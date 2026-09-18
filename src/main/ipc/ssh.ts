import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { sshHosts } from '../ssh'
import type { IpcCtx } from './index'

export function registerSshIpc(_ctx: IpcCtx): void {
  // Re-read every time: the user may edit ~/.ssh/config while the app is running.
  ipcMain.handle(CH.sshHosts, () => sshHosts())
}
