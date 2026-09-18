/**
 * The explorer's directory cache and read coordinator.
 *
 * Every directory listing the panel shows comes from here, whether headless-tree
 * asked for it (lazy load on expand) or an `fs:changed` push did. Funnelling both
 * through one place buys three things the panel cannot get from headless-tree's own
 * loader:
 *
 *  1. **A change during an in-flight read is never lost.** headless-tree's
 *     `loadChildrenIds` de-dupes by *subscribing* to a load already running, so an
 *     `invalidateChildrenIds()` that lands mid-read resolves with that read's older
 *     snapshot and nothing ever retries. Here a `refresh()` that joins a running read
 *     marks it stale, and the read loops until it completes without a change arriving
 *     behind it. The flag check and the record's retirement happen in the same
 *     synchronous step, so there is no window where a change is observed and dropped.
 *  2. **Deleted and renamed paths are forgotten**, along with everything cached
 *     beneath them, so a vanished entry cannot linger as a ghost row and the cache
 *     does not grow for the life of the session.
 *  3. **Quiet reads are free.** `fs.watch` fires on content writes too, and the panel
 *     reconciles on a timer as a backstop; `changed` lets the caller skip the tree
 *     rebuild when the listing came back identical.
 *
 * Paths are the *stored* form the main process hands back — the same strings feed
 * straight into `readDir` again (see src/main/fileTree.ts's module header).
 */
import type { FileTreeEntry } from '../../../shared/types'

export interface DirLoad {
  /** the directory's children, in the order the main process returned them */
  ids: string[]
  /** false when this listing is identical to the one already cached */
  changed: boolean
  /** paths that vanished in this read: the removed children plus their whole subtrees */
  removed: string[]
  /** entries that still exist but whose name/kind/symlink-ness changed on disk */
  restated: FileTreeEntry[]
}

/** One directory read in flight, plus whether a change landed behind it. */
interface DirRead {
  promise: Promise<DirLoad>
  stale: boolean
}

export class ExplorerTreeCache {
  /** path → the entry we last saw for it */
  private entries = new Map<string, FileTreeEntry>()
  /** directory path → its child paths, as of the last read */
  private children = new Map<string, string[]>()
  /** directory path → the read currently running for it */
  private reads = new Map<string, DirRead>()

  constructor(private readDir: (dir: string) => Promise<FileTreeEntry[]>) {}

  /** Plant an entry we were told about rather than read — the workspace root, which
   *  has no parent directory to list it. */
  seed(entry: FileTreeEntry): void {
    this.entries.set(entry.path, entry)
  }

  /** The entry cached for `path`, if we have ever listed its parent. */
  get(path: string): FileTreeEntry | undefined {
    return this.entries.get(path)
  }

  /** Whether this directory has been listed at least once (i.e. re-expanding it would
   *  otherwise be served from cache). */
  hasChildren(dir: string): boolean {
    return this.children.has(dir)
  }

  /** How many paths are cached — for leak checks. */
  get size(): number {
    return this.entries.size
  }

  /** List `dir`, joining a read already running for it. Use for lazy loads, where an
   *  answer that is merely as fresh as the in-flight read is fine. */
  load(dir: string): Promise<DirLoad> {
    return this.run(dir, false)
  }

  /**
   * List `dir`, guaranteeing the answer reflects the directory at or after this call.
   * A read already in flight is re-run rather than reused, because it may have
   * enumerated the directory *before* the change that prompted this call.
   */
  refresh(dir: string): Promise<DirLoad> {
    return this.run(dir, true)
  }

  private run(dir: string, markStale: boolean): Promise<DirLoad> {
    const inflight = this.reads.get(dir)
    if (inflight) {
      if (markStale) inflight.stale = true
      return inflight.promise
    }
    const record: DirRead = { stale: false, promise: undefined as unknown as Promise<DirLoad> }
    record.promise = (async () => {
      for (;;) {
        record.stale = false
        const entries = await this.readDir(dir)
        const load = this.apply(dir, entries)
        // Retiring the record and testing the flag are one synchronous step, so a
        // concurrent refresh() either finds the record (and sets `stale` before this
        // check, so we read again) or finds nothing and starts its own read. It can
        // never mark a record that has already stopped looking.
        if (!record.stale) {
          this.reads.delete(dir)
          return load
        }
      }
    })().catch((error) => {
      // A failed read must not wedge the directory: drop the record so the next
      // fs:changed starts a fresh attempt, and let the caller see the rejection.
      this.reads.delete(dir)
      throw error
    })
    this.reads.set(dir, record)
    return record.promise
  }

  /** Fold one fresh listing into the cache and report what moved. */
  private apply(dir: string, entries: FileTreeEntry[]): DirLoad {
    const ids = entries.map((entry) => entry.path)
    const previous = this.children.get(dir)
    const changed =
      !previous ||
      previous.length !== ids.length ||
      previous.some((path, index) => path !== ids[index])

    const removed: string[] = []
    if (previous) {
      const next = new Set(ids)
      for (const id of previous) if (!next.has(id)) this.forget(id, removed)
    }

    const restated: FileTreeEntry[] = []
    for (const entry of entries) {
      const before = this.entries.get(entry.path)
      // A path can change kind under us — an agent replaces note.txt with a note.txt/
      // folder — and nothing downstream re-reads item data on its own, so the row
      // would keep its old icon and refuse to expand for the rest of the session.
      if (
        before &&
        (before.kind !== entry.kind ||
          before.name !== entry.name ||
          before.symlink !== entry.symlink)
      ) {
        restated.push(entry)
      }
      this.entries.set(entry.path, entry)
    }

    this.children.set(dir, ids)
    return { ids, changed, removed, restated }
  }

  /** Drop `path` and everything cached beneath it (a deleted or renamed subtree). */
  private forget(path: string, out: string[]): void {
    out.push(path)
    this.entries.delete(path)
    const kids = this.children.get(path)
    if (!kids) return
    this.children.delete(path)
    for (const kid of kids) this.forget(kid, out)
  }
}
