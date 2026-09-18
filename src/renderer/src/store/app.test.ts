import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { selectActiveWorkspace, useApp } from './app'
import { useRuntime } from './runtime'
import { hydrate, startPersistence } from './persist'

/**
 * A hand-rolled preload bridge. Only the members the store actually calls are
 * implemented; anything else would be dead weight, and a missing one shows up as
 * a loud TypeError rather than a silent pass.
 */
function makeApi(): Record<string, unknown> {
  return {
    platform: 'linux',
    killPty: vi.fn(),
    unregisterSession: vi.fn(),
    registerSession: vi.fn(),
    saveState: vi.fn(),
    saveArchive: vi.fn(),
    saveRecents: vi.fn(),
    saveSettings: vi.fn(),
    getSettings: vi.fn(async () => DEFAULT_SETTINGS),
    loadState: vi.fn(async () => null),
    loadArchive: vi.fn(async () => []),
    loadRecents: vi.fn(async () => []),
    onSettingsChanged: vi.fn(() => () => undefined)
  }
}

let mockApi = makeApi()

const appInitial = useApp.getState()
const runtimeInitial = useRuntime.getState()

beforeEach(() => {
  mockApi = makeApi()
  ;(globalThis as { window?: unknown }).window = { api: mockApi }
  useApp.setState({ ...appInitial }, true)
  useRuntime.setState({ ...runtimeInitial }, true)
})

const ROOT = '/home/dev/project'

/** Open ROOT and hand back the live workspace id. */
function openRoot(root = ROOT): string {
  useApp.getState().openWorkspace(root)
  const workspace = selectActiveWorkspace(useApp.getState())
  if (!workspace) throw new Error('no active workspace')
  return workspace.id
}

function workspaceById(id: string) {
  const workspace = useApp.getState().workspaces.find((candidate) => candidate.id === id)
  if (!workspace) throw new Error(`workspace ${id} is gone`)
  return workspace
}

describe('workspace lifecycle', () => {
  it('archives a closed workspace and kills every pane process', () => {
    const wsId = openRoot()
    const first = useApp.getState().addPane(wsId, { kind: 'claude' })
    const second = useApp.getState().addPane(wsId, { kind: 'terminal' })

    useApp.getState().closeWorkspace(wsId)

    const { archive, workspaces, activeWorkspaceId, view } = useApp.getState()
    expect(archive).toHaveLength(1)
    expect(archive[0].panes.map((pane) => pane.id)).toEqual([first, second])
    expect(mockApi.killPty).toHaveBeenCalledTimes(2)
    expect(mockApi.killPty).toHaveBeenCalledWith(first)
    expect(mockApi.unregisterSession).toHaveBeenCalledWith(second)
    expect(workspaces).toHaveLength(0)
    expect(activeWorkspaceId).toBeNull()
    expect(view).toBe('firstRun')
  })

  it('archives nothing when the closed workspace had no panes', () => {
    const wsId = openRoot()
    useApp.getState().closeWorkspace(wsId)
    expect(useApp.getState().archive).toHaveLength(0)
    expect(mockApi.saveArchive).not.toHaveBeenCalled()
  })

  it('offers the archive on reopen instead of creating a workspace', () => {
    const wsId = openRoot()
    useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().closeWorkspace(wsId)

    useApp.getState().openWorkspace(ROOT)

    const state = useApp.getState()
    expect(state.pendingRestore?.entry.rootDir).toBe(ROOT)
    expect(state.workspaces).toHaveLength(0)
    expect(state.activeWorkspaceId).toBeNull()
  })

  it('selects the already-open workspace when the same root is opened again', () => {
    const wsId = openRoot()
    useApp.getState().selectWorkspace(wsId)
    useApp.getState().openWorkspace(`${ROOT}/`)
    expect(useApp.getState().workspaces).toHaveLength(1)
    expect(useApp.getState().activeWorkspaceId).toBe(wsId)
    expect(useApp.getState().pendingRestore).toBeNull()
  })

  it('restores panes with their session ids and layout, consuming the entry', () => {
    const wsId = openRoot()
    const paneId = useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().setPaneSessionId(paneId, 'sess-1')
    const layoutBefore = workspaceById(wsId).layout
    useApp.getState().closeWorkspace(wsId)

    useApp.getState().openWorkspace(ROOT)
    useApp.getState().confirmRestore('restore')

    const restored = selectActiveWorkspace(useApp.getState())
    expect(restored?.panes).toHaveLength(1)
    expect(restored?.panes[0].id).toBe(paneId)
    expect(restored?.panes[0].sessionId).toBe('sess-1')
    expect(restored?.layout.assign).toEqual(layoutBefore.assign)
    expect(useApp.getState().archive).toHaveLength(0)
    expect(useApp.getState().pendingRestore).toBeNull()
  })

  it('keeps the archive entry when the user starts empty', () => {
    const wsId = openRoot()
    useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().closeWorkspace(wsId)

    useApp.getState().openWorkspace(ROOT)
    useApp.getState().confirmRestore('empty')

    const fresh = selectActiveWorkspace(useApp.getState())
    expect(fresh?.panes).toHaveLength(0)
    expect(fresh?.rootDir).toBe(ROOT)
    expect(useApp.getState().archive).toHaveLength(1)
  })

  it('creates and consumes nothing when the restore prompt is cancelled', () => {
    const wsId = openRoot()
    useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().closeWorkspace(wsId)

    useApp.getState().openWorkspace(ROOT)
    useApp.getState().confirmRestore('cancel')

    expect(useApp.getState().workspaces).toHaveLength(0)
    expect(useApp.getState().archive).toHaveLength(1)
    expect(useApp.getState().pendingRestore).toBeNull()
  })

  it('restores automatically when the setting says so', () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, restoreArchivesAutomatically: true } })
    const wsId = openRoot()
    useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().closeWorkspace(wsId)

    useApp.getState().openWorkspace(ROOT)

    expect(useApp.getState().pendingRestore).toBeNull()
    expect(selectActiveWorkspace(useApp.getState())?.panes).toHaveLength(1)
    expect(useApp.getState().archive).toHaveLength(0)
  })

  it('reorders workspaces', () => {
    const first = openRoot('/a')
    const second = openRoot('/b')
    const third = openRoot('/c')

    useApp.getState().reorderWorkspaces(0, 2)

    expect(useApp.getState().workspaces.map((workspace) => workspace.id)).toEqual([
      second,
      third,
      first
    ])
  })
})

