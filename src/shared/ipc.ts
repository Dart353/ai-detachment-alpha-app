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
} from './types'

/**
 * The single source of truth for the main↔renderer contract.
 *
 * `CH` names every channel once so no string is ever typed twice, and `Api`
 * declares the surface the preload exposes on `window.api`. The preload
 * implements `Api` and nothing else; main registers a handler for every channel
 * in `CH`. Anything missing on either side is a type error or a test failure
 * (see ipc.test.ts), never a silent no-op at runtime.
 */
export const CH = {
  // window controls
  winMinimize: 'win:minimize',
  winToggleMaximize: 'win:toggleMaximize',
  winClose: 'win:close',
  winMaximized: 'win:maximized',

  // persistence + settings
  stateLoad: 'state:load',
  stateSave: 'state:save',
  archiveLoad: 'archive:load',
  archiveSave: 'archive:save',
  recentsLoad: 'recents:load',
  recentsSave: 'recents:save',
  layoutsLoad: 'layouts:load',
  layoutsSave: 'layouts:save',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsChanged: 'settings:changed',

  // pseudo-terminals
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyPause: 'pty:pause',
  ptyResume: 'pty:resume',
  ptyCwd: 'pty:cwd',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',

  // Claude session transcripts
  sessionRegister: 'session:register',
  sessionUnregister: 'session:unregister',
  sessionTranscriptExists: 'session:transcriptExists',
  sessionUpdate: 'session:update',

  // Claude Code hooks
  hooksInstalled: 'hooks:installed',
  hooksInstall: 'hooks:install',
  hookEvent: 'hooks:event',

  // filesystem + explorer
  fsPickDir: 'fs:pickDir',
  fsHomeDir: 'fs:homeDir',
  fsReadDir: 'fs:readDir',
  fsReadFile: 'fs:readFile',
  fsWatchDir: 'fs:watchDir',
  fsUnwatchDir: 'fs:unwatchDir',
  fsRename: 'fs:rename',
  fsCreateFile: 'fs:createFile',
  fsCreateDir: 'fs:createDir',
  fsMove: 'fs:move',
  fsTrash: 'fs:trash',
  fsChanged: 'fs:changed',

  // ssh + git
  sshHosts: 'ssh:hosts',
  gitStatus: 'git:status',

  // usage meters
  usageGet: 'usage:get',
  usageUpdate: 'usage:update',

  // Claude accounts
  accountsList: 'accounts:list',
  accountsAdd: 'accounts:add',
  accountsRemove: 'accounts:remove',
  accountsBeginMint: 'accounts:beginMint',
  accountsCompleteMint: 'accounts:completeMint',
  accountsCancelMint: 'accounts:cancelMint',
  accountsChanged: 'accounts:changed',
  accountsMintDone: 'accounts:mintDone',

  // remote (the relay a phone watches this machine through)
  relayStatus: 'relay:status',
  relayKey: 'relay:key',
  relayRotateKey: 'relay:rotateKey',
  relayPublish: 'relay:publish',
  relayChanged: 'relay:changed',
  relayCommand: 'relay:command',
  relayDisconnectViewer: 'relay:disconnectViewer',

  // updates (GitHub releases, via electron-updater)
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateChanged: 'update:changed',

  // misc host services
  copyText: 'misc:copyText',
  revealPath: 'misc:revealPath',
  openExternal: 'misc:openExternal',
  wslDistros: 'misc:wslDistros',
  cliProbe: 'misc:cliProbe',
  notificationShow: 'notification:show',
  notificationClick: 'notification:click',
  revealLogs: 'misc:revealLogs',
  appVersion: 'misc:appVersion'
} as const

/** Drop an event subscription. Every `on*` returns one. */
export type Unsubscribe = () => void

export interface Api {
  /** Baked in at preload time; the renderer branches its chrome on it. */
  platform: NodeJS.Platform

  /* === window === */
  winMinimize(): void
  winToggleMaximize(): void
  winClose(): void
  onWinMaximized(cb: (maximized: boolean) => void): Unsubscribe

