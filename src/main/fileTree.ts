import fs from 'node:fs'
import path from 'node:path'
import type { FileOpResult, FileReadResult, FileTreeEntry } from '../shared/types'
import { isWsl, toHost } from './platform'

/**
 * The explorer's main-process data layer for the VS Code-style file tree.
 *
 * The renderer stays sandboxed, so every fs access for the explorer flows through
 * here: `readDir` lists one directory at a time (lazy loading over IPC), and the
 * `FileTreeWatcher` keeps one non-recursive `fs.watch` per *expanded* directory,
 * refcounted across the panes subscribed to it, pushing debounced change events
 * back so agent edits show up live.
 *
 * Paths round-trip in *stored* form (Linux, in WSL mode): every path we hand the
 * renderer is safe to pass straight back to `readDir`/`watchDir`. We only translate
 * to a host path (`toHost`) at the moment we touch the disk.
 *
 * Deliberately Electron-free, so it is unit-testable and so nothing here depends
 * on the app being ready.
 */

// The renderer decides how to present node_modules, so it is deliberately NOT
// hidden here — only the noise a file tree never wants to show.
const IGNORED = new Set(['.git', '.DS_Store'])

/** Quiet period after the last change before a directory is pushed to the renderer. */
const DEBOUNCE_MS = 150
/**
 * Hard cap between the FIRST change of a burst and its push, however busy the
 * directory stays. A pure trailing-edge debounce starves under an agent: a shell
 * `touch` is one event followed by quiet, so it always fires at DEBOUNCE_MS, but an
 * agent writing eight files plus a formatter pass re-arms the timer faster than it
 * expires and the tree sees nothing until the writes stop. That is the whole reason
 * the stale tree only ever showed up for agent edits.
 */
const MAX_WAIT_MS = 500

/** Build a child path in stored form (posix in WSL mode, native otherwise). */
function joinStored(dir: string, name: string): string {
  return isWsl() ? path.posix.join(dir, name) : path.join(dir, name)
}

/**
 * List one directory: directories first, then case-insensitive natural order.
 * Symlinks are marked but never followed — their kind comes from stat-ing the
 * target (a broken link is treated as a file). Any read failure (missing dir,
 * permission denied) resolves to an empty array rather than throwing across IPC.
 */
