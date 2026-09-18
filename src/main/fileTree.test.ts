import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDir,
  createFile,
  FileTreeWatcher,
  movePath,
  readDir,
  readFile,
  renamePath
} from './fileTree'

/** Everything here runs against a real temp directory: this module is fs, not logic. */
let root = ''

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ada-tree-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(relative: string, contents: string | Buffer): string {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
  return target
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('readDir', () => {
  it('lists directories first, then natural case-insensitive order', async () => {
    write('file10.txt', '')
    write('file2.txt', '')
    write('Apple.txt', '')
    fs.mkdirSync(path.join(root, 'zeta'))
    fs.mkdirSync(path.join(root, 'beta'))

    const entries = await readDir(root)
    expect(entries.map((entry) => entry.name)).toEqual([
      'beta',
      'zeta',
      'Apple.txt',
      'file2.txt',
      'file10.txt'
    ])
    expect(entries[0].kind).toBe('dir')
    expect(entries[0].path).toBe(path.join(root, 'beta'))
  })

  it('hides .git and marks symlinks without following them', async () => {
    fs.mkdirSync(path.join(root, '.git'))
    write('real.txt', 'hi')
    fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'))

    const entries = await readDir(root)
    expect(entries.map((entry) => entry.name)).toEqual(['link.txt', 'real.txt'])
    expect(entries[0].symlink).toBe(true)
    expect(entries[0].kind).toBe('file')
  })

  it('resolves to an empty list for a missing directory', async () => {
    expect(await readDir(path.join(root, 'nope'))).toEqual([])
  })
})

describe('readFile', () => {
  it('decodes text', async () => {
    write('notes.md', '# hello')
    expect(await readFile(path.join(root, 'notes.md'))).toEqual({
      kind: 'text',
      content: '# hello'
    })
  })

  it('reports a NUL byte in the head as binary', async () => {
    write('blob.bin', Buffer.from([0x41, 0x00, 0x42]))
    expect(await readFile(path.join(root, 'blob.bin'))).toEqual({ kind: 'binary' })
  })

  it('reports a PDF as binary rather than trying to decode it', async () => {
    write('paper.pdf', '%PDF-1.7 not really')
    expect(await readFile(path.join(root, 'paper.pdf'))).toEqual({ kind: 'binary' })
  })

  it('reports text over the 1MB cap as toolarge', async () => {
    const size = 1024 * 1024 + 1
    write('huge.txt', 'a'.repeat(size))
    expect(await readFile(path.join(root, 'huge.txt'))).toEqual({ kind: 'toolarge', size })
  })

  it('returns an ada-file URL for an image, escaping each segment', async () => {
    const name = 'my pic #1.png'
    write(path.join('shots', name), 'png-ish')
    const result = await readFile(path.join(root, 'shots', name))
    expect(result.kind).toBe('image')
    const url = result.kind === 'image' ? result.dataUrl : ''
    expect(url.startsWith('ada-file://local')).toBe(true)
    expect(url.endsWith('/shots/my%20pic%20%231.png')).toBe(true)
    // Symmetric with the protocol handler's whole-string decodeURIComponent.
    expect(decodeURIComponent(url.replace(/^ada-file:\/\/local/, ''))).toBe(
      path.join(root, 'shots', name)
    )
  })

  it('errors on a directory', async () => {
    const result = await readFile(root)
    expect(result.kind).toBe('error')
  })
})

describe('file operations', () => {
  it('rejects a name containing a separator', async () => {
    write('a.txt', '')
    const result = await renamePath(path.join(root, 'a.txt'), '../escaped.txt')
    expect(result).toEqual({ ok: false, message: 'Name cannot contain a slash.' })
  })

  it('renames within the directory', async () => {
    write('a.txt', 'x')
    expect(await renamePath(path.join(root, 'a.txt'), 'b.txt')).toEqual({ ok: true })
    expect(fs.existsSync(path.join(root, 'b.txt'))).toBe(true)
  })

  it('refuses to rename onto an existing sibling', async () => {
    write('a.txt', 'x')
    write('b.txt', 'y')
    const result = await renamePath(path.join(root, 'a.txt'), 'b.txt')
    expect(result.ok).toBe(false)
  })

  it('refuses an empty or reserved name', async () => {
    expect(await createFile(root, '   ')).toEqual({ ok: false, message: 'Name cannot be empty.' })
    expect(await createDir(root, '..')).toEqual({ ok: false, message: 'That name is reserved.' })
  })

  it('creates a file and a directory, refusing to clobber', async () => {
    expect(await createFile(root, 'new.txt')).toEqual({ ok: true })
    expect((await createFile(root, 'new.txt')).ok).toBe(false)
    expect(await createDir(root, 'sub')).toEqual({ ok: true })
    expect((await createDir(root, 'sub')).ok).toBe(false)
  })

  it('moves into a sibling directory', async () => {
    write('a.txt', 'x')
    fs.mkdirSync(path.join(root, 'dest'))
    expect(await movePath(path.join(root, 'a.txt'), path.join(root, 'dest'))).toEqual({ ok: true })
    expect(fs.existsSync(path.join(root, 'dest', 'a.txt'))).toBe(true)
  })

  it('refuses to move a folder into its own subtree', async () => {
    fs.mkdirSync(path.join(root, 'outer', 'inner'), { recursive: true })
    expect(await movePath(path.join(root, 'outer'), path.join(root, 'outer', 'inner'))).toEqual({
      ok: false,
      message: 'Cannot move a folder into itself.'
    })
  })

  it('refuses a move whose destination already holds that name', async () => {
    write('a.txt', 'x')
    write('dest/a.txt', 'y')
    const result = await movePath(path.join(root, 'a.txt'), path.join(root, 'dest'))
    expect(result.ok).toBe(false)
  })
})

describe('FileTreeWatcher', () => {
  it('coalesces a burst of writes into one change event', async () => {
    const changed: string[] = []
    const watcher = new FileTreeWatcher((dir) => changed.push(dir), {
      debounceMs: 30,
      maxWaitMs: 500
    })
    watcher.watch('pane-1', root)
    for (let index = 0; index < 8; index++) write(`burst-${index}.txt`, 'x')
    await sleep(200)
    watcher.dispose()

    expect(changed).toEqual([root])
  })

  it('refcounts subscribers and tears down with the last one', () => {
    const watcher = new FileTreeWatcher(() => undefined)
    watcher.watch('pane-1', root)
    watcher.watch('pane-2', root)
    expect(watcher.watchCount).toBe(1)
    expect(watcher.subscriberCount(root)).toBe(2)
    watcher.unwatch('pane-1', root)
    expect(watcher.watchCount).toBe(1)
    watcher.unwatch('pane-2', root)
    expect(watcher.watchCount).toBe(0)
    watcher.dispose()
  })

  it('still flushes within the max-wait cap while writes keep arriving', async () => {
    const stamps: number[] = []
    const watcher = new FileTreeWatcher(() => stamps.push(Date.now()), {
      debounceMs: 60,
      maxWaitMs: 100
    })
    watcher.watch('pane-1', root)
    const startedAt = Date.now()
    // Writes land faster than the debounce expires — a pure trailing-edge
    // debounce would never fire while this loop runs.
    for (let index = 0; index < 12; index++) {
      write(`drip-${index}.txt`, 'x')
      await sleep(25)
    }
    watcher.dispose()

    expect(stamps.length).toBeGreaterThanOrEqual(2)
    expect(stamps[0] - startedAt).toBeLessThan(400)
  })

  it('ignores a directory that cannot be watched', () => {
    const watcher = new FileTreeWatcher(() => undefined)
    watcher.watch('pane-1', path.join(root, 'gone'))
    expect(watcher.watchCount).toBe(0)
  })
})
