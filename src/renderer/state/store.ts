/**
 * The renderer's single store.
 *
 * Everything the UI can change lives here, and every change that has to reach
 * the main process goes out through the bridge from an action in this file. No
 * component calls `window.kpu` directly, so the browser mock and the real
 * preload bridge are interchangeable at exactly one seam.
 *
 * Two shapes matter for performance:
 *
 *  - `actions` is a frozen object created once, so `useAppStore(s => s.actions)`
 *    never re-renders. Components subscribe to the narrow slice they draw and
 *    read every mutator off that one stable reference.
 *  - `sessionState` arrives from the injector as often as the hold loop ticks.
 *    `applySessionState` drops pushes that changed nothing, so a 25ms stream of
 *    identical frames costs zero renders.
 */
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type {
  AppInfo,
  HoldMode,
  Platform,
  Preset,
  SessionConfig,
  SessionState,
  Settings,
  UpdateInfo,
} from '../../shared/types'
import { getKeyById, getMouseButtonById } from '../../shared/keys'
import type {
  KpuBridge,
  PermissionState,
  UpdateProgress,
} from './bridge'

// ---------------------------------------------------------------------------
// Limits. Every one of these is also enforced by the injector; the UI clamps
// so a typed-in value can never leave the field in a state Start would refuse.
// ---------------------------------------------------------------------------

export const LIMITS = {
  repeatInitialMs: { min: 100, max: 2000, step: 10 },
  repeatIntervalMs: { min: 10, max: 500, step: 1 },
  tapIntervalMs: { min: 10, max: 1000, step: 5 },
} as const

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  panicHotkey: 'CommandOrControl+Alt+Shift+K',
  maxSessionMinutes: 30,
  autoCheckUpdates: true,
  windowsUseVirtualKeys: false,
}

export const IDLE_SESSION: SessionState = {
  phase: 'idle',
  startedAt: null,
  firingKeyIds: [],
  firingButtonIds: [],
  focusedApp: null,
  onTarget: false,
  message: null,
}

export const NO_PERMISSION_NEEDED: PermissionState = {
  needsPermission: false,
  hasPermission: true,
  promptWasAlreadyUsed: false,
}

export type NoticeKind = 'info' | 'problem'

export interface Notice {
  kind: NoticeKind
  text: string
}

export type UpdateStage = 'none' | 'available' | 'downloading' | 'ready'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AppState {
  /** Host facts, filled by `init`. Defaults keep the first paint honest. */
  platform: Platform
  appVersion: string
  ready: boolean

  /** The editable half of a `SessionConfig`. */
  keyIds: string[]
  buttonIds: string[]
  targets: string[]
  mode: HoldMode
  repeatInitialMs: number
  repeatIntervalMs: number
  tapIntervalMs: number

  apps: AppInfo[]
  session: SessionState
  permissions: PermissionState
  settings: Settings

  presets: Preset[]
  activePresetId: string | null

  update: UpdateInfo | null
  updateStage: UpdateStage
  updateProgress: UpdateProgress | null

  notice: Notice | null
  settingsOpen: boolean

  actions: AppActions
}

export interface AppActions {
  init(): Promise<void>

  toggleKey(id: string): void
  /** Bulk form, for the keyboard's shift-click range selection. */
  setKeysSelected(ids: readonly string[], selected: boolean): void
  toggleButton(id: string): void
  clearSelection(): void
  toggleTarget(identity: string): void

  setMode(mode: HoldMode): void
  setRepeatInitialMs(value: number): void
  setRepeatIntervalMs(value: number): void
  setTapIntervalMs(value: number): void

  start(): Promise<StartOutcome>
  stop(): Promise<void>
  refreshApps(): Promise<void>

  savePreset(name: string): Promise<void>
  applyPreset(id: string): void
  renamePreset(id: string, name: string): Promise<void>
  deletePreset(id: string): Promise<void>

  updateSettings(patch: Partial<Settings>): Promise<void>
  openPermissionSettings(): Promise<void>

  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  openReleasesPage(): Promise<void>

  setSettingsOpen(open: boolean): void
  dismissNotice(): void

  minimizeWindow(): Promise<void>
  closeWindow(): Promise<void>
}

export type StartOutcome = { started: true } | { started: false; message: string }

export type AppStore = StoreApi<AppState>

