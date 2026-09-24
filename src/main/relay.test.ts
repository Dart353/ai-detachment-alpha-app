import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type Feed } from '../shared/relayProtocol'
import { RelayLink, hostIdFor, isKey, mintKey, normalizeRelayUrl, type LinkEvent } from './relay'

const feed: Feed = {
  workspaces: [],
  recents: [],
  updatedAt: 1,
  host: { name: 'office', version: '1.0.0', models: ['opus'] }
}

describe('keys and urls', () => {
  it('mints 64-hex keys that pass the protocol check', () => {
    const key = mintKey()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(isKey(key)).toBe(true)
    expect(isKey(key.slice(1))).toBe(false)
    expect(mintKey()).not.toBe(key)
  })

  it('hashes to a 64-hex id that is not the key', () => {
    const key = mintKey()
    expect(hostIdFor(key)).toMatch(/^[0-9a-f]{64}$/)
    expect(hostIdFor(key)).not.toBe(key)
  })

  it('normalizes a relay url to its origin', () => {
    expect(normalizeRelayUrl('https://ada.example.com/')).toBe('https://ada.example.com')
    expect(normalizeRelayUrl('ada.example.com')).toBe('https://ada.example.com')
    expect(normalizeRelayUrl(' http://127.0.0.1:3801/x ')).toBe('http://127.0.0.1:3801')
    expect(normalizeRelayUrl('')).toBeNull()
    expect(normalizeRelayUrl('ftp://x')).toBeNull()
  })
})

/**
 * A stand-in for the relay: enough of its handshake to register a host and
 * refuse a bad version. The real relay's tests live in its own repo.
 */
