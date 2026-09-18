import { describe, expect, it, vi } from 'vitest'
import type { FileTreeEntry } from '../../../shared/types'
import { ExplorerTreeCache } from './explorerTreeCache'

/** A listing built from bare names under `/w`, so a test reads as its directory. */
function listing(dir: string, names: string[], kind: 'file' | 'dir' = 'file'): FileTreeEntry[] {
  return names.map((name) => ({ name, path: `${dir}/${name}`, kind }))
}

/** A deferred promise, so a test can hold a read open and act while it is in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('ExplorerTreeCache.load', () => {
  it('reports the first listing as changed and the identical one as unchanged', async () => {
    const readDir = vi.fn(async () => listing('/w', ['a.ts', 'b.ts']))
    const cache = new ExplorerTreeCache(readDir)

    const first = await cache.load('/w')
    expect(first.changed).toBe(true)
    expect(first.ids).toEqual(['/w/a.ts', '/w/b.ts'])

    const second = await cache.refresh('/w')
    expect(second.changed).toBe(false)
    expect(second.removed).toEqual([])
  })

  it('joins a read already in flight instead of reading twice', async () => {
    const gate = deferred<FileTreeEntry[]>()
    const readDir = vi.fn(() => gate.promise)
    const cache = new ExplorerTreeCache(readDir)

    const a = cache.load('/w')
    const b = cache.load('/w')
    gate.resolve(listing('/w', ['a.ts']))

    expect(await a).toEqual(await b)
    expect(readDir).toHaveBeenCalledTimes(1)
  })

  it('caches nothing about a directory whose read failed', async () => {
    const readDir = vi
      .fn<(dir: string) => Promise<FileTreeEntry[]>>()
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce(listing('/w', ['a.ts']))
    const cache = new ExplorerTreeCache(readDir)

    await expect(cache.load('/w')).rejects.toThrow('EACCES')
    expect(cache.hasChildren('/w')).toBe(false)
    expect((await cache.load('/w')).ids).toEqual(['/w/a.ts'])
  })
})

describe('ExplorerTreeCache.refresh', () => {
  it('forgets a removed entry and everything cached beneath it', async () => {
    const dirs: Record<string, FileTreeEntry[]> = {
      '/w': [
        { name: 'src', path: '/w/src', kind: 'dir' },
        { name: 'readme.md', path: '/w/readme.md', kind: 'file' }
      ],
      '/w/src': listing('/w/src', ['index.ts'])
    }
    const cache = new ExplorerTreeCache(async (dir) => dirs[dir] ?? [])

    await cache.load('/w')
    await cache.load('/w/src')
    expect(cache.get('/w/src/index.ts')).toBeDefined()

    dirs['/w'] = [{ name: 'readme.md', path: '/w/readme.md', kind: 'file' }]
    const load = await cache.refresh('/w')

    expect(load.changed).toBe(true)
    expect(load.removed.sort()).toEqual(['/w/src', '/w/src/index.ts'])
    expect(cache.get('/w/src/index.ts')).toBeUndefined()
    expect(cache.hasChildren('/w/src')).toBe(false)
  })

  it('restates an entry whose kind changed on disk', async () => {
    let entries: FileTreeEntry[] = [{ name: 'note.txt', path: '/w/note.txt', kind: 'file' }]
    const cache = new ExplorerTreeCache(async () => entries)

    await cache.load('/w')
    entries = [{ name: 'note.txt', path: '/w/note.txt', kind: 'dir' }]
    const load = await cache.refresh('/w')

    // the ids are identical, so only `restated` tells the panel to redraw the row
    expect(load.changed).toBe(false)
    expect(load.restated).toEqual([{ name: 'note.txt', path: '/w/note.txt', kind: 'dir' }])
  })

  it('re-reads when a change lands behind an in-flight read', async () => {
    const gates = [deferred<FileTreeEntry[]>(), deferred<FileTreeEntry[]>()]
    let call = 0
    const readDir = vi.fn(() => gates[call++].promise)
    const cache = new ExplorerTreeCache(readDir)

    const pending = cache.load('/w')
    // the change arrives while the first read is still enumerating: its answer is
    // already out of date, so the cache must read again rather than hand it back
    const joined = cache.refresh('/w')
    gates[0].resolve(listing('/w', ['stale.ts']))
    await Promise.resolve()
    gates[1].resolve(listing('/w', ['fresh.ts']))

    expect((await pending).ids).toEqual(['/w/fresh.ts'])
    expect((await joined).ids).toEqual(['/w/fresh.ts'])
    expect(readDir).toHaveBeenCalledTimes(2)
  })
})
