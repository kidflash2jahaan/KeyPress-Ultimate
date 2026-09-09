/**
 * The renderer/main boundary.
 *
 * Everything the renderer can ask main to do arrives here first, and nothing
 * gets past this file unvalidated. The renderer is a web page. It runs code we
 * wrote, but it also runs whatever a compromised dependency, a devtools console
 * or a rogue extension puts in front of it, so from main's point of view its
 * messages are untrusted input with a friendly return address.
 *
 * Four rules, all enforced here rather than in the modules downstream:
 *
 *   1. **Only the channels in the contract exist.** Handlers are registered for
 *      exactly the entries in `IPC_INVOKE`, and registering anything not in
 *      `ALL_IPC_CHANNELS` throws at wiring time rather than opening a channel
 *      nobody reviewed.
 *   2. **Only the sender we created answers.** A message from a webContents that
 *      is not our window is rejected outright.
 *   3. **Every payload is re-derived, never trusted.** Key ids are looked up in
 *      the key table, mouse buttons in the mouse table, modes and themes and
 *      disarm reasons in their closed sets, and every number is clamped into a
 *      range the injector can survive. What comes out is a value main built,
 *      whose only relationship to the renderer's bytes is that it was inspired
 *      by them.
 *   4. **No renderer string ever becomes a path, a URL or an argument.** The
 *      releases page URL is a constant here. Settings and presets go to the
 *      store, which writes two fixed filenames. Nothing the renderer sends is
 *      concatenated into anything the OS will interpret.
 *
 * The module is Electron-free by design: `IpcMainLike` is the whole surface it
 * needs, so the entire boundary is testable under plain vitest with a fake.
 */
import {
  ALL_IPC_CHANNELS,
  IPC_INVOKE,
  type DisarmReason,
  type IpcInvokeChannel,
} from '@shared/ipc'
import { getKeyById, getMouseButtonById } from '@shared/keys'
import type {
  AppInfo,
  HoldMode,
  Platform,
  Preset,
  SessionConfig,
  SessionState,
  Settings,
  UpdateInfo,
} from '@shared/types'

// ---------------------------------------------------------------------------
// The view models the renderer speaks.
//
// `src/shared/types.ts` is final and says nothing about a permission reading, a
// start refusal or a download's progress, so those shapes live here. They are
// the same declarations `src/renderer/state/bridge.ts` makes for the renderer
// half; the preload imports these, which is what keeps the two halves honest
// without the main tsconfig having to compile renderer code.
// ---------------------------------------------------------------------------

export interface SystemInfo {
  platform: Platform
  appVersion: string
  isPackaged: boolean
}

export interface PermissionState {
  needsPermission: boolean
  hasPermission: boolean
  promptWasAlreadyUsed: boolean
}

/** A refusal is an ordinary outcome, not an exception. */
export type ArmResult = { ok: true } | { ok: false; message: string }

export interface UpdateProgress {
  receivedBytes: number
  totalBytes: number
  /** 0 to 1. Always determinate, so the UI never fakes a spinner. */
  fraction: number
}

export interface RecoveryNotice {
  count: number
}

/** Push channels, keyed the way `IPC_EVENT` keys them. */
export interface KpuEventMap {
  sessionState: SessionState
  appsChanged: AppInfo[]
  permissionsChanged: PermissionState
  updateAvailable: UpdateInfo | null
  updateProgress: UpdateProgress
  recoveryNotice: RecoveryNotice
}

export type KpuEventName = keyof KpuEventMap

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Every bound below exists because the value crosses into a real-time loop or a
 * file. A tap interval of 0 is a busy loop that pins a core; a tap interval of
 * 2^31 is a session that never fires; 50,000 target identities is a denial of
 * service against our own enumeration. None of these are reachable through the
 * UI, which is exactly why they have to be checked here.
 */
export const INTERVAL_MS = { min: 10, max: 1000 } as const
export const REPEAT_INITIAL_MS = { min: 10, max: 10_000 } as const
export const MAX_SESSION_MINUTES = { min: 0, max: 24 * 60 } as const

export const LIMITS = {
  /** 114 keys exist; the cap is a guard, not a policy. */
  keys: 128,
  buttons: 16,
  targets: 32,
  /** A Windows identity is a full exe path. */
  identityChars: 512,
  presetIdChars: 128,
  presetNameChars: 120,
  presets: 200,
} as const

