import type { UsageWindow } from '../shared/types'

/**
 * The once-per-window latch behind the usage warning banner. Pure so it can be
 * unit tested without Electron; `ipc/usage.ts` owns the Set and the toast.
 */

/**
 * The endpoint stamps `resets_at` with the request's own fractional second
 * (`13:59:59.960969`, then `.961146` a poll later), so two readings of the same
 * window rarely agree to the millisecond. Keying on the minute is what makes a
 * window "the same window" across polls; a genuine rollover is days apart.
 */
export function warnKey(window: Pick<UsageWindow, 'key' | 'resetsAt'>): string {
  const reset = window.resetsAt === null ? 'unknown' : Math.round(window.resetsAt / 60_000)
  return `${window.key}:${reset}`
}

/**
 * Should this window raise a warning banner right now? True exactly once per
 * (window, reset time) pair: the meter keeps reporting 84% for hours, and one
 * banner per window per window-period is the whole point. A new reset time is a
 * new window, so the same key warns again after it rolls over.
 */
export function shouldWarn(latch: Set<string>, window: UsageWindow, warnAtPct: number): boolean {
  if (window.pct < warnAtPct) return false
  const pair = warnKey(window)
  if (latch.has(pair)) return false
  latch.add(pair)
  return true
}
