/**
 * The session controller: the safety layer.
 *
 * It owns one thing, the lifecycle of a hold session, and it owns all of it.
 * Fork the injector at arm, kill it at disarm, keep a heartbeat, watch the
 * clock, watch the power state, watch the permission, hold the panic hotkey,
 * write the journal, and route every possible ending through one idempotent
 * release path.
 *
 * The failsafe fan-in is the reason this module exists. Thirteen different
 * things can end a session:
 *
 *   stop pressed, target loses focus, target quits, app quit, window close,
 *   uncaughtException, SIGINT/SIGTERM/SIGHUP, powerMonitor suspend,
 *   powerMonitor lock-screen, permission revoked mid-session, heartbeat
 *   timeout, panic hotkey, maxSessionMinutes cap reached
 *
 * Every one of them calls `#release`, which is idempotent and safe to call
 * re-entrantly, from a signal handler, or twice at once. There is no second
 * teardown path anywhere in the app.
 *
 * Two of those thirteen are soft: losing focus and the target quitting leave
 * the session armed and waiting, because the user's intent is still "hold W in
 * Minecraft" and Minecraft will be back. The injector performs those releases
 * itself on its 25ms tick, so the controller's job for them is to verify the
 * release actually happened and escalate to a hard stop if it did not.
 *
 * Electron is never imported at module scope. Every Electron dependency comes
 * in through the options object and falls back to a lazily loaded real
 * implementation, so the entire module runs under vitest against fakes.
 */
import { join } from 'node:path'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  type DisarmReason,
  type InjectorErrorCode,
  type InjectorToMainMessage,
  type MainToInjectorMessage,
} from '@shared/ipc'
import type { AppInfo, SessionConfig, SessionPhase, SessionState, Settings } from '@shared/types'
import type { HoldJournal } from './journal'
import {
  PanicHotkey,
  describePanicHotkeyConflict,
  panicHotkeyConflicts,
  type GlobalShortcutLike,
} from './panic-hotkey'

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** Opaque to this module; whatever the clock's timer functions returned. */
export type TimerHandle = unknown

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

/**
 * The injector as seen from main: a message pipe with a pid and a kill switch.
 * Nothing about `utilityProcess`, and nothing about the injector's internals,
 * leaks past this interface.
 */
export interface InjectorHandle {
  readonly pid: number | null
  postMessage(message: MainToInjectorMessage): void
  onMessage(listener: (message: InjectorToMainMessage) => void): void
  onExit(listener: (code: number | null) => void): void
  kill(): void
}

export interface ForkInjectorOptions {
  /** Built injector entry point. */
  modulePath: string
  /** Passed to the injector so it can refuse to press while we are frontmost. */
  mainPid: number
}

export type ForkInjector = (options: ForkInjectorOptions) => InjectorHandle

export type PowerEventName = 'suspend' | 'lock-screen' | 'shutdown' | 'user-did-resign-active'

export interface PowerMonitorLike {
  on(event: PowerEventName, listener: () => void): void
  removeListener(event: PowerEventName, listener: () => void): void
}

/**
 * App Nap throttles timers in a process that is not frontmost, and this app is
 * never frontmost while it is working. A power-management assertion is one of
 * the documented exclusions, so the injector's 25ms tick keeps its period and,
 * more importantly, its release path stays prompt.
 */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

export interface PermissionProbe {
  /** True when input can actually be posted. Always true on Windows. */
  hasPermission(): boolean
}

export type ProcessSignalListener = (...args: unknown[]) => void

export interface ProcessFailsafeTarget {
  readonly pid: number
  on(event: string, listener: ProcessSignalListener): void
  removeListener(event: string, listener: ProcessSignalListener): void
}

/** The journal surface this module needs. `HoldJournal` satisfies it. */
export type SessionJournal = Pick<HoldJournal, 'write' | 'clear'>

// ---------------------------------------------------------------------------
// Public results
// ---------------------------------------------------------------------------

export type ArmRefusalCode =
  | 'already-armed'
  | 'nothing-selected'
  | 'no-targets'
  | 'permission-required'
  | 'panic-hotkey-unavailable'
  | 'panic-hotkey-conflict'
  | 'fork-failed'

export type ArmResult = { ok: true } | { ok: false; code: ArmRefusalCode; message: string }

export interface ReleaseEvent {
  reason: DisarmReason
  at: number
  /** What was held when the release began. Empty if nothing was pressed. */
  keyIds: string[]
  buttonIds: string[]
  /** False when a hard stop tore down without proof that the ups were posted. */
  confirmed: boolean
  /** True for a full teardown, false for focus loss and target quit. */
  hardStop: boolean
}

