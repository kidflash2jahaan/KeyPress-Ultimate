/**
 * A believable stand-in for `window.kpu`, used whenever the renderer is loaded
 * outside Electron.
 *
 * This exists so the whole interface can be flow-tested in Chrome:
 *
 *     npx vite src/renderer
 *
 * It is not a stub. It enumerates apps, rotates the frontmost window on a
 * timer, refuses Start for the same reasons the real controller does, and
 * drives the session through idle to armed-waiting to firing, so the
 * focus-gating rule is visible without a single native call. If a screen looks
 * right here, it looks right in the app.
 *
 * The one deliberate departure from reality: mock icons are neutral graphite
 * monograms rather than the coloured icons `app.getFileIcon` returns. Colour in
 * this app means "current is flowing" and nothing else, and inventing six
 * coloured tiles would be the app breaking its own rule in its own test rig.
 */
import type {
  AppInfo,
  Preset,
  SessionConfig,
  SessionState,
  Settings,
  UpdateInfo,
} from '../../shared/types'
import { FOCUS_SETTLE_MS } from '../../shared/ipc'
import type {
  ArmResult,
  DownloadResult,
  KpuBridge,
  KpuEventMap,
  KpuEventName,
  PermissionState,
  SystemInfo,
  UpdateProgress,
} from '../state/bridge'

// ---------------------------------------------------------------------------
// Fake fixtures
// ---------------------------------------------------------------------------

/**
 * A rounded monogram tile as a data URL. Greys only, drawn at 32px so the
 * 16px CSS chips get an exact 2x source the same way the real registry does.
 */
function monogram(letter: string, tile: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="8" fill="${tile}"/>` +
    `<text x="16" y="22" font-family="Geist,Inter,system-ui,sans-serif" font-size="17"` +
    ` font-weight="600" fill="#E6E6EA" text-anchor="middle">${letter}</text>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

interface FakeApp extends AppInfo {
  /** Present in the focus rotation but never offered as a target. */
  isSelf?: boolean
}

const SELF_IDENTITY = 'com.keypressultimate.app'

const FAKE_APPS: readonly FakeApp[] = [
  {
    identity: 'com.mojang.minecraft',
    name: 'Minecraft',
    pid: 4412,
    path: '/Applications/Minecraft.app',
    iconDataUrl: monogram('M', '#3C3C44'),
  },
  {
    identity: 'com.google.Chrome',
    name: 'Google Chrome',
    pid: 2210,
    path: '/Applications/Google Chrome.app',
    iconDataUrl: monogram('C', '#4A4A54'),
  },
  {
    identity: 'com.valvesoftware.steam',
    name: 'Steam',
    pid: 5006,
    path: '/Applications/Steam.app',
    iconDataUrl: monogram('S', '#33333A'),
  },
  {
    identity: 'com.roblox.RobloxPlayer',
    name: 'Roblox',
    pid: 6621,
    path: '/Applications/Roblox.app',
    iconDataUrl: monogram('R', '#565661'),
  },
  {
    identity: 'com.hnc.Discord',
    name: 'Discord',
    pid: 3180,
    path: '/Applications/Discord.app',
    iconDataUrl: monogram('D', '#42424C'),
  },
  {
    identity: 'com.apple.Terminal',
    name: 'Terminal',
    pid: 719,
    path: '/System/Applications/Utilities/Terminal.app',
    iconDataUrl: monogram('T', '#2E2E34'),
  },
  {
    identity: SELF_IDENTITY,
    name: 'KeyPress Ultimate',
    pid: 9001,
    path: '/Applications/KeyPress Ultimate.app',
    iconDataUrl: monogram('K', '#5E5E68'),
    isSelf: true,
  },
]

/**
 * The order the mock cycles focus through. KeyPress Ultimate is in it twice on
 * purpose: the moment the user presses Start with our own window frontmost is
 * exactly the moment that has to read as intentional rather than broken, so it
 * should be easy to catch while clicking around.
 */
const FOCUS_ROTATION: readonly string[] = [
  SELF_IDENTITY,
  'com.mojang.minecraft',
  'com.google.Chrome',
  SELF_IDENTITY,
  'com.apple.Terminal',
  'com.mojang.minecraft',
  'com.hnc.Discord',
]

const FOCUS_PERIOD_MS = 3200

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  panicHotkey: 'CommandOrControl+Alt+Shift+K',
  maxSessionMinutes: 30,
  autoCheckUpdates: true,
  windowsUseVirtualKeys: false,
}

