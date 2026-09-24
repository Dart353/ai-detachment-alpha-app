/**
 * The app store: workspaces, their panes, their layouts, and the small amount of
 * chrome state (view, sidebar, toasts) that belongs with them. This is the
 * persisted half of the world — everything here survives a relaunch — while
 * `store/runtime.ts` holds what does not.
 *
 * Three rules hold throughout:
 *   • every update is immutable, so React sees real reference changes;
 *   • pane and workspace ids are globally unique, because the layout, the PTY
 *     manager and the archive all address panes by id;
 *   • a pane's `sessionId` is never dropped implicitly. It is what lets a
 *     restored or relaunched Claude pane resume its own conversation.
 *
 * Side effects (IPC saves, PTY kills) are fired from the actions rather than
 * from effects in components: closing a workspace has to archive it and kill its
 * processes as one atomic step, whether the click came from the sidebar, the
 * context menu or a hotkey.
 */
import { create } from 'zustand'
import type {
  ArchiveEntry,
  ExplorerState,
  Pane,
  PaneKind,
  PersistedState,
  RecentWorkspace,
  Settings,
  Workspace,
  ZoneLayout
} from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import type { Api } from '../../../shared/ipc'
import type { Toast } from '../components/ui/Toasts'
import { toastTtl } from '../components/ui/Toasts'
import {
  archiveKey,
  entryMatchesRoot,
  rehydrateWorkspace,
  removeArchive,
  snapshotWorkspace,
  upsertArchive
} from '../lib/archive'
import { rememberWorkspace } from '../lib/recents'
import { baseName, uid } from '../lib/ids'
import {
  applyPresetById,
  dropPaneOnZone,
  movePaneToZone,
  paneInZone,
  reconcileZones,
  splitForPane,
  zoneById,
  zonePaneIds,
  type Dir,
  spanPaneToZone
} from '../lib/zones'
import { getFocusFn, useRuntime } from './runtime'

/** Which top-level surface is on screen. */
export type AppView = 'grid' | 'settings' | 'firstRun' | 'addWorkspace'

/** What a caller may specify when spawning a pane; everything else is derived. */
export interface PaneInit {
  kind: PaneKind
  name?: string
  sshHost?: string
  filePath?: string
  planMode?: boolean
  accountId?: string
  cwd?: string
}

/** Everything the Add workspace screen decides; the store turns it into a workspace. */
export interface WorkspaceSpec {
  rootDir: string
  /** Blank means "name it after the folder". */
  name: string
  /** A ZONE_PRESETS id; unknown ids fall back to the single zone. */
  presetId: string
  /** One entry per zone of the preset, in reading order; null leaves the zone empty. */
  panes: (PaneInit | null)[]
}

export interface ToastOptions {
  kind?: Toast['kind']
  action?: Toast['action']
}

/** What the restore prompt is currently offering, if anything. */
export interface PendingRestore {
  entry: ArchiveEntry
}

/** The grid a workspace with more than one pane falls back to. */
const DEFAULT_GRID = { cols: 2, rows: 2 }

/** A brand-new workspace opens as a single full-canvas zone. */
const SINGLE_GRID = { cols: 1, rows: 1 }

const DEFAULT_EXPLORER: ExplorerState = { open: false, width: 240, expanded: [] }

export interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  sidebarCollapsed: boolean
  /** False until `hydrate()` has read the disk; nothing may be saved before it. */
  hydrated: boolean
  view: AppView
  zoneEditorOpen: boolean
  settings: Settings
  archive: ArchiveEntry[]
  recents: RecentWorkspace[]
  toasts: Toast[]
  pendingRestore: PendingRestore | null
  /** The folder the Add workspace screen opens with, when it was chosen elsewhere. */
  addWorkspaceRoot: string | null

  /* workspaces */
  openWorkspace: (rootDir: string) => void
  /** Show the Add workspace screen, optionally with a folder already chosen. */
  openAddWorkspace: (rootDir?: string) => void
  /** Leave the Add workspace screen without creating anything. */
  cancelAddWorkspace: () => void
  /** Create a workspace from the Add screen's choices; returns its id. */
  createWorkspace: (spec: WorkspaceSpec) => string
  confirmRestore: (choice: 'restore' | 'empty' | 'cancel') => void
  closeWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  reorderWorkspaces: (from: number, to: number) => void
  /** Sidebar order only: the grid mounts panes in creation order (see Grid). */
  reorderPanes: (wsId: string, from: number, to: number) => void
  selectWorkspace: (id: string) => void
  toggleWorkspaceCollapsed: (id: string) => void

  /* panes */
  addPane: (wsId: string, init: PaneInit, zoneId?: string) => string
  closePane: (paneId: string) => void
  renamePane: (paneId: string, name: string) => void
  setPaneColor: (paneId: string, color: string | undefined) => void
  setPaneSessionId: (paneId: string, sessionId: string | undefined) => void
  setPaneAccount: (paneId: string, accountId: string | undefined) => void
  startFresh: (paneId: string) => void
  duplicatePane: (paneId: string) => string
  focusPane: (paneId: string) => void
  toggleMaximize: (paneId: string) => void

  /* layout */
  applyLayout: (wsId: string, layout: ZoneLayout) => void
  applyPreset: (wsId: string, presetId: string) => void
  splitPane: (paneId: string, dir: 'right' | 'down', init?: Partial<PaneInit>) => string
  dropPane: (paneId: string, zoneId: string, side: Dir | null) => void
  /** Shift-drop: the pane's zone grows over the neighbour under the pointer. */
  spanPane: (paneId: string, zoneId: string) => void
  setExplorer: (wsId: string, partial: Partial<ExplorerState>) => void

  /* chrome */
  toggleSidebar: () => void
  setView: (view: AppView) => void
  setZoneEditorOpen: (open: boolean) => void

  /* settings, archive, recents, toasts */
  updateSettings: (partial: Partial<Settings>) => void
  setSettings: (settings: Settings) => void
  setArchive: (list: ArchiveEntry[]) => void
  deleteArchiveEntry: (key: string) => void
  clearRecents: () => void
  pushToast: (msg: string, opts?: ToastOptions) => string
  dismissToast: (id: string) => void
}

/**
 * The preload bridge, or undefined outside the app (unit tests, SSR). Every
 * call site is optional-chained, so the store is fully usable without it.
 */
export function api(): Api | undefined {
  return typeof window !== 'undefined' ? window.api : undefined
}

/** Replace one workspace, leaving the array's identity alone when it is absent. */
function mapWorkspace(
  workspaces: Workspace[],
  wsId: string,
  update: (workspace: Workspace) => Workspace
): Workspace[] {
  let touched = false
  const next = workspaces.map((workspace) => {
    if (workspace.id !== wsId) return workspace
    touched = true
    return update(workspace)
  })
  return touched ? next : workspaces
}

/** The workspace owning `paneId`, or undefined. */
function workspaceOfPane(workspaces: Workspace[], paneId: string): Workspace | undefined {
  return workspaces.find((workspace) => workspace.panes.some((pane) => pane.id === paneId))
}

/** A viewer pane is a file view, not a process; nothing to kill or unregister. */
function isProcessPane(pane: Pane): boolean {
  return pane.kind !== 'viewer'
}

/** Tear down a pane's process and its transcript registration. */
function teardownPane(pane: Pane): void {
  if (!isProcessPane(pane)) return
  const bridge = api()
  bridge?.killPty(pane.id)
  bridge?.unregisterSession(pane.id)
}

/**
 * The default label for a new pane: the kind's prefix plus the smallest free
 * number in this workspace, so closing "Agent 2" and spawning again reuses the
 * gap rather than marching on to "Agent 4".
 */
