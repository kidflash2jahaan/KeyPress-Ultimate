/**
 * The hold journal: the last line of defence against a stuck key.
 *
 * Every other failsafe in the app depends on some process surviving long enough
 * to post key-ups. This one does not. If the user Force Quits both the main
 * process and the injector at the same instant, no handler anywhere gets to
 * run, and the OS keeps the key down forever because a held key is global,
 * durable state that nothing times out or garbage-collects.
 *
 * The remedy is a file on disk, fsynced before the first key-down, listing what
 * is about to be held and which pid owns it. On the next launch, if that file
 * exists and its owner is gone, we post the ups it describes and tell the user
 * what happened.
 *
 * Two rules govern this module and everything that calls it:
 *
 *   1. The journal is written BEFORE anything is pressed and deleted only after
 *      a release is CONFIRMED. Its presence means "keys may be down". A journal
 *      that outlives a clean session costs one harmless replayed key-up. A
 *      journal that is missing after a crash costs the user a wedged keyboard.
 *      The asymmetry is total, so every ambiguous case leaves the file alone.
 *
 *   2. The write is durable, not just issued. `writeFileSync` returns as soon
 *      as the data reaches the page cache, which is worthless in the exact
 *      scenario this file exists for. We write a temp file, fsync it, rename it
 *      into place, and fsync the directory.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { getKeyById } from '@shared/keys'

/** File name inside `app.getPath('userData')`. */
export const JOURNAL_FILENAME = 'held-keys.json'

/** Bumped only if the on-disk shape changes incompatibly. */
export const JOURNAL_VERSION = 1

/**
 * What is on disk. `pid` is the MAIN process pid, because that is the process
 * whose death means "nobody is left to release these". `injectorPid` is
 * recorded for diagnostics only.
 */
export interface HeldKeysJournal {
  version: number
  pid: number
  injectorPid: number | null
  startedAt: number
  keyIds: string[]
  buttonIds: string[]
}

/** Everything a caller supplies; `version` is stamped by the journal itself. */
export type HeldKeysJournalDraft = Omit<HeldKeysJournal, 'version'>

/**
 * The filesystem calls this module makes, as an interface so tests can watch
 * the exact order of operations. The ordering is the thing under test: a write
 * that is not fsynced before the rename is not durable, and a durable write
 * that lands after the first key-down is useless.
 */
export interface JournalFileSystem {
  existsSync(path: string): boolean
  mkdirSync(path: string, options: { recursive: true }): void
  readFileSync(path: string): string
  openSync(path: string, flags: string): number
  writeSync(fd: number, data: string): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
}

export const nodeJournalFileSystem: JournalFileSystem = {
  existsSync: (path) => existsSync(path),
  mkdirSync: (path, options) => {
    mkdirSync(path, options)
  },
  readFileSync: (path) => readFileSync(path, 'utf8'),
  openSync: (path, flags) => openSync(path, flags),
  writeSync: (fd, data) => writeSync(fd, data),
  fsyncSync: (fd) => {
    fsyncSync(fd)
  },
  closeSync: (fd) => {
    closeSync(fd)
  },
  renameSync: (from, to) => {
    renameSync(from, to)
  },
  unlinkSync: (path) => {
    unlinkSync(path)
  },
}

export interface HoldJournalOptions {
  /** Directory to write into. Normally `app.getPath('userData')`. */
  directory: string
  fs?: JournalFileSystem
  /** Called with any filesystem failure. Journal errors never throw upward. */
  onError?: (stage: 'write' | 'read' | 'clear', error: unknown) => void
}

/**
 * The writer half. Deliberately tiny: write, read, clear. No policy lives here,
 * only durability.
 */
export class HoldJournal {
  readonly path: string
  readonly #tempPath: string
  readonly #directory: string
  readonly #fs: JournalFileSystem
  readonly #onError: (stage: 'write' | 'read' | 'clear', error: unknown) => void

  constructor(options: HoldJournalOptions) {
    this.#directory = options.directory
    this.path = join(options.directory, JOURNAL_FILENAME)
    this.#tempPath = `${this.path}.tmp`
    this.#fs = options.fs ?? nodeJournalFileSystem
    this.#onError = options.onError ?? (() => undefined)
  }

