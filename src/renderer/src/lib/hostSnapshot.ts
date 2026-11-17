import type { FeedLayout, FeedWorkbenchTask } from '../../../shared/relayProtocol'
import type {
  HostPane,
  HostSnapshot,
  Pane,
  PaneStatus,
  RecentWorkspace,
  SessionInfo,
  WorkbenchSnapshot,
  Workspace
} from '../../../shared/types'

/**
 * A fresh agent has no transcript until its first prompt is sent; for this
 * long after it was made, that reads as "starting" rather than "idle".
 */
const STARTING_WINDOW_MS = 60_000

/**
 * What the status engine knows about every pane, in the shape the publisher
 * reads it off the runtime store.
 */
export interface HostSnapshotInputs {
  workspaces: Workspace[]
  recents: RecentWorkspace[]
  status: Record<string, PaneStatus>
  sessions: Record<string, SessionInfo>
  lastActivity: Record<string, number>
  /** Workspace root → its workbench page; optional so callers without one need not say so. */
  workbench?: Record<string, WorkbenchSnapshot>
  now: number
}

/**
 * The phone's view of this machine, built from what the desktop is already
 * showing. Pure and deliberately lossy: no paths beyond the workspace root, no
 * session ids, no account ids — the snapshot leaves the machine, and nothing in
 * it should let the reader reach anything the page does not draw.
 *
 * A pane the engine has not resolved yet reads as `idle` rather than being left
 * out, so the phone's list always matches the desktop's sidebar one for one.
 */
export function buildHostSnapshot(inputs: HostSnapshotInputs): HostSnapshot {
  return {
    updatedAt: inputs.now,
    recents: inputs.recents.map((recent) => ({ name: recent.name, rootDir: recent.rootDir })),
    workspaces: inputs.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      rootDir: workspace.rootDir,
      layout: wireLayout(workspace),
      ...wireWorkbench(inputs.workbench?.[workspace.rootDir]),
      panes: workspace.panes.map((pane) => {
        const session = inputs.sessions[pane.id]
        const status = wireStatus(pane, inputs.status[pane.id] ?? 'idle', session, inputs.now)
        return {
          id: pane.id,
          name: pane.name,
          kind: pane.kind,
          status,
          ...(pane.color ? { color: pane.color } : {}),
          title: session?.title ?? null,
          lastPrompt: session?.lastPrompt ?? null,
          model: session?.model ?? pane.model ?? null,
          summary: summarise(pane, status, session),
          lastActivity: inputs.lastActivity[pane.id] ?? 0,
          ...(pane.tag ? { tag: pane.tag } : {})
        }
      })
    }))
  }
}

/**
 * The canvas, reduced to what a viewer needs to draw it: where each tile is and
 * which pane sits in it. Assignments to panes or zones that no longer exist are
 * dropped, so the reader never has to defend against them.
 */
function wireLayout(workspace: Workspace): FeedLayout {
  const zoneIds = new Set(workspace.layout.zones.map((zone) => zone.id))
  const paneIds = new Set(workspace.panes.map((pane) => pane.id))
  const assign: Record<string, string> = {}
  for (const [paneId, zoneId] of Object.entries(workspace.layout.assign)) {
    if (paneIds.has(paneId) && zoneIds.has(zoneId)) assign[paneId] = zoneId
  }
  return {
    zones: workspace.layout.zones.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
    assign,
    ...(workspace.focusedPaneId && paneIds.has(workspace.focusedPaneId)
      ? { focusedPaneId: workspace.focusedPaneId }
      : {}),
    ...(workspace.maximizedPaneId && paneIds.has(workspace.maximizedPaneId)
      ? { maximizedPaneId: workspace.maximizedPaneId }
      : {})
  }
}

/**
 * A workspace's workbench as list rows. Nothing from the page goes out but the
 * parsed text: no markup, no file names of its captures, only how many there are.
 */
function wireWorkbench(
  snapshot: WorkbenchSnapshot | undefined
): { workbench?: FeedWorkbenchTask[] } {
  if (!snapshot?.exists) return {}
  return {
    workbench: snapshot.sections.map((section) => ({
      agent: section.agent,
      title: section.title,
      status: section.status,
      now: section.now,
      question: section.question,
      progress: section.counts
        ? {
            done: section.counts.done,
            total: section.counts.done + section.counts.working + section.counts.queued
          }
        : null,
      captures: section.captures
    }))
  }
}

function wireStatus(
  pane: Pane,
  status: PaneStatus,
  session: SessionInfo | undefined,
  now: number
): HostPane['status'] {
  const fresh = pane.kind === 'claude' && !session && now - pane.createdAt < STARTING_WINDOW_MS
  return fresh && (status === 'idle' || status === 'working') ? 'starting' : status
}

/** The one line under a pane's name on the phone. */
function summarise(pane: Pane, status: HostPane['status'], session: SessionInfo | undefined): string | null {
  if (pane.kind !== 'claude') return null
  switch (status) {
    case 'starting':
      return 'Starting up'
    case 'attention':
      return 'Needs your answer'
    case 'exited':
      return 'Exited'
    default:
      return session?.title ?? session?.lastPrompt ?? null
  }
}
