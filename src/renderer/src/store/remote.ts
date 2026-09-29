/**
 * Remote mode's state: this desktop as a viewer of other machines through the
 * relay. Main owns the link and the keys; this store only mirrors what main
 * reports (`status`), what the user is looking at (`mode`, `selected`) and the
 * one-shot notices waiting for a toast.
 *
 * What is looked at is a WORKSPACE on a machine — its whole canvas is drawn —
 * with at most one pane of it holding the keyboard.
 *
 * Nothing here is persisted with the app state — a relaunch asks main again.
 * The one exception is which machines and workspaces the user folded in the
 * list, a pure view preference kept in `localStorage`. Every read and write of
 * it is guarded: storage can be absent (tests) or throw (a locked profile), and
 * folding must keep working in memory either way.
 *
 * Remote screens and output are deliberately NOT in here. They stream straight
 * into the terminal component; putting bytes in a store would be a render storm.
 */
import { create } from 'zustand'
import type { RemoteMachine, RemoteNotice, RemoteStatus } from '../../../shared/types'
import type { FeedPane, FeedWorkspace } from '../../../shared/relayProtocol'

const FOLDED_STORAGE_KEY = 'ada-remote-folded'

export type AppMode = 'local' | 'remote'

export interface RemoteSelection {
  hostId: string
  workspaceId: string
  /** The pane with the keyboard; null for a workspace with no pane picked. */
  paneId: string | null
}

/** A pane to look at; its workspace is found from the feed when not given. */
export interface RemotePaneRef {
  hostId: string
  paneId: string
  workspaceId?: string
}

export interface RemoteState {
  mode: AppMode
  setMode: (mode: AppMode) => void
  status: RemoteStatus
  /** Replaces the picture; drops the selection if its machine is gone from it. */
  setStatus: (status: RemoteStatus) => void
  selected: RemoteSelection | null
  /** Show a pane's workspace with that pane focused; null shows nothing. */
  select: (pane: RemotePaneRef | null) => void
  /** Show a workspace, focused where its own desktop has it focused. */
  selectWorkspace: (hostId: string, workspaceId: string) => void
  /** key: `hostId`, or `${hostId}/${workspaceId}` */
  folded: Record<string, boolean>
  toggleFold: (key: string) => void
  notices: RemoteNotice[]
  pushNotice: (notice: RemoteNotice) => void
  shiftNotice: () => void
}

export const DEFAULT_REMOTE_STATUS: RemoteStatus = {
  state: 'off',
  machines: [],
  keysPersisted: true
}

/* === fold persistence ======================================================= */

function isFoldRecord(value: unknown): value is Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'boolean')
}

function readStoredFolds(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(FOLDED_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isFoldRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeStoredFolds(folded: Record<string, boolean>): void {
  try {
    globalThis.localStorage?.setItem(FOLDED_STORAGE_KEY, JSON.stringify(folded))
  } catch {
    // Storage unavailable or full: the fold still holds for this session.
  }
}

/* === lookups ================================================================ */

/** The machine, workspace and pane a pane id points at, or null if any is gone. */
export function findRemotePane(
  status: RemoteStatus,
  ref: { hostId: string; paneId: string | null }
): { machine: RemoteMachine; workspace: FeedWorkspace; pane: FeedPane } | null {
  if (ref.paneId === null) return null
  const machine = status.machines.find((candidate) => candidate.hostId === ref.hostId)
  if (!machine?.feed) return null
  for (const workspace of machine.feed.workspaces) {
    const pane = workspace.panes.find((candidate) => candidate.id === ref.paneId)
    if (pane) return { machine, workspace, pane }
  }
  return null
}

/** The machine and workspace a selection shows, or null if either is gone. */
export function findRemoteWorkspace(
  status: RemoteStatus,
  ref: { hostId: string; workspaceId: string }
): { machine: RemoteMachine; workspace: FeedWorkspace } | null {
  const machine = status.machines.find((candidate) => candidate.hostId === ref.hostId)
  const workspace = machine?.feed?.workspaces.find((candidate) => candidate.id === ref.workspaceId)
  return machine && workspace ? { machine, workspace } : null
}

/** A pane that can be shown as a terminal: a file viewer has nothing to stream. */
export function isWatchable(pane: FeedPane): boolean {
  return pane.kind !== 'viewer'
}

/** How many panes are waiting on the user. */
export function waitingCount(panes: FeedPane[]): number {
  return panes.filter((pane) => pane.status === 'attention').length
}

function machineListed(status: RemoteStatus, hostId: string): boolean {
  return status.machines.some((machine) => machine.hostId === hostId)
}

function sameSelection(
  current: RemoteSelection | null,
  next: RemoteSelection | null
): boolean {
  if (current === null || next === null) return current === next
  return (
    current.hostId === next.hostId &&
    current.workspaceId === next.workspaceId &&
    current.paneId === next.paneId
  )
}

/* === the store ============================================================== */

export const useRemote = create<RemoteState>()((set, get) => ({
  mode: 'local',
  status: DEFAULT_REMOTE_STATUS,
  selected: null,
  folded: readStoredFolds(),
  notices: [],

  setMode: (mode) => {
    if (get().mode === mode) return
    set({ mode })
  },

  // An offline machine keeps its feed and stays listed, so its selection
  // survives; only a machine that vanished (forgotten, kicked) clears it.
  setStatus: (status) => {
    if (get().status === status) return
    const { selected } = get()
    const selectionGone = selected !== null && !machineListed(status, selected.hostId)
    set(selectionGone ? { status, selected: null } : { status })
  },

  select: (pane) => {
    let next: RemoteSelection | null = null
    if (pane) {
      const workspaceId =
        pane.workspaceId ?? findRemotePane(get().status, pane)?.workspace.id ?? null
      // A pane the feed does not list has no canvas to show it on.
      if (workspaceId === null) return
      next = { hostId: pane.hostId, workspaceId, paneId: pane.paneId }
    }
    if (sameSelection(get().selected, next)) return
    set({ selected: next })
  },

  selectWorkspace: (hostId, workspaceId) => {
    const found = findRemoteWorkspace(get().status, { hostId, workspaceId })
    if (!found) return
    const current = get().selected
    // Coming back to the workspace already shown keeps the pane in hand.
    if (current?.hostId === hostId && current.workspaceId === workspaceId) return
    const watchable = found.workspace.panes.filter(isWatchable)
    const focused = watchable.find((pane) => pane.id === found.workspace.layout?.focusedPaneId)
    const paneId = (focused ?? watchable[0])?.id ?? null
    set({ selected: { hostId, workspaceId, paneId } })
  },

  toggleFold: (key) => {
    const folded = { ...get().folded }
    if (folded[key]) delete folded[key]
    else folded[key] = true
    writeStoredFolds(folded)
    set({ folded })
  },

  pushNotice: (notice) => set((state) => ({ notices: [...state.notices, notice] })),

  shiftNotice: () => {
    if (get().notices.length === 0) return
    set((state) => ({ notices: state.notices.slice(1) }))
  }
}))
