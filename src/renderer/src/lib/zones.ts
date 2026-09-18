// The workspace layout model: FREE-FORM ZONES over a snap substrate.
//
// A fixed R×C grid of equal cells, where a "split" only ever subdivides the
// pane's own cell, is a cage: splitting the top-left pane of a 2×2 produces
// three columns on row 1 and two on row 2, a nested pane has no divider to
// drag, and spans have to exist as escape hatches.
//
// Here the canvas is a set of arbitrary rectangles (the PowerToys FancyZones
// model). Panes are ASSIGNED into zones; the grid survives only as the seed and
// the snap substrate. Everything the cage needed a special case for falls out
// of plain rectangle arithmetic:
//
//   • split       → cut a zone in two; both halves are first-class zones
//   • new column  → insert a full-height band and rescale what it crosses
//   • resize      → drag a shared edge; every zone touching it moves
//   • drag/drop   → centre = swap the ASSIGNMENT (zero geometry change),
//                   edge   = split that zone and land in the new half
//
// The rendering contract is load-bearing: flatten to Map<paneId, Rect> in %,
// render each pane as an absolutely-positioned, id-keyed stable child. Panes
// hold live xterm terminals over node-pty, so nothing here may ever cause a
// pane's DOM to be reparented.

import type { Zone, ZoneLayout, ZoneSnap } from '../../../shared/types'

export type { Zone, ZoneLayout, ZoneSnap }

/** All values are percentages (0–100) of the layout container. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Dir = 'left' | 'right' | 'up' | 'down'

/** A plain rows×cols shape — the seed for a fresh layout. */
export interface GridSize {
  rows: number
  cols: number
}

/** Smallest zone extent (% of the canvas) a resize may leave behind. */
export const MIN_ZONE = 8

/** Default snap substrate for a fresh layout. */
export const DEFAULT_SNAP: ZoneSnap = { cols: 12, rows: 12 }

/** Geometry tolerance (%) — two edges within this are "the same line". */
export const EPS = 0.05

/** How far (%) a dragged edge is pulled onto a neighbouring zone's edge. */
export const MAGNET = 1.5

const clamp = (value: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, value))

/** Trim float noise so persisted layouts stay stable across round trips. */
export const r4 = (value: number): number => Math.round(value * 10000) / 10000

export function isZones(value: unknown): value is ZoneLayout {
  if (!value || typeof value !== 'object') return false
  const layout = value as ZoneLayout
  return (
    layout.v === 2 &&
    Array.isArray(layout.zones) &&
    !!layout.assign &&
    typeof layout.assign === 'object'
  )
}

// ---- reading the layout ------------------------------------------------------

export function zoneRect(zone: Zone): Rect {
  return { x: zone.x, y: zone.y, w: zone.w, h: zone.h }
}

export function zoneById(layout: ZoneLayout, zoneId: string): Zone | undefined {
  return layout.zones.find((zone) => zone.id === zoneId)
}

/** The zone `paneId` is assigned to, or undefined. */
export function zoneOfPane(layout: ZoneLayout, paneId: string): string | undefined {
  const zoneId = layout.assign[paneId]
  return zoneId && zoneById(layout, zoneId) ? zoneId : undefined
}

/** The pane sitting in `zoneId`, or undefined (an empty zone). */
export function paneInZone(layout: ZoneLayout, zoneId: string): string | undefined {
  for (const [paneId, assigned] of Object.entries(layout.assign)) {
    if (assigned === zoneId) return paneId
  }
  return undefined
}

/**
 * Zones in reading order: top band first, then left to right. The y key is
 * rounded to the nearest half-percent so hand-drawn zones that sit in the same
 * visual row still sort together, and the comparator stays a total order.
 */
export function orderedZones(zones: Zone[]): Zone[] {
  return zones
    .map((zone, index) => ({ zone, index }))
    .sort((left, right) => {
      const leftY = Math.round(left.zone.y * 2)
      const rightY = Math.round(right.zone.y * 2)
      if (leftY !== rightY) return leftY - rightY
      if (left.zone.x !== right.zone.x) return left.zone.x - right.zone.x
      return left.index - right.index
    })
    .map((entry) => entry.zone)
}

/** Every pane id in reading order — focus-by-number and the badges follow it. */
export function zonePaneIds(layout: ZoneLayout): string[] {
  const out: string[] = []
  for (const zone of orderedZones(layout.zones)) {
    const paneId = paneInZone(layout, zone.id)
    if (paneId) out.push(paneId)
  }
  // an assignment whose zone vanished mid-render still names a live pane
  for (const paneId of Object.keys(layout.assign)) {
    if (!out.includes(paneId)) out.push(paneId)
  }
  return out
}

/** Zones with no pane in them, in reading order — the droppable "+" tiles. */
export function emptyZones(layout: ZoneLayout): Zone[] {
  const taken = new Set(Object.values(layout.assign))
  return orderedZones(layout.zones).filter((zone) => !taken.has(zone.id))
}

/**
 * Flatten every pane's rect to container % coordinates — the one function the
 * renderer needs, so the slot styles, maximize and the hotkey badges all read
 * from a single source.
 */
export function computeZoneRects(layout: ZoneLayout, paneIds?: string[]): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const want = paneIds ? new Set(paneIds) : null
  for (const zone of orderedZones(layout.zones)) {
    const paneId = paneInZone(layout, zone.id)
    if (!paneId) continue
    if (want && !want.has(paneId)) continue
    out.set(paneId, zoneRect(zone))
  }
  return out
}

/** True when any two zones overlap — the invariant every edit is guarded on. */
export function hasOverlap(zones: Zone[]): boolean {
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i]
      const b = zones[j]
      if (
        a.x + a.w > b.x + EPS &&
        b.x + b.w > a.x + EPS &&
        a.y + a.h > b.y + EPS &&
        b.y + b.h > a.y + EPS
      ) {
        return true
      }
    }
  }
  return false
}

