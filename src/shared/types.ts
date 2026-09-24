/**
 * The data model shared by main, preload and renderer.
 *
 * Everything here crosses the IPC boundary, so every type is plain JSON —
 * no class instances, no Dates, no functions. Epoch milliseconds stand in
 * for timestamps throughout.
 */
import type { Effort } from './relayProtocol'

/** What a pane runs. `viewer` is a read-only file pane, not a process. */
export type PaneKind = 'claude' | 'terminal' | 'ssh' | 'viewer'

/**
 * Coarse pane state as the UI shows it.
 *   working   → the process is producing output / a turn is in flight
 *   attention → the agent asked a question and is waiting on the user
 *   idle      → alive and quiet
 *   done      → a turn ended while the pane was not focused; focusing clears it
 *   exited    → the process is gone
 */
export type PaneStatus = 'working' | 'attention' | 'idle' | 'done' | 'exited'

export interface Pane {
  id: string
  /** User-editable label shown in the sidebar and the pane header. */
  name: string
  kind: PaneKind
  cwd: string
  createdAt: number
  /** `ssh` panes only: the host alias from ~/.ssh/config. */
  sshHost?: string
  /** `viewer` panes only: the file being displayed. */
  filePath?: string
  /** `claude` panes only: the transcript this pane is bound to, once claimed. */
  sessionId?: string
  /** `claude` panes only: which Claude account credentials to run under. */
  accountId?: string
  /** `claude` panes only: spawn with plan mode enabled. */
  planMode?: boolean
  /** `claude` panes only: `--model`, an alias or id as the CLI takes it. */
  model?: string
  /** `claude` panes only: `--effort`. */
  effort?: Effort
  /** Optional accent colour for the pane header, chosen by the user. */
  color?: string
}

