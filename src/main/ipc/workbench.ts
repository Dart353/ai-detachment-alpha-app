import { app, ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { log } from '../log'
import { setupWorkbench, WorkbenchWatcher, workbenchState } from '../workbench'
import type { IpcCtx } from './index'

/**
 * The workbench: setup on request, and one watcher for the whole app that
 * pushes each workspace's page to the renderer as agents rewrite it.
 */
export function registerWorkbenchIpc(ctx: IpcCtx): void {
  const watcher = new WorkbenchWatcher((snapshot) => ctx.send(CH.workbenchChanged, snapshot))
  app.on('will-quit', () => watcher.dispose())

  ipcMain.handle(CH.workbenchState, (_event, rootDir: string) => workbenchState(rootDir))

  ipcMain.handle(
    CH.workbenchSetup,
    (_event, { rootDir, replaceModifiedRules }: { rootDir: string; replaceModifiedRules?: boolean }) => {
      const result = setupWorkbench(rootDir, { replaceModifiedRules })
      if (result.ok) watcher.refresh(rootDir)
      else log.warn('workbench', `setup failed in ${rootDir}`, result.error)
      return result
    }
  )

  ipcMain.on(CH.workbenchWatch, (_event, { id, rootDir }: { id: string; rootDir: string }) =>
    watcher.watch(id, rootDir)
  )
  ipcMain.on(CH.workbenchUnwatch, (_event, { id, rootDir }: { id: string; rootDir: string }) =>
    watcher.unwatch(id, rootDir)
  )
}
