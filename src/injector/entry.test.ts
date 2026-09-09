import { describe, expect, it } from 'vitest'
import type { InjectorToMainMessage } from '@shared/ipc'
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '@shared/ipc'
import type { AppInfo, KeyDef, MouseDef, SessionConfig, Settings } from '@shared/types'
import type { ForegroundBlockingReport } from './native/windows'
import type { InjectorNative } from './hold-loop'
import type { InjectorMessageEvent, InjectorPort, ProcessLike } from './entry'
import {
  createInjectorRuntime,
  FAILSAFE_SIGNALS,
  installFailsafeHandlers,
  parseMainToInjectorMessage,
  parseOurPids,
} from './entry'
import type { Clock, TimerHandle } from './scheduler'

// ---------------------------------------------------------------------------
// Fakes: no Electron, no real process, no real timers, no real input.
// ---------------------------------------------------------------------------

interface FakeClock extends Clock {
  advance(ms: number): void
}

function createFakeClock(start = 1_000): FakeClock {
  let time = start
  let seq = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => time,
    setTimeout(callback: () => void, delayMs: number): TimerHandle {
      const id = ++seq
      timers.set(id, { at: time + Math.max(0, delayMs), callback })
      return id
    },
    clearTimeout(handle: TimerHandle): void {
      timers.delete(handle as number)
    },
    advance(ms: number): void {
      const end = time + ms
      for (;;) {
        let nextId: number | null = null
        let nextAt = Number.POSITIVE_INFINITY
        for (const [id, timer] of timers) {
          if (timer.at < nextAt) {
            nextAt = timer.at
            nextId = id
          }
        }
        if (nextId === null || nextAt > end) break
        const timer = timers.get(nextId)
        timers.delete(nextId)
        time = nextAt
        timer?.callback()
      }
      time = end
    },
  }
}

const TARGET: AppInfo = { identity: 'com.mojang.minecraft', name: 'Minecraft', pid: 4242, path: null }

interface FakeNative {
  native: InjectorNative
  calls: string[]
  count(name: string): number
}

function createFakeNative(): FakeNative {
  const calls: string[] = []
  const native: InjectorNative = {
    async init(): Promise<void> {
      calls.push('init')
    },
    listApplications: (): AppInfo[] => [TARGET],
    getFrontmostPid: (): number | null => TARGET.pid,
    keyDown: (key: KeyDef): void => {
      calls.push(`keyDown:${key.id}`)
    },
    keyUp: (key: KeyDef): void => {
      calls.push(`keyUp:${key.id}`)
    },
    mouseDown: (button: MouseDef): void => {
      calls.push(`mouseDown:${button.id}`)
    },
    mouseUp: (button: MouseDef): void => {
      calls.push(`mouseUp:${button.id}`)
    },
    releaseAll: (): void => {
      calls.push('releaseAll')
    },
    hasPermission: (): boolean => true,
    openPermissionSettings: (): void => {},
    dispose: (): void => {
      calls.push('dispose')
    },
  }
  return {
    native,
    calls,
    count: (name) => calls.filter((call) => call === name).length,
  }
}

interface FakePort extends InjectorPort {
  sent: InjectorToMainMessage[]
  emit(data: unknown): void
}

function createFakePort(): FakePort {
  const sent: InjectorToMainMessage[] = []
  let listener: ((event: InjectorMessageEvent) => void) | null = null
  return {
    sent,
    postMessage(message: InjectorToMainMessage): void {
      sent.push(message)
    },
    on(_event: 'message', handler: (event: InjectorMessageEvent) => void): unknown {
      listener = handler
      return this
    },
    emit(data: unknown): void {
      listener?.({ data })
    },
  }
}

interface FakeProcess extends ProcessLike {
  fire(event: string): void
  handlers: Map<string, (() => void)[]>
  exitCodes: number[]
}

function createFakeProcess(): FakeProcess {
  const handlers = new Map<string, (() => void)[]>()
  const exitCodes: number[] = []
  return {
    handlers,
    exitCodes,
    on(event: string, listener: () => void): unknown {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return this
    },
    exit(code = 0): void {
      exitCodes.push(code)
    },
    fire(event: string): void {
      for (const listener of handlers.get(event) ?? []) listener()
    },
  }
}

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    keyIds: ['key-w'],
    buttonIds: [],
    targets: [TARGET.identity],
    mode: 'hold',
    repeatInitialMs: 400,
    repeatIntervalMs: 33,
    tapIntervalMs: 100,
    ...overrides,
  }
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    panicHotkey: 'CommandOrControl+Alt+Shift+K',
    maxSessionMinutes: 30,
    autoCheckUpdates: true,
    windowsUseVirtualKeys: false,
    ...overrides,
  }
}

