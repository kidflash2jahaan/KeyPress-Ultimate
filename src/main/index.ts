/**
 * The main process. This file is the integration, and nothing else.
 *
 * Every other module in `src/main` is a self-contained thing that knows how to
 * do one job against injected dependencies: enumerate apps, watch focus, read a
 * permission, persist settings, run a session, replay a journal, fetch an
 * update. None of them import Electron at module scope and none of them know
 * about each other. This file is where they are handed the real Electron and
 * wired to each other, and it is deliberately the only file in the app that
 * does both.
 *
 * The order below is load-bearing, and it is the order of the startup:
 *
 *   1. Take the single instance lock. A second copy would fork a second
 *      injector, and two injectors holding the same key is exactly the
 *      stuck-key failure the whole app exists to prevent.
 *   2. Load settings, so the theme is right before the first pixel.
 *   3. Bind the native layer, so the app list and the crash recovery have
 *      something real underneath them.
 *   4. Replay the crash journal, before the window exists, so any key stranded
 *      by a hard kill is already up by the time the user can see the UI. The
 *      notice about it is delivered when the renderer has loaded.
 *   5. Register the IPC handlers, then create the window. Handlers first,
 *      because the renderer starts invoking during its first paint.
 *
 * Shutdown is the same list backwards, with one rule that overrides everything:
 * the app does not exit until the injector has confirmed it let go of the keys,
 * or until a short grace period proves it never will. `before-quit` holds the
 * quit open for exactly that long. Nothing about the shutdown races the
 * injector's own exit, because the injector is killed only after it confirms.
 */
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  shell,
  systemPreferences,
} from 'electron'
import { IPC_EVENT, type DisarmReason, type IpcEventChannel } from '@shared/ipc'
import type {
  AppInfo,
  Platform,
  Preset,
  SessionConfig,
  SessionState,
  Settings,
  UpdateInfo,
} from '@shared/types'
import { createNativeInput, type NativeInput } from '../injector/native'
import { createAppRegistry } from './app-registry'
import { createFocusWatcher } from './focus-watcher'
import { createIconCache } from './icons'
import { HoldJournal, recoverStaleJournal, type ReplayPlan } from './journal'
import { ACCESSIBILITY_SETTINGS_URL, createPermissions } from './permissions'
import { releaseInputDirectly } from './release-directly'
import {
  SessionController,
  type PowerEventName,
  type PowerMonitorLike,
} from './session-controller'
import { createStore } from './store'
import { createUpdater, RELEASES_PAGE_URL, type DownloadProgress, type Updater } from './updater'
import {
  registerIpcHandlers,
  type ArmResult,
  type IpcInvokeEventLike,
  type KpuEventMap,
  type KpuEventName,
  type PermissionState,
  type SystemInfo,
} from './ipc-handlers'
import { backgroundFor, createMainWindow, focusMainWindow, getMainWindow } from './window'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Matches the packaged bundle identifier. It is used to keep our own window out
 * of the target list: holding a key "in KeyPress Ultimate" is a loop with no
 * way out, because the app that would let you press Stop is the app receiving
 * the keys.
 */
const APP_ID = 'com.keypressultimate.app'

const EVENT_CHANNELS: Readonly<Record<KpuEventName, IpcEventChannel>> = {
  sessionState: IPC_EVENT.sessionState,
  appsChanged: IPC_EVENT.appsChanged,
  permissionsChanged: IPC_EVENT.permissionsChanged,
  updateAvailable: IPC_EVENT.updateAvailable,
  updateProgress: IPC_EVENT.updateProgress,
  recoveryNotice: IPC_EVENT.recoveryNotice,
}

/** How long a quit waits for the injector to confirm the keys are up. */
const QUIT_RELEASE_TIMEOUT_MS = 2000

function log(message: string, error?: unknown): void {
  if (error === undefined) console.error(`[keypress] ${message}`)
  else console.error(`[keypress] ${message}`, error)
}

