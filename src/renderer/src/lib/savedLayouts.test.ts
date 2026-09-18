import { describe, expect, it } from 'vitest'
import type { SavedLayout, Zone } from '../../../shared/types'
import {
  addSavedLayout,
  deleteSavedLayout,
  renameSavedLayout,
  reorderSavedLayout,
  uniqueLayoutName
} from './savedLayouts'

const HALVES: Zone[] = [
  { id: 'a', x: 0, y: 0, w: 50, h: 100 },
  { id: 'b', x: 50, y: 0, w: 50, h: 100 }
]

const named = (list: readonly SavedLayout[]): string[] => list.map((entry) => entry.name)

describe('addSavedLayout', () => {
  it('appends a layout with a trimmed name and renumbered zone ids', () => {
    const list = addSavedLayout([], '  Two columns  ', HALVES)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Two columns')
    expect(list[0].zones.map((zone) => zone.id)).toEqual(['z1', 'z2'])
    expect(list[0].zones[1]).toEqual({ id: 'z2', x: 50, y: 0, w: 50, h: 100 })
  })

  it('falls back to a placeholder name rather than saving a nameless layout', () => {
    expect(addSavedLayout([], '   ', HALVES)[0].name).toBe('Layout')
  })

  it('de-duplicates a name that is already taken, ignoring case', () => {
    let list = addSavedLayout([], 'Wide', HALVES)
    list = addSavedLayout(list, 'wide', HALVES)
    list = addSavedLayout(list, 'Wide', HALVES)
    expect(named(list)).toEqual(['Wide', 'wide 2', 'Wide 3'])
  })

  it('refuses a layout with no zones', () => {
    expect(addSavedLayout([], 'Empty', [])).toEqual([])
  })

  it('does not mutate the list it was given', () => {
    const list = addSavedLayout([], 'One', HALVES)
    const next = addSavedLayout(list, 'Two', HALVES)
    expect(list).toHaveLength(1)
    expect(next).toHaveLength(2)
  })

  it('copies the zones, so editing on after saving cannot reach back', () => {
    const zones = HALVES.map((zone) => ({ ...zone }))
    const list = addSavedLayout([], 'One', zones)
    zones[0].w = 10
    expect(list[0].zones[0].w).toBe(50)
  })
})

describe('renameSavedLayout', () => {
  it('renames in place', () => {
    const list = addSavedLayout([], 'Old', HALVES)
    expect(named(renameSavedLayout(list, list[0].id, ' New '))).toEqual(['New'])
  })

  it('refuses a blank name and leaves the list as it was', () => {
    const list = addSavedLayout([], 'Old', HALVES)
    expect(named(renameSavedLayout(list, list[0].id, '   '))).toEqual(['Old'])
  })

  it('de-duplicates against the other entries, but not against itself', () => {
    let list = addSavedLayout([], 'Wide', HALVES)
    list = addSavedLayout(list, 'Tall', HALVES)
    expect(named(renameSavedLayout(list, list[1].id, 'Wide'))).toEqual(['Wide', 'Wide 2'])
    expect(named(renameSavedLayout(list, list[0].id, 'Wide'))).toEqual(['Wide', 'Tall'])
  })

  it('ignores an id that is not in the list', () => {
    const list = addSavedLayout([], 'Wide', HALVES)
    expect(named(renameSavedLayout(list, 'nope', 'Other'))).toEqual(['Wide'])
  })
})

describe('reorderSavedLayout', () => {
  const build = (): SavedLayout[] => {
    let list: SavedLayout[] = []
    for (const name of ['A', 'B', 'C']) list = addSavedLayout(list, name, HALVES)
    return list
  }

  it('moves an entry to the target index', () => {
    expect(named(reorderSavedLayout(build(), 2, 0))).toEqual(['C', 'A', 'B'])
    expect(named(reorderSavedLayout(build(), 0, 1))).toEqual(['B', 'A', 'C'])
  })

  it('clamps a target past either end', () => {
    expect(named(reorderSavedLayout(build(), 0, 99))).toEqual(['B', 'C', 'A'])
    expect(named(reorderSavedLayout(build(), 2, -4))).toEqual(['C', 'A', 'B'])
  })

  it('is a no-op for a target that is already the source, or a bad source', () => {
    expect(named(reorderSavedLayout(build(), 1, 1))).toEqual(['A', 'B', 'C'])
    expect(named(reorderSavedLayout(build(), 5, 0))).toEqual(['A', 'B', 'C'])
    expect(named(reorderSavedLayout(build(), -1, 0))).toEqual(['A', 'B', 'C'])
  })
})

describe('deleteSavedLayout', () => {
  it('removes one entry and leaves the rest in order', () => {
    let list = addSavedLayout([], 'A', HALVES)
    list = addSavedLayout(list, 'B', HALVES)
    expect(named(deleteSavedLayout(list, list[0].id))).toEqual(['B'])
    expect(named(deleteSavedLayout(list, 'nope'))).toEqual(['A', 'B'])
  })
})

describe('uniqueLayoutName', () => {
  it('walks the suffix until the name is free', () => {
    let list = addSavedLayout([], 'Main', HALVES)
    list = addSavedLayout(list, 'Main', HALVES)
    expect(uniqueLayoutName(list, 'Main')).toBe('Main 3')
  })
})