function defaultPaneName(workspace: Workspace, init: PaneInit): string {
  if (init.kind === 'ssh') return init.sshHost ?? 'ssh'
  if (init.kind === 'viewer') return baseName(init.filePath ?? 'file')
  const prefix = init.kind === 'claude' ? 'Agent' : 'Terminal'
  const taken = new Set<number>()
  const pattern = new RegExp(`^${prefix} (\\d+)$`)
  for (const pane of workspace.panes) {
    const match = pattern.exec(pane.name)
    if (match) taken.add(Number(match[1]))
  }
  let number = 1
  while (taken.has(number)) number += 1
  return `${prefix} ${number}`
}

/** A pane to focus once `paneId` is gone: the first one still placed. */
function nextFocus(workspace: Workspace, gone: string): string | undefined {
  const alive = new Set(workspace.panes.filter((pane) => pane.id !== gone).map((pane) => pane.id))
  const placed = zonePaneIds(workspace.layout).find((paneId) => alive.has(paneId))
  if (placed) return placed
  return workspace.panes.find((pane) => pane.id !== gone)?.id
}

/** Run `fn` on the next frame, or the next tick where there are no frames. */
function onNextFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn)
  else setTimeout(fn, 0)
}

function freshWorkspace(rootDir: string): Workspace {
  return {
    id: uid('w'),
    name: baseName(rootDir),
    rootDir,
    layout: reconcileZones(undefined, [], SINGLE_GRID),
    panes: [],
    explorer: { ...DEFAULT_EXPLORER, expanded: [] }
  }
}

