import { app, ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { HookWatcher, areBellHooksInstalled, installHooks } from '../hooks'
import type { IpcCtx } from './index'

/**
 * Claude Code hooks: the install/status pair the Settings panel drives, plus the
 * tailer that forwards each Stop/Notification/SubagentStop to the renderer as an
 * exact signal (its fallback being the PTY-quiet heuristic).
 *
 * "Installed" asks only about the two alert hooks — see BELL_HOOK_EVENTS — so a
 * settings file predating SubagentStop never re-arms the heuristic.
 */
export function registerHooksIpc(ctx: IpcCtx): void {
  ipcMain.handle(CH.hooksInstalled, () => areBellHooksInstalled())
  ipcMain.handle(CH.hooksInstall, () => installHooks())

  const watcher = new HookWatcher((event) => {
    ctx.send(CH.hookEvent, event)
  })
  watcher.start()

  app.on('before-quit', () => watcher.dispose())
}