export interface SessionControllerOptions {
  settings: Settings
  clock?: Clock
  journal?: SessionJournal
  forkInjector?: ForkInjector
  /** Built injector entry. Defaults to `injector.js` next to the main bundle. */
  injectorPath?: string
  globalShortcut?: GlobalShortcutLike
  powerMonitor?: PowerMonitorLike
  powerSaveBlocker?: PowerSaveBlockerLike | null
  permissions?: PermissionProbe
  processTarget?: ProcessFailsafeTarget
  /** pid to `AppInfo`, normally the app registry. */
  resolveApp?: (pid: number | null) => AppInfo | null
  /** Target identity to display name, for the waiting message. */
  resolveTargetName?: (identity: string) => string | null
  /**
   * Last-resort release from main's own native binding, used when the injector
   * dies or wedges before confirming. Returns how many were released. When this
   * is null and a release cannot be confirmed, the journal is deliberately left
   * on disk so the next launch recovers.
   */
  releaseFallback?: ((keyIds: string[], buttonIds: string[]) => number) | null
  /** How long a hard stop waits for the injector to confirm. */
  releaseGraceMs?: number
  /** How long a soft release waits before escalating to a hard stop. */
  focusReleaseGraceMs?: number
  onError?: (message: string, error: unknown) => void
}

const DEFAULT_RELEASE_GRACE_MS = 250
const DEFAULT_FOCUS_RELEASE_GRACE_MS = 500
const PERMISSION_POLL_MS = 1000
/** Even "30 minutes" gets a floor, so a fat-fingered 0.001 cannot arm forever. */
const MIN_SESSION_MS = 10_000
/**
 * Node stores a timer delay in a signed 32-bit int. Anything larger overflows,
 * is silently clamped to 1ms, and fires immediately, which for the max-session
 * timer means the session ends the instant it starts. The store clamps
 * `maxSessionMinutes` too; this is the last line of defence, because the value
 * also arrives from settings files this build did not write.
 */
const MAX_TIMER_MS = 2_147_483_647

const POWER_EVENTS: ReadonlyArray<{ event: PowerEventName; reason: DisarmReason }> = [
  { event: 'suspend', reason: 'power-suspend' },
  { event: 'lock-screen', reason: 'screen-locked' },
  // macOS and Linux only. Registering it on Windows is harmless.
  { event: 'shutdown', reason: 'app-quit' },
  // macOS fast user switching. Another user's session is about to take the
  // keyboard, which is the same hazard as a lock.
  { event: 'user-did-resign-active', reason: 'screen-locked' },
]

const SIGNAL_EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** Reasons that leave the session armed rather than tearing it down. */
export const SOFT_RELEASE_REASONS: ReadonlySet<DisarmReason> = new Set<DisarmReason>([
  'focus-lost',
  'target-quit',
])

type TimerName =
  | 'heartbeat'
  | 'permission-poll'
  | 'max-session'
  | 'release-grace'
  | 'soft-release-watchdog'

/**
 * The injector's "Windows will not let me reach this window" report. The shape
 * lives in the IPC contract; this is only a name for it.
 */
type ElevatedTargetBlocked = Extract<InjectorToMainMessage, { t: 'blocked' }>

interface PendingRelease {
  reason: DisarmReason
  terminalPhase: SessionPhase
  message: string | null
  keyIds: string[]
  buttonIds: string[]
}

export class SessionController {
  readonly #options: SessionControllerOptions
  readonly #clock: Clock
  readonly #panic: PanicHotkey
  readonly #powerMonitor: PowerMonitorLike | null
  readonly #timers = new Map<TimerName, { handle: TimerHandle; kind: 'timeout' | 'interval' }>()
  readonly #stateListeners = new Set<(state: SessionState) => void>()
  readonly #releaseListeners = new Set<(event: ReleaseEvent) => void>()
  readonly #powerBindings: Array<{ event: PowerEventName; listener: () => void }> = []
  readonly #processBindings: Array<{ event: string; listener: ProcessSignalListener }> = []

  #settings: Settings
  #phase: SessionPhase = 'idle'
  #startedAt: number | null = null
  #firingKeyIds: string[] = []
  #firingButtonIds: string[] = []
  #focusedApp: AppInfo | null = null
  #onTarget = false
  #message: string | null = null
  #lastEmittedSignature = ''

  #config: SessionConfig | null = null
  #injector: InjectorHandle | null = null
  #armed = false
  #pending: PendingRelease | null = null
  /** Last non-empty firing set, so a release event can say what was released. */
  #lastHeld: { keyIds: string[]; buttonIds: string[] } = { keyIds: [], buttonIds: [] }
  /** A soft release waiting on the injector to confirm it let go. */
  #pendingSoftReason: DisarmReason | null = null
  #lastPongAt = 0
  #pingCounter = 0
  #powerSaveBlockerId: number | null = null
  #processTarget: ProcessFailsafeTarget | null = null
  #disposed = false

