import type {
  HostSnapshot,
  PaneStatus,
  SessionInfo,
  Workspace
} from '../../../shared/types'

/**
 * What the status engine knows about every pane, in the shape the publisher
 * reads it off the runtime store.
 */
export interface HostSnapshotInputs {
  workspaces: Workspace[]
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
    workspaces: inputs.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      rootDir: workspace.rootDir,
      panes: workspace.panes.map((pane) => {
        const session = inputs.sessions[pane.id]
        return {
          id: pane.id,
          name: pane.name,
          kind: pane.kind,
          status: inputs.status[pane.id] ?? 'idle',
          ...(pane.color ? { color: pane.color } : {}),
          title: session?.title ?? null,
          lastPrompt: session?.lastPrompt ?? null,
          model: session?.model ?? null,
          lastActivity: inputs.lastActivity[pane.id] ?? 0
        }
      })
    }))
  }
}
