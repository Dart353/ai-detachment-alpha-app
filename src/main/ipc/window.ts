import { ipcMain, type BrowserWindow } from 'electron'
import { CH } from '../../shared/ipc'
import type { IpcCtx } from './index'

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
}

/**
 * Keep the title bar's maximize glyph honest.
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
}
