/**
 * The renderer's single door to the outside world.
 *
 * `window.kpu` is installed by the preload script (Task 10) and speaks the
 * channels in `src/shared/ipc.ts`. When it is missing, we are running in a
 * plain browser, and `getBridge()` transparently substitutes the mock in
 * `src/renderer/mock/bridge.ts`. Nothing above this file knows which one it
 * got, which is the whole point: the entire UI is driveable in Chrome with
 * `npx vite src/renderer` and no Electron.
 *
 * Imports here are relative on purpose. The `@shared` alias only exists in the
 * electron-vite and vitest configs, so a relative path is what keeps a bare
 * `vite` server working with zero configuration.
 */
import type {
  AppInfo,
  Platform,
  Preset,
  SessionConfig,
  SessionState,
  Settings,
  UpdateInfo,
} from '../../shared/types'
import type { DisarmReason } from '../../shared/ipc'

// ---------------------------------------------------------------------------
// Payloads that are not part of the locked type contract.
//
// `src/shared/types.ts` is final and deliberately says nothing about the shape
// of a permission reading, an arm refusal, or a download's progress. Those are
// renderer-facing view models, so they are declared here rather than widening
// the shared contract.
// ---------------------------------------------------------------------------

export interface SystemInfo {
  platform: Platform
  appVersion: string
  /** False in `electron-vite dev` and in the browser mock. */
  isPackaged: boolean
}

export interface PermissionState {
  /** macOS needs Accessibility. Windows always reports false. */
  needsPermission: boolean
  hasPermission: boolean
  /**
   * macOS shows the Accessibility prompt at most once per app identity. Once
   * it has been used, a button that "asks again" does nothing, so the UI has to
   * lead with manual instructions instead.
   */
  promptWasAlreadyUsed: boolean
}

/**
 * Start either happens or it is refused with a sentence the user can act on.
 * Refusals are not exceptions: a missing panic hotkey or a revoked permission
 * is an ordinary outcome, and throwing would turn it into a stack trace.
 */
export type ArmResult = { ok: true } | { ok: false; message: string }

export interface UpdateProgress {
  receivedBytes: number
  totalBytes: number
  /** 0 to 1. Always determinate, so the UI never fakes a spinner. */
  fraction: number
}

/** Sent once at launch when the journal found keys stranded by a hard kill. */
export interface RecoveryNotice {
  count: number
}

/** Push channels, keyed the same way as `IPC_EVENT` in the shared contract. */
export interface KpuEventMap {
  sessionState: SessionState
  appsChanged: AppInfo[]
  permissionsChanged: PermissionState
  updateAvailable: UpdateInfo | null
  updateProgress: UpdateProgress
  recoveryNotice: RecoveryNotice
}

export type KpuEventName = keyof KpuEventMap

/**
 * The whole surface the renderer is allowed to touch. Grouped by subject so a
 * caller reads `bridge.session.arm(...)` rather than a flat wall of verbs.
 *
 * Every method is async even where the mock answers instantly, because the
 * real implementation is `ipcRenderer.invoke` across a process boundary and the
 * UI must never be written as though it were not.
 */
export interface KpuBridge {
  systemInfo(): Promise<SystemInfo>

  apps: {
    list(): Promise<AppInfo[]>
    /** Re-enumerates rather than returning the cached list. */
    refresh(): Promise<AppInfo[]>
  }

  session: {
    arm(config: SessionConfig): Promise<ArmResult>
    disarm(reason: DisarmReason): Promise<void>
    getState(): Promise<SessionState>
  }

  permissions: {
    get(): Promise<PermissionState>
    openSettings(): Promise<void>
  }

  presets: {
    list(): Promise<Preset[]>
    /** Upsert by id. Returns the full list so the UI never guesses at order. */
    save(preset: Preset): Promise<Preset[]>
    remove(id: string): Promise<Preset[]>
  }

  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }

  updates: {
    check(): Promise<UpdateInfo | null>
    download(): Promise<void>
    install(): Promise<void>
    openReleasesPage(): Promise<void>
  }

  win: {
    minimize(): Promise<void>
    close(): Promise<void>
  }

  /** Subscribe to a push channel. The returned function unsubscribes. */
  on<K extends KpuEventName>(event: K, listener: (payload: KpuEventMap[K]) => void): () => void
}

declare global {
  interface Window {
    kpu?: KpuBridge
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

let resolved: KpuBridge | null = null

/** True when no preload bridge was found, i.e. we are running in a browser. */
export function isMockBridge(): boolean {
  return typeof window === 'undefined' || window.kpu === undefined
}

/**
 * The bridge for this process, resolved once and cached.
 *
 * The mock module is loaded lazily so a packaged Electron build never pulls
 * the fake app list, fake icons or fake focus timer into its renderer bundle.
 */
export function getBridge(): KpuBridge {
  if (resolved !== null) return resolved
  const real = typeof window === 'undefined' ? undefined : window.kpu
  if (real !== undefined) {
    resolved = real
    return real
  }
  throw new Error(
    'getBridge() was called before the bridge was resolved. Call resolveBridge() first.',
  )
}

/**
 * Resolve the bridge, importing the mock only if `window.kpu` is absent.
 * `main.tsx` awaits this before the first render, so no component ever has to
 * cope with a half-connected bridge.
 */
export async function resolveBridge(): Promise<KpuBridge> {
  if (resolved !== null) return resolved
  const real = typeof window === 'undefined' ? undefined : window.kpu
  if (real !== undefined) {
    resolved = real
    return real
  }
  const { createMockBridge } = await import('../mock/bridge')
  resolved = createMockBridge()
  return resolved
}

/** Test seam. Also used by `main.tsx` when it wants an explicit mock. */
export function setBridge(bridge: KpuBridge | null): void {
  resolved = bridge
}