  constructor(options: SessionControllerOptions) {
    this.#options = options
    this.#settings = options.settings
    this.#clock = options.clock ?? systemClock
    this.#panic = new PanicHotkey(
      options.globalShortcut === undefined ? {} : { globalShortcut: options.globalShortcut },
    )
    this.#powerMonitor = options.powerMonitor ?? null
    this.#bindPowerMonitor()
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  getState(): SessionState {
    return {
      phase: this.#phase,
      startedAt: this.#startedAt,
      firingKeyIds: [...this.#firingKeyIds],
      firingButtonIds: [...this.#firingButtonIds],
      focusedApp: this.#focusedApp,
      onTarget: this.#onTarget,
      message: this.#message,
    }
  }

  onState(listener: (state: SessionState) => void): () => void {
    this.#stateListeners.add(listener)
    return () => this.#stateListeners.delete(listener)
  }

  onRelease(listener: (event: ReleaseEvent) => void): () => void {
    this.#releaseListeners.add(listener)
    return () => this.#releaseListeners.delete(listener)
  }

  get isArmed(): boolean {
    return this.#armed
  }

  setSettings(settings: Settings): void {
    const previous = this.#settings
    this.#settings = settings
    if (!this.#armed || this.#injector === null) return

    this.#post({ t: 'settings', settings })

    // The injector re-reads the cap the moment it is told, so main has to as
    // well. Leaving the old timeout running means the two sides disagree about
    // when the session ends: raising the cap mid-session would still hard-stop
    // at the original deadline, and lowering it would leave main's own failsafe
    // running long after the injector had self-disarmed.
    if (settings.maxSessionMinutes !== previous.maxSessionMinutes) {
      this.#startMaxSessionTimer()
    }
  }

  // -------------------------------------------------------------------------
  // Arm
  // -------------------------------------------------------------------------

  arm(config: SessionConfig): ArmResult {
    if (this.#disposed) {
      return { ok: false, code: 'already-armed', message: 'The session controller was disposed.' }
    }
    if (this.#armed) {
      return { ok: false, code: 'already-armed', message: 'A session is already running.' }
    }

    if (config.keyIds.length === 0 && config.buttonIds.length === 0) {
      return this.#refuse(
        'nothing-selected',
        'Pick at least one key or mouse button before starting.',
        'idle',
      )
    }
    if (config.targets.length === 0) {
      return this.#refuse(
        'no-targets',
        'Pick at least one target app. KeyPress Ultimate only holds keys while a target is frontmost.',
        'idle',
      )
    }

    // Permission first, because it is the only refusal that leaves the UI in a
    // state the user has to go somewhere else to fix.
    const permissions = this.#options.permissions
    if (permissions !== undefined && !permissions.hasPermission()) {
      return this.#refuse(
        'permission-required',
        'KeyPress Ultimate needs Accessibility permission to send key presses. Grant it in System Settings, then press Start again.',
        'blocked',
      )
    }

    const accelerator = this.#settings.panicHotkey
    const conflicts = panicHotkeyConflicts(accelerator, config.keyIds)
    if (conflicts.length > 0) {
      // Names the key on the user's own keyboard and the one action that fixes
      // it. The old wording pointed at Settings, which has no hotkey editor.
      return this.#refuse(
        'panic-hotkey-conflict',
        describePanicHotkeyConflict(accelerator, conflicts),
        'idle',
      )
    }

