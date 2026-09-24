import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CH, type Api, type Unsubscribe } from '../shared/ipc'
import type {
  AddAccountInput,
  AppNotification,
  ArchiveEntry,
  ClaudeAccount,
  CliProbe,
  FileOpResult,
  FileReadResult,
  FileTreeEntry,
  GitStatus,
  HookEvent,
  HostSnapshot,
  PaneReg,
  PendingMint,
  PersistedState,
  PtyDataEvent,
  PtyExitEvent,
  RecentWorkspace,
  RelayCommand,
  RelayStatus,
  SavedLayout,
  SessionInfo,
  Settings,
  SpawnOpts,
  UpdateStatus,
  UsageSnapshot
} from '../shared/types'

/**
 * Subscribe to a main→renderer event and hand back the unsubscribe.
 *
 * Every listener the renderer registers belongs to a component that will
 * unmount, so `on*` never returns void: without the disposer the only way to
 * detach would be `removeAllListeners`, which would tear down the listeners
 * other components still hold on the same channel.
 */
function sub<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

// The renderer never gets Node or the raw ipcRenderer; everything it may call
// lives on this one object, which implements the shared `Api` contract exactly.
const api: Api = {
  platform: process.platform,

  /* === window === */
  winMinimize: () => ipcRenderer.send(CH.winMinimize),
  winToggleMaximize: () => ipcRenderer.send(CH.winToggleMaximize),
  winClose: () => ipcRenderer.send(CH.winClose),
  onWinMaximized: (cb: (maximized: boolean) => void) => sub<boolean>(CH.winMaximized, cb),

  /* === persistence + settings === */
  loadState: () => ipcRenderer.invoke(CH.stateLoad) as Promise<PersistedState | null>,
  saveState: (state: PersistedState) => ipcRenderer.invoke(CH.stateSave, state) as Promise<void>,
  loadArchive: () => ipcRenderer.invoke(CH.archiveLoad) as Promise<ArchiveEntry[]>,
  saveArchive: (archive: ArchiveEntry[]) =>
    ipcRenderer.invoke(CH.archiveSave, archive) as Promise<void>,
  loadRecents: () => ipcRenderer.invoke(CH.recentsLoad) as Promise<RecentWorkspace[]>,
  saveRecents: (recents: RecentWorkspace[]) =>
    ipcRenderer.invoke(CH.recentsSave, recents) as Promise<void>,
  loadLayouts: () => ipcRenderer.invoke(CH.layoutsLoad) as Promise<SavedLayout[]>,
  saveLayouts: (layouts: SavedLayout[]) =>
    ipcRenderer.invoke(CH.layoutsSave, layouts) as Promise<void>,
  getSettings: () => ipcRenderer.invoke(CH.settingsGet) as Promise<Settings>,
  saveSettings: (partial: Partial<Settings>) =>
    ipcRenderer.invoke(CH.settingsSave, partial) as Promise<Settings>,
  onSettingsChanged: (cb: (settings: Settings) => void) => sub<Settings>(CH.settingsChanged, cb),

  /* === pty === */
  spawnPty: (opts: SpawnOpts) => ipcRenderer.invoke(CH.ptySpawn, opts) as Promise<boolean>,
  writePty: (id: string, data: string) => ipcRenderer.send(CH.ptyWrite, { id, data }),
  resizePty: (id: string, cols: number, rows: number) =>
    ipcRenderer.send(CH.ptyResize, { id, cols, rows }),
  killPty: (id: string) => ipcRenderer.send(CH.ptyKill, { id }),
  pausePty: (id: string) => ipcRenderer.send(CH.ptyPause, { id }),
  resumePty: (id: string) => ipcRenderer.send(CH.ptyResume, { id }),
  ptyCwd: (id: string) => ipcRenderer.invoke(CH.ptyCwd, { id }) as Promise<string | null>,
  onPtyData: (cb: (event: PtyDataEvent) => void) => sub<PtyDataEvent>(CH.ptyData, cb),
  onPtyExit: (cb: (event: PtyExitEvent) => void) => sub<PtyExitEvent>(CH.ptyExit, cb),

  /* === Claude session transcripts === */
  registerSession: (reg: PaneReg) => ipcRenderer.send(CH.sessionRegister, reg),
  unregisterSession: (id: string) => ipcRenderer.send(CH.sessionUnregister, { id }),
  transcriptExists: (cwd: string, sessionId: string, accountId?: string) =>
    ipcRenderer.invoke(CH.sessionTranscriptExists, {
      cwd,
      sessionId,
      accountId
    }) as Promise<boolean>,
  onSessionUpdate: (cb: (updates: SessionInfo[]) => void) =>
    sub<SessionInfo[]>(CH.sessionUpdate, cb),

  /* === Claude Code hooks === */
  hooksInstalled: () => ipcRenderer.invoke(CH.hooksInstalled) as Promise<boolean>,
  installHooks: () =>
    ipcRenderer.invoke(CH.hooksInstall) as Promise<
      { ok: true; alreadyInstalled: boolean } | { ok: false; error: string }
    >,
  onHookEvent: (cb: (event: HookEvent) => void) => sub<HookEvent>(CH.hookEvent, cb),

  /* === filesystem + explorer === */
  pickDir: () => ipcRenderer.invoke(CH.fsPickDir) as Promise<string | null>,
  homeDir: () => ipcRenderer.invoke(CH.fsHomeDir) as Promise<string>,
  readDir: (dir: string) => ipcRenderer.invoke(CH.fsReadDir, dir) as Promise<FileTreeEntry[]>,
  readFile: (path: string) => ipcRenderer.invoke(CH.fsReadFile, path) as Promise<FileReadResult>,
  watchDir: (id: string, dir: string) => ipcRenderer.send(CH.fsWatchDir, { id, dir }),
  unwatchDir: (id: string, dir: string) => ipcRenderer.send(CH.fsUnwatchDir, { id, dir }),
  renamePath: (oldPath: string, newName: string) =>
    ipcRenderer.invoke(CH.fsRename, { oldPath, newName }) as Promise<FileOpResult>,
  createFile: (parentDir: string, name: string) =>
    ipcRenderer.invoke(CH.fsCreateFile, { parentDir, name }) as Promise<FileOpResult>,
  createDir: (parentDir: string, name: string) =>
    ipcRenderer.invoke(CH.fsCreateDir, { parentDir, name }) as Promise<FileOpResult>,
  movePath: (srcPath: string, destDir: string) =>
    ipcRenderer.invoke(CH.fsMove, { srcPath, destDir }) as Promise<FileOpResult>,
  trashPath: (path: string) => ipcRenderer.invoke(CH.fsTrash, path) as Promise<FileOpResult>,
  onFsChanged: (cb: (dir: string) => void) => sub<string>(CH.fsChanged, cb),
  getDroppedFilePath: (file: File): string => webUtils.getPathForFile(file),

  /* === ssh + git === */
  sshHosts: () => ipcRenderer.invoke(CH.sshHosts) as Promise<string[]>,
  gitStatus: (cwd: string) => ipcRenderer.invoke(CH.gitStatus, cwd) as Promise<GitStatus>,

  /* === usage meters === */
  getUsage: (force?: boolean) => ipcRenderer.invoke(CH.usageGet, force) as Promise<UsageSnapshot>,
  onUsage: (cb: (usage: UsageSnapshot) => void) => sub<UsageSnapshot>(CH.usageUpdate, cb),

  /* === Claude accounts === */
  listAccounts: () => ipcRenderer.invoke(CH.accountsList) as Promise<ClaudeAccount[]>,
  addAccount: (input: AddAccountInput) =>
    ipcRenderer.invoke(CH.accountsAdd, input) as Promise<
      { ok: true; account: ClaudeAccount } | { ok: false; error: string }
    >,
  removeAccount: (id: string) => ipcRenderer.invoke(CH.accountsRemove, id) as Promise<boolean>,
  beginMint: (label: string, replaceAccountId?: string) =>
    ipcRenderer.invoke(CH.accountsBeginMint, { label, replaceAccountId }) as Promise<
      PendingMint | { error: string }
    >,
  completeMint: (ptyId: string, token: string) =>
    ipcRenderer.invoke(CH.accountsCompleteMint, { ptyId, token }) as Promise<
      { ok: true; account: ClaudeAccount } | { ok: false; error: string }
    >,
  cancelMint: (ptyId: string) => ipcRenderer.invoke(CH.accountsCancelMint, ptyId) as Promise<void>,
  onAccountsChanged: (cb: (accounts: ClaudeAccount[]) => void) =>
    sub<ClaudeAccount[]>(CH.accountsChanged, cb),
  onMintDone: (
    cb: (event: { ptyId: string; ok: boolean; account?: ClaudeAccount; error?: string }) => void
  ) =>
    sub<{ ptyId: string; ok: boolean; account?: ClaudeAccount; error?: string }>(
      CH.accountsMintDone,
      cb
    ),

  /* === remote === */
  relayStatus: () => ipcRenderer.invoke(CH.relayStatus) as Promise<RelayStatus>,
  relayKey: () => ipcRenderer.invoke(CH.relayKey) as Promise<string>,
  rotateRelayKey: () => ipcRenderer.invoke(CH.relayRotateKey) as Promise<string>,
  publishRelaySnapshot: (snapshot: HostSnapshot) => ipcRenderer.send(CH.relayPublish, snapshot),
  onRelayChanged: (cb: (status: RelayStatus) => void) => sub<RelayStatus>(CH.relayChanged, cb),
  onRelayCommand: (cb: (command: RelayCommand) => void) => sub<RelayCommand>(CH.relayCommand, cb),
  disconnectRelayViewer: (viewerId: string) => ipcRenderer.send(CH.relayDisconnectViewer, viewerId),

  /* === updates === */
  getUpdateStatus: () => ipcRenderer.invoke(CH.updateGet) as Promise<UpdateStatus>,
  checkForUpdate: () => ipcRenderer.invoke(CH.updateCheck) as Promise<UpdateStatus>,
  installUpdate: () => ipcRenderer.send(CH.updateInstall),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => sub<UpdateStatus>(CH.updateChanged, cb),

  /* === misc host services === */
  copyText: (text: string) => ipcRenderer.send(CH.copyText, text),
  revealPath: (path: string) => ipcRenderer.invoke(CH.revealPath, path) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.send(CH.openExternal, url),
  wslDistros: () => ipcRenderer.invoke(CH.wslDistros) as Promise<string[]>,
  cliProbe: (candidate?: string) => ipcRenderer.invoke(CH.cliProbe, candidate) as Promise<CliProbe>,
  showNotification: (notification: AppNotification) =>
    ipcRenderer.send(CH.notificationShow, notification),
  onNotificationClick: (cb: (paneId: string | undefined) => void) =>
    sub<string | undefined>(CH.notificationClick, cb),
  revealLogs: () => ipcRenderer.invoke(CH.revealLogs) as Promise<void>,
  appVersion: () => ipcRenderer.invoke(CH.appVersion) as Promise<string>
}

contextBridge.exposeInMainWorld('api', api)