  /* === persistence + settings === */
  loadState(): Promise<PersistedState | null>
  saveState(state: PersistedState): Promise<void>
  loadArchive(): Promise<ArchiveEntry[]>
  saveArchive(archive: ArchiveEntry[]): Promise<void>
  loadRecents(): Promise<RecentWorkspace[]>
  saveRecents(recents: RecentWorkspace[]): Promise<void>
  loadLayouts(): Promise<SavedLayout[]>
  saveLayouts(layouts: SavedLayout[]): Promise<void>
  getSettings(): Promise<Settings>
  /** Merges `partial` into the stored settings and resolves the merged result. */
  saveSettings(partial: Partial<Settings>): Promise<Settings>
  onSettingsChanged(cb: (settings: Settings) => void): Unsubscribe

  /* === pty === */
  spawnPty(opts: SpawnOpts): Promise<boolean>
  writePty(id: string, data: string): void
  resizePty(id: string, cols: number, rows: number): void
  killPty(id: string): void
  /** Stop forwarding output (the pane is hidden); the process keeps running. */
  pausePty(id: string): void
  resumePty(id: string): void
  ptyCwd(id: string): Promise<string | null>
  onPtyData(cb: (event: PtyDataEvent) => void): Unsubscribe
  onPtyExit(cb: (event: PtyExitEvent) => void): Unsubscribe

  /* === Claude session transcripts === */
  registerSession(reg: PaneReg): void
  unregisterSession(id: string): void
  transcriptExists(cwd: string, sessionId: string, accountId?: string): Promise<boolean>
  onSessionUpdate(cb: (updates: SessionInfo[]) => void): Unsubscribe

  /* === Claude Code hooks === */
  hooksInstalled(): Promise<boolean>
  installHooks(): Promise<{ ok: true; alreadyInstalled: boolean } | { ok: false; error: string }>
  onHookEvent(cb: (event: HookEvent) => void): Unsubscribe

  /* === filesystem + explorer === */
  pickDir(): Promise<string | null>
  homeDir(): Promise<string>
  readDir(dir: string): Promise<FileTreeEntry[]>
  readFile(path: string): Promise<FileReadResult>
  /** Watch `dir` for this subscriber id; watchers are refcounted in main. */
  watchDir(id: string, dir: string): void
  unwatchDir(id: string, dir: string): void
  renamePath(oldPath: string, newName: string): Promise<FileOpResult>
  createFile(parentDir: string, name: string): Promise<FileOpResult>
  createDir(parentDir: string, name: string): Promise<FileOpResult>
  movePath(srcPath: string, destDir: string): Promise<FileOpResult>
  trashPath(path: string): Promise<FileOpResult>
  onFsChanged(cb: (dir: string) => void): Unsubscribe
  /**
   * A dropped File carries no path in a sandboxed renderer, so the renderer
   * asks the preload (webUtils) to translate the handle for it.
   */
  getDroppedFilePath(file: File): string

  /* === ssh + git === */
  sshHosts(): Promise<string[]>
  gitStatus(cwd: string): Promise<GitStatus>

  /* === usage meters === */
  getUsage(force?: boolean): Promise<UsageSnapshot>
  onUsage(cb: (usage: UsageSnapshot) => void): Unsubscribe

  /* === Claude accounts === */
  listAccounts(): Promise<ClaudeAccount[]>
  addAccount(
    input: AddAccountInput
  ): Promise<{ ok: true; account: ClaudeAccount } | { ok: false; error: string }>
  removeAccount(id: string): Promise<boolean>
  /** Start a `claude setup-token` PTY; `replaceAccountId` re-mints an account. */
  beginMint(label: string, replaceAccountId?: string): Promise<PendingMint | { error: string }>
  completeMint(
    ptyId: string,
    token: string
  ): Promise<{ ok: true; account: ClaudeAccount } | { ok: false; error: string }>
  cancelMint(ptyId: string): Promise<void>
  onAccountsChanged(cb: (accounts: ClaudeAccount[]) => void): Unsubscribe
  onMintDone(
    cb: (event: { ptyId: string; ok: boolean; account?: ClaudeAccount; error?: string }) => void
  ): Unsubscribe