    // Registered before anything is forked or written, so a hotkey conflict
    // costs nothing to recover from.
    const registration = this.#panic.register(accelerator, () => {
      this.#release('panic-hotkey')
    })
    if (!registration.ok) {
      return this.#refuse('panic-hotkey-unavailable', registration.message, 'idle')
    }

    const startedAt = this.#clock.now()

    // The journal goes down BEFORE the injector exists, which makes it strictly
    // before the first key-down with no window in between. The cost of
    // journalling a session that never presses anything is one harmless
    // replayed key-up on the next launch.
    this.#options.journal?.write({
      pid: this.#processPid(),
      injectorPid: null,
      startedAt,
      keyIds: [...config.keyIds],
      buttonIds: [...config.buttonIds],
    })

    let injector: InjectorHandle
    try {
      injector = this.#fork()
    } catch (error) {
      this.#options.onError?.('failed to fork the injector', error)
      this.#panic.unregister()
      this.#options.journal?.clear()
      return this.#refuse(
        'fork-failed',
        'KeyPress Ultimate could not start its input process. Restart the app and try again.',
        'error',
      )
    }

    this.#injector = injector
    this.#config = config
    this.#armed = true
    this.#pending = null
    this.#pendingSoftReason = null
    this.#lastHeld = { keyIds: [], buttonIds: [] }
    this.#startedAt = startedAt
    this.#lastPongAt = startedAt
    this.#pingCounter = 0

    injector.onMessage((message) => {
      this.#handleInjectorMessage(message)
    })
    injector.onExit((code) => {
      this.#handleInjectorExit(code)
    })

    this.#startPowerSaveBlocker()
    this.#post({ t: 'settings', settings: this.#settings })
    this.#post({ t: 'arm', config })

    this.#startHeartbeat()
    this.#startPermissionPoll()
    this.#startMaxSessionTimer()

    this.#phase = 'armed-waiting'
    this.#onTarget = false
    this.#firingKeyIds = []
    this.#firingButtonIds = []
    this.#message = this.#waitingMessage(config)
    this.#emitState()
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Failsafe fan-in. Every entry point below ends in `#release`.
  // -------------------------------------------------------------------------

  /** Stop pressed, and the generic entry point for anything else. */
  disarm(reason: DisarmReason): void {
    this.#release(reason)
  }

  /** The target application exited. Stays armed: it may come back. */
  handleTargetQuit(): void {
    this.#release('target-quit')
  }

  /** `app.on('before-quit')` / `will-quit`. */
  handleAppQuit(): void {
    this.#release('app-quit', { sync: true })
  }

  /** `app.on('window-all-closed')`. */
  handleWindowClosed(): void {
    this.#release('window-closed', { sync: true })
  }

  /** Same path the panic hotkey takes, for a UI panic button. */
  panic(): void {
    this.#release('panic-hotkey')
  }

  /**
   * Signals and uncaught exceptions. Returns a detach function.
   *
   * The handlers run synchronously, because `process.on('exit')` gives no
   * chance to await anything, and they never rethrow: deciding what to do after
   * an uncaught exception belongs to the app entry point, not here.
   */
  attachProcessFailsafes(): () => void {
    const target = this.#options.processTarget ?? defaultProcessTarget()
    this.#processTarget = target

    const bind = (event: string, listener: ProcessSignalListener): void => {
      target.on(event, listener)
      this.#processBindings.push({ event, listener })
    }

    bind('uncaughtException', (...args: unknown[]) => {
      this.#options.onError?.('uncaught exception in the main process', args[0])
      this.#release('uncaught-exception', { sync: true, terminalPhase: 'error' })
    })
    bind('unhandledRejection', (...args: unknown[]) => {
      this.#options.onError?.('unhandled rejection in the main process', args[0])
      this.#release('uncaught-exception', { sync: true, terminalPhase: 'error' })
    })
    for (const signal of SIGNAL_EVENTS) {
      bind(signal, () => {
        this.#release('signal', { sync: true })
      })
    }
    bind('exit', () => {
      this.#release('app-quit', { sync: true })
    })

    return () => {
      for (const binding of this.#processBindings) {
        target.removeListener(binding.event, binding.listener)
      }
      this.#processBindings.length = 0
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#release('app-quit', { sync: true })
    this.#unbindPowerMonitor()
    const target = this.#processTarget
    if (target !== null) {
      for (const binding of this.#processBindings) {
        target.removeListener(binding.event, binding.listener)
      }
    }
    this.#processBindings.length = 0
    this.#stateListeners.clear()
    this.#releaseListeners.clear()
    this.#disposed = true
  }

  // -------------------------------------------------------------------------
  // The one release path
  // -------------------------------------------------------------------------

  /**
   * Idempotent. Re-entrant. Safe from a signal handler. Safe when nothing is
   * armed. There is no other way to end a session.
   */
  #release(
    reason: DisarmReason,
    options: {
      sync?: boolean
      terminalPhase?: SessionPhase
      message?: string
      /** Forces a full teardown even for a normally soft reason. */
      hard?: boolean
    } = {},
  ): void {
    if (!this.#armed) return

    if (SOFT_RELEASE_REASONS.has(reason) && options.hard !== true) {
      this.#softRelease(reason)
      return
    }

    // Flip this first: everything below can re-enter through a synchronous
    // fake injector, an exit handler, or a second signal.
    this.#armed = false

    const held = this.#currentlyHeld()
    const holdingNow = held.keyIds.length > 0 || held.buttonIds.length > 0
    const keyIds = holdingNow ? held.keyIds : [...this.#lastHeld.keyIds]
    const buttonIds = holdingNow ? held.buttonIds : [...this.#lastHeld.buttonIds]
    const terminalPhase = options.terminalPhase ?? terminalPhaseFor(reason)
    const message = options.message ?? this.#releaseMessage(reason)

    this.#clearTimer('heartbeat')
    this.#clearTimer('permission-poll')
    this.#clearTimer('max-session')
    this.#clearTimer('soft-release-watchdog')
    this.#pendingSoftReason = null
    this.#panic.unregister()

    this.#pending = { reason, terminalPhase, message, keyIds, buttonIds }

    // Ask the injector to release before doing anything that could kill it.
    this.#post({ t: 'disarm', reason })
    if (this.#pending === null) return // the injector confirmed synchronously

    // There is deliberately no fast path here for "this session never pressed
    // anything". Everything main knows about the injector's key state lags the
    // injector by one IPC hop: the injector presses and *then* emits its state,
    // so a session that reads as idle can already be holding a key. Skipping
    // the wait and killing the injector in the same tick as the disarm was the
    // one way this app could leave a key down system-wide and delete the
    // journal that would have recovered it. Proof now comes from exactly two
    // places: the injector confirming, or the main-side fallback releasing.
    if (options.sync === true) {
      // No chance to wait. The injector's own exit handler and its 300ms
      // heartbeat timeout are the backstops, and an unconfirmed release leaves
      // the journal on disk on purpose.
      this.#finishTeardown(false, { keepInjectorAlive: true })
      return
    }

    this.#setTimeout(
      'release-grace',
      this.#options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS,
      () => {
        this.#finishTeardown(false)
      },
    )
  }

  /**
   * Focus loss and target quit. The injector releases on its own tick, so this
   * verifies rather than commands, and escalates to a hard stop if the keys are
   * still down after the grace window.
   */
  #softRelease(reason: DisarmReason): void {
    const held = this.#currentlyHeld()
    const alreadyClear = held.keyIds.length === 0 && held.buttonIds.length === 0

    this.#phase = 'armed-waiting'
    this.#message = this.#waitingMessage(this.#config)

    if (alreadyClear) {
      this.#clearTimer('soft-release-watchdog')
      this.#pendingSoftReason = null
      this.#emitState()
      this.#emitRelease({
        reason,
        at: this.#clock.now(),
        keyIds: [...this.#lastHeld.keyIds],
        buttonIds: [...this.#lastHeld.buttonIds],
        confirmed: true,
        hardStop: false,
      })
      // `#lastHeld` deliberately survives a soft release. The session is still
      // armed, so that set is still the set a later unconfirmable teardown has
      // to replay ups for. It is reset by `arm` and by a finished teardown.
      return
    }

    // The injector has not confirmed yet. Remember why we are waiting, so the
    // release event names the real cause even if the confirmation arrives
    // after a second, different-looking state message.
    this.#pendingSoftReason = reason
    this.#emitState()
    this.#setTimeout(
      'soft-release-watchdog',
      this.#options.focusReleaseGraceMs ?? DEFAULT_FOCUS_RELEASE_GRACE_MS,
      () => {
        const still = this.#currentlyHeld()
        if (still.keyIds.length === 0 && still.buttonIds.length === 0) return
        // The injector saw the focus change and did not release. That is the
        // failure this whole app exists to prevent, so stop everything.
        this.#release(reason, {
          hard: true,
          terminalPhase: 'error',
          message:
            'The input process did not release the keys when focus moved away, so the session was stopped.',
        })
      },
    )
  }

  #finishTeardown(confirmed: boolean, options: { keepInjectorAlive?: boolean } = {}): void {
    const pending = this.#pending
    if (pending === null) return
    this.#pending = null
    this.#clearTimer('release-grace')

    let released = confirmed
    if (!released) {
      const fallback = this.#options.releaseFallback
      if (fallback !== undefined && fallback !== null) {
        // Release everything this session could conceivably have down, not just
        // what the last state message said. The injector's key-down happens one
        // IPC hop before main hears about it, so the configured set is the only
        // honest upper bound, and posting an up for a key that was never down
        // is harmless: it is exactly what the journal replays at next launch.
        const safety = this.#unconfirmedReleaseSet(pending)
        try {
          fallback(safety.keyIds, safety.buttonIds)
          released = true
        } catch (error) {
          this.#options.onError?.('main-side release fallback failed', error)
        }
      }
    }

    const injector = this.#injector
    this.#injector = null
    if (injector !== null && options.keepInjectorAlive !== true) {
      try {
        injector.kill()
      } catch (error) {
        this.#options.onError?.('failed to kill the injector', error)
      }
    }

    this.#stopPowerSaveBlocker()

    // The journal is only cleared against proof. Without proof it stays, and
    // the next launch replays the ups.
    if (released) {
      this.#options.journal?.clear()
    }

    this.#phase = pending.terminalPhase
    this.#startedAt = null
    this.#firingKeyIds = []
    this.#firingButtonIds = []
    this.#onTarget = false
    this.#focusedApp = null
    this.#config = null
    this.#message = released
      ? pending.message
      : appendUnconfirmedWarning(pending.message ?? unconfirmedFallbackMessage())
    this.#emitState()

    this.#emitRelease({
      reason: pending.reason,
      at: this.#clock.now(),
      keyIds: pending.keyIds,
      buttonIds: pending.buttonIds,
      confirmed: released,
      hardStop: true,
    })
    this.#lastHeld = { keyIds: [], buttonIds: [] }
  }

  /**
   * What to hand the main-side fallback when nothing confirmed the ups: the set
   * main believes was held, plus everything the session was configured to hold.
   */
  #unconfirmedReleaseSet(pending: PendingRelease): { keyIds: string[]; buttonIds: string[] } {
    const config = this.#config
    return {
      keyIds: union(pending.keyIds, config?.keyIds ?? []),
      buttonIds: union(pending.buttonIds, config?.buttonIds ?? []),
    }
  }

  // -------------------------------------------------------------------------
  // Injector conversation
  // -------------------------------------------------------------------------

  #handleInjectorMessage(message: InjectorToMainMessage): void {
    switch (message.t) {
      case 'pong':
        this.#lastPongAt = this.#clock.now()
        return
      case 'released':
        if (this.#pending !== null) this.#finishTeardown(true)
        return
      case 'error':
        this.#handleInjectorError(message.code, message.message)
        return
      case 'blocked':
        // Windows UIPI. The injector's report about the outside world, not a
        // value main produced, so the payload is coerced rather than trusted.
        this.#handleElevatedTarget(message)
        return
      case 'state':
        this.#handleInjectorState(message)
        return
    }
  }

  #handleInjectorState(message: Extract<InjectorToMainMessage, { t: 'state' }>): void {
    if (!this.#armed && this.#pending === null) return

    const wasOnTarget = this.#onTarget
    this.#firingKeyIds = [...message.firingKeyIds]
    this.#firingButtonIds = [...message.firingButtonIds]
    this.#onTarget = message.onTarget
    this.#focusedApp = this.#options.resolveApp?.(message.focusedPid) ?? null

    if (this.#firingKeyIds.length > 0 || this.#firingButtonIds.length > 0) {
      this.#lastHeld = {
        keyIds: [...this.#firingKeyIds],
        buttonIds: [...this.#firingButtonIds],
      }
    }

    if (this.#pending !== null) {
      // Mid-teardown. An empty firing set is the injector confirming the ups.
      if (this.#firingKeyIds.length === 0 && this.#firingButtonIds.length === 0) {
        this.#finishTeardown(true)
      }
      return
    }

    const firing = this.#firingKeyIds.length > 0 || this.#firingButtonIds.length > 0

    if (this.#pendingSoftReason !== null) {
      if (!firing) {
        // The injector let go. Report the release under the reason that
        // started it, not whatever the latest message happens to look like.
        this.#softRelease(this.#pendingSoftReason)
        return
      }
      if (message.onTarget) {
        // False alarm: the target is back and still being held.
        this.#pendingSoftReason = null
        this.#clearTimer('soft-release-watchdog')
      } else {
        this.#emitState()
        return
      }
    }

    if (wasOnTarget && !message.onTarget) {
      // Focus left the target. `#softRelease` emits the state.
      this.#release('focus-lost')
      return
    }

    this.#phase = firing ? 'firing' : 'armed-waiting'
    if (!firing) this.#message = this.#waitingMessage(this.#config)
    else this.#message = null
    this.#emitState()
  }

  /**
   * The target is running elevated and Windows will not let our input reach it.
   * Nothing the app can do at runtime fixes that, so the session ends in
   * `blocked` carrying a message that names the app, exactly like a missing
   * Accessibility permission on macOS.
   */
  #handleElevatedTarget(message: ElevatedTargetBlocked): void {
    this.#release('injector-error', {
      terminalPhase: 'blocked',
      message: elevatedTargetMessage(message.appName, message.message),
    })
  }

  #handleInjectorError(code: InjectorErrorCode, detail: string): void {
    const blocked = code === 'injection-blocked' || code === 'permission-denied'
    this.#release('injector-error', {
      terminalPhase: blocked ? 'blocked' : 'error',
      message: injectorErrorMessage(code, detail),
    })
  }

  #handleInjectorExit(code: number | null): void {
    if (this.#pending !== null) {
      // Expected: it exited after being told to disarm. Whether the ups landed
      // is decided by whether we already saw `released`, so do not claim it.
      this.#finishTeardown(false)
      return
    }
    if (!this.#armed) return
    this.#injector = null
    // No point waiting for a confirmation from a process that is gone. This
    // finishes as unconfirmed unless a main-side fallback release succeeds,
    // which is what leaves the journal on disk for the next launch.
    this.#release('injector-error', {
      sync: true,
      terminalPhase: 'error',
      message: `The input process stopped unexpectedly (exit code ${String(code ?? 'unknown')}). Everything it was holding was released.`,
    })
  }

  #post(message: MainToInjectorMessage): void {
    const injector = this.#injector
    if (injector === null) return
    try {
      injector.postMessage(message)
    } catch (error) {
      // A dead pipe on the way out is expected, not worth surfacing.
      if (message.t !== 'disarm') {
        this.#options.onError?.(`failed to post ${message.t} to the injector`, error)
      }
    }
  }

  #fork(): InjectorHandle {
    const mainPid = this.#processPid()
    const injected = this.#options.forkInjector
    if (injected !== undefined) {
      // An injected fork supplies its own process, so the packaged injector
      // path is never resolved. Resolving it here would fail under vitest.
      return injected({ modulePath: this.#options.injectorPath ?? '', mainPid })
    }
    return defaultForkInjector({
      modulePath: this.#options.injectorPath ?? defaultInjectorPath(),
      mainPid,
    })
  }

  // -------------------------------------------------------------------------
  // Watchdogs
  // -------------------------------------------------------------------------

  #startHeartbeat(): void {
    this.#setInterval('heartbeat', HEARTBEAT_INTERVAL_MS, () => {
      const now = this.#clock.now()
      if (now - this.#lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.#release('heartbeat-timeout')
        return
      }
      this.#pingCounter += 1
      this.#post({ t: 'ping', n: this.#pingCounter })
    })
  }

  #startPermissionPoll(): void {
    const permissions = this.#options.permissions
    if (permissions === undefined) return
    this.#setInterval('permission-poll', PERMISSION_POLL_MS, () => {
      let granted: boolean
      try {
        granted = permissions.hasPermission()
      } catch (error) {
        this.#options.onError?.('permission probe threw', error)
        return
      }
      if (!granted) this.#release('permission-revoked')
    })
  }

  /**
   * Schedules the cap against the session's own start, so it can be restarted
   * mid-session after a settings change and still mean "N minutes of holding",
   * not "N more minutes". Safe to call repeatedly: it replaces the timer.
   */
  #startMaxSessionTimer(): void {
    this.#clearTimer('max-session')
    const minutes = this.#settings.maxSessionMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) return // 0 is unlimited, by design.
    const total = Math.min(MAX_TIMER_MS, Math.max(MIN_SESSION_MS, minutes * 60_000))
    const now = this.#clock.now()
    const elapsed = this.#startedAt === null ? 0 : Math.max(0, now - this.#startedAt)
    // A cap that is already past fires on the next turn of the loop rather than
    // synchronously: `setSettings` runs inside an IPC handler, and releasing
    // re-entrantly from there is how a teardown ends up half-done.
    this.#setTimeout('max-session', Math.max(0, total - elapsed), () => {
      this.#release('max-session-time')
    })
  }

  #startPowerSaveBlocker(): void {
    const blocker = this.#options.powerSaveBlocker
    if (blocker === undefined || blocker === null) return
    try {
      this.#powerSaveBlockerId = blocker.start('prevent-app-suspension')
    } catch (error) {
      this.#options.onError?.('failed to start the power save blocker', error)
      this.#powerSaveBlockerId = null
    }
  }

  #stopPowerSaveBlocker(): void {
    const blocker = this.#options.powerSaveBlocker
    const id = this.#powerSaveBlockerId
    this.#powerSaveBlockerId = null
    if (blocker === undefined || blocker === null || id === null) return
    try {
      blocker.stop(id)
    } catch (error) {
      this.#options.onError?.('failed to stop the power save blocker', error)
    }
  }

  #bindPowerMonitor(): void {
    const monitor = this.#powerMonitor
    if (monitor === null) return
    for (const { event, reason } of POWER_EVENTS) {
      const listener = (): void => {
        this.#release(reason, { sync: true })
      }
      try {
        monitor.on(event, listener)
        this.#powerBindings.push({ event, listener })
      } catch (error) {
        // Not every event exists on every platform.
        this.#options.onError?.(`could not subscribe to powerMonitor ${event}`, error)
      }
    }
  }

  #unbindPowerMonitor(): void {
    const monitor = this.#powerMonitor
    if (monitor === null) return
    for (const binding of this.#powerBindings) {
      try {
        monitor.removeListener(binding.event, binding.listener)
      } catch {
        // Tearing down anyway.
      }
    }
    this.#powerBindings.length = 0
  }

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  #currentlyHeld(): { keyIds: string[]; buttonIds: string[] } {
    if (this.#firingKeyIds.length > 0 || this.#firingButtonIds.length > 0) {
      return { keyIds: [...this.#firingKeyIds], buttonIds: [...this.#firingButtonIds] }
    }
    return { keyIds: [], buttonIds: [] }
  }

  #refuse(code: ArmRefusalCode, message: string, phase: SessionPhase): ArmResult {
    this.#phase = phase
    this.#startedAt = null
    this.#firingKeyIds = []
    this.#firingButtonIds = []
    this.#onTarget = false
    this.#message = message
    this.#emitState()
    return { ok: false, code, message }
  }

  #waitingMessage(config: SessionConfig | null): string {
    const identity = config?.targets[0]
    const name =
      identity === undefined ? null : (this.#options.resolveTargetName?.(identity) ?? null)
    return name === null ? 'Armed, waiting for the target app.' : `Armed, waiting for ${name}.`
  }

  #releaseMessage(reason: DisarmReason): string | null {
    switch (reason) {
      case 'user-stop':
      case 'app-quit':
      case 'window-closed':
      case 'signal':
        return null
      case 'uncaught-exception':
        return 'KeyPress Ultimate hit an internal error, so everything was released.'
      case 'power-suspend':
        return 'The computer went to sleep, so everything was released.'
      case 'screen-locked':
        return 'The screen locked, so everything was released.'
      case 'permission-revoked':
        return 'Accessibility permission was turned off, so everything was released. Grant it again in System Settings, then press Start.'
      case 'heartbeat-timeout':
        return 'The input process stopped responding, so everything was released.'
      case 'panic-hotkey':
        return `Panic hotkey ${this.#settings.panicHotkey} pressed. Everything was released.`
      case 'max-session-time':
        return `The ${String(this.#settings.maxSessionMinutes)} minute session limit was reached, so everything was released.`
      case 'focus-lost':
      case 'target-quit':
      case 'injector-error':
        return null
    }
  }

  #processPid(): number {
    return this.#options.processTarget?.pid ?? process.pid
  }

  #emitState(): void {
    const state = this.getState()
    const signature = JSON.stringify(state)
    if (signature === this.#lastEmittedSignature) return
    this.#lastEmittedSignature = signature
    for (const listener of this.#stateListeners) {
      try {
        listener(state)
      } catch (error) {
        // A listener must never be able to break a release path.
        this.#options.onError?.('a session state listener threw', error)
      }
    }
  }

  #emitRelease(event: ReleaseEvent): void {
    for (const listener of this.#releaseListeners) {
      try {
        listener(event)
      } catch (error) {
        this.#options.onError?.('a release listener threw', error)
      }
    }
  }

  #setTimeout(name: TimerName, ms: number, fn: () => void): void {
    this.#clearTimer(name)
    this.#timers.set(name, { handle: this.#clock.setTimeout(fn, ms), kind: 'timeout' })
  }

  #setInterval(name: TimerName, ms: number, fn: () => void): void {
    this.#clearTimer(name)
    this.#timers.set(name, { handle: this.#clock.setInterval(fn, ms), kind: 'interval' })
  }

  #clearTimer(name: TimerName): void {
    const timer = this.#timers.get(name)
    if (timer === undefined) return
    this.#timers.delete(name)
    if (timer.kind === 'timeout') this.#clock.clearTimeout(timer.handle)
    else this.#clock.clearInterval(timer.handle)
  }
}

