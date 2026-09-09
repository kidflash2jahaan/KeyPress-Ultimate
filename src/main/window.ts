/**
 * The one window.
 *
 * The app has no tray, no background mode and no second window, so this module
 * owns a single `BrowserWindow` and the handful of decisions that go with it.
 *
 * Three of those decisions are load-bearing:
 *
 *   1. **`show: false` until `ready-to-show`.** Electron paints a white frame the
 *      instant a window is created, and this app is graphite in both themes. A
 *      white flash on a dark UI reads as a bug in the app rather than a quirk of
 *      the toolkit, and it is the very first thing the user ever sees.
 *   2. **The chrome differs, the layout does not.** macOS gets `hiddenInset`, so
 *      the real traffic lights sit in the inset the title bar reserves for them.
 *      Windows gets a frameless window, because the renderer draws its own
 *      minimise and close buttons there and a native title bar above a custom
 *      one is two title bars.
 *   3. **`sandbox: false`, and only for the preload.** koffi runs in main and in
 *      the injector, never in the renderer, so the renderer keeps
 *      `contextIsolation: true` and `nodeIntegration: false`. The preload still
 *      needs Node to reach `contextBridge`, which is what the disabled sandbox
 *      buys, and nothing else.
 *
 * Navigation is locked down here rather than in the IPC layer, because a window
 * that can be talked into loading a remote page has a preload bridge attached to
 * it, and that bridge can arm the injector.
 */
import { join } from 'node:path'
import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'

/** Comfortable for the 104-key board at a readable unit size. */
export const WINDOW_DEFAULT_SIZE = { width: 1180, height: 820 } as const

/**
 * Below this the key unit drops under 38px and the dual-legend keys stop being
 * readable, which is the measurement that killed the sidebar layout too.
 */
export const WINDOW_MIN_SIZE = { width: 1100, height: 760 } as const

/**
 * The first paint, before the renderer has painted anything of its own. These
 * are `--bg` from `src/renderer/styles/tokens.css` in each theme: a window that
 * opens white on a dark UI reads as a bug in the app rather than a quirk of the
 * toolkit, and it is the very first thing the user ever sees.
 */
export const WINDOW_BACKGROUND_DARK = '#0b0b0d'
export const WINDOW_BACKGROUND_LIGHT = '#f4f4f2'

/** Kept as the constructor default, and as the name older callers reach for. */
export const WINDOW_BACKGROUND = WINDOW_BACKGROUND_DARK

export function backgroundFor(dark: boolean): string {
  return dark ? WINDOW_BACKGROUND_DARK : WINDOW_BACKGROUND_LIGHT
}

export interface CreateWindowOptions {
  /** Built preload bundle. Defaults to `../preload/index.js` next to main. */
  preloadPath?: string
  /** `ELECTRON_RENDERER_URL` in dev. Falls back to the packaged index.html. */
  rendererUrl?: string | undefined
  rendererFile?: string
  platform?: NodeJS.Platform
  onError?: (message: string, error: unknown) => void
}

let current: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  if (current === null || current.isDestroyed()) return null
  return current
}

/**
 * Bring the existing window to the front. This is what a second launch does
 * instead of starting a second app: the single instance lock hands the new
 * process's argv to the running one, and the running one surfaces.
 */
export function focusMainWindow(): boolean {
  const window = getMainWindow()
  if (window === null) return false
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
  return true
}

export function createMainWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const platform = options.platform ?? process.platform
  const onError = options.onError ?? ((): void => undefined)
  const isMac = platform === 'darwin'

  const constructorOptions: BrowserWindowConstructorOptions = {
    width: WINDOW_DEFAULT_SIZE.width,
    height: WINDOW_DEFAULT_SIZE.height,
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    title: 'KeyPress Ultimate',
    // macOS keeps its traffic lights in the inset the renderer's title bar
    // reserves. Windows draws its own controls, so it gets no frame at all.
    ...(isMac
      ? ({ titleBarStyle: 'hiddenInset' } satisfies BrowserWindowConstructorOptions)
      : ({ frame: false } satisfies BrowserWindowConstructorOptions)),
    webPreferences: {
      preload: options.preloadPath ?? join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // koffi lives in main and the injector, never in the renderer. The
      // preload still needs Node to reach contextBridge.
      sandbox: false,
      webviewTag: false,
      spellcheck: false,
    },
  }

  const window = new BrowserWindow(constructorOptions)
  current = window

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('closed', () => {
    if (current === window) current = null
  })

  // A window carrying the bridge must never navigate anywhere we did not build.
  // Links go to the user's browser; in-place navigation is refused.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const target = options.rendererUrl
    const allowed = target !== undefined && target !== '' && url.startsWith(target)
    if (!allowed) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  const devServerUrl = options.rendererUrl
  const load =
    devServerUrl !== undefined && devServerUrl !== ''
      ? window.loadURL(devServerUrl)
      : window.loadFile(options.rendererFile ?? join(__dirname, '../renderer/index.html'))

  load.catch((error: unknown) => {
    onError('failed to load the renderer', error)
  })

  return window
}

/** Only http(s) reaches the user's browser. No file://, no custom schemes. */
function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
