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
import { configureWsl } from '../platform'
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
import type { IpcCtx } from './index'
import { applyRelaySettings } from './relay'

/** The relay link reconnects only when its own fields change, not on every save. */
function sameRelay(a: Settings['relay'], b: Settings['relay']): boolean {
  return a.enabled === b.enabled && a.url === b.url && a.name === b.name
}

export function registerStoreIpc(ctx: IpcCtx): void {
  // WSL mode decides where `.claude` lives and how panes spawn, and both are
  // read long before the renderer asks for settings — so the stored config is
  // applied here, at registration, not on first settings:get.
  configureWsl(loadSettings().wsl)

  ipcMain.handle(CH.stateLoad, () => loadState())
  ipcMain.handle(CH.stateSave, (_event, state: PersistedState) => saveState(state))

  ipcMain.handle(CH.archiveLoad, () => loadArchive())
  ipcMain.handle(CH.archiveSave, (_event, archive: ArchiveEntry[]) => saveArchive(archive))

  ipcMain.handle(CH.recentsLoad, () => loadRecents())
  ipcMain.handle(CH.recentsSave, (_event, recents: RecentWorkspace[]) => saveRecents(recents))

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
    if (!sameRelay(before.relay, merged.relay)) applyRelaySettings(ctx, merged.relay)
    ctx.send(CH.settingsChanged, merged)
    return merged
  })
}
