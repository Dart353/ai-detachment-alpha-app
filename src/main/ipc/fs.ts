import { app, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { CH } from '../../shared/ipc'
import type { FileOpResult } from '../../shared/types'
import {
  createDir,
  createFile,
  FileTreeWatcher,
  movePath,
  readDir,
  readFile,
  renamePath
} from '../fileTree'
import { homeDir, toHost, toStored } from '../platform'
import type { IpcCtx } from './index'

/**
 * The explorer's IPC surface. Every path crosses this boundary in *stored* form
 * (Linux, in WSL mode): `fileTree` translates to a host path at the disk touch,
 * and the two handlers that talk to Electron directly (the picker, trash) do that
 * translation themselves.
 */
export function registerFsIpc(ctx: IpcCtx): void {
  // One watcher for the whole app: it refcounts subscribers per directory itself,
  // so several panes expanding the same folder still cost a single `fs.watch`.
  const watcher = new FileTreeWatcher((dir) => ctx.send(CH.fsChanged, dir))
  app.on('before-quit', () => watcher.dispose())

  ipcMain.handle(CH.fsPickDir, async () => {
    const win = ctx.win()
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    // Attached to the window so macOS shows it as a sheet; free-floating is the
    // only choice in the window-less moment after the last window closed.
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null
    // The picker answers with a host path; the rest of the app speaks stored form.
    return toStored(picked)
  })

  ipcMain.handle(CH.fsHomeDir, () => homeDir())
  ipcMain.handle(CH.fsReadDir, (_event, dir: string) => readDir(dir))
  ipcMain.handle(CH.fsReadFile, (_event, filePath: string) => readFile(filePath))

  ipcMain.on(CH.fsWatchDir, (_event, id: string, dir: string) => watcher.watch(id, dir))
  ipcMain.on(CH.fsUnwatchDir, (_event, id: string, dir: string) => watcher.unwatch(id, dir))

  ipcMain.handle(CH.fsRename, (_event, oldPath: string, newName: string) =>
    renamePath(oldPath, newName)
  )
  ipcMain.handle(CH.fsCreateFile, (_event, parentDir: string, name: string) =>
    createFile(parentDir, name)
  )
  ipcMain.handle(CH.fsCreateDir, (_event, parentDir: string, name: string) =>
    createDir(parentDir, name)
  )
  ipcMain.handle(CH.fsMove, (_event, srcPath: string, destDir: string) =>
    movePath(srcPath, destDir)
  )

  // Trash is the one file op that needs Electron, which is why it lives here
  // rather than in the deliberately Electron-free fileTree module. It throws on
  // failure; the renderer expects the same plain result every other op returns.
  ipcMain.handle(CH.fsTrash, async (_event, filePath: string): Promise<FileOpResult> => {
    try {
      await shell.trashItem(toHost(filePath))
      return { ok: true }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })
}
