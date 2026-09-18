import { describe, expect, it } from 'vitest'
import type { RecentWorkspace } from '../../../shared/types'
import { MAX_RECENTS, normalizeRecents, rememberWorkspace } from './recents'

describe('rememberWorkspace', () => {
  it('puts the newest visit first', () => {
    let list: RecentWorkspace[] = []
    list = rememberWorkspace(list, { name: 'A', rootDir: '/p/a' }, 1)
    list = rememberWorkspace(list, { name: 'B', rootDir: '/p/b' }, 2)
    expect(list.map((r) => r.rootDir)).toEqual(['/p/b', '/p/a'])
  })

  it('replaces an existing folder and takes the new name', () => {
    let list = rememberWorkspace([], { name: 'Old', rootDir: '/p/a' }, 1)
    list = rememberWorkspace(list, { name: 'New', rootDir: '/p/a/' }, 5)
    expect(list).toEqual([{ rootDir: '/p/a/', name: 'New', lastOpenedAt: 5 }])
  })

  it('falls back to the path when the name is blank', () => {
    expect(rememberWorkspace([], { name: '  ', rootDir: '/p/a' }, 1)[0].name).toBe('/p/a')
  })

  it('ignores a blank or missing root', () => {
    const list = rememberWorkspace([], { name: 'A', rootDir: '/p/a' }, 1)
    expect(rememberWorkspace(list, { name: 'X', rootDir: '   ' }, 2)).toBe(list)
    expect(rememberWorkspace(list, { name: 'X', rootDir: undefined }, 2)).toBe(list)
  })

  it('caps the history, dropping the oldest', () => {
    let list: RecentWorkspace[] = []
    for (let visit = 0; visit < MAX_RECENTS + 5; visit++) {
      list = rememberWorkspace(list, { name: `W${visit}`, rootDir: `/p/${visit}` }, visit)
    }
    expect(list).toHaveLength(MAX_RECENTS)
    expect(list[0].rootDir).toBe(`/p/${MAX_RECENTS + 4}`)
    expect(list.some((r) => r.rootDir === '/p/0')).toBe(false)
  })
})

describe('normalizeRecents', () => {
  it('returns an empty history for anything that is not an array', () => {
    expect(normalizeRecents(null)).toEqual([])
    expect(normalizeRecents({ rootDir: '/p/a' })).toEqual([])
  })

  it('drops malformed rows, de-duplicates and re-sorts', () => {
    const raw = [
      { rootDir: '/p/a', name: 'A', lastOpenedAt: 1 },
      { rootDir: '/p/a/', name: 'duplicate', lastOpenedAt: 9 },
      { rootDir: '', name: 'blank', lastOpenedAt: 9 },
      { name: 'no root', lastOpenedAt: 9 },
      'nonsense',
      { rootDir: '/p/b', name: 'B', lastOpenedAt: 4 },
      { rootDir: '/p/c', lastOpenedAt: 'soon' }
    ]
    expect(normalizeRecents(raw)).toEqual([
      { rootDir: '/p/b', name: 'B', lastOpenedAt: 4 },
      { rootDir: '/p/a', name: 'A', lastOpenedAt: 1 },
      { rootDir: '/p/c', name: '/p/c', lastOpenedAt: 0 }
    ])
  })

  it('re-caps an oversized saved file', () => {
    const raw = Array.from({ length: MAX_RECENTS + 3 }, (_, index) => ({
      rootDir: `/p/${index}`,
      name: `W${index}`,
      lastOpenedAt: index
    }))
    expect(normalizeRecents(raw)).toHaveLength(MAX_RECENTS)
  })
})
