import { describe, expect, it } from 'vitest'
import type { ArchiveEntry, Pane, PersistedState, Workspace } from '../shared/types'
import {
  normalizeArchivePaths,
  normalizeRecentPaths,
  normalizeStatePaths,
  wslShareToLinux
} from './wslPaths'

/** The form the explorer produced: a share root with posix children joined on. */
const SHARE_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\redsky'
const MIXED = `${SHARE_ROOT}/openShop`

describe('wslShareToLinux', () => {
  it('turns a share path with mixed separators into the Linux path', () => {
    expect(wslShareToLinux(MIXED)).toBe('/home/me/redsky/openShop')
  })

  it('handles the legacy wsl$ share, forward slashes and a trailing separator', () => {
    expect(wslShareToLinux('\\\\wsl$\\Debian\\srv\\app\\')).toBe('/srv/app')
    expect(wslShareToLinux('//wsl.localhost/Ubuntu/home/me')).toBe('/home/me')
    expect(wslShareToLinux('\\\\WSL.LOCALHOST\\Ubuntu')).toBe('/')
  })

  it('leaves Linux, drive and other UNC paths alone', () => {
    expect(wslShareToLinux('/home/me/app')).toBe('/home/me/app')
    expect(wslShareToLinux('C:\\work\\app')).toBe('C:\\work\\app')
    expect(wslShareToLinux('\\\\server\\share\\app')).toBe('\\\\server\\share\\app')
  })
})

function pane(over: Partial<Pane>): Pane {
  return { id: 'p1', name: 'Agent 1', kind: 'claude', cwd: MIXED, createdAt: 1, ...over }
}

function workspace(over: Partial<Workspace>): Workspace {
  return {
    id: 'w1',
    name: 'Open Shop',
    rootDir: MIXED,
    layout: { v: 2, snap: { cols: 1, rows: 1 }, zones: [], assign: {} },
    panes: [pane({})],
    explorer: { open: true, width: 240, expanded: [`${MIXED}/src`] },
    ...over
  } as Workspace
}

describe('normalizeStatePaths', () => {
  it('rewrites roots, pane folders, viewer files and expanded folders', () => {
    const state: PersistedState = {
      v: 1,
      workspaces: [
        workspace({
          panes: [pane({}), pane({ id: 'p2', kind: 'viewer', filePath: `${MIXED}/README.md` })]
        })
      ],
      activeWorkspaceId: 'w1',
      sidebarCollapsed: false
    } as PersistedState
    const [ws] = normalizeStatePaths(state).workspaces
    expect(ws.rootDir).toBe('/home/me/redsky/openShop')
    expect(ws.panes.map((p) => p.cwd)).toEqual(['/home/me/redsky/openShop', '/home/me/redsky/openShop'])
    expect(ws.panes[1].filePath).toBe('/home/me/redsky/openShop/README.md')
    expect(ws.explorer.expanded).toEqual(['/home/me/redsky/openShop/src'])
  })

  it('keeps the session id it rewrites around', () => {
    const state = { v: 1, workspaces: [workspace({ panes: [pane({ sessionId: 'abc' })] })] } as PersistedState
    expect(normalizeStatePaths(state).workspaces[0].panes[0].sessionId).toBe('abc')
  })

  it('returns the same object when nothing needs changing', () => {
    const state = {
      v: 1,
      workspaces: [
        workspace({
          rootDir: '/a',
          panes: [pane({ cwd: '/a' })],
          explorer: { open: false, width: 240, expanded: [] }
        })
      ]
    } as PersistedState
    expect(normalizeStatePaths(state)).toBe(state)
  })
})

describe('normalizeArchivePaths', () => {
  it('re-keys a migrated entry the way the renderer looks it up on Windows', () => {
    const entry = { ...workspace({}), key: MIXED.toLowerCase(), archivedAt: 1 } as unknown as ArchiveEntry
    const [migrated] = normalizeArchivePaths([entry])
    expect(migrated.rootDir).toBe('/home/me/redsky/openShop')
    expect(migrated.key).toBe('/home/me/redsky/openshop')
  })
})

describe('normalizeRecentPaths', () => {
  it('migrates and keeps one entry per folder, the newest', () => {
    const recents = normalizeRecentPaths([
      { rootDir: MIXED, name: 'newer', lastOpenedAt: 2 },
      { rootDir: '/home/me/redsky/openShop', name: 'older', lastOpenedAt: 1 }
    ] as never)
    expect(recents).toEqual([{ rootDir: '/home/me/redsky/openShop', name: 'newer', lastOpenedAt: 2 }])
  })
})