const DEFAULTS = {
  repeatInitialMs: 400,
  repeatIntervalMs: 33,
  tapIntervalMs: 100,
} as const

const MODES: ReadonlySet<string> = new Set<HoldMode>(['hold', 'hold-repeat', 'tap'])
const THEMES: ReadonlySet<string> = new Set<Settings['theme']>(['system', 'dark', 'light'])

const DISARM_REASONS: ReadonlySet<string> = new Set<DisarmReason>([
  'user-stop',
  'focus-lost',
  'target-quit',
  'app-quit',
  'window-closed',
  'uncaught-exception',
  'signal',
  'power-suspend',
  'screen-locked',
  'permission-revoked',
  'heartbeat-timeout',
  'panic-hotkey',
  'max-session-time',
  'injector-error',
])

/**
 * The renderer has exactly one reason to stop a session: the user pressed Stop.
 * Everything else in `DisarmReason` is main's own vocabulary for describing a
 * failsafe, and a renderer claiming "permission-revoked" would put a sentence in
 * the UI that is not true. Anything else is quietly read as a user stop.
 */
const RENDERER_DISARM_REASONS: ReadonlySet<string> = new Set<DisarmReason>(['user-stop'])

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Control characters are how a string sneaks past a log, a path or a UI. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

export function isSafeText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    !CONTROL_CHARS.test(value)
  )
}

/**
 * Clamp into range. A non-number, a NaN, an Infinity or a numeric string all
 * become the fallback rather than propagating into a timer.
 */
export function clampMs(
  value: unknown,
  bounds: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

function uniqueSafeStrings(value: unknown, maxChars: number, maxCount: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (out.length >= maxCount) break
    if (!isSafeText(item, maxChars)) continue
    const trimmed = item.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

// ---------------------------------------------------------------------------
// Payload parsers. Each returns a value main built, or a refusal the user can
// act on. None of them throw: a malformed payload is a bug or an attack, and
// neither is worth a stack trace in the renderer's console.
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

const MALFORMED = 'KeyPress Ultimate could not read that request. Reopen the window and try again.'

/**
 * Key and button ids are checked against the generated tables, so an id that is
 * not on the keyboard cannot reach the injector, where it would either be
 * silently dropped or turned into a keycode nobody meant to press.
 */
export function parseSessionConfig(raw: unknown): Parsed<SessionConfig> {
  if (!isRecord(raw)) return { ok: false, message: MALFORMED }

  const mode = raw['mode']
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    return { ok: false, message: MALFORMED }
  }

  const keyIds = uniqueSafeStrings(raw['keyIds'], LIMITS.identityChars, LIMITS.keys).filter(
    (id) => getKeyById(id) !== undefined,
  )
  const buttonIds = uniqueSafeStrings(raw['buttonIds'], LIMITS.identityChars, LIMITS.buttons).filter(
    (id) => getMouseButtonById(id) !== undefined,
  )
  const targets = uniqueSafeStrings(raw['targets'], LIMITS.identityChars, LIMITS.targets)

  if (keyIds.length === 0 && buttonIds.length === 0) {
    return {
      ok: false,
      message: 'Pick at least one key or mouse button before starting.',
    }
  }
  if (targets.length === 0) {
    return {
      ok: false,
      message:
        'Pick at least one target app. KeyPress Ultimate only holds keys while a target is frontmost.',
    }
  }

  return {
    ok: true,
    value: {
      keyIds,
      buttonIds,
      targets,
      mode: mode as HoldMode,
      repeatInitialMs: clampMs(
        raw['repeatInitialMs'],
        REPEAT_INITIAL_MS,
        DEFAULTS.repeatInitialMs,
      ),
      repeatIntervalMs: clampMs(raw['repeatIntervalMs'], INTERVAL_MS, DEFAULTS.repeatIntervalMs),
      tapIntervalMs: clampMs(raw['tapIntervalMs'], INTERVAL_MS, DEFAULTS.tapIntervalMs),
    },
  }
}

/** Anything but a reason the renderer is entitled to send reads as a user stop. */
export function parseDisarmReason(raw: unknown): DisarmReason {
  if (typeof raw === 'string' && DISARM_REASONS.has(raw) && RENDERER_DISARM_REASONS.has(raw)) {
    return raw as DisarmReason
  }
  return 'user-stop'
}

export function parsePresetId(raw: unknown): string | null {
  if (!isSafeText(raw, LIMITS.presetIdChars)) return null
  const id = raw.trim()
  // Ids are compared, never joined into a path, but a preset id that looks like
  // one is a smell worth refusing outright.
  if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) return null
  return id
}