// ---- building zone sets ------------------------------------------------------

/** The next free `z<n>` id — deterministic, so reconcile is JSON-stable. */
export function nextZoneId(zones: Zone[]): string {
  let max = 0
  for (const zone of zones) {
    const match = /^z(\d+)$/.exec(zone.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `z${max + 1}`
}

/** An even rows×cols zone set (the grid presets seed through here). */
export function makeGridZones(
  rows: number,
  cols: number,
  snap: ZoneSnap = DEFAULT_SNAP
): ZoneLayout {
  const rowCount = Math.max(1, Math.floor(rows))
  const colCount = Math.max(1, Math.floor(cols))
  const zones: Zone[] = []
  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      zones.push({
        id: `z${row * colCount + col + 1}`,
        x: r4((col / colCount) * 100),
        y: r4((row / rowCount) * 100),
        w: r4(100 / colCount),
        h: r4(100 / rowCount)
      })
    }
  }
  return { v: 2, snap, zones, assign: {} }
}

/** Seed a zone set from a rows×cols shape and fill it with `paneIds` in order. */
export function zonesFromIds(
  paneIds: readonly string[],
  size: GridSize,
  snap: ZoneSnap = DEFAULT_SNAP
): ZoneLayout {
  const cols = Math.max(1, size.cols)
  const rows = Math.max(size.rows, Math.ceil(paneIds.length / cols) || 1)
  const layout = makeGridZones(rows, cols, snap)
  const assign: Record<string, string> = {}
  orderedZones(layout.zones).forEach((zone, index) => {
    if (index < paneIds.length) assign[paneIds[index]] = zone.id
  })
  return { ...layout, assign }
}

/** Rebuild a zone set from bare rectangles, keeping `assign` by reading order. */
export function zonesFromRects(
  rects: readonly Rect[],
  paneIds: readonly string[],
  snap: ZoneSnap = DEFAULT_SNAP
): ZoneLayout {
  const zones: Zone[] = rects.map((rect, index) => ({
    id: `z${index + 1}`,
    x: r4(rect.x),
    y: r4(rect.y),
    w: r4(rect.w),
    h: r4(rect.h)
  }))
  const assign: Record<string, string> = {}
  orderedZones(zones).forEach((zone, index) => {
    if (index < paneIds.length) assign[paneIds[index]] = zone.id
  })
  return { v: 2, snap, zones, assign }
}

/** Drop zones that are not sane rectangles, and assignments that point nowhere. */
export function sanitize(layout: ZoneLayout, defaultGrid: GridSize): ZoneLayout {
  const snap: ZoneSnap = {
    cols: Math.max(1, Math.floor(layout.snap?.cols ?? DEFAULT_SNAP.cols)),
    rows: Math.max(1, Math.floor(layout.snap?.rows ?? DEFAULT_SNAP.rows))
  }
  const seen = new Set<string>()
  const zones = layout.zones.filter((zone) => {
    if (!zone || typeof zone.id !== 'string' || seen.has(zone.id)) return false
    const numbers = [zone.x, zone.y, zone.w, zone.h]
    if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return false
    if (zone.w <= 0 || zone.h <= 0) return false
    seen.add(zone.id)
    return true
  })
  if (zones.length === 0) return makeGridZones(defaultGrid.rows, defaultGrid.cols, snap)
  const sameSnap = snap.cols === layout.snap?.cols && snap.rows === layout.snap?.rows
  if (sameSnap && zones.length === layout.zones.length) return layout
  return { v: 2, snap, zones, assign: layout.assign }
}

// ---- reconcile: keep the layout honest about the live pane set ---------------

/** Split `zone` down its LONGER axis, returning the two halves. */
export function halve(zone: Zone, newId: string): [Zone, Zone] {
  if (zone.w >= zone.h) {
    const w = r4(zone.w / 2)
    return [
      { ...zone, w },
      { id: newId, x: r4(zone.x + w), y: zone.y, w: r4(zone.w - w), h: zone.h }
    ]
  }
  const h = r4(zone.h / 2)
  return [
    { ...zone, h },
    { id: newId, x: zone.x, y: r4(zone.y + h), w: zone.w, h: r4(zone.h - h) }
  ]
}

/**
 * Sync a layout to the live pane set: drop assignments for panes that are gone,
 * place new panes in the first empty zone, and — when every zone is taken —
 * split the largest zone and use the new half (rather than only ever growing a
 * row downwards). Nothing but a zone layout comes in; anything else (undefined,
 * or a shape that fails `isZones`) opens at the app-wide default grid.
 *
 * Idempotent and JSON-stable: the same layout in returns the SAME OBJECT out, so
 * the effect that compares serialised layouts settles after one pass.
 */
export function reconcileZones(
  layout: ZoneLayout | undefined | null,
  paneIds: string[],
  defaultGrid: GridSize
): ZoneLayout {
  const base = isZones(layout) ? sanitize(layout, defaultGrid) : zonesFromIds(paneIds, defaultGrid)
  const want = new Set(paneIds)
  let zones = base.zones
  const assign = { ...base.assign }
  let changed = base !== layout

  // prune: panes that are gone, and assignments pointing at a vanished zone
  const zoneIds = new Set(zones.map((zone) => zone.id))
  const used = new Set<string>()
  for (const paneId of Object.keys(assign)) {
    const zoneId = assign[paneId]
    if (!want.has(paneId) || !zoneIds.has(zoneId) || used.has(zoneId)) {
      delete assign[paneId]
      changed = true
      continue
    }
    used.add(zoneId)
  }

  // place newcomers: first free zone in reading order, else split the largest
  for (const paneId of paneIds) {
    if (assign[paneId]) continue
    changed = true
    const free = orderedZones(zones).find((zone) => !used.has(zone.id))
    if (free) {
      assign[paneId] = free.id
      used.add(free.id)
      continue
    }
    const largest = zones.reduce(
      (best, zone) => (zone.w * zone.h > best.w * best.h ? zone : best),
      zones[0]
    )
    const [kept, added] = halve(largest, nextZoneId(zones))
    zones = zones.map((zone) => (zone.id === largest.id ? kept : zone)).concat(added)
    assign[paneId] = added.id
    used.add(added.id)
  }

  if (!changed) return base
  return { v: 2, snap: base.snap, zones, assign }
}

