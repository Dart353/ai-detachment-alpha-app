import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../store/app'
import { useRuntime } from '../store/runtime'
import { saveNow } from '../store/persist'

/**
 * Claude panes mid-turn right now: quitting would cut them off. Only agents count —
 * a terminal reads as "working" whenever it has printed lately, which says nothing
 * about whether closing it loses anything.
 */
function workingAgentCount(): number {
  const status = useRuntime.getState().status
  return useApp
    .getState()
    .workspaces.flatMap((workspace) => workspace.panes)
    .filter((pane) => pane.kind === 'claude' && status[pane.id] === 'working').length
}

export interface CloseGuard {
  /** How many agents are working, while the quit question is up; null otherwise. */
  asking: number | null
  quitAnyway: () => void
  keepOpen: () => void
}

/**
 * The renderer's half of the close handshake (main/ipc/window.ts). When the window
 * is about to close, save the workspaces — every pane's session id with them, which
 * is what resumes it next launch — and only then tell main to go ahead. If an agent
 * is mid-task, ask first: closing stops it.
 */
export function useCloseGuard(): CloseGuard {
  const [asking, setAsking] = useState<number | null>(null)

  const finish = useCallback(async (): Promise<void> => {
    try {
      await saveNow()
    } finally {
      // A failed save must not trap the user in the app; main logs and goes.
      window.api?.proceedClose()
    }
  }, [])

  useEffect(
    () =>
      window.api?.onCloseRequested(() => {
        const working = workingAgentCount()
        if (working === 0) {
          void finish()
          return
        }
        window.api.holdClose()
        setAsking(working)
      }),
    [finish]
  )

  const quitAnyway = useCallback(() => {
    setAsking(null)
    void finish()
  }, [finish])

  const keepOpen = useCallback(() => {
    setAsking(null)
    window.api?.cancelClose()
  }, [])

  return { asking, quitAnyway, keepOpen }
}
