import { app, BrowserWindow, Menu } from 'electron'
import path from 'node:path'
import { reconcileAccountShares } from './accounts'
import { sweepOrphanedMintDirs } from './accountMint'
import { registerAllIpc, type IpcCtx } from './ipc'
import { closeTodoWindow, restoreTodoWindow } from './ipc/todos'
import { attachWindowEvents } from './ipc/window'
import { log, writeCrashReport } from './log'
import { installProtocolHandlers, registerSchemes } from './protocol'
import { guardWebContents, loadRenderer } from './windows'

let win: BrowserWindow | null = null

/**
 * Which userData folder this launch owns.
 *
 * `ADA_USER_DATA` is an absolute override — the e2e smoke test points it at a
 * throwaway temp dir. `ADA_PROFILE` names a sibling folder beside the installed
 * app's, and a run from source defaults to the `dev` profile so experimenting
 * can never touch the workspaces, archive or accounts of the installed copy.
 *
 * This runs before anything reads userData (the logger, the store, the account
 * dirs) and before the single-instance lock, which Electron keys on that very
 * path — a profile that arrives late would fight the running instance for it.
 */
function applyUserDataProfile(): void {
  const override = process.env['ADA_USER_DATA']
  if (override) {
    app.setPath('userData', path.resolve(override))
    return
  }
  const profile = process.env['ADA_PROFILE'] || (app.isPackaged ? '' : 'dev')
  if (!profile) return
  app.setPath('userData', path.join(app.getPath('appData'), `AI Detachment Alpha (${profile})`))
}

applyUserDataProfile()

// Custom schemes have to be declared before the app is ready; after that
// Electron has locked its scheme registry.
registerSchemes()

// Last-resort handlers that write a self-contained crash report before the
// process dies. Without them a throw inside a node-pty onData callback takes
// the whole app down leaving nothing behind to explain it.
process.on('uncaughtException', (err) => {
  writeCrashReport('main-uncaught-exception', { message: err?.message, stack: err?.stack })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : null
  writeCrashReport('main-unhandled-rejection', {
    message: err?.message ?? String(reason),
    stack: err?.stack
  })
})

// IPC handlers reach the window through this, never through a captured
// reference: they are registered before the window exists, and the window can
// be destroyed and recreated (macOS dock activate) under them.
const ipcCtx: IpcCtx = {
  win: () => win,
  send: (channel, ...args) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

function createWindow(): void {
  // The app draws its own title bar and owns Ctrl/Alt keybindings, so a native
  // (Alt-revealable) menu would both mismatch the chrome and steal chords.
  // macOS keeps its default global menu (needed for Cmd+Q/copy/paste roles).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'AI Detachment Alpha',
    backgroundColor: '#1c1c1f',
    // Custom title bar. On macOS hide the native chrome — which paints its own
    // mismatched grey bar — and let the app's title bar be the drag region; the
    // traffic lights stay, inset to sit centred in the slimmer header. Other
    // platforms drop the frame entirely and draw their own ─ ▢ ✕ controls.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 13, y: 12 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Panes keep streaming PTY output and deriving status while the window is
      // hidden or fully occluded; Chromium's intensive timer throttling would
      // otherwise stall those ticks minutes after the window leaves the screen.
      backgroundThrottling: false
    }
  })

  loadRenderer(win)
  guardWebContents(win)

  attachWindowEvents(win)

  win.on('closed', () => {
    win = null
    // The board's window is the main window's satellite: left open, it would
    // keep the app alive with nothing behind it to send a todo to.
    closeTodoWindow()
  })
}

// Two copies of the app would fight over the same userData files and the same
// PTYs. Second launches hand off to the running instance and quit.
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

void app.whenReady().then(() => {
  if (!gotInstanceLock) return
  log.info(`app starting — AI Detachment Alpha v${app.getVersion()}`)
  installProtocolHandlers()
  // Account housekeeping runs before any pane can exist: staging dirs a crash
  // mid-mint left behind are swept, and each account's shared pieces (skills,
  // settings, CLAUDE.md…) are relinked. Neither is worth failing a launch over.
  try {
    sweepOrphanedMintDirs()
  } catch (err) {
    log.warn(`mint dir sweep failed: ${String(err)}`)
  }
  try {
    reconcileAccountShares()
  } catch (err) {
    log.warn(`account share reconcile failed: ${String(err)}`)
  }
  // Registered once, before any window exists, so no renderer call can arrive
  // before its handler — and so a recreated window never double-registers.
  registerAllIpc(ipcCtx)
  createWindow()
  restoreTodoWindow()

  // macOS keeps the app alive after the last window closes; clicking the dock
  // icon has to be able to bring a window back.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
