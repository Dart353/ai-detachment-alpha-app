import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { SavedLayout, Zone, ZoneLayout } from '../../../shared/types'
import {
  DEFAULT_SNAP,
  ZONE_PRESETS,
  addZone,
  applyPresetById,
  canMerge,
  deleteZone,
  evenOutZones,
  mergeZones,
  moveSharedEdge,
  paneInZone,
  reconcileZones,
  resizeZoneEdge,
  sharedEdges,
  snapAxis,
  splitZoneAt,
  zoneById,
  zoneGuides,
  zonePaneIds,
  zoneRect,
  zonesFromRects,
  type Rect
} from '../lib/zones'
import {
  addSavedLayout,
  deleteSavedLayout,
  loadSavedLayouts,
  persistSavedLayouts,
  renameSavedLayout,
  reorderSavedLayout
} from '../lib/savedLayouts'
import { useApp } from '../store/app'
import { useRuntime } from '../store/runtime'
import { Button, Select } from './ui'
import SavedLayouts from './SavedLayouts'
import './ZoneEditor.css'

/**
 * The zone editor — the FancyZones half of the layout model.
 *
 * It draws OVER the live panes rather than replacing them: every gesture only
 * rewrites rectangles in the workspace's `ZoneLayout`, so the panes underneath
 * keep their DOM (and their terminals keep their PTYs) for the whole session.
 *
 * The vocabulary:
 *   • drag on empty canvas      → draw a new zone, snapping cell by cell
 *   • drag inside a zone        → cut it with a guide that spans only that zone
 *   • drag an edge or a corner  → resize it; flush neighbours follow
 *   • click / Shift-click       → select; two adjacent zones can be merged
 *   • Backspace / Delete        → remove the selected zone
 *
 * Every position snaps to the substrate (default 12×12) and magnetically to the
 * other zones' edges. Hold Alt to place a line exactly where the cursor is.
 *
 * Saved layouts are managed from an INLINE panel beside the canvas (never a
 * modal), so the layout stays visible and live while shapes are renamed,
 * reordered or removed.
 *
 * The zone module refuses any edit that would leave two zones overlapping, so
 * that invariant holds no matter how the gestures are combined.
 */

export interface ZoneEditorProps {
  workspaceId: string
  onClose: () => void
}

/** The snap substrates on offer, as square `N × N` grids. */
const SNAP_CHOICES = [6, 8, 10, 12, 16, 20, 24]

/**
 * No zone may be dragged, drawn or cut below this, in REAL pixels. The geometry
 * engine's own MIN_ZONE is a percentage, which says nothing about whether a zone
 * can actually hold a pane — 8% of a narrow canvas is unusable. Enforced here
 * rather than in lib/zones.ts because only the editor knows the canvas's pixel size.
 */
const MIN_ZONE_PX = 100

/** The four corners, and which pair of edges each one drives. */
type Corner = 'nw' | 'ne' | 'sw' | 'se'
type EdgeSide = 'left' | 'right' | 'up' | 'down'

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

const CORNER_SIDES: Record<Corner, { x: EdgeSide; y: EdgeSide }> = {
  nw: { x: 'left', y: 'up' },
  ne: { x: 'right', y: 'up' },
  sw: { x: 'left', y: 'down' },
  se: { x: 'right', y: 'down' }
}

const CORNER_LABEL: Record<Corner, string> = {
  nw: 'top left',
  ne: 'top right',
  sw: 'bottom left',
  se: 'bottom right'
}

const EDGE_SIDES: EdgeSide[] = ['left', 'right', 'up', 'down']

/** Where a zone's given edge currently sits, as a canvas percentage. */
const edgeOf = (zone: Zone, side: EdgeSide): number =>
  side === 'left'
    ? zone.x
    : side === 'right'
      ? zone.x + zone.w
      : side === 'up'
        ? zone.y
        : zone.y + zone.h

type Gesture =
  // `alt` rides along so the render can snap the preview the same way the commit
  // will — Alt means "ignore the grid", and the cell highlight must agree
  | { kind: 'draw'; from: { x: number; y: number }; to: { x: number; y: number }; alt: boolean }
  | { kind: 'guide'; zoneId: string; axis: 'x' | 'y'; at: number }
  | { kind: 'edge'; zoneId: string; side: EdgeSide; at: number }
  // a corner drags BOTH of its edges at once, each clamped on its own axis
  | { kind: 'corner'; zoneId: string; corner: Corner; atX: number; atY: number }

const pct = (rect: Rect): CSSProperties => ({
  left: `${rect.x}%`,
  top: `${rect.y}%`,
  width: `${rect.w}%`,
  height: `${rect.h}%`
})

const sizeLabel = (rect: { w: number; h: number }): string =>
  `${Math.round(rect.w)}% × ${Math.round(rect.h)}%`

/** What the status bar says: one bold mode word, then what this gesture will do. */
interface StatusLine {
  mode: string
  detail: string
}