// ---------------------------------------------------------------------------
// Copy and mapping
// ---------------------------------------------------------------------------

/**
 * Where a session lands after a hard stop. `blocked` is reserved for the two
 * cases the user has to leave the app to fix: a missing permission and Windows
 * refusing the injection because the target is elevated.
 */
export function terminalPhaseFor(reason: DisarmReason): SessionPhase {
  switch (reason) {
    case 'permission-revoked':
      return 'blocked'
    case 'uncaught-exception':
    case 'heartbeat-timeout':
    case 'injector-error':
      return 'error'
    default:
      return 'idle'
  }
}

export function injectorErrorMessage(code: InjectorErrorCode, detail: string): string {
  switch (code) {
    case 'injection-blocked':
      return 'Windows is blocking input into this app because it is running as administrator. Restart KeyPress Ultimate as administrator, then press Start again.'
    case 'permission-denied':
      return 'KeyPress Ultimate lost Accessibility permission, so everything was released. Grant it again in System Settings, then press Start.'
    case 'struct-layout-mismatch':
      return 'KeyPress Ultimate refused to send input because the system input structures are not the layout it expects. This build cannot run safely on this machine.'
    case 'ffi-init-failed':
      return 'KeyPress Ultimate could not load its native input layer, so no keys were pressed.'
    case 'unsupported-platform':
      return 'KeyPress Ultimate does not support sending input on this platform.'
    case 'unknown':
      return detail.length > 0 ? detail : 'The input process reported an error, so everything was released.'
  }
}