// ---- assignment ops (no geometry changes at all) -----------------------------

/** Trade two panes' zones. */
export function swapPaneZones(layout: ZoneLayout, paneA: string, paneB: string): ZoneLayout {
  if (paneA === paneB) return layout
  const zoneA = layout.assign[paneA]
  const zoneB = layout.assign[paneB]
  if (!zoneA || !zoneB) return layout
  return { ...layout, assign: { ...layout.assign, [paneA]: zoneB, [paneB]: zoneA } }
}

/** Move a pane into a zone: swap with whoever is there, or just land in it. */
export function movePaneToZone(layout: ZoneLayout, paneId: string, zoneId: string): ZoneLayout {
  if (!zoneById(layout, zoneId)) return layout
  if (layout.assign[paneId] === zoneId) return layout
  const sitting = paneInZone(layout, zoneId)
  if (sitting) return swapPaneZones(layout, paneId, sitting)
  return { ...layout, assign: { ...layout.assign, [paneId]: zoneId } }
}

// ---- splitting ---------------------------------------------------------------

/**
 * Cut `zoneId` in two along `side`'s axis. The zone keeps the half AWAY from
 * `side`; the returned `newZoneId` is the half ON `side`, which is where a
 * freshly spawned (or dropped) pane goes.
 */
export function splitZone(
  layout: ZoneLayout,
  zoneId: string,
  side: Dir
): { layout: ZoneLayout; newZoneId: string } | null {
  const zone = zoneById(layout, zoneId)
  if (!zone) return null
  const newZoneId = nextZoneId(layout.zones)
  let kept: Zone
  let added: Zone
  if (side === 'left' || side === 'right') {
    const w = r4(zone.w / 2)
    const rest = r4(zone.w - w)
    kept = side === 'right' ? { ...zone, w } : { ...zone, x: r4(zone.x + rest), w }
    added =
      side === 'right'
        ? { id: newZoneId, x: r4(zone.x + w), y: zone.y, w: rest, h: zone.h }
        : { id: newZoneId, x: zone.x, y: zone.y, w: rest, h: zone.h }
  } else {
    const h = r4(zone.h / 2)
    const rest = r4(zone.h - h)
    kept = side === 'down' ? { ...zone, h } : { ...zone, y: r4(zone.y + rest), h }
    added =
      side === 'down'
        ? { id: newZoneId, x: zone.x, y: r4(zone.y + h), w: zone.w, h: rest }
        : { id: newZoneId, x: zone.x, y: zone.y, w: zone.w, h: rest }
  }
  const zones = layout.zones.map((cur) => (cur.id === zoneId ? kept : cur)).concat(added)
  return { layout: { ...layout, zones }, newZoneId }
}

/** Cut a zone at an explicit position along an axis (the editor's split guide). */
export function splitZoneAt(
  layout: ZoneLayout,
  zoneId: string,
  axis: 'x' | 'y',
  at: number
): { layout: ZoneLayout; newZoneId: string } | null {
  const zone = zoneById(layout, zoneId)
  if (!zone) return null
  const lo = axis === 'x' ? zone.x : zone.y
  const size = axis === 'x' ? zone.w : zone.h
  const cut = clamp(r4(at), lo + 1, lo + size - 1)
  if (!(cut > lo && cut < lo + size)) return null
  const newZoneId = nextZoneId(layout.zones)
  const kept: Zone = axis === 'x' ? { ...zone, w: r4(cut - lo) } : { ...zone, h: r4(cut - lo) }
  const added: Zone =
    axis === 'x'
      ? { id: newZoneId, x: cut, y: zone.y, w: r4(lo + size - cut), h: zone.h }
      : { id: newZoneId, x: zone.x, y: cut, w: zone.w, h: r4(lo + size - cut) }
  const zones = layout.zones.map((cur) => (cur.id === zoneId ? kept : cur)).concat(added)
  return { layout: { ...layout, zones }, newZoneId }
}

/**
 * Where a fresh pane goes when `paneId` is split towards `side`.
 *
 * A neighbouring EMPTY zone on that side wins: on a 2×2-seeded canvas,
 * splitting the top-left pane right must put the new pane in the second column,
 * not carve the first column into two. Only when the neighbour is occupied (or
 * there is none) does the pane's own zone get cut in half, which is still a pair
 * of real, resizable rectangles.
 */
export function splitForPane(
  layout: ZoneLayout,
  paneId: string,
  side: Dir
): { layout: ZoneLayout; zoneId: string } | null {
  const zoneId = zoneOfPane(layout, paneId)
  if (!zoneId) return null
  const neighbor = neighborZoneInDirection(layout, zoneId, side)
  if (neighbor && !paneInZone(layout, neighbor)) return { layout, zoneId: neighbor }
  const split = splitZone(layout, zoneId, side)
  if (!split) return null
  return { layout: split.layout, zoneId: split.newZoneId }
}

// ---- promote-split: a full-height column / full-width row --------------------

/**
 * Positions along `axis` that no zone straddles — the lines a full-height band
 * can be inserted at without cutting a rectangle in half. 0 and 100 always
 * qualify, so the set is never empty.
 */
export function cleanLines(zones: Zone[], axis: 'x' | 'y'): number[] {
  const lo = (zone: Zone): number => (axis === 'x' ? zone.x : zone.y)
  const hi = (zone: Zone): number => (axis === 'x' ? zone.x + zone.w : zone.y + zone.h)
  const candidates = new Set<number>([0, 100])
  for (const zone of zones) {
    candidates.add(r4(lo(zone)))
    candidates.add(r4(hi(zone)))
  }
  const out: number[] = []
  for (const pos of [...candidates].sort((a, b) => a - b)) {
    if (pos < -EPS || pos > 100 + EPS) continue
    if (zones.some((zone) => lo(zone) < pos - EPS && hi(zone) > pos + EPS)) continue
    out.push(pos)
  }
  return out
}

