import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { gitStatus } from '../git'
import type { IpcCtx } from './index'

// A null branch is what "not a repository" looks like, so the UI treats a folder
// git knows nothing about exactly as it treats a plain folder.
export function registerGitIpc(_ctx: IpcCtx): void {
  ipcMain.handle(CH.gitStatus, (_event, cwd: string) => gitStatus(cwd))
}