export async function readDir(dir: string): Promise<FileTreeEntry[]> {
  const hostDir = toHost(dir)
  let dirents: fs.Dirent[]
  try {
    dirents = await fs.promises.readdir(hostDir, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: FileTreeEntry[] = []
  for (const dirent of dirents) {
    if (IGNORED.has(dirent.name)) continue
    const entry: FileTreeEntry = {
      name: dirent.name,
      path: joinStored(dir, dirent.name),
      kind: dirent.isDirectory() ? 'dir' : 'file'
    }
    if (dirent.isSymbolicLink()) {
      entry.symlink = true
      // Classify by the target without following it further; a broken link stats
      // as an error, in which case we present it as a plain file.
      try {
        entry.kind = (await fs.promises.stat(path.join(hostDir, dirent.name))).isDirectory()
          ? 'dir'
          : 'file'
      } catch {
        entry.kind = 'file'
      }
    }
    entries.push(entry)
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return entries
}

/** UTF-8 text is decoded up to this size; larger files report `toolarge`. */
const TEXT_CAP = 1024 * 1024 // 1MB
/** Images are inlined as data URLs up to this size; larger report `toolarge`. */
const IMAGE_CAP = 10 * 1024 * 1024 // 10MB

/**
 * A stored-form path → its `ada-file://` URL. Built per-segment
 * (encodeURIComponent, joined by unescaped slashes) so the main-side protocol
 * handler's whole-string decodeURIComponent is symmetric.
 */
export function fileUrl(p: string): string {
  return 'ada-file://local' + p.split('/').map(encodeURIComponent).join('/')
}

/** How much of the head is sniffed for a NUL byte before decoding as text. */
const SNIFF_BYTES = 8192

/** Extension → image mime for the inline `<img>`; membership also gates the image path. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp'
}

/** Lower-cased extension (no dot) of a stored-form path; '' when there is none. */
function extOf(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Read one file for the viewer pane. Images (by extension) come back as an
 * `ada-file://` URL the renderer points an `<img>` at; other files are decoded as
 * UTF-8 text unless a NUL byte in the first 8KB marks them binary. Size caps apply
 * per kind (1MB text, 10MB image). Any stat or read failure resolves to
 * `{ kind: 'error' }` rather than throwing over IPC.
 */
export async function readFile(p: string): Promise<FileReadResult> {
  const host = toHost(p)
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(host)
  } catch (err) {
    return { kind: 'error', message: (err as Error).message }
  }
  if (!stat.isFile()) return { kind: 'error', message: 'Not a regular file.' }

  const ext = extOf(p)
  // A PDF is bytes the viewer has no reader for; the pane offers to reveal it.
  if (ext === 'pdf') return { kind: 'binary' }

  const mime = IMAGE_MIME[ext]
  if (mime) {
    if (stat.size > IMAGE_CAP) return { kind: 'toolarge', size: stat.size }
    return { kind: 'image', dataUrl: fileUrl(p) }
  }

  if (stat.size > TEXT_CAP) return { kind: 'toolarge', size: stat.size }
  let buf: Buffer
  try {
    buf = await fs.promises.readFile(host)
  } catch (err) {
    return { kind: 'error', message: (err as Error).message }
  }
  // Binary sniff: a NUL byte in the head is the cheap, reliable "not text" tell.
  const sniff = Math.min(buf.length, SNIFF_BYTES)
  for (let index = 0; index < sniff; index++) {
    if (buf[index] === 0) return { kind: 'binary' }
  }
  return { kind: 'text', content: buf.toString('utf8') }
}

/**
 * File management. Every op resolves to a plain result so nothing throws across
 * IPC — the renderer surfaces `message` inline. Paths arrive in *stored* form (see
 * the module header); we translate to a host path only at the disk touch. These
 * deliberately return no new path: the per-directory watchers already push a change
 * for the affected parent(s), so the tree refreshes itself. Trash is NOT here —
 * `shell.trashItem` lives in the IPC layer so this module stays Electron-free.
 */

/** Reject a bare entry name that is empty, dotty, or would escape its parent dir. */
function invalidName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name cannot be empty.'
  if (trimmed === '.' || trimmed === '..') return 'That name is reserved.'
  if (/[/\\]/.test(trimmed)) return 'Name cannot contain a slash.'
  return null
}

/** Same-directory rename of `oldPath` to the bare name `newName`. Rejects a name that
 *  collides with an existing sibling — but allows a case-only rename on a
 *  case-insensitive volume, where the "existing" entry is the file itself. */
export async function renamePath(oldPath: string, newName: string): Promise<FileOpResult> {
  const bad = invalidName(newName)
  if (bad) return { ok: false, message: bad }
  const name = newName.trim()
  const hostOld = toHost(oldPath)
  const hostNew = path.join(path.dirname(hostOld), name)
  if (hostNew === hostOld) return { ok: true } // no change
  try {
    try {
      const [targetStat, sourceStat] = await Promise.all([
        fs.promises.stat(hostNew),
        fs.promises.stat(hostOld)
      ])
      if (!(targetStat.ino === sourceStat.ino && targetStat.dev === sourceStat.dev)) {
        return { ok: false, message: `A file or folder named "${name}" already exists.` }
      }
    } catch {
      /* target does not exist — free to rename */
    }
    await fs.promises.rename(hostOld, hostNew)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** Create an empty file `name` inside `parentDir`; rejects if the path is taken. */
export async function createFile(parentDir: string, name: string): Promise<FileOpResult> {
  const bad = invalidName(name)
  if (bad) return { ok: false, message: bad }
  const target = path.join(toHost(parentDir), name.trim())
  try {
    // 'wx' = create-exclusive: fails with EEXIST rather than truncating an existing file.
    const handle = await fs.promises.open(target, 'wx')
    await handle.close()
    return { ok: true }
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error.code === 'EEXIST') {
      return { ok: false, message: `A file or folder named "${name.trim()}" already exists.` }
    }
    return { ok: false, message: error.message }
  }
}

/** Create a directory `name` inside `parentDir`; rejects if the path is taken. */
export async function createDir(parentDir: string, name: string): Promise<FileOpResult> {
  const bad = invalidName(name)
  if (bad) return { ok: false, message: bad }
  const target = path.join(toHost(parentDir), name.trim())
  try {
    await fs.promises.mkdir(target) // non-recursive: throws EEXIST if the path is taken
    return { ok: true }
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error.code === 'EEXIST') {
      return { ok: false, message: `A file or folder named "${name.trim()}" already exists.` }
    }
    return { ok: false, message: error.message }
  }
}

/** Move `srcPath` into `destDir` (keeping its name). Rejects a destination that already
 *  has that child, moving a folder into itself or its own descendant, and a cross-volume
 *  move (EXDEV) with a clear message — no copy fallback. */
export async function movePath(srcPath: string, destDir: string): Promise<FileOpResult> {
  const hostSrc = toHost(srcPath)
  const hostDestDir = toHost(destDir)
  // destDir === src, or destDir sits inside src → moving a folder into itself/its subtree.
  const relative = path.relative(hostSrc, hostDestDir)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return { ok: false, message: 'Cannot move a folder into itself.' }
  }
  const target = path.join(hostDestDir, path.basename(hostSrc))
  if (target === hostSrc) return { ok: true } // already in this folder — nothing to do
  try {
    await fs.promises.access(target)
    return {
      ok: false,
      message: `A file or folder named "${path.basename(hostSrc)}" already exists here.`
    }
  } catch {
    /* destination child is free */
  }
  try {
    await fs.promises.rename(hostSrc, target)
    return { ok: true }
  } catch (err) {
    const error = err as NodeJS.ErrnoException
    if (error.code === 'EXDEV') {
      return { ok: false, message: 'Cannot move across different drives or volumes.' }
    }
    return { ok: false, message: error.message }
  }
}

/** One live watcher plus the set of subscriber ids that asked for this directory. */
interface DirWatch {
  watcher: fs.FSWatcher
  subscribers: Set<string>
  debounce: NodeJS.Timeout | null
  /** when the current un-pushed burst started; null between bursts */
  burstStartedAt: number | null
}

/** Timings, overridable so tests do not have to wait out the real ones. */
export interface FileTreeWatcherOptions {
  debounceMs?: number
  maxWaitMs?: number
}

/**
 * Refcounted directory watching: a single non-recursive `fs.watch` per unique
 * directory regardless of how many subscribers ask for it, torn down when the last
 * subscriber leaves. `fs.watch` can throw on creation (dir already gone) and emit
 * a late 'error' event, so both are guarded and clean up the entry.
 *
 * Change events are debounced per directory before the (stored-form) dir is pushed
 * out — trailing edge, but never held longer than `maxWaitMs` from the first event
 * of a burst, so an agent writing continuously still gets the tree refreshed while
 * it works instead of only once it falls silent.
 */
export class FileTreeWatcher {
  private watches = new Map<string, DirWatch>()
  private debounceMs: number
  private maxWaitMs: number

  constructor(
    private onChange: (dir: string) => void,
    opts: FileTreeWatcherOptions = {}
  ) {
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS
    this.maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS
  }

  /** How many directories currently hold a live watcher. Leak instrumentation. */
  get watchCount(): number {
    return this.watches.size
  }

  /** How many subscribers still hold `dir`. Leak instrumentation. */
  subscriberCount(dir: string): number {
    return this.watches.get(dir)?.subscribers.size ?? 0
  }

  /** Subscribe `id` to `dir`, arming the watcher on the first subscriber. */
  watch(id: string, dir: string): void {
    const existing = this.watches.get(dir)
    if (existing) {
      existing.subscribers.add(id)
      return
    }
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(toHost(dir), () => this.schedule(dir))
    } catch {
      return // dir vanished before we could watch it — nothing to refcount
    }
    const entry: DirWatch = {
      watcher,
      subscribers: new Set([id]),
      debounce: null,
      burstStartedAt: null
    }
    watcher.on('error', () => this.teardown(dir))
    this.watches.set(dir, entry)
  }

  /** Unsubscribe `id`; the watcher closes once its last subscriber is gone. */
  unwatch(id: string, dir: string): void {
    const entry = this.watches.get(dir)
    if (!entry) return
    entry.subscribers.delete(id)
    if (entry.subscribers.size === 0) this.teardown(dir)
  }

  private schedule(dir: string): void {
    const entry = this.watches.get(dir)
    if (!entry) return
    const now = Date.now()
    entry.burstStartedAt ??= now
    // Coalesce on the trailing edge, but clamp the wait to whatever is left of this
    // burst's max-wait window — so a directory under continuous writes still flushes
    // on a fixed cadence rather than never. The window restarts after each push.
    const wait = Math.max(
      0,
      Math.min(this.debounceMs, entry.burstStartedAt + this.maxWaitMs - now)
    )
    if (entry.debounce) clearTimeout(entry.debounce)
    entry.debounce = setTimeout(() => {
      entry.debounce = null
      entry.burstStartedAt = null
      this.onChange(dir)
    }, wait)
  }

  private teardown(dir: string): void {
    const entry = this.watches.get(dir)
    if (!entry) return
    if (entry.debounce) clearTimeout(entry.debounce)
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    this.watches.delete(dir)
  }

  /** Close every watcher (window close / quit). */
  dispose(): void {
    for (const dir of [...this.watches.keys()]) this.teardown(dir)
  }
}
