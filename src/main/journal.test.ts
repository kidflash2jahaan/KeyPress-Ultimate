import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  buildReplayPlan,
  HoldJournal,
  isProcessAlive,
  JOURNAL_FILENAME,
  JOURNAL_VERSION,
  parseJournal,
  recoverStaleJournal,
  recoveryMessage,
  type JournalFileSystem,
  type ReplayPlan,
} from './journal'

const DIR = '/userData'
const FINAL = `${DIR}/${JOURNAL_FILENAME}`
const TMP = `${FINAL}.tmp`

/**
 * A filesystem that records the exact order of every call, because the ordering
 * is the property under test. An fsync after the rename is not durability, and
 * a rename before the fsync is a torn journal waiting to happen.
 */
class FakeFs implements JournalFileSystem {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly ops: string[] = []
  failWriteAt: 'open' | 'write' | 'fsync' | 'rename' | null = null
  failUnlink = false

  #nextFd = 3
  readonly #open = new Map<number, { path: string; mode: string; buffer: string }>()

  existsSync(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }

  mkdirSync(path: string): void {
    this.ops.push(`mkdir ${path}`)
    this.dirs.add(path)
  }

  readFileSync(path: string): string {
    this.ops.push(`read ${path}`)
    const content = this.files.get(path)
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return content
  }

