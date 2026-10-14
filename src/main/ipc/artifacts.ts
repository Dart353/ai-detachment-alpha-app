import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { listArtifacts } from '../artifacts'
import { log } from '../log'
import type { IpcCtx } from './index'

/** The Artifacts view's list: read on demand, never pushed. */
export function registerArtifactsIpc(_ctx: IpcCtx): void {
  ipcMain.handle(CH.artifactsList, async () => {
    try {
      return await listArtifacts()
    } catch (error) {
      log.warn('artifacts', 'scan failed', error)
      return []
    }
  })
}