  /**
   * Durably record what is about to be held. Must complete before the first
   * key-down is posted. Never throws: a session that cannot write a journal is
   * still safer to run than no session at all, because every in-process
   * failsafe still works. The caller is told through `onError`.
   */
  write(draft: HeldKeysJournalDraft): boolean {
    const entry: HeldKeysJournal = { version: JOURNAL_VERSION, ...draft }
    let fd: number | null = null
    try {
      this.#fs.mkdirSync(this.#directory, { recursive: true })
      fd = this.#fs.openSync(this.#tempPath, 'w')
      this.#fs.writeSync(fd, JSON.stringify(entry))
      // The fsync is the entire point of this module. Without it the bytes sit
      // in the page cache and a hard power loss or panic loses them.
      this.#fs.fsyncSync(fd)
      this.#fs.closeSync(fd)
      fd = null
      // Rename is atomic on both APFS and NTFS, so a reader never sees a torn
      // journal, only the old one or the new one.
      this.#fs.renameSync(this.#tempPath, this.path)
      this.#fsyncDirectory()
      return true
    } catch (error) {
      if (fd !== null) {
        try {
          this.#fs.closeSync(fd)
        } catch {
          // Nothing useful to do with a failing close on an already failed write.
        }
      }
      this.#onError('write', error)
      return false
    }
  }

  /** True when a journal file is present, parseable or not. */
  exists(): boolean {
    try {
      return this.#fs.existsSync(this.path)
    } catch (error) {
      this.#onError('read', error)
      return false
    }
  }