describe('RelayLink', () => {
  let server: http.Server
  let io: Server
  let url: string
  let link: RelayLink | null = null
  const received: unknown[] = []
  const agents: string[] = []

  beforeEach(async () => {
    server = http.createServer()
    io = new Server(server)
    io.on('connection', (socket) => {
      const auth = socket.handshake.auth as { protocolVersion: number; key: string; role: string }
      if (auth.protocolVersion !== PROTOCOL_VERSION) {
        socket.emit('authError', {
          code: 'bad-version',
          message: 'nope',
          protocolVersion: PROTOCOL_VERSION + 1
        })
        setImmediate(() => socket.disconnect(true))
        return
      }
      socket.on('feed', (value) => received.push(value))
      agents.push(socket.handshake.headers['user-agent'] ?? '')
      socket.emit('registered', { hostId: 'x', viewers: 2 })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    received.length = 0
  })

  afterEach(async () => {
    link?.close()
    link = null
    await new Promise<void>((resolve) => io.close(() => resolve()))
  })

  function untilState(events: LinkEvent[], state: LinkEvent['state']): Promise<LinkEvent> {
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

  it('registers, reports viewers, and sends the feed on connect and on publish', async () => {
    const events: LinkEvent[] = []
    const key = mintKey()
    link = new RelayLink({ url, key, name: 'office', version: '1.0.0', feed: () => feed, onChange: (e) => events.push(e) })
    expect(events[0]).toMatchObject({ state: 'connecting', hostId: hostIdFor(key) })
    const connected = await untilState(events, 'connected')
    expect(connected.viewers).toBe(2)
    expect(agents.at(-1)).toBe('ai-detachment-alpha/1.0.0')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toHaveLength(1)
    link.publish()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received).toHaveLength(2)
  })

  it('answers watch with a screen, streams output, and hands input over', async () => {
    const events: LinkEvent[] = []
    const seen: string[] = []
    let hostSocket: import('socket.io').Socket | null = null
    io.on('connection', (socket) => {
      hostSocket = socket
    })
    link = new RelayLink({
      url,
      key: mintKey(),
      name: 'office',
      version: '1.0.0',
      feed: () => feed,
      onChange: (e) => events.push(e),
      onWatch: (paneId) => {
        seen.push(`watch ${paneId}`)
        link?.sendScreen({ paneId, data: '$ ', cols: 100, rows: 30 })
        link?.sendOutput(paneId, 'live')
      },
      onUnwatch: (paneId) => seen.push(`unwatch ${paneId}`),
      onInput: (input) => seen.push(`input ${input.paneId} ${input.data}`)
    })
    await untilState(events, 'connected')
    const gotScreen = new Promise<unknown>((resolve) => hostSocket!.once('screen', resolve))
    const gotOutput = new Promise<unknown>((resolve) => hostSocket!.once('output', resolve))
    hostSocket!.emit('watch', { paneId: 'p1' })
    expect(await gotScreen).toEqual({ paneId: 'p1', data: '$ ', cols: 100, rows: 30 })
    expect(await gotOutput).toEqual({ paneId: 'p1', data: 'live' })
    hostSocket!.emit('input', { paneId: 'p1', data: 'ls\r' })
    hostSocket!.emit('unwatch', { paneId: 'p1' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toEqual(['watch p1', 'input p1 ls\r', 'unwatch p1'])
  })

  it('cleans a new-agent request and hands a picture over as bytes', async () => {
    const events: LinkEvent[] = []
    const added: unknown[] = []
    const attached: { paneId: string; name: string; mime: string; data: unknown }[] = []
    let hostSocket: import('socket.io').Socket | null = null
    io.on('connection', (socket) => {
      hostSocket = socket
    })
    link = new RelayLink({
      url,
      key: mintKey(),
      name: 'office',
      version: '1.0.0',
      feed: () => feed,
      onChange: (e) => events.push(e),
      onAddPane: (request) => added.push(request),
      onAttach: (attach) => attached.push(attach)
    })
    await untilState(events, 'connected')
    hostSocket!.emit('addPane', { workspaceId: 'w', kind: 'claude', name: ' Fixer ', model: 'sonnet', effort: 'max', planMode: true })
    hostSocket!.emit('addPane', { workspaceId: 'w', kind: 'claude', model: 'no spaces', effort: 'nope', planMode: 'yes' })
    hostSocket!.emit('addPane', { workspaceId: 'w', kind: 'terminal', model: 'opus', name: 'sh' })
    hostSocket!.emit('attach', { paneId: 'p1', name: 'a.png', mime: 'image/png', data: Buffer.from([1, 2, 3]) })
    hostSocket!.emit('attach', { paneId: 'p1', name: 'a.png', mime: 'image/png', data: 'text' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(added).toEqual([
      { workspaceId: 'w', kind: 'claude', name: 'Fixer', model: 'sonnet', effort: 'max', planMode: true },
      { workspaceId: 'w', kind: 'claude' },
      { workspaceId: 'w', kind: 'terminal', name: 'sh' }
    ])
    expect(attached).toHaveLength(1)
    expect(attached[0]).toMatchObject({ paneId: 'p1', name: 'a.png', mime: 'image/png' })
    expect(Buffer.from(attached[0].data as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('passes the viewer list through and asks the relay to drop one', async () => {
    const events: LinkEvent[] = []
    const lists: unknown[] = []
    let hostSocket: import('socket.io').Socket | null = null
    const dropped: unknown[] = []
    io.on('connection', (socket) => {
      hostSocket = socket
      socket.on('disconnectViewer', (t) => dropped.push(t))
    })
    link = new RelayLink({
      url,
      key: mintKey(),
      name: 'office',
      version: '1.0.0',
      feed: () => feed,
      onChange: (e) => events.push(e),
      onViewers: (list) => lists.push(list)
    })
    await untilState(events, 'connected')
    const phone = { id: 'v1', address: '1.2.3.4', userAgent: 'iPhone', connectedAt: 5, watching: ['p1'] }
    hostSocket!.emit('viewers', [phone])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(lists).toEqual([[phone]])
    link.disconnectViewer('v1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(dropped).toEqual([{ viewerId: 'v1' }])
  })

  it('reads an unreachable relay as connecting with a message, not a crash', async () => {
    const events: LinkEvent[] = []
    link = new RelayLink({
      url: 'http://127.0.0.1:1',
      key: mintKey(),
      name: 'office',
      version: '1.0.0',
      feed: () => feed,
      onChange: (e) => events.push(e)
    })
    const connecting = await new Promise<LinkEvent>((resolve, reject) => {
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
