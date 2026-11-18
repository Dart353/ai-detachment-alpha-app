/**
 * The workbench, app-wide. Mounted once from the app shell.
 *
 *   • watches every open workspace's folder for its page (main does the
 *     watching; this keeps the set of folders in step with the workspaces);
 *   • keeps the latest page per folder in the runtime store, where the
 *     sidebar, the tabs and the pane header read their badges from;
 *   • rings when a task starts waiting on the user, through the same
 *     Settings matrix as a pane asking for input — but not while the user is
 *     looking straight at the workbench;
 *   • sets newly opened folders up when Settings asks for that.
 */
import { useEffect, useRef } from 'react'
import type { WorkbenchSection } from '../../../shared/types'
import { useApp } from '../store/app'
import { useRuntime } from '../store/runtime'
import { shouldDeliver } from '../lib/notify'
import { playChime } from '../lib/sound'
import { bellText, isWorkbenchPane, newlyWanting, workbenchBellTarget } from '../lib/workbench'

/** The one subscriber id this window watches every root under; main refcounts per root. */
const WATCH_ID = 'workbench:app'

/** Is the user looking at this workspace's workbench right now? */
function watchingWorkbench(rootDir: string): boolean {
  if (typeof document === 'undefined' || !document.hasFocus() || document.hidden) return false
  const state = useApp.getState()
  if (state.view !== 'grid') return false
  const workspace = state.workspaces.find((candidate) => candidate.id === state.activeWorkspaceId)
  if (!workspace || workspace.rootDir !== rootDir) return false
  const focused = workspace.panes.find((pane) => pane.id === workspace.focusedPaneId)
  return !!focused && isWorkbenchPane(focused, rootDir)
}

function ring(rootDir: string, section: WorkbenchSection): void {
  const state = useApp.getState()
  const workspace = state.workspaces.find((candidate) => candidate.rootDir === rootDir)
  if (!workspace) return
  const gates = shouldDeliver(state.settings.notifications, 'attention', {
    focusedAndVisible: watchingWorkbench(rootDir)
  })
  if (!gates.banner && !gates.sound) return
  const { title, body } = bellText(workspace.name, section)
  if (gates.banner) {
    window.api?.showNotification({
      title,
      body,
      paneId: workbenchBellTarget(workspace.id),
      silent: true
    })
  }
  if (gates.sound) playChime('attention')
}

export function useWorkbench(): void {
  /* ---- pages in, bells out ----------------------------------------------- */
  useEffect(() => {
    return window.api?.onWorkbench((snapshot) => {
      const runtime = useRuntime.getState()
      const previous = runtime.workbench[snapshot.rootDir]
      runtime.setWorkbench(snapshot)
      for (const section of newlyWanting(previous, snapshot)) ring(snapshot.rootDir, section)
    })
  }, [])

  /* ---- one watch per open folder ------------------------------------------ */
  // A string, so the selector is stable and this only re-runs when the set of
  // folders really changes — not on every pane focus.
  const roots = useApp((state) => state.workspaces.map((workspace) => workspace.rootDir).join('\n'))
  const watched = useRef(new Set<string>())

  useEffect(() => {
    const next = new Set(roots ? roots.split('\n') : [])
    for (const root of next) {
      if (!watched.current.has(root)) window.api?.watchWorkbench(WATCH_ID, root)
    }
    for (const root of watched.current) {
      if (next.has(root)) continue
      window.api?.unwatchWorkbench(WATCH_ID, root)
      useRuntime.getState().forgetWorkbench(root)
    }
    watched.current = next
  }, [roots])

  useEffect(() => {
    const current = watched.current
    return () => {
      for (const root of current) window.api?.unwatchWorkbench(WATCH_ID, root)
      current.clear()
    }
  }, [])

  /* ---- auto setup for newly opened folders -------------------------------- */
  const hydrated = useApp((state) => state.hydrated)
  const ids = useApp((state) => state.workspaces.map((workspace) => workspace.id).join(','))
  // The workspaces that were there at launch are not "newly opened".
  const known = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (!hydrated) return
    const state = useApp.getState()
    if (known.current === null) {
      known.current = new Set(state.workspaces.map((workspace) => workspace.id))
      return
    }
    for (const workspace of state.workspaces) {
      if (known.current.has(workspace.id)) continue
      known.current.add(workspace.id)
      if (state.settings.workbench.autoSetup) void window.api?.setupWorkbench(workspace.rootDir)
    }
  }, [hydrated, ids])
}

export default useWorkbench
