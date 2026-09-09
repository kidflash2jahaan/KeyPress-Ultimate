/**
 * "Currently focused: X" for the UI, and nothing more.
 *
 * This is deliberately NOT the focus gate. The injector re-checks the frontmost
 * pid on its own 25ms absolute-deadline tick before every assert, because that
 * is what decides whether a key is allowed to be down. This watcher exists only
 * so the target strip can show what the user is looking at, so it polls at a
 * lazy 250ms and emits on change, never on every tick. A display that repaints
 * four times a second is plenty; one that repaints forty times a second for no
 * new information is a battery cost and a render-loop hazard.
 */
import type { AppInfo } from '../shared/types'
import type { NativeInput } from '../injector/native/types'
import type { AppRegistry } from './app-registry'

/** The only part of the native seam this module needs. */
export type FrontmostSource = Pick<NativeInput, 'getFrontmostPid'>

/** Four updates a second. The injector's own gate is FOCUS_TICK_MS (25ms). */
export const FOCUS_POLL_MS = 250

type TimerHandle = ReturnType<typeof globalThis.setInterval>

interface Scheduler {
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

export interface FocusWatcherDeps {
  native: FrontmostSource
  /** Resolves a pid to a real app. Omit and the watcher reports pids only. */
  registry?: Pick<AppRegistry, 'findByPid'>
  /**
   * Us. The registry deliberately excludes our own app so it can never be
   * targeted, but the focus readout still has to be able to NAME us: when our
   * own window is frontmost the strip should say "KeyPress Ultimate", not
   * "Unknown", because "Unknown" reads as the app being broken at the exact
   * moment it is working correctly and deliberately holding nothing.
   */
  selfApp?: AppInfo | null
  /** Our process ids, matched against the frontmost pid to recognise ourselves. */
  selfPids?: readonly number[]
  intervalMs?: number
  scheduler?: Scheduler
}

export type FocusListener = (focused: AppInfo | null, pid: number | null) => void

export interface FocusWatcher {
  /** One read. Emits only if the focused app actually changed. */
  poll(): void
  start(): void
  stop(): void
  current(): AppInfo | null
  currentPid(): number | null
  onChange(listener: FocusListener): () => void
}

export function createFocusWatcher(deps: FocusWatcherDeps): FocusWatcher {
  const intervalMs = deps.intervalMs ?? FOCUS_POLL_MS
  const scheduler: Scheduler = deps.scheduler ?? {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle),
  }

  const listeners = new Set<FocusListener>()
  let handle: TimerHandle | null = null
  let currentPid: number | null = null
  let currentApp: AppInfo | null = null
  let started = false

  function readPid(): number | null {
    try {
      const pid = deps.native.getFrontmostPid()
      return typeof pid === 'number' && Number.isFinite(pid) ? pid : null
    } catch {
      // A null frontmost pid means "unknown", which every caller already has to
      // treat as "not on target". A throw here must not take the UI down.
      return null
    }
  }

  const selfPids = new Set<number>(deps.selfPids ?? [])

  function resolve(pid: number | null): AppInfo | null {
    if (pid === null) return null
    // Us first: the registry excludes our own app by design, so asking it about
    // our pid returns null and the UI would say "Unknown" about itself.
    if (deps.selfApp != null && selfPids.has(pid)) return deps.selfApp
    if (deps.registry === undefined) return null
    try {
      return deps.registry.findByPid(pid)
    } catch {
      return null
    }
  }

  function poll(): void {
    const pid = readPid()
    const app = resolve(pid)
    const changed = pid !== currentPid || (app?.identity ?? null) !== (currentApp?.identity ?? null)
    if (!changed) return

    currentPid = pid
    currentApp = app
    for (const listener of [...listeners]) {
      try {
        listener(app === null ? null : { ...app }, pid)
      } catch {
        // A broken UI listener must never stop the watcher.
      }
    }
  }

  return {
    poll,

    start(): void {
      if (started) return
      started = true
      // Read immediately, so the strip is never blank for the first 250ms.
      poll()
      handle = scheduler.setInterval(poll, intervalMs)
    },

    stop(): void {
      if (handle !== null) scheduler.clearInterval(handle)
      handle = null
      started = false
    },

    current(): AppInfo | null {
      return currentApp === null ? null : { ...currentApp }
    },

    currentPid(): number | null {
      return currentPid
    },

    onChange(listener: FocusListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