  /* === remote === */
  relayStatus(): Promise<RelayStatus>
  /** The pairing key the phone needs. Shown in Settings, nowhere else. */
  relayKey(): Promise<string>
  /** Mint a new key; every paired phone has to pair again. */
  rotateRelayKey(): Promise<string>
  /** The renderer's latest view of every pane, for main to push to the relay. */
  publishRelaySnapshot(snapshot: HostSnapshot): void
  onRelayChanged(cb: (status: RelayStatus) => void): Unsubscribe
  /** A phone asked for a pane or a workspace; the renderer carries it out. */
  onRelayCommand(cb: (command: RelayCommand) => void): Unsubscribe
  /** Drop one phone; it forgets this machine's key. Rotate the key to revoke a phone you cannot reach. */
  disconnectRelayViewer(viewerId: string): void

  /* === updates === */
  /** The status main already holds; no network call. */
  getUpdateStatus(): Promise<UpdateStatus>
  /** Ask GitHub now. Resolves with the status the check produced. */
  checkForUpdate(): Promise<UpdateStatus>
  /** Quit and install a downloaded update. Only meaningful when `ready`. */
  installUpdate(): void
  onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe

  /* === misc host services === */
  copyText(text: string): void
  revealPath(path: string): Promise<void>
  openExternal(url: string): void
  wslDistros(): Promise<string[]>
  cliProbe(candidate?: string): Promise<CliProbe>
  showNotification(notification: AppNotification): void
  onNotificationClick(cb: (paneId: string | undefined) => void): Unsubscribe
  revealLogs(): Promise<void>
  appVersion(): Promise<string>
}

/**
 * Every key of `Api`, spelled out. Written as a `Record<keyof Api, true>` so
 * TypeScript itself enforces completeness: adding a member to `Api` without
 * listing it here fails the typecheck.
 */
const API_KEY_RECORD: Record<keyof Api, true> = {
  platform: true,
  winMinimize: true,
  winToggleMaximize: true,
  winClose: true,
  onWinMaximized: true,
  loadState: true,
  saveState: true,
  loadArchive: true,
  saveArchive: true,
  loadRecents: true,
  saveRecents: true,
  loadLayouts: true,
  saveLayouts: true,
  getSettings: true,
  saveSettings: true,
  onSettingsChanged: true,
  spawnPty: true,
  writePty: true,
  resizePty: true,
  killPty: true,
  pausePty: true,
  resumePty: true,
  ptyCwd: true,
  onPtyData: true,
  onPtyExit: true,
  registerSession: true,
  unregisterSession: true,
  transcriptExists: true,
  onSessionUpdate: true,
  hooksInstalled: true,
  installHooks: true,
  onHookEvent: true,
  pickDir: true,
  homeDir: true,
  readDir: true,
  readFile: true,
  watchDir: true,
  unwatchDir: true,
  renamePath: true,
  createFile: true,
  createDir: true,
  movePath: true,
  trashPath: true,
  onFsChanged: true,
  getDroppedFilePath: true,
  sshHosts: true,
  gitStatus: true,
  getUsage: true,
  onUsage: true,
  listAccounts: true,
  addAccount: true,
  removeAccount: true,
  beginMint: true,
  completeMint: true,
  cancelMint: true,
  onAccountsChanged: true,
  onMintDone: true,
  relayStatus: true,
  relayKey: true,
  rotateRelayKey: true,
  publishRelaySnapshot: true,
  onRelayChanged: true,
  onRelayCommand: true,
  disconnectRelayViewer: true,
  getUpdateStatus: true,
  checkForUpdate: true,
  installUpdate: true,
  onUpdateStatus: true,
  copyText: true,
  revealPath: true,
  openExternal: true,
  wslDistros: true,
  cliProbe: true,
  showNotification: true,
  onNotificationClick: true,
  revealLogs: true,
  appVersion: true
}

export const API_KEYS: readonly (keyof Api)[] = Object.keys(API_KEY_RECORD) as (keyof Api)[]
