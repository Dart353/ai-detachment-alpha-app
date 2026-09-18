import { describe, expect, it } from 'vitest'

import {
  EPS,
  MIN_ZONE,
  ZONE_PRESETS,
  applyPresetById,
  computeZoneRects,
  deleteZone,
  dropPaneOnZone,
  hasOverlap,
  makeGridZones,
  matchPreset,
  mergeZones,
  moveSharedEdge,
  paneInZone,
  reconcileZones,
  sharedEdges,
  splitZone,
  zoneById,
  zoneOfPane,
  zonesFromRects,
  type GridSize,
  type Rect,
  type ZoneLayout
} from './zones'

const DEFAULT_GRID: GridSize = { rows: 1, cols: 2 }

const seed = (paneIds: string[]): ZoneLayout =>
  reconcileZones(undefined, paneIds, DEFAULT_GRID)

const rectOf = (layout: ZoneLayout, zoneId: string): Rect => {
  const zone = zoneById(layout, zoneId)
  if (!zone) throw new Error(`no zone ${zoneId}`)
  return { x: zone.x, y: zone.y, w: zone.w, h: zone.h }
}

const allPlaced = (layout: ZoneLayout, paneIds: string[]): boolean =>
  paneIds.every((paneId) => !!zoneOfPane(layout, paneId))

describe('reconcileZones', () => {
  it('places every pane and is idempotent', () => {
    const once = seed(['a', 'b', 'c'])
    expect(allPlaced(once, ['a', 'b', 'c'])).toBe(true)
    const twice = reconcileZones(once, ['a', 'b', 'c'], DEFAULT_GRID)
    expect(twice).toBe(once)
  })

  it('places a newly added pane without disturbing the others', () => {
    const before = seed(['a', 'b'])
    const after = reconcileZones(before, ['a', 'b', 'c'], DEFAULT_GRID)
    expect(allPlaced(after, ['a', 'b', 'c'])).toBe(true)
    expect(zoneOfPane(after, 'a')).toBe(zoneOfPane(before, 'a'))
    expect(hasOverlap(after.zones)).toBe(false)
    expect(reconcileZones(after, ['a', 'b', 'c'], DEFAULT_GRID)).toBe(after)
  })

  it('drops a removed pane and keeps the rest assigned', () => {
    const before = seed(['a', 'b', 'c'])
    const after = reconcileZones(before, ['a', 'c'], DEFAULT_GRID)
    expect(after.assign.b).toBeUndefined()
    expect(allPlaced(after, ['a', 'c'])).toBe(true)
    expect(reconcileZones(after, ['a', 'c'], DEFAULT_GRID)).toBe(after)
  })

  it('never leaves a pane unassigned, however many there are', () => {
    const paneIds = Array.from({ length: 9 }, (_, index) => `p${index}`)
    const layout = seed(paneIds)
    expect(allPlaced(layout, paneIds)).toBe(true)
    expect(hasOverlap(layout.zones)).toBe(false)
  })
})

describe('split / merge', () => {
  it('round-trips the geometry', () => {
    const layout = makeGridZones(1, 2)
    const before = rectOf(layout, 'z1')
    const split = splitZone(layout, 'z1', 'right')
    expect(split).not.toBeNull()
    if (!split) return
    expect(split.layout.zones).toHaveLength(3)
    const merged = mergeZones(split.layout, 'z1', split.newZoneId)
    expect(merged).not.toBeNull()
    if (!merged) return
    expect(merged.zones).toHaveLength(2)
    expect(rectOf(merged, 'z1')).toEqual(before)
  })
})

describe('moveSharedEdge', () => {
  it('never shrinks a zone below MIN_ZONE', () => {
    const layout = makeGridZones(1, 2)
    const edge = sharedEdges(layout).find((candidate) => candidate.axis === 'x')
    expect(edge).toBeDefined()
    if (!edge) return
    for (const target of [-50, 0, 1, 99, 100, 150]) {
      const moved = moveSharedEdge(layout, edge, target)
      for (const zone of moved.zones) {
        expect(zone.w).toBeGreaterThanOrEqual(MIN_ZONE - EPS)
        expect(zone.h).toBeGreaterThanOrEqual(MIN_ZONE - EPS)
      }
      expect(hasOverlap(moved.zones)).toBe(false)
    }
  })
})

describe('dropPaneOnZone', () => {
  it('swaps on centre without changing any zone rect', () => {
    const before = seed(['a', 'b'])
    const zoneA = zoneOfPane(before, 'a')
    const zoneB = zoneOfPane(before, 'b')
    expect(zoneB).toBeDefined()
    if (!zoneB) return
    const after = dropPaneOnZone(before, 'a', zoneB, null)
    expect(after.zones).toEqual(before.zones)
    expect(zoneOfPane(after, 'a')).toBe(zoneB)
    expect(zoneOfPane(after, 'b')).toBe(zoneA)
  })

  it('splits on an edge and lands the dragged pane in the new half', () => {
    const before = seed(['a', 'b'])
    const zoneB = zoneOfPane(before, 'b')
    expect(zoneB).toBeDefined()
    if (!zoneB) return
    const targetBefore = rectOf(before, zoneB)
    const after = dropPaneOnZone(before, 'a', zoneB, 'down')
    expect(after.zones).toHaveLength(before.zones.length + 1)
    const zoneOfA = zoneOfPane(after, 'a')
    expect(zoneOfA).toBeDefined()
    if (!zoneOfA) return
    const half = rectOf(after, zoneOfA)
    expect(half.h).toBeCloseTo(targetBefore.h / 2, 3)
    expect(half.y).toBeCloseTo(targetBefore.y + targetBefore.h / 2, 3)
    expect(paneInZone(after, zoneB)).toBe('b')
    expect(hasOverlap(after.zones)).toBe(false)
  })
})

