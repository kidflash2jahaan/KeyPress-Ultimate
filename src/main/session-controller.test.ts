import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DisarmReason, InjectorToMainMessage, MainToInjectorMessage } from '@shared/ipc'
import type { SessionConfig, SessionPhase, SessionState, Settings } from '@shared/types'
import type { HeldKeysJournalDraft } from './journal'
import { DEFAULT_PANIC_HOTKEY, type GlobalShortcutLike } from './panic-hotkey'
import {
  SessionController,
  SOFT_RELEASE_REASONS,
  terminalPhaseFor,
  type Clock,
  type ForkInjector,
  type InjectorHandle,
  type PowerEventName,
  type PowerMonitorLike,
  type ProcessFailsafeTarget,
  type ProcessSignalListener,
  type ReleaseEvent,
  type SessionControllerOptions,
  type TimerHandle,
} from './session-controller'

// ---------------------------------------------------------------------------
// Fakes. Electron is never touched: every dependency comes in through options.
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  #now = 0
  #nextId = 1
  readonly #timers = new Map<number, { at: number; fn: () => void; every: number | null }>()

  now(): number {
    return this.#now
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++
    this.#timers.set(id, { at: this.#now + ms, fn, every: null })
    return id
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++
    this.#timers.set(id, { at: this.#now + ms, fn, every: ms })
    return id
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number)
  }

  clearInterval(handle: TimerHandle): void {
    this.#timers.delete(handle as number)
  }

  get pendingTimers(): number {
    return this.#timers.size
  }

  advance(ms: number): void {
    const target = this.#now + ms
    let guard = 0
    for (;;) {
      let dueId = -1
      let dueAt = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at
          dueId = id
        }
      }
      if (dueId === -1) break
      if (++guard > 500_000) throw new Error('fake clock timer storm')
      const timer = this.#timers.get(dueId)
      if (timer === undefined) break
      this.#now = timer.at
      if (timer.every === null) this.#timers.delete(dueId)
      else timer.at = timer.at + timer.every
      timer.fn()
    }
    this.#now = target
  }
}

class FakeGlobalShortcut implements GlobalShortcutLike {
  readonly registered = new Map<string, () => void>()
  readonly takenByOthers = new Set<string>()
  throwOn: string | null = null

  register(accelerator: string, callback: () => void): boolean {
    if (this.throwOn === accelerator) throw new Error('invalid accelerator')
    if (this.takenByOthers.has(accelerator)) return false
    this.registered.set(accelerator, callback)
    return true
  }

  isRegistered(accelerator: string): boolean {
    return this.registered.has(accelerator)
  }

  unregister(accelerator: string): void {
    this.registered.delete(accelerator)
  }

  trigger(accelerator: string): void {
    const callback = this.registered.get(accelerator)
    if (callback === undefined) throw new Error(`${accelerator} is not registered`)
    callback()
  }
}

class FakePowerMonitor implements PowerMonitorLike {
  readonly listeners = new Map<PowerEventName, Set<() => void>>()

  on(event: PowerEventName, listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set<() => void>()
    set.add(listener)
    this.listeners.set(event, set)
  }

  removeListener(event: PowerEventName, listener: () => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: PowerEventName): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener()
  }
}

class FakeProcessTarget implements ProcessFailsafeTarget {
  readonly pid = 4242
  readonly listeners = new Map<string, Set<ProcessSignalListener>>()

  on(event: string, listener: ProcessSignalListener): void {
    const set = this.listeners.get(event) ?? new Set<ProcessSignalListener>()
    set.add(listener)
    this.listeners.set(event, set)
  }

