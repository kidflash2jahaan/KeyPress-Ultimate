/**
 * The hold loop. This is the only code in the app that decides *when* a key is
 * down, and every one of its rules exists because the obvious alternative is
 * actively harmful:
 *
 * - **`hold` never re-asserts.** A held key is global OS state; one down holds
 *   it forever on both platforms. Re-sending the down "to be safe" produces
 *   seven distinct key events for seven re-asserts, which is seven characters
 *   in a text field. Re-assertion is a mode the user opts into, never a
 *   background compatibility hack.
 * - **Focus is re-read from the OS immediately before every assert.** Never a
 *   value cached from the top of the tick, never a value from a notification
 *   stream. The frontmost pid is the single fact that authorises pressing.
 * - **Focus gain is gated, focus loss is not.** Gaining focus waits 150ms to
 *   settle and then waits for the user's physical modifiers to clear, because
 *   the user is usually still holding Cmd or Alt at the instant their Cmd+Tab
 *   lands and a held `W` would arrive as Cmd+W. Losing focus releases on the
 *   spot, with no delay and no gate.
 * - **Release is reverse press order, modifiers last.** Releasing Shift before
 *   Shift+W leaves a bare W up that some apps map differently. Reverse order
 *   is what a human hand does.
 *
 * The loop owns no timers of its own: it is driven by `createScheduler`, whose
 * clock is injectable, so every rule above is testable with a fake clock and a
 * recording `NativeInput` and zero real input is ever synthesized in a test.
 */
import type { DisarmReason, InjectorErrorCode } from '@shared/ipc'
import { FOCUS_SETTLE_MS, FOCUS_TICK_MS, MODIFIER_CLEAR_TIMEOUT_MS } from '@shared/ipc'
import { getKeyById, getMouseButtonById, isKeyAvailableOn } from '@shared/keys'
import type { KeyDef, MouseDef, Platform, SessionConfig, Settings } from '@shared/types'
import type { NativeInput, NativeInputExtras } from './native/types'
// Type-only, so importing the loop never pulls the Windows adapter (and koffi)
// into a macOS process. `import type` is erased entirely at compile time.
import type { ForegroundBlockingReport } from './native/windows'
import type { Clock, Scheduler } from './scheduler'
import { createScheduler, realClock } from './scheduler'

// ---------------------------------------------------------------------------
// Native surface
// ---------------------------------------------------------------------------

/**
 * Capabilities an adapter may provide beyond the locked `NativeInput`
 * contract. `NativeInputExtras` is owned by `./native/types.ts` and imported
 * verbatim; the two Windows timer-resolution calls and `applySettings` are
 * declared here because they exist on the Windows adapter only.
 *
 * Everything is optional and feature-detected at the call site, so the loop is
 * correct against a bare `NativeInput` and better against a full adapter.
 * Nothing here widens `NativeInput` itself.
 */
export interface NativeInputOptionalExtras {
  /**
   * Windows `timeBeginPeriod(1)`. A utilityProcess does not inherit Chromium's
   * raised timer resolution, so without this a 20ms interval lands somewhere
   * between 15.6ms and 31.2ms.
   */
  beginHighResolutionTimers?(period?: number): unknown
  /** Windows `timeEndPeriod(1)`. Must be balanced against every begin. */
  endHighResolutionTimers?(period?: number): unknown
  /** Adapter-visible settings, e.g. the Windows virtual-key fallback. */
  applySettings?(settings: Settings): void
  /**
   * Windows only. "Will anything we post actually reach whatever is in front
   * right now?" `SendInput` cannot answer that: under UIPI it reports the full
   * count inserted and leaves GetLastError at zero while nothing lands, so
   * without this call the app would confidently claim to be holding W into a
   * void. Absent on macOS, where there is no equivalent block.
   */
  describeForegroundBlocking?(): ForegroundBlockingReport
}