/** `decorate` wraps the recording fake, so extra adapter capabilities can be bolted on. */
function runtimeHarness(decorate?: (native: InjectorNative) => InjectorNative) {
  const clock = createFakeClock()
  const fake = createFakeNative()
  const port = createFakePort()
  const exitCodes: number[] = []
  const runtime = createInjectorRuntime({
    port,
    native: decorate ? decorate(fake.native) : fake.native,
    clock,
    spinMs: 0,
    platform: 'darwin',
    ourPids: [999],
    exit: (code) => exitCodes.push(code),
  })
  runtime.start()

  let pings = 0
  /**
   * Advance the clock the way a live main does: a ping every heartbeat
   * interval. Plain `clock.advance` simulates a main that has gone silent,
   * which after HEARTBEAT_TIMEOUT_MS is a main the injector must outlive.
   */
  function advanceAlive(ms: number): void {
    let remaining = ms
    while (remaining > 0) {
      const step = Math.min(HEARTBEAT_INTERVAL_MS, remaining)
      clock.advance(step)
      port.emit({ t: 'ping', n: ++pings })
      remaining -= step
    }
  }

  return { clock, fake, port, runtime, exitCodes, advanceAlive }
}

// ---------------------------------------------------------------------------

describe('parseOurPids', () => {
  it('takes the main pid off argv and always includes our own', () => {
    expect(parseOurPids(['node', 'injector.js', '--main-pid=321'], 654)).toEqual([654, 321])
  })

  it('survives a missing or malformed argument', () => {
    expect(parseOurPids([], 7)).toEqual([7])
    expect(parseOurPids(['--main-pid=', '--main-pid=abc'], 7)).toEqual([7])
  })
})

describe('parseMainToInjectorMessage', () => {
  it('accepts every tag in the protocol', () => {
    expect(parseMainToInjectorMessage({ t: 'ping', n: 4 })).toEqual({ t: 'ping', n: 4 })
    expect(parseMainToInjectorMessage({ t: 'disarm', reason: 'user-stop' })).toEqual({
      t: 'disarm',
      reason: 'user-stop',
    })
    expect(parseMainToInjectorMessage({ t: 'arm', config: config() })?.t).toBe('arm')
    expect(parseMainToInjectorMessage({ t: 'settings', settings: {} })?.t).toBe('settings')
  })

  it('rejects anything else rather than trusting it', () => {
    expect(parseMainToInjectorMessage(null)).toBeNull()
    expect(parseMainToInjectorMessage('arm')).toBeNull()
    expect(parseMainToInjectorMessage({ t: 'nope' })).toBeNull()
    expect(parseMainToInjectorMessage({ t: 'ping' })).toBeNull()
    expect(parseMainToInjectorMessage({ t: 'arm' })).toBeNull()
  })
})

describe('message handling', () => {
  it('answers a ping with a matching pong', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'ping', n: 17 })
    expect(h.port.sent).toContainEqual({ t: 'pong', n: 17 })
  })

  it('arms and disarms the hold loop, and reports state and releases upward', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'arm', config: config() })
    h.advanceAlive(300)
    expect(h.fake.count('keyDown:key-w')).toBe(1)

    const states = h.port.sent.filter((message) => message.t === 'state')
    expect(states.length).toBeGreaterThan(0)
    const firing = states.find((message) => message.firingKeyIds.length > 0)
    expect(firing?.onTarget).toBe(true)
    expect(firing?.focusedPid).toBe(TARGET.pid)

    h.port.emit({ t: 'disarm', reason: 'user-stop' })
    expect(h.fake.count('keyUp:key-w')).toBe(1)
    expect(h.port.sent).toContainEqual({ t: 'released', count: 1 })
  })

  it('reports a configuration that cannot be held as an error, not a crash', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'arm', config: config({ keyIds: ['key-caps-lock'] }) })
    const errors = h.port.sent.filter((message) => message.t === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('nothing to hold')
  })

  it('ignores an unrecognised message instead of acting on it', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'arm' })
    h.port.emit({ hello: 'world' })
    h.advanceAlive(1_000)
    expect(h.fake.calls).toHaveLength(0)
    // A live main is still being answered; nothing else went out.
    expect(h.port.sent.every((message) => message.t === 'pong')).toBe(true)
  })
})

