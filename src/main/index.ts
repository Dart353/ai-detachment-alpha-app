import { app, BrowserWindow, Menu, shell } from 'electron'
import path from 'node:path'
import { reconcileAccountShares } from './accounts'
import { sweepOrphanedMintDirs } from './accountMint'
import { registerAllIpc, type IpcCtx } from './ipc'
import { attachWindowEvents } from './ipc/window'
import { log, writeCrashReport } from './log'
import { installProtocolHandlers, registerSchemes } from './protocol'

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

  // The e2e smoke test drives the app through the renderer's own stores, and
  // `?e2e=1` is what asks the renderer to expose them. It rides on
  // ADA_USER_DATA, so the flag can only ever appear in a throwaway profile.
  const e2e = !!process.env['ADA_USER_DATA']
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (e2e) url.searchParams.set('e2e', '1')
    void win.loadURL(url.toString())
  } else {
    const file = path.join(__dirname, '../renderer/index.html')
    void win.loadFile(file, e2e ? { query: { e2e: '1' } } : {})
  }

  // Nothing in the app is meant to spawn a child window. Left unhandled, any
  // window.open — xterm's OSC 8 default, a stray target=_blank — gets Electron's
  // default answer: a new BrowserWindow with no address bar and no way to
  // navigate. Deny the popup and hand the URL to the OS browser instead.
  const webContents = win.webContents
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Same reasoning for top-level navigation: following an external link in place
  // would replace the app with a web page, and this window has no chrome to get
  // back from it. Same-origin navigation still passes so the dev server's
  // reloads keep working.
  webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === new URL(webContents.getURL()).origin) return
    } catch {
      /* unparsable current or target URL — fall through to the guard */
    }
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // A renderer crash blanks the window with no dialog and no console left to
  // read; the report is the only trace of why.
  webContents.on('render-process-gone', (_event, details) => {
    writeCrashReport('render-process-gone', details)
  })

  attachWindowEvents(win)

  win.on('closed', () => {
    win = null
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

  // macOS keeps the app alive after the last window closes; clicking the dock
  // icon has to be able to bring a window back.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
