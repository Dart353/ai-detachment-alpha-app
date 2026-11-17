/**
 * The renderer's side of the workbench, as pure rules: where a workspace's page
 * is, which of its tasks want the user, and which of those are news.
 *
 * A bell rings for a task when it starts wanting the user — it moved into
 * `needs-input` or `blocked`, or it asked a different question while still
 * waiting. A task finishing never rings: the Stop hook already rings when a
 * Claude turn ends, and a second bell for the same moment is noise.
 */
import { WORKBENCH_FILE, wantsUser, type WorkbenchSection } from '../../../shared/workbench'
import type { Pane, WorkbenchSnapshot } from '../../../shared/types'

/** The page's stored-form path for a workspace root, in the root's own separator. */
export function workbenchPathOf(rootDir: string): string {
  const sep = rootDir.includes('\\') && !rootDir.includes('/') ? '\\' : '/'
  const root = rootDir.endsWith(sep) && rootDir.length > 1 ? rootDir.slice(0, -1) : rootDir
  return `${root}${sep}${WORKBENCH_FILE}`
}

/** True for the viewer pane showing a workspace's own workbench. */
export function isWorkbenchPane(pane: Pick<Pane, 'kind' | 'filePath'>, rootDir: string): boolean {
  return pane.kind === 'viewer' && pane.filePath === workbenchPathOf(rootDir)
}

/** The tasks on a page that are waiting on the user, in page order. */
export function wantingSections(snapshot: WorkbenchSnapshot | undefined): WorkbenchSection[] {
  return snapshot ? snapshot.sections.filter(wantsUser) : []
}

/** What makes a waiting task the same wait: who, how, and what it asked. */
function waitKey(section: WorkbenchSection): string {
  return `${section.agent}\u0000${section.status}\u0000${section.question ?? ''}`
}

/**
 * The tasks in `next` that are newly waiting on the user since `prev`. With no
 * `prev` — the first look at a page, at launch or on opening a workspace —
 * nothing is news: those waits were there before anyone was watching.
 */
export function newlyWanting(
  prev: WorkbenchSnapshot | undefined,
  next: WorkbenchSnapshot
): WorkbenchSection[] {
  if (!prev) return []
  const before = new Set(wantingSections(prev).map(waitKey))
  return wantingSections(next).filter((section) => !before.has(waitKey(section)))
}

/** The worst status on a page, for a pane header's chip; null for an empty page. */
export function pageStatus(
  snapshot: WorkbenchSnapshot | undefined
): 'needs-input' | 'blocked' | 'working' | 'done' | null {
  const sections = snapshot?.sections ?? []
  if (sections.length === 0) return null
  for (const status of ['needs-input', 'blocked', 'working'] as const) {
    if (sections.some((section) => section.status === status)) return status
  }
  return 'done'
}

/** What a bell says about one waiting task. */
export function bellText(
  workspaceName: string,
  section: WorkbenchSection
): { title: string; body: string } {
  const title = `${workspaceName} needs you`
  const ask = section.question ?? (section.status === 'blocked' ? 'Blocked' : 'Waiting on you')
  return { title, body: `${section.title}\n${ask}` }
}

/**
 * A notification's click target for a workspace's workbench. Bells carry a
 * pane id to focus; the workbench may not have a pane open yet, so it gets a
 * name of its own that the click handler opens the page for.
 */
const BELL_PREFIX = 'workbench:'

export function workbenchBellTarget(workspaceId: string): string {
  return `${BELL_PREFIX}${workspaceId}`
}

export function workspaceOfBellTarget(target: string): string | null {
  return target.startsWith(BELL_PREFIX) ? target.slice(BELL_PREFIX.length) : null
}
