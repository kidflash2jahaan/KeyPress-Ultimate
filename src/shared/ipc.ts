/**
 * The IPC contract. Two separate conversations live here:
 *
 *   1. renderer <-> main, over Electron's ipcMain/ipcRenderer, named by the
 *      channel strings in `IPC`.
 *   2. main <-> injector (a `utilityProcess`), over structured-clone messages
 *      typed by `MainToInjectorMessage` / `InjectorToMainMessage`.
 *
 * Both are defined once, here, and imported by every process. Nothing else in
 * the app is allowed to spell a channel name or a message tag as a literal.
 */
import type { SessionConfig, Settings } from './types'

// ---------------------------------------------------------------------------
// renderer <-> main channel names
// ---------------------------------------------------------------------------

/** Channels the renderer invokes and awaits a reply on (`ipcRenderer.invoke`). */
export const IPC_INVOKE = {
  systemInfo: 'system:info',

  appsList: 'apps:list',
  appsRefresh: 'apps:refresh',

  sessionArm: 'session:arm',
  sessionDisarm: 'session:disarm',
  sessionGetState: 'session:get-state',

  permissionsGet: 'permissions:get',
  permissionsOpenSettings: 'permissions:open-settings',

  presetsList: 'presets:list',
  presetsSave: 'presets:save',
  presetsDelete: 'presets:delete',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesInstall: 'updates:install',
  updatesOpenReleasesPage: 'updates:open-releases-page',

  windowMinimize: 'window:minimize',
  windowClose: 'window:close',
} as const

/** Channels main pushes to the renderer (`webContents.send`). */
export const IPC_EVENT = {
  sessionState: 'session:state',
  appsChanged: 'apps:changed',
  permissionsChanged: 'permissions:changed',
  updateAvailable: 'updates:available',
  updateProgress: 'updates:progress',
  recoveryNotice: 'notice:recovered',
} as const

export type IpcInvokeChannel = (typeof IPC_INVOKE)[keyof typeof IPC_INVOKE]
export type IpcEventChannel = (typeof IPC_EVENT)[keyof typeof IPC_EVENT]
export type IpcChannel = IpcInvokeChannel | IpcEventChannel

/** Every channel name, for the preload allowlist. */
export const ALL_IPC_CHANNELS: readonly IpcChannel[] = [
  ...Object.values(IPC_INVOKE),
  ...Object.values(IPC_EVENT),
]

// ---------------------------------------------------------------------------
// main <-> injector message protocol
// ---------------------------------------------------------------------------

/**
 * Why a session is being torn down. Every one of these ends in the same
 * idempotent `releaseAll()`; the reason exists only so the UI can say what
 * happened.
 */
export type DisarmReason =
  | 'user-stop'
  | 'focus-lost'
  | 'target-quit'
  | 'app-quit'
  | 'window-closed'
  | 'uncaught-exception'
  | 'signal'
  | 'power-suspend'
  | 'screen-locked'
  | 'permission-revoked'
  | 'heartbeat-timeout'
  | 'panic-hotkey'
  | 'max-session-time'
  | 'injector-error'

export type InjectorErrorCode =
  | 'ffi-init-failed'
  | 'struct-layout-mismatch'
  | 'permission-denied'
  | 'injection-blocked'
  | 'unsupported-platform'
  | 'unknown'

export type MainToInjectorMessage =
  | { t: 'arm'; config: SessionConfig }
  | { t: 'disarm'; reason: DisarmReason }
  | { t: 'ping'; n: number }
  | { t: 'settings'; settings: Settings }

export type InjectorToMainMessage =
  | {
      t: 'state'
      firingKeyIds: string[]
      firingButtonIds: string[]
      onTarget: boolean
      focusedPid: number | null
    }
  | { t: 'pong'; n: number }
  | { t: 'error'; code: InjectorErrorCode; message: string }
  | { t: 'released'; count: number }
  /** Windows UIPI: the target is elevated and nothing we post can reach it. */
  | { t: 'blocked'; code: 'elevated-target'; message: string; appName: string }

export type MainToInjectorTag = MainToInjectorMessage['t']
export type InjectorToMainTag = InjectorToMainMessage['t']

// ---------------------------------------------------------------------------
// shared timing constants
// ---------------------------------------------------------------------------

/**
 * Bidirectional liveness. If either side stops hearing from the other within
 * the timeout, it releases every held key and exits. These two numbers are
 * shared so the hold loop and the session controller can never disagree.
 */
export const HEARTBEAT_INTERVAL_MS = 100
export const HEARTBEAT_TIMEOUT_MS = 300

/** Focus is re-checked before every assert, on an absolute-deadline schedule. */
export const FOCUS_TICK_MS = 25

/** After focus lands on a target, wait this long before the first press. */
export const FOCUS_SETTLE_MS = 150

/** Give up waiting for the user's physical modifiers to clear after this long. */
export const MODIFIER_CLEAR_TIMEOUT_MS = 2000