describe('heartbeat', () => {
  it('releases and exits when main goes quiet for the timeout', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'arm', config: config() })
    h.advanceAlive(300)
    expect(h.fake.count('keyDown:key-w')).toBe(1)

    h.port.emit({ t: 'ping', n: 1 })
    h.clock.advance(HEARTBEAT_TIMEOUT_MS - 120)
    expect(h.exitCodes).toHaveLength(0)

    h.clock.advance(200)
    expect(h.fake.count('keyUp:key-w')).toBe(1)
    expect(h.fake.count('releaseAll')).toBe(1)
    expect(h.fake.count('dispose')).toBe(1)
    expect(h.exitCodes).toEqual([1])
  })

  it('stays alive as long as the pings keep coming', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'arm', config: config() })
    for (let i = 0; i < 60; i++) {
      h.port.emit({ t: 'ping', n: i })
      h.clock.advance(100)
    }
    expect(h.exitCodes).toHaveLength(0)
    expect(h.fake.count('releaseAll')).toBe(0)
  })

  // Regression: the watchdog used to stay disabled until the first ping
  // arrived, so a main that died in the ~100ms between forking the injector and
  // its first ping left an armed injector with no liveness deadline at all, and
  // whatever it pressed next stayed down.
  it('is armed from process start, so a main that never pings still gets outlived', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'arm', config: config() })
    // Main dies here: no ping ever arrives. The key still goes down, because
    // the loop is armed and the target is frontmost.
    h.clock.advance(HEARTBEAT_TIMEOUT_MS - 50)
    expect(h.fake.count('keyDown:key-w')).toBe(1)
    expect(h.exitCodes).toHaveLength(0)

    h.clock.advance(50)
    expect(h.fake.count('keyUp:key-w')).toBe(1)
    expect(h.fake.count('releaseAll')).toBe(1)
    expect(h.fake.count('dispose')).toBe(1)
    expect(h.exitCodes).toEqual([1])
  })

  it('outlives a main that never sends anything at all, armed or not', () => {
    const h = runtimeHarness()
    h.clock.advance(HEARTBEAT_TIMEOUT_MS)
    expect(h.exitCodes).toEqual([1])
  })

  it('counts any message from main as proof of life, not only a ping', () => {
    const h = runtimeHarness()
    for (let i = 0; i < 10; i++) {
      h.clock.advance(HEARTBEAT_TIMEOUT_MS - 50)
      h.port.emit({ t: 'settings', settings: settings() })
    }
    expect(h.exitCodes).toHaveLength(0)
  })

  it('exits only once even if the watchdog would fire again', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'ping', n: 1 })
    h.clock.advance(10_000)
    expect(h.exitCodes).toEqual([1])
    expect(h.fake.count('releaseAll')).toBe(1)
  })
})

describe('self-disarm', () => {
  // Regression: the loop can end its own session (the injector-side max session
  // cap), but a self-disarm was invisible on the wire. Main read the last state
  // frame as an ordinary focus loss, soft-released, and stayed armed forever
  // against a loop whose scheduler had stopped, while this process happily went
  // on answering pings. Ending the process is a signal main already handles.
  it('releases and exits when the loop ends its own session', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'settings', settings: settings({ maxSessionMinutes: 1 }) })
    h.port.emit({ t: 'arm', config: config() })
    h.advanceAlive(300)
    expect(h.fake.count('keyDown:key-w')).toBe(1)
    expect(h.exitCodes).toHaveLength(0)

    h.advanceAlive(61_000)
    expect(h.fake.count('keyUp:key-w')).toBe(1)
    // The loop's own teardown and the shutdown path both post the global
    // release. Deliberate belt and braces: `releaseAll` is idempotent.
    expect(h.fake.count('releaseAll')).toBeGreaterThan(0)
    expect(h.fake.count('dispose')).toBe(1)
    expect(h.runtime.shutdownCount).toBe(1)
    expect(h.exitCodes).toEqual([0])
  })

  it('does not exit when main is the one asking for the disarm', () => {
    const h = runtimeHarness()
    h.port.emit({ t: 'arm', config: config() })
    h.advanceAlive(300)
    h.port.emit({ t: 'disarm', reason: 'user-stop' })
    expect(h.fake.count('keyUp:key-w')).toBe(1)
    // Main owns the teardown from here: it saw `released` and kills us itself.
    expect(h.exitCodes).toHaveLength(0)
    expect(h.runtime.shutdownCount).toBe(0)
  })
})