  read(): HeldKeysJournal | null {
    try {
      if (!this.#fs.existsSync(this.path)) return null
      return parseJournal(this.#fs.readFileSync(this.path))
    } catch (error) {
      this.#onError('read', error)
      return null
    }
  }

  /**
   * Delete the journal. Call this ONLY once a release is confirmed. Idempotent,
   * and a missing file is success.
   */
  clear(): boolean {
    try {
      if (!this.#fs.existsSync(this.path)) return true
      this.#fs.unlinkSync(this.path)
      return true
    } catch (error) {
      this.#onError('clear', error)
      return false
    }
  }

  /**
   * Directory fsync, so the rename itself is durable and not just the file
   * contents. Fails on Windows, where directories cannot be opened for fsync,
   * and that is fine: NTFS metadata journalling already covers the rename.
   */
  #fsyncDirectory(): void {
    let dirFd: number | null = null
    try {
      dirFd = this.#fs.openSync(this.#directory, 'r')
      this.#fs.fsyncSync(dirFd)
    } catch {
      // Expected on Windows. Not an error worth surfacing.
    } finally {
      if (dirFd !== null) {
        try {
          this.#fs.closeSync(dirFd)
        } catch {
          // Same.
        }
      }
    }
  }
}

/** Parse and validate. Anything malformed reads as "no usable journal". */
export function parseJournal(text: string): HeldKeysJournal | null {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const pid = record['pid']
  const startedAt = record['startedAt']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  const injectorPid = record['injectorPid']
  return {
    version: typeof record['version'] === 'number' ? record['version'] : 0,
    pid,
    injectorPid: typeof injectorPid === 'number' ? injectorPid : null,
    startedAt,
    keyIds: stringArray(record['keyIds']),
    buttonIds: stringArray(record['buttonIds']),
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/** What a replay should post, already in the correct order. */
export interface ReplayPlan {
  keyIds: string[]
  buttonIds: string[]
}

export type RecoveryOutcome =
  | 'no-journal'
  | 'owner-alive'
  | 'unreadable'
  | 'nothing-held'
  | 'recovered'
  | 'replay-failed'

export interface RecoveryResult {
  outcome: RecoveryOutcome
  releasedCount: number
  /** User-facing notice, or null when there is nothing worth saying. */
  message: string | null
  journal: HeldKeysJournal | null
}

export interface RecoveryOptions {
  journal: Pick<HoldJournal, 'read' | 'clear' | 'exists'>
  /**
   * Posts the ups. Returns how many were actually released. Supplied by the
   * caller because posting input is the injector's job, never this module's.
   * Throwing is treated as a failed replay and leaves the journal in place.
   */
  replay: (plan: ReplayPlan) => number
  /** Defaults to a `kill(pid, 0)` probe. */
  isProcessAlive?: (pid: number) => boolean
  /**
   * Wall-clock time the machine booted. A journal written before the current
   * boot cannot belong to a live process, no matter what the pid table says,
   * so this closes the pid-reuse hole where a recycled pid would suppress a
   * recovery the user badly needs.
   */
  bootTimeMs?: () => number
  onError?: (error: unknown) => void
}

/**
 * Read the journal left by a previous run and, if its owner is gone, release
 * whatever it says was held.
 *
 * The live-owner case must not replay: another copy of the app is running right
 * now and holding those keys deliberately, and posting ups underneath it would
 * break a working session.
 */
export function recoverStaleJournal(options: RecoveryOptions): RecoveryResult {
  const isAlive = options.isProcessAlive ?? isProcessAlive
  const bootTimeMs = options.bootTimeMs ?? defaultBootTimeMs
  const onError = options.onError ?? (() => undefined)

  const entry = options.journal.read()
  if (entry === null) {
    if (!options.journal.exists()) {
      return { outcome: 'no-journal', releasedCount: 0, message: null, journal: null }
    }
    // The file is there but unparseable, so there is nothing to replay from it.
    // Clear it rather than re-examining the same garbage on every launch; the
    // next session writes a fresh one before pressing anything.
    options.journal.clear()
    return { outcome: 'unreadable', releasedCount: 0, message: null, journal: null }
  }

  const bootedAt = bootTimeMs()
  const predatesBoot = Number.isFinite(bootedAt) && entry.startedAt < bootedAt
  if (!predatesBoot && isAlive(entry.pid)) {
    return { outcome: 'owner-alive', releasedCount: 0, message: null, journal: entry }
  }

  const plan = buildReplayPlan(entry)
  if (plan.keyIds.length === 0 && plan.buttonIds.length === 0) {
    options.journal.clear()
    return { outcome: 'nothing-held', releasedCount: 0, message: null, journal: entry }
  }

  let released: number
  try {
    released = options.replay(plan)
  } catch (error) {
    onError(error)
    // Leave the journal in place. Better to try again next launch than to
    // forget that keys may still be down.
    return {
      outcome: 'replay-failed',
      releasedCount: 0,
      message:
        'KeyPress Ultimate found keys left down by an earlier run but could not release them. Tap them once on your keyboard to clear them.',
      journal: entry,
    }
  }

  options.journal.clear()
  return {
    outcome: 'recovered',
    releasedCount: released,
    message: recoveryMessage(released),
    journal: entry,
  }
}

/**
 * Release order, which is the reverse of press order with modifiers last.
 *
 * A human lifts the letter before the modifier, and every app's shortcut
 * handling assumes it. Releasing Shift before W can turn the tail of a hold
 * into an unshifted keystroke the target reacts to.
 *
 * Mouse buttons come first because a held mouse button is a drag, and ending
 * the drag before the keyboard state changes is what the target expects.
 */
export function buildReplayPlan(
  entry: Pick<HeldKeysJournal, 'keyIds' | 'buttonIds'>,
  isModifier: (keyId: string) => boolean = defaultIsModifier,
): ReplayPlan {
  const reversed = [...entry.keyIds].reverse()
  return {
    keyIds: [
      ...reversed.filter((id) => !isModifier(id)),
      ...reversed.filter((id) => isModifier(id)),
    ],
    buttonIds: [...entry.buttonIds].reverse(),
  }
}

function defaultIsModifier(keyId: string): boolean {
  return getKeyById(keyId)?.isModifier === true
}

export function recoveryMessage(count: number): string {
  const noun = count === 1 ? 'key' : 'keys'
  return `Recovered from an unclean shutdown, released ${String(count)} ${noun}.`
}

/**
 * Signal 0 sends nothing and only runs the permission and existence checks.
 * EPERM means the process exists but belongs to someone else, which for our
 * purposes is very much alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function defaultBootTimeMs(): number {
  // `os.uptime()` is seconds since boot, so this is the wall-clock instant the
  // machine came up. Everything written before it belongs to a previous boot.
  return Date.now() - uptime() * 1000
}
