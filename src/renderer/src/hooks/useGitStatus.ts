import { useEffect, useState } from 'react'
import type { GitStatus } from '../../../shared/types'

/** How often a visible window re-reads the branch and dirty flag. */
const POLL_MS = 10_000

/**
 * The git branch and dirty flag of `cwd`, kept roughly fresh.
 *
 * Polling is the honest model here: the status changes from outside the app
 * (a commit in another terminal, a checkout by an agent), so there is nothing
 * to subscribe to. Three things keep the poll cheap and correct:
 *   • a hidden window reads nothing — a backgrounded app has no footer to paint;
 *   • coming back into focus reads immediately, so the first glance is current;
 *   • a response that lands after `cwd` changed is dropped rather than shown
 *     against the wrong workspace.
 */
export function useGitStatus(cwd: string | undefined): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null)

  useEffect(() => {
    // A different folder has a different branch: clear first, never carry the
    // previous workspace's line across the switch.
    setStatus(null)
    if (!cwd) return undefined

    let cancelled = false
    const read = (): void => {
      if (typeof document !== 'undefined' && document.hidden) return
      void window.api?.gitStatus(cwd).then((next) => {
        if (!cancelled) setStatus(next)
      })
    }

    read()
    const timer = window.setInterval(read, POLL_MS)
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', read)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', read)
    }
  }, [cwd])

  return status
}

export default useGitStatus