/**
 * What the user reads when Windows refuses the injection because the target is
 * elevated. It names the app, because "restart as administrator" is only
 * actionable once you know which window is the problem.
 */
export function elevatedTargetMessage(appName: unknown, detail: unknown): string {
  const name = typeof appName === 'string' ? appName.trim() : ''
  if (name.length > 0) {
    return `Windows is blocking input into ${name} because it is running as administrator. Restart KeyPress Ultimate as administrator, then press Start again.`
  }
  const fallback = typeof detail === 'string' ? detail.trim() : ''
  if (fallback.length > 0) return fallback
  return 'Windows is blocking input into the target app because it is running as administrator. Restart KeyPress Ultimate as administrator, then press Start again.'
}

/** Order-preserving union, used to widen an unconfirmed release set. */
function union(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a]
  for (const id of b) if (!out.includes(id)) out.push(id)
  return out
}

function appendUnconfirmedWarning(message: string): string {
  return `${message} Some keys may still be held. They will be released the next time KeyPress Ultimate starts, or when you tap them.`
}

function unconfirmedFallbackMessage(): string {
  return 'The session was stopped.'
}

// ---------------------------------------------------------------------------
// Real implementations, loaded only when nothing was injected
// ---------------------------------------------------------------------------

function requireElectron(): Record<string, unknown> {
  const req = (globalThis as { require?: (id: string) => unknown }).require
  if (typeof req !== 'function') {
    throw new Error('SessionController needs injected dependencies outside the Electron main process')
  }
  return req('electron') as Record<string, unknown>
}