/**
 * Add a full-height column (left/right) or full-width row (up/down) at the
 * target zone's edge, rescaling everything it crosses proportionally.
 *
 * The band is placed on the nearest CLEAN line at or beyond that edge, so no
 * existing zone is ever cut in half by it and the result still tiles. Its size
 * is an even share against the strips already there — one strip becomes two
 * halves, two become three thirds — which is exactly what "give this pane its
 * own column" means on a 2×2.
 */
export function promoteSplit(
  layout: ZoneLayout,
  zoneId: string,
  side: Dir
): { layout: ZoneLayout; newZoneId: string } | null {
  const zone = zoneById(layout, zoneId)
  if (!zone) return null
  const axis: 'x' | 'y' = side === 'left' || side === 'right' ? 'x' : 'y'
  const forward = side === 'right' || side === 'down'
  const edge =
    axis === 'x'
      ? forward
        ? zone.x + zone.w
        : zone.x
      : forward
        ? zone.y + zone.h
        : zone.y

  const lines = cleanLines(layout.zones, axis)
  const line = forward
    ? (lines.find((candidate) => candidate >= edge - EPS) ?? 100)
    : ([...lines].reverse().find((candidate) => candidate <= edge + EPS) ?? 0)

  const strips = Math.max(1, lines.length - 1)
  const band = clamp(r4(100 / (strips + 1)), MIN_ZONE, 50)
  const scale = (100 - band) / 100
  const at = r4(line * scale)

  // `line` is a clean line, so every zone lies wholly on one side of it — which
  // is what makes the shift unambiguous at the line itself (a zone starting
  // exactly at `line` belongs to the far side and must clear the band, not sit
  // under it).
  const zones: Zone[] = layout.zones.map((cur) => {
    const lo = axis === 'x' ? cur.x : cur.y
    const hi = lo + (axis === 'x' ? cur.w : cur.h)
    const shift = hi <= line + EPS ? 0 : band
    const start = r4(lo * scale + shift)
    const end = r4(hi * scale + shift)
    return axis === 'x'
      ? { ...cur, x: start, w: r4(end - start) }
      : { ...cur, y: start, h: r4(end - start) }
  })
  const newZoneId = nextZoneId(layout.zones)
  zones.push(
    axis === 'x'
      ? { id: newZoneId, x: at, y: 0, w: band, h: 100 }
      : { id: newZoneId, x: 0, y: at, w: 100, h: band }
  )
  return { layout: { ...layout, zones }, newZoneId }
}

// ---- merge / delete / draw (the editor's vocabulary) -------------------------

/** Two zones share a full edge when they abut and their cross ranges match. */
export function canMerge(a: Zone, b: Zone): boolean {
  const flushX =
    (Math.abs(a.x + a.w - b.x) < EPS || Math.abs(b.x + b.w - a.x) < EPS) &&
    Math.abs(a.y - b.y) < EPS &&
    Math.abs(a.h - b.h) < EPS
  const flushY =
    (Math.abs(a.y + a.h - b.y) < EPS || Math.abs(b.y + b.h - a.y) < EPS) &&
    Math.abs(a.x - b.x) < EPS &&
    Math.abs(a.w - b.w) < EPS
  return flushX || flushY
}

/**
 * Combine two adjacent zones into their bounding rect. `a` survives (keeping its
 * pane); if `b` held a pane its assignment is dropped, and reconcile re-places it
 * in the next free zone. Returns null when they do not share a full edge.
 */
export function mergeZones(layout: ZoneLayout, aId: string, bId: string): ZoneLayout | null {
  const a = zoneById(layout, aId)
  const b = zoneById(layout, bId)
  if (!a || !b || a.id === b.id || !canMerge(a, b)) return null
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const merged: Zone = {
    id: a.id,
    x: r4(x),
    y: r4(y),
    w: r4(Math.max(a.x + a.w, b.x + b.w) - x),
    h: r4(Math.max(a.y + a.h, b.y + b.h) - y)
  }
  const zones = layout.zones
    .filter((zone) => zone.id !== bId)
    .map((zone) => (zone.id === aId ? merged : zone))
  const assign = { ...layout.assign }
  const homeless = paneInZone(layout, bId)
  if (homeless) {
    if (paneInZone(layout, aId)) delete assign[homeless]
    else assign[homeless] = aId
  }
  return { ...layout, zones, assign }
}

/**
 * Remove a zone. Its pane falls back to the nearest remaining zone (by centre
 * distance), and a neighbour that shared a full edge with it grows to swallow
 * the hole, so a delete does not leave dead canvas behind.
 */
export function deleteZone(layout: ZoneLayout, zoneId: string): ZoneLayout {
  const gone = zoneById(layout, zoneId)
  if (!gone || layout.zones.length <= 1) return layout
  let zones = layout.zones.filter((zone) => zone.id !== zoneId)
  // fill the hole with a neighbour that lines up exactly along the shared edge
  const filler = zones.find((zone) => canMerge(zone, gone))
  if (filler) {
    const x = Math.min(filler.x, gone.x)
    const y = Math.min(filler.y, gone.y)
    const grown: Zone = {
      ...filler,
      x: r4(x),
      y: r4(y),
      w: r4(Math.max(filler.x + filler.w, gone.x + gone.w) - x),
      h: r4(Math.max(filler.y + filler.h, gone.y + gone.h) - y)
    }
    zones = zones.map((zone) => (zone.id === filler.id ? grown : zone))
  }
  const assign = { ...layout.assign }
  const homeless = paneInZone(layout, zoneId)
  if (homeless) {
    delete assign[homeless]
    const taken = new Set(Object.values(assign))
    const centerX = gone.x + gone.w / 2
    const centerY = gone.y + gone.h / 2
    const free = zones.filter((zone) => !taken.has(zone.id))
    // No free zone: the pane stays unassigned rather than doubling up on a
    // neighbour — two panes in one zone is not a layout the grid can draw.
    // reconcileZones places it (splitting the largest zone) on the next pass.
    const nearest = free.reduce<Zone | null>((best, zone) => {
      if (!best) return zone
      const dist = (zone.x + zone.w / 2 - centerX) ** 2 + (zone.y + zone.h / 2 - centerY) ** 2
      const bestDist = (best.x + best.w / 2 - centerX) ** 2 + (best.y + best.h / 2 - centerY) ** 2
      return dist < bestDist ? zone : best
    }, null)
    if (nearest) assign[homeless] = nearest.id
  }
  return { ...layout, zones, assign }
}

