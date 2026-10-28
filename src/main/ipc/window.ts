import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { CH } from '../../shared/ipc'
import { log } from '../log'
import type { IpcCtx } from './index'

/**
 * How long a close waits for the renderer to answer before going ahead anyway.
 * The save it waits on is one small JSON write; this only matters when the
 * renderer is wedged, and then a window that will not close is worse than a
 * save that did not happen.
 */
const CLOSE_ANSWER_MS = 5000

/** One window's side of the close handshake. */
interface CloseGuard {
  /** The renderer has subscribed and will answer a close request. */
  listening: boolean
  /** A request is out; further close attempts wait on the same answer. */
  pending: boolean
  /** The renderer said go (or never answered): the next close goes through. */
  allowed: boolean
  timer: NodeJS.Timeout | null
}

const guards = new WeakMap<BrowserWindow, CloseGuard>()

function guardOf(win: BrowserWindow): CloseGuard {
  let guard = guards.get(win)
  if (!guard) {
    guard = { listening: false, pending: false, allowed: false, timer: null }
    guards.set(win, guard)
  }
  return guard
}

function clearTimer(guard: CloseGuard): void {
  if (guard.timer) clearTimeout(guard.timer)
  guard.timer = null
}

/** Let the window close for real. */
function release(win: BrowserWindow): void {
  const guard = guardOf(win)
  clearTimer(guard)
  guard.allowed = true
  if (!win.isDestroyed()) win.close()
}

function senderWindow(event: IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * The custom title bar's ─ ▢ ✕. The window is frameless (or has its native
 * chrome hidden on macOS), so these three are the only way to minimize,
 * maximize or close it.
 */
export function registerWindowIpc(ctx: IpcCtx): void {
  ipcMain.on(CH.winMinimize, () => ctx.win()?.minimize())

  ipcMain.on(CH.winToggleMaximize, () => {
    const win = ctx.win()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(CH.winClose, () => ctx.win()?.close())

  ipcMain.on(CH.winCloseReady, (event) => {
    const win = senderWindow(event)
    if (win) guardOf(win).listening = true
  })
  // The user is being asked whether to quit: no timeout while they decide.
  ipcMain.on(CH.winCloseHold, (event) => {
    const win = senderWindow(event)
    if (win) clearTimer(guardOf(win))
  })
  ipcMain.on(CH.winCloseProceed, (event) => {
    const win = senderWindow(event)
    if (win) release(win)
  })
  ipcMain.on(CH.winCloseCancel, (event) => {
    const win = senderWindow(event)
    if (!win) return
    const guard = guardOf(win)
    clearTimer(guard)
    guard.pending = false
  })
}

/**
 * Closing waits for the renderer. The ✕, Alt+F4, the OS shutting the window and a
 * quit all arrive here first; the renderer is asked, saves the workspaces (session
 * ids included — they are what lets every pane resume) and answers, and only then
 * does the window go. Without this the last save was a message sent from a page
 * already being torn down, with nothing waiting for it to land.
 *
 * A renderer that is not listening yet (still loading), has crashed, or does not
 * answer in time never holds the window open.
 */
function attachCloseGuard(win: BrowserWindow): void {
  const guard = guardOf(win)
  // A reload re-subscribes; until then nobody is there to answer.
  win.webContents.on('did-start-loading', () => {
    guard.listening = false
  })
  win.on('close', (event) => {
    if (guard.allowed || !guard.listening || win.webContents.isCrashed()) return
    event.preventDefault()
    if (guard.pending) return
    guard.pending = true
    win.webContents.send(CH.winCloseRequested)
    guard.timer = setTimeout(() => {
      log.warn('close: the renderer did not answer; closing without its final save')
      release(win)
    }, CLOSE_ANSWER_MS)
  })
}

/**
 * Keep the title bar's maximize glyph honest.
 * Also arms the close handshake (`attachCloseGuard`, above).
 *
 * The window can be maximized without the app asking — a double-clicked drag
 * region, a window-snap chord, the OS restoring a maximized session — so the
 * renderer cannot infer the state from its own clicks and is told instead.
 */
export function attachWindowEvents(win: BrowserWindow): void {
  const send = (maximized: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send(CH.winMaximized, maximized)
  }
  win.on('maximize', () => send(true))
  win.on('unmaximize', () => send(false))
  attachCloseGuard(win)
}
