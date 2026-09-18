/**
 * Recent workspaces: the folder history the "open a workspace" flow offers.
 * Pure logic, deliberately free of React and IPC (mirroring archive.ts) — the
 * store owns the persistence wiring.
 *
 * Deriving the list from the live workspaces would only ever show folders that
 * are *currently open* — the one set of folders you are least likely to want to
 * open again, and closing one would drop it forever. This is a real history: a
 * folder is remembered when it is opened AND re-stamped when it is closed, so
 * the list is the last `MAX_RECENTS` folders worked in, open or not.
 *
 * Keyed by `archiveKey(rootDir)` (the same normalization the workspace archive
 * uses), so "/home/me/proj" and "/home/me/proj/" are one entry, not two.
 */
import type { RecentWorkspace } from '../../../shared/types'
import { archiveKey } from './archive'

/** How many folders the history keeps. Oldest fall off the end. */
export const MAX_RECENTS = 20

/** Newest first; entries without a usable stamp sort last but keep their order. */
export function byRecency(a: RecentWorkspace, b: RecentWorkspace): number {
  return b.lastOpenedAt - a.lastOpenedAt
}

/**
 * Record a visit to `entry`'s folder, returning the new history.
 *
 * An existing entry for the same folder is replaced rather than duplicated, and
 * takes the incoming name — so renaming a workspace and closing it updates the
 * label instead of leaving a stale one. The result is sorted newest-first and
 * capped at `MAX_RECENTS`.
 *
 * Folders with a blank root are ignored (there is nothing to reopen).
 */
export function rememberWorkspace(
  list: RecentWorkspace[],
  entry: { name: string; rootDir: string | undefined },
  lastOpenedAt: number = Date.now()
): RecentWorkspace[] {
  const rootDir = entry.rootDir?.trim()
  if (!rootDir) return list
  const key = archiveKey(rootDir)
  const kept = list.filter((recent) => archiveKey(recent.rootDir) !== key)
  const next: RecentWorkspace = { rootDir, name: entry.name.trim() || rootDir, lastOpenedAt }
  return [next, ...kept].sort(byRecency).slice(0, MAX_RECENTS)
}

/**
 * Coerce whatever is on disk into a valid history: drops malformed rows rather
 * than throwing, so a hand-edited or truncated file degrades to a shorter list
 * instead of breaking the picker. Also re-sorts and re-caps, so lowering
 * `MAX_RECENTS` in a later build trims an oversized saved file on load.
 */
export function normalizeRecents(raw: unknown): RecentWorkspace[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: RecentWorkspace[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const { name, rootDir, lastOpenedAt } = row as Partial<RecentWorkspace>
    if (typeof rootDir !== 'string' || !rootDir.trim()) continue
    const key = archiveKey(rootDir)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      rootDir,
      name: typeof name === 'string' && name.trim() ? name : rootDir,
      lastOpenedAt: typeof lastOpenedAt === 'number' && Number.isFinite(lastOpenedAt) ? lastOpenedAt : 0
    })
  }
  return out.sort(byRecency).slice(0, MAX_RECENTS)
}
