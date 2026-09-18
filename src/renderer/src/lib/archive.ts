/**
 * Workspace archiving: pure snapshot/rehydrate logic for a closed workspace —
 * its panes, its zone layout and its explorer state. Deliberately free of React,
 * IPC and store imports; this is the hand-testable core, and the close/reopen
 * wiring is the only side-effectful call site.
 *
 * A snapshot is taken when a workspace closes and is keyed by its root folder
 * (`archiveKey`), so reopening the same folder gets everything back. The
 * persisted state drops a closed workspace entirely, so the archive is the only
 * surviving copy.
 *
 * Panes come back verbatim — that is the point: a restored Claude pane keeps its
 * session id, account and plan mode, so it resumes the same conversation the way
 * a cold boot does.
 */
import type { ArchiveEntry, ExplorerState, Pane, PaneKind, Workspace, ZoneLayout } from '../../../shared/types'

/** The host platform, for `archiveKey`'s case handling. Reads the preload bridge
 *  when present; falls back to case-sensitive keys outside the app, which can
 *  never conflate two folders that really are distinct. */
export function detectPlatform(): string {
  if (typeof window !== 'undefined' && window.api?.platform) return window.api.platform
  return 'linux'
}

/**
 * The case-PRESERVING half of `archiveKey`: trim, unify Windows backslashes to
 * `/`, drop trailing slashes ("/Users/x/proj/" ≡ "/Users/x/proj"), keeping one
 * for the filesystem root itself ("/" or "C:/"). None of these ever conflate two
 * distinct folders — they are pure spelling differences for the same path.
 */
export function normalizeRoot(root: string): string {
  let key = root.trim().replace(/\\/g, '/')
  key = key.replace(/\/+$/, '') || '/'
  if (/^[a-zA-Z]:$/.test(key)) key += '/' // bare drive letter → drive root
  return key
}

/**
 * Normalize a workspace root into the archive's lookup key, so close/reopen of
 * the same folder always matches however the path was spelled: `normalizeRoot`,
 * plus case folding on darwin and win32, whose default filesystems are
 * case-insensitive. Linux keys stay case-sensitive.
 */
export function archiveKey(rootDir: string, platform: string = detectPlatform()): string {
  const key = normalizeRoot(rootDir)
  return platform === 'darwin' || platform === 'win32' ? key.toLowerCase() : key
}

/**
 * Is this archived workspace really the one belonging to `rootDir`?
 *
 * The archive is keyed by `archiveKey`, which case-folds on darwin and win32. On
 * their DEFAULT filesystems that is exactly right — "/x/Proj" and "/x/proj" are
 * one folder. But macOS also offers case-SENSITIVE APFS, where they are two
 * different folders sharing one key: closing one and reopening the other would
 * hand the second folder the first one's panes. That is the only way two
 * genuinely distinct folders can collide here — the other normalizations
 * (whitespace, separators, trailing slashes) are pure spelling.
 *
 * So the key is used to FIND a candidate and this check decides whether to use
 * it: the entry must have been archived from the same path, spelled the same
 * way, case included. Both spellings in practice come from the same two sources
 * — the folder dialog (which returns the OS's own canonical spelling) and the
 * recents list (which replays the exact string that dialog gave) — so a genuine
 * reopen matches, and only the cross-folder case never does.
 *
 * A failed match leaves the entry in the archive untouched, so the folder it
 * really belongs to still gets it back.
 */
export function entryMatchesRoot(
  entry: ArchiveEntry,
  rootDir: string,
  platform: string = detectPlatform()
): boolean {
  if (entry.key !== archiveKey(rootDir, platform)) return false
  return normalizeRoot(entry.rootDir) === normalizeRoot(rootDir)
}

/**
 * Deep-copy a layout so the archive holds no reference into the live one. Zone
 * sets go through JSON rather than a hand-written walk — a layout is plain JSON
 * by construction (it is persisted as such), which is exactly the guarantee that
 * makes the round-trip total.
 */
function copyLayout(layout: ZoneLayout): ZoneLayout {
  return JSON.parse(JSON.stringify(layout)) as ZoneLayout
}

/** Copy a pane field-by-field, so later mutations of the live workspace can
 *  never bleed into the archive. */
function copyPane(pane: Pane): Pane {
  const copy: Pane = {
    id: pane.id,
    name: pane.name,
    kind: pane.kind,
    cwd: pane.cwd,
    createdAt: pane.createdAt
  }
  if (pane.sshHost !== undefined) copy.sshHost = pane.sshHost
  if (pane.filePath !== undefined) copy.filePath = pane.filePath
  if (pane.sessionId !== undefined) copy.sessionId = pane.sessionId
  if (pane.accountId !== undefined) copy.accountId = pane.accountId
  if (pane.planMode !== undefined) copy.planMode = pane.planMode
  if (pane.color !== undefined) copy.color = pane.color
  return copy
}

function copyExplorer(explorer: ExplorerState): ExplorerState {
  return { open: explorer.open, width: explorer.width, expanded: [...explorer.expanded] }
}

/** Snapshot a workspace for the archive. `now` is the stamp to file it under. */
export function snapshotWorkspace(
  workspace: Workspace,
  now: number,
  platform: string = detectPlatform()
): ArchiveEntry {
  return {
    key: archiveKey(workspace.rootDir, platform),
    rootDir: workspace.rootDir,
    name: workspace.name,
    archivedAt: now,
    layout: copyLayout(workspace.layout),
    panes: workspace.panes.map(copyPane),
    explorer: copyExplorer(workspace.explorer)
  }
}

/**
 * Turn an archived workspace back into a live one under a fresh workspace id.
 * Pane ids are kept exactly as archived, because the archived `layout` addresses
 * them — re-minting one would leave its zone orphaned. Focus and maximization
 * are view state rather than content, so a restored workspace starts with
 * neither.
 */
export function rehydrateWorkspace(entry: ArchiveEntry, newId: string): Workspace {
  return {
    id: newId,
    name: entry.name,
    rootDir: entry.rootDir,
    layout: copyLayout(entry.layout),
    panes: entry.panes.map(copyPane),
    explorer: copyExplorer(entry.explorer)
  }
}

export interface ArchiveSummary {
  name: string
  rootDir: string
  archivedAt: number
  paneCount: number
  panes: { name: string; kind: PaneKind }[]
}

/** What the "restore these panes?" prompt shows about an entry. */
export function summarizeArchive(entry: ArchiveEntry): ArchiveSummary {
  return {
    name: entry.name,
    rootDir: entry.rootDir,
    archivedAt: entry.archivedAt,
    paneCount: entry.panes.length,
    panes: entry.panes.map((pane) => ({ name: pane.name, kind: pane.kind }))
  }
}

/**
 * File an entry in the archive: one slot per key, latest close wins it, newest
 * first so the list reads as a history.
 */
export function upsertArchive(list: ArchiveEntry[], entry: ArchiveEntry): ArchiveEntry[] {
  return [entry, ...list.filter((existing) => existing.key !== entry.key)]
}

/** Forget an archived workspace (its panes were restored, or discarded). */
export function removeArchive(list: ArchiveEntry[], key: string): ArchiveEntry[] {
  return list.filter((entry) => entry.key !== key)
}