export function parsePreset(raw: unknown, now: number): Parsed<Preset> {
  if (!isRecord(raw)) return { ok: false, message: MALFORMED }

  const id = parsePresetId(raw['id'])
  if (id === null) return { ok: false, message: MALFORMED }

  const nameRaw = raw['name']
  if (!isSafeText(nameRaw, LIMITS.presetNameChars)) {
    return { ok: false, message: 'A preset needs a name of 120 characters or fewer.' }
  }
  const name = nameRaw.trim()
  if (name === '') {
    return { ok: false, message: 'A preset needs a name. Type one, then save.' }
  }

  // A preset is a saved configuration, not a session about to run, so it is
  // allowed to be empty of keys or targets. Reuse the config parser's clamping
  // without inheriting its "you cannot start this" refusals.
  const configRaw = raw['config']
  if (!isRecord(configRaw)) return { ok: false, message: MALFORMED }
  const mode = configRaw['mode']
  if (typeof mode !== 'string' || !MODES.has(mode)) return { ok: false, message: MALFORMED }

  const config: SessionConfig = {
    keyIds: uniqueSafeStrings(configRaw['keyIds'], LIMITS.identityChars, LIMITS.keys).filter(
      (keyId) => getKeyById(keyId) !== undefined,
    ),
    buttonIds: uniqueSafeStrings(
      configRaw['buttonIds'],
      LIMITS.identityChars,
      LIMITS.buttons,
    ).filter((buttonId) => getMouseButtonById(buttonId) !== undefined),
    targets: uniqueSafeStrings(configRaw['targets'], LIMITS.identityChars, LIMITS.targets),
    mode: mode as HoldMode,
    repeatInitialMs: clampMs(
      configRaw['repeatInitialMs'],
      REPEAT_INITIAL_MS,
      DEFAULTS.repeatInitialMs,
    ),
    repeatIntervalMs: clampMs(
      configRaw['repeatIntervalMs'],
      INTERVAL_MS,
      DEFAULTS.repeatIntervalMs,
    ),
    tapIntervalMs: clampMs(configRaw['tapIntervalMs'], INTERVAL_MS, DEFAULTS.tapIntervalMs),
  }

  const updatedAt = raw['updatedAt']
  return {
    ok: true,
    value: {
      id,
      name,
      config,
      updatedAt:
        typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0
          ? Math.floor(updatedAt)
          : now,
    },
  }
}

/**
 * Only the five known settings, each re-derived. An unknown key is dropped
 * rather than merged, so the renderer cannot write arbitrary JSON into the
 * settings file by way of a patch.
 */
export function parseSettingsPatch(raw: unknown): Parsed<Partial<Settings>> {
  if (!isRecord(raw)) return { ok: false, message: MALFORMED }

  const patch: Partial<Settings> = {}

  if ('theme' in raw) {
    const theme = raw['theme']
    if (typeof theme !== 'string' || !THEMES.has(theme)) return { ok: false, message: MALFORMED }
    patch.theme = theme as Settings['theme']
  }

  if ('panicHotkey' in raw) {
    // Shape only. Whether the accelerator can actually be registered is the
    // panic hotkey module's judgement, made at Start where a refusal is
    // actionable.
    const hotkey = raw['panicHotkey']
    if (!isSafeText(hotkey, 64)) return { ok: false, message: MALFORMED }
    patch.panicHotkey = hotkey.trim()
  }

  if ('maxSessionMinutes' in raw) {
    const minutes = raw['maxSessionMinutes']
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
      return { ok: false, message: MALFORMED }
    }
    patch.maxSessionMinutes = Math.min(
      MAX_SESSION_MINUTES.max,
      Math.max(MAX_SESSION_MINUTES.min, Math.floor(minutes)),
    )
  }

  if ('autoCheckUpdates' in raw) {
    const value = raw['autoCheckUpdates']
    if (typeof value !== 'boolean') return { ok: false, message: MALFORMED }
    patch.autoCheckUpdates = value
  }

  if ('windowsUseVirtualKeys' in raw) {
    const value = raw['windowsUseVirtualKeys']
    if (typeof value !== 'boolean') return { ok: false, message: MALFORMED }
    patch.windowsUseVirtualKeys = value
  }

  return { ok: true, value: patch }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** The only part of an `IpcMainInvokeEvent` this module looks at. */