/** Draw a new zone. Rejected (null) when it is degenerate or would overlap. */
export function addZone(
  layout: ZoneLayout,
  rect: Rect
): { layout: ZoneLayout; zoneId: string } | null {
  const zone: Zone = {
    id: nextZoneId(layout.zones),
    x: r4(rect.x),
    y: r4(rect.y),
    w: r4(rect.w),
    h: r4(rect.h)
  }
  if (zone.w < 1 || zone.h < 1) return null
  const zones = [...layout.zones, zone]
  if (hasOverlap(zones)) return null
  return { layout: { ...layout, zones }, zoneId: zone.id }
}

/** Move/resize one zone outright (the editor's handles). Overlap → unchanged. */
export function setZoneRect(layout: ZoneLayout, zoneId: string, rect: Rect): ZoneLayout {
  const next: Zone = { id: zoneId, x: r4(rect.x), y: r4(rect.y), w: r4(rect.w), h: r4(rect.h) }
  if (next.w < 1 || next.h < 1) return layout
  const zones = layout.zones.map((zone) => (zone.id === zoneId ? next : zone))
  if (hasOverlap(zones)) return layout
  return { ...layout, zones }
}

/**
 * Drag one zone's edge in the editor. Zones flush against that edge follow it,
 * so a well-formed layout stays tiled; anything that would overlap is refused.
 */
export function resizeZoneEdge(
  layout: ZoneLayout,
  zoneId: string,
  side: Dir,
  pos: number
): ZoneLayout {
  const zone = zoneById(layout, zoneId)
  if (!zone) return layout
  const axis: 'x' | 'y' = side === 'left' || side === 'right' ? 'x' : 'y'
  const lo = (target: Zone): number => (axis === 'x' ? target.x : target.y)
  const hi = (target: Zone): number =>
    axis === 'x' ? target.x + target.w : target.y + target.h
  const far = side === 'right' || side === 'down'
  const old = far ? hi(zone) : lo(zone)
  const next = clamp(r4(pos), 0, 100)
  if (Math.abs(next - old) < EPS) return layout

  const crossLo = axis === 'x' ? zone.y : zone.x
  const crossHi = axis === 'x' ? zone.y + zone.h : zone.x + zone.w
  const touches = (target: Zone): boolean => {
    const targetLo = axis === 'x' ? target.y : target.x
    const targetHi = axis === 'x' ? target.y + target.h : target.x + target.w
    return targetHi > crossLo + EPS && targetLo < crossHi - EPS
  }

  const zones = layout.zones.map((target) => {
    const moveFar =
      Math.abs(hi(target) - old) < EPS && (target.id === zone.id ? far : touches(target))
    const moveNear =
      Math.abs(lo(target) - old) < EPS && (target.id === zone.id ? !far : touches(target))
    if (!moveFar && !moveNear) return target
    if (moveFar) {
      const size = r4(next - lo(target))
      if (size < 1) return target
      return axis === 'x' ? { ...target, w: size } : { ...target, h: size }
    }
    const size = r4(hi(target) - next)
    if (size < 1) return target
    return axis === 'x'
      ? { ...target, x: next, w: size }
      : { ...target, y: next, h: size }
  })
  if (hasOverlap(zones)) return layout
  return { ...layout, zones }
}

// ---- shared edges (the dividers you drag outside edit mode) ------------------

/** A maximal boundary segment with zones on both sides — one draggable divider. */
export interface ZoneEdge {
  /** stable render key */
  id: string
  /** 'x' → a vertical divider at `pos` (drag left/right) */
  axis: 'x' | 'y'
  pos: number
  /** extent along the cross axis */
  from: number
  to: number
  /** zone ids whose FAR edge sits on the line (they grow when it moves out) */
  before: string[]
  /** zone ids whose NEAR edge sits on the line */
  after: string[]
}

type Interval = [number, number]

export function unionIntervals(list: Interval[]): Interval[] {
  const sorted = list.slice().sort((a, b) => a[0] - b[0])
  const out: Interval[] = []
  for (const interval of sorted) {
    const last = out[out.length - 1]
    if (last && interval[0] <= last[1] + EPS) last[1] = Math.max(last[1], interval[1])
    else out.push([interval[0], interval[1]])
  }
  return out
}

export function sameInterval(a: Interval[], b: Interval[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (interval, index) =>
      Math.abs(interval[0] - b[index][0]) < EPS && Math.abs(interval[1] - b[index][1]) < EPS
  )
}

