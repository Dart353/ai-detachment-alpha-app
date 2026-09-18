/**
 * The app's keyboard chords, as ONE window listener in the CAPTURE phase.
 *
 * Capture is load-bearing: a focused terminal owns every keystroke that reaches
 * it, so a bubble-phase listener would only ever hear the chords no pane was
 * focused for. xterm declines exactly this set (see `isAppShortcut` in
 * TerminalPane), and this handler stops the ones it acts on from travelling any
 * further.
 *
 * Text fields are the one exception: a rename box must be able to contain a `b`.
 * The terminal's own hidden textarea is NOT such a field — it is how xterm reads
 * the keyboard — so it is explicitly let through.
 */
import { useEffect } from 'react'
import { useApp } from '../store/app'
import { zonePaneIds } from '../lib/zones'

/** True for a real text field — but never for xterm's hidden input. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.classList.contains('xterm-helper-textarea')) return false
  if (target.isContentEditable) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const isMac = window.api?.platform === 'darwin'

    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (!mod || event.altKey) return
      if (isTextEntry(event.target)) return

      const state = useApp.getState()
      const workspace = state.workspaces.find(
        (candidate) => candidate.id === state.activeWorkspaceId
      )
      const key = event.key.toLowerCase()
      let handled = false

      if (!event.shiftKey && /^[1-9]$/.test(key)) {
        // Panes are numbered in reading order, which is the order the zones are
        // laid out in — not the order the panes were spawned.
        const paneId = workspace ? zonePaneIds(workspace.layout)[Number(key) - 1] : undefined
        if (paneId) {
          state.focusPane(paneId)
          handled = true
        }
      } else if (!event.shiftKey && key === 'b') {
        state.toggleSidebar()
        handled = true
      } else if (event.shiftKey && key === 'm') {
        if (workspace?.focusedPaneId) {
          state.toggleMaximize(workspace.focusedPaneId)
          handled = true
        }
      } else if (event.shiftKey && key === 'l') {
        state.setZoneEditorOpen(true)
        handled = true
      } else if (event.shiftKey && (key === '[' || key === '{' || key === ']' || key === '}')) {
        // Shift+[ and Shift+] arrive as { and } on most layouts, so both count.
        const back = key === '[' || key === '{'
        const index = state.workspaces.findIndex(
          (candidate) => candidate.id === state.activeWorkspaceId
        )
        if (index >= 0 && state.workspaces.length > 1) {
          const count = state.workspaces.length
          const next = (index + (back ? -1 : 1) + count) % count
          state.selectWorkspace(state.workspaces[next].id)
          handled = true
        }
      }

      if (!handled) return
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

export default useGlobalShortcuts