/** What the injector actually holds: the locked contract plus optional extras. */
export type InjectorNative = NativeInput & Partial<NativeInputExtras> & NativeInputOptionalExtras

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Defaults matching a typical OS typematic setting: initial delay, then ~30/s. */
export const REPEAT_INITIAL_DEFAULT_MS = 400
export const REPEAT_INTERVAL_DEFAULT_MS = 33
export const REPEAT_INITIAL_MIN_MS = 0
export const REPEAT_INITIAL_MAX_MS = 5_000
/** Below 10ms is beyond any OS repeat rate and reads as an input flood. */
export const REPEAT_INTERVAL_MIN_MS = 10
export const REPEAT_INTERVAL_MAX_MS = 500

export const TAP_INTERVAL_DEFAULT_MS = 100
export const TAP_INTERVAL_MIN_MS = 10
export const TAP_INTERVAL_MAX_MS = 1_000

/** The loop may tick faster than 25ms for a short interval, never slower, and never below this. */
export const MIN_TICK_MS = 5

/** Longest a pid -> identity snapshot is trusted before a rebuild. */
export const TARGET_SNAPSHOT_MAX_AGE_MS = 1_000
/** Floor on rebuild frequency, so an unknown foreground app cannot cause a rebuild every tick. */
export const TARGET_SNAPSHOT_MIN_REFRESH_MS = 250
/**
 * How often the identity behind the pid we are pressing into is re-confirmed.
 *
 * A pid is not an identity. Windows hands pids back out of a free list within
 * seconds, so "same number as last tick" is not proof the process behind it is
 * the one we authorised; without this the loop would keep asserting into
 * whatever inherited the number until the snapshot aged out.
 */
export const TARGET_IDENTITY_RECHECK_MS = 250

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type HoldLoopPhase =
  /** Not armed. */
  | 'idle'
  /** Armed, nothing held, waiting for a target to come forward. */
  | 'armed-waiting'
  /** Target is frontmost; letting the switch finish before touching anything. */
  | 'settling'
  /** Waiting for the user's physical modifiers to clear before the first press. */
  | 'modifier-gate'
  /** Keys are down (or being tapped). */
  | 'firing'

/**
 * Internal release reasons alongside the protocol's `DisarmReason`. The extra
 * ones never leave the injector; they exist so logs say what actually happened.
 */
export type ReleaseReason =
  | DisarmReason
  | 'focus-changed'
  | 'self-target'
  | 'tap-cycle'
  | 'assert-aborted'
  | 'native-error'

/**
 * The loop's half of the `blocked` protocol message: a target that is
 * frontmost and being pressed into while the OS is silently discarding
 * everything we post.
 */
export interface BlockedTargetEvent {
  code: 'elevated-target'
  message: string
  appName: string
}

export interface HoldLoopState {
  phase: HoldLoopPhase
  onTarget: boolean
  focusedPid: number | null
  firingKeyIds: string[]
  firingButtonIds: string[]
}

export interface HoldLoopOptions {
  native: InjectorNative
  /** Our own process ids. If one of these is frontmost we release and wait. */
  ourPids?: readonly number[]
  platform?: Platform
  clock?: Clock
  /** Forwarded to the scheduler. Pass 0 when driving with a fake clock. */
  spinMs?: number
  /** Fired only when the reported state actually changes, never on every tick. */
  onState?: (state: HoldLoopState) => void
  /** Fired once per session-ending release, with the number of items released. */
  onReleased?: (count: number, reason: ReleaseReason) => void
  /**
   * Fired when the loop ends its OWN session, i.e. for a reason main did not
   * ask for. Main owns the session lifecycle, so a self-disarm it cannot see
   * would leave it armed forever with a loop that has stopped ticking. A
   * disarm main requested does not fire this: main already knows.
   */
  onSelfDisarm?: (reason: DisarmReason) => void
  /** Fired once per transition into a blocked target, never on every tick. */
  onBlocked?: (event: BlockedTargetEvent) => void
  onError?: (code: InjectorErrorCode, message: string) => void
  onLog?: (message: string) => void
}

