/**
 * The bridge between the app store and the disk.
 *
 * `hydrate()` runs once at boot: it reads settings, state, archive and recents
 * in parallel and pours a SANITIZED version of them into the store. Sanitizing
 * is not paranoia — the state file is user-visible JSON, and a half-written or
 * hand-edited one must degrade into a working app rather than a crash. One thing
 * is explicitly never touched: a pane's `sessionId`. Resuming the conversation a
 * pane was having before the app was last quit IS the relaunch feature, and it
 * lives or dies by that field surviving the round trip verbatim.
 *
 * `startPersistence()` runs the other direction: a debounced save whenever the
 * persisted slice changes, plus a synchronous flush on window close so the last
 * few hundred milliseconds of work are never lost.
 */
import type { ExplorerState, Pane, Workspace } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { normalizeRecents } from '../lib/recents'
import { baseName, uid } from '../lib/ids'
import { isZones, reconcileZones } from '../lib/zones'
import { api, toPersisted, useApp } from './app'

/** How long writes are coalesced. Long enough to swallow a drag, short enough
 *  that a crash loses nothing anyone would notice. */
const SAVE_DEBOUNCE_MS = 400

const DEFAULT_GRID = { cols: 2, rows: 2 }

const DEFAULT_EXPLORER: ExplorerState = { open: false, width: 240, expanded: [] }

const PANE_KINDS = new Set(['claude', 'terminal', 'ssh', 'viewer'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

/** Keep a pane only if its identity is intact; everything else gets a default. */
function sanitizePane(raw: unknown, rootDir: string): Pane | null {
  if (!isRecord(raw)) return null
  const { id, kind } = raw
  if (typeof id !== 'string' || !id) return null
  if (typeof kind !== 'string' || !PANE_KINDS.has(kind)) return null
  const pane: Pane = {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Pane',
    kind: kind as Pane['kind'],
    cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : rootDir,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
  }
  if (typeof raw.sshHost === 'string') pane.sshHost = raw.sshHost
  if (typeof raw.filePath === 'string') pane.filePath = raw.filePath
  // never conditioned on anything else: this is the resume key
  if (typeof raw.sessionId === 'string') pane.sessionId = raw.sessionId
  if (typeof raw.accountId === 'string') pane.accountId = raw.accountId
  if (typeof raw.planMode === 'boolean') pane.planMode = raw.planMode
  if (typeof raw.color === 'string') pane.color = raw.color
  return pane
}

function sanitizeExplorer(raw: unknown): ExplorerState {
  if (!isRecord(raw)) return { ...DEFAULT_EXPLORER, expanded: [] }
  const expanded = Array.isArray(raw.expanded)
    ? raw.expanded.filter((path): path is string => typeof path === 'string')
    : []
  return {
    open: raw.open === true,
    width:
      typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width > 0
        ? raw.width
        : DEFAULT_EXPLORER.width,
    expanded
  }
}

/** A workspace without a root folder has nothing to be: it is dropped. */
function sanitizeWorkspace(raw: unknown): Workspace | null {
  if (!isRecord(raw)) return null
  const rootDir = typeof raw.rootDir === 'string' ? raw.rootDir.trim() : ''
  if (!rootDir) return null
  const panes = (Array.isArray(raw.panes) ? raw.panes : [])
    .map((pane) => sanitizePane(pane, rootDir))
    .filter((pane): pane is Pane => pane !== null)
  const paneIds = new Set(panes.map((pane) => pane.id))
  const workspace: Workspace = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('w'),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : baseName(rootDir),
    rootDir,
    layout: reconcileZones(
      isZones(raw.layout) ? raw.layout : undefined,
      panes.map((pane) => pane.id),
      DEFAULT_GRID
    ),
    panes,
    explorer: sanitizeExplorer(raw.explorer)
  }
  if (typeof raw.focusedPaneId === 'string' && paneIds.has(raw.focusedPaneId)) {
    workspace.focusedPaneId = raw.focusedPaneId
  }
  if (typeof raw.maximizedPaneId === 'string' && paneIds.has(raw.maximizedPaneId)) {
    workspace.maximizedPaneId = raw.maximizedPaneId
  }
  if (raw.collapsed === true) workspace.collapsed = true
  return workspace
}

export function sanitizeWorkspaces(raw: unknown): Workspace[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Workspace[] = []
  for (const row of raw) {
    const workspace = sanitizeWorkspace(row)
    if (!workspace || seen.has(workspace.id)) continue
    seen.add(workspace.id)
    out.push(workspace)
  }
  return out
}

/** Read everything off disk into the store. Safe to await before first paint. */
export async function hydrate(): Promise<void> {
  const bridge = api()
  if (!bridge) {
    useApp.setState({ hydrated: true, view: 'firstRun' })
    return
  }
  const [settings, persisted, archive, recents] = await Promise.all([
    bridge.getSettings(),
    bridge.loadState(),
    bridge.loadArchive(),
    bridge.loadRecents()
  ])

  const workspaces = sanitizeWorkspaces(persisted?.workspaces)
  const known = new Set(workspaces.map((workspace) => workspace.id))
  const savedActive = persisted?.activeWorkspaceId
  const activeWorkspaceId =
    savedActive && known.has(savedActive) ? savedActive : (workspaces[0]?.id ?? null)

  useApp.setState({
    settings: settings ?? DEFAULT_SETTINGS,
    archive: Array.isArray(archive) ? archive : [],
    recents: normalizeRecents(recents),
    workspaces,
    activeWorkspaceId,
    sidebarCollapsed: persisted?.sidebarCollapsed === true,
    view: workspaces.length === 0 ? 'firstRun' : 'grid',
    hydrated: true
  })
}

/**
 * Start writing changes back. Returns a teardown that flushes anything pending,
 * so a hot reload does not strand an unsaved edit.
 */
export function startPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!dirty) return
    dirty = false
    const state = useApp.getState()
    if (!state.hydrated) return
    api()?.saveState(toPersisted(state))
  }

  const unsubscribeState = useApp.subscribe((state, previous) => {
    // Saving before hydration would write an empty state over a real file.
    if (!state.hydrated) return
    const changed =
      state.workspaces !== previous.workspaces ||
      state.activeWorkspaceId !== previous.activeWorkspaceId ||
      state.sidebarCollapsed !== previous.sidebarCollapsed
    if (!changed) return
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS)
  })

  const unsubscribeSettings = api()?.onSettingsChanged((settings) => {
    useApp.getState().setSettings(settings)
  })

  // Outside a real browser window (unit tests) there is no unload to hook.
  const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (hasWindow) window.addEventListener('beforeunload', flush)

  return () => {
    flush()
    unsubscribeState()
    unsubscribeSettings?.()
    if (hasWindow) window.removeEventListener('beforeunload', flush)
  }
}