// ---------------------------------------------------------------------------
// Pure helpers, exported because the tests and the status line both need them
// ---------------------------------------------------------------------------

export function configOf(state: AppState): SessionConfig {
  return {
    keyIds: state.keyIds,
    buttonIds: state.buttonIds,
    targets: state.targets,
    mode: state.mode,
    repeatInitialMs: state.repeatInitialMs,
    repeatIntervalMs: state.repeatIntervalMs,
    tapIntervalMs: state.tapIntervalMs,
  }
}

/**
 * Why Start cannot run yet, phrased as something the user can act on, or null
 * when it can. Order matters: name the thing nearest their hand first.
 */
export function describeStartRefusal(state: AppState): string | null {
  if (state.keyIds.length === 0 && state.buttonIds.length === 0) {
    return 'Nothing is selected yet. Click a key on the board or a button on the mouse to choose what gets held.'
  }
  if (state.targets.length === 0) {
    return 'No target app is picked. Choose at least one above, because keys only fire while a target app is frontmost.'
  }
  if (state.permissions.needsPermission && !state.permissions.hasPermission) {
    return 'macOS has not granted Accessibility to KeyPress Ultimate, so nothing would actually be sent. Grant it, then press Start.'
  }
  if (state.mode === 'tap') {
    const { min, max } = LIMITS.tapIntervalMs
    if (state.tapIntervalMs < min || state.tapIntervalMs > max) {
      return `The tap interval has to be between ${min} and ${max} ms. 100 ms is about ten taps a second.`
    }
  }
  return null
}

export function isSessionArmed(phase: SessionState['phase']): boolean {
  return phase === 'armed-waiting' || phase === 'firing' || phase === 'blocked'
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function sameSession(a: SessionState, b: SessionState): boolean {
  return (
    a.phase === b.phase &&
    a.startedAt === b.startedAt &&
    a.onTarget === b.onTarget &&
    a.message === b.message &&
    a.focusedApp?.identity === b.focusedApp?.identity &&
    sameIds(a.firingKeyIds, b.firingKeyIds) &&
    sameIds(a.firingButtonIds, b.firingButtonIds)
  )
}

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((existing) => existing !== id) : [...list, id]
}

/** Keys and buttons with no held state, which only Hold mode cannot express. */
function isHoldable(id: string, kind: 'key' | 'button'): boolean {
  const def = kind === 'key' ? getKeyById(id) : getMouseButtonById(id)
  return def?.holdable ?? true
}

function labelOf(id: string, kind: 'key' | 'button'): string {
  if (kind === 'key') return getKeyById(id)?.label ?? id
  return getMouseButtonById(id)?.label ?? id
}