export interface HoldLoop {
  arm(config: SessionConfig): void
  disarm(reason: DisarmReason): void
  applySettings(settings: Settings): void
  /**
   * Release everything, unconditionally. Idempotent, synchronous, and safe to
   * call from a `process.on('exit')` handler or twice from racing failsafes.
   */
  releaseAll(reason?: ReleaseReason): number
  readonly armed: boolean
  readonly state: HoldLoopState
  /** Stops the scheduler and balances any raised timer resolution. */
  dispose(): void
}

// ---------------------------------------------------------------------------

interface HeldKeyItem {
  kind: 'key'
  def: KeyDef
}
interface HeldButtonItem {
  kind: 'button'
  def: MouseDef
}
type HeldItem = HeldKeyItem | HeldButtonItem

interface ResolvedConfig {
  /** Modifiers first, then ordinary keys: press order. */
  keys: KeyDef[]
  buttons: MouseDef[]
  targets: ReadonlySet<string>
  repeatInitialMs: number
  repeatIntervalMs: number
  tapIntervalMs: number
  tickMs: number
}

/** A missing, non-finite or non-positive interval means "unset": take the default. */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * The initial repeat delay is the one tunable where zero is a real choice
 * ("start repeating straight away"), so only a negative or non-finite value
 * falls back to the default.
 */
function clampInitialDelay(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(REPEAT_INITIAL_MAX_MS, Math.max(REPEAT_INITIAL_MIN_MS, value))
}

function isModifierItem(item: HeldItem): boolean {
  return item.kind === 'key' && item.def.isModifier
}

/**
 * Tick period for a mode. 25ms is the ceiling, always: it bounds the
 * "keys still held after focus left" window at under two frames. A shorter
 * repeat or tap interval pulls the tick *down* to match, never up, so the
 * focus check always happens at least as often as an assert.
 */
export function computeTickPeriodMs(
  mode: SessionConfig['mode'],
  repeatIntervalMs: number,
  tapIntervalMs: number,
): number {
  if (mode === 'hold-repeat') {
    return Math.max(MIN_TICK_MS, Math.min(FOCUS_TICK_MS, repeatIntervalMs))
  }
  if (mode === 'tap') {
    // Four samples per tap cycle, so the down and up edges land accurately.
    return Math.max(MIN_TICK_MS, Math.min(FOCUS_TICK_MS, tapIntervalMs / 4))
  }
  return FOCUS_TICK_MS
}

// ---------------------------------------------------------------------------

