import { useEffect } from 'react'
import { useApp } from '../store/app'
import { useRuntime } from '../store/runtime'
import { buildHostSnapshot } from '../lib/hostSnapshot'

/** Bursts of status ticks and activity stamps collapse into one publish. */
const PUBLISH_DEBOUNCE_MS = 400

/**
 * Keeps main's relay feed current, and carries out what a phone asks for.
 * Mounted once from the app shell, next to the status engine whose verdicts
 * it forwards.
 *
 * It subscribes to the two stores directly rather than through React state:
 * a status tick or an activity stamp must not re-render the shell, and the
 * only consumer here is an IPC send. Nothing is published while Remote is off
 * — main would only drop it — and the moment it is switched on the current
 * picture goes out, so a phone never waits for the next tick.
 */
export function useHostPublisher(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const publish = (): void => {
      timer = null
      const app = useApp.getState()
      if (!app.settings.relay.enabled) return
      const runtime = useRuntime.getState()
      window.api?.publishRelaySnapshot(
        buildHostSnapshot({
          workspaces: app.workspaces,
          recents: app.recents,
          status: runtime.status,
          sessions: runtime.sessions,
          lastActivity: runtime.lastActivity,
          now: Date.now()
        })
      )
    }

    const schedule = (): void => {
      if (timer !== null) return
      timer = setTimeout(publish, PUBLISH_DEBOUNCE_MS)
    }

    const offApp = useApp.subscribe((state, previous) => {
      if (
        state.workspaces !== previous.workspaces ||
        state.recents !== previous.recents ||
        state.settings.relay.enabled !== previous.settings.relay.enabled
      ) {
        schedule()
      }
    })
    const offRuntime = useRuntime.subscribe((state, previous) => {
      if (
        state.status !== previous.status ||
        state.sessions !== previous.sessions ||
        state.lastActivity !== previous.lastActivity
      ) {
        schedule()
      }
    })
    schedule()

    // A phone's ask goes through the same store actions a click would, so the
    // pane lands where a split would put it and the folder opens as the dialog
    // would open it. The one difference: a restore prompt has no one at the
    // desktop to answer it, so an archived folder is restored outright.
    const offCommand = window.api?.onRelayCommand((command) => {
      const app = useApp.getState()
      if (command.type === 'addPane') {
        if (app.workspaces.some((workspace) => workspace.id === command.workspaceId)) {
          app.addPane(command.workspaceId, { kind: command.kind })
        }
        return
      }
      app.openWorkspace(command.rootDir)
      if (useApp.getState().pendingRestore) useApp.getState().confirmRestore('restore')
    })

    return () => {
      offApp()
      offRuntime()
      offCommand?.()
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
}

export default useHostPublisher