export const useApp = create<AppState>()((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  sidebarCollapsed: false,
  hydrated: false,
  view: 'firstRun',
  zoneEditorOpen: false,
  addWorkspaceRoot: null,
  settings: DEFAULT_SETTINGS,
  archive: [],
  recents: [],
  toasts: [],
  pendingRestore: null,

  /* === workspaces ========================================================== */

  openWorkspace: (rootDir) => {
    const state = get()
    const key = archiveKey(rootDir)
    const already = state.workspaces.find((workspace) => archiveKey(workspace.rootDir) === key)
    const name = already ? already.name : baseName(rootDir)
    const recents = rememberWorkspace(state.recents, { name, rootDir })
    api()?.saveRecents(recents)

    if (already) {
      set({ recents, activeWorkspaceId: already.id, view: 'grid' })
      return
    }

    const entry = state.archive.find((candidate) => entryMatchesRoot(candidate, rootDir))
    if (entry && !state.settings.restoreArchivesAutomatically) {
      // Nothing is created yet: the prompt decides what this folder becomes.
      set({ recents, pendingRestore: { entry } })
      return
    }

    if (entry) {
      const restored = rehydrateWorkspace(entry, uid('w'))
      const archive = removeArchive(state.archive, entry.key)
      api()?.saveArchive(archive)
      set({
        recents,
        archive,
        workspaces: [...state.workspaces, restored],
        activeWorkspaceId: restored.id,
        view: 'grid'
      })
      return
    }

    const workspace = freshWorkspace(rootDir)
    set({
      recents,
      workspaces: [...state.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      view: 'grid'
    })
  },

  openAddWorkspace: (rootDir) => {
    set({ view: 'addWorkspace', addWorkspaceRoot: rootDir ?? null })
  },

  cancelAddWorkspace: () => {
    set((state) => ({
      view: state.workspaces.length ? 'grid' : 'firstRun',
      addWorkspaceRoot: null
    }))
  },

  createWorkspace: (spec) => {
    const state = get()
    const key = archiveKey(spec.rootDir)
    const already = state.workspaces.find((workspace) => archiveKey(workspace.rootDir) === key)
    if (already) {
      // The folder is open: the honest result is that workspace, not a twin of it.
      set({ activeWorkspaceId: already.id, view: 'grid', addWorkspaceRoot: null })
      return already.id
    }

    const workspace = freshWorkspace(spec.rootDir)
    const name = spec.name.trim()
    if (name) workspace.name = name
    workspace.layout = applyPresetById(workspace.layout, spec.presetId, [])
    const recents = rememberWorkspace(state.recents, {
      name: workspace.name,
      rootDir: spec.rootDir
    })
    api()?.saveRecents(recents)
    set({
      recents,
      workspaces: [...state.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      view: 'grid',
      addWorkspaceRoot: null
    })

    // zonesFromRects mints zones in the preset's rect order, which is the order
    // the screen showed them in — so index i on screen is zones[i] here.
    const zones = workspace.layout.zones
    spec.panes.forEach((init, index) => {
      const zone = zones[index]
      if (init && zone) get().addPane(workspace.id, init, zone.id)
    })
    const first = get().workspaces.find((candidate) => candidate.id === workspace.id)
    const firstPane = first?.panes[0]
    if (firstPane) get().focusPane(firstPane.id)
    return workspace.id
  },

  confirmRestore: (choice) => {
    const state = get()
    const pending = state.pendingRestore
    if (!pending) return
    if (choice === 'cancel') {
      set({ pendingRestore: null })
      return
    }
    if (choice === 'empty') {
      // The archive entry stays: choosing an empty workspace now must not throw
      // those panes away, they are still offered next time.
      const workspace = freshWorkspace(pending.entry.rootDir)
      set({
        pendingRestore: null,
        workspaces: [...state.workspaces, workspace],
        activeWorkspaceId: workspace.id,
        view: 'grid'
      })
      return
    }
    const restored = rehydrateWorkspace(pending.entry, uid('w'))
    const archive = removeArchive(state.archive, pending.entry.key)
    api()?.saveArchive(archive)
    set({
      pendingRestore: null,
      archive,
      workspaces: [...state.workspaces, restored],
      activeWorkspaceId: restored.id,
      view: 'grid'
    })
  },

  closeWorkspace: (id) => {
    const state = get()
    const index = state.workspaces.findIndex((workspace) => workspace.id === id)
    if (index < 0) return
    const workspace = state.workspaces[index]

    // An empty workspace has nothing worth offering back, so it is not archived.
    let archive = state.archive
    if (workspace.panes.length > 0) {
      archive = upsertArchive(archive, snapshotWorkspace(workspace, Date.now()))
      api()?.saveArchive(archive)
    }

    const runtime = useRuntime.getState()
    for (const pane of workspace.panes) {
      teardownPane(pane)
      runtime.forgetPane(pane.id)
    }

    const recents = rememberWorkspace(state.recents, {
      name: workspace.name,
      rootDir: workspace.rootDir
    })
    api()?.saveRecents(recents)

    const workspaces = state.workspaces.filter((candidate) => candidate.id !== id)
    if (workspaces.length === 0) {
      set({ workspaces, archive, recents, activeWorkspaceId: null, view: 'firstRun' })
      return
    }
    const activeWorkspaceId =
      state.activeWorkspaceId === id
        ? (workspaces[index] ?? workspaces[workspaces.length - 1]).id
        : state.activeWorkspaceId
    set({ workspaces, archive, recents, activeWorkspaceId })
  },

  renameWorkspace: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    set((state) => ({
      workspaces: mapWorkspace(state.workspaces, id, (workspace) => ({
        ...workspace,
        name: trimmed
      }))
    }))
  },

  reorderWorkspaces: (from, to) => {
    set((state) => {
      const workspaces = [...state.workspaces]
      if (from < 0 || from >= workspaces.length) return state
      const target = Math.max(0, Math.min(workspaces.length - 1, to))
      if (target === from) return state
      const [moved] = workspaces.splice(from, 1)
      workspaces.splice(target, 0, moved)
      return { workspaces }
    })
  },

  reorderPanes: (wsId, from, to) => {
    set((state) => {
      const workspace = state.workspaces.find((candidate) => candidate.id === wsId)
      if (!workspace || from < 0 || from >= workspace.panes.length) return state
      const target = Math.max(0, Math.min(workspace.panes.length - 1, to))
      if (target === from) return state
      const panes = [...workspace.panes]
      const [moved] = panes.splice(from, 1)
      panes.splice(target, 0, moved)
      return { workspaces: mapWorkspace(state.workspaces, wsId, (current) => ({ ...current, panes })) }
    })
  },

  selectWorkspace: (id) => set({ activeWorkspaceId: id, view: 'grid' }),

  toggleWorkspaceCollapsed: (id) => {
    set((state) => ({
      workspaces: mapWorkspace(state.workspaces, id, (workspace) => ({
        ...workspace,
        collapsed: !workspace.collapsed
      }))
    }))
  },

  /* === panes =============================================================== */

  addPane: (wsId, init, zoneId) => {
    const state = get()
    const workspace = state.workspaces.find((candidate) => candidate.id === wsId)
    if (!workspace) return ''

    // One viewer per file: opening the same file again is a focus, not a pane.
    if (init.kind === 'viewer' && init.filePath) {
      const open = workspace.panes.find(
        (pane) => pane.kind === 'viewer' && pane.filePath === init.filePath
      )
      if (open) {
        get().focusPane(open.id)
        return open.id
      }
    }

    const pane: Pane = {
      id: uid('p'),
      name: init.name?.trim() || defaultPaneName(workspace, init),
      kind: init.kind,
      cwd: init.cwd ?? workspace.rootDir,
      createdAt: Date.now()
    }
    if (init.sshHost !== undefined) pane.sshHost = init.sshHost
    if (init.filePath !== undefined) pane.filePath = init.filePath
    if (init.planMode !== undefined) pane.planMode = init.planMode
    if (init.accountId !== undefined) pane.accountId = init.accountId

    const panes = [...workspace.panes, pane]
    const targetZone = zoneId ? zoneById(workspace.layout, zoneId) : undefined
    const layout =
      targetZone && !paneInZone(workspace.layout, targetZone.id)
        ? movePaneToZone(workspace.layout, pane.id, targetZone.id)
        : reconcileZones(
            workspace.layout,
            panes.map((existing) => existing.id),
            DEFAULT_GRID
          )

    set({
      workspaces: mapWorkspace(state.workspaces, wsId, (current) => ({
        ...current,
        panes,
        layout,
        focusedPaneId: pane.id
      })),
      activeWorkspaceId: wsId,
      view: 'grid'
    })
    return pane.id
  },

  closePane: (paneId) => {
    const state = get()
    const workspace = workspaceOfPane(state.workspaces, paneId)
    if (!workspace) return
    const pane = workspace.panes.find((candidate) => candidate.id === paneId)
    if (!pane) return

    teardownPane(pane)
    useRuntime.getState().forgetPane(paneId)

    // The zone stays behind as an EMPTY zone: closing a pane must not reshuffle
    // the canvas the user arranged, it leaves a hole to drop something new into.
    const assign = { ...workspace.layout.assign }
    delete assign[paneId]
    const focused =
      workspace.focusedPaneId === paneId ? nextFocus(workspace, paneId) : workspace.focusedPaneId

    set({
      workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
        ...current,
        panes: current.panes.filter((candidate) => candidate.id !== paneId),
        layout: { ...current.layout, assign },
        focusedPaneId: focused,
        maximizedPaneId:
          current.maximizedPaneId === paneId ? undefined : current.maximizedPaneId
      }))
    })
  },

  renamePane: (paneId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    set((state) => ({
      workspaces: state.workspaces.map((workspace) => ({
        ...workspace,
        panes: workspace.panes.map((pane) =>
          pane.id === paneId ? { ...pane, name: trimmed } : pane
        )
      }))
    }))
  },

  setPaneColor: (paneId, color) => {
    set((state) => {
      const workspace = workspaceOfPane(state.workspaces, paneId)
      if (!workspace) return state
      return {
        workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
          ...current,
          panes: current.panes.map((pane) => {
            if (pane.id !== paneId) return pane
            const next = { ...pane }
            if (color === undefined) delete next.color
            else next.color = color
            return next
          })
        }))
      }
    })
  },

  setPaneSessionId: (paneId, sessionId) => {
    // The transcript watcher calls this on every tick; an unchanged value must
    // leave the state object untouched so nothing re-renders.
    set((state) => {
      const workspace = workspaceOfPane(state.workspaces, paneId)
      if (!workspace) return state
      const pane = workspace.panes.find((candidate) => candidate.id === paneId)
      if (!pane || pane.sessionId === sessionId) return state
      return {
        workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
          ...current,
          panes: current.panes.map((candidate) => {
            if (candidate.id !== paneId) return candidate
            const next = { ...candidate }
            if (sessionId === undefined) delete next.sessionId
            else next.sessionId = sessionId
            return next
          })
        }))
      }
    })
  },

  setPaneAccount: (paneId, accountId) => {
    set((state) => {
      const workspace = workspaceOfPane(state.workspaces, paneId)
      if (!workspace) return state
      return {
        workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
          ...current,
          panes: current.panes.map((pane) => {
            if (pane.id !== paneId) return pane
            const next = { ...pane }
            if (accountId === undefined) delete next.accountId
            else next.accountId = accountId
            return next
          })
        }))
      }
    })
    // A different account is a different ~/.claude: the old transcript is not
    // resumable under it, so the pane starts over.
    get().startFresh(paneId)
  },

  startFresh: (paneId) => {
    set((state) => {
      const workspace = workspaceOfPane(state.workspaces, paneId)
      if (!workspace) return state
      return {
        workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
          ...current,
          panes: current.panes.map((pane) => {
            if (pane.id !== paneId) return pane
            const next = { ...pane }
            delete next.sessionId
            return next
          })
        }))
      }
    })
    useRuntime.getState().resetPane(paneId)
  },

  duplicatePane: (paneId) => {
    const state = get()
    const workspace = workspaceOfPane(state.workspaces, paneId)
    if (!workspace) return ''
    const pane = workspace.panes.find((candidate) => candidate.id === paneId)
    if (!pane) return ''
    const init: PaneInit = { kind: pane.kind, name: `${pane.name} copy`, cwd: pane.cwd }
    if (pane.sshHost !== undefined) init.sshHost = pane.sshHost
    if (pane.planMode !== undefined) init.planMode = pane.planMode
    if (pane.accountId !== undefined) init.accountId = pane.accountId
    return get().addPane(workspace.id, init)
  },

  focusPane: (paneId) => {
    const state = get()
    const workspace = workspaceOfPane(state.workspaces, paneId)
    if (!workspace) return
    set({
      activeWorkspaceId: workspace.id,
      view: 'grid',
      workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
        ...current,
        focusedPaneId: paneId,
        // The sidebar highlights the focused pane's row; a folded workspace
        // would hide that row, so focusing a pane unfolds its workspace.
        collapsed: false,
        // Focusing a pane hidden behind another's maximize means "show me this
        // one" — the only sane reading is to drop the maximize.
        maximizedPaneId:
          current.maximizedPaneId && current.maximizedPaneId !== paneId
            ? undefined
            : current.maximizedPaneId
      }))
    })
    useRuntime.getState().setUnseenDone(paneId, false)
    // The terminal has to be told to take the cursor, and only once the pane it
    // lives in has actually been laid out — hence the next frame. By then a
    // later call may have moved focus elsewhere, so the request is checked
    // again before it fires: an out-of-date one that still ran would pull DOM
    // focus onto its pane, whose focusin handler would call back in here and
    // queue the other pane, and the two would trade the cursor once per frame
    // for as long as the window stayed open.
    onNextFrame(() => {
      const current = workspaceOfPane(get().workspaces, paneId)
      if (current?.focusedPaneId !== paneId) return
      getFocusFn(paneId)?.()
    })
  },

  toggleMaximize: (paneId) => {
    set((state) => {
      const workspace = workspaceOfPane(state.workspaces, paneId)
      if (!workspace) return state
      return {
        workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
          ...current,
          maximizedPaneId: current.maximizedPaneId === paneId ? undefined : paneId
        }))
      }
    })
  },

  /* === layout ============================================================== */

  applyLayout: (wsId, layout) => {
    set((state) => ({
      workspaces: mapWorkspace(state.workspaces, wsId, (workspace) => ({ ...workspace, layout }))
    }))
  },

  applyPreset: (wsId, presetId) => {
    set((state) => ({
      workspaces: mapWorkspace(state.workspaces, wsId, (workspace) => ({
        ...workspace,
        layout: applyPresetById(
          workspace.layout,
          presetId,
          workspace.panes.map((pane) => pane.id)
        )
      }))
    }))
  },

  splitPane: (paneId, dir, init) => {
    const state = get()
    const workspace = workspaceOfPane(state.workspaces, paneId)
    if (!workspace) return ''
    const split = splitForPane(workspace.layout, paneId, dir)
    if (!split) return ''
    get().applyLayout(workspace.id, split.layout)
    return get().addPane(
      workspace.id,
      { ...init, kind: init?.kind ?? state.settings.defaultPaneKind },
      split.zoneId
    )
  },

  dropPane: (paneId, zoneId, side) => {
    set((state) => {
      const workspace = workspaceOfPane(state.workspaces, paneId)
      if (!workspace) return state
      return {
        workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
          ...current,
          layout: dropPaneOnZone(current.layout, paneId, zoneId, side)
        }))
      }
    })
  },

  spanPane: (paneId, zoneId) => {
    set((state) => {
      const workspace = workspaceOfPane(state.workspaces, paneId)
      if (!workspace) return state
      return {
        workspaces: mapWorkspace(state.workspaces, workspace.id, (current) => ({
          ...current,
          // A pane the span unseated is placed again straight away, so no
          // pane is ever left without a tile between two renders.
          layout: reconcileZones(
            spanPaneToZone(current.layout, paneId, zoneId),
            current.panes.map((pane) => pane.id),
            SINGLE_GRID
          )
        }))
      }
    })
  },

  setExplorer: (wsId, partial) => {
    set((state) => ({
      workspaces: mapWorkspace(state.workspaces, wsId, (workspace) => ({
        ...workspace,
        explorer: { ...workspace.explorer, ...partial }
      }))
    }))
  },

  /* === chrome ============================================================== */

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setView: (view) => set({ view }),
  setZoneEditorOpen: (zoneEditorOpen) => set({ zoneEditorOpen }),

  /* === settings, archive, recents, toasts ================================== */

  updateSettings: (partial) => {
    // Optimistic: the UI must not wait a round trip to show the new value, and
    // main echoes the merged result back through `onSettingsChanged`.
    set((state) => ({ settings: { ...state.settings, ...partial } }))
    api()?.saveSettings(partial)
  },

  setSettings: (settings) => set({ settings }),

  setArchive: (archive) => set({ archive }),

  deleteArchiveEntry: (key) => {
    const archive = removeArchive(get().archive, key)
    api()?.saveArchive(archive)
    set({ archive })
  },

  clearRecents: () => {
    api()?.saveRecents([])
    set({ recents: [] })
  },

  pushToast: (msg, opts) => {
    const toast: Toast = { id: uid('t'), msg, kind: opts?.kind ?? 'info' }
    if (opts?.action) toast.action = opts.action
    set((state) => ({ toasts: [...state.toasts, toast] }))
    setTimeout(() => get().dismissToast(toast.id), toastTtl(toast))
    return toast.id
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  }
}))

/* === selectors ============================================================== */

export function selectActiveWorkspace(state: AppState): Workspace | null {
  if (!state.activeWorkspaceId) return null
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null
}

export function findPane(state: AppState, paneId: string): { ws: Workspace; pane: Pane } | null {
  for (const workspace of state.workspaces) {
    const pane = workspace.panes.find((candidate) => candidate.id === paneId)
    if (pane) return { ws: workspace, pane }
  }
  return null
}

/** The state as it goes to disk — one place, so the shape can never drift. */
export function toPersisted(state: AppState): PersistedState {
  return {
    v: 1,
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    sidebarCollapsed: state.sidebarCollapsed
  }
}
