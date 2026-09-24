/**
 * The pane canvas: every pane of one workspace, placed at its zone's rectangle.
 *
 * The rendering contract is load-bearing (see lib/zones.ts). Each pane is an
 * ABSOLUTELY POSITIONED, id-keyed SIBLING of every other pane, and a layout
 * change only rewrites the slot's inline geometry. Panes hold live xterm
 * instances over node-pty: reparenting one throws away the terminal's
 * measurements and blanks it, and re-keying one kills the process behind it. So
 * the slots are rendered from the pane list in creation order — never from zone
 * order — and nothing here may ever reorder, nest or re-key them.
 *
 * On top of that geometry sit the four gestures the canvas owns: drag a shared
 * edge to resize, drag a pane header to swap or split, click an empty zone to
 * spawn, and right-click anything for its menu.
 */
import {
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { Pane, Zone } from '../../../shared/types'
import { useApp } from '../store/app'
import { getSelectionFn, useRuntime } from '../store/runtime'
import { usePaneShare } from '../hooks/useUsage'
import {
  computeZoneRects,
  emptyZones,
  moveSharedEdge,
  neighborZoneInDirection,
  sharedEdges,
  zoneDragPreview,
  zoneOfPane,
  type Dir,
  type Rect,
  type ZoneEdge,
  type ZoneLayout,
  spanPreview
} from '../lib/zones'
import { Button, ContextMenu, Modal, TextInput, type MenuItem } from './ui'
import { PANE_DND_TYPE, TerminalPane, type TerminalPaneProps } from './TerminalPane'
import type { MenuAnchor } from './PaneHeader'
import ViewerPane from './ViewerPane'
import EmptyZone from './EmptyZone'
import { buildPaneMenu, buildQuickSpawnMenu } from './paneMenu'
import './Grid.css'

export interface GridProps {
  workspaceId: string
  /** False for the workspaces kept mounted behind the active one. */
  active: boolean
}

/** The gap between panes (design 2a). Half of it is taken off each side. */
const GAP = 8

/** Fraction of a zone, on each axis, that counts as its centre rather than an edge. */
const CENTRE_BAND = 0.25

/** Which menu is open, and what it is about. */
type GridMenu =
  | { kind: 'pane'; paneId: string; x: number; y: number }
  | { kind: 'zone'; zoneId: string; x: number; y: number }

/** The zone a pane drag is currently over, and where in it it would land. */
interface DragHint {
  zoneId: string
  side: Dir | null
  /** Shift held: the pane's zone grows over this one instead of moving into it. */
  span: boolean
}

/** A percent rect, inset by half the gap so neighbours sit a whole gap apart. */
/**
 * The order slots are rendered in: creation order, never `workspace.panes`
 * order. The sidebar reorders that array, and a reordered keyed list makes React
 * move the DOM nodes — which blanks a terminal just as a reparent would. Slots
 * are absolutely positioned, so their document order changes nothing visible.
 */
function mountOrder(panes: Pane[]): Pane[] {
  return [...panes].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

function rectStyle(rect: Rect): CSSProperties {
  return {
    left: `calc(${rect.x}% + ${GAP / 2}px)`,
    top: `calc(${rect.y}% + ${GAP / 2}px)`,
    width: `calc(${rect.w}% - ${GAP}px)`,
    height: `calc(${rect.h}% - ${GAP}px)`
  }
}

/**
 * Where in a zone a pointer sits: the inner half is the centre (swap or move),
 * anything outside it is the nearest edge (split that zone and land in the half
 * on that side).
 */
export function zoneSide(zone: Zone, x: number, y: number): Dir | null {
  const across = zone.w ? (x - zone.x) / zone.w : 0.5
  const down = zone.h ? (y - zone.y) / zone.h : 0.5
  const inCentre =
    across > CENTRE_BAND &&
    across < 1 - CENTRE_BAND &&
    down > CENTRE_BAND &&
    down < 1 - CENTRE_BAND
  if (inCentre) return null
  const edges: { dir: Dir; distance: number }[] = [
    { dir: 'left', distance: across },
    { dir: 'right', distance: 1 - across },
    { dir: 'up', distance: down },
    { dir: 'down', distance: 1 - down }
  ]
  return edges.reduce((best, edge) => (edge.distance < best.distance ? edge : best)).dir
}

/**
 * One terminal slot. It exists only so the usage-share hook runs once per pane:
 * a hook cannot be called from inside the loop over the pane list, and lifting
 * the shares into the grid would re-render every pane whenever any one of them
 * spent a token.
 */
function TerminalSlot({ paneId, ...rest }: Omit<TerminalPaneProps, 'sharePct'>): JSX.Element {
  const sharePct = usePaneShare(paneId)
  return <TerminalPane paneId={paneId} sharePct={sharePct} {...rest} />
}

export default function Grid({ workspaceId, active }: GridProps): JSX.Element | null {
  const workspace = useApp((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  )
  const addPane = useApp((state) => state.addPane)
  const closePane = useApp((state) => state.closePane)
  const renamePane = useApp((state) => state.renamePane)
  const setPaneColor = useApp((state) => state.setPaneColor)
  const setPaneAccount = useApp((state) => state.setPaneAccount)
  const startFresh = useApp((state) => state.startFresh)
  const duplicatePane = useApp((state) => state.duplicatePane)
  const focusPane = useApp((state) => state.focusPane)
  const toggleMaximize = useApp((state) => state.toggleMaximize)
  const applyLayout = useApp((state) => state.applyLayout)
  const splitPane = useApp((state) => state.splitPane)
  const dropPane = useApp((state) => state.dropPane)
  const spanPane = useApp((state) => state.spanPane)

  const remountKeys = useRuntime((state) => state.remountKey)
  const accounts = useRuntime((state) => state.accounts)

  const gridRef = useRef<HTMLDivElement>(null)
  /** The pane in flight. `dataTransfer` refuses to be read during a dragover. */
  const draggingPaneRef = useRef<string | null>(null)
  const [dragHint, setDragHint] = useState<DragHint | null>(null)
  const [draggingEdge, setDraggingEdge] = useState<string | null>(null)
  const [menu, setMenu] = useState<GridMenu | null>(null)
  /** null while ~/.ssh/config is being read, so the menu can say "Loading…". */
  const [sshHosts, setSshHosts] = useState<string[] | null>(null)
  const [renaming, setRenaming] = useState<{ paneId: string; name: string } | null>(null)
  const [newAgent, setNewAgent] = useState<{ zoneId: string; name: string } | null>(null)

  if (!workspace) return null

  const layout = workspace.layout
  const maximizedPaneId = workspace.maximizedPaneId
  const paneIds = workspace.panes.map((pane) => pane.id)
  const rects = computeZoneRects(layout, paneIds)

  /**
   * A maximized pane covers the canvas; every other slot STAYS MOUNTED, merely
   * invisible, because unmounting it would tear down its terminal and its PTY.
   */
  const slotStyle = (paneId: string): CSSProperties => {
    if (maximizedPaneId === paneId) return { inset: `${GAP / 2}px`, zIndex: 5 }
    const rect = rects.get(paneId)
    if (!rect) return { display: 'none' }
    const style = rectStyle(rect)
    return maximizedPaneId ? { ...style, visibility: 'hidden' } : style
  }

  /* === menus =============================================================== */

  // Re-read ~/.ssh/config every time a menu opens, so hosts added since launch
  // show up without a relaunch.
  const loadSshHosts = (): void => {
    setSshHosts(null)
    window.api
      .sshHosts()
      .then(setSshHosts)
      .catch(() => setSshHosts([]))
  }

  const openZoneMenu = (zoneId: string, event: ReactMouseEvent): void => {
    setMenu({ kind: 'zone', zoneId, x: event.clientX, y: event.clientY })
    loadSshHosts()
  }

  const openPaneMenu =
    (paneId: string) =>
    (anchor: ReactMouseEvent | MenuAnchor): void => {
      setMenu({ kind: 'pane', paneId, x: anchor.clientX, y: anchor.clientY })
    }

  /** The pane's live working directory, falling back to the one it was spawned in. */
  const panePath = async (pane: Pane): Promise<string> => {
    if (pane.kind === 'viewer') return pane.filePath ?? pane.cwd
    const live = await window.api.ptyCwd(pane.id)
    return live ?? pane.cwd
  }

  const quickSpawnItems = (zoneId: string): MenuItem[] => {
    const focusedPaneId = workspace.focusedPaneId
    return buildQuickSpawnMenu({
      sshHosts,
      accounts,
      canDuplicate: !!focusedPaneId,
      onSpawn: (init) => addPane(workspaceId, init, zoneId),
      onDuplicate: () => {
        if (!focusedPaneId) return
        // The copy is placed by reconcile, then moved into the zone the menu was
        // opened on — "duplicate here" has to mean here.
        const copyId = duplicatePane(focusedPaneId)
        if (copyId) dropPane(copyId, zoneId, null)
      },
      onNewAgent: () => setNewAgent({ zoneId, name: '' })
    })
  }

  const paneMenuItems = (paneId: string): MenuItem[] => {
    const pane = workspace.panes.find((candidate) => candidate.id === paneId)
    if (!pane) return []
    return buildPaneMenu({
      pane,
      layout,
      accounts,
      maximized: maximizedPaneId === paneId,
      platform: window.api.platform,
      // xterm paints its selection itself and keeps it out of the document, so
      // the terminal is asked directly; `window.getSelection()` is the fallback
      // for the panes that do render their text into the DOM (the viewer).
      getSelection: () => getSelectionFn(paneId)?.() ?? window.getSelection()?.toString() ?? '',
      onCopyText: (text) => window.api.copyText(text),
      onRename: () => setRenaming({ paneId, name: pane.name }),
      onSetColor: (color) => setPaneColor(paneId, color),
      onCopyPath: () => {
        void panePath(pane).then((path) => {
          if (path) window.api.copyText(path)
        })
      },
      onRevealPath: () => {
        void panePath(pane).then((path) => {
          if (path) void window.api.revealPath(path)
        })
      },
      onSplit: (dir) => splitPane(paneId, dir),
      onMove: (dir) => {
        const zoneId = zoneOfPane(layout, paneId)
        const target = zoneId ? neighborZoneInDirection(layout, zoneId, dir) : null
        if (!target) return
        dropPane(paneId, target, null)
        focusPane(paneId)
      },
      onToggleMaximize: () => toggleMaximize(paneId),
      onSetAccount: (accountId) => setPaneAccount(paneId, accountId),
      onStartFresh: () => startFresh(paneId),
      onClose: () => closePane(paneId)
    })
  }

  /* === pane drag & drop ==================================================== */

  const carriesPane = (event: ReactDragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(PANE_DND_TYPE)

  const onGridDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!carriesPane(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const grid = gridRef.current
    if (maximizedPaneId || !grid) return
    const box = grid.getBoundingClientRect()
    if (!box.width || !box.height) return
    const x = ((event.clientX - box.left) / box.width) * 100
    const y = ((event.clientY - box.top) / box.height) * 100
    const zone = layout.zones.find(
      (candidate) =>
        x >= candidate.x &&
        x <= candidate.x + candidate.w &&
        y >= candidate.y &&
        y <= candidate.y + candidate.h
    )
    if (!zone) {
      setDragHint(null)
      return
    }
    const dragged = draggingPaneRef.current
    // Shift turns the drop into a span: the pane's zone joins the one under
    // the pointer, whole, whichever part of it the pointer is over. Only a
    // neighbour sharing a full edge can join; over anything else the gesture
    // falls back to a plain drop, and the preview says which it will be.
    const span = event.shiftKey && !!dragged && spanPreview(layout, dragged, zone.id) !== null
    const side = span ? null : zoneSide(zone, x, y)
    // A pane dropped on its own zone's centre goes nowhere; do not draw a
    // preview promising a move that will not happen.
    if (dragged && !span && side === null && zoneOfPane(layout, dragged) === zone.id) {
      setDragHint(null)
      return
    }
    setDragHint((current) =>
      current && current.zoneId === zone.id && current.side === side && current.span === span
        ? current
        : { zoneId: zone.id, side, span }
    )
  }

  const onGridDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragHint(null)
  }

  const onGridDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!carriesPane(event)) return
    event.preventDefault()
    const paneId = event.dataTransfer.getData(PANE_DND_TYPE)
    const hint = dragHint
    setDragHint(null)
    draggingPaneRef.current = null
    if (!paneId || !hint || maximizedPaneId) return
    if (hint.span) {
      spanPane(paneId, hint.zoneId)
      focusPane(paneId)
      return
    }
    if (hint.side === null && zoneOfPane(layout, paneId) === hint.zoneId) return
    dropPane(paneId, hint.zoneId, hint.side)
    focusPane(paneId)
  }

  /* === dividers ============================================================ */

  /**
   * Drag one shared edge. The listeners go on the WINDOW, not on the handle: a
   * divider is keyed by the boundary it draws, so the first frame of the drag
   * moves that boundary, remounts the handle, and any pointer capture on the old
   * element dies with it. Window listeners outlive the remount.
   *
   * Every move is committed straight to the store — terminals refit themselves
   * through their own ResizeObservers — and measured against `base`, the layout
   * captured at drag start, so the delta is cumulative and an edge clamped at
   * MIN_ZONE springs back when the pointer comes the other way.
   */
  const startDivider =
    (edge: ZoneEdge, base: ZoneLayout) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const grid = gridRef.current
      if (!active || !grid) return
      const box = grid.getBoundingClientRect()
      const size = edge.axis === 'x' ? box.width : box.height
      if (!size) return
      const start = edge.axis === 'x' ? event.clientX : event.clientY
      setDraggingEdge(edge.id)
      // Every move resizes a pane, which SIGWINCHes its TUI into a full repaint —
      // activity the status engine would otherwise hear as an agent stirring.
      // Keep the notifications down for the drag and a moment after it.
      useRuntime.getState().holdNotifications()
      const onMove = (moveEvent: PointerEvent): void => {
        const pos = edge.axis === 'x' ? moveEvent.clientX : moveEvent.clientY
        applyLayout(workspaceId, moveSharedEdge(base, edge, edge.pos + ((pos - start) / size) * 100))
        useRuntime.getState().holdNotifications()
      }
      const onEnd = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        setDraggingEdge(null)
        useRuntime.getState().holdNotifications()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
      event.preventDefault()
    }

  /* === render ============================================================== */

  const spanRect =
    dragHint?.span && draggingPaneRef.current
      ? spanPreview(layout, draggingPaneRef.current, dragHint.zoneId)
      : null
  const preview = spanRect
    ? { rect: spanRect, kind: 'span' as const }
    : dragHint
      ? zoneDragPreview(layout, dragHint.zoneId, dragHint.side)
      : null

  return (
    <div
      className="ada-grid"
      ref={gridRef}
      onDragOver={onGridDragOver}
      onDragLeave={onGridDragLeave}
      onDrop={onGridDrop}
    >
      {mountOrder(workspace.panes).map((pane) => (
        // Keyed by pane id and NOTHING else: a layout change restyles this
        // wrapper, it never reparents or remounts what is inside it.
        <div key={pane.id} className="ada-grid-slot" style={slotStyle(pane.id)}>
          {pane.kind === 'viewer' ? (
            <ViewerPane
              workspaceId={workspaceId}
              paneId={pane.id}
              onContextMenu={openPaneMenu(pane.id)}
              onHeaderDragStart={() => {
                draggingPaneRef.current = pane.id
              }}
              onHeaderDragEnd={() => {
                draggingPaneRef.current = null
                setDragHint(null)
              }}
            />
          ) : (
            <TerminalSlot
              // the one key that may change: bumping it is how "Start fresh"
              // and an account switch respawn the process
              key={remountKeys[pane.id] ?? 0}
              workspaceId={workspaceId}
              paneId={pane.id}
              onContextMenu={openPaneMenu(pane.id)}
              onHeaderDragStart={() => {
                draggingPaneRef.current = pane.id
              }}
              onHeaderDragEnd={() => {
                draggingPaneRef.current = null
                setDragHint(null)
              }}
            />
          )}
        </div>
      ))}

      {!maximizedPaneId &&
        emptyZones(layout).map((zone) => (
          <div key={`empty:${zone.id}`} className="ada-grid-slot" style={rectStyle(zone)}>
            <EmptyZone
              workspaceId={workspaceId}
              zoneId={zone.id}
              menuOpen={menu?.kind === 'zone' && menu.zoneId === zone.id}
              onContextMenu={(event) => openZoneMenu(zone.id, event)}
            />
          </div>
        ))}

      {/* The drop preview is drawn HERE rather than inside the pane: a pane's
          overflow:hidden would clip it. It is computed from the same zone and
          side the drop applies, so the outline can never promise a rectangle
          the drop does not produce. */}
      {!maximizedPaneId && preview && (
        <div
          className={`ada-grid-preview${preview.kind === 'span' ? ' ada-grid-preview--span' : ''}`}
          style={rectStyle(preview.rect)}
          aria-hidden
        />
      )}

      {/* One handle per shared boundary, spanning only the run it divides.
          Hidden while a pane is maximized — there is no canvas to resize. */}
      {!maximizedPaneId &&
        sharedEdges(layout).map((edge) => (
          <div
            key={`divider:${edge.id}`}
            className={`ada-grid-divider ada-grid-divider--${edge.axis === 'x' ? 'col' : 'row'}${
              draggingEdge === edge.id ? ' is-dragging' : ''
            }`}
            style={
              edge.axis === 'x'
                ? {
                    left: `calc(${edge.pos}% - ${GAP / 2}px)`,
                    top: `${edge.from}%`,
                    height: `${edge.to - edge.from}%`
                  }
                : {
                    top: `calc(${edge.pos}% - ${GAP / 2}px)`,
                    left: `${edge.from}%`,
                    width: `${edge.to - edge.from}%`
                  }
            }
            onPointerDown={startDivider(edge, layout)}
          />
        ))}

      {menu?.kind === 'zone' && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={quickSpawnItems(menu.zoneId)}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === 'pane' && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={paneMenuItems(menu.paneId)}
          onClose={() => setMenu(null)}
        />
      )}

      <Modal
        open={!!renaming}
        title="Rename pane"
        width={380}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (renaming) renamePane(renaming.paneId, renaming.name)
                setRenaming(null)
              }}
            >
              Rename
            </Button>
          </>
        }
      >
        <TextInput
          value={renaming?.name ?? ''}
          maxLength={40}
          autoFocus
          onChange={(name) => setRenaming((current) => (current ? { ...current, name } : current))}
          onEnter={(name) => {
            if (renaming) renamePane(renaming.paneId, name)
            setRenaming(null)
          }}
          onEscape={() => setRenaming(null)}
        />
      </Modal>

      <Modal
        open={!!newAgent}
        title="New agent"
        width={380}
        onClose={() => setNewAgent(null)}
        footer={
          <>
            <Button onClick={() => setNewAgent(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (newAgent) addPane(workspaceId, { kind: 'claude', name: newAgent.name }, newAgent.zoneId)
                setNewAgent(null)
              }}
            >
              Spawn
            </Button>
          </>
        }
      >
        <TextInput
          value={newAgent?.name ?? ''}
          placeholder="Name this agent"
          maxLength={40}
          autoFocus
          onChange={(name) => setNewAgent((current) => (current ? { ...current, name } : current))}
          onEnter={(name) => {
            if (newAgent) addPane(workspaceId, { kind: 'claude', name }, newAgent.zoneId)
            setNewAgent(null)
          }}
          onEscape={() => setNewAgent(null)}
        />
      </Modal>
    </div>
  )
}
