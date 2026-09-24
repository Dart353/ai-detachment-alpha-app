import type {
  HostPane,
  HostSnapshot,
  Pane,
  PaneStatus,
  RecentWorkspace,
  SessionInfo,
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
          lastActivity: inputs.lastActivity[pane.id] ?? 0
        }
      })
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
