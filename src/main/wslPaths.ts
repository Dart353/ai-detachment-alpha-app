import type { ArchiveEntry, Pane, PersistedState, RecentWorkspace, Workspace } from '../shared/types'

/**
 * WSL mode stores every folder as its Linux path, because that is how Claude Code
 * (running inside WSL) names its transcript folders: `/home/me/app` →
 * `projects/-home-me-app`. A folder that slipped in as the Windows share path
 * (`\\wsl.localhost\Ubuntu\home\me/app`) still opens and still spawns, but its
 * panes look for transcripts under `--wsl-localhost-Ubuntu-home-me-app`, which never
 * exists — so they never record a session and come back blank after a restart.
 *
 * These are pure: they recognise the share by its shape, without asking wsl.exe
 * which distro or share prefix is current, so a path saved under another share
 * name (`\\wsl$\…`) or with mixed separators is caught too.
 */

const SHARE_RE = /^(?:\\\\|\/\/)wsl(?:\.localhost|\$)[\\/][^\\/]+(.*)$/i

/** `\\wsl.localhost\<distro>\home\me/app` → `/home/me/app`; anything else unchanged. */
export function wslShareToLinux(p: string): string {
  const match = SHARE_RE.exec(p)
  if (!match) return p
  const rest = match[1].replace(/\\/g, '/').replace(/\/+$/, '')
  return rest === '' ? '/' : rest
}

function normalizePane(pane: Pane): Pane {
  const cwd = wslShareToLinux(pane.cwd)
  const filePath = pane.filePath === undefined ? undefined : wslShareToLinux(pane.filePath)
  if (cwd === pane.cwd && filePath === pane.filePath) return pane
  return { ...pane, cwd, ...(filePath === undefined ? {} : { filePath }) }
}

function normalizeTree<T extends { rootDir: string; panes: Pane[]; explorer: Workspace['explorer'] }>(
  entry: T
): T {
  const rootDir = wslShareToLinux(entry.rootDir)
  const panes = entry.panes.map(normalizePane)
  const expanded = entry.explorer.expanded.map(wslShareToLinux)
  const unchanged =
    rootDir === entry.rootDir &&
    panes.every((pane, index) => pane === entry.panes[index]) &&
    expanded.every((path, index) => path === entry.explorer.expanded[index])
  if (unchanged) return entry
  return { ...entry, rootDir, panes, explorer: { ...entry.explorer, expanded } }
}

/** The saved workspaces with every folder in its Linux form. */
export function normalizeStatePaths(state: PersistedState): PersistedState {
  if (!Array.isArray(state.workspaces)) return state
  const workspaces = state.workspaces.map((workspace) => normalizeTree(workspace))
  return workspaces.every((workspace, index) => workspace === state.workspaces[index])
    ? state
    : { ...state, workspaces }
}

/**
 * Archive entries the same way. The key is the case-folded root on Windows (the
 * renderer's `archiveKey`), so a migrated root gets the key the renderer will look
 * it up by.
 */
export function normalizeArchivePaths(entries: ArchiveEntry[]): ArchiveEntry[] {
  return entries.map((entry) => {
    const next = normalizeTree(entry)
    if (next === entry) return entry
    return { ...next, key: next.rootDir.toLowerCase() }
  })
}

/** Recents the same way; a folder listed in both forms keeps its first (newest) entry. */
export function normalizeRecentPaths(recents: RecentWorkspace[]): RecentWorkspace[] {
  const seen = new Set<string>()
  const out: RecentWorkspace[] = []
  for (const recent of recents) {
    const rootDir = wslShareToLinux(recent.rootDir)
    if (seen.has(rootDir)) continue
    seen.add(rootDir)
    out.push(rootDir === recent.rootDir ? recent : { ...recent, rootDir })
  }
  return out
}