function newPresetId(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return `preset-${c.randomUUID()}`
  return `preset-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createAppStore(bridge: KpuBridge): AppStore {
  return createStore<AppState>()((set, get) => {
    /** Replace a session push, but only when something actually changed. */
    function applySessionState(next: SessionState): void {
      if (sameSession(get().session, next)) return
      set({ session: next })
    }

    /** Any edit to the config detaches from the preset it came from. */
    function editConfig(patch: Partial<AppState>): void {
      set({ ...patch, activePresetId: null })
    }

    const actions: AppActions = {
      async init() {
        const [info, apps, permissions, settings, presets, session] = await Promise.all([
          bridge.systemInfo(),
          bridge.apps.list(),
          bridge.permissions.get(),
          bridge.settings.get(),
          bridge.presets.list(),
          bridge.session.getState(),
        ])

        set({
          platform: info.platform,
          appVersion: info.appVersion,
          apps,
          permissions,
          settings,
          presets,
          session,
          ready: true,
        })

        bridge.on('sessionState', applySessionState)
        bridge.on('appsChanged', (next) => set({ apps: next }))
        bridge.on('permissionsChanged', (next) => set({ permissions: next }))
        bridge.on('updateProgress', (progress) => {
          set({
            updateProgress: progress,
            updateStage: progress.fraction >= 1 ? 'ready' : 'downloading',
          })
        })
        bridge.on('updateAvailable', (update) => {
          set({ update, updateStage: update === null ? 'none' : 'available' })
        })
        bridge.on('recoveryNotice', ({ count }) => {
          set({
            notice: {
              kind: 'info',
              text:
                count === 1
                  ? 'KeyPress Ultimate closed while a key was still down. That key has been released.'
                  : `KeyPress Ultimate closed while ${count} keys were still down. They have been released.`,
            },
          })
        })

        if (settings.autoCheckUpdates) void actions.checkForUpdates()
      },

      toggleKey(id) {
        const state = get()
        const adding = !state.keyIds.includes(id)
        if (adding && state.mode === 'hold' && !isHoldable(id, 'key')) {
          set({
            notice: {
              kind: 'problem',
              text: `${labelOf(id, 'key')} has no held state, so Hold cannot use it. Switch to Tap and it will be pressed once per interval.`,
            },
          })
          return
        }
        editConfig({ keyIds: toggle(state.keyIds, id), notice: null })
      },

      setKeysSelected(ids, selected) {
        const state = get()
        if (ids.length === 1) {
          const only = ids[0]
          // A single id is a plain click. Route it through toggleKey so the
          // "this key has no held state" explanation is not lost on the way.
          if (only !== undefined && state.keyIds.includes(only) !== selected) {
            actions.toggleKey(only)
            return
          }
        }
        const usable = ids.filter((id) => state.mode !== 'hold' || isHoldable(id, 'key'))
        const skipped = ids.length - usable.length
        const next = selected
          ? [...state.keyIds, ...usable.filter((id) => !state.keyIds.includes(id))]
          : state.keyIds.filter((id) => !usable.includes(id))
        editConfig({
          keyIds: next,
          notice:
            skipped === 0
              ? null
              : {
                  kind: 'info',
                  text:
                    skipped === 1
                      ? 'One key in that range has no held state, so Hold left it out. Tap can use it.'
                      : `${skipped} keys in that range have no held state, so Hold left them out. Tap can use them.`,
                },
        })
      },

      toggleButton(id) {
        const state = get()
        const adding = !state.buttonIds.includes(id)
        if (adding && state.mode === 'hold' && !isHoldable(id, 'button')) {
          set({
            notice: {
              kind: 'problem',
              text: `${labelOf(id, 'button')} is a wheel detent, not a button, so there is nothing to hold. Switch to Tap to scroll repeatedly.`,
            },
          })
          return
        }
        editConfig({ buttonIds: toggle(state.buttonIds, id), notice: null })
      },

      clearSelection() {
        editConfig({ keyIds: [], buttonIds: [], notice: null })
      },

      toggleTarget(identity) {
        editConfig({ targets: toggle(get().targets, identity), notice: null })
      },

      setMode(mode) {
        const state = get()
        if (mode === state.mode) return
        if (mode !== 'hold') {
          editConfig({ mode, notice: null })
          return
        }
        // Hold cannot express a key with no held state, so dropping them is the
        // only honest move. Say which ones went, and why.
        const droppedKeys = state.keyIds.filter((id) => !isHoldable(id, 'key'))
        const droppedButtons = state.buttonIds.filter((id) => !isHoldable(id, 'button'))
        const dropped = [
          ...droppedKeys.map((id) => labelOf(id, 'key')),
          ...droppedButtons.map((id) => labelOf(id, 'button')),
        ]
        editConfig({
          mode,
          keyIds: state.keyIds.filter((id) => isHoldable(id, 'key')),
          buttonIds: state.buttonIds.filter((id) => isHoldable(id, 'button')),
          notice:
            dropped.length === 0
              ? null
              : {
                  kind: 'info',
                  text: `${dropped.join(', ')} left the selection. Hold sends one press and keeps it down, and those have no held state.`,
                },
        })
      },

      setRepeatInitialMs(value) {
        const { min, max } = LIMITS.repeatInitialMs
        editConfig({ repeatInitialMs: clamp(value, min, max) })
      },
      setRepeatIntervalMs(value) {
        const { min, max } = LIMITS.repeatIntervalMs
        editConfig({ repeatIntervalMs: clamp(value, min, max) })
      },
      setTapIntervalMs(value) {
        const { min, max } = LIMITS.tapIntervalMs
        editConfig({ tapIntervalMs: clamp(value, min, max) })
      },

      async start() {
        const state = get()
        const refusal = describeStartRefusal(state)
        if (refusal !== null) {
          set({ notice: { kind: 'problem', text: refusal } })
          return { started: false, message: refusal }
        }
        const result = await bridge.session.arm(configOf(state))
        if (!result.ok) {
          set({ notice: { kind: 'problem', text: result.message } })
          return { started: false, message: result.message }
        }
        set({ notice: null })
        return { started: true }
      },

      async stop() {
        await bridge.session.disarm('user-stop')
        set({ notice: null })
      },

      async refreshApps() {
        const apps = await bridge.apps.refresh()
        set({ apps })
      },

      async savePreset(name) {
        const state = get()
        const trimmed = name.trim()
        if (trimmed === '') {
          set({ notice: { kind: 'problem', text: 'A preset needs a name. Type one, then save.' } })
          return
        }
        const preset: Preset = {
          id: newPresetId(),
          name: trimmed,
          config: configOf(state),
          updatedAt: Date.now(),
        }
        const presets = await bridge.presets.save(preset)
        set({ presets, activePresetId: preset.id, notice: null })
      },

      applyPreset(id) {
        const preset = get().presets.find((candidate) => candidate.id === id)
        if (preset === undefined) return
        const { config } = preset
        set({
          keyIds: [...config.keyIds],
          buttonIds: [...config.buttonIds],
          targets: [...config.targets],
          mode: config.mode,
          repeatInitialMs: config.repeatInitialMs,
          repeatIntervalMs: config.repeatIntervalMs,
          tapIntervalMs: config.tapIntervalMs,
          activePresetId: preset.id,
          notice: null,
        })
      },

      async renamePreset(id, name) {
        const preset = get().presets.find((candidate) => candidate.id === id)
        if (preset === undefined) return
        const trimmed = name.trim()
        if (trimmed === '') {
          set({ notice: { kind: 'problem', text: 'A preset needs a name. Type one, then save.' } })
          return
        }
        const presets = await bridge.presets.save({ ...preset, name: trimmed, updatedAt: Date.now() })
        set({ presets, notice: null })
      },

      async deletePreset(id) {
        const presets = await bridge.presets.remove(id)
        set({
          presets,
          activePresetId: get().activePresetId === id ? null : get().activePresetId,
        })
      },

      async updateSettings(patch) {
        const settings = await bridge.settings.set(patch)
        set({ settings })
      },

      async openPermissionSettings() {
        await bridge.permissions.openSettings()
      },

      async checkForUpdates() {
        const update = await bridge.updates.check()
        set({ update, updateStage: update === null ? 'none' : 'available' })
      },

      async downloadUpdate() {
        set({ updateStage: 'downloading', updateProgress: null })
        await bridge.updates.download()
      },

      async installUpdate() {
        await bridge.updates.install()
      },

      async openReleasesPage() {
        await bridge.updates.openReleasesPage()
      },

      setSettingsOpen(open) {
        set({ settingsOpen: open })
      },

      dismissNotice() {
        set({ notice: null })
      },

      async minimizeWindow() {
        await bridge.win.minimize()
      },

      async closeWindow() {
        await bridge.win.close()
      },
    }

    return {
      platform: 'darwin',
      appVersion: '0.0.0',
      ready: false,

      keyIds: [],
      buttonIds: [],
      targets: [],
      mode: 'hold',
      repeatInitialMs: 400,
      repeatIntervalMs: 33,
      tapIntervalMs: 100,

      apps: [],
      session: IDLE_SESSION,
      permissions: NO_PERMISSION_NEEDED,
      settings: DEFAULT_SETTINGS,

      presets: [],
      activePresetId: null,

      update: null,
      updateStage: 'none',
      updateProgress: null,

      notice: null,
      settingsOpen: false,

      actions: Object.freeze(actions),
    }
  })
}

// ---------------------------------------------------------------------------
// The app-wide instance
// ---------------------------------------------------------------------------

let instance: AppStore | null = null

export function initAppStore(bridge: KpuBridge): AppStore {
  instance = createAppStore(bridge)
  return instance
}

export function getAppStore(): AppStore {
  if (instance === null) {
    throw new Error('The store was read before initAppStore() ran. main.tsx installs it.')
  }
  return instance
}

/** Subscribe to one slice. Keep selectors narrow: this runs on every push. */
export function useAppStore<T>(selector: (state: AppState) => T): T {
  return useStore(getAppStore(), selector)
}

/** The frozen action bag. Stable for the life of the store, so it never re-renders. */
export function useActions(): AppActions {
  return useStore(getAppStore(), (state) => state.actions)
}