/** One tile of the layout. x/y/w/h are percentages of the canvas, 0–100. */
export interface Zone {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** The editor grid zones snap to while being drawn or resized. */
export interface ZoneSnap {
  cols: number
  rows: number
}

export interface ZoneLayout {
  v: 2
  snap: ZoneSnap
  zones: Zone[]
  /** paneId → zoneId. Panes with no entry are unplaced. */
  assign: Record<string, string>
}

export interface ExplorerState {
  open: boolean
  /** Panel width in CSS pixels. */
  width: number
  /** Absolute paths of the directories the tree currently has expanded. */
  expanded: string[]
}

export interface Workspace {
  id: string
  name: string
  rootDir: string
  layout: ZoneLayout
  panes: Pane[]
  explorer: ExplorerState
  focusedPaneId?: string
  maximizedPaneId?: string
  /** Sidebar tree node collapsed (hides this workspace's panes). */
  collapsed?: boolean
}

/** The whole app state as written to disk. `v` guards future migrations. */
export interface PersistedState {
  v: 1
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  sidebarCollapsed: boolean
}

/**
 * A closed workspace, kept so reopening the same folder can offer its old
 * panes back. Keyed by root directory, which is the identity of a workspace
 * as far as the user is concerned.
 */
export interface ArchiveEntry {
  key: string
  rootDir: string
  name: string
  archivedAt: number
  layout: ZoneLayout
  panes: Pane[]
  explorer: ExplorerState
}

export interface RecentWorkspace {
  rootDir: string
  name: string
  lastOpenedAt: number
}

/** A zone arrangement the user saved from the layout editor for reuse. */
export interface SavedLayout {
  id: string
  name: string
  zones: Zone[]
}

export interface Settings {
  termFontSize: number
  termFontFamily: string
  defaultPaneKind: 'claude' | 'terminal'
  /** Overrides the login shell for `terminal` panes when set. */
  shellPath?: string
  /** Windows only: run panes inside a WSL distro instead of on the host. */
  wsl: { enabled: boolean; distro?: string }
  /** Explicit CLI locations, for when the login shell cannot find them. */
  cliPaths: { claude?: string }
  /** Give full-screen TUIs the alternate screen buffer instead of scrollback. */
  fullscreenTui: boolean
  /** Reopening a folder restores its archived panes without asking. */
  restoreArchivesAutomatically: boolean
  /** Usage percentage at which the limit meter warns. */
  warnAtPct: number
  warnEnabled: boolean
  notifications: {
    muted: boolean
    attention: { banner: boolean; sound: boolean }
    done: { banner: boolean; sound: boolean }
  }
  /** Remote: push this machine's pane statuses to the relay a phone watches. */
  relay: RelaySettings
}

export interface RelaySettings {
  enabled: boolean
  /** The relay's origin, e.g. `https://ada.example.com`. */
  url: string
  /** How this machine is labelled on the phone; '' means the OS hostname. */
  name: string
}

export const DEFAULT_SETTINGS: Settings = {
  termFontSize: 12,
  termFontFamily: 'JetBrains Mono',
  defaultPaneKind: 'claude',
  wsl: { enabled: false },
  cliPaths: {},
  fullscreenTui: true,
  restoreArchivesAutomatically: false,
  warnAtPct: 80,
  warnEnabled: true,
  notifications: {
    muted: false,
    attention: { banner: true, sound: true },
    done: { banner: true, sound: true }
  },
  relay: { enabled: false, url: '', name: '' }
}

/* === Remote (the phone's view of this machine, via the relay) === */

/**
 * One pane as the phone shows it: the status pill and the transcript facts
 * around it. Nothing here identifies a file or a process — the renderer
 * publishes it, main relays it, and it goes over the network.
 */
export interface HostPane {
  id: string
  name: string
  kind: PaneKind
  /** The engine's verdict, plus `starting` for a fresh agent before its first prompt. */
  status: PaneStatus | 'starting'
  color?: string
  /** `claude` panes: the transcript's title, last prompt and model when known. */
  title: string | null
  lastPrompt: string | null
  model: string | null
  /** One line for the phone's list: what the agent is on, or what it wants. */
  summary: string | null
  /** epoch ms of the last PTY output, 0 if it never spoke */
  lastActivity: number
}

export interface HostWorkspace {
  id: string
  name: string
  rootDir: string
  panes: HostPane[]
}

/**
 * What the renderer hands main to publish; main stamps the machine on it and
 * it becomes the relay protocol's `Feed` (see `relayProtocol.ts`, whose
 * `FeedWorkspace`/`FeedPane` these match field for field).
 */
export interface HostSnapshot {
  workspaces: HostWorkspace[]
  /** Recent folders, most recent first, so the phone can open one. */
  recents: { name: string; rootDir: string }[]
  /** epoch ms the renderer built it */
  updatedAt: number
}

/**
 * Something a phone asked this machine to do, relayed by main to the renderer,
 * which owns the workspace tree and does it exactly as a click would.
 */
export type RelayCommand =
  | {
      type: 'addPane'
      workspaceId: string
      kind: 'claude' | 'terminal'
      name?: string
      model?: string
      effort?: Effort
      planMode?: boolean
    }
  | { type: 'openWorkspace'; rootDir: string }

/** One phone connected with this machine's key, as Settings lists it. */
export interface RelayViewer {
  /** The relay's id for the connection; changes on every reconnect. */
  id: string
  address: string
  userAgent: string
  /** epoch ms */
  connectedAt: number
  /** ids of the panes it has open */
  watching: string[]
}

/** What Settings shows about the relay link. */
export interface RelayStatus {
  /** 'off' while disabled; the rest follow the socket. */
  state: 'off' | 'connecting' | 'connected' | 'error'
  /** The relay's id for this machine: sha256(key). Never the key. */
  hostId: string | null
  /** How many phones are connected right now. */
  viewers: number
  /** The phones themselves, as the relay last reported them. */
  phones: RelayViewer[]
  /** The last refusal or transport error, for Settings to show. */
  error?: string
  /**
   * False when the OS keychain is unavailable: the key then lives in memory
   * for this launch only, and a phone pairs again after a relaunch.
   */
  keyPersisted: boolean
}

/* === Claude session transcripts === */

/** What the renderer tells main about a pane so its transcript can be found. */
export interface PaneReg {
  id: string
  cwd: string
  spawnedAt: number
  /** When resuming a chat, bind directly to this transcript instead of guessing. */
  sessionId?: string
  accountId?: string
}

/** Coarse hint from the transcript; the renderer blends this with PTY activity. */
export type JsonlStatus = 'pending-tool' | 'turn-idle' | 'unknown'

/**
 * Is the agent mid-turn? PTY bytes alone can't answer this: an idle Claude still
 * repaints its TUI (background-agent counters, footer hints, redraws), and every
 * one of those bytes used to read as "working". The transcript is definitive —
 * a Claude turn ends with an assistant message that carries prose and no
 * tool_use, and nothing else is written until the next prompt.
 *   open    → a turn is in flight (prompt sent / tool pending / results returning)
 *   ended   → the last turn closed; any PTY output since is cosmetic repaint
 *   unknown → no transcript, or the tail carries no usable message
 */
export type TurnState = 'open' | 'ended' | 'unknown'

export interface SessionInfo {
  paneId: string
  sessionId: string | null
  title: string | null
  lastPrompt: string | null
  model: string | null
  permissionMode: string | null
  gitBranch: string | null
  jsonlStatus: JsonlStatus
  /** whether a turn is in flight; gates the renderer's "attention" status */
  turnState: TurnState
  /** context size (input + cache read + cache creation tokens) of the last
   *  assistant turn with usage data; undefined when the tail carries none */
  contextTokens?: number
  /** context window (tokens) implied by the user's default model alias in
   *  ~/.claude/settings.json; undefined when no default model is configured */
  contextWindow?: number
  /** epoch ms of the transcript's last write (file mtime) */
  lastWriteMs: number
}

/* === Claude Code hooks === */

/** The events we care about; anything else on the wire is ignored. */
export type HookEventName = 'Stop' | 'Notification' | 'SubagentStop'

export interface HookEvent {
  event: HookEventName
  sessionId: string | null
  /**
   * For a SubagentStop stamped with the subagent's own transcript, the session
   * that owns it, read off the path. Null on every other event.
   */
  parentSessionId: string | null
  cwd: string | null
  transcriptPath: string | null
  /** Notification hooks carry a human message ("Claude needs your permission…"). */
  message: string | null
  /**
   * Claude's id for the *instruction* this turn belongs to. Every re-invocation
   * of the same instruction — a background agent reporting in, and the short
   * handling turn that follows — reuses it, so it is the honest identity of
   * "one turn" the completion gate fires once for.
   */
  promptId: string | null
  /**
   * True when the payload lists a background agent (a `teammate`/`agent` task)
   * still running: the main loop is going to be woken again, so this Stop is
   * very likely an intermediate one.
   */
  agentsRunning: boolean
  /**
   * True when this turn was started by a subagent reporting in rather than by a
   * person — the transcript stamps such a prompt `origin.kind:
   * "task-notification"`, `promptSource: "system"`. THE tell for a
   * per-subagent completion.
   */
  fromTaskNotification: boolean
  /** True when this turn launched background agents (async Agent-tool calls). */
  agentsLaunched: boolean
  ts: number
}

/* === File explorer === */

export interface FileTreeEntry {
  name: string
  /** stored-form absolute path — feed straight back into readDir/watchDir */
  path: string
  kind: 'file' | 'dir'
  /** present (true) only when the entry is a symbolic link (not followed) */
  symlink?: true
}

/**
 * A single file's contents for the read-only viewer pane. A discriminated union
 * so the renderer switches on `kind` and never has to sniff bytes itself — text
 * decoded UTF-8, images as a base64 data URL, and everything else (binary,
 * oversized, unreadable) reported as a quiet fallback the pane renders with a
 * "Reveal in file manager" affordance. Never throws across IPC; a read failure
 * resolves to `{ kind: 'error' }`.
 */
export type FileReadResult =
  | { kind: 'text'; content: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary' }
  | { kind: 'toolarge'; size: number }
  | { kind: 'error'; message: string }

/**
 * Every file op resolves to a plain result so nothing throws across IPC — the
 * renderer surfaces `message` inline. These deliberately return no new path:
 * the per-directory watchers already push a change for the affected parent(s),
 * so the tree refreshes itself.
 */
export type FileOpResult = { ok: true } | { ok: false; message: string }

/* === Claude accounts === */

export type ClaudeAccountBackend = 'default' | 'api-key' | 'subscription'

export interface ClaudeAccount {
  id: string
  label: string
  backend: ClaudeAccountBackend
  /** CLAUDE_CONFIG_DIR this account's panes run under; '' for the default. */
  configDir: string
  /** epoch ms */
  addedAt: number
  /** whether a secret is held for this account in the OS keychain */
  hasSecret: boolean
}

/** The account panes use when none is chosen: the user's own ~/.claude. */
export const DEFAULT_ACCOUNT_ID = 'default'

export interface AddAccountInput {
  label: string
  backend: 'api-key' | 'subscription'
  apiKey?: string
  oauthToken?: string
}

/**
 * An in-flight `claude setup-token` run: a throwaway PTY whose output the user
 * completes the OAuth flow in, after which the token is captured.
 */
export interface PendingMint {
  ptyId: string
  configDir: string
  command: string
}

/* === PTY === */

export interface SpawnOpts {
  id: string
  kind: PaneKind
  cwd?: string
  /** Full command line; absent means the pane kind's default. */
  command?: string
  accountId?: string
  /** Set when this PTY is a token-minting run rather than a pane. */
  mint?: { configDir: string }
  cols?: number
  rows?: number
}

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  code: number
}

/* === Misc main-process reads === */

export interface GitStatus {
  branch: string | null
  dirty: boolean
}

/** One rate-limit window (session, weekly, …) as the usage meter shows it. */
export interface UsageWindow {
  key: string
  label: string
  pct: number
  /** epoch ms the window resets, when the endpoint reports one */
  resetsAt: number | null
  /** epoch ms the current burn rate would hit 100%, when projectable */
  projectedCapAt?: number | null
}

export interface UsageSnapshot {
  /** false when the endpoint is unreachable or the plan has no windows */
  available: boolean
  plan: string | null
  updatedAt: number
  windows: UsageWindow[]
  /** tokens spent in the current session window, keyed by Claude session id */
  bySessionId: Record<string, number>
  /** total tokens spent in the current session window */
  windowTokens: number
  error?: string
}

/** The result of looking for a CLI binary, shown in Settings. */
export interface CliProbe {
  ok: boolean
  command: string
  source: 'setting' | 'login-shell' | 'bare'
  version?: string
  error?: string
}

export interface AppNotification {
  title: string
  body: string
  /** clicking the notification focuses this pane */
  paneId?: string
  silent?: boolean
}

/**
 * Where the app is in the update cycle. One flat stage rather than a set of
 * booleans: the About screen renders exactly one line, and the stage is what
 * picks it.
 *
 * `unsupported` is a build that cannot update itself — a dev run, or a Linux
 * tree that was not started from the AppImage — and is a statement of fact,
 * not an error the user can act on.
 */
export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'current'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  stage: UpdateStage
  /** The version behind the stage: what is offered, downloading, or ready. */
  version: string | null
  /** Download progress, 0–100; only meaningful while `downloading`. */
  percent: number
  /** Why the last check or download failed, in words a user can read. */
  error?: string
  /** epoch ms of the last completed check, null before the first one. */
  checkedAt: number | null
}
