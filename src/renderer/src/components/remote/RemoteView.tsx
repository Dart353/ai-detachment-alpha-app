/**
 * Remote mode's whole surface: the machine tree on the left and, on the right,
 * the one remote pane the user picked — its header, any link or offline notice,
 * and its live terminal.
 */
import { useEffect, useState, type JSX } from 'react'
import { useApp } from '../../store/app'
import { findRemotePane, useRemote } from '../../store/remote'
import type { RemoteStatus } from '../../../../shared/types'
import { RemotePaneHeader } from './RemotePaneHeader'
import { RemoteSidebar } from './RemoteSidebar'
import { machineName } from './remoteHelpers'
import { RemoteTerminal } from './RemoteTerminal'
import './remote.css'

interface GridSize {
  cols: number
  rows: number
}

/** The remote's cols/rows for the chip, learned from the screens it sends. */
function useRemoteGridSize(hostId: string | null, paneId: string | null): GridSize | null {
  const [size, setSize] = useState<GridSize | null>(null)

  useEffect(() => {
    setSize(null)
    if (hostId === null || paneId === null) return
    return window.api.onRemoteScreen((screen) => {
      if (screen.hostId !== hostId || screen.paneId !== paneId) return
      setSize({ cols: screen.cols, rows: screen.rows })
    })
  }, [hostId, paneId])

  return size
}

function linkNote(status: RemoteStatus): string | null {
  if (status.state === 'error') return status.error ?? null
  if (status.state === 'connecting') return 'Connecting to the relay…'
  return null
}

export default function RemoteView(): JSX.Element {
  const status = useRemote((state) => state.status)
  const selected = useRemote((state) => state.selected)
  const select = useRemote((state) => state.select)
  const termFontSize = useApp((state) => state.settings.termFontSize)
  const termFontFamily = useApp((state) => state.settings.termFontFamily)
  const [refreshToken, setRefreshToken] = useState(0)

  const found = selected ? findRemotePane(status, selected) : null
  const gridSize = useRemoteGridSize(found ? found.machine.hostId : null, found ? found.pane.id : null)
  const note = linkNote(status)

  return (
    <div className="ada-remote">
      <RemoteSidebar />
      <main className="ada-remote-main">
        {found && (
          <RemotePaneHeader
            machine={found.machine}
            workspace={found.workspace}
            pane={found.pane}
            cols={gridSize?.cols ?? null}
            rows={gridSize?.rows ?? null}
            onRefresh={() => setRefreshToken((token) => token + 1)}
            onClose={() => select(null)}
          />
        )}
        {note && <div className="ada-remote-note">{note}</div>}
        {found ? (
          <>
            {!found.machine.online && (
              <div className="ada-remote-banner">
                {machineName(found.machine)} is offline — showing its last picture
              </div>
            )}
            {/* Always the same wrapper, so going offline dims the terminal without remounting it. */}
            <div className={`ada-remote-stage${found.machine.online ? '' : ' ada-remote-dim'}`}>
              <RemoteTerminal
                key={`${found.machine.hostId}/${found.pane.id}`}
                hostId={found.machine.hostId}
                paneId={found.pane.id}
                fontSize={termFontSize}
                fontFamily={termFontFamily}
                focused={true}
                onFocus={() => {}}
                refreshToken={refreshToken}
              />
            </div>
          </>
        ) : (
          <div className="ada-remote-empty">Pick a pane</div>
        )}
      </main>
    </div>
  )
}