export default function ZoneEditor({ workspaceId, onClose }: ZoneEditorProps): JSX.Element {
  const workspace = useApp((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  )
  const applyLayout = useApp((state) => state.applyLayout)
  const storeLayout = workspace?.layout
  const panes = workspace?.panes

  const surfaceRef = useRef<HTMLDivElement>(null)
  const [surfacePx, setSurfacePx] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [selected, setSelected] = useState<string[]>([])
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [layouts, setLayouts] = useState<SavedLayout[]>([])

  /**
   * The editor edits a LOCAL draft and pushes each result to the store, so the
   * live grid under the overlay follows the gesture instead of jumping when it
   * ends. The draft is what the canvas renders, so a beat the store has not
   * applied yet can never be drawn.
   */
  const [draft, setDraft] = useState<ZoneLayout>(
    () => storeLayout ?? { v: 2, snap: DEFAULT_SNAP, zones: [], assign: {} }
  )
  /** The last layout WE sent, so an outside change is told apart from an echo. */
  const committed = useRef<ZoneLayout | undefined>(storeLayout)
  /**
   * The layout as it stood when the editor opened. Every edit is pushed to the
   * store live so the grid follows the gesture, which means "Cancel" is a
   * restore rather than a discard: put this back, reconciled against whatever
   * panes exist now, and leave.
   */
  const opening = useRef<ZoneLayout | undefined>(storeLayout)

  // the layout as it stood when the current gesture began — edge drags are
  // applied to it cumulatively, so a drag never compounds its own rounding
  const gestureBase = useRef<ZoneLayout>(draft)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  const commit = useCallback(
    (next: ZoneLayout): void => {
      committed.current = next
      setDraft(next)
      applyLayout(workspaceId, next)
    },
    [applyLayout, workspaceId]
  )

  // A pane closing (or opening) while the editor is up rewrites the layout from
  // outside; adopt it rather than overwriting it with a stale draft.
  useEffect(() => {
    if (storeLayout && storeLayout !== committed.current) {
      committed.current = storeLayout
      setDraft(storeLayout)
    }
  }, [storeLayout])

  useEffect(() => {
    let alive = true
    void loadSavedLayouts().then((list) => {
      if (alive) setLayouts(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const writeLayouts = (next: SavedLayout[]): void => {
    setLayouts(next)
    persistSavedLayouts(next)
  }

  // the canvas's live pixel size, so the 100px floor can be expressed as a
  // percentage of whatever the window currently is
  useEffect(() => {
    const element = surfaceRef.current
    if (!element) return undefined
    const observer = new ResizeObserver(([entry]) => {
      setSurfacePx({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** MIN_ZONE_PX as canvas percentages. Capped at 45% so a small window cannot
   *  make every gesture illegal — better a floor that relaxes than an editor
   *  that refuses everything. */
  const minPct = useMemo(
    () => ({
      x: surfacePx.w ? Math.min(45, (MIN_ZONE_PX / surfacePx.w) * 100) : 0,
      y: surfacePx.h ? Math.min(45, (MIN_ZONE_PX / surfacePx.h) * 100) : 0
    }),
    [surfacePx.w, surfacePx.h]
  )

  /** Would every zone in this candidate layout still clear the pixel floor? */
  const fitsMin = useCallback(
    (candidate: ZoneLayout): boolean =>
      candidate.zones.every((zone) => zone.w >= minPct.x - 0.01 && zone.h >= minPct.y - 0.01),
    [minPct.x, minPct.y]
  )

  /** Is this rectangle itself big enough to be a zone? */
  const rectFitsMin = useCallback(
    (rect: { w: number; h: number }): boolean =>
      rect.w >= minPct.x - 0.01 && rect.h >= minPct.y - 0.01,
    [minPct.x, minPct.y]
  )

  /**
   * The furthest legal position for an edge being dragged to `want`. Bisects
   * between the last position that held and the one asked for, so the boundary
   * travels right up to the 100px floor and stops there. Topology-agnostic: it
   * asks the geometry what a candidate actually does rather than trying to
   * reason about which neighbours a move would drag along.
   */
  const clampEdgeToMin = useCallback(
    (
      apply: (base: ZoneLayout, zoneId: string, side: EdgeSide, pos: number) => ZoneLayout,
      base: ZoneLayout,
      zoneId: string,
      side: EdgeSide,
      want: number,
      lastGood: number
    ): number => {
      /**
       * A candidate counts only if the edge REALLY landed on it. resizeZoneEdge
       * returns the layout untouched when a move would breach the engine's own
       * percentage MIN_ZONE — and an untouched layout trivially satisfies the
       * pixel floor, so testing the floor alone reads a refusal as a success and
       * snaps the whole drag back to where it started.
       */
      const legal = (value: number): boolean => {
        const next = apply(base, zoneId, side, value)
        const zone = next.zones.find((candidate) => candidate.id === zoneId)
        if (!zone) return false
        return Math.abs(edgeOf(zone, side) - value) < 0.01 && fitsMin(next)
      }
      if (legal(want)) return want
      // where this edge sits in `base` is a no-op move, so it is always legal —
      // the backstop when `lastGood` was measured against a different base, as a
      // corner's second axis is
      const here = base.zones.find((candidate) => candidate.id === zoneId)
      const start = legal(lastGood) ? lastGood : here ? edgeOf(here, side) : lastGood
      if (!legal(start)) return start
      let good = start
      let bad = want
      for (let step = 0; step < 14; step++) {
        const mid = (good + bad) / 2
        if (legal(mid)) good = mid
        else bad = mid
      }
      return good
    },
    [fitsMin]
  )

  /**
   * Move one boundary of a zone, for a CORNER drag.
   *
   * resizeZoneEdge alone cannot express a corner. It moves only the neighbours
   * flush with the dragged zone along that one edge, so the first axis leaves
   * the second axis's neighbours mismatched — and the second move is then
   * refused outright for overlapping, which is why a corner drag moved on one
   * axis only. Moving the shared DIVIDER instead takes every zone on that line
   * with it, so the canvas stays tiled through both halves of the gesture.
   *
   * Edge handles deliberately keep the other behaviour: an edge moves just its
   * own boundary (that is what lets you build a staircase), a corner moves the
   * intersection.
   */
  const moveBoundary = useCallback(
    (base: ZoneLayout, zoneId: string, side: EdgeSide, pos: number): ZoneLayout => {
      const zone = zoneById(base, zoneId)
      if (!zone) return base
      const axis: 'x' | 'y' = side === 'left' || side === 'right' ? 'x' : 'y'
      const at = edgeOf(zone, side)
      const divider = sharedEdges(base).find(
        (edge) =>
          edge.axis === axis &&
          Math.abs(edge.pos - at) < 0.01 &&
          (edge.before.includes(zoneId) || edge.after.includes(zoneId))
      )
      // no divider there — the canvas border, or free space beyond. The local
      // edge move still works, and can shrink the zone into that space.
      return divider ? moveSharedEdge(base, divider, pos) : resizeZoneEdge(base, zoneId, side, pos)
    },
    []
  )

  /** Pointer position as canvas percentages. */
  const toPct = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } => {
      const element = surfaceRef.current
      if (!element) return { x: 0, y: 0 }
      const rect = element.getBoundingClientRect()
      return {
        x: rect.width ? ((event.clientX - rect.left) / rect.width) * 100 : 0,
        y: rect.height ? ((event.clientY - rect.top) / rect.height) * 100 : 0
      }
    },
    []
  )

  const snap = (value: number, axis: 'x' | 'y', bypass: boolean, exceptId?: string): number =>
    snapAxis(
      value,
      axis === 'x' ? draft.snap.cols : draft.snap.rows,
      zoneGuides(draft.zones, axis, exceptId),
      bypass
    )

  /** The rectangle a draw would commit: both corners snapped, as a Rect. */
  const snappedDrawRect = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    bypass: boolean
  ): Rect => {
    const x1 = snap(Math.min(from.x, to.x), 'x', bypass)
    const x2 = snap(Math.max(from.x, to.x), 'x', bypass)
    const y1 = snap(Math.min(from.y, to.y), 'y', bypass)
    const y2 = snap(Math.max(from.y, to.y), 'y', bypass)
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }

  const paneLabel = (paneId: string): string =>
    panes?.find((pane) => pane.id === paneId)?.name ?? 'a pane'

  /**
   * Whether the current selection can be merged, and why not when it cannot.
   *
   * The occupancy rule matters: mergeZones keeps `a`'s pane and DROPS `b`'s
   * assignment — it is pure geometry and will happily displace a pane, which is
   * a tested property of the engine rather than a bug in it. Merging two
   * occupied zones would therefore evict a pane behind the user's back, so the
   * no-eviction POLICY lives here and is re-checked at the call site.
   */
  const mergeState = ((): { can: boolean; reason: string } => {
    if (selected.length === 0)
      return { can: false, reason: 'Click a zone, then Shift-click an adjacent one' }
    if (selected.length === 1)
      return {
        can: false,
        reason: 'Shift-click a second zone that shares a full edge with this one'
      }
    if (selected.length > 2)
      return {
        can: false,
        reason: 'Merge takes exactly two zones — Shift-click to deselect the extras'
      }
    const first = zoneById(draft, selected[0])
    const second = zoneById(draft, selected[1])
    if (!first || !second) return { can: false, reason: 'Select two adjacent zones' }
    if (!canMerge(first, second))
      return {
        can: false,
        reason: 'Those two zones do not share a full edge, so they cannot merge'
      }
    const paneA = paneInZone(draft, first.id)
    const paneB = paneInZone(draft, second.id)
    if (paneA && paneB)
      return {
        can: false,
        reason: `Both zones are occupied (${paneLabel(paneA)} and ${paneLabel(paneB)}) — merging would evict one. Close or move a pane first.`
      }
    return { can: true, reason: 'Merge the two selected zones into one' }
  })()

  const livePaneIds = panes?.map((pane) => pane.id) ?? []
  const livePaneKey = livePaneIds.join(',')

  /** Panes in reading order, newcomers last — the order a re-seed fills zones in. */
  const orderedPaneIds = useCallback((): string[] => {
    const placed = zonePaneIds(draft).filter((paneId) => livePaneIds.includes(paneId))
    return [...placed, ...livePaneIds.filter((paneId) => !placed.includes(paneId))]
    // livePaneIds is a fresh array each render; the joined key is its identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, livePaneKey])

  /**
   * Whether the selection can be deleted. A pane living in a deleted zone moves
   * to a free zone (deleteZone picks the nearest), so occupancy only blocks the
   * delete when there is nowhere left for the pane to go.
   */
  const deleteState = ((): { can: boolean; reason: string } => {
    if (selected.length === 0) return { can: false, reason: 'Select a zone to delete it' }
    if (draft.zones.length <= selected.length)
      return { can: false, reason: 'The canvas has to keep at least one zone' }
    const occupied = selected
      .map((zoneId) => paneInZone(draft, zoneId))
      .filter((paneId): paneId is string => !!paneId)
    const taken = new Set(Object.values(draft.assign))
    const freeAfter = draft.zones.filter(
      (zone) => !selected.includes(zone.id) && !taken.has(zone.id)
    ).length
    if (occupied.length > freeAfter)
      return {
        can: false,
        reason: `${paneLabel(occupied[0])} lives in that zone and no empty zone is left for it — close the pane or free a zone first`
      }
    if (occupied.length === 1)
      return {
        can: true,
        reason: `Delete the selected zone — ${paneLabel(occupied[0])} moves to the nearest empty zone`
      }
    return { can: true, reason: 'Delete the selected zone' }
  })()

  const removeSelected = useCallback((): void => {
    if (!deleteState.can) return
    let next = draft
    for (const zoneId of selected) next = deleteZone(next, zoneId)
    setSelected([])
    // deleteZone re-homes each pane itself; reconcile is the safety net that
    // guarantees every live pane still has a zone before the grid draws it.
    commit(reconcileZones(next, orderedPaneIds(), { rows: 1, cols: 1 }))
  }, [commit, deleteState.can, draft, selected, orderedPaneIds])

  /**
   * With exactly one zone selected, the zones it could legally merge with. They
   * get a dashed outline, so "Shift-click an adjacent one" stops being folklore
   * you have to read out of a tooltip and becomes something you can see.
   */
  const mergeCandidates = ((): Set<string> => {
    const out = new Set<string>()
    if (selected.length !== 1) return out
    const first = zoneById(draft, selected[0])
    if (!first) return out
    const occupied = !!paneInZone(draft, first.id)
    for (const other of draft.zones) {
      if (other.id === first.id || !canMerge(first, other)) continue
      if (occupied && paneInZone(draft, other.id)) continue // would evict a pane
      out.add(other.id)
    }
    return out
  })()

  // Esc leaves, Backspace/Delete removes the selection. Capture, so the terminal
  // underneath never sees them while the editor owns the canvas — but a text
  // field owns its own keys, or naming a layout would be impossible.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && selected.length) {
        event.preventDefault()
        event.stopPropagation()
        removeSelected()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, removeSelected, selected.length])

  /* === gestures ============================================================= */

  // Every beat of every gesture reshapes zones under the live panes, which
  // SIGWINCHes their TUIs into a full repaint; the status heuristic would hear
  // that as activity, so notifications are held for the whole drag — press, move
  // and release alike (a gesture the min-size clamp refuses still leaves the
  // panes it already moved repainting).
  const noteGesture = (): void => useRuntime.getState().holdNotifications()

  const beginDraw = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    noteGesture()
    const point = toPct(event)
    dragStart.current = point
    gestureBase.current = draft
    setSelected([])
    setGesture({ kind: 'draw', from: point, to: point, alt: event.altKey })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const beginGuide =
    (zoneId: string) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      noteGesture()
      const point = toPct(event)
      dragStart.current = point
      gestureBase.current = draft
      setSelected((current) =>
        event.shiftKey ? [...current.filter((id) => id !== zoneId), zoneId] : [zoneId]
      )
      setGesture(null)
      event.currentTarget.setPointerCapture(event.pointerId)
      // the surface below is the draw target; without this a press inside a zone
      // would start a draw that can only ever be refused for overlapping
      event.stopPropagation()
    }

  const beginEdge =
    (zoneId: string, side: EdgeSide) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      noteGesture()
      const point = toPct(event)
      dragStart.current = point
      gestureBase.current = draft
      setSelected([zoneId])
      setGesture({
        kind: 'edge',
        zoneId,
        side,
        at: side === 'left' || side === 'right' ? point.x : point.y
      })
      event.currentTarget.setPointerCapture(event.pointerId)
      event.stopPropagation()
      event.preventDefault()
    }

  const beginCorner =
    (zoneId: string, corner: Corner) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      noteGesture()
      const point = toPct(event)
      dragStart.current = point
      gestureBase.current = draft
      setSelected([zoneId])
      const zone = zoneById(draft, zoneId)
      const sides = CORNER_SIDES[corner]
      setGesture({
        kind: 'corner',
        zoneId,
        corner,
        atX: zone ? edgeOf(zone, sides.x) : point.x,
        atY: zone ? edgeOf(zone, sides.y) : point.y
      })
      event.currentTarget.setPointerCapture(event.pointerId)
      event.stopPropagation()
      event.preventDefault()
    }

  const onMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current
    if (!start) return
    noteGesture()
    const point = toPct(event)
    const bypass = event.altKey

    if (gesture?.kind === 'draw') {
      setGesture({ kind: 'draw', from: start, to: point, alt: bypass })
      return
    }
    if (gesture?.kind === 'edge') {
      const axis: 'x' | 'y' = gesture.side === 'left' || gesture.side === 'right' ? 'x' : 'y'
      const want = snap(axis === 'x' ? point.x : point.y, axis, bypass, gesture.zoneId)
      // Clamp to the floor rather than refusing outright. Refusing looks fine
      // when the pointer creeps, but a fast drag jumps straight past the limit
      // in one move event — and then the edge sticks where it was instead of
      // travelling as far as it legally can.
      const at = clampEdgeToMin(
        resizeZoneEdge,
        gestureBase.current,
        gesture.zoneId,
        gesture.side,
        want,
        gesture.at
      )
      const next = resizeZoneEdge(gestureBase.current, gesture.zoneId, gesture.side, at)
      if (!fitsMin(next)) return
      setGesture({ ...gesture, at })
      commit(next)
      return
    }
    if (gesture?.kind === 'corner') {
      const sides = CORNER_SIDES[gesture.corner]
      // one axis at a time, each against the layout the previous one produced —
      // clamping them independently is what lets a corner slide along a limit
      // instead of jamming the moment either axis hits the floor
      const atX = clampEdgeToMin(
        moveBoundary,
        gestureBase.current,
        gesture.zoneId,
        sides.x,
        snap(point.x, 'x', bypass, gesture.zoneId),
        gesture.atX
      )
      const afterX = moveBoundary(gestureBase.current, gesture.zoneId, sides.x, atX)
      const atY = clampEdgeToMin(
        moveBoundary,
        afterX,
        gesture.zoneId,
        sides.y,
        snap(point.y, 'y', bypass, gesture.zoneId),
        gesture.atY
      )
      const next = moveBoundary(afterX, gesture.zoneId, sides.y, atY)
      if (!fitsMin(next)) return
      setGesture({ ...gesture, atX, atY })
      commit(next)
      return
    }
    // still inside the zone we pressed in: once the pointer has travelled far
    // enough, the drag becomes a split guide, cutting across the drag direction
    if (!gesture && selected.length === 1) {
      const dx = Math.abs(point.x - start.x)
      const dy = Math.abs(point.y - start.y)
      if (Math.max(dx, dy) < 2) return
      const axis: 'x' | 'y' = dx >= dy ? 'x' : 'y'
      setGesture({
        kind: 'guide',
        zoneId: selected[0],
        axis,
        at: snap(axis === 'x' ? point.x : point.y, axis, bypass, selected[0])
      })
      return
    }
    if (gesture?.kind === 'guide') {
      const at = snap(gesture.axis === 'x' ? point.x : point.y, gesture.axis, bypass, gesture.zoneId)
      setGesture({ ...gesture, at })
    }
  }

  const onUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const ending = gesture
    noteGesture()
    dragStart.current = null
    setGesture(null)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already released */
    }
    if (!ending) return
    if (ending.kind === 'draw') {
      // the very rect the preview has been showing, so what you saw is what lands
      const rect = snappedDrawRect(ending.from, ending.to, event.altKey)
      if (!rectFitsMin(rect)) return
      const drawn = addZone(gestureBase.current, rect)
      if (drawn) {
        setSelected([drawn.zoneId])
        commit(drawn.layout)
      }
      return
    }
    if (ending.kind === 'guide') {
      const cut = splitZoneAt(gestureBase.current, ending.zoneId, ending.axis, ending.at)
      if (cut && fitsMin(cut.layout)) commit(cut.layout)
    }
    // edge and corner drags have already been committed on every move
  }

  /* === applying layouts ===================================================== */

  const cancel = (): void => {
    const original = opening.current
    if (original) applyLayout(workspaceId, reconcileZones(original, orderedPaneIds(), { rows: 1, cols: 1 }))
    onClose()
  }

  const applySaved = (saved: SavedLayout): void => {
    const ordered = orderedPaneIds()
    const seeded = zonesFromRects(saved.zones.map(zoneRect), ordered, draft.snap)
    // panes past the saved shape's zone count are handed to reconcile, which
    // splits the largest zone for each — the same mechanism applyPresetById uses
    commit(reconcileZones(seeded, ordered, { rows: 1, cols: 1 }))
    setSelected([])
  }

  const applyChoice = (value: string): void => {
    if (value.startsWith('preset:')) {
      commit(applyPresetById(draft, value.slice('preset:'.length), orderedPaneIds()))
      setSelected([])
      return
    }
    const saved = layouts.find((candidate) => `saved:${candidate.id}` === value)
    if (saved) applySaved(saved)
  }

  const applyOptions = [
    { value: 'group:grids', label: 'GRIDS', disabled: true },
    ...ZONE_PRESETS.filter((preset) => preset.group === 'grid').map((preset) => ({
      value: `preset:${preset.id}`,
      label: preset.label
    })),
    { value: 'group:arrangements', label: 'ARRANGEMENTS', disabled: true },
    ...ZONE_PRESETS.filter((preset) => preset.group === 'arrangement').map((preset) => ({
      value: `preset:${preset.id}`,
      label: preset.label
    })),
    ...(layouts.length
      ? [
          { value: 'group:saved', label: 'SAVED', disabled: true },
          ...layouts.map((saved) => ({ value: `saved:${saved.id}`, label: saved.name }))
        ]
      : [])
  ]

  /* === gesture chrome ======================================================= */

  /** The zone a gesture is acting on — everything else dims out of the way. */
  const gestureZoneId = gesture && gesture.kind !== 'draw' ? gesture.zoneId : null

  const drawPreview =
    gesture?.kind === 'draw' ? snappedDrawRect(gesture.from, gesture.to, gesture.alt) : null

  /**
   * The substrate cells a draw currently covers, lit one by one — the FancyZones
   * read, where you watch the selection travel cell by cell instead of guessing
   * where the rectangle will land once it snaps. Skipped while Alt is held,
   * since that gesture is explicitly off-grid and lit cells would be a lie.
   */
  const drawCells = ((): CSSProperties[] => {
    if (!drawPreview || gesture?.kind !== 'draw' || gesture.alt) return []
    const cellW = 100 / draft.snap.cols
    const cellH = 100 / draft.snap.rows
    if (!cellW || !cellH || drawPreview.w < cellW / 2 || drawPreview.h < cellH / 2) return []
    const firstCol = Math.round(drawPreview.x / cellW)
    const lastCol = Math.round((drawPreview.x + drawPreview.w) / cellW)
    const firstRow = Math.round(drawPreview.y / cellH)
    const lastRow = Math.round((drawPreview.y + drawPreview.h) / cellH)
    const cells: CSSProperties[] = []
    for (let row = firstRow; row < lastRow; row++) {
      for (let col = firstCol; col < lastCol; col++) {
        cells.push({
          left: `${col * cellW}%`,
          top: `${row * cellH}%`,
          width: `${cellW}%`,
          height: `${cellH}%`
        })
      }
    }
    return cells
  })()

  /** The two rectangles a live split guide would produce, for the cut overlay. */
  const cutHalves = ((): { a: Rect; b: Rect } | null => {
    if (gesture?.kind !== 'guide') return null
    const zone = zoneById(draft, gesture.zoneId)
    if (!zone) return null
    const rect = zoneRect(zone)
    if (gesture.axis === 'x') {
      const at = Math.max(rect.x, Math.min(gesture.at, rect.x + rect.w))
      return {
        a: { x: rect.x, y: rect.y, w: at - rect.x, h: rect.h },
        b: { x: at, y: rect.y, w: rect.x + rect.w - at, h: rect.h }
      }
    }
    const at = Math.max(rect.y, Math.min(gesture.at, rect.y + rect.h))
    return {
      a: { x: rect.x, y: rect.y, w: rect.w, h: at - rect.y },
      b: { x: rect.x, y: at, w: rect.w, h: rect.y + rect.h - at }
    }
  })()

  /** A draw or a cut that would breach the pixel floor — shown refused rather
   *  than silently doing nothing when the pointer comes up. */
  const drawTooSmall = !!drawPreview && !rectFitsMin(drawPreview)
  const cutTooSmall = !!cutHalves && (!rectFitsMin(cutHalves.a) || !rectFitsMin(cutHalves.b))

  /** The boundary an edge drag is moving, drawn across the zone it belongs to. */
  const edgeGuide = ((): CSSProperties | null => {
    if (gesture?.kind !== 'edge') return null
    const zone = zoneById(draft, gesture.zoneId)
    if (!zone) return null
    const rect = zoneRect(zone)
    return gesture.side === 'left' || gesture.side === 'right'
      ? { left: `${gesture.at}%`, top: `${rect.y}%`, height: `${rect.h}%` }
      : { top: `${gesture.at}%`, left: `${rect.x}%`, width: `${rect.w}%` }
  })()

  /** A corner drag moves two boundaries — draw them both. */
  const cornerGuides = ((): CSSProperties[] => {
    if (gesture?.kind !== 'corner') return []
    const zone = zoneById(draft, gesture.zoneId)
    if (!zone) return []
    const rect = zoneRect(zone)
    return [
      { left: `${gesture.atX}%`, top: `${rect.y}%`, height: `${rect.h}%` },
      { top: `${gesture.atY}%`, left: `${rect.x}%`, width: `${rect.w}%` }
    ]
  })()

  /**
   * The faint accent gridlines: the snap substrate at the canvas's REAL size, so
   * a cell on screen is the cell a drag will snap to rather than a decoration
   * that happens to look similar.
   */
  const substrate: CSSProperties = ((): CSSProperties => {
    const stepX = surfacePx.w / Math.max(1, draft.snap.cols)
    const stepY = surfacePx.h / Math.max(1, draft.snap.rows)
    if (stepX < 2 || stepY < 2) return {}
    const line = 'rgba(var(--ada-accent-rgb), 0.07)'
    return {
      backgroundImage: [
        `repeating-linear-gradient(to right, transparent 0, transparent ${stepX - 1}px, ${line} ${stepX - 1}px, ${line} ${stepX}px)`,
        `repeating-linear-gradient(to bottom, transparent 0, transparent ${stepY - 1}px, ${line} ${stepY - 1}px, ${line} ${stepY}px)`
      ].join(', ')
    }
  })()

  const status = ((): StatusLine => {
    if (drawPreview) {
      return {
        mode: 'Drawing',
        detail: drawTooSmall
          ? `a zone under ${MIN_ZONE_PX}px is refused · drag further · Alt bypasses snapping`
          : `releases into a ${sizeLabel(drawPreview)} zone · drag inside a zone to cut · Shift-click two to merge · Alt bypasses snapping`
      }
    }
    if (cutHalves) {
      return {
        mode: 'Cutting',
        detail: cutTooSmall
          ? `a half under ${MIN_ZONE_PX}px is refused · move the guide · Alt bypasses snapping`
          : `splits into ${sizeLabel(cutHalves.a)} and ${sizeLabel(cutHalves.b)} · Alt bypasses snapping`
      }
    }
    if (gesture?.kind === 'edge' || gesture?.kind === 'corner') {
      const zone = zoneById(draft, gesture.zoneId)
      return {
        mode: 'Resizing',
        detail: `${zone ? `${sizeLabel(zone)} · ` : ''}neighbours follow the boundary · zones stop at ${MIN_ZONE_PX}px · Alt bypasses snapping`
      }
    }
    if (selected.length) {
      return { mode: `${selected.length} selected`, detail: mergeState.reason }
    }
    return {
      mode: 'Zones',
      detail:
        'drag empty space to draw · drag inside a zone to cut · drag an edge or corner to resize · Shift-click two to merge · Alt bypasses snapping'
    }
  })()

  const snapValue = String(draft.snap.cols)

  return (
    <div className="ada-zone-editor">
      <div className="ada-zone-bar">
        <span className="ada-zone-bar-title">Edit zones</span>

        <span className="ada-zone-bar-label">APPLY</span>
        <Select
          size="sm"
          value=""
          placeholder="Apply a layout…"
          options={applyOptions}
          ariaLabel="Apply a layout"
          onChange={applyChoice}
        />

        <span className="ada-zone-bar-label">ARRANGE</span>
        <Button
          variant="outline"
          size="sm"
          title="Distribute every boundary evenly"
          onClick={() => commit(evenOutZones(draft))}
        >
          Even out
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!mergeState.can}
          title={mergeState.reason}
          onClick={() => {
            if (!mergeState.can) return
            const merged = mergeZones(draft, selected[0], selected[1])
            if (merged) {
              setSelected([selected[0]])
              commit(merged)
            }
          }}
        >
          Merge
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!deleteState.can}
          title={deleteState.reason}
          onClick={removeSelected}
        >
          Delete
        </Button>

        <span className="ada-zone-bar-label">GRID</span>
        <Select
          size="sm"
          value={snapValue}
          options={SNAP_CHOICES.map((count) => ({
            value: String(count),
            // thin spaces: the multiplication sign belongs to the pair, not to
            // either number
            label: `${count} × ${count}`
          }))}
          ariaLabel="Snap grid"
          onChange={(value) => {
            const count = Number(value) || DEFAULT_SNAP.cols
            commit({ ...draft, snap: { cols: count, rows: count } })
          }}
        />

        <span className="ada-zone-bar-spacer" aria-hidden />

        <Button
          variant="ghost"
          size="sm"
          active={panelOpen}
          title="Save these zones as a layout you can apply again"
          onClick={() => setPanelOpen((open) => !open)}
        >
          Save layout…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title="Put the zones back the way they were when the editor opened"
          onClick={cancel}
        >
          Cancel
        </Button>
        <Button variant="primary" className="ada-zone-done" onClick={onClose}>
          Done
        </Button>
      </div>

      <div className="ada-zone-body">
        <div
          ref={surfaceRef}
          className={`ada-zone-canvas${gesture ? ' ada-zone-canvas--busy' : ''}`}
          style={substrate}
          onPointerDown={beginDraw}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {draft.zones.map((zone) => {
            const paneId = paneInZone(draft, zone.id)
            const isTarget = gestureZoneId === zone.id
            const classes = ['ada-zone']
            if (selected.includes(zone.id)) classes.push('ada-zone--selected')
            if (isTarget) classes.push('ada-zone--target')
            if (mergeCandidates.has(zone.id)) classes.push('ada-zone--mergeable')
            if (gesture !== null && !isTarget) classes.push('ada-zone--dimmed')
            return (
              <div
                key={zone.id}
                className={classes.join(' ')}
                style={pct(zoneRect(zone))}
                onPointerDown={beginGuide(zone.id)}
              >
                <div className="ada-zone-chip">
                  <span
                    className={`ada-zone-chip-name${paneId ? '' : ' ada-zone-chip-name--empty'}`}
                  >
                    {paneId ? paneLabel(paneId) : 'Empty'}
                  </span>
                  <span className="ada-zone-chip-size">{sizeLabel(zone)}</span>
                </div>

                {EDGE_SIDES.map((side) => (
                  <div
                    key={side}
                    className={`ada-zone-handle ada-zone-handle--${side}`}
                    onPointerDown={beginEdge(zone.id, side)}
                  />
                ))}
                {CORNERS.map((corner) => (
                  <div
                    key={corner}
                    className={`ada-zone-corner ada-zone-corner--${corner}`}
                    title={`Resize from the ${CORNER_LABEL[corner]} corner`}
                    onPointerDown={beginCorner(zone.id, corner)}
                  />
                ))}
              </div>
            )
          })}

          {/* the substrate cells the drag currently owns, lit one by one */}
          {drawCells.map((style, index) => (
            <div key={index} className="ada-zone-cell" style={style} />
          ))}

          {drawPreview && (
            <div
              className={`ada-zone-draw${drawTooSmall ? ' ada-zone-draw--invalid' : ''}`}
              style={pct(drawPreview)}
            >
              <span className="ada-zone-draw-chip">
                {drawTooSmall
                  ? `Under ${MIN_ZONE_PX}px — too small`
                  : `New zone · ${sizeLabel(drawPreview)}`}
              </span>
              <span className="ada-zone-draw-dot" aria-hidden />
            </div>
          )}

          {cutHalves && gesture?.kind === 'guide' && (
            <>
              <div
                className={`ada-zone-cut${cutTooSmall ? ' ada-zone-cut--invalid' : ''}`}
                style={pct(cutHalves.a)}
              >
                <span className="ada-zone-cut-chip">
                  {cutTooSmall ? `Under ${MIN_ZONE_PX}px` : sizeLabel(cutHalves.a)}
                </span>
              </div>
              <div
                className={`ada-zone-cut${cutTooSmall ? ' ada-zone-cut--invalid' : ''}`}
                style={pct(cutHalves.b)}
              >
                <span className="ada-zone-cut-chip">
                  {cutTooSmall ? `Under ${MIN_ZONE_PX}px` : sizeLabel(cutHalves.b)}
                </span>
              </div>
              {/* edge to edge of the zone being cut, and no further — a line
                  running the whole canvas reads as a global divider and makes it
                  ambiguous which zone the cut belongs to */}
              <div
                className={`ada-zone-guide ada-zone-guide--${gesture.axis}`}
                style={
                  gesture.axis === 'x'
                    ? {
                        left: `${gesture.at}%`,
                        top: `${cutHalves.a.y}%`,
                        height: `${cutHalves.a.h}%`
                      }
                    : {
                        top: `${gesture.at}%`,
                        left: `${cutHalves.a.x}%`,
                        width: `${cutHalves.a.w}%`
                      }
                }
              />
            </>
          )}

          {cornerGuides.map((style, index) => (
            <div
              key={index}
              className={`ada-zone-guide ada-zone-guide--${index === 0 ? 'x' : 'y'}`}
              style={style}
            />
          ))}
          {edgeGuide && gesture?.kind === 'edge' && (
            <div
              className={`ada-zone-guide ada-zone-guide--${
                gesture.side === 'left' || gesture.side === 'right' ? 'x' : 'y'
              }`}
              style={edgeGuide}
            />
          )}
        </div>

        {panelOpen && (
          <SavedLayouts
            layouts={layouts}
            onSave={(name) => writeLayouts(addSavedLayout(layouts, name, draft.zones))}
            onApply={applySaved}
            onRename={(id, name) => writeLayouts(renameSavedLayout(layouts, id, name))}
            onReorder={(from, to) => writeLayouts(reorderSavedLayout(layouts, from, to))}
            onDelete={(id) => writeLayouts(deleteSavedLayout(layouts, id))}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>

      <div className="ada-zone-status">
        <span className="ada-zone-status-mode">{status.mode}</span> · {status.detail}
      </div>
    </div>
  )
}
