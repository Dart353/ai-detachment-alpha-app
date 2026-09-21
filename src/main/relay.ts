import crypto from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import {
  KEY_RE,
  PROTOCOL_VERSION,
  type Auth,
  type AuthError,
  type Feed,
  type HostToRelay,
  type RelayToHost
} from '../shared/relayProtocol'

/**
 * The link from this machine to the relay a phone watches it through.
 *
 * One outbound socket.io connection, registered as a host under the pairing
 * key. It pushes the latest feed on every change and again on every
 * reconnect, because the relay only remembers a feed while the socket that
 * sent it is alive. socket.io owns the reconnect schedule; this class only
 * turns its events into a status the Settings screen can show.
 *
 * Pure of Electron on purpose, so a vitest can run it against a real relay on
 * a random port.
 */

/** 256 random bits as 64 hex chars — what the phone types. */
export function mintKey(): string {
  return crypto.randomBytes(32).toString('hex')
}

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_RE.test(value)
}

/** The relay's id for a key; shown in Settings so a user can match logs. */
export function hostIdFor(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex')
}

/** `https://ada.example.com/` and `ada.example.com` both mean the origin. */
export function normalizeRelayUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

export type LinkState = 'connecting' | 'connected' | 'error'

export interface LinkEvent {
  state: LinkState
  hostId: string
  viewers: number
  error?: string
}

export interface RelayLinkOpts {
  url: string
  key: string
  name: string
  /** What to send on connect and on every `publish`. */
  feed: () => Feed
  onChange: (event: LinkEvent) => void
}

export class RelayLink {
  private readonly socket: Socket<RelayToHost, HostToRelay>
  private readonly hostId: string
  private viewers = 0

  constructor(private readonly opts: RelayLinkOpts) {
    this.hostId = hostIdFor(opts.key)
    const auth: Auth = {
      role: 'host',
      protocolVersion: PROTOCOL_VERSION,
      key: opts.key,
      name: opts.name
    }
    this.socket = io(opts.url, {
      auth,
      // WebSocket first; polling only as the fallback for a hostile proxy.
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 30_000
    })

    this.socket.on('registered', ({ viewers }) => {
      this.viewers = viewers
      this.emit('connected')
      // The relay forgot our last feed when the previous socket died.
      this.socket.emit('feed', this.opts.feed())
    })
    this.socket.on('authError', (error: AuthError) => {
      // A refusal is final for this configuration: no point in retrying the
      // same key or version every few seconds.
      this.socket.io.reconnection(false)
      this.emit('error', describeRefusal(error))
    })
    this.socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') return // we closed it
      if (!this.socket.io.reconnection()) return // refused above; keep that message
      this.emit('connecting', `disconnected: ${reason}`)
    })
    this.socket.on('connect_error', (err) => {
      this.emit('connecting', err.message)
    })
    this.emit('connecting')
  }

  /** Push the current feed; a no-op while disconnected (it goes on reconnect). */
  publish(): void {
    if (this.socket.connected) this.socket.emit('feed', this.opts.feed())
  }

  close(): void {
    this.socket.removeAllListeners()
    this.socket.disconnect()
  }

  private emit(state: LinkState, error?: string): void {
    this.opts.onChange({ state, hostId: this.hostId, viewers: this.viewers, error })
  }
}

function describeRefusal(error: AuthError): string {
  if (error.code === 'bad-version') {
    return PROTOCOL_VERSION < error.protocolVersion
      ? `The relay speaks protocol ${error.protocolVersion}; this app speaks ${PROTOCOL_VERSION}. Update the app.`
      : `This app speaks protocol ${PROTOCOL_VERSION}; the relay speaks ${error.protocolVersion}. Update the relay.`
  }
  return error.message
}
