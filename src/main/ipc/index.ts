import type { BrowserWindow } from 'electron'
import { registerWindowIpc } from './window'
import { registerStoreIpc } from './store'
import { registerPtyIpc } from './pty'
import { registerSessionsIpc } from './sessions'
import { registerHooksIpc } from './hooks'
import { registerFsIpc } from './fs'
import { registerSshIpc } from './ssh'
import { registerGitIpc } from './git'
import { registerUsageIpc } from './usage'
import { registerAccountsIpc } from './accounts'
import { registerMiscIpc } from './misc'

/**
 * What every IPC area gets instead of a module-level reference to the window.
 *
 * Handlers are registered once, at startup, but the window they talk to is
 * created after them and can be destroyed and recreated (macOS dock activate).
 * Asking for it through `win()` at call time keeps the areas free of that
 * lifecycle, and `send` is the one safe way to push an event: it silently does
 * nothing when there is no live window rather than throwing into a listener.
 */
export interface IpcCtx {
  win(): BrowserWindow | null
  send(channel: string, ...args: unknown[]): void
}

/**
 * Register every channel in the contract. Called exactly once, before the
 * window exists, so no renderer call can ever arrive before its handler.
 */
export function registerAllIpc(ctx: IpcCtx): void {
  registerWindowIpc(ctx)
  registerStoreIpc(ctx)
  registerPtyIpc(ctx)
  registerSessionsIpc(ctx)
  registerHooksIpc(ctx)
  registerFsIpc(ctx)
  registerSshIpc(ctx)
  registerGitIpc(ctx)
  registerUsageIpc(ctx)
  registerAccountsIpc(ctx)
  registerMiscIpc(ctx)
}