const SEED_PRESETS: readonly Preset[] = [
  {
    id: 'preset-afk-farm',
    name: 'Minecraft AFK farm',
    config: {
      keyIds: ['key-w'],
      buttonIds: ['left'],
      targets: ['com.mojang.minecraft'],
      mode: 'hold',
      repeatInitialMs: 400,
      repeatIntervalMs: 33,
      tapIntervalMs: 100,
    },
    updatedAt: Date.UTC(2026, 7, 19, 9, 14),
  },
  {
    id: 'preset-autoclick',
    name: 'Autoclicker, 10 per second',
    config: {
      keyIds: [],
      buttonIds: ['left'],
      targets: ['com.roblox.RobloxPlayer'],
      mode: 'tap',
      repeatInitialMs: 400,
      repeatIntervalMs: 33,
      tapIntervalMs: 100,
    },
    updatedAt: Date.UTC(2026, 8, 2, 17, 40),
  },
]

const FAKE_UPDATE: UpdateInfo = {
  version: '0.2.0',
  notes:
    'Release ordering now puts modifiers last, so a held Shift can no longer outlive the key it was modifying.\n' +
    'Focus changes settle for 150ms before the first press, which stops a Cmd+Tab from turning a held W into Cmd+W.\n' +
    'Windows: scancode injection is the default, with a virtual-key fallback in Settings for titles that ignore scancodes.',
  url: 'https://github.com/keypressultimate/keypress-ultimate/releases/tag/v0.2.0',
  assetName: 'KeyPress-Ultimate-0.2.0-universal.dmg',
  assetUrl:
    'https://github.com/keypressultimate/keypress-ultimate/releases/download/v0.2.0/KeyPress-Ultimate-0.2.0-universal.dmg',
  sha256: '9f2c1b0a4d7e6835c1f0a9b2d4e6f8071a3b5c7d9e0f2a4b6c8d0e2f4a6b8c0d',
  sizeBytes: 128_450_560,
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MockBridgeOptions {
  /** Defaults to 'darwin' so the permission gate and Cmd legends are reachable. */
  platform?: 'darwin' | 'win32'
  /** Start already granted. Set false to exercise the permission gate. */
  hasPermission?: boolean
  promptWasAlreadyUsed?: boolean
  /** Offer a pretend 0.2.0. Off by default so the banner stays quiet. */
  offerUpdate?: boolean
  /** Frozen focus, for tests that want no timers. */
  rotateFocus?: boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type Listeners = { [K in KpuEventName]: Set<(payload: KpuEventMap[K]) => void> }

export function createMockBridge(options: MockBridgeOptions = {}): KpuBridge {
  const platform = options.platform ?? 'darwin'
  const rotateFocus = options.rotateFocus ?? true

  const listeners: Listeners = {
    sessionState: new Set(),
    appsChanged: new Set(),
    permissionsChanged: new Set(),
    updateAvailable: new Set(),
    updateProgress: new Set(),
    recoveryNotice: new Set(),
  }

  let permissions: PermissionState = {
    needsPermission: platform === 'darwin',
    hasPermission: options.hasPermission ?? true,
    promptWasAlreadyUsed: options.promptWasAlreadyUsed ?? false,
  }

  let settings: Settings = { ...DEFAULT_SETTINGS }
  let presets: Preset[] = SEED_PRESETS.map((preset) => ({ ...preset }))

  let armedConfig: SessionConfig | null = null
  let focusIndex = 0
  let focusedSince = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  let session: SessionState = {
    phase: 'idle',
    startedAt: null,
    firingKeyIds: [],
    firingButtonIds: [],
    focusedApp: appFor(FOCUS_ROTATION[0] ?? SELF_IDENTITY),
    onTarget: false,
    message: null,
  }

  function appFor(identity: string): AppInfo | null {
    const found = FAKE_APPS.find((app) => app.identity === identity)
    if (found === undefined) return null
    const { isSelf: _isSelf, ...info } = found
    return info
  }

  function emit<K extends KpuEventName>(event: K, payload: KpuEventMap[K]): void {
    for (const listener of listeners[event]) listener(payload)
  }

  function publish(next: SessionState): void {
    session = next
    emit('sessionState', session)
  }

  /**
   * Recompute the session from the current focus. This is a small mirror of
   * the real gate: on target and settled means firing, anything else means
   * armed and waiting, and our own window is never a target.
   */
  function evaluate(): void {
    const identity = FOCUS_ROTATION[focusIndex % FOCUS_ROTATION.length] ?? SELF_IDENTITY
    const focusedApp = appFor(identity)

    if (armedConfig === null) {
      publish({ ...session, phase: 'idle', focusedApp, onTarget: false, firingKeyIds: [], firingButtonIds: [] })
      return
    }

    const onTarget = identity !== SELF_IDENTITY && armedConfig.targets.includes(identity)
    const settled = Date.now() - focusedSince >= FOCUS_SETTLE_MS

    if (onTarget && settled) {
      publish({
        ...session,
        phase: 'firing',
        focusedApp,
        onTarget: true,
        firingKeyIds: [...armedConfig.keyIds],
        firingButtonIds: [...armedConfig.buttonIds],
        message: null,
      })
      return
    }

    publish({
      ...session,
      phase: 'armed-waiting',
      focusedApp,
      onTarget,
      firingKeyIds: [],
      firingButtonIds: [],
      message: null,
    })
  }

  function clearSettle(): void {
    if (settleTimer === null) return
    clearTimeout(settleTimer)
    settleTimer = null
  }

  /**
   * Publish now, then again once the focus has settled.
   *
   * The second pass is not decoration. `evaluate` reads the settle gate
   * against the clock, and at the moment focus changes (or a session is armed)
   * nothing has settled yet, so the first pass can only ever say
   * 'armed-waiting'. Without the follow-up the mock would sit there until the
   * next focus rotation, and pressing Start on an already-frontmost target
   * would look like the app had failed. The real hold loop re-ticks every 25ms
   * and gets this for free; here it is one timer.
   */
  function evaluateAndSettle(): void {
    clearSettle()
    evaluate()
    if (armedConfig === null) return
    const remaining = focusedSince + FOCUS_SETTLE_MS - Date.now()
    settleTimer = setTimeout(
      () => {
        settleTimer = null
        evaluate()
      },
      Math.max(0, remaining) + 20,
    )
  }

  function tick(): void {
    focusIndex += 1
    focusedSince = Date.now()
    evaluateAndSettle()
  }

  function startTimer(): void {
    if (timer !== null || !rotateFocus) return
    timer = setInterval(tick, FOCUS_PERIOD_MS)
  }

  function stopTimerIfIdle(): void {
    const anyListeners = Object.values(listeners).some((set) => set.size > 0)
    if (!anyListeners && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const targetableApps = (): AppInfo[] =>
    FAKE_APPS.filter((app) => app.isSelf !== true).map(({ isSelf: _isSelf, ...info }) => info)

  return {
    async systemInfo(): Promise<SystemInfo> {
      return { platform, appVersion: '0.1.0', isPackaged: false }
    },

    apps: {
      async list() {
        return targetableApps()
      },
      async refresh() {
        const apps = targetableApps()
        emit('appsChanged', apps)
        return apps
      },
    },

    session: {
      async arm(config: SessionConfig): Promise<ArmResult> {
        if (permissions.needsPermission && !permissions.hasPermission) {
          return {
            ok: false,
            message:
              'macOS has not granted Accessibility to KeyPress Ultimate, so no key would actually be sent. Grant it in System Settings, then press Start again.',
          }
        }
        if (config.targets.length === 0) {
          return {
            ok: false,
            message:
              'Start needs at least one target app. Pick one in the target strip so the app knows when to fire.',
          }
        }
        if (config.keyIds.length === 0 && config.buttonIds.length === 0) {
          return {
            ok: false,
            message: 'Start needs at least one key or mouse button. Click one on the board below.',
          }
        }
        armedConfig = { ...config }
        focusedSince = Date.now()
        session = { ...session, startedAt: Date.now(), message: null }
        evaluateAndSettle()
        return { ok: true }
      },

      async disarm() {
        armedConfig = null
        clearSettle()
        publish({
          ...session,
          phase: 'idle',
          startedAt: null,
          firingKeyIds: [],
          firingButtonIds: [],
          onTarget: false,
          message: null,
        })
      },

      async getState() {
        return session
      },
    },

    permissions: {
      async get() {
        return permissions
      },
      async openSettings() {
        // The real bridge opens System Settings. Here, grant it after a beat so
        // the gate's dismissal can be seen. No fake progress bar: the state
        // simply flips, which is what actually happens.
        permissions = { ...permissions, hasPermission: true, promptWasAlreadyUsed: true }
        setTimeout(() => emit('permissionsChanged', permissions), 900)
      },
    },

    presets: {
      async list() {
        return presets.map((preset) => ({ ...preset }))
      },
      async save(preset: Preset) {
        const index = presets.findIndex((existing) => existing.id === preset.id)
        if (index === -1) presets = [...presets, preset]
        else presets = presets.map((existing) => (existing.id === preset.id ? preset : existing))
        return presets.map((existing) => ({ ...existing }))
      },
      async remove(id: string) {
        presets = presets.filter((preset) => preset.id !== id)
        return presets.map((preset) => ({ ...preset }))
      },
    },

    settings: {
      async get() {
        return settings
      },
      async set(patch: Partial<Settings>) {
        settings = { ...settings, ...patch }
        return settings
      },
    },

    updates: {
      async check() {
        return options.offerUpdate === true ? FAKE_UPDATE : null
      },
      /**
       * Resolves when the bytes are in, the way main does: it awaits the real
       * download before returning. Resolving early would tell the renderer the
       * call was over while the progress was still arriving, and the renderer
       * reads "came back before 100%" as an abandoned download.
       */
      async download(): Promise<DownloadResult> {
        const total = FAKE_UPDATE.sizeBytes
        let received = 0
        const step = Math.round(total / 24)
        await new Promise<void>((resolve) => {
          const id = setInterval(() => {
            received = Math.min(total, received + step)
            const progress: UpdateProgress = {
              receivedBytes: received,
              totalBytes: total,
              fraction: received / total,
            }
            emit('updateProgress', progress)
            if (received >= total) {
              clearInterval(id)
              resolve()
            }
          }, 180)
        })
        return { ok: true }
      },
      async install() {
        // A real install relaunches the app. Nothing to fake.
      },
      async openReleasesPage() {
        window.open(FAKE_UPDATE.url, '_blank', 'noopener')
      },
    },

    win: {
      async minimize() {
        // No frame to minimise in a browser tab.
      },
      async close() {
        // Refusing to close the tab is the honest behaviour here.
      },
    },

    on<K extends KpuEventName>(event: K, listener: (payload: KpuEventMap[K]) => void): () => void {
      listeners[event].add(listener)
      startTimer()
      if (event === 'sessionState') queueMicrotask(() => listener(session as KpuEventMap[K]))
      return () => {
        listeners[event].delete(listener)
        stopTimerIfIdle()
      }
    },
  }
}
