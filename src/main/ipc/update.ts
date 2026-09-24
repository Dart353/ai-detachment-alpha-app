import { app, ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import type { UpdateStatus } from '../../shared/types'
import {
  checkForUpdate,
  getUpdateStatus,
  installUpdate,
  onUpdateStatus,
  scheduleStartupCheck
} from '../updater'
import type { IpcCtx } from './index'

/**
 * The update channels. Main owns the whole cycle — checking, downloading, and
 * the swap on quit — and the renderer only reads a status and presses two
 * buttons, so nothing here takes a version or a URL from the renderer.
 */
export function registerUpdateIpc(ctx: IpcCtx): void {
  onUpdateStatus((status: UpdateStatus) => ctx.send(CH.updateChanged, status))

  const startupTimer = scheduleStartupCheck()

  ipcMain.handle(CH.updateGet, (): UpdateStatus => getUpdateStatus())
  ipcMain.handle(CH.updateCheck, (): Promise<UpdateStatus> => checkForUpdate())
  ipcMain.on(CH.updateInstall, () => installUpdate())

  app.on('before-quit', () => {
    if (startupTimer) clearTimeout(startupTimer)
    onUpdateStatus(null)
  })
}
