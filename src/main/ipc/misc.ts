import { app, clipboard, ipcMain, Notification, shell } from 'electron'
import { CH } from '../../shared/ipc'
import type { AppNotification, CliProbe } from '../../shared/types'
import { probeCli } from '../cliPath'
import { logsDir } from '../log'
import { listDistros, toHost } from '../platform'
import type { IpcCtx } from './index'

/**
 * Only these schemes may be handed to the OS. The renderer can be persuaded to
 * open a link by anything it renders — terminal output, a transcript, a file —
 * so an allowlist is the boundary: `http(s)` because dev servers live there,
 * `figma:` because it opens the Figma desktop app.
 */
const EXTERNAL_SCHEMES = /^(?:https?|figma):\/\//i

export function registerMiscIpc(ctx: IpcCtx): void {
  ipcMain.on(CH.copyText, (_event, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  // The renderer holds stored (Linux, in WSL mode) paths; the file manager we
  // hand this to is the host's, and Explorer cannot open '/home/...'. Translate
  // the way every other path that leaves main does — without it the item is
  // silently never shown, since showItemInFolder reports nothing back.
  ipcMain.handle(CH.revealPath, (_event, path: string) => {
    if (typeof path === 'string' && path) shell.showItemInFolder(toHost(path))
  })

  ipcMain.on(CH.openExternal, (_event, url: string) => {
    if (typeof url !== 'string' || !EXTERNAL_SCHEMES.test(url)) return
    void shell.openExternal(url)
  })

  ipcMain.handle(CH.wslDistros, () => listDistros())

  // `candidate` is the unsaved Settings field, so Check tests what is on screen
  // rather than what was last saved.
  ipcMain.handle(
    CH.cliProbe,
    (_event, candidate?: string): Promise<CliProbe> =>
      probeCli(typeof candidate === 'string' ? candidate : undefined)
  )

  // OS banners come from main rather than the renderer's web Notification API:
  // a click has to raise and focus the window, which only main can do, and the
  // renderer is often hidden or occluded when a pane wants to speak up.
  ipcMain.on(CH.notificationShow, (_event, notification: AppNotification) => {
    if (!Notification.isSupported()) return
    const banner = new Notification({
      title: notification.title,
      body: notification.body,
      silent: notification.silent ?? false
    })
    banner.on('click', () => {
      const win = ctx.win()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      ctx.send(CH.notificationClick, notification.paneId)
    })
    banner.show()
  })

  // The logger owns the directory and creates it on first use — asking it,
  // rather than rebuilding the path here, keeps the two from drifting, and a
  // fresh install has no folder yet (openPath on a missing path silently does
  // nothing, which reads as a dead menu item).
  ipcMain.handle(CH.revealLogs, async () => {
    await shell.openPath(logsDir())
  })

  ipcMain.handle(CH.appVersion, () => app.getVersion())
}