  removeListener(event: string, listener: ProcessSignalListener): void {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class FakeJournal {
  readonly writes: HeldKeysJournalDraft[] = []
  cleared = 0
  present = false

  constructor(private readonly ops: string[]) {}

  write(draft: HeldKeysJournalDraft): boolean {
    this.ops.push('journal-write')
    this.writes.push(draft)
    this.present = true
    return true
  }

  clear(): boolean {
    this.ops.push('journal-clear')
    this.cleared += 1
    this.present = false
    return true
  }
}

/**
 * Stands in for the injector process. It models the parts of the real
 * injector's behaviour the controller depends on: it pongs, it reports its
 * firing set, and on disarm it releases and says so.
 */
class FakeInjector implements InjectorHandle {
  readonly pid = 5555
  readonly posted: MainToInjectorMessage[] = []
  killed = false
  /** Stops responding to disarm, modelling a wedged or hung injector. */
  wedged = false
  /** Stops ponging, modelling a dead or blocked injector. */
  silent = false

  firingKeyIds: string[] = []
  firingButtonIds: string[] = []
  onTarget = false

  readonly #messageListeners: Array<(message: InjectorToMainMessage) => void> = []
  readonly #exitListeners: Array<(code: number | null) => void> = []

  postMessage(message: MainToInjectorMessage): void {
    this.posted.push(message)
    if (message.t === 'ping' && !this.silent) this.emit({ t: 'pong', n: message.n })
    if (message.t === 'disarm' && !this.wedged) this.releaseEverything()
  }

  onMessage(listener: (message: InjectorToMainMessage) => void): void {
    this.#messageListeners.push(listener)
  }

  onExit(listener: (code: number | null) => void): void {
    this.#exitListeners.push(listener)
  }

  kill(): void {
    this.killed = true
  }

  emit(message: InjectorToMainMessage): void {
    for (const listener of [...this.#messageListeners]) listener(message)
  }

  exit(code: number | null = 0): void {
    for (const listener of [...this.#exitListeners]) listener(code)
  }

  // -- behaviours the real injector performs on its own 25ms tick ------------

  focusTarget(keyIds: string[], buttonIds: string[]): void {
    this.onTarget = true
    this.firingKeyIds = [...keyIds]
    this.firingButtonIds = [...buttonIds]
    this.#pushState()
  }

  /** Focus moved away and the injector released, which is the normal path. */
  loseFocus(): void {
    this.onTarget = false
    this.firingKeyIds = []
    this.firingButtonIds = []
    this.#pushState()
  }

  /** Focus moved away and the injector did NOT release. The nightmare case. */
  loseFocusWithoutReleasing(): void {
    this.onTarget = false
    this.#pushState()
  }

  releaseEverything(): void {
    const count = this.firingKeyIds.length + this.firingButtonIds.length
    this.firingKeyIds = []
    this.firingButtonIds = []
    this.onTarget = false
    this.emit({ t: 'released', count })
  }

  #pushState(): void {
    this.emit({
      t: 'state',
      firingKeyIds: [...this.firingKeyIds],
      firingButtonIds: [...this.firingButtonIds],
      onTarget: this.onTarget,
      focusedPid: this.onTarget ? 777 : 888,
    })
  }
}

const SETTINGS: Settings = {
  theme: 'system',
  panicHotkey: DEFAULT_PANIC_HOTKEY,
  maxSessionMinutes: 30,
  autoCheckUpdates: true,
  windowsUseVirtualKeys: false,
}

const CONFIG: SessionConfig = {
  keyIds: ['key-w'],
  buttonIds: ['left'],
  targets: ['com.mojang.minecraft'],
  mode: 'hold',
  repeatInitialMs: 400,
  repeatIntervalMs: 33,
  tapIntervalMs: 100,
}

interface Harness {
  controller: SessionController
  clock: FakeClock
  shortcuts: FakeGlobalShortcut
  power: FakePowerMonitor
  proc: FakeProcessTarget
  journal: FakeJournal
  ops: string[]
  states: SessionState[]
  releases: ReleaseEvent[]
  permissionGranted: { value: boolean }
  injectors: FakeInjector[]
  injector: () => FakeInjector
  detachProcess: () => void
}

function setup(overrides: Partial<SessionControllerOptions> = {}): Harness {
  const ops: string[] = []
  const clock = new FakeClock()
  const shortcuts = new FakeGlobalShortcut()
  const power = new FakePowerMonitor()
  const proc = new FakeProcessTarget()
  const journal = new FakeJournal(ops)
  const permissionGranted = { value: true }
  const injectors: FakeInjector[] = []

  const forkInjector: ForkInjector = () => {
    ops.push('fork')
    const injector = new FakeInjector()
    injectors.push(injector)
    return injector
  }

  const controller = new SessionController({
    settings: SETTINGS,
    clock,
    journal,
    forkInjector,
    globalShortcut: shortcuts,
    powerMonitor: power,
    processTarget: proc,
    permissions: { hasPermission: () => permissionGranted.value },
    ...overrides,
  })

  const states: SessionState[] = []
  const releases: ReleaseEvent[] = []
  controller.onState((state) => states.push(state))
  controller.onRelease((event) => releases.push(event))
  const detachProcess = controller.attachProcessFailsafes()

  return {
    controller,
    clock,
    shortcuts,
    power,
    proc,
    journal,
    ops,
    states,
    releases,
    permissionGranted,
    injectors,
    injector: () => {
      const injector = injectors[injectors.length - 1]
      if (injector === undefined) throw new Error('no injector was forked')
      return injector
    },
    detachProcess,
  }
}

function armAndFire(h: Harness, config: SessionConfig = CONFIG): void {
  const result = h.controller.arm(config)
  expect(result).toEqual({ ok: true })
  h.injector().focusTarget(config.keyIds, config.buttonIds)
  expect(h.controller.getState().phase).toBe('firing')
}

// ---------------------------------------------------------------------------
// Arm
// ---------------------------------------------------------------------------

describe('arm', () => {
  it('registers the panic hotkey, writes the journal, then forks the injector', () => {
    const h = setup()
    expect(h.controller.arm(CONFIG)).toEqual({ ok: true })

    // The journal has to be durable before anything can press a key, and the
    // only thing that can press a key is the process forked after it.
    expect(h.ops).toEqual(['journal-write', 'fork'])
    expect(h.journal.writes).toEqual([
      {
        pid: 4242,
        injectorPid: null,
        startedAt: 0,
        keyIds: ['key-w'],
        buttonIds: ['left'],
      },
    ])
    expect(h.shortcuts.isRegistered(DEFAULT_PANIC_HOTKEY)).toBe(true)
  })

  it('sends settings before arm so the injector never runs on stale settings', () => {
    const h = setup()
    h.controller.arm(CONFIG)
    expect(h.injector().posted.map((m) => m.t).slice(0, 2)).toEqual(['settings', 'arm'])
  })

  it('lands in armed-waiting, not firing, because our own window is focused at Start', () => {
    const h = setup({ resolveTargetName: () => 'Minecraft' })
    h.controller.arm(CONFIG)

    const state = h.controller.getState()
    expect(state.phase).toBe('armed-waiting')
    expect(state.onTarget).toBe(false)
    expect(state.firingKeyIds).toEqual([])
    expect(state.message).toBe('Armed, waiting for Minecraft.')
  })

  it('refuses a second arm', () => {
    const h = setup()
    h.controller.arm(CONFIG)
    expect(h.controller.arm(CONFIG)).toEqual({
      ok: false,
      code: 'already-armed',
      message: 'A session is already running.',
    })
    expect(h.injectors).toHaveLength(1)
  })

  it('refuses an empty selection and an empty target list', () => {
    const h = setup()
    expect(h.controller.arm({ ...CONFIG, keyIds: [], buttonIds: [] })).toMatchObject({
      ok: false,
      code: 'nothing-selected',
    })
    expect(h.controller.arm({ ...CONFIG, targets: [] })).toMatchObject({
      ok: false,
      code: 'no-targets',
    })
    expect(h.injectors).toHaveLength(0)
  })

  it('blocks on a missing permission and forks nothing', () => {
    const h = setup()
    h.permissionGranted.value = false

    const result = h.controller.arm(CONFIG)
    expect(result).toMatchObject({ ok: false, code: 'permission-required' })
    expect(h.controller.getState().phase).toBe('blocked')
    expect(h.injectors).toHaveLength(0)
    expect(h.journal.writes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Panic hotkey
// ---------------------------------------------------------------------------

describe('panic hotkey', () => {
  it('refuses Start and names the conflict when the combination is taken', () => {
    const h = setup()
    h.shortcuts.takenByOthers.add(DEFAULT_PANIC_HOTKEY)

    const result = h.controller.arm(CONFIG)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('panic-hotkey-unavailable')
    expect(result.message).toContain(DEFAULT_PANIC_HOTKEY)
    expect(result.message).toContain('already taken by another app')
    // A panic button that silently does nothing is worse than none, so nothing
    // starts at all.
    expect(h.injectors).toHaveLength(0)
    expect(h.journal.writes).toHaveLength(0)
    expect(h.controller.getState().message).toBe(result.message)
  })

  it('refuses Start when register succeeds but isRegistered disagrees', () => {
    const h = setup()
    const shortcuts: GlobalShortcutLike = {
      register: () => true,
      isRegistered: () => false,
      unregister: () => undefined,
    }
    const controller = new SessionController({
      settings: SETTINGS,
      clock: h.clock,
      journal: h.journal,
      forkInjector: () => new FakeInjector(),
      globalShortcut: shortcuts,
    })
    expect(controller.arm(CONFIG)).toMatchObject({ ok: false, code: 'panic-hotkey-unavailable' })
  })

  it('refuses a media key, which would depend on a permission the panic path has to survive without', () => {
    const h = setup({ settings: { ...SETTINGS, panicHotkey: 'MediaPlayPause' } })
    const result = h.controller.arm(CONFIG)
    expect(result).toMatchObject({ ok: false, code: 'panic-hotkey-unavailable' })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('Media and volume keys')
    expect(h.shortcuts.registered.size).toBe(0)
  })

  it('refuses a hotkey with no modifier', () => {
    const h = setup({ settings: { ...SETTINGS, panicHotkey: 'K' } })
    expect(h.controller.arm(CONFIG)).toMatchObject({
      ok: false,
      code: 'panic-hotkey-unavailable',
    })
  })

  it('refuses when the panic hotkey uses a key the user asked to hold', () => {
    const h = setup()
    const result = h.controller.arm({ ...CONFIG, keyIds: ['key-w', 'key-k'] })
    expect(result).toMatchObject({ ok: false, code: 'panic-hotkey-conflict' })
    expect(h.injectors).toHaveLength(0)
  })

  it('is registered only while a session is armed', () => {
    const h = setup()
    expect(h.shortcuts.registered.size).toBe(0)

    h.controller.arm(CONFIG)
    expect(h.shortcuts.registered.size).toBe(1)

    h.controller.disarm('user-stop')
    expect(h.shortcuts.registered.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The failsafe fan-in. This is the point of the whole module.
// ---------------------------------------------------------------------------

interface Trigger {
  name: string
  reason: DisarmReason
  hardStop: boolean
  fire: (h: Harness) => void
}

const TRIGGERS: Trigger[] = [
  {
    name: 'stop pressed',
    reason: 'user-stop',
    hardStop: true,
    fire: (h) => h.controller.disarm('user-stop'),
  },
  {
    name: 'target loses focus',
    reason: 'focus-lost',
    hardStop: false,
    fire: (h) => h.injector().loseFocus(),
  },
  {
    name: 'target quits',
    reason: 'target-quit',
    hardStop: false,
    fire: (h) => {
      h.controller.handleTargetQuit()
      h.injector().loseFocus()
    },
  },
  {
    name: 'app quit',
    reason: 'app-quit',
    hardStop: true,
    fire: (h) => h.controller.handleAppQuit(),
  },
  {
    name: 'window close',
    reason: 'window-closed',
    hardStop: true,
    fire: (h) => h.controller.handleWindowClosed(),
  },
  {
    name: 'uncaughtException',
    reason: 'uncaught-exception',
    hardStop: true,
    fire: (h) => h.proc.emit('uncaughtException', new Error('boom')),
  },
  {
    name: 'SIGINT',
    reason: 'signal',
    hardStop: true,
    fire: (h) => h.proc.emit('SIGINT'),
  },
  {
    name: 'SIGTERM',
    reason: 'signal',
    hardStop: true,
    fire: (h) => h.proc.emit('SIGTERM'),
  },
  {
    name: 'powerMonitor suspend',
    reason: 'power-suspend',
    hardStop: true,
    fire: (h) => h.power.emit('suspend'),
  },
  {
    name: 'powerMonitor lock-screen',
    reason: 'screen-locked',
    hardStop: true,
    fire: (h) => h.power.emit('lock-screen'),
  },
  {
    name: 'permission revoked mid-session',
    reason: 'permission-revoked',
    hardStop: true,
    fire: (h) => {
      h.permissionGranted.value = false
      h.clock.advance(1_000)
    },
  },
  {
    name: 'heartbeat timeout',
    reason: 'heartbeat-timeout',
    hardStop: true,
    fire: (h) => {
      h.injector().silent = true
      h.clock.advance(500)
    },
  },
  {
    name: 'panic hotkey',
    reason: 'panic-hotkey',
    hardStop: true,
    fire: (h) => h.shortcuts.trigger(DEFAULT_PANIC_HOTKEY),
  },
  {
    name: 'maxSessionMinutes cap reached',
    reason: 'max-session-time',
    hardStop: true,
    fire: (h) => h.clock.advance(30 * 60_000 + 1),
  },
]

describe('failsafe fan-in', () => {
  it('enumerates every failsafe the spec names', () => {
    expect(TRIGGERS.map((trigger) => trigger.name)).toEqual([
      'stop pressed',
      'target loses focus',
      'target quits',
      'app quit',
      'window close',
      'uncaughtException',
      'SIGINT',
      'SIGTERM',
      'powerMonitor suspend',
      'powerMonitor lock-screen',
      'permission revoked mid-session',
      'heartbeat timeout',
      'panic hotkey',
      'maxSessionMinutes cap reached',
    ])
  })

  for (const trigger of TRIGGERS) {
    it(`releases everything when ${trigger.name}`, () => {
      const h = setup()
      armAndFire(h)

      trigger.fire(h)

      const events = h.releases.filter((event) => event.reason === trigger.reason)
      expect(events).toHaveLength(1)
      const event = events[0]
      if (event === undefined) throw new Error('unreachable')

      // Every path reports what it released, and reports it as confirmed.
      expect(event.keyIds).toEqual(['key-w'])
      expect(event.buttonIds).toEqual(['left'])
      expect(event.confirmed).toBe(true)
      expect(event.hardStop).toBe(trigger.hardStop)

      // And nothing is held afterwards.
      const state = h.controller.getState()
      expect(state.firingKeyIds).toEqual([])
      expect(state.firingButtonIds).toEqual([])
      expect(state.onTarget).toBe(false)

      if (trigger.hardStop) {
        const disarms = h
          .injector()
          .posted.filter((message) => message.t === 'disarm')
          .map((message) => (message.t === 'disarm' ? message.reason : null))
        expect(disarms).toContain(trigger.reason)
        expect(h.injector().killed).toBe(true)
        expect(h.controller.isArmed).toBe(false)
        expect(h.shortcuts.registered.size).toBe(0)
        expect(h.journal.present).toBe(false)
        expect(h.clock.pendingTimers).toBe(0)
      } else {
        // Focus loss and target quit leave the session armed, because the user
        // still wants the keys held the moment the target comes back.
        expect(h.controller.isArmed).toBe(true)
        expect(state.phase).toBe('armed-waiting')
        expect(h.injector().killed).toBe(false)
        expect(h.shortcuts.registered.size).toBe(1)
        expect(h.journal.present).toBe(true)
      }
    })
  }

  it('routes exactly two reasons through the soft path', () => {
    expect([...SOFT_RELEASE_REASONS].sort()).toEqual(['focus-lost', 'target-quit'])
  })

  it('is idempotent: a second stop does not produce a second release', () => {
    const h = setup()
    armAndFire(h)

    h.controller.disarm('user-stop')
    h.controller.disarm('user-stop')
    h.controller.disarm('app-quit')
    h.controller.handleWindowClosed()
    h.proc.emit('SIGTERM')

    expect(h.releases).toHaveLength(1)
    expect(h.journal.cleared).toBe(1)
  })

  it('collapses two failsafes firing at the same instant into one release', () => {
    const h = setup()
    armAndFire(h)

    h.shortcuts.trigger(DEFAULT_PANIC_HOTKEY)
    h.power.emit('suspend')

    expect(h.releases.map((event) => event.reason)).toEqual(['panic-hotkey'])
  })

  it('does nothing when a failsafe fires while idle', () => {
    const h = setup()
    h.power.emit('suspend')
    h.proc.emit('SIGINT')
    h.controller.disarm('user-stop')

    expect(h.releases).toHaveLength(0)
    expect(h.controller.getState().phase).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// Soft releases
// ---------------------------------------------------------------------------

describe('focus loss', () => {
  it('keeps the session armed and re-fires when the target comes back', () => {
    const h = setup({ resolveTargetName: () => 'Minecraft' })
    armAndFire(h)

    h.injector().loseFocus()
    expect(h.controller.getState().phase).toBe('armed-waiting')
    expect(h.controller.getState().message).toBe('Armed, waiting for Minecraft.')

    h.injector().focusTarget(['key-w'], ['left'])
    expect(h.controller.getState().phase).toBe('firing')
    expect(h.controller.getState().firingKeyIds).toEqual(['key-w'])
  })

  it('escalates to a hard stop when the injector loses focus and does not release', () => {
    const h = setup()
    armAndFire(h)
    h.injector().wedged = true

    h.injector().loseFocusWithoutReleasing()
    // Still armed while the watchdog waits.
    expect(h.controller.isArmed).toBe(true)

    h.clock.advance(500)
    // The grace window for the hard stop that follows.
    h.clock.advance(250)

    expect(h.controller.isArmed).toBe(false)
    expect(h.controller.getState().phase).toBe('error')
    expect(h.injector().killed).toBe(true)
    const last = h.releases[h.releases.length - 1]
    expect(last?.reason).toBe('focus-lost')
    expect(last?.hardStop).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Unconfirmed releases
// ---------------------------------------------------------------------------

describe('unconfirmed releases', () => {
  it('leaves the journal on disk when the injector never confirms', () => {
    const h = setup()
    armAndFire(h)
    h.injector().wedged = true

    h.controller.disarm('user-stop')
    expect(h.journal.present).toBe(true) // still waiting
    h.clock.advance(250)

    expect(h.releases[0]?.confirmed).toBe(false)
    // The file is the only thing that can rescue the next launch, so it stays.
    expect(h.journal.present).toBe(true)
    expect(h.journal.cleared).toBe(0)
    expect(h.controller.getState().message).toContain('Some keys may still be held')
  })

  it('uses the main-side release fallback when the injector wedges, and then clears the journal', () => {
    const fallback = vi.fn(() => 2)
    const h = setup({ releaseFallback: fallback })
    armAndFire(h)
    h.injector().wedged = true

    h.controller.disarm('user-stop')
    h.clock.advance(250)

    expect(fallback).toHaveBeenCalledWith(['key-w'], ['left'])
    expect(h.releases[0]?.confirmed).toBe(true)
    expect(h.journal.present).toBe(false)
  })

  it('does not wait for a confirmation when the session never pressed anything', () => {
    const h = setup()
    h.controller.arm(CONFIG)
    h.injector().wedged = true

    h.controller.disarm('user-stop')

    expect(h.releases[0]?.confirmed).toBe(true)
    expect(h.releases[0]?.keyIds).toEqual([])
    expect(h.journal.present).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Injector faults
// ---------------------------------------------------------------------------

describe('injector faults', () => {
  it('blocks, rather than errors, when Windows refuses the injection', () => {
    const h = setup()
    armAndFire(h)

    h.injector().emit({
      t: 'error',
      code: 'injection-blocked',
      message: 'SendInput reported success but nothing happened',
    })

    const state = h.controller.getState()
    expect(state.phase).toBe('blocked')
    expect(state.message).toContain('running as administrator')
    expect(h.releases.map((event) => event.reason)).toEqual(['injector-error'])
  })

  it('blocks when the permission is denied inside the injector', () => {
    const h = setup()
    armAndFire(h)
    h.injector().emit({ t: 'error', code: 'permission-denied', message: '' })
    expect(h.controller.getState().phase).toBe('blocked')
  })

  it('errors on a struct layout mismatch rather than posting garbage', () => {
    const h = setup()
    armAndFire(h)
    h.injector().emit({ t: 'error', code: 'struct-layout-mismatch', message: '' })

    const state = h.controller.getState()
    expect(state.phase).toBe('error')
    expect(state.message).toContain('not the layout it expects')
  })

  it('releases and errors when the injector exits on its own', () => {
    const h = setup()
    armAndFire(h)

    h.injector().exit(9)

    expect(h.controller.getState().phase).toBe('error')
    expect(h.controller.getState().message).toContain('stopped unexpectedly')
    expect(h.releases.map((event) => event.reason)).toEqual(['injector-error'])
    expect(h.controller.isArmed).toBe(false)
    // Nothing survived to confirm the ups, so the journal stays and the next
    // launch replays them.
    expect(h.releases[0]?.confirmed).toBe(false)
    expect(h.journal.present).toBe(true)
    expect(h.controller.getState().message).toContain('Some keys may still be held')
  })

  it('recovers the ups through the main-side fallback when the injector dies', () => {
    const fallback = vi.fn(() => 2)
    const h = setup({ releaseFallback: fallback })
    armAndFire(h)

    h.injector().exit(null)

    expect(fallback).toHaveBeenCalledWith(['key-w'], ['left'])
    expect(h.releases[0]?.confirmed).toBe(true)
    expect(h.journal.present).toBe(false)
  })

  it('refuses Start and cleans up when the fork itself throws', () => {
    const ops: string[] = []
    const shortcuts = new FakeGlobalShortcut()
    const journal = new FakeJournal(ops)
    const controller = new SessionController({
      settings: SETTINGS,
      clock: new FakeClock(),
      journal,
      globalShortcut: shortcuts,
      forkInjector: () => {
        throw new Error('utilityProcess unavailable')
      },
    })

    expect(controller.arm(CONFIG)).toMatchObject({ ok: false, code: 'fork-failed' })
    expect(controller.getState().phase).toBe('error')
    expect(shortcuts.registered.size).toBe(0)
    expect(journal.present).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Timers and settings
// ---------------------------------------------------------------------------

describe('maxSessionMinutes', () => {
  it('treats 0 as unlimited', () => {
    const h = setup({ settings: { ...SETTINGS, maxSessionMinutes: 0 } })
    armAndFire(h)

    h.clock.advance(4 * 60 * 60_000)

    expect(h.controller.isArmed).toBe(true)
    expect(h.releases).toHaveLength(0)
  })

  it('caps at the configured number of minutes', () => {
    const h = setup({ settings: { ...SETTINGS, maxSessionMinutes: 1 } })
    armAndFire(h)

    h.clock.advance(59_999)
    expect(h.controller.isArmed).toBe(true)

    h.clock.advance(2)
    expect(h.controller.isArmed).toBe(false)
    expect(h.controller.getState().message).toContain('1 minute session limit')
  })

  it('floors a nonsense fraction of a minute at ten seconds', () => {
    const h = setup({ settings: { ...SETTINGS, maxSessionMinutes: 0.001 } })
    armAndFire(h)

    h.clock.advance(9_000)
    expect(h.controller.isArmed).toBe(true)
    h.clock.advance(1_001)
    expect(h.controller.isArmed).toBe(false)
  })
})

describe('heartbeat', () => {
  it('pings on the shared interval and keeps the session alive while ponged', () => {
    const h = setup()
    armAndFire(h)

    h.clock.advance(1_000)

    const pings = h.injector().posted.filter((message) => message.t === 'ping')
    expect(pings.length).toBe(10)
    expect(h.controller.isArmed).toBe(true)
  })
})

describe('settings', () => {
  it('forwards a settings change to a running injector', () => {
    const h = setup()
    armAndFire(h)
    const next: Settings = { ...SETTINGS, windowsUseVirtualKeys: true }

    h.controller.setSettings(next)

    const forwarded = h.injector().posted.filter((message) => message.t === 'settings')
    expect(forwarded).toHaveLength(2)
    expect(forwarded[1]).toEqual({ t: 'settings', settings: next })
  })
})

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const ALL_PHASES: SessionPhase[] = ['idle', 'armed-waiting', 'firing', 'blocked', 'error']

describe('session phases', () => {
  let seen: Set<SessionPhase>

  beforeEach(() => {
    seen = new Set<SessionPhase>()
  })

  it('emits a state on every transition and never leaves the phase union', () => {
    const h = setup()
    h.controller.onState((state) => seen.add(state.phase))

    h.controller.arm(CONFIG)
    h.injector().focusTarget(['key-w'], ['left'])
    h.injector().loseFocus()
    h.injector().focusTarget(['key-w'], ['left'])
    h.injector().emit({ t: 'error', code: 'injection-blocked', message: '' })

    expect([...seen]).toEqual(expect.arrayContaining(['armed-waiting', 'firing', 'blocked']))
    for (const state of h.states) expect(ALL_PHASES).toContain(state.phase)

    // idle and error are reachable too.
    const other = setup()
    other.controller.arm(CONFIG)
    other.controller.disarm('user-stop')
    expect(other.controller.getState().phase).toBe('idle')
    other.controller.arm(CONFIG)
    other.injector().exit(1)
    expect(other.controller.getState().phase).toBe('error')
  })

  it('does not re-emit an unchanged state', () => {
    const h = setup()
    h.controller.arm(CONFIG)
    const before = h.states.length
    h.injector().focusTarget(['key-w'], ['left'])
    h.injector().focusTarget(['key-w'], ['left'])
    expect(h.states.length).toBe(before + 1)
  })

  it('maps reasons to the terminal phase the UI expects', () => {
    expect(terminalPhaseFor('user-stop')).toBe('idle')
    expect(terminalPhaseFor('panic-hotkey')).toBe('idle')
    expect(terminalPhaseFor('max-session-time')).toBe('idle')
    expect(terminalPhaseFor('permission-revoked')).toBe('blocked')
    expect(terminalPhaseFor('heartbeat-timeout')).toBe('error')
    expect(terminalPhaseFor('uncaught-exception')).toBe('error')
    expect(terminalPhaseFor('injector-error')).toBe('error')
  })

  it('survives a listener that throws, because a release must not depend on the UI', () => {
    const onError = vi.fn()
    const h = setup({ onError })
    h.controller.onState(() => {
      throw new Error('renderer went away')
    })
    armAndFire(h)

    h.controller.disarm('user-stop')

    expect(h.releases).toHaveLength(1)
    expect(h.journal.present).toBe(false)
    expect(onError).toHaveBeenCalled()
  })
})

describe('dispose', () => {
  it('releases, unsubscribes from powerMonitor, and stops emitting', () => {
    const h = setup()
    armAndFire(h)
    h.detachProcess()

    h.controller.dispose()

    expect(h.releases.map((event) => event.reason)).toEqual(['app-quit'])
    expect([...h.power.listeners.values()].every((set) => set.size === 0)).toBe(true)
    expect(h.clock.pendingTimers).toBe(0)
  })
})
