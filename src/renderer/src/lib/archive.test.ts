import { describe, expect, it } from 'vitest'
import type { ArchiveEntry, Workspace } from '../../../shared/types'
import {
  archiveKey,
  entryMatchesRoot,
  normalizeRoot,
  rehydrateWorkspace,
  removeArchive,
  snapshotWorkspace,
  summarizeArchive,
  upsertArchive
} from './archive'

function workspace(): Workspace {
  return {
    id: 'ws-old',
    name: 'Alpha',
    rootDir: '/home/me/Alpha',
    layout: {
      v: 2,
      snap: { cols: 12, rows: 12 },
      zones: [{ id: 'zone-1', x: 0, y: 0, w: 50, h: 100 }],
      assign: { 'pane-1': 'zone-1' }
    },
    panes: [
      {
        id: 'pane-1',
        name: 'Agent',
        kind: 'claude',
        cwd: '/home/me/Alpha',
        createdAt: 10,
        sessionId: 'abcdef12-3456',
        accountId: 'default',
        planMode: true,
        color: '#ff0000'
      },
      {
        id: 'pane-2',
        name: 'box',
        kind: 'ssh',
        cwd: '/home/me/Alpha',
        createdAt: 20,
        sshHost: 'build-box'
      }
    ],
    explorer: { open: true, width: 260, expanded: ['/home/me/Alpha/src'] },
    focusedPaneId: 'pane-1',
    maximizedPaneId: 'pane-2'
  }
}

describe('normalizeRoot', () => {
  it('is spelling-insensitive without conflating folders', () => {
    expect(normalizeRoot(' /home/me/proj/ ')).toBe('/home/me/proj')
    expect(normalizeRoot('C:\\Users\\me\\proj\\')).toBe('C:/Users/me/proj')
    expect(normalizeRoot('/')).toBe('/')
    expect(normalizeRoot('C:')).toBe('C:/')
  })
})

describe('archiveKey', () => {
  it('case-folds on darwin and win32 only', () => {
    expect(archiveKey('/home/me/Proj', 'darwin')).toBe('/home/me/proj')
    expect(archiveKey('C:\\Users\\Me\\Proj', 'win32')).toBe('c:/users/me/proj')
    expect(archiveKey('/home/me/Proj', 'linux')).toBe('/home/me/Proj')
    expect(archiveKey('/home/me/Proj/', 'linux')).toBe(archiveKey('/home/me/Proj', 'linux'))
  })
})

describe('entryMatchesRoot', () => {
  it('rejects a case-fold collision on a case-sensitive volume', () => {
    const entry = snapshotWorkspace(workspace(), 100, 'darwin')
    expect(entryMatchesRoot(entry, '/home/me/Alpha/', 'darwin')).toBe(true)
    expect(entryMatchesRoot(entry, '/home/me/alpha', 'darwin')).toBe(false)
    expect(entryMatchesRoot(entry, '/home/me/Beta', 'darwin')).toBe(false)
  })
})

describe('snapshot → rehydrate', () => {
  it('round-trips panes, layout and explorer under a fresh workspace id', () => {
    const live = workspace()
    const entry = snapshotWorkspace(live, 4242, 'linux')
    expect(entry).toMatchObject({ key: '/home/me/Alpha', rootDir: '/home/me/Alpha', archivedAt: 4242 })

    const restored = rehydrateWorkspace(entry, 'ws-new')
    expect(restored.id).toBe('ws-new')
    expect(restored.name).toBe(live.name)
    expect(restored.rootDir).toBe(live.rootDir)
    expect(restored.panes).toEqual(live.panes)
    expect(restored.layout).toEqual(live.layout)
    expect(restored.explorer).toEqual(live.explorer)
    // view state is not content: a restored workspace starts unfocused
    expect(restored.focusedPaneId).toBeUndefined()
    expect(restored.maximizedPaneId).toBeUndefined()
    // pane ids survive, so the layout's assignments still resolve
    expect(Object.keys(restored.layout.assign).every((id) =>
      restored.panes.some((pane) => pane.id === id)
    )).toBe(true)
  })

  it('copies deeply, so later edits to the live workspace never reach the archive', () => {
    const live = workspace()
    const entry = snapshotWorkspace(live, 1, 'linux')
    live.panes[0].name = 'renamed'
    live.layout.zones[0].w = 10
    live.explorer.expanded.push('/home/me/Alpha/docs')
    expect(entry.panes[0].name).toBe('Agent')
    expect(entry.layout.zones[0].w).toBe(50)
    expect(entry.explorer.expanded).toEqual(['/home/me/Alpha/src'])
  })
})

describe('summarizeArchive', () => {
  it('describes an entry without exposing its panes', () => {
    const entry = snapshotWorkspace(workspace(), 7, 'linux')
    expect(summarizeArchive(entry)).toEqual({
      name: 'Alpha',
      rootDir: '/home/me/Alpha',
      archivedAt: 7,
      paneCount: 2,
      panes: [
        { name: 'Agent', kind: 'claude' },
        { name: 'box', kind: 'ssh' }
      ]
    })
  })
})

describe('upsertArchive / removeArchive', () => {
  const entryFor = (key: string, archivedAt: number): ArchiveEntry => ({
    key,
    rootDir: key,
    name: key,
    archivedAt,
    layout: { v: 2, snap: { cols: 12, rows: 12 }, zones: [], assign: {} },
    panes: [],
    explorer: { open: false, width: 240, expanded: [] }
  })

  it('replaces the entry with the same key and keeps the newest first', () => {
    const list = upsertArchive([entryFor('/a', 1)], entryFor('/b', 2))
    expect(list.map((e) => e.key)).toEqual(['/b', '/a'])
    const replaced = upsertArchive(list, entryFor('/a', 3))
    expect(replaced.map((e) => e.key)).toEqual(['/a', '/b'])
    expect(replaced[0].archivedAt).toBe(3)
  })

  it('removes by key', () => {
    const list = [entryFor('/a', 1), entryFor('/b', 2)]
    expect(removeArchive(list, '/a').map((e) => e.key)).toEqual(['/b'])
    expect(removeArchive(list, '/missing')).toHaveLength(2)
  })
})