export interface IpcInvokeEventLike {
  readonly sender?: unknown
}

export type IpcInvokeListener = (
  event: IpcInvokeEventLike,
  ...args: unknown[]
) => unknown | Promise<unknown>

/** The whole Electron surface this module needs. */
export interface IpcMainLike {
  handle(channel: string, listener: IpcInvokeListener): void
  removeHandler(channel: string): void
}

export interface IpcHandlerDeps {
  ipcMain: IpcMainLike

  systemInfo(): SystemInfo

  apps: {
    list(): Promise<AppInfo[]>
    refresh(): Promise<AppInfo[]>
  }

  session: {
    arm(config: SessionConfig): ArmResult | Promise<ArmResult>
    disarm(reason: DisarmReason): void | Promise<void>
    getState(): SessionState
  }

  permissions: {
    get(): PermissionState
    openSettings(): void | Promise<void>
  }

  presets: {
    list(): Preset[]
    save(preset: Preset): Preset[]
    remove(id: string): Preset[]
  }

  settings: {
    get(): Settings
    set(patch: Partial<Settings>): Settings
  }

  /**
   * These four are the channels whose rejections are forwarded to the renderer
   * rather than swallowed. `check()` resolving to `null` means "checked, and
   * nothing is newer"; it must never be used to paper over a check that could
   * not run, and `download()` / `install()` must reject rather than resolve on
   * a refusal, or the UI has no way to stop saying "Downloading…".
   */
  updates: {
    check(): Promise<UpdateInfo | null>
    download(): Promise<void>
    install(): Promise<void>
    openReleasesPage(): Promise<void>
  }

  window: {
    minimize(): void
    close(): void
  }

  /** True when the message came from the window we created. */
  isTrustedSender?(event: IpcInvokeEventLike): boolean
  now?: () => number
  onError?: (message: string, error: unknown) => void
}

const UNTRUSTED_SENDER = 'KeyPress Ultimate ignored a message from an unexpected sender.'

/**
 * Register every invoke handler in the contract. Returns a function that
 * removes them again, so a window that is torn down and rebuilt never ends up
 * with two handlers on one channel (Electron throws on the second `handle`).
 */