describe('presets', () => {
  it('has the ten designed entries', () => {
    expect(ZONE_PRESETS.map((preset) => preset.id)).toEqual([
      'single',
      'cols-2',
      'rows-2',
      'grid-2x2',
      'cols-3',
      'grid-2x3',
      'main-side',
      'main-2',
      'main-3',
      'top-2'
    ])
  })

  it.each(ZONE_PRESETS)('$id tiles the canvas exactly', (preset) => {
    const layout = zonesFromRects(preset.rects, [])
    expect(hasOverlap(layout.zones)).toBe(false)
    const area = preset.rects.reduce((sum, rect) => sum + rect.w * rect.h, 0)
    expect(area).toBeCloseTo(100 * 100, 1)
  })

  it.each(ZONE_PRESETS)('$id is recognised after applyPresetById', (preset) => {
    const layout = applyPresetById(seed(['a']), preset.id, ['a'])
    expect(matchPreset(layout)).toBe(preset.id)
    expect(allPlaced(layout, ['a'])).toBe(true)
  })

  it('keeps every pane assigned when there are more panes than zones', () => {
    const paneIds = ['a', 'b', 'c', 'd', 'e']
    const layout = applyPresetById(seed(paneIds), 'cols-2', paneIds)
    expect(allPlaced(layout, paneIds)).toBe(true)
    expect(hasOverlap(layout.zones)).toBe(false)
  })

  it('reports null for a layout that matches no preset', () => {
    const layout = zonesFromRects(
      [
        { x: 0, y: 0, w: 20, h: 100 },
        { x: 20, y: 0, w: 80, h: 100 }
      ],
      []
    )
    expect(matchPreset(layout)).toBeNull()
  })
})

describe('computeZoneRects', () => {
  it('returns a rect for each assigned pane', () => {
    const paneIds = ['a', 'b', 'c']
    const layout = seed(paneIds)
    const rects = computeZoneRects(layout)
    expect([...rects.keys()].sort()).toEqual(paneIds)
    for (const paneId of paneIds) {
      const zoneId = zoneOfPane(layout, paneId)
      expect(zoneId).toBeDefined()
      if (!zoneId) continue
      expect(rects.get(paneId)).toEqual(rectOf(layout, zoneId))
    }
  })

  it('honours a pane filter', () => {
    const layout = seed(['a', 'b'])
    expect([...computeZoneRects(layout, ['b']).keys()]).toEqual(['b'])
  })
})

describe('deleteZone', () => {
  it('moves the zone\'s pane to the nearest free zone', () => {
    const layout = zonesFromRects(
      [
        { x: 0, y: 0, w: 50, h: 100 },
        { x: 50, y: 0, w: 50, h: 50 },
        { x: 50, y: 50, w: 50, h: 50 }
      ],
      ['a'],
      DEFAULT_GRID
    )
    const home = zoneOfPane(layout, 'a')!
    const after = deleteZone(layout, home)
    expect(after.zones).toHaveLength(2)
    expect(zoneOfPane(after, 'a')).not.toBe(home)
    expect(zoneById(after, zoneOfPane(after, 'a')!)).toBeTruthy()
    expect(hasOverlap(after.zones)).toBe(false)
  })

  it('never doubles two panes up in one zone when nothing is free', () => {
    const layout = zonesFromRects(
      [
        { x: 0, y: 0, w: 50, h: 100 },
        { x: 50, y: 0, w: 50, h: 100 }
      ],
      ['a', 'b'],
      DEFAULT_GRID
    )
    const after = deleteZone(layout, zoneOfPane(layout, 'a')!)
    expect(after.zones).toHaveLength(1)
    expect(zoneOfPane(after, 'a')).toBeUndefined()
    expect(zoneOfPane(after, 'b')).toBe(after.zones[0].id)
    // reconcile then gives the homeless pane a zone of its own again
    const placed = reconcileZones(after, ['a', 'b'], DEFAULT_GRID)
    expect(allPlaced(placed, ['a', 'b'])).toBe(true)
    expect(hasOverlap(placed.zones)).toBe(false)
  })

  it('keeps the last zone', () => {
    const layout = zonesFromRects([{ x: 0, y: 0, w: 100, h: 100 }], [], DEFAULT_GRID)
    expect(deleteZone(layout, layout.zones[0].id)).toBe(layout)
  })
})
