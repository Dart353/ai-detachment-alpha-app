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
      recents: [{ name: 'api', rootDir: '/home/me/dev/api', lastOpenedAt: 5 }],
      status: { p1: 'attention', p2: 'idle' },
      sessions: { p1: session },
      lastActivity: { p1: 90 },
      now: 100
    })
    expect(snapshot.updatedAt).toBe(100)
    expect(snapshot.recents).toEqual([{ name: 'api', rootDir: '/home/me/dev/api' }])
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
      summary: 'Needs your answer',
      lastActivity: 90
    })
  })

  it('summarises a working agent by its title, falling back to the last prompt', () => {
    const build = (status: 'working' | 'done', over: Partial<SessionInfo>): string | null =>
      buildHostSnapshot({
        workspaces: [workspace],
        recents: [],
        status: { p1: status },
        sessions: { p1: { ...session, ...over } },
        lastActivity: {},
        now: 100
      }).workspaces[0].panes[0].summary
    expect(build('working', {})).toBe('Fix the login bug')
    expect(build('done', { title: null })).toBe('why does login 500')
    expect(build('working', { title: null, lastPrompt: null })).toBeNull()
  })

  it('reads a fresh agent with no transcript as starting, briefly', () => {
    const fresh: Workspace = {
      ...workspace,
      panes: [{ id: 'p3', name: 'new', kind: 'claude', cwd: '/x', createdAt: 1000, model: 'sonnet' }]
    }
    const at = (now: number, status: 'idle' | 'working' | 'attention'): { status: string; summary: string | null; model: string | null } => {
      const pane = buildHostSnapshot({
        workspaces: [fresh],
        recents: [],
        status: { p3: status },
        sessions: {},
        lastActivity: {},
        now
      }).workspaces[0].panes[0]
      return { status: pane.status, summary: pane.summary, model: pane.model }
    }
    expect(at(2000, 'idle')).toEqual({ status: 'starting', summary: 'Starting up', model: 'sonnet' })
    expect(at(2000, 'working').status).toBe('starting')
    expect(at(2000, 'attention').status).toBe('attention')
    expect(at(1000 + 60_000, 'idle').status).toBe('idle')
  })

  it('defaults an unresolved pane to idle and never drops it', () => {
    const snapshot = buildHostSnapshot({
      workspaces: [workspace],
      recents: [],
      status: {},
      sessions: {},
      lastActivity: {},
      now: 1
    })
    // p1 is a claude pane made a moment ago with no transcript yet: starting.
    expect(snapshot.workspaces[0].panes.map((pane) => pane.status)).toEqual(['starting', 'idle'])
    expect(snapshot.workspaces[0].panes[1]).toEqual({
      id: 'p2',
      name: 'shell',
      kind: 'terminal',
      status: 'idle',
      title: null,
      lastPrompt: null,
      model: null,
      summary: null,
      lastActivity: 0
    })
  })

  it('leaks no session, account or cwd', () => {
    const text = JSON.stringify(
      buildHostSnapshot({
        workspaces: [workspace],
        recents: [],
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
