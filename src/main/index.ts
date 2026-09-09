// SCAFFOLD PLACEHOLDER. Task 10 (preload + IPC wiring) owns this file and
// replaces it wholesale: window creation, ipc handlers, session controller,
// updater and permissions all land here. It exists now only so the three build
// entry points resolve and `npm run build` is exercisable from Task 1 onward.
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // koffi lives in main and the injector, never in the renderer, but the
      // preload script still needs Node to reach the contextBridge.
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(createWindow, (error: unknown) => {
  console.error('failed to create the main window', error)
  app.quit()
})

// The app never runs headless or in a tray. Closing the last window quits the
// process on both platforms, macOS included.
app.on('window-all-closed', () => {
  app.quit()
})
