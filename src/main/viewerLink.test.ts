import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server, type Socket as ServerSocket } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INPUT_MAX_CHARS, PROTOCOL_VERSION, type Feed } from '../shared/relayProtocol'
import { hostIdFor, mintKey } from './relay'
import { ViewerLink, type ViewerEvent } from './viewerLink'

const feed: Feed = {
  workspaces: [],
  recents: [],
  updatedAt: 1,
  host: { name: 'office', version: '1.0.0', models: ['opus'] }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A stand-in for the relay: enough of its handshake to accept a viewer and
 * refuse a bad version. The real relay's tests live in its own repo.
 */
describe('ViewerLink', () => {
  let server: http.Server
  let io: Server
  let url: string
  let link: ViewerLink | null = null
  let relaySocket: ServerSocket | null = null
  let refuseVersion = false
  let connections = 0
  const auths: unknown[] = []
  const agents: string[] = []

  beforeEach(async () => {
    server = http.createServer()
    io = new Server(server)
    relaySocket = null
    refuseVersion = false
    connections = 0
    auths.length = 0
    agents.length = 0
    io.on('connection', (socket) => {
      connections += 1
      if (refuseVersion) {
        socket.emit('authError', { code: 'bad-version', message: 'nope', protocolVersion: PROTOCOL_VERSION + 1 })
        setImmediate(() => socket.disconnect(true))
        return
      }
      auths.push(socket.handshake.auth)
      agents.push(socket.handshake.headers['user-agent'] ?? '')
      relaySocket = socket
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    link?.close()
    link = null
    await new Promise<void>((resolve) => io.close(() => resolve()))
  })

  function untilState(events: ViewerEvent[], state: ViewerEvent['state']): Promise<ViewerEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never reached ${state}`)), 4000)
      const poll = setInterval(() => {
        const hit = events.find((event) => event.state === state)
        if (hit) {
          clearTimeout(timer)
          clearInterval(poll)
          resolve(hit)
        }
      }, 10)
    })
  }

  function relayReceives(eventName: string): unknown[] {
    const received: unknown[] = []
    relaySocket!.on(eventName, (payload: unknown) => received.push(payload))
    return received
  }

  it('subscribes as a viewer with its keys and a viewer User-Agent', async () => {
    const events: ViewerEvent[] = []
    const keys = [mintKey(), mintKey()]
    link = new ViewerLink({ url, keys: [...keys, 'not-a-key'], version: '1.2.3', onChange: (event) => events.push(event) })
    expect(events[0]).toEqual({ state: 'connecting', error: undefined })
    await untilState(events, 'connected')
    expect(events.map((event) => event.state)).toEqual(['connecting', 'connected'])
    expect(auths).toEqual([{ role: 'viewer', protocolVersion: PROTOCOL_VERSION, keys }])
    expect(agents).toEqual(['ai-detachment-alpha/1.2.3 (viewer)'])
  })

  it('hands the relay events to their callbacks, intact', async () => {
    const events: ViewerEvent[] = []
    const seen: unknown[] = []
    const key = mintKey()
    const hostId = hostIdFor(key)
    link = new ViewerLink({
      url,
      keys: [key],
      version: '1.0.0',
      onChange: (event) => events.push(event),
      onHostState: (state) => seen.push(['hostState', state]),
      onHostFeed: (update) => seen.push(['hostFeed', update]),
      onScreen: (screen) => seen.push(['screen', screen]),
      onOutput: (output) => seen.push(['output', output]),
      onKicked: (kickedHostId) => seen.push(['kicked', kickedHostId]),
      onAttached: (result) => seen.push(['attached', result])
    })
    await untilState(events, 'connected')
    relaySocket!.emit('hostState', { hostId, online: true, name: 'office', feed })
    relaySocket!.emit('hostFeed', { hostId, feed })
    relaySocket!.emit('screen', { hostId, paneId: 'p1', data: '$ ', cols: 100, rows: 30 })
    relaySocket!.emit('output', { hostId, paneId: 'p1', data: 'live' })
    relaySocket!.emit('attached', { hostId, paneId: 'p1', ok: false, error: 'too big' })
    relaySocket!.emit('kicked', { hostId })
    await pause(50)
    expect(seen).toEqual([
      ['hostState', { hostId, online: true, name: 'office', feed }],
      ['hostFeed', { hostId, feed }],
      ['screen', { hostId, paneId: 'p1', data: '$ ', cols: 100, rows: 30 }],
      ['output', { hostId, paneId: 'p1', data: 'live' }],
      ['attached', { hostId, paneId: 'p1', ok: false, error: 'too big' }],
      ['kicked', hostId]
    ])
  })

  it('drops malformed payloads and events about machines it holds no key for', async () => {
    const events: ViewerEvent[] = []
    const seen: unknown[] = []
    const hostId = hostIdFor(mintKey())
    const strangerId = hostIdFor(mintKey())
    link = new ViewerLink({
      url,
      keys: [mintKey()],
      version: '1.0.0',
      onChange: (event) => events.push(event),
      onOutput: (output) => seen.push(output),
      onKicked: (kickedHostId) => seen.push(kickedHostId)
    })
    await untilState(events, 'connected')
    relaySocket!.emit('output', { hostId: strangerId, paneId: 'p1', data: 'live' })
    relaySocket!.emit('output', { hostId, paneId: 1, data: 'live' })
    relaySocket!.emit('output', { hostId, paneId: 'p1', data: 42 })
    relaySocket!.emit('kicked', { hostId: strangerId })
    await pause(50)
    expect(seen).toEqual([])
  })

  it('sends watch, unwatch, input, addPane and openWorkspace addressed by host', async () => {
    const events: ViewerEvent[] = []
    const hostId = hostIdFor(mintKey())
    link = new ViewerLink({ url, keys: [mintKey()], version: '1.0.0', onChange: (event) => events.push(event) })
    await untilState(events, 'connected')
    const watched = relayReceives('watch')
    const unwatched = relayReceives('unwatch')
    const inputs = relayReceives('input')
    const added = relayReceives('addPane')
    const opened = relayReceives('openWorkspace')
    link.watch(hostId, 'p1')
    link.input(hostId, 'p1', 'ls\r')
    link.input(hostId, 'p1', '')
    link.input(hostId, 'p1', 'x'.repeat(INPUT_MAX_CHARS + 1))
    link.addPane(hostId, { workspaceId: 'w', kind: 'claude', name: 'Fixer', model: 'opus', effort: 'max', planMode: true })
    link.openWorkspace(hostId, '/home/me/project')
    link.unwatch(hostId, 'p1')
    await pause(50)
    expect(watched).toEqual([{ hostId, paneId: 'p1' }])
    expect(inputs).toEqual([{ hostId, paneId: 'p1', data: 'ls\r' }])
    expect(added).toEqual([
      { hostId, workspaceId: 'w', kind: 'claude', name: 'Fixer', model: 'opus', effort: 'max', planMode: true }
    ])
    expect(opened).toEqual([{ hostId, rootDir: '/home/me/project' }])
    expect(unwatched).toEqual([{ hostId, paneId: 'p1' }])
  })

  it('sends a picture to the relay as bytes', async () => {
    const events: ViewerEvent[] = []
    const hostId = hostIdFor(mintKey())
    link = new ViewerLink({ url, keys: [mintKey()], version: '1.0.0', onChange: (event) => events.push(event) })
    await untilState(events, 'connected')
    const attaches = relayReceives('attach') as { hostId: string; paneId: string; name: string; mime: string; data: unknown }[]
    link.attach(hostId, { paneId: 'p1', name: 'a.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]).buffer })
    link.attach(hostId, { paneId: 'p2', name: 'b.png', mime: 'image/png', data: Buffer.from([4, 5, 6]) })
    await pause(50)
    expect(attaches).toHaveLength(2)
    expect(attaches[0]).toMatchObject({ hostId, paneId: 'p1', name: 'a.png', mime: 'image/png' })
    expect(Buffer.isBuffer(attaches[0].data)).toBe(true)
    expect(Buffer.from(attaches[0].data as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
    expect(attaches[1]).toMatchObject({ hostId, paneId: 'p2', name: 'b.png', mime: 'image/png' })
    expect(Buffer.from(attaches[1].data as Uint8Array)).toEqual(Buffer.from([4, 5, 6]))
  })

  it('sends nothing while disconnected', async () => {
    const events: ViewerEvent[] = []
    link = new ViewerLink({ url, keys: [mintKey()], version: '1.0.0', onChange: (event) => events.push(event) })
    link.watch(hostIdFor(mintKey()), 'p1')
    await untilState(events, 'connected')
    const watched = relayReceives('watch')
    await pause(50)
    expect(watched).toEqual([])
  })

  it('reads a version refusal as a final error that says to update the app', async () => {
    refuseVersion = true
    const events: ViewerEvent[] = []
    link = new ViewerLink({ url, keys: [mintKey()], version: '1.0.0', onChange: (event) => events.push(event) })
    const refused = await untilState(events, 'error')
    expect(refused.error).toContain('Update the app')
    await pause(1600)
    expect(connections).toBe(1)
    expect(events.at(-1)?.state).toBe('error')
  })

  it('reads an unreachable relay as connecting with a message, not a crash', async () => {
    const events: ViewerEvent[] = []
    link = new ViewerLink({ url: 'http://127.0.0.1:1', keys: [mintKey()], version: '1.0.0', onChange: (event) => events.push(event) })
    const connecting = await new Promise<ViewerEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no connect_error')), 4000)
      const poll = setInterval(() => {
        const hit = events.find((event) => event.state === 'connecting' && event.error)
        if (hit) {
          clearTimeout(timer)
          clearInterval(poll)
          resolve(hit)
        }
      }, 10)
    })
    expect(connecting.error).toBeTruthy()
  })
})