  openSync(path: string, flags: string): number {
    if (this.failWriteAt === 'open' && flags === 'w') throw new Error('EACCES')
    // Directory fsync only works on POSIX; model it as available here.
    if (flags === 'r' && !this.files.has(path) && !this.dirs.has(path)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const fd = this.#nextFd++
    this.#open.set(fd, { path, mode: flags, buffer: '' })
    this.ops.push(`open ${flags} ${path}`)
    return fd
  }

  writeSync(fd: number, data: string): number {
    if (this.failWriteAt === 'write') throw new Error('ENOSPC')
    const entry = this.#open.get(fd)
    if (entry === undefined) throw new Error('EBADF')
    entry.buffer += data
    this.ops.push(`write ${entry.path}`)
    return data.length
  }

  fsyncSync(fd: number): void {
    const entry = this.#open.get(fd)
    if (entry === undefined) throw new Error('EBADF')
    if (this.failWriteAt === 'fsync' && entry.mode === 'w') throw new Error('EIO')
    this.ops.push(`fsync ${entry.path}`)
  }

  closeSync(fd: number): void {
    const entry = this.#open.get(fd)
    if (entry === undefined) throw new Error('EBADF')
    this.#open.delete(fd)
    if (entry.mode === 'w') this.files.set(entry.path, entry.buffer)
    this.ops.push(`close ${entry.path}`)
  }

  renameSync(from: string, to: string): void {
    if (this.failWriteAt === 'rename') throw new Error('EXDEV')
    const content = this.files.get(from)
    if (content === undefined) throw new Error('ENOENT')
    this.files.delete(from)
    this.files.set(to, content)
    this.ops.push(`rename ${from} -> ${to}`)
  }

  unlinkSync(path: string): void {
    if (this.failUnlink) throw new Error('EPERM')
    this.files.delete(path)
    this.ops.push(`unlink ${path}`)
  }
}

function makeJournal(fs: FakeFs): HoldJournal {
  return new HoldJournal({ directory: DIR, fs })
}

const DRAFT = {
  pid: 4242,
  injectorPid: 4243,
  startedAt: 1_700_000_000_000,
  keyIds: ['key-left-shift', 'key-w'],
  buttonIds: ['left'],
}

describe('HoldJournal.write', () => {
  it('fsyncs the data before the rename that publishes it', () => {
    const fs = new FakeFs()
    expect(makeJournal(fs).write(DRAFT)).toBe(true)

    const fsyncTmp = fs.ops.indexOf(`fsync ${TMP}`)
    const rename = fs.ops.indexOf(`rename ${TMP} -> ${FINAL}`)
    expect(fsyncTmp).toBeGreaterThan(-1)
    expect(rename).toBeGreaterThan(-1)
    expect(fsyncTmp).toBeLessThan(rename)
  })

  it('fsyncs the directory after the rename so the rename itself is durable', () => {
    const fs = new FakeFs()
    fs.dirs.add(DIR)
    makeJournal(fs).write(DRAFT)

    const rename = fs.ops.indexOf(`rename ${TMP} -> ${FINAL}`)
    const fsyncDir = fs.ops.indexOf(`fsync ${DIR}`)
    expect(fsyncDir).toBeGreaterThan(rename)
  })

  it('publishes the entry atomically, so a reader never sees a half-written file', () => {
    const fs = new FakeFs()
    makeJournal(fs).write(DRAFT)

    // Everything before the rename touched the temp path only.
    const rename = fs.ops.indexOf(`rename ${TMP} -> ${FINAL}`)
    expect(fs.ops.slice(0, rename).some((op) => op.endsWith(FINAL))).toBe(false)
    expect(fs.files.has(TMP)).toBe(false)
    expect(JSON.parse(fs.files.get(FINAL) ?? '{}')).toEqual({ version: JOURNAL_VERSION, ...DRAFT })
  })

  it('reports a failed write instead of throwing, because a session without a journal still has every in-process failsafe', () => {
    const fs = new FakeFs()
    fs.failWriteAt = 'fsync'
    const onError = vi.fn()
    const journal = new HoldJournal({ directory: DIR, fs, onError })

    expect(journal.write(DRAFT)).toBe(false)
    expect(onError).toHaveBeenCalledWith('write', expect.any(Error))
    expect(fs.files.has(FINAL)).toBe(false)
  })

  it('round-trips through read', () => {
    const fs = new FakeFs()
    const journal = makeJournal(fs)
    journal.write(DRAFT)
    expect(journal.read()).toEqual({ version: JOURNAL_VERSION, ...DRAFT })
  })
})

describe('HoldJournal.clear', () => {
  it('removes the file and is idempotent', () => {
    const fs = new FakeFs()
    const journal = makeJournal(fs)
    journal.write(DRAFT)

    expect(journal.clear()).toBe(true)
    expect(fs.files.has(FINAL)).toBe(false)
    expect(journal.clear()).toBe(true)
    expect(journal.read()).toBeNull()
  })

  it('reports a failed unlink rather than throwing', () => {
    const fs = new FakeFs()
    const onError = vi.fn()
    const journal = new HoldJournal({ directory: DIR, fs, onError })
    journal.write(DRAFT)
    fs.failUnlink = true

    expect(journal.clear()).toBe(false)
    expect(onError).toHaveBeenCalledWith('clear', expect.any(Error))
  })
})

describe('parseJournal', () => {
  it('rejects anything without a usable pid or timestamp', () => {
    expect(parseJournal('null')).toBeNull()
    expect(parseJournal('{"pid":0,"startedAt":1}')).toBeNull()
    expect(parseJournal('{"pid":-3,"startedAt":1}')).toBeNull()
    expect(parseJournal('{"pid":12}')).toBeNull()
  })

  it('drops non-string entries rather than failing the whole recovery', () => {
    const entry = parseJournal('{"pid":12,"startedAt":5,"keyIds":["key-w",7,null],"buttonIds":"x"}')
    expect(entry?.keyIds).toEqual(['key-w'])
    expect(entry?.buttonIds).toEqual([])
  })
})

describe('buildReplayPlan', () => {
  it('releases in reverse press order with modifiers last', () => {
    // Real key data: key-left-shift is a modifier, key-w and key-a are not.
    expect(buildReplayPlan({ keyIds: ['key-w', 'key-left-shift', 'key-a'], buttonIds: [] })).toEqual(
      { keyIds: ['key-a', 'key-w', 'key-left-shift'], buttonIds: [] },
    )
  })

  it('releases every modifier after every plain key', () => {
    const plan = buildReplayPlan({
      keyIds: ['key-left-ctrl', 'key-left-shift', 'key-w'],
      buttonIds: [],
    })
    expect(plan.keyIds).toEqual(['key-w', 'key-left-shift', 'key-left-ctrl'])
  })

  it('reverses mouse buttons too', () => {
    const plan = buildReplayPlan({ keyIds: [], buttonIds: ['left', 'right'] })
    expect(plan.buttonIds).toEqual(['right', 'left'])
  })
})

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

interface RecoveryHarness {
  fs: FakeFs
  journal: HoldJournal
  replay: Mock<(plan: ReplayPlan) => number>
  plans: ReplayPlan[]
}

function harness(entry: Record<string, unknown> | string | null): RecoveryHarness {
  const fs = new FakeFs()
  const journal = new HoldJournal({ directory: DIR, fs })
  if (entry !== null) {
    fs.files.set(FINAL, typeof entry === 'string' ? entry : JSON.stringify(entry))
  }
  const plans: ReplayPlan[] = []
  const replay = vi.fn((plan: ReplayPlan) => {
    plans.push(plan)
    return plan.keyIds.length + plan.buttonIds.length
  })
  return { fs, journal, replay, plans }
}

const DEAD_PID = 90_001
const LIVE_PID = 90_002
const aliveOnly =
  (alive: number) =>
  (pid: number): boolean =>
    pid === alive

describe('recoverStaleJournal', () => {
  it('replays the ups when the owning pid is gone, then clears the file', () => {
    const h = harness({
      version: JOURNAL_VERSION,
      pid: DEAD_PID,
      injectorPid: null,
      startedAt: 1_000,
      keyIds: ['key-left-shift', 'key-w'],
      buttonIds: ['left'],
    })

    const result = recoverStaleJournal({
      journal: h.journal,
      replay: h.replay,
      isProcessAlive: aliveOnly(LIVE_PID),
      bootTimeMs: () => 0,
    })

    expect(result.outcome).toBe('recovered')
    expect(result.releasedCount).toBe(3)
    expect(result.message).toBe('Recovered from an unclean shutdown, released 3 keys.')
    expect(h.plans).toEqual([{ keyIds: ['key-w', 'key-left-shift'], buttonIds: ['left'] }])
    expect(h.fs.files.has(FINAL)).toBe(false)
  })

  it('does NOT replay while the owning pid is still alive, and leaves the file alone', () => {
    const h = harness({
      version: JOURNAL_VERSION,
      pid: LIVE_PID,
      injectorPid: null,
      startedAt: 1_000,
      keyIds: ['key-w'],
      buttonIds: [],
    })

    const result = recoverStaleJournal({
      journal: h.journal,
      replay: h.replay,
      isProcessAlive: aliveOnly(LIVE_PID),
      bootTimeMs: () => 0,
    })

    expect(result.outcome).toBe('owner-alive')
    expect(result.releasedCount).toBe(0)
    expect(result.message).toBeNull()
    expect(h.replay).not.toHaveBeenCalled()
    // Another copy of the app is holding those keys on purpose right now.
    expect(h.fs.files.has(FINAL)).toBe(true)
  })

  it('treats a live pid as reused when the journal predates this boot', () => {
    const h = harness({
      version: JOURNAL_VERSION,
      pid: LIVE_PID,
      injectorPid: null,
      startedAt: 1_000,
      keyIds: ['key-w'],
      buttonIds: [],
    })

    const result = recoverStaleJournal({
      journal: h.journal,
      replay: h.replay,
      isProcessAlive: aliveOnly(LIVE_PID),
      bootTimeMs: () => 5_000,
    })

    expect(result.outcome).toBe('recovered')
    expect(result.releasedCount).toBe(1)
    expect(result.message).toBe('Recovered from an unclean shutdown, released 1 key.')
  })

  it('does nothing at all when there is no journal', () => {
    const h = harness(null)
    const result = recoverStaleJournal({
      journal: h.journal,
      replay: h.replay,
      isProcessAlive: () => false,
      bootTimeMs: () => 0,
    })

    expect(result).toEqual({ outcome: 'no-journal', releasedCount: 0, message: null, journal: null })
    expect(h.replay).not.toHaveBeenCalled()
  })

  it('clears an unparseable journal without replaying anything', () => {
    const h = harness('{ not json')
    const result = recoverStaleJournal({
      journal: h.journal,
      replay: h.replay,
      isProcessAlive: () => false,
      bootTimeMs: () => 0,
    })

    expect(result.outcome).toBe('unreadable')
    expect(h.replay).not.toHaveBeenCalled()
    expect(h.fs.files.has(FINAL)).toBe(false)
  })

  it('clears a journal that lists nothing, and says nothing to the user', () => {
    const h = harness({ pid: DEAD_PID, startedAt: 1_000, keyIds: [], buttonIds: [] })
    const result = recoverStaleJournal({
      journal: h.journal,
      replay: h.replay,
      isProcessAlive: () => false,
      bootTimeMs: () => 0,
    })

    expect(result.outcome).toBe('nothing-held')
    expect(result.message).toBeNull()
    expect(h.replay).not.toHaveBeenCalled()
    expect(h.fs.files.has(FINAL)).toBe(false)
  })

  it('keeps the journal when the replay fails, so the next launch tries again', () => {
    const h = harness({ pid: DEAD_PID, startedAt: 1_000, keyIds: ['key-w'], buttonIds: [] })
    const onError = vi.fn()

    const result = recoverStaleJournal({
      journal: h.journal,
      replay: () => {
        throw new Error('no native input available')
      },
      isProcessAlive: () => false,
      bootTimeMs: () => 0,
      onError,
    })

    expect(result.outcome).toBe('replay-failed')
    expect(result.releasedCount).toBe(0)
    expect(result.message).toContain('could not release them')
    expect(h.fs.files.has(FINAL)).toBe(true)
    expect(onError).toHaveBeenCalled()
  })
})

describe('recoveryMessage', () => {
  it('says key for one and keys for anything else', () => {
    expect(recoveryMessage(1)).toBe('Recovered from an unclean shutdown, released 1 key.')
    expect(recoveryMessage(0)).toBe('Recovered from an unclean shutdown, released 0 keys.')
    expect(recoveryMessage(4)).toBe('Recovered from an unclean shutdown, released 4 keys.')
  })
})

describe('isProcessAlive', () => {
  it('reports this process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('rejects pids that cannot exist rather than throwing', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
  })
})
