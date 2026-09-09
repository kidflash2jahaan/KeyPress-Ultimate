/**
 * The macOS Accessibility gate.
 *
 * Three facts from the research shape this module:
 *
 * 1. Accessibility alone is sufficient for both key and mouse synthesis, so we
 *    ask for Accessibility and never for Input Monitoring. Asking for a second
 *    permission we do not need is how an input tool gets uninstalled.
 * 2. The system prompt appears **once per app identity, ever**. If the user
 *    denied it, calling `isTrustedAccessibilityClient(true)` again does nothing
 *    visible, so a UI that waits on a dialog waits forever. `promptWasAlreadyUsed`
 *    is how the UI knows to switch to explicit "open Settings, click +, pick
 *    KeyPress Ultimate from Applications" instructions instead.
 * 3. Permission can be revoked while keys are held. So the poll runs for the
 *    whole session at 1s, not just at Start, and the revocation event is what
 *    releases the keys rather than stranding them down.
 *
 * We expose the deep link as a string and never open it ourselves. Opening a URL
 * is `shell.openExternal`, which belongs to the process that owns Electron; this
 * module stays Electron-free so it runs under plain vitest.
 */

/** Wired to `systemPreferences.isTrustedAccessibilityClient(prompt)` by main. */
export type TrustCheck = (prompt: boolean) => boolean

/** The System Settings pane. Handed to the UI, opened by the caller. */
export const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/** Polled for the whole session, so a mid-hold revocation releases keys. */
export const PERMISSION_POLL_MS = 1000

export interface PermissionStatus {
  /** macOS: true. Windows: false, always. */
  needsPermission: boolean
  hasPermission: boolean
  /**
   * The one-shot system prompt has been spent. The UI must stop waiting on a
   * dialog and show the manual grant path instead.
   */
  promptWasAlreadyUsed: boolean
  /** Deep link for the UI's "Open Settings" button. Never opened here. */
  settingsUrl: string
}

/** Survives relaunches when backed by the store; in-memory in tests. */
export interface PromptState {
  wasUsed(): boolean
  markUsed(): void
}

export function createMemoryPromptState(initial = false): PromptState {
  let used = initial
  return {
    wasUsed: () => used,
    markUsed: () => {
      used = true
    },
  }
}

type TimerHandle = ReturnType<typeof globalThis.setInterval>

interface Scheduler {
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

export interface PermissionsDeps {
  platform: NodeJS.Platform | string
  isTrusted: TrustCheck
  promptState?: PromptState
  intervalMs?: number
  scheduler?: Scheduler
}

export type PermissionListener = (status: PermissionStatus) => void

export interface Permissions {
  /** Last known status. Cheap, does not touch the OS. */
  status(): PermissionStatus
  /** Re-reads the OS and emits if it changed. */
  check(): PermissionStatus
  /**
   * Shows the system prompt if it has never been shown. Otherwise re-checks
   * without prompting, because the dialog will not reappear.
   */
  request(): Promise<PermissionStatus>
  start(): void
  stop(): void
  onChange(listener: PermissionListener): () => void
}

export function createPermissions(deps: PermissionsDeps): Permissions {
  const needsPermission = deps.platform === 'darwin'
  const promptState = deps.promptState ?? createMemoryPromptState()
  const intervalMs = deps.intervalMs ?? PERMISSION_POLL_MS
  const scheduler: Scheduler = deps.scheduler ?? {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle),
  }

  const listeners = new Set<PermissionListener>()
  let handle: TimerHandle | null = null
  let granted = !needsPermission

  function read(prompt: boolean): boolean {
    if (!needsPermission) return true
    try {
      return deps.isTrusted(prompt) === true
    } catch {
      // A missing or throwing systemPreferences means we cannot prove we are
      // trusted, and "cannot prove" must read as "not trusted".
      return false
    }
  }

  function snapshot(): PermissionStatus {
    return {
      needsPermission,
      hasPermission: granted,
      promptWasAlreadyUsed: needsPermission ? promptState.wasUsed() : false,
      settingsUrl: ACCESSIBILITY_SETTINGS_URL,
    }
  }

  function emit(): void {
    const status = snapshot()
    for (const listener of [...listeners]) {
      try {
        listener(status)
      } catch {
        // A broken listener must never stop the poll that releases keys.
      }
    }
  }

  function apply(next: boolean): PermissionStatus {
    const changed = next !== granted
    granted = next
    if (changed) emit()
    return snapshot()
  }

  // Establish the baseline at construction so the first `check()` reports a
  // real transition rather than a spurious one.
  granted = read(false)

  return {
    status: snapshot,

    check(): PermissionStatus {
      return apply(read(false))
    },

    async request(): Promise<PermissionStatus> {
      if (!needsPermission) return snapshot()

      if (read(false)) return apply(true)

      if (promptState.wasUsed()) {
        // The dialog is spent. Asking again shows nothing, so report the state
        // and let the UI lead with the deep link and manual instructions.
        return apply(false)
      }

      promptState.markUsed()
      return apply(read(true))
    },

    start(): void {
      if (handle !== null || !needsPermission) return
      handle = scheduler.setInterval(() => {
        apply(read(false))
      }, intervalMs)
    },

    stop(): void {
      if (handle !== null) scheduler.clearInterval(handle)
      handle = null
    },

    onChange(listener: PermissionListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
