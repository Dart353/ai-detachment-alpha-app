import { describe, expect, it } from 'vitest'
import type { SessionInfo, Workspace } from '../../../shared/types'
import { buildHostSnapshot } from './hostSnapshot'

const layout = { v: 2 as const, snap: { cols: 12, rows: 8 }, zones: [], assign: {} }
const explorer = { open: false, width: 240, expanded: [] }

const workspace: Workspace = {
  id: 'ws1',
  name: 'api',
  rootDir: '/home/me/dev/api',
  layout,
  explorer,
  panes: [
    {
      id: 'p1',
      name: 'agent',
      kind: 'claude',
      cwd: '/home/me/dev/api',
      createdAt: 1,
      sessionId: 'sess-secret',
      accountId: 'work',
      color: '#8be'
    },
    { id: 'p2', name: 'shell', kind: 'terminal', cwd: '/home/me/dev/api', createdAt: 2 }
  ]
}

const session: SessionInfo = {
  paneId: 'p1',
  sessionId: 'sess-secret',
  title: 'Fix the login bug',
  lastPrompt: 'why does login 500',
  model: 'opus',
  permissionMode: null,
  gitBranch: 'main',
  jsonlStatus: 'turn-idle',
  turnState: 'ended',
  lastWriteMs: 50
}

describe('buildHostSnapshot', () => {
  it('carries the status, transcript facts and colour per pane', () => {
    const snapshot = buildHostSnapshot({
      workspaces: [workspace],
      status: { p1: 'attention', p2: 'idle' },
      sessions: { p1: session },
      lastActivity: { p1: 90 },
      now: 100
    })
    expect(snapshot.updatedAt).toBe(100)
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.workspaces[0]).toMatchObject({ id: 'ws1', name: 'api', rootDir: '/home/me/dev/api' })
    expect(snapshot.workspaces[0].panes[0]).toEqual({
      id: 'p1',
      name: 'agent',
      kind: 'claude',
      status: 'attention',
      color: '#8be',
      title: 'Fix the login bug',
      lastPrompt: 'why does login 500',
      model: 'opus',
      lastActivity: 90
    })
  })

  it('defaults an unresolved pane to idle and never drops it', () => {
    const snapshot = buildHostSnapshot({
      workspaces: [workspace],
      status: {},
      sessions: {},
      lastActivity: {},
      now: 1
    })
    expect(snapshot.workspaces[0].panes.map((pane) => pane.status)).toEqual(['idle', 'idle'])
    expect(snapshot.workspaces[0].panes[1]).toEqual({
      id: 'p2',
      name: 'shell',
      kind: 'terminal',
      status: 'idle',
      title: null,
      lastPrompt: null,
      model: null,
      lastActivity: 0
    })
  })

  it('leaks no session, account or cwd', () => {
    const text = JSON.stringify(
      buildHostSnapshot({
        workspaces: [workspace],
        status: {},
        sessions: { p1: session },
        lastActivity: {},
        now: 1
      })
    )
    expect(text).not.toContain('sess-secret')
    expect(text).not.toContain('"work"')
    expect(text).not.toContain('cwd')
  })
})
