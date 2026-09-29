import { io, type Socket } from 'socket.io-client'
import {
  INPUT_MAX_CHARS,
  PROTOCOL_VERSION,
  type AddPane,
  type Attach,
  type Attached,
  type Auth,
  type AuthError,
  type Feed,
  type HostState,
  type Output,
  type RelayToViewer,
  type Screen,
  type ViewerToRelay
} from '../shared/relayProtocol'
import { hostIdFor, isKey } from './relay'

/**
 * The link from this machine to the relay as a viewer of other machines.
 *
 * One outbound socket.io connection, subscribed with the pairing keys this
 * machine holds for other desktops. The relay answers with one `hostState`
 * per key and then forwards feeds, screens and output for those machines;
 * watching, typing, adding panes and sending pictures flow the other way,
 * addressed by host id. It is the phone's side of the protocol, spoken from a
 * desktop.
 *
 * There is no `registered` for a viewer, so "connected" is the socket's own
 * `connect`. socket.io owns the reconnect schedule; this class only turns its
 * events into a status and hands the relay's events to callbacks. It keeps no
 * picture of the machines it watches — that belongs to whoever listens. Pure
 * of Electron on purpose, so a vitest can run it against a real socket.io
 * server on a random port.
 */

/** The most keys one viewer may subscribe with; the relay refuses more. */
const MAX_KEYS = 32

export type ViewerState = 'connecting' | 'connected' | 'error'

export interface ViewerEvent {
  state: ViewerState
  error?: string
}

export interface ViewerLinkOpts {
  url: string
  /** Pairing keys of the machines to watch; invalid ones and extras past 32 are dropped. */
  keys: string[]
  /** The app version, for the connection's User-Agent. */
  version: string
  onChange: (event: ViewerEvent) => void
  /** A machine's presence and last feed: once per key on connect, then as it comes and goes. */
  onHostState?: (state: HostState) => void
  /** A fresh feed from a machine. */
  onHostFeed?: (update: { hostId: string; feed: Feed }) => void
  /** The replay for a pane this link started watching. */
  onScreen?: (screen: { hostId: string } & Screen) => void
  /** Live output of a watched pane. */
  onOutput?: (output: { hostId: string } & Output) => void
  /** That machine dropped this viewer: forget its key. The relay disconnects right after. */
  onKicked?: (hostId: string) => void
  /** Whether an `attach` reached the machine. */
  onAttached?: (result: { hostId: string } & Attached) => void
}

export class ViewerLink {
  private readonly socket: Socket<RelayToViewer, ViewerToRelay>
  private readonly hostIds: Set<string>

  constructor(private readonly opts: ViewerLinkOpts) {
    const keys = [...new Set(opts.keys.filter(isKey))].slice(0, MAX_KEYS)
    this.hostIds = new Set(keys.map(hostIdFor))
    const auth: Auth = { role: 'viewer', protocolVersion: PROTOCOL_VERSION, keys }
    this.socket = io(opts.url, {
      auth,
      // WebSocket first; polling only as the fallback for a hostile proxy.
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 30_000,
      // Node's WebSocket client sends no User-Agent at all, and a reverse
      // proxy that tarpits empty agents would swallow the connection.
      extraHeaders: { 'User-Agent': `ai-detachment-alpha/${opts.version} (viewer)` }
    })

    this.socket.on('connect', () => this.emit('connected'))
    this.socket.on('authError', (error: AuthError) => {
      // A refusal is final for this configuration: no point in retrying the
      // same keys or version every few seconds.
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
    this.socket.on('hostState', (state) => {
      if (state && this.holds(state.hostId) && typeof state.online === 'boolean') {
        this.opts.onHostState?.(state)
      }
    })
    this.socket.on('hostFeed', (update) => {
      if (update && this.holds(update.hostId) && update.feed && typeof update.feed === 'object') {
        this.opts.onHostFeed?.(update)
      }
    })
    this.socket.on('screen', (screen) => {
      if (
        screen &&
        this.holds(screen.hostId) &&
        typeof screen.paneId === 'string' &&
        typeof screen.data === 'string' &&
        typeof screen.cols === 'number' &&
        typeof screen.rows === 'number'
      ) {
        this.opts.onScreen?.(screen)
      }
    })
    this.socket.on('output', (output) => {
      if (output && this.holds(output.hostId) && typeof output.paneId === 'string' && typeof output.data === 'string') {
        this.opts.onOutput?.(output)
      }
    })
    this.socket.on('kicked', (target) => {
      if (target && this.holds(target.hostId)) this.opts.onKicked?.(target.hostId)
    })
    this.socket.on('attached', (result) => {
      if (result && this.holds(result.hostId) && typeof result.paneId === 'string' && typeof result.ok === 'boolean') {
        this.opts.onAttached?.(result)
      }
    })
    this.emit('connecting')
  }

  get connected(): boolean {
    return this.socket.connected
  }

  watch(hostId: string, paneId: string): void {
    if (this.socket.connected) this.socket.emit('watch', { hostId, paneId })
  }

  unwatch(hostId: string, paneId: string): void {
    if (this.socket.connected) this.socket.emit('unwatch', { hostId, paneId })
  }

  /** Keystrokes for a pane; empty or oversized input is dropped, as the relay would. */
  input(hostId: string, paneId: string, data: string): void {
    if (!data || data.length > INPUT_MAX_CHARS) return
    if (this.socket.connected) this.socket.emit('input', { hostId, paneId, data })
  }

  addPane(hostId: string, request: AddPane): void {
    if (this.socket.connected) this.socket.emit('addPane', { hostId, ...request })
  }

  openWorkspace(hostId: string, rootDir: string): void {
    if (this.socket.connected) this.socket.emit('openWorkspace', { hostId, rootDir })
  }

  /** A picture for a pane; the answer comes back through `onAttached`. A Buffer read from disk will do. */
  attach(hostId: string, attach: Omit<Attach, 'data'> & { data: ArrayBuffer | Uint8Array }): void {
    // The protocol types `data` as the browser's ArrayBuffer; socket.io sends a
    // Uint8Array (and so a Buffer) as the same binary attachment, so it goes as-is.
    const payload = { hostId, ...attach } as { hostId: string } & Attach
    if (this.socket.connected) this.socket.emit('attach', payload)
  }

  close(): void {
    this.socket.removeAllListeners()
    this.socket.disconnect()
  }

  /** Only events about machines this link holds a key for are passed on. */
  private holds(hostId: unknown): hostId is string {
    return typeof hostId === 'string' && this.hostIds.has(hostId)
  }

  private emit(state: ViewerState, error?: string): void {
    this.opts.onChange({ state, error })
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
