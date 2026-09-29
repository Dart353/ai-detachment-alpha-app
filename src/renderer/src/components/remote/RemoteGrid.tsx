/**
 * A remote workspace's canvas, drawn the way its own desktop draws it: every
 * pane in its tile, all of them live. The tiles come from the layout the
 * machine publishes; only the pane that was picked holds the keyboard.
 *
 * Nothing here can be rearranged — the layout belongs to the other machine —
 * and a pane's grid (cols × rows) is that machine's too; each terminal scales
 * its type to fill the tile it has here.
 */
import { useState, type CSSProperties, type JSX } from 'react'
import { useApp } from '../../store/app'
import { isWatchable, useRemote } from '../../store/remote'
import type { RemoteMachine } from '../../../../shared/types'
import type { FeedPane, FeedWorkspace, FeedZone } from '../../../../shared/relayProtocol'
import { RemotePaneHeader } from './RemotePaneHeader'
import { RemoteTerminal } from './RemoteTerminal'
import { kindLabel, slotsOf } from './remoteHelpers'
import '../Grid.css'
import '../TerminalPane.css'
import './remote.css'

/** The gutter between tiles, as on the local canvas. */
const GAP = 8

function rectStyle(zone: FeedZone): CSSProperties {
  return {
    left: `calc(${zone.x}% + ${GAP / 2}px)`,
    top: `calc(${zone.y}% + ${GAP / 2}px)`,
    width: `calc(${zone.w}% - ${GAP}px)`,
    height: `calc(${zone.h}% - ${GAP}px)`
  }
}

export interface RemoteGridProps {
  machine: RemoteMachine
  workspace: FeedWorkspace
}

export function RemoteGrid({ machine, workspace }: RemoteGridProps): JSX.Element {
  const focusedPaneId = useRemote((state) =>
    state.selected?.hostId === machine.hostId && state.selected.workspaceId === workspace.id
      ? state.selected.paneId
      : null
  )
  const select = useRemote((state) => state.select)
  // Maximizing is this desktop's own view of the canvas; it changes nothing over there.
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null)
  const slots = slotsOf(workspace)
  const maximized = slots.some((slot) => slot.pane.id === maximizedPaneId) ? maximizedPaneId : null

  if (slots.length === 0) {
    return <div className="ada-remote-empty">No panes in this workspace — use + in the list to start one.</div>
  }

  // A maximized pane covers the canvas; the others stay mounted, and streaming, behind it.
  const slotStyle = (paneId: string, zone: FeedZone): CSSProperties => {
    if (maximized === paneId) return { inset: `${GAP / 2}px`, zIndex: 5 }
    const style = rectStyle(zone)
    return maximized ? { ...style, visibility: 'hidden' } : style
  }

  return (
    <div className="ada-remote-canvas">
      <div className="ada-grid">
        {slots.map(({ pane, zone }) => (
          <div key={pane.id} className="ada-grid-slot" style={slotStyle(pane.id, zone)}>
            <RemotePane
              hostId={machine.hostId}
              workspaceId={workspace.id}
              pane={pane}
              focused={focusedPaneId === pane.id}
              maximized={maximized === pane.id}
              onFocus={() => select({ hostId: machine.hostId, workspaceId: workspace.id, paneId: pane.id })}
              onToggleMaximize={() => setMaximizedPaneId(maximized === pane.id ? null : pane.id)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/* === one tile =============================================================== */

interface RemotePaneProps {
  hostId: string
  workspaceId: string
  pane: FeedPane
  focused: boolean
  maximized: boolean
  onFocus: () => void
  onToggleMaximize: () => void
}

function RemotePane({
  hostId,
  pane,
  focused,
  maximized,
  onFocus,
  onToggleMaximize
}: RemotePaneProps): JSX.Element {
  const termFontSize = useApp((state) => state.settings.termFontSize)
  const termFontFamily = useApp((state) => state.settings.termFontFamily)
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const classes = ['ada-pane']
  if (focused) classes.push('is-focused')
  if (pane.color) classes.push('has-color')
  const style = pane.color ? ({ ['--ada-pane-color' as string]: pane.color } as CSSProperties) : undefined

  return (
    <div className={classes.join(' ')} style={style} data-remote-pane-id={pane.id} onPointerDown={onFocus}>
      <RemotePaneHeader
        hostId={hostId}
        pane={pane}
        focused={focused}
        maximized={maximized}
        cols={size?.cols ?? null}
        rows={size?.rows ?? null}
        onRefresh={() => setRefreshToken((token) => token + 1)}
        onToggleMaximize={onToggleMaximize}
      />
      {pane.color && <span className="ada-pane-seam" style={{ background: pane.color }} aria-hidden />}
      {isWatchable(pane) ? (
        <RemoteTerminal
          key={`${hostId}/${pane.id}`}
          hostId={hostId}
          paneId={pane.id}
          fontSize={termFontSize}
          fontFamily={termFontFamily}
          focused={focused}
          onFocus={onFocus}
          refreshToken={refreshToken}
          onSize={(cols, rows) => setSize({ cols, rows })}
        />
      ) : (
        <div className="ada-remote-empty">{kindLabel(pane.kind)} panes are shown on their own machine only.</div>
      )}
    </div>
  )
}