export function registerIpcHandlers(deps: IpcHandlerDeps): () => void {
  const now = deps.now ?? (() => Date.now())
  const onError = deps.onError ?? ((): void => undefined)
  const registered: string[] = []

  function handle(channel: IpcInvokeChannel, run: (args: unknown[]) => Promise<unknown>): void {
    // A channel that is not in the contract is a wiring bug, and it is worth
    // failing at startup rather than quietly opening a door.
    if (!ALL_IPC_CHANNELS.includes(channel)) {
      throw new Error(`refusing to register an IPC handler for the unknown channel "${channel}"`)
    }
    if (registered.includes(channel)) {
      throw new Error(`an IPC handler for "${channel}" is already registered`)
    }
    registered.push(channel)

    deps.ipcMain.handle(channel, async (event: IpcInvokeEventLike, ...args: unknown[]) => {
      if (deps.isTrustedSender !== undefined && !deps.isTrustedSender(event)) {
        throw new Error(UNTRUSTED_SENDER)
      }
      return run(args)
    })
  }

  /** Anything a downstream module throws becomes `fallback`, never a crash. */
  async function safely<T>(label: string, run: () => Promise<T> | T, fallback: T): Promise<T> {
    try {
      return await run()
    } catch (error) {
      onError(label, error)
      return fallback
    }
  }

  /**
   * The updater's exception to `safely`.
   *
   * `safely` is right for a channel whose failure the user cannot act on:
   * minimising a window that is already gone should not become a dialog. It is
   * wrong for the update channels, because their entire job is to report an
   * outcome. The updater deliberately rejects with sentences written for the
   * user ("GitHub's release API is rate limited right now…", "No SHA-256 was
   * published for …, so it cannot be verified"), and swallowing them here turns
   * a refusal into a resolved `undefined`: the renderer then shows a check that
   * "found nothing" or a download that never finishes, which is a lie about an
   * app that replaces its own binary.
   *
   * So: log it for the main-process log, then let it cross the boundary.
   * `ipcMain.handle` forwards a rejection to the renderer's `invoke`, which is
   * the only channel the UI has for hearing "this failed".
   */
  async function surfacing<T>(label: string, run: () => Promise<T> | T): Promise<T> {
    try {
      return await run()
    } catch (error) {
      onError(label, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  handle(IPC_INVOKE.systemInfo, async () => deps.systemInfo())

  handle(IPC_INVOKE.appsList, async () => safely('apps:list', () => deps.apps.list(), []))
  handle(IPC_INVOKE.appsRefresh, async () =>
    safely('apps:refresh', () => deps.apps.refresh(), []),
  )

  handle(IPC_INVOKE.sessionArm, async (args) => {
    const parsed = parseSessionConfig(args[0])
    if (!parsed.ok) return { ok: false, message: parsed.message } satisfies ArmResult
    return safely('session:arm', () => deps.session.arm(parsed.value), {
      ok: false,
      message: 'KeyPress Ultimate could not start the session. Restart the app and try again.',
    } satisfies ArmResult)
  })

  handle(IPC_INVOKE.sessionDisarm, async (args) => {
    const reason = parseDisarmReason(args[0])
    await safely('session:disarm', () => deps.session.disarm(reason), undefined)
    return undefined
  })

  handle(IPC_INVOKE.sessionGetState, async () => deps.session.getState())

  handle(IPC_INVOKE.permissionsGet, async () => deps.permissions.get())
  handle(IPC_INVOKE.permissionsOpenSettings, async () => {
    await safely(
      'permissions:open-settings',
      () => deps.permissions.openSettings(),
      undefined,
    )
    return undefined
  })

  handle(IPC_INVOKE.presetsList, async () => safely('presets:list', () => deps.presets.list(), []))

  handle(IPC_INVOKE.presetsSave, async (args) => {
    const parsed = parsePreset(args[0], now())
    // A refused preset returns the list unchanged rather than throwing: the UI
    // has already validated the name, so anything arriving broken here is not
    // something the user can fix from a dialog.
    if (!parsed.ok) {
      onError('presets:save', new Error(parsed.message))
      return safely('presets:list', () => deps.presets.list(), [])
    }
    return safely('presets:save', () => deps.presets.save(parsed.value), [])
  })

  handle(IPC_INVOKE.presetsDelete, async (args) => {
    const id = parsePresetId(args[0])
    if (id === null) return safely('presets:list', () => deps.presets.list(), [])
    return safely('presets:delete', () => deps.presets.remove(id), [])
  })

  handle(IPC_INVOKE.settingsGet, async () => deps.settings.get())

  handle(IPC_INVOKE.settingsSet, async (args) => {
    const parsed = parseSettingsPatch(args[0])
    const current = deps.settings.get()
    if (!parsed.ok) {
      onError('settings:set', new Error(parsed.message))
      return current
    }
    return safely('settings:set', () => deps.settings.set(parsed.value), current)
  })

  // `null` from these channels means "checked, and you are already current".
  // A check that could not run rejects instead, so the two are never confused.
  handle(IPC_INVOKE.updatesCheck, async () => surfacing('updates:check', () => deps.updates.check()))
  handle(IPC_INVOKE.updatesDownload, async () => {
    await surfacing('updates:download', () => deps.updates.download())
    return undefined
  })
  handle(IPC_INVOKE.updatesInstall, async () => {
    await surfacing('updates:install', () => deps.updates.install())
    return undefined
  })
  handle(IPC_INVOKE.updatesOpenReleasesPage, async () => {
    await safely('updates:open-releases-page', () => deps.updates.openReleasesPage(), undefined)
    return undefined
  })

  handle(IPC_INVOKE.windowMinimize, async () => {
    await safely('window:minimize', () => deps.window.minimize(), undefined)
    return undefined
  })
  handle(IPC_INVOKE.windowClose, async () => {
    await safely('window:close', () => deps.window.close(), undefined)
    return undefined
  })

  return () => {
    for (const channel of registered) {
      try {
        deps.ipcMain.removeHandler(channel)
      } catch (error) {
        onError(`failed to remove the handler for ${channel}`, error)
      }
    }
    registered.length = 0
  }
}