export function edgesForAxis(zones: Zone[], axis: 'x' | 'y'): ZoneEdge[] {
  const lo = (zone: Zone): number => (axis === 'x' ? zone.x : zone.y)
  const hi = (zone: Zone): number => (axis === 'x' ? zone.x + zone.w : zone.y + zone.h)
  const cross = (zone: Zone): Interval =>
    axis === 'x' ? [zone.y, zone.y + zone.h] : [zone.x, zone.x + zone.w]

  const positions: number[] = []
  for (const zone of zones) {
    for (const pos of [lo(zone), hi(zone)]) {
      if (pos <= EPS || pos >= 100 - EPS) continue
      if (!positions.some((known) => Math.abs(known - pos) < EPS)) positions.push(pos)
    }
  }
  positions.sort((a, b) => a - b)

  const out: ZoneEdge[] = []
  for (const pos of positions) {
    const before = zones.filter((zone) => Math.abs(hi(zone) - pos) < EPS)
    const after = zones.filter((zone) => Math.abs(lo(zone) - pos) < EPS)
    if (!before.length || !after.length) continue
    // maximal connected spans covered by either side
    const spans = unionIntervals([...before, ...after].map(cross))
    for (const span of spans) {
      const within = (zone: Zone): boolean => {
        const range = cross(zone)
        return range[1] > span[0] + EPS && range[0] < span[1] - EPS
      }
      const beforeInSpan = before.filter(within)
      const afterInSpan = after.filter(within)
      if (!beforeInSpan.length || !afterInSpan.length) continue
      // both sides must cover the span exactly, else moving the line would tear
      // a zone away from a neighbour that is not part of this boundary
      const beforeUnion = unionIntervals(beforeInSpan.map(cross))
      const afterUnion = unionIntervals(afterInSpan.map(cross))
      if (!sameInterval(beforeUnion, [span]) || !sameInterval(afterUnion, [span])) continue
      out.push({
        id: `${axis}:${r4(pos)}:${r4(span[0])}`,
        axis,
        pos: r4(pos),
        from: r4(span[0]),
        to: r4(span[1]),
        before: beforeInSpan.map((zone) => zone.id),
        after: afterInSpan.map((zone) => zone.id)
      })
    }
  }
  return out
}

/** Every draggable boundary in the layout (both axes). */
export function sharedEdges(layout: ZoneLayout): ZoneEdge[] {
  return [...edgesForAxis(layout.zones, 'x'), ...edgesForAxis(layout.zones, 'y')]
}

/**
 * Drag a shared boundary to `pos`, moving every zone that touches it. The move
 * is clamped so no zone on either side drops below MIN_ZONE.
 */
export function moveSharedEdge(layout: ZoneLayout, edge: ZoneEdge, pos: number): ZoneLayout {
  const byId = new Map(layout.zones.map((zone) => [zone.id, zone]))
  const size = (zone: Zone): number => (edge.axis === 'x' ? zone.w : zone.h)
  let minPos = -Infinity
  let maxPos = Infinity
  for (const id of edge.before) {
    const zone = byId.get(id)
    if (zone) minPos = Math.max(minPos, edge.pos - (size(zone) - MIN_ZONE))
  }
  for (const id of edge.after) {
    const zone = byId.get(id)
    if (zone) maxPos = Math.min(maxPos, edge.pos + (size(zone) - MIN_ZONE))
  }
  const next = r4(clamp(pos, Math.min(minPos, edge.pos), Math.max(maxPos, edge.pos)))
  if (Math.abs(next - edge.pos) < 1e-6) return layout
  const before = new Set(edge.before)
  const after = new Set(edge.after)
  const zones = layout.zones.map((zone) => {
    if (before.has(zone.id)) {
      return edge.axis === 'x'
        ? { ...zone, w: r4(next - zone.x) }
        : { ...zone, h: r4(next - zone.y) }
    }
    if (after.has(zone.id)) {
      return edge.axis === 'x'
        ? { ...zone, x: next, w: r4(zone.x + zone.w - next) }
        : { ...zone, y: next, h: r4(zone.y + zone.h - next) }
    }
    return zone
  })
  return { ...layout, zones }
}

// ---- neighbours (directional focus, and "is there an empty zone that way?") --

/** The zone geometrically adjacent to `zoneId` in a direction, or null. */
export function neighborZoneInDirection(
  layout: ZoneLayout,
  zoneId: string,
  dir: Dir
): string | null {
  const me = zoneById(layout, zoneId)
  if (!me) return null
  let best: string | null = null
  let bestDist = Infinity
  let bestOverlap = 0
  for (const zone of layout.zones) {
    if (zone.id === zoneId) continue
    let onSide = false
    let dist = 0
    let overlap = 0
    if (dir === 'right') {
      onSide = zone.x >= me.x + me.w - EPS
      dist = zone.x - (me.x + me.w)
      overlap = Math.min(zone.y + zone.h, me.y + me.h) - Math.max(zone.y, me.y)
    } else if (dir === 'left') {
      onSide = zone.x + zone.w <= me.x + EPS
      dist = me.x - (zone.x + zone.w)
      overlap = Math.min(zone.y + zone.h, me.y + me.h) - Math.max(zone.y, me.y)
    } else if (dir === 'down') {
      onSide = zone.y >= me.y + me.h - EPS
      dist = zone.y - (me.y + me.h)
      overlap = Math.min(zone.x + zone.w, me.x + me.w) - Math.max(zone.x, me.x)
    } else {
      onSide = zone.y + zone.h <= me.y + EPS
      dist = me.y - (zone.y + zone.h)
      overlap = Math.min(zone.x + zone.w, me.x + me.w) - Math.max(zone.x, me.x)
    }
    if (!onSide || overlap <= EPS) continue
    if (dist < bestDist - EPS || (Math.abs(dist - bestDist) < EPS && overlap > bestOverlap)) {
      bestDist = dist
      bestOverlap = overlap
      best = zone.id
    }
  }
  return best
}

// ---- drop preview ------------------------------------------------------------

/** What the drop overlay draws — always the exact rect the drop will produce. */
export interface ZoneDragPreview {
  rect: Rect
  /** 'swap' = trade panes (or move into an empty zone); 'split' = cut the zone */
  kind: 'swap' | 'move' | 'split'
  dir?: Dir
}

/**
 * The preview for hovering a zone. Two gestures only, and each mirrors exactly
 * what `dropPaneOnZone` will apply:
 *   • centre (side null) → the whole zone: swap panes, or move into an empty one
 *   • an edge band       → the half of the zone the dragged pane will occupy
 */
