import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import type {
  ArchiveEntry,
  PersistedState,
  RecentWorkspace,
  SavedLayout,
  Settings
} from '../../shared/types'
import { clearCliPathCache } from '../cliPath'
import { configureWsl, isWsl } from '../platform'
import {
  loadArchive,
  loadLayouts,
  loadRecents,
  loadSettings,
  loadState,
  saveArchive,
  saveLayouts,
  saveRecents,
  saveSettings,
  saveState
} from '../store'
import { normalizeArchivePaths, normalizeRecentPaths, normalizeStatePaths } from '../wslPaths'
import type { IpcCtx } from './index'
import { applyRelaySettings } from './relay'
import { applyRemoteSettings } from './remote'

/**
 * In WSL mode every stored folder must be its Linux path, or its panes never find
 * their transcripts and lose their sessions on restart (see wslPaths.ts). Applied
 * on load, which repairs files written before this existed, and on save, which
 * catches a Windows-form path however it got in. A file too malformed to walk is
 * passed through for the renderer's sanitizing to deal with.
 */
function inWslForm<T>(value: T, normalize: (value: T) => T): T {
  if (!isWsl() || value === null) return value
  try {
    return normalize(value)
  } catch {
    return value
  }
}

/** The relay link reconnects only when its own fields change, not on every save. */
function sameRelay(a: Settings['relay'], b: Settings['relay']): boolean {
  return a.enabled === b.enabled && a.url === b.url && a.name === b.name
}

export function registerStoreIpc(ctx: IpcCtx): void {
  // WSL mode decides where `.claude` lives and how panes spawn, and both are
  // read long before the renderer asks for settings — so the stored config is
  // applied here, at registration, not on first settings:get.
  configureWsl(loadSettings().wsl)

  ipcMain.handle(CH.stateLoad, () => {
    const state = loadState()
    return state && inWslForm(state, normalizeStatePaths)
  })
  ipcMain.handle(CH.stateSave, (_event, state: PersistedState) =>
    saveState(inWslForm(state, normalizeStatePaths))
  )

  ipcMain.handle(CH.archiveLoad, () => inWslForm(loadArchive(), normalizeArchivePaths))
  ipcMain.handle(CH.archiveSave, (_event, archive: ArchiveEntry[]) =>
    saveArchive(inWslForm(archive, normalizeArchivePaths))
  )

  ipcMain.handle(CH.recentsLoad, () => inWslForm(loadRecents(), normalizeRecentPaths))
  ipcMain.handle(CH.recentsSave, (_event, recents: RecentWorkspace[]) =>
    saveRecents(inWslForm(recents, normalizeRecentPaths))
  )

  ipcMain.handle(CH.layoutsLoad, () => loadLayouts())
  ipcMain.handle(CH.layoutsSave, (_event, layouts: SavedLayout[]) => saveLayouts(layouts))

  ipcMain.handle(CH.settingsGet, () => loadSettings())

  // One writer, one broadcast: main re-applies anything it derives from settings
  // (WSL mode) and then tells every renderer the merged truth, so no view is
  // left rendering the partial it happened to send.
  ipcMain.handle(CH.settingsSave, (_event, partial: Partial<Settings>): Settings => {
    const before = loadSettings()
    const merged = saveSettings(partial)
    configureWsl(merged.wsl)
    // The resolved CLI path is probed once per session and cached. Someone who
    // corrects a wrong path in Settings expects the next pane to use it, not to
    // have to relaunch the app.
    if (merged.cliPaths?.claude !== before.cliPaths?.claude) clearCliPathCache()
    if (!sameRelay(before.relay, merged.relay)) {
      applyRelaySettings(ctx, merged.relay)
      applyRemoteSettings(ctx, merged.relay)
    }
    ctx.send(CH.settingsChanged, merged)
    return merged
  })
}
