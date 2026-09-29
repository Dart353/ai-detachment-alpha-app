import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteMachine, RemoteNotice, RemoteStatus } from '../../../shared/types'
import type { FeedPane, FeedWorkspace } from '../../../shared/relayProtocol'
import { findRemotePane, useRemote, waitingCount } from './remote'

const remoteInitial = useRemote.getState()

beforeEach(() => {
  useRemote.setState({ ...remoteInitial, folded: {} }, true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function makePane(id: string, status: FeedPane['status'] = 'idle'): FeedPane {
  return {
    id,
    name: id,
    kind: 'claude',
    status,
    title: null,
    lastPrompt: null,
    model: null,
    summary: null,
    lastActivity: 0
  }
}

function makeWorkspace(id: string, panes: FeedPane[]): FeedWorkspace {
  return { id, name: id, rootDir: `/home/dev/${id}`, panes }
}

function makeMachine(
  hostId: string,
  workspaces: FeedWorkspace[],
  online = true
): RemoteMachine {
  return {
    hostId,
    label: hostId,
    online,
    name: hostId,
    lastSeen: 0,
    feed: {
      workspaces,
      recents: [],
      updatedAt: 0,
      host: { name: hostId, version: '0.0.0', models: [] }
    }
  }
}

function makeStatus(machines: RemoteMachine[]): RemoteStatus {
  return { state: 'connected', machines, keysPersisted: true }
}

/** A Map-backed stand-in for `localStorage`. */
function makeStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key)
    },
    setItem: (key, value) => {
      entries.set(key, value)
    }
  }
}

describe('defaults', () => {
  it('starts local, with nothing selected and the link off', () => {
    const state = useRemote.getState()
    expect(state.mode).toBe('local')
    expect(state.selected).toBeNull()
    expect(state.status).toEqual({ state: 'off', machines: [], keysPersisted: true })
    expect(state.notices).toEqual([])
  })

  it('switches mode', () => {
    useRemote.getState().setMode('remote')
    expect(useRemote.getState().mode).toBe('remote')
  })
})

describe('findRemotePane', () => {
  const target = makePane('pane-b')
  const workspace = makeWorkspace('ws-2', [target])
  const status = makeStatus([
    makeMachine('host-1', [makeWorkspace('ws-1', [makePane('pane-a')]), workspace])
  ])

  it('finds the machine, workspace and pane a selection points at', () => {
    const found = findRemotePane(status, { hostId: 'host-1', paneId: 'pane-b' })
    expect(found?.machine.hostId).toBe('host-1')
    expect(found?.workspace).toBe(workspace)
    expect(found?.pane).toBe(target)
  })

  it('returns null for an unknown machine or pane', () => {
    expect(findRemotePane(status, { hostId: 'host-9', paneId: 'pane-b' })).toBeNull()
    expect(findRemotePane(status, { hostId: 'host-1', paneId: 'pane-z' })).toBeNull()
  })

  it('returns null for a machine that has no feed yet', () => {
    const bare = { ...makeMachine('host-1', []), feed: null }
    expect(findRemotePane(makeStatus([bare]), { hostId: 'host-1', paneId: 'pane-a' })).toBeNull()
  })
})

describe('waitingCount', () => {
  it('counts only panes that want attention', () => {
    const panes = [
      makePane('one', 'attention'),
      makePane('two', 'working'),
      makePane('three', 'attention'),
      makePane('four', 'done')
    ]
    expect(waitingCount(panes)).toBe(2)
    expect(waitingCount([])).toBe(0)
  })
})

describe('setStatus', () => {
  const selection = { hostId: 'host-1', paneId: 'pane-a' }
  const workspaces = [makeWorkspace('ws-1', [makePane('pane-a')])]

  it('clears the selection when its machine vanishes', () => {
    useRemote.getState().setStatus(makeStatus([makeMachine('host-1', workspaces)]))
    useRemote.getState().select(selection)
    useRemote.getState().setStatus(makeStatus([makeMachine('host-2', [])]))
    expect(useRemote.getState().selected).toBeNull()
  })

  it('keeps the selection while its machine is merely offline', () => {
    useRemote.getState().setStatus(makeStatus([makeMachine('host-1', workspaces)]))
    useRemote.getState().select(selection)
    const offline = makeStatus([makeMachine('host-1', workspaces, false)])
    useRemote.getState().setStatus(offline)
    expect(useRemote.getState().selected).toEqual(selection)
    expect(useRemote.getState().status).toBe(offline)
  })
})

describe('toggleFold', () => {
  it('folds and unfolds in memory without localStorage', () => {
    expect(globalThis.localStorage).toBeUndefined()
    useRemote.getState().toggleFold('host-1')
    expect(useRemote.getState().folded).toEqual({ 'host-1': true })
    useRemote.getState().toggleFold('host-1')
    expect(useRemote.getState().folded).toEqual({})
  })

  it('keeps working when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    })
    useRemote.getState().toggleFold('host-1/ws-1')
    expect(useRemote.getState().folded).toEqual({ 'host-1/ws-1': true })
  })

  it('round-trips through localStorage into a fresh store', async () => {
    vi.stubGlobal('localStorage', makeStorage())
    useRemote.getState().toggleFold('host-1')
    useRemote.getState().toggleFold('host-1/ws-1')
    useRemote.getState().toggleFold('host-1')

    vi.resetModules()
    const fresh = await import('./remote')
    expect(fresh.useRemote.getState().folded).toEqual({ 'host-1/ws-1': true })
  })

  it('ignores a corrupt stored value', async () => {
    const storage = makeStorage()
    storage.setItem('ada-remote-folded', '{not json')
    vi.stubGlobal('localStorage', storage)
    vi.resetModules()
    const fresh = await import('./remote')
    expect(fresh.useRemote.getState().folded).toEqual({})
  })
})

describe('notices', () => {
  it('queues notices first in, first out', () => {
    const kicked: RemoteNotice = { type: 'kicked', hostId: 'host-1', label: 'Desk' }
    const attached: RemoteNotice = { type: 'attached', hostId: 'host-1', paneId: 'pane-a', ok: true }
    useRemote.getState().pushNotice(kicked)
    useRemote.getState().pushNotice(attached)
    expect(useRemote.getState().notices).toEqual([kicked, attached])
    useRemote.getState().shiftNotice()
    expect(useRemote.getState().notices).toEqual([attached])
    useRemote.getState().shiftNotice()
    useRemote.getState().shiftNotice()
    expect(useRemote.getState().notices).toEqual([])
  })
})