describe('panes', () => {
  it('numbers default names and reuses gaps', () => {
    const wsId = openRoot()
    const first = useApp.getState().addPane(wsId, { kind: 'claude' })
    const second = useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().addPane(wsId, { kind: 'terminal' })
    expect(workspaceById(wsId).panes.map((pane) => pane.name)).toEqual([
      'Agent 1',
      'Agent 2',
      'Terminal 1'
    ])

    useApp.getState().closePane(first)
    const third = useApp.getState().addPane(wsId, { kind: 'claude' })
    expect(workspaceById(wsId).panes.find((pane) => pane.id === third)?.name).toBe('Agent 1')
    expect(second).not.toBe(third)
  })

  it('puts a pane in the named empty zone', () => {
    const wsId = openRoot()
    const first = useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().applyPreset(wsId, 'cols-2')
    const empty = workspaceById(wsId).layout.zones.find(
      (zone) => workspaceById(wsId).layout.assign[first] !== zone.id
    )
    expect(empty).toBeDefined()

    const second = useApp.getState().addPane(wsId, { kind: 'terminal' }, empty?.id)

    expect(workspaceById(wsId).layout.assign[second]).toBe(empty?.id)
  })

  it('focuses the existing viewer instead of opening a second one', () => {
    const wsId = openRoot()
    const first = useApp.getState().addPane(wsId, {
      kind: 'viewer',
      filePath: `${ROOT}/README.md`
    })
    const again = useApp.getState().addPane(wsId, {
      kind: 'viewer',
      filePath: `${ROOT}/README.md`
    })

    expect(again).toBe(first)
    expect(workspaceById(wsId).panes).toHaveLength(1)
    expect(workspaceById(wsId).focusedPaneId).toBe(first)
    expect(workspaceById(wsId).panes[0].name).toBe('README.md')
  })

  it('leaves the closed pane zone behind as an empty zone', () => {
    const wsId = openRoot()
    const first = useApp.getState().addPane(wsId, { kind: 'claude' })
    const second = useApp.getState().addPane(wsId, { kind: 'terminal' })
    const zoneCount = workspaceById(wsId).layout.zones.length
    const zoneOfSecond = workspaceById(wsId).layout.assign[second]

    useApp.getState().closePane(second)

    const layout = workspaceById(wsId).layout
    expect(layout.zones).toHaveLength(zoneCount)
    expect(layout.zones.some((zone) => zone.id === zoneOfSecond)).toBe(true)
    expect(layout.assign[second]).toBeUndefined()
    expect(workspaceById(wsId).focusedPaneId).toBe(first)
    expect(mockApi.killPty).toHaveBeenCalledWith(second)
  })

  it('clears the session and bumps the remount key on start fresh', () => {
    const wsId = openRoot()
    const paneId = useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().setPaneSessionId(paneId, 'sess-1')

    useApp.getState().startFresh(paneId)

    expect(workspaceById(wsId).panes[0].sessionId).toBeUndefined()
    expect(useRuntime.getState().remountKey[paneId]).toBe(1)
  })

  it('does not touch state when the session id is unchanged', () => {
    const wsId = openRoot()
    const paneId = useApp.getState().addPane(wsId, { kind: 'claude' })
    useApp.getState().setPaneSessionId(paneId, 'sess-1')
    const before = useApp.getState()

    useApp.getState().setPaneSessionId(paneId, 'sess-1')

    expect(useApp.getState()).toBe(before)
  })

  it('duplicates a pane without carrying its session over', () => {
    const wsId = openRoot()
    const paneId = useApp.getState().addPane(wsId, { kind: 'claude', accountId: 'acct-2' })
    useApp.getState().setPaneSessionId(paneId, 'sess-1')

    const copyId = useApp.getState().duplicatePane(paneId)

    const copy = workspaceById(wsId).panes.find((pane) => pane.id === copyId)
    expect(copy?.name).toBe('Agent 1 copy')
    expect(copy?.accountId).toBe('acct-2')
    expect(copy?.sessionId).toBeUndefined()
  })

  it('splits a pane into a new one beside it', () => {
    const wsId = openRoot()
    const first = useApp.getState().addPane(wsId, { kind: 'claude' })

    const second = useApp.getState().splitPane(first, 'right', { kind: 'terminal' })

    const layout = workspaceById(wsId).layout
    expect(layout.assign[second]).toBeDefined()
    expect(layout.assign[second]).not.toBe(layout.assign[first])
    expect(workspaceById(wsId).panes).toHaveLength(2)
  })
})

