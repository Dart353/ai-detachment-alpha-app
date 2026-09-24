/**
 * The wire contract between a desktop (host), the relay, and a phone (viewer).
 *
 * THIS FILE IS A VERBATIM COPY of the relay repo's `src/protocol.ts` — edit it there, copy it here.
 * Bump `PROTOCOL_VERSION` on any change to an event or payload; a peer on a
 * different version is refused at auth with a message that says so, instead of
 * two sides silently disagreeing about a field.
 *
 * Trust model: a machine is identified by the SHA-256 of a 256-bit pairing key
 * the desktop generated. The desktop presents the key to register; a phone
 * presents the same key to subscribe. The relay derives the id, keeps nothing
 * on disk, and has no secrets of its own — a connection with no key matches
 * nothing. The key crosses to the relay over TLS; it is the operator's own
 * server, and the design leaves room to encrypt payloads end to end with the
 * same key later without changing this handshake.
 *
 * Holding a machine's key grants everything on it: seeing its panes AND typing
 * into them. There is no read-only key.
 */

export const PROTOCOL_VERSION = 5

/** A 256-bit key as 64 lowercase hex chars — what the desktop shows and the phone types. */
export const KEY_RE = /^[0-9a-f]{64}$/

/* === what a host publishes ================================================== */

export type PaneKind = 'claude' | 'terminal' | 'ssh' | 'viewer'
/** `starting` is a fresh agent that has not shown its first prompt yet. */
export type PaneStatus = 'starting' | 'working' | 'attention' | 'idle' | 'done' | 'exited'

export interface FeedPane {
  id: string
  name: string
  kind: PaneKind
  status: PaneStatus
  color?: string
  title: string | null
  lastPrompt: string | null
  model: string | null
  /** One line for the list: what the agent is on, or what it wants. */
  summary: string | null
  /** epoch ms of the pane's last output, 0 if it never spoke */
  lastActivity: number
}

export interface FeedWorkspace {
  id: string
  name: string
  rootDir: string
  panes: FeedPane[]
}

/** A folder the desktop has opened before, offered on the phone for reopening. */
export interface FeedRecent {
  name: string
  rootDir: string
}

/** One machine's whole picture, replaced wholesale on every publish. */
export interface Feed {
  workspaces: FeedWorkspace[]
  /** Recent folders, most recent first, for "open a workspace" on the phone. */
  recents: FeedRecent[]
  /** epoch ms the desktop built it */
  updatedAt: number
  host: {
    name: string
    version: string
    /** Model aliases the machine's Claude Code offers, as `--model` takes them. */
    models: string[]
  }
}

/* === acting on the desktop ================================================== */

/** The pane kinds a phone may add; ssh and viewer panes need a desktop. */
export type AddablePaneKind = 'claude' | 'terminal'

/** `--effort` as Claude Code takes it. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
/** A model alias or id as `--model` takes it. */
export const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/
export const PANE_NAME_MAX_CHARS = 64

/** Add a pane to an open workspace; the desktop places it as a split would. */
export interface AddPane {
  workspaceId: string
  kind: AddablePaneKind
  /** Blank means the desktop's default name. */
  name?: string
  /** `claude` panes: one of the feed's `host.models`, or any id `--model` takes. */
  model?: string
  effort?: Effort
  planMode?: boolean
}

/**
 * Open a folder as a workspace, as the desktop's own open dialog would: a
 * folder that is already open is focused, an archived one is restored.
 */
export interface OpenWorkspace {
  rootDir: string
}

/** The most a `rootDir` may carry. */
export const ROOT_DIR_MAX_CHARS = 1024

/* === watching a pane ======================================================== */

/**
 * What a viewer gets when it starts watching a pane: the recent raw terminal
 * output, to replay into a terminal of the same size. The desktop owns the
 * size — a phone renders at the desktop's columns and never resizes the PTY.
 */
export interface Screen {
  paneId: string
  data: string
  cols: number
  rows: number
}

/** A live chunk of a watched pane's output, raw bytes as the PTY produced them. */
export interface Output {
  paneId: string
  data: string
}

/** Keystrokes for a pane, raw: the page appends `\r` to a prompt itself. */
export interface Input {
  paneId: string
  data: string
}

/** The most a `screen` replay carries; the desktop trims its buffer to this. */
export const SCREEN_MAX_CHARS = 256 * 1024
/** The most one `input` may carry — a pasted prompt, never a file. */
export const INPUT_MAX_CHARS = 16 * 1024

/* === attaching a picture ==================================================== */