export function zoneDragPreview(
  layout: ZoneLayout,
  zoneId: string,
  side: Dir | null
): ZoneDragPreview | null {
  const zone = zoneById(layout, zoneId)
  if (!zone) return null
  const rect = zoneRect(zone)
  if (!side) return { rect, kind: paneInZone(layout, zoneId) ? 'swap' : 'move' }
  const half: Rect =
    side === 'left'
      ? { ...rect, w: rect.w / 2 }
      : side === 'right'
        ? { x: rect.x + rect.w / 2, y: rect.y, w: rect.w / 2, h: rect.h }
        : side === 'up'
          ? { ...rect, h: rect.h / 2 }
          : { x: rect.x, y: rect.y + rect.h / 2, w: rect.w, h: rect.h / 2 }
  return { rect: half, kind: 'split', dir: side }
}

/** Apply a drop: centre swaps/moves (assignment only), an edge splits the zone. */
export function dropPaneOnZone(
  layout: ZoneLayout,
  paneId: string,
  zoneId: string,
  side: Dir | null
): ZoneLayout {
  const from = zoneOfPane(layout, paneId)
  if (from === zoneId) return layout
  if (!side) return movePaneToZone(layout, paneId, zoneId)
  const split = splitZone(layout, zoneId, side)
  if (!split) return layout
  return { ...split.layout, assign: { ...split.layout.assign, [paneId]: split.newZoneId } }
}

// ---- snapping ----------------------------------------------------------------

/** Every zone edge along an axis — the magnets an editor drag is pulled onto. */
export function zoneGuides(zones: Zone[], axis: 'x' | 'y', exceptId?: string): number[] {
  const out = new Set<number>([0, 100])
  for (const zone of zones) {
    if (zone.id === exceptId) continue
    out.add(r4(axis === 'x' ? zone.x : zone.y))
    out.add(r4(axis === 'x' ? zone.x + zone.w : zone.y + zone.h))
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Snap a coordinate to the substrate, preferring a nearby zone edge when one is
 * within the magnet radius. `bypass` (the modifier) returns the raw value.
 */
export function snapAxis(
  value: number,
  divisions: number,
  guides: number[],
  bypass = false
): number {
  const raw = clamp(value, 0, 100)
  if (bypass) return r4(raw)
  const step = 100 / Math.max(1, divisions)
  let best = Math.round(raw / step) * step
  let bestDist = Math.abs(raw - best)
  for (const guide of guides) {
    const dist = Math.abs(raw - guide)
    if (dist < bestDist && dist <= MAGNET) {
      best = guide
      bestDist = dist
    }
  }
  return r4(clamp(best, 0, 100))
}

// ---- even out ----------------------------------------------------------------

/** Piecewise-linear map that carries `from[i]` onto `to[i]`. */
export function remap(value: number, from: number[], to: number[]): number {
  if (value <= from[0]) return to[0]
  for (let i = 1; i < from.length; i++) {
    if (value <= from[i] + EPS) {
      const span = from[i] - from[i - 1]
      const t = span < EPS ? 0 : (value - from[i - 1]) / span
      return to[i - 1] + t * (to[i] - to[i - 1])
    }
  }
  return to[to.length - 1]
}

/**
 * Rebalance: keep the layout's topology but distribute the boundary lines
 * evenly. A 70/30 pair of columns becomes 50/50; three ragged rows become
 * thirds. Monotone, so it can neither introduce an overlap nor lose a zone.
 */
export function evenOutZones(layout: ZoneLayout): ZoneLayout {
  const axisLines = (axis: 'x' | 'y'): { from: number[]; to: number[] } => {
    const set = new Set<number>([0, 100])
    for (const zone of layout.zones) {
      set.add(r4(axis === 'x' ? zone.x : zone.y))
      set.add(r4(axis === 'x' ? zone.x + zone.w : zone.y + zone.h))
    }
    const from = [...set].filter((v) => v >= -EPS && v <= 100 + EPS).sort((a, b) => a - b)
    const to = from.map((_, index) => (index / (from.length - 1)) * 100)
    return { from, to }
  }
  const linesX = axisLines('x')
  const linesY = axisLines('y')
  if (linesX.from.length < 2 || linesY.from.length < 2) return layout
  const zones = layout.zones.map((zone) => {
    const x = r4(remap(zone.x, linesX.from, linesX.to))
    const y = r4(remap(zone.y, linesY.from, linesY.to))
    return {
      ...zone,
      x,
      y,
      w: r4(remap(zone.x + zone.w, linesX.from, linesX.to) - x),
      h: r4(remap(zone.y + zone.h, linesY.from, linesY.to) - y)
    }
  })
  return { ...layout, zones }
}

// ---- presets -----------------------------------------------------------------

/** A named zone arrangement, as bare rectangles (ids are minted on apply). */
export interface ZonePreset {
  id: string
  label: string
  /** which section of the picker it belongs to */
  group: 'grid' | 'arrangement'
  rects: Rect[]
}

/** A third of the canvas, and the remainder that closes the gap at 100. */
const THIRD = 33.3333
const LAST_THIRD = 33.3334
const TWO_THIRDS = 66.6666

/**
 * The house presets. Every set tiles the whole 0–100 canvas with no gaps and no
 * overlap, and the "main" region comes first so panes land in it in reading
 * order when a preset is applied.
 */
export const ZONE_PRESETS: ZonePreset[] = [
  {
    id: 'single',
    label: 'Single',
    group: 'grid',
    rects: [{ x: 0, y: 0, w: 100, h: 100 }]
  },
  {
    id: 'cols-2',
    label: '2 columns',
    group: 'grid',
    rects: [
      { x: 0, y: 0, w: 50, h: 100 },
      { x: 50, y: 0, w: 50, h: 100 }
    ]
  },
  {
    id: 'rows-2',
    label: '2 rows',
    group: 'grid',
    rects: [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 50, w: 100, h: 50 }
    ]
  },
  {
    id: 'grid-2x2',
    label: '2 × 2',
    group: 'grid',
    rects: [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 50, y: 0, w: 50, h: 50 },
      { x: 0, y: 50, w: 50, h: 50 },
      { x: 50, y: 50, w: 50, h: 50 }
    ]
  },
  {
    id: 'cols-3',
    label: '3 columns',
    group: 'grid',
    rects: [
      { x: 0, y: 0, w: THIRD, h: 100 },
      { x: THIRD, y: 0, w: THIRD, h: 100 },
      { x: TWO_THIRDS, y: 0, w: LAST_THIRD, h: 100 }
    ]
  },
  {
    id: 'grid-2x3',
    label: '2 × 3',
    group: 'grid',
    rects: [
      { x: 0, y: 0, w: THIRD, h: 50 },
      { x: THIRD, y: 0, w: THIRD, h: 50 },
      { x: TWO_THIRDS, y: 0, w: LAST_THIRD, h: 50 },
      { x: 0, y: 50, w: THIRD, h: 50 },
      { x: THIRD, y: 50, w: THIRD, h: 50 },
      { x: TWO_THIRDS, y: 50, w: LAST_THIRD, h: 50 }
    ]
  },
  {
    id: 'main-side',
    label: 'Main + side',
    group: 'arrangement',
    rects: [
      { x: 0, y: 0, w: TWO_THIRDS, h: 100 },
      { x: TWO_THIRDS, y: 0, w: LAST_THIRD, h: 100 }
    ]
  },
  {
    id: 'main-2',
    label: 'Main + 2',
    group: 'arrangement',
    rects: [
      { x: 0, y: 0, w: TWO_THIRDS, h: 100 },
      { x: TWO_THIRDS, y: 0, w: LAST_THIRD, h: 50 },
      { x: TWO_THIRDS, y: 50, w: LAST_THIRD, h: 50 }
    ]
  },
  {
    id: 'main-3',
    label: 'Main + 3',
    group: 'arrangement',
    rects: [
      { x: 0, y: 0, w: TWO_THIRDS, h: 100 },
      { x: TWO_THIRDS, y: 0, w: LAST_THIRD, h: THIRD },
      { x: TWO_THIRDS, y: THIRD, w: LAST_THIRD, h: THIRD },
      { x: TWO_THIRDS, y: TWO_THIRDS, w: LAST_THIRD, h: LAST_THIRD }
    ]
  },
  {
    id: 'top-2',
    label: 'Top + 2 below',
    group: 'arrangement',
    rects: [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 50, w: 50, h: 50 },
      { x: 50, y: 50, w: 50, h: 50 }
    ]
  }
]