describe('persistence', () => {
  it('keeps session ids and repairs a dangling focused pane on hydrate', async () => {
    const persisted: PersistedState = {
      v: 1,
      workspaces: [
        {
          id: 'w_1',
          name: 'project',
          rootDir: ROOT,
          layout: { v: 2, snap: { cols: 12, rows: 12 }, zones: [], assign: {} },
          panes: [
            {
              id: 'p_1',
              name: 'Agent 1',
              kind: 'claude',
              cwd: ROOT,
              createdAt: 1,
              sessionId: 'sess-9'
            }
          ],
          explorer: { open: false, width: 240, expanded: [] },
          focusedPaneId: 'p_gone',
          maximizedPaneId: 'p_gone'
        },
        { id: 'w_2', name: 'no root', rootDir: '', layout: undefined, panes: [] } as never
      ],
      activeWorkspaceId: 'w_missing',
      sidebarCollapsed: true
    }
    mockApi.loadState = vi.fn(async () => persisted)

    await hydrate()

    const state = useApp.getState()
    expect(state.workspaces).toHaveLength(1)
    expect(state.workspaces[0].panes[0].sessionId).toBe('sess-9')
    expect(state.workspaces[0].focusedPaneId).toBeUndefined()
    expect(state.workspaces[0].maximizedPaneId).toBeUndefined()
    expect(state.workspaces[0].layout.assign.p_1).toBeDefined()
    expect(state.activeWorkspaceId).toBe('w_1')
    expect(state.sidebarCollapsed).toBe(true)
    expect(state.view).toBe('grid')
    expect(state.hydrated).toBe(true)
  })

  it('saves nothing before hydration and saves after it', () => {
    vi.useFakeTimers()
    try {
      const stop = startPersistence()

      openRoot()
      vi.advanceTimersByTime(1000)
      expect(mockApi.saveState).not.toHaveBeenCalled()

      useApp.setState({ hydrated: true })
      useApp.getState().toggleSidebar()
      vi.advanceTimersByTime(1000)
      expect(mockApi.saveState).toHaveBeenCalledTimes(1)
      expect(mockApi.saveState).toHaveBeenCalledWith(
        expect.objectContaining({ v: 1, sidebarCollapsed: true })
      )

      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