/**
 * Both `index.ts` and `entry.ts` are inputs to electron-vite's `main` build, so
 * the built injector sits next to the built main bundle as `injector.js`.
 */
export function defaultInjectorPath(): string {
  const dir = (globalThis as { __dirname?: string }).__dirname
  if (typeof dir !== 'string') {
    throw new Error('cannot resolve the injector path outside the packaged main process')
  }
  return join(dir, 'injector.js')
}

interface UtilityProcessLike {
  pid: number | undefined
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  kill(): boolean
}

export const defaultForkInjector: ForkInjector = (options) => {
  const electron = requireElectron()
  const utilityProcess = electron['utilityProcess'] as {
    fork(
      modulePath: string,
      args?: string[],
      forkOptions?: { serviceName?: string; stdio?: 'inherit' | 'pipe' | 'ignore' },
    ): UtilityProcessLike
  }

  const child = utilityProcess.fork(options.modulePath, [`--main-pid=${String(options.mainPid)}`], {
    serviceName: 'keypress-injector',
    stdio: 'inherit',
  })

  return {
    get pid(): number | null {
      return child.pid ?? null
    },
    postMessage: (message) => {
      child.postMessage(message)
    },
    onMessage: (listener) => {
      child.on('message', (message: unknown) => {
        listener(message as InjectorToMainMessage)
      })
    },
    onExit: (listener) => {
      child.on('exit', (code: number) => {
        listener(code)
      })
    },
    kill: () => {
      child.kill()
    },
  }
}

function defaultProcessTarget(): ProcessFailsafeTarget {
  return {
    pid: process.pid,
    on: (event, listener) => {
      process.on(event as NodeJS.Signals, listener as () => void)
    },
    removeListener: (event, listener) => {
      process.removeListener(event as NodeJS.Signals, listener as () => void)
    },
  }
}
