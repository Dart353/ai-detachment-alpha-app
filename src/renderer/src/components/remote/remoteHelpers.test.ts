import { describe, expect, it } from 'vitest'
import type { FeedPane, FeedWorkspace } from '../../../../shared/relayProtocol'
import { evenZones, isPairingKey, normalizePairingKey, slotsOf } from './remoteHelpers'

function pane(id: string): FeedPane {
  return { id, name: id, kind: 'claude', status: 'idle', title: null, lastPrompt: null, model: null, summary: null, lastActivity: 0 }
}

function workspace(panes: FeedPane[], layout?: FeedWorkspace['layout']): FeedWorkspace {
  return { id: 'ws', name: 'ws', rootDir: '/ws', panes, ...(layout ? { layout } : {}) }
}

describe('evenZones', () => {
  it('covers the canvas exactly, whatever the count', () => {
    for (const count of [1, 2, 3, 4, 5, 7, 9]) {
      const zones = evenZones(count)
      expect(zones).toHaveLength(count)
      const area = zones.reduce((sum, zone) => sum + zone.w * zone.h, 0)
      expect(Math.round(area)).toBe(10000)
    }
    expect(evenZones(0)).toEqual([])
  })

  it('stretches a short last row across the width', () => {
    const zones = evenZones(3)
    expect(zones[2]).toMatchObject({ x: 0, y: 50, w: 100, h: 50 })
  })
})

describe('slotsOf', () => {
  const zones = [
    { id: 'a', x: 0, y: 0, w: 50, h: 100 },
    { id: 'b', x: 50, y: 0, w: 50, h: 100 }
  ]

  it('puts each pane in the tile its own desktop has it in', () => {
    const slots = slotsOf(workspace([pane('p1'), pane('p2')], { zones, assign: { p1: 'b', p2: 'a' } }))
    expect(slots.map((slot) => [slot.pane.id, slot.zone.id])).toEqual([
      ['p1', 'b'],
      ['p2', 'a']
    ])
  })

  it('leaves out a pane with no tile, and never doubles a tile up', () => {
    const slots = slotsOf(
      workspace([pane('p1'), pane('p2'), pane('p3')], { zones, assign: { p1: 'a', p2: 'a', p3: 'gone' } })
    )
    expect(slots.map((slot) => slot.pane.id)).toEqual(['p1'])
  })

  it('falls back to an even grid when the machine sent no layout, or one that places nothing', () => {
    expect(slotsOf(workspace([pane('p1'), pane('p2')])).map((slot) => slot.zone.w)).toEqual([50, 50])
    expect(slotsOf(workspace([pane('p1')], { zones, assign: {} }))).toHaveLength(1)
    expect(slotsOf(workspace([]))).toEqual([])
  })
})

describe('pairing keys', () => {
  const key = 'ab'.repeat(32)

  it('drops whitespace and case from a pasted key', () => {
    expect(normalizePairingKey(`  ${key.slice(0, 32).toUpperCase()}\n${key.slice(32)} `)).toBe(key)
  })

  it('accepts exactly 64 hex characters', () => {
    expect(isPairingKey(key)).toBe(true)
    expect(isPairingKey(key.slice(1))).toBe(false)
    expect(isPairingKey(key.slice(1) + 'g')).toBe(false)
  })
})
