/**
 * Remote mode's whole surface: the machine tree on the left and, on the right,
 * the canvas of the workspace that was picked — every pane of it, laid out as
 * its own desktop lays it out.
 */
import type { JSX } from 'react'
import { findRemoteWorkspace, useRemote } from '../../store/remote'
import type { RemoteStatus } from '../../../../shared/types'
import { RemoteGrid } from './RemoteGrid'
import { RemoteSidebar } from './RemoteSidebar'
import { machineName } from './remoteHelpers'
import './remote.css'

function linkNote(status: RemoteStatus): string | null {
  if (status.state === 'error') return status.error ?? null
  if (status.state === 'connecting') return 'Connecting to the relay…'
  return null
}

export default function RemoteView(): JSX.Element {
  const status = useRemote((state) => state.status)
  const selected = useRemote((state) => state.selected)

  const found = selected ? findRemoteWorkspace(status, selected) : null
  const note = linkNote(status)

  return (
    <div className="ada-remote">
      <RemoteSidebar />
      <main className="ada-remote-main">
        {note && <div className="ada-remote-note">{note}</div>}
        {found && !found.machine.online && (
          <div className="ada-remote-banner">
            {machineName(found.machine)} is offline — showing its last picture
          </div>
        )}
        {found ? (
          // Always the same wrapper, so going offline dims the canvas without remounting it.
          <div className={`ada-remote-stage${found.machine.online ? '' : ' ada-remote-dim'}`}>
            <RemoteGrid
              key={`${found.machine.hostId}/${found.workspace.id}`}
              machine={found.machine}
              workspace={found.workspace}
            />
          </div>
        ) : (
          <div className="ada-remote-empty">Pick a workspace</div>
        )}
      </main>
    </div>
  )
}