describe('blocked targets', () => {
  const blockedReport: ForegroundBlockingReport = {
    ok: false,
    severity: 'blocked',
    app: TARGET,
    self: { state: 'known-not-elevated', lastError: null, reason: 'the token reports not elevated' },
    target: { state: 'known-elevated', lastError: null, reason: 'the token reports elevated' },
    message:
      'Minecraft is running as administrator, restart KeyPress Ultimate as administrator.',
  }

  it('forwards an elevated target to main as a blocked message, once', () => {
    let calls = 0
    const h = runtimeHarness((native) => ({
      ...native,
      describeForegroundBlocking: (): ForegroundBlockingReport => {
        calls++
        return blockedReport
      },
    }))
    h.port.emit({ t: 'arm', config: config() })
    h.advanceAlive(5_000)

    const blocked = h.port.sent.filter((message) => message.t === 'blocked')
    expect(blocked).toEqual([
      {
        t: 'blocked',
        code: 'elevated-target',
        message: blockedReport.message,
        appName: 'Minecraft',
      },
    ])
    // Asked once per target, not once per 25ms tick.
    expect(calls).toBe(1)
  })

  it('says nothing when the adapter reports the target is reachable', () => {
    const h = runtimeHarness((native) => ({
      ...native,
      describeForegroundBlocking: (): ForegroundBlockingReport => ({
        ...blockedReport,
        ok: true,
        severity: 'ok',
        message: 'Minecraft looks reachable.',
      }),
    }))
    h.port.emit({ t: 'arm', config: config() })
    h.advanceAlive(5_000)
    expect(h.port.sent.some((message) => message.t === 'blocked')).toBe(false)
  })
})

describe('failsafe handlers', () => {
  it('registers every exit path named in the spec', () => {
    const h = runtimeHarness()
    const proc = createFakeProcess()
    installFailsafeHandlers(h.runtime, proc)
    expect([...proc.handlers.keys()].sort()).toEqual(
      ['SIGHUP', 'SIGINT', 'SIGTERM', 'exit', 'uncaughtException'].sort(),
    )
    expect(FAILSAFE_SIGNALS).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
  })

  it.each(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'])(
    'releases everything exactly once when %s fires',
    (event) => {
      const h = runtimeHarness()
      const proc = createFakeProcess()
      installFailsafeHandlers(h.runtime, proc)
      h.port.emit({ t: 'arm', config: config() })
      h.advanceAlive(300)
      expect(h.fake.count('keyDown:key-w')).toBe(1)

      proc.fire(event)
      expect(h.fake.count('keyUp:key-w')).toBe(1)
      expect(h.fake.count('releaseAll')).toBe(1)
      expect(h.runtime.shutdownCount).toBe(1)

      // Firing again, and firing every other handler too, must not double-release.
      proc.fire(event)
      for (const other of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException']) {
        proc.fire(other)
      }
      expect(h.fake.count('keyUp:key-w')).toBe(1)
      expect(h.fake.count('releaseAll')).toBe(1)
      expect(h.fake.count('dispose')).toBe(1)
    },
  )

  it('does not call process.exit from inside the exit handler', () => {
    const h = runtimeHarness()
    const proc = createFakeProcess()
    installFailsafeHandlers(h.runtime, proc)
    h.port.emit({ t: 'arm', config: config() })
    h.advanceAlive(300)

    proc.fire('exit')
    expect(h.fake.count('releaseAll')).toBe(1)
    expect(h.exitCodes).toHaveLength(0)
  })

  it('exits non-zero on an uncaught exception and zero on a signal', () => {
    const a = runtimeHarness()
    const procA = createFakeProcess()
    installFailsafeHandlers(a.runtime, procA)
    procA.fire('uncaughtException')
    expect(a.exitCodes).toEqual([1])

    const b = runtimeHarness()
    const procB = createFakeProcess()
    installFailsafeHandlers(b.runtime, procB)
    procB.fire('SIGTERM')
    expect(b.exitCodes).toEqual([0])
  })

  it('stops the loop dead after a shutdown, so no tick can press again', () => {
    const h = runtimeHarness()
    const proc = createFakeProcess()
    installFailsafeHandlers(h.runtime, proc)
    h.port.emit({ t: 'arm', config: config() })
    h.advanceAlive(300)
    proc.fire('SIGINT')

    const after = h.fake.calls.length
    h.advanceAlive(10_000)
    expect(h.fake.calls).toHaveLength(after)
  })
})

describe('port failures', () => {
  it('keeps releasing keys even when the port is dead', () => {
    const clock = createFakeClock()
    const fake = createFakeNative()
    const port = createFakePort()
    const broken: FakePort = {
      ...port,
      postMessage(): void {
        throw new Error('parent port is gone')
      },
    }
    const exitCodes: number[] = []
    const runtime = createInjectorRuntime({
      port: broken,
      native: fake.native,
      clock,
      spinMs: 0,
      platform: 'darwin',
      exit: (code) => exitCodes.push(code),
    })
    runtime.start()
    broken.emit({ t: 'arm', config: config() })
    for (let i = 0; i < 3; i++) {
      clock.advance(HEARTBEAT_INTERVAL_MS)
      broken.emit({ t: 'ping', n: i })
    }
    expect(fake.count('keyDown:key-w')).toBe(1)

    runtime.shutdown('signal', 0)
    expect(fake.count('keyUp:key-w')).toBe(1)
    expect(fake.count('releaseAll')).toBe(1)
    expect(exitCodes).toEqual([0])
  })
})
