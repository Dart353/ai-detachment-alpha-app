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
 */

export const PROTOCOL_VERSION = 1

/** A 256-bit key as 64 lowercase hex chars — what the desktop shows and the phone types. */
export const KEY_RE = /^[0-9a-f]{64}$/

/* === what a host publishes ================================================== */

export type PaneKind = 'claude' | 'terminal' | 'ssh' | 'viewer'
export type PaneStatus = 'working' | 'attention' | 'idle' | 'done' | 'exited'

export interface FeedPane {
  id: string
  name: string
  kind: PaneKind
  status: PaneStatus
  color?: string
  title: string | null
  lastPrompt: string | null
  model: string | null
  /** epoch ms of the pane's last output, 0 if it never spoke */
  lastActivity: number
}

export interface FeedWorkspace {
  id: string
  name: string
  rootDir: string
  panes: FeedPane[]
}

/** One machine's whole picture, replaced wholesale on every publish. */
export interface Feed {
  workspaces: FeedWorkspace[]
  /** epoch ms the desktop built it */
  updatedAt: number
  host: { name: string; version: string }
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
}

export interface RelayToHost {
  /** Registration succeeded; `viewers` is how many phones are watching right now. */
  registered: (info: { hostId: string; viewers: number }) => void
  authError: (error: AuthError) => void
}

export interface RelayToViewer {
  /** On subscribe: one per key held; afterwards whenever a machine comes or goes. */
  hostState: (state: HostState) => void
  /** A fresh feed from a machine this viewer holds the key for. */
  hostFeed: (update: { hostId: string; feed: Feed }) => void
  authError: (error: AuthError) => void
}

export interface ViewerToRelay {
  /** Nothing yet — chat arrives in the next protocol version. */
  _reserved?: never
}