/**
 * An image for a pane, sent as bytes. The desktop saves it to a temp folder
 * and types the file's path into the pane, the way a drag-drop does, so the
 * agent reads it as a local file. Nothing is stored anywhere else.
 */
export interface Attach {
  paneId: string
  /** The file's name on the phone, for the saved file's name (sanitised there). */
  name: string
  mime: string
  data: ArrayBuffer
}

/** The phone re-encodes to JPEG before sending; this is the ceiling after that. */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024
export const ATTACH_MIME_RE = /^image\/(png|jpeg|gif|webp)$/
/** Attaches one viewer may send per minute. */
export const ATTACH_PER_MINUTE = 6

/** The relay's answer to an `attach`: forwarded, or why not. */
export interface Attached {
  paneId: string
  ok: boolean
  error?: string
}

/* === who is watching ======================================================== */

/** One phone connected with this machine's key, as the desktop lists it. */
export interface ViewerInfo {
  /** The relay's id for the connection; changes on every reconnect. */
  id: string
  /** The phone's address as the relay saw it (forwarded through the proxy). */
  address: string
  /** The browser's User-Agent, for a human label. */
  userAgent: string
  /** epoch ms the connection was made */
  connectedAt: number
  /** The panes on this machine it has open right now. */
  watching: string[]
}

/* === the handshake ========================================================== */

/** `socket.io` `auth` payload, sent once per connection. */
export type Auth =
  | { role: 'host'; protocolVersion: number; key: string; name: string }
  | { role: 'viewer'; protocolVersion: number; keys: string[] }

/** Why an auth was refused; the relay disconnects right after sending it. */
export interface AuthError {
  code: 'bad-version' | 'bad-key' | 'bad-role' | 'rate-limited'
  message: string
  /** what the relay speaks, so a client can say "update the app" */
  protocolVersion: number
}

/* === events ================================================================= */

/** What a viewer knows about one machine it holds the key for. */
export interface HostState {
  hostId: string
  online: boolean
  name: string | null
  feed: Feed | null
}

export interface HostToRelay {
  /** The desktop's latest picture; the relay keeps the last one for late viewers. */
  feed: (feed: Feed) => void
  /**
   * Drop one phone: the relay tells it to forget this machine's key and closes
   * its connection. Cooperative — a phone that keeps the key can pair again;
   * rotating the key is the revoke that needs no cooperation.
   */
  disconnectViewer: (target: { viewerId: string }) => void
  /** Answer to `watch`: the pane's recent output and size, for every watcher. */
  screen: (screen: Screen) => void
  /** Live output of a watched pane. */
  output: (output: Output) => void
}

export interface RelayToHost {
  /** Registration succeeded; `viewers` is how many phones are watching right now. */
  registered: (info: { hostId: string; viewers: number }) => void
  authError: (error: AuthError) => void
  /** A first viewer opened this pane: send a `screen`, then stream `output`. */
  watch: (target: { paneId: string }) => void
  /** The last viewer left this pane: stop streaming it. */
  unwatch: (target: { paneId: string }) => void
  /** A viewer typed into this pane. */
  input: (input: Input) => void
  /** A viewer sent a picture for this pane. */
  attach: (attach: Attach) => void
  addPane: (request: AddPane) => void
  openWorkspace: (request: OpenWorkspace) => void
  /** Every phone holding this machine's key, whenever that set changes. */
  viewers: (list: ViewerInfo[]) => void
}

export interface RelayToViewer {
  /** On subscribe: one per key held; afterwards whenever a machine comes or goes. */
  hostState: (state: HostState) => void
  /** A fresh feed from a machine this viewer holds the key for. */
  hostFeed: (update: { hostId: string; feed: Feed }) => void
  authError: (error: AuthError) => void
  screen: (update: { hostId: string } & Screen) => void
  output: (update: { hostId: string } & Output) => void
  /** The desktop dropped this phone: forget that machine's key. Sent right before the disconnect. */
  kicked: (target: { hostId: string }) => void
  /** Whether an `attach` reached the machine. */
  attached: (result: { hostId: string } & Attached) => void
}

export interface ViewerToRelay {
  watch: (target: { hostId: string; paneId: string }) => void
  unwatch: (target: { hostId: string; paneId: string }) => void
  input: (input: { hostId: string } & Input) => void
  attach: (attach: { hostId: string } & Attach) => void
  addPane: (request: { hostId: string } & AddPane) => void
  openWorkspace: (request: { hostId: string } & OpenWorkspace) => void
}
