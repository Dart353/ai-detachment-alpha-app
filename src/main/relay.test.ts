import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type Feed } from '../shared/relayProtocol'
import { RelayLink, hostIdFor, isKey, mintKey, normalizeRelayUrl, type LinkEvent } from './relay'

const feed: Feed = {
  workspaces: [],
  updatedAt: 1,
  host: { name: 'office', version: '1.0.0' }
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