function currentPlatform(): Platform {
  return process.platform === 'darwin' ? 'darwin' : 'win32'
}

// ---------------------------------------------------------------------------
// Single instance. Everything below runs only in the first copy.
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // A second launch is a request to look at the window that already exists, so
  // the running copy is told to surface and this one leaves without touching
  // the journal, the store or the injector.
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
  })
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
  void bootstrap()
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  try {
    await app.whenReady()
  } catch (error) {
    log('the app never became ready', error)
    app.quit()
    return
  }

  // -------------------------------------------------------------------------
  // Persistence and theme
  // -------------------------------------------------------------------------

  const store = createStore({ userDataDir: app.getPath('userData') })
  let settings: Settings = store.loadSettings()
  applyTheme(settings.theme)
  nativeTheme.on('updated', () => {
    // Only the chrome colour is ours to keep in step. The renderer resolves
    // 'system' itself from `prefers-color-scheme`, which `themeSource` drives.
    getMainWindow()?.setBackgroundColor(backgroundFor(nativeTheme.shouldUseDarkColors))
  })

  // -------------------------------------------------------------------------
  // Native input
  //
  // koffi binds here, in main, and in the injector. Never in the renderer.
  // A failure is survivable: the app list goes empty and Start refuses, which
  // is a visibly broken app rather than a silently dead one.
  // -------------------------------------------------------------------------

  let native: NativeInput | null = null
  try {
    const bound = await createNativeInput()
    await bound.init()
    native = bound
  } catch (error) {
    log('could not bind the native input layer', error)
  }

  const nativeInput = native

  /**
   * Post key-ups and button-ups for a set of ids, straight from main. Used by
   * the crash-journal replay at startup and as the session controller's
   * last-resort release when the injector dies without confirming.
   *
   * The rules it obeys, and why a normal return here is treated as proof the
   * keys are up, live in `./release-directly.ts`.
   */
  function releaseDirectly(keyIds: readonly string[], buttonIds: readonly string[]): number {
    return releaseInputDirectly({ native: nativeInput, keyIds, buttonIds, onError: log })
  }

  // -------------------------------------------------------------------------
  // Registry, icons, focus
  // -------------------------------------------------------------------------

  const registry = createAppRegistry({
    native: {
      listApplications: () => (nativeInput === null ? [] : nativeInput.listApplications()),
    },
    selfIdentity: currentPlatform() === 'darwin' ? APP_ID : app.getPath('exe'),
    selfPids: [process.pid],
  })

  const icons = createIconCache({
    // Electron insists on a size; the cache treats it as optional. 'normal' is
    // 32px on macOS, which is the cap `getFileIcon` honours anyway.
    getFileIcon: (path, options) => app.getFileIcon(path, { size: options?.size ?? 'normal' }),
  })

  const focus = createFocusWatcher({
    native: {
      getFrontmostPid: () => (nativeInput === null ? null : nativeInput.getFrontmostPid()),
    },
    registry,
  })

  /**
   * The frontmost app, kept here rather than asked for on demand. The session
   * controller only knows about focus while a session is armed, because that is
   * the only time the injector is reporting it, but the target strip shows the
   * frontmost app the whole time.
   */
  let focusedApp: AppInfo | null = null

  async function listApps(): Promise<AppInfo[]> {
    return icons.decorate(registry.list())
  }

  async function refreshApps(): Promise<AppInfo[]> {
    const apps = await icons.decorate(registry.refresh())
    emit('appsChanged', apps)
    return apps
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  const permissions = createPermissions({
    platform: process.platform,
    isTrusted: (prompt) => {
      const prefs = systemPreferences as Partial<{
        isTrustedAccessibilityClient(prompt: boolean): boolean
      }>
      if (typeof prefs.isTrustedAccessibilityClient !== 'function') return true
      return prefs.isTrustedAccessibilityClient(prompt)
    },
    // Persisted, because macOS shows its Accessibility prompt once per app
    // identity and the UI has to stop offering a button that does nothing.
    promptState: store.promptState,
  })

  function permissionView(): PermissionState {
    const status = permissions.status()
    return {
      needsPermission: status.needsPermission,
      hasPermission: status.hasPermission,
      promptWasAlreadyUsed: status.promptWasAlreadyUsed,
    }
  }

  permissions.onChange(() => {
    emit('permissionsChanged', permissionView())
  })
  permissions.check()
  permissions.start()

  // -------------------------------------------------------------------------
  // Crash journal replay, before the window exists
  // -------------------------------------------------------------------------

  const journal = new HoldJournal({
    directory: app.getPath('userData'),
    onError: (stage, error) => {
      log(`journal ${stage} failed`, error)
    },
  })

  const recovery = recoverStaleJournal({
    journal,
    replay: (plan: ReplayPlan) => releaseDirectly(plan.keyIds, plan.buttonIds),
    onError: (error) => {
      log('could not replay the crash journal', error)
    },
  })
  if (recovery.message !== null) log(recovery.message)

  // -------------------------------------------------------------------------
  // Session controller
  // -------------------------------------------------------------------------

  const powerMonitorAdapter: PowerMonitorLike = {
    on: (event: PowerEventName, listener: () => void) => {
      powerMonitor.on(event as 'suspend', listener)
    },
    removeListener: (event: PowerEventName, listener: () => void) => {
      powerMonitor.removeListener(event as 'suspend', listener)
    },
  }

  const controller = new SessionController({
    settings,
    journal,
    globalShortcut,
    powerMonitor: powerMonitorAdapter,
    powerSaveBlocker,
    permissions: { hasPermission: () => permissions.status().hasPermission },
    resolveApp: (pid) => (pid === null ? null : registry.findByPid(pid)),
    resolveTargetName: (identity) => registry.findByIdentity(identity)?.name ?? null,
    releaseFallback: nativeInput === null ? null : releaseDirectly,
    onError: (message, error) => {
      log(message, error)
    },
  })

  const detachFailsafes = controller.attachProcessFailsafes()

  /** Every state the renderer sees carries the frontmost app, armed or not. */
  function withFocus(state: SessionState): SessionState {
    return state.focusedApp === null ? { ...state, focusedApp: focusedApp } : state
  }

  controller.onState((state) => {
    emit('sessionState', withFocus(state))
  })

  focus.onChange((next, pid) => {
    focusedApp = next
    // A pid we cannot name is usually an app that started after the last
    // enumeration, so re-enumerate once rather than showing a blank strip. Our
    // own window is the exception: it is filtered out of the list on purpose
    // and will never resolve, so re-enumerating for it is pure waste.
    if (next === null && pid !== null && pid !== process.pid) {
      registry.invalidate()
      void refreshApps().catch((error: unknown) => {
        log('could not refresh the app list', error)
      })
    }
    if (!controller.isArmed) emit('sessionState', withFocus(controller.getState()))
  })
  focus.start()

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  const updater: Updater = createUpdater({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    tempDir: app.getPath('temp'),
    // The swap runs in a detached process that waits for this one to exit, so
    // the quit is part of the install rather than something the user does
    // afterwards. It goes through `app.quit()`, which means it goes through
    // `before-quit`, which means the keys are released on the way out.
    quit: () => {
      app.quit()
    },
    log: (message, detail) => {
      log(`updater: ${message}`, detail)
    },
  })

  let latestUpdate: UpdateInfo | null = null
  let downloadedPath: string | null = null

  function reportProgress(progress: DownloadProgress): void {
    const total = progress.bytesTotal > 0 ? progress.bytesTotal : 0
    const done = Math.max(0, Math.min(progress.bytesDone, total === 0 ? progress.bytesDone : total))
    const raw =
      total > 0 ? done / total : progress.percent > 1 ? progress.percent / 100 : progress.percent
    const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    emit('updateProgress', { receivedBytes: done, totalBytes: total, fraction })
  }

  async function checkForUpdates(userInitiated: boolean): Promise<UpdateInfo | null> {
    const info = await updater.check({ userInitiated })
    if (info === null || latestUpdate === null || info.version !== latestUpdate.version) {
      // A different version invalidates whatever was downloaded for the old one.
      downloadedPath = null
    }
    latestUpdate = info
    emit('updateAvailable', info)
    return info
  }

  async function downloadUpdate(): Promise<void> {
    const info = latestUpdate ?? (await checkForUpdates(true))
    if (info === null) return
    const capability = updater.canSelfUpdate()
    if (!capability.ok) {
      // Read-only location, translocated bundle, or an install we must not
      // rewrite. The honest move is the Releases page, from a constant.
      log(`self-update is unavailable: ${capability.reason ?? 'unknown reason'}`)
      await openReleasesPage()
      return
    }
    downloadedPath = await updater.download(info, reportProgress)
  }

  async function installUpdate(): Promise<void> {
    const info = latestUpdate
    if (info === null) return
    if (downloadedPath === null) {
      await downloadUpdate()
      if (downloadedPath === null) return
    }
    await updater.install(info, downloadedPath)
  }

  /** The URL is a module constant. No fetched or renderer-supplied string. */
  async function openReleasesPage(): Promise<void> {
    await shell.openExternal(RELEASES_PAGE_URL)
  }

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------

  function emit<K extends KpuEventName>(name: K, payload: KpuEventMap[K]): void {
    const window = getMainWindow()
    if (window === null) return
    const contents = window.webContents
    if (contents.isDestroyed()) return
    contents.send(EVENT_CHANNELS[name], payload)
  }

  const systemInfo = (): SystemInfo => ({
    platform: currentPlatform(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
  })

  const removeIpcHandlers = registerIpcHandlers({
    ipcMain,
    systemInfo,

    apps: {
      list: listApps,
      refresh: refreshApps,
    },

    session: {
      // The controller's refusal carries a machine-readable code the renderer
      // has no use for, so only the sentence crosses the boundary.
      arm: (config: SessionConfig): ArmResult => {
        const result = controller.arm(config)
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      },
      disarm: (reason: DisarmReason) => {
        controller.disarm(reason)
      },
      getState: () => withFocus(controller.getState()),
    },

    permissions: {
      get: permissionView,
      openSettings: async () => {
        // The one-shot system prompt first, if it has never been spent, then
        // the pane itself. Both are constants; neither is a renderer string.
        await permissions.request()
        await shell.openExternal(ACCESSIBILITY_SETTINGS_URL)
        emit('permissionsChanged', permissionView())
      },
    },

    presets: {
      list: () => store.loadPresets(),
      save: (preset: Preset) => store.upsertPreset(preset),
      remove: (id: string) => store.deletePreset(id),
    },

    settings: {
      get: () => settings,
      set: (patch: Partial<Settings>) => {
        const next = store.saveSettings({ ...settings, ...patch })
        settings = next
        applyTheme(next.theme)
        controller.setSettings(next)
        return next
      },
    },

    updates: {
      check: () => checkForUpdates(true),
      download: downloadUpdate,
      install: installUpdate,
      openReleasesPage,
    },

    window: {
      minimize: () => {
        getMainWindow()?.minimize()
      },
      close: () => {
        getMainWindow()?.close()
      },
    },

    // Only the window we made is allowed to talk to us. A message from any
    // other webContents is refused before its payload is even parsed.
    isTrustedSender: (event: IpcInvokeEventLike) => {
      const window = getMainWindow()
      return window !== null && event.sender === window.webContents
    },

    onError: (message, error) => {
      log(message, error)
    },
  })

  // -------------------------------------------------------------------------
  // Window
  // -------------------------------------------------------------------------

  function openWindow(): void {
    const window = createMainWindow({
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
      platform: process.platform,
      onError: (message, error) => {
        log(message, error)
      },
    })
    window.setBackgroundColor(backgroundFor(nativeTheme.shouldUseDarkColors))

    // Pushes are only worth sending once the preload has installed its
    // listeners, which is what `did-finish-load` guarantees. The preload buffers
    // anything that arrives before the renderer subscribes, so the recovery
    // notice survives the gap between load and the store's first render.
    window.webContents.on('did-finish-load', () => {
      if (recovery.releasedCount > 0) {
        emit('recoveryNotice', { count: recovery.releasedCount })
      } else if (recovery.outcome === 'replay-failed' && recovery.message !== null) {
        // The one outcome where keys really may still be physically down is the
        // one the notice channel cannot express: `RecoveryNotice` carries a
        // released count and nothing else, and a count of 0 renders as "0 keys
        // were still down. They have been released", which is the opposite of
        // the truth. Until that payload is widened to carry the outcome, this
        // is said in the only surface main owns outright, rather than left in
        // the log where the user will never see it. A sheet on our own window,
        // so it cannot block anything else the user is doing.
        void dialog
          .showMessageBox(window, {
            type: 'warning',
            title: 'Some keys may still be held',
            message: 'Some keys may still be held',
            detail: recovery.message,
            buttons: ['OK'],
            noLink: true,
          })
          .catch((error: unknown) => {
            log('could not show the failed-recovery notice', error)
          })
      }
      emit('permissionsChanged', permissionView())
      emit('sessionState', withFocus(controller.getState()))
      void listApps()
        .then((apps) => {
          emit('appsChanged', apps)
        })
        .catch((error: unknown) => {
          log('could not send the app list', error)
        })
      if (settings.autoCheckUpdates) {
        void checkForUpdates(false).catch((error: unknown) => {
          log('the startup update check failed', error)
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  let quitting = false

  openWindow()

  /**
   * Stop the session and wait for the release to be confirmed.
   *
   * The controller asks the injector to let go, waits for its `released`
   * message, and only then kills it, so this never races the injector's own
   * exit. The timeout is the backstop for an injector that is already gone: it
   * falls through to main's own native release, and if even that is impossible
   * the journal is deliberately left on disk for the next launch to replay.
   */
  function disarmAndWait(reason: DisarmReason): Promise<void> {
    if (!controller.isArmed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        off()
        resolve()
      }
      const off = controller.onRelease((event) => {
        if (event.hardStop) finish()
      })
      const timer = setTimeout(finish, QUIT_RELEASE_TIMEOUT_MS)
      controller.disarm(reason)
    })
  }

  async function shutdown(): Promise<void> {
    try {
      await disarmAndWait('app-quit')
    } catch (error) {
      log('the shutdown release failed', error)
    }
    try {
      controller.dispose()
      detachFailsafes()
      focus.stop()
      permissions.stop()
      removeIpcHandlers()
      globalShortcut.unregisterAll()
      nativeInput?.dispose()
    } catch (error) {
      log('shutdown cleanup failed', error)
    }
  }

  // The app is a visible foreground app or it is not running. There is no tray,
  // no background mode, and no macOS exception: closing the window quits.
  app.on('window-all-closed', () => {
    app.quit()
  })

  // Only reachable if something else kept the process alive. Rebuilding the
  // window is better than a dock icon that does nothing when clicked.
  app.on('activate', () => {
    if (quitting) return
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    // Hold the quit open exactly long enough to release the keys.
    event.preventDefault()
    void shutdown().finally(() => {
      app.quit()
    })
  })
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * `Settings.theme` drives `nativeTheme.themeSource`, which is the one switch
 * that moves everything at once: the window's own chrome, the traffic lights,
 * and the renderer's `prefers-color-scheme`. That last one is how the resolved
 * theme reaches the renderer; the UI reads the setting for its explicit
 * `data-theme`, and the media query for 'system'. No extra IPC channel exists
 * for it, and none is needed.
 */
function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
  getMainWindow()?.setBackgroundColor(backgroundFor(nativeTheme.shouldUseDarkColors))
}
