import { useEffect, useState } from 'react'
import { useApp, findPane } from '../store/app'
import { useRuntime } from '../store/runtime'
import { sessionPctOfWindow, sessionWindowPct } from '../lib/usageMath'

/**
 * The renderer's side of the usage feed. Main polls the source and broadcasts;
 * everything here does is keep one subscription alive, hand out a ticking clock
 * for the "updated Ns ago" copy, and answer "what is this pane's share?".
 */

/** How many mounted components currently want the feed. */
let subscriberCount = 0
/** The live subscription, owned by the first subscriber to arrive. */
let unsubscribe: (() => void) | null = null

function startSync(): void {
  const setUsage = useRuntime.getState().setUsage
  unsubscribe = window.api?.onUsage(setUsage) ?? null
  // The broadcast only fires when the poll finds something new, so the first
  // paint would otherwise wait out a whole interval on the cache it could have
  // had immediately.
  void window.api?.getUsage().then((usage) => {
    if (subscriberCount > 0) setUsage(usage)
  })
}

function stopSync(): void {
  unsubscribe?.()
  unsubscribe = null
}

/**
 * Keep `runtime.usage` fed for as long as any component asks. Ref-counted rather
 * than guarded by a boolean, so the pill and the sidebar may both mount it and
 * the feed survives whichever of them unmounts first.
 */
export function useUsageSync(): void {
  useEffect(() => {
    subscriberCount += 1
    if (subscriberCount === 1) startSync()
    return () => {
      subscriberCount -= 1
      if (subscriberCount === 0) stopSync()
    }
  }, [])
}

/**
 * A clock that re-renders its owner every `intervalMs`, for countdowns and
 * freshness lines. An interval of 0 or less pauses it: a closed popover has no
 * text to keep current and should cost nothing.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (intervalMs <= 0) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])

  return now
}

/**
 * A claude pane's share of the current session window, as whole percent — or
 * null when there is no usage to read, the pane has not claimed a transcript,
 * or that transcript has spent nothing in this window. Null means "say nothing",
 * never "0%".
 */
export function usePaneShare(paneId: string): number | null {
  const usage = useRuntime((state) => state.usage)
  // The persisted id is the pane's own binding; the runtime one is what the
  // transcript watcher found for a pane that has not been saved with it yet.
  const persistedSessionId = useApp((state) => findPane(state, paneId)?.pane.sessionId ?? null)
  const watchedSessionId = useRuntime((state) => state.sessions[paneId]?.sessionId ?? null)

  if (!usage?.available) return null
  const sessionId = persistedSessionId ?? watchedSessionId
  if (!sessionId) return null

  const tokens = usage.bySessionId[sessionId] ?? 0
  if (tokens <= 0) return null
  return sessionPctOfWindow(tokens, usage.windowTokens, sessionWindowPct(usage))
}
