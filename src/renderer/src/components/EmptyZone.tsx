/**
 * A zone with no pane in it (design 2a "Empty zone", 1c): the dashed tile that
 * invites a spawn. Left-click opens the workspace's default pane kind here;
 * right-click raises the quick-spawn menu, which the grid owns.
 *
 * It is a drop target too, but it needs no handlers of its own: the grid listens
 * for a pane drag across its whole canvas and resolves the zone under the
 * pointer, so a pane dropped on this tile simply moves into it.
 */
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useApp } from '../store/app'
import './EmptyZone.css'

export interface EmptyZoneProps {
  workspaceId: string
  zoneId: string
  /** True while this zone's quick-spawn menu is open — the border goes accent. */
  menuOpen: boolean
  onContextMenu: (event: ReactMouseEvent) => void
}

export function EmptyZone({
  workspaceId,
  zoneId,
  menuOpen,
  onContextMenu
}: EmptyZoneProps): JSX.Element {
  const addPane = useApp((state) => state.addPane)
  const defaultPaneKind = useApp((state) => state.settings.defaultPaneKind)

  const classes = ['ada-empty-zone']
  if (menuOpen) classes.push('is-menu-open')

  return (
    <button
      type="button"
      className={classes.join(' ')}
      title="Add a pane here"
      onClick={() => addPane(workspaceId, { kind: defaultPaneKind }, zoneId)}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu(event)
      }}
    >
      <span className="ada-empty-zone-plus" aria-hidden>
        +
      </span>
      <span className="ada-empty-zone-title">New agent here</span>
      <span className="ada-empty-zone-hint">Right-click for a quick spawn</span>
    </button>
  )
}

export default EmptyZone