export function createHoldLoop(options: HoldLoopOptions): HoldLoop {
  const native = options.native
  const clock = options.clock ?? realClock
  const platform: Platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'darwin')
  const ourPids = new Set<number>(options.ourPids ?? [])

  let armed = false
  let phase: HoldLoopPhase = 'idle'
  let config: ResolvedConfig | null = null
  let scheduler: Scheduler | null = null

  let held: HeldItem[] = []
  /** The pid we are currently pressing into. Null whenever nothing is held. */
  let activePid: number | null = null
  /** The identity `activePid` was authorised as, re-confirmed on a bounded schedule. */
  let activeIdentity: string | null = null
  let identityVerifiedAt = 0
  let lastFocusedPid: number | null = null
  /** The pid a `blocked` report has already gone out for, so it goes out once. */
  let blockedReportedPid: number | null = null

  let focusGainedAt = 0
  let gateStartedAt = 0
  let nextRepeatAt = 0
  let tapStartedAt = 0

  let sessionStartedAt = 0
  let maxSessionMs = 0
  let highResTimersOn = false
  let releasing = false

  /** pid -> identity, rebuilt from `listApplications()` and cached. */
  let pidIdentities = new Map<number, string>()
  let snapshotAt = Number.NEGATIVE_INFINITY

  let lastStateSignature = ''
  let currentMode: SessionConfig['mode'] = 'hold'

  function log(message: string): void {
    options.onLog?.(message)
  }

  function reportError(code: InjectorErrorCode, message: string): void {
    options.onError?.(code, message)
    log(`error ${code}: ${message}`)
  }

  // -------------------------------------------------------------------------
  // Focus
  // -------------------------------------------------------------------------

  /** Always a fresh read. There is deliberately no cached-pid path in this file. */
  function readFrontmostPid(): number | null {
    try {
      const pid = native.getFrontmostPid()
      // The contract says null means unknown, and unknown must be treated as
      // "not on target". A negative pid from a C API means the same thing.
      if (pid === null || !Number.isInteger(pid) || pid < 0) return null
      return pid
    } catch (error) {
      reportError('unknown', `getFrontmostPid failed: ${String(error)}`)
      return null
    }
  }

  /** False when the rebuild failed and the previous snapshot is still in place. */
  function refreshIdentities(now: number): boolean {
    try {
      const apps = native.listApplications()
      const next = new Map<number, string>()
      for (const app of apps) next.set(app.pid, app.identity)
      pidIdentities = next
      snapshotAt = now
      return true
    } catch (error) {
      snapshotAt = now
      reportError('unknown', `listApplications failed: ${String(error)}`)
      return false
    }
  }

  function identityForPid(pid: number, now: number): string | null {
    const age = now - snapshotAt
    const known = pidIdentities.get(pid)
    // The pid we are already pressing into has its own re-verification
    // schedule (`verifyActiveIdentity`), so the cache may answer for it for the
    // snapshot's full lifetime. Any other pid is about to *start* a firing
    // session: authorising that from a snapshot up to a second old is how a
    // recycled pid gets pressed into, so it only gets a cache hit while the
    // snapshot is younger than the rebuild floor.
    const maxAge = pid === activePid ? TARGET_SNAPSHOT_MAX_AGE_MS : TARGET_SNAPSHOT_MIN_REFRESH_MS
    if (known !== undefined && age < maxAge) return known
    if (age < TARGET_SNAPSHOT_MIN_REFRESH_MS) return known ?? null
    refreshIdentities(now)
    return pidIdentities.get(pid) ?? null
  }

  /** The target identity this pid resolves to, or null when it is not a target. */
  function targetIdentityForPid(pid: number, now: number): string | null {
    if (config === null) return null
    if (ourPids.has(pid)) return null
    const identity = identityForPid(pid, now)
    if (identity === null || !config.targets.has(identity)) return null
    return identity
  }

  /**
   * Confirm the pid we are pressing into still belongs to the process we
   * authorised. A pid is a reusable number, not an identity: on Windows it
   * comes back off a free list within seconds, and a numeric-only check would
   * keep asserting into whichever process inherited it.
   *
   * Bounded to one rebuild per `TARGET_IDENTITY_RECHECK_MS`, because this sits
   * on the path of every assert and `listApplications()` enumerates windows.
   */
  function verifyActiveIdentity(): boolean {
    if (activePid === null || activeIdentity === null) return true
    const now = clock.now()
    if (now - identityVerifiedAt < TARGET_IDENTITY_RECHECK_MS) return true
    identityVerifiedAt = now
    // A native failure is not evidence that the target died. Fail open and try
    // again at the next recheck rather than dropping a legitimate hold. A
    // snapshot another path has just rebuilt is fresh enough to answer with.
    if (now - snapshotAt >= TARGET_IDENTITY_RECHECK_MS && !refreshIdentities(now)) return true
    const identity = pidIdentities.get(activePid)
    if (identity === activeIdentity) return true
    log(`pid ${activePid} is no longer ${activeIdentity} (now ${identity ?? 'gone'}), letting go`)
    return false
  }

  /**
   * Re-read the frontmost pid and confirm it is still the pid we are pressing
   * into. Called immediately before every assert, without exception.
   *
   * Identity is checked first so that the frontmost-pid read stays the very
   * last thing that happens before the assert.
   */
  function stillOnTarget(): boolean {
    if (!verifyActiveIdentity()) return false
    const pid = readFrontmostPid()
    return pid !== null && pid === activePid && !ourPids.has(pid)
  }

  // -------------------------------------------------------------------------
  // Press and release
  // -------------------------------------------------------------------------

  function press(): boolean {
    if (config === null) return false
    if (!stillOnTarget()) {
      abort('assert-aborted')
      return false
    }
    try {
      // Modifiers down first, then ordinary keys, then mouse buttons. This is
      // the order a human hand produces and the order shortcut handling in
      // every app expects.
      for (const key of config.keys) {
        native.keyDown(key)
        held.push({ kind: 'key', def: key })
      }
      for (const button of config.buttons) {
        native.mouseDown(button)
        held.push({ kind: 'button', def: button })
      }
      return true
    } catch (error) {
      reportError('unknown', `press failed: ${String(error)}`)
      releaseHeld('native-error', true)
      return false
    }
  }

  function postUp(item: HeldItem, pid: number | null): void {
    try {
      // macOS only, and it must come first: the app that was holding the key
      // may no longer be frontmost, so the global post alone would never reach
      // it. A dead pid makes CGEventPostToPid a silent no-op, which is fine.
      // There is no mouse equivalent in the adapter contract, so a held mouse
      // button gets the global up only.
      if (platform === 'darwin' && pid !== null && item.kind === 'key') {
        native.keyUpToPid?.(item.def, pid)
      }
      if (item.kind === 'key') native.keyUp(item.def)
      else native.mouseUp(item.def)
    } catch (error) {
      reportError('unknown', `release of ${item.def.id} failed: ${String(error)}`)
    }
  }

  function safeReleaseAll(): void {
    try {
      native.releaseAll()
    } catch (error) {
      reportError('unknown', `releaseAll failed: ${String(error)}`)
    }
  }

  /**
   * `full` distinguishes a session-ending release (belt-and-braces
   * `native.releaseAll()`, a `released` event for the UI) from the up half of
   * a tap duty cycle, which is neither.
   */
  function releaseHeld(reason: ReleaseReason, full: boolean): number {
    if (releasing) return 0
    releasing = true
    try {
      // Snapshot and clear before posting anything, so a concurrent failsafe
      // cannot interleave a second release of the same items.
      const snapshot = held
      held = []
      const pid = activePid

      const reversed = [...snapshot].reverse()
      const ordered = [
        ...reversed.filter((item) => !isModifierItem(item)),
        ...reversed.filter(isModifierItem),
      ]
      for (const item of ordered) postUp(item, pid)

      if (full) {
        safeReleaseAll()
        if (ordered.length > 0) {
          log(`released ${ordered.length} (${reason})`)
          options.onReleased?.(ordered.length, reason)
        }
      }
      return ordered.length
    } finally {
      releasing = false
    }
  }

  /** Give up on the current target and go back to waiting, keys released. */
  function abort(reason: ReleaseReason): void {
    releaseHeld(reason, true)
    activePid = null
    activeIdentity = null
    phase = armed ? 'armed-waiting' : 'idle'
  }

  // -------------------------------------------------------------------------
  // Modifier gate
  // -------------------------------------------------------------------------

  /**
   * The adapter answers for the *physical* keyboard: true when the user is not
   * holding any modifier right now. A session that intends to hold Shift still
   * waits for the user's own Shift to come up, and the 2s timeout is what
   * stops that from wedging the session.
   */
  function physicalModifiersClear(): boolean {
    const check = native.physicalModifiersClear
    if (typeof check !== 'function') return true
    try {
      return check.call(native)
    } catch (error) {
      reportError('unknown', `modifier check failed: ${String(error)}`)
      return true
    }
  }

  // -------------------------------------------------------------------------
  // Modes
  // -------------------------------------------------------------------------

  /**
   * Windows UIPI: a normal-integrity process cannot post input into an
   * elevated one, and `SendInput` reports success anyway. So the moment we
   * start pressing into a target, ask the adapter whether anything can land,
   * and say so once. The alternative is what the app did before: hold into a
   * void in complete silence while the UI claims the key is down.
   *
   * Reported on transition only. One report per target, however long the
   * session runs and however often focus flicks away and back.
   */
  function checkForegroundBlocking(): void {
    const describe = native.describeForegroundBlocking
    if (typeof describe !== 'function') return
    if (activePid === null || blockedReportedPid === activePid) return
    let report: ForegroundBlockingReport
    try {
      report = describe.call(native)
    } catch (error) {
      reportError('unknown', `describeForegroundBlocking failed: ${String(error)}`)
      return
    }
    // `ok` is true only when there is positive reason to think injection lands.
    // A report about some other window raced with us and says nothing about the
    // pid we are pressing into, so it is discarded rather than misattributed.
    if (report.ok || report.app === null || report.app.pid !== activePid) return
    blockedReportedPid = activePid
    log(`foreground blocking (${report.severity}): ${report.message}`)
    options.onBlocked?.({
      code: 'elevated-target',
      message: report.message,
      appName: report.app.name,
    })
  }

  function enterFiring(now: number): void {
    if (config === null) return
    phase = 'firing'
    if (currentMode === 'tap') {
      tapStartedAt = now
      runTap(now)
      checkForegroundBlocking()
      return
    }
    if (!press()) return
    nextRepeatAt = now + config.repeatInitialMs
    checkForegroundBlocking()
  }

  function runRepeat(now: number): void {
    if (config === null || held.length === 0) return
    if (now < nextRepeatAt) return
    if (!stillOnTarget()) {
      abort('assert-aborted')
      return
    }
    try {
      // Re-send the DOWN only. Never an intermediate up: an up would be a real
      // release that a game reads as "the player let go".
      for (const item of held) {
        if (item.kind !== 'key' || item.def.isModifier) continue
        if (typeof native.keyDownRepeat === 'function') native.keyDownRepeat(item.def)
        else native.keyDown(item.def)
      }
    } catch (error) {
      reportError('unknown', `repeat assert failed: ${String(error)}`)
      releaseHeld('native-error', true)
      return
    }
    // Absolute deadlines here too, but never fire a catch-up burst.
    const interval = config.repeatIntervalMs
    const missed = Math.floor((now - nextRepeatAt) / interval)
    nextRepeatAt += (missed + 1) * interval
    if (nextRepeatAt <= now) nextRepeatAt = now + interval
  }

  function runTap(now: number): void {
    if (config === null) return
    const interval = config.tapIntervalMs
    const elapsed = now - tapStartedAt
    const cycle = elapsed - Math.floor(elapsed / interval) * interval
    const shouldBeDown = cycle < interval / 2

    if (shouldBeDown && held.length === 0) press()
    else if (!shouldBeDown && held.length > 0) releaseHeld('tap-cycle', false)
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  function tick(): void {
    if (!armed || config === null) return
    const now = clock.now()

    if (maxSessionMs > 0 && now - sessionStartedAt >= maxSessionMs) {
      log('max session time reached')
      selfDisarm('max-session-time')
      return
    }

    const pid = readFrontmostPid()
    lastFocusedPid = pid
    const ours = pid !== null && ourPids.has(pid)
    const identity = pid === null || ours ? null : targetIdentityForPid(pid, now)
    let onTarget = pid !== null && identity !== null
    // A pid is a reusable number, not an identity. Before treating the pid we
    // are already pressing into as still ours, confirm the process behind it
    // has not been replaced. This has to happen here and not only before an
    // assert, because `hold` mode never asserts again after the first press.
    if (onTarget && pid === activePid && !verifyActiveIdentity()) onTarget = false

    if (!onTarget) {
      if (held.length > 0 || activePid !== null) {
        // Focus loss releases immediately. No settle, no gate, no delay.
        releaseHeld(ours ? 'self-target' : 'focus-lost', true)
        activePid = null
        activeIdentity = null
      }
      if (ours) log('our own window is frontmost, staying armed and pressing nothing')
      phase = 'armed-waiting'
      emitState(pid, false)
      return
    }

    if (activePid !== pid) {
      if (held.length > 0) releaseHeld('focus-changed', true)
      activePid = pid
      activeIdentity = identity
      identityVerifiedAt = now
      focusGainedAt = now
      phase = 'settling'
    }

    if (phase === 'settling') {
      if (now - focusGainedAt < FOCUS_SETTLE_MS) {
        emitState(pid, activePid !== null)
        return
      }
      phase = 'modifier-gate'
      gateStartedAt = now
    }

    if (phase === 'modifier-gate') {
      const clear = physicalModifiersClear()
      const timedOut = now - gateStartedAt >= MODIFIER_CLEAR_TIMEOUT_MS
      if (!clear && !timedOut) {
        emitState(pid, activePid !== null)
        return
      }
      if (!clear) {
        log('modifier gate timed out after 2s, pressing anyway')
      }
      enterFiring(now)
      emitState(pid, activePid !== null)
      return
    }

    if (phase === 'firing') {
      if (currentMode === 'hold-repeat') runRepeat(now)
      else if (currentMode === 'tap') runTap(now)
      // 'hold' does nothing here, on purpose. One down at arm, one up at
      // release, nothing in between, ever.
    }

    emitState(pid, true)
  }

  // -------------------------------------------------------------------------
  // State reporting
  // -------------------------------------------------------------------------

  function buildState(pid: number | null, onTarget: boolean): HoldLoopState {
    // While firing, report the whole intended set rather than what is
    // instantaneously down: in tap mode the real set toggles up to 50 times a
    // second and the UI would strobe.
    const firing = phase === 'firing' && config !== null
    return {
      phase,
      onTarget,
      focusedPid: pid,
      firingKeyIds: firing && config !== null ? config.keys.map((key) => key.id) : [],
      firingButtonIds: firing && config !== null ? config.buttons.map((button) => button.id) : [],
    }
  }

  function emitState(pid: number | null, onTarget: boolean): void {
    const state = buildState(pid, onTarget)
    const signature = `${state.phase}|${state.onTarget}|${state.focusedPid ?? 'null'}|${state.firingKeyIds.join(',')}|${state.firingButtonIds.join(',')}`
    if (signature === lastStateSignature) return
    lastStateSignature = signature
    options.onState?.(state)
  }

  // -------------------------------------------------------------------------
  // Windows timer resolution
  // -------------------------------------------------------------------------

  function beginHighResTimers(): void {
    if (platform !== 'win32' || highResTimersOn) return
    if (typeof native.beginHighResolutionTimers !== 'function') return
    try {
      native.beginHighResolutionTimers()
      highResTimersOn = true
    } catch (error) {
      reportError('unknown', `timeBeginPeriod failed: ${String(error)}`)
    }
  }

  function endHighResTimers(): void {
    if (!highResTimersOn) return
    // Cleared first so a throw cannot leave an unbalanced begin behind.
    highResTimersOn = false
    try {
      native.endHighResolutionTimers?.()
    } catch (error) {
      reportError('unknown', `timeEndPeriod failed: ${String(error)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  function resolveConfig(input: SessionConfig): ResolvedConfig {
    const wantsHold = input.mode !== 'tap'
    const keys: KeyDef[] = []
    for (const id of input.keyIds) {
      const key = getKeyById(id)
      if (key === undefined) {
        log(`ignoring unknown key id ${id}`)
        continue
      }
      if (!isKeyAvailableOn(key, platform)) {
        log(`ignoring ${id}, it does not exist on ${platform}`)
        continue
      }
      if (wantsHold && !key.holdable) {
        log(`ignoring ${id}, it cannot be held`)
        continue
      }
      keys.push(key)
    }

    const buttons: MouseDef[] = []
    for (const id of input.buttonIds) {
      const button = getMouseButtonById(id)
      if (button === undefined) {
        log(`ignoring unknown button id ${id}`)
        continue
      }
      if (wantsHold && !button.holdable) {
        log(`ignoring ${id}, it cannot be held`)
        continue
      }
      buttons.push(button)
    }

    const repeatIntervalMs = clampNumber(
      input.repeatIntervalMs,
      REPEAT_INTERVAL_MIN_MS,
      REPEAT_INTERVAL_MAX_MS,
      REPEAT_INTERVAL_DEFAULT_MS,
    )
    const repeatInitialMs = clampInitialDelay(input.repeatInitialMs, REPEAT_INITIAL_DEFAULT_MS)
    const tapIntervalMs = clampNumber(
      input.tapIntervalMs,
      TAP_INTERVAL_MIN_MS,
      TAP_INTERVAL_MAX_MS,
      TAP_INTERVAL_DEFAULT_MS,
    )

    return {
      // Press order: modifiers first. Stable within each group.
      keys: [...keys.filter((key) => key.isModifier), ...keys.filter((key) => !key.isModifier)],
      buttons,
      targets: new Set(input.targets),
      repeatInitialMs,
      repeatIntervalMs,
      tapIntervalMs,
      tickMs: computeTickPeriodMs(input.mode, repeatIntervalMs, tapIntervalMs),
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function stopScheduler(): void {
    scheduler?.stop()
    scheduler = null
  }

  function arm(input: SessionConfig): void {
    if (armed) teardown('user-stop')

    const resolved = resolveConfig(input)
    if (resolved.keys.length === 0 && resolved.buttons.length === 0) {
      reportError('unknown', 'nothing to hold: no usable key or button in this configuration')
      return
    }

    config = resolved
    currentMode = input.mode
    armed = true
    phase = 'armed-waiting'
    activePid = null
    activeIdentity = null
    blockedReportedPid = null
    held = []
    lastStateSignature = ''
    sessionStartedAt = clock.now()
    // Force a fresh identity snapshot for this session.
    snapshotAt = Number.NEGATIVE_INFINITY

    beginHighResTimers()

    scheduler = createScheduler({
      periodMs: resolved.tickMs,
      clock,
      spinMs: options.spinMs,
      onTick: tick,
      onError: (error) => reportError('unknown', `tick failed: ${String(error)}`),
    })
    scheduler.start()
    log(`armed: mode=${input.mode} tick=${resolved.tickMs}ms keys=${resolved.keys.length} buttons=${resolved.buttons.length}`)
    emitState(null, false)
  }

  function teardown(reason: ReleaseReason): number {
    const count = releaseHeld(reason, true)
    stopScheduler()
    endHighResTimers()
    armed = false
    config = null
    activePid = null
    activeIdentity = null
    blockedReportedPid = null
    phase = 'idle'
    return count
  }

  /**
   * The loop deciding on its own that the session is over.
   *
   * Main owns the session lifecycle and it is not the one asking here, so it
   * has to be told: `disarm()` on its own stops the scheduler, and the last
   * state frame it emits is indistinguishable from an ordinary focus loss, so
   * main would soft-release and stay armed forever against a loop that has
   * stopped ticking.
   */
  function selfDisarm(reason: DisarmReason): void {
    disarm(reason)
    options.onSelfDisarm?.(reason)
  }

  function disarm(reason: DisarmReason): void {
    if (!armed && held.length === 0) {
      // Still balance the timer resolution and stop any stray scheduler.
      stopScheduler()
      endHighResTimers()
      phase = 'idle'
      return
    }
    teardown(reason)
    emitState(lastFocusedPid, false)
  }

  return {
    arm,
    disarm,
    applySettings(settings: Settings): void {
      maxSessionMs = Math.max(0, settings.maxSessionMinutes) * 60_000
      try {
        native.applySettings?.(settings)
      } catch (error) {
        reportError('unknown', `applySettings failed: ${String(error)}`)
      }
    },
    releaseAll(reason: ReleaseReason = 'user-stop'): number {
      return teardown(reason)
    },
    get armed(): boolean {
      return armed
    },
    get state(): HoldLoopState {
      return buildState(lastFocusedPid, activePid !== null)
    },
    dispose(): void {
      teardown('app-quit')
    },
  }
}