/**
 * Re-seed the canvas from a rect set, keeping panes in reading order so nothing
 * is lost (any pane past the preset's zone count is left unassigned for
 * reconcile to place, which splits the largest zone rather than dropping it).
 */
export function applyZonePreset(layout: ZoneLayout, rects: readonly Rect[]): ZoneLayout {
  return zonesFromRects(rects, zonePaneIds(layout), layout.snap)
}

/** Recognise an even rows×cols zone set, so the toolbar picker can show it. */
export function matchGridZones(layout: ZoneLayout): GridSize | null {
  const count = layout.zones.length
  if (count === 0) return null
  const xs = [...new Set(layout.zones.map((zone) => r4(zone.x)))].sort((a, b) => a - b)
  const ys = [...new Set(layout.zones.map((zone) => r4(zone.y)))].sort((a, b) => a - b)
  const cols = xs.length
  const rows = ys.length
  if (rows * cols !== count) return null
  const width = 100 / cols
  const height = 100 / rows
  const ok = layout.zones.every(
    (zone) =>
      Math.abs(zone.w - width) < 0.02 &&
      Math.abs(zone.h - height) < 0.02 &&
      xs.some((v) => Math.abs(v - zone.x) < 0.02) &&
      ys.some((v) => Math.abs(v - zone.y) < 0.02)
  )
  return ok ? { rows, cols } : null
}

const sameRect = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) < EPS &&
  Math.abs(a.y - b.y) < EPS &&
  Math.abs(a.w - b.w) < EPS &&
  Math.abs(a.h - b.h) < EPS

/** Order-insensitive rect-set equality, within the geometry tolerance. */
function sameRectSet(a: readonly Rect[], b: readonly Rect[]): boolean {
  if (a.length !== b.length) return false
  const unmatched = [...b]
  for (const rect of a) {
    const index = unmatched.findIndex((other) => sameRect(rect, other))
    if (index < 0) return false
    unmatched.splice(index, 1)
  }
  return true
}

/**
 * The preset this layout IS, if any — the picker highlights it. Order-insensitive
 * because a layout's zone order is an artefact of how it was edited, not of what
 * it looks like.
 */
export function matchPreset(layout: ZoneLayout): string | null {
  const rects = layout.zones.map(zoneRect)
  const preset = ZONE_PRESETS.find((candidate) => sameRectSet(candidate.rects, rects))
  return preset ? preset.id : null
}

/**
 * Apply a preset by id, keeping every pane placed. Panes beyond the preset's
 * zone count are handed to `reconcileZones`, which splits the largest zone for
 * each one exactly as it does for a newly spawned pane.
 */
export function applyPresetById(
  layout: ZoneLayout,
  presetId: string,
  paneIds: string[]
): ZoneLayout {
  const preset = ZONE_PRESETS.find((candidate) => candidate.id === presetId)
  if (!preset) return layout
  const want = new Set(paneIds)
  const placed = zonePaneIds(layout)
  const ordered = [
    ...placed.filter((paneId) => want.has(paneId)),
    ...paneIds.filter((paneId) => !placed.includes(paneId))
  ]
  const seeded = zonesFromRects(preset.rects, ordered, layout.snap)
  return reconcileZones(seeded, ordered, { rows: 1, cols: 1 })
}
