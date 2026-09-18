import { app, ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import type { PaneReg } from '../../shared/types'
import { SessionWatcher, transcriptExists } from '../sessionWatcher'
import type { IpcCtx } from './index'

/**
 * One watcher for the whole app: it polls every registered pane's transcript and
 * pushes a batch of SessionInfo to the renderer, which blends it with PTY activity.
 */
export function registerSessionsIpc(ctx: IpcCtx): void {
  const watcher = new SessionWatcher((updates) => {
    ctx.send(CH.sessionUpdate, updates)
  })

  ipcMain.on(CH.sessionRegister, (_event, reg: PaneReg) => {
    watcher.register(reg)
  })
  ipcMain.on(CH.sessionUnregister, (_event, { id }: { id: string }) => {
    watcher.unregister(id)
  })
  // does a resumable transcript still exist for this cwd + session id?
  ipcMain.handle(
    CH.sessionTranscriptExists,
    (
      _event,
      { cwd, sessionId, accountId }: { cwd: string; sessionId: string; accountId?: string }
    ) => transcriptExists(cwd, sessionId, accountId)
  )

  app.on('before-quit', () => watcher.dispose())
}
