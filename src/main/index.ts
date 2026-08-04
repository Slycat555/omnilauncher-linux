import { app, shell, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/omni.png?asset'
import trayIcon from '../../resources/tray-icon.png?asset'
import { registerCoverProtocolHandler, registerCoverProtocolPrivilege } from './coverProtocol'
import { registerIpcHandlers } from './ipc'
import { installLinuxDesktopEntry } from './linuxDesktopIntegration'

registerCoverProtocolPrivilege()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// Set by the tray's own "Quit" item just before calling app.quit() - the only way the
// close handler below should ever let the window actually close instead of hiding it.
let isQuitting = false

// The window's own close handler hides it to the tray instead of quitting, so a running
// instance is often sitting there hidden with no window - without a single-instance
// lock, clicking the taskbar/desktop launcher again just starts a brand new process
// instead of surfacing that one. The second launch loses the race, quits immediately,
// and its 'second-instance' event on the first process is what re-shows the real window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
}

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // frame: false hands the whole window chrome (title bar, minimize/maximize/close
    // buttons) to the renderer instead of the OS/window manager drawing it - a custom
    // titlebar (App.tsx) replaces it, same as Steam's own client does. autoHideMenuBar
    // is now moot (there's no native frame left for it to hide a menu bar from) but
    // harmless to leave.
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#14161c',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // The renderer's custom titlebar buttons can't call BrowserWindow methods directly -
  // it has no Node/Electron access (sandboxed renderer) - so these mirror what the
  // native frame's own buttons would have done, reached via IPC (see ipc.ts).
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false))

  // The X/close button backgrounds the app to the tray instead of quitting it - a
  // running install or game shouldn't be torn down just because the window closed, the
  // same reasoning as any other tray-resident app. Only the tray's own Quit item (or an
  // OS-level kill) should end the process.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Brings the main window to the front, restoring/unhiding it from the tray if needed.
 *  Exported so the NFC scan handler can call this too - the app normally sits hidden to
 *  tray, and without this a tag scan would launch the game and show our own
 *  "Launching…" overlay behind everything, with Steam's own dialog then appearing on
 *  top of whatever window happened to be focused - visually identical to "the Steam
 *  popup covers the launcher" even though the real gap was our window never coming
 *  forward in the first place. */
export function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// The custom titlebar's own minimize/maximize/close buttons (App.tsx) - a frameless
// window has no native equivalent buttons doing this anymore, so the renderer calls
// these over IPC instead.
export function minimizeMainWindow(): void {
  mainWindow?.minimize()
}

export function toggleMaximizeMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
}

export function isMainWindowMaximized(): boolean {
  return mainWindow?.isMaximized() ?? false
}

export function closeMainWindow(): void {
  // Same as the native frame's own X button before frame:false - this backgrounds to
  // tray via the window's existing 'close' handler below, it does not quit the app.
  mainWindow?.close()
}

function createTray(): void {
  // The full-res app icon (omni.png) is 1024px and renders oversized/blurry when handed
  // straight to the tray - Electron doesn't intelligently downscale it the way a window
  // icon gets scaled by the compositor. A dedicated 24px asset (Steam's own tray icons
  // use the same hicolor/24x24 convention) keeps it crisp and correctly sized instead.
  tray = new Tray(nativeImage.createFromPath(trayIcon))
  tray.setToolTip('OmniLauncher')

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OmniLauncher', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )

  tray.on('click', showMainWindow)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.omnilauncher.linux')

  installLinuxDesktopEntry()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerCoverProtocolHandler()
  registerIpcHandlers()

  createWindow()
  createTray()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The window's own 'close' handler hides it to the tray rather than destroying it, so
// in normal use this never fires from the X button - only if the window is destroyed
// some other way (e.g. during quit itself), in which case there's nothing left running
// to keep the app alive for anyway.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
