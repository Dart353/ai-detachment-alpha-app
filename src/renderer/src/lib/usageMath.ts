/**
 * The arithmetic and copy behind the usage meters (design README 4a): window
 * percentages, per-session shares, and every string the pill, the popover and
 * the sidebar footer put on screen.
 *
 * Pure — no React, no IPC, and `now` is always passed in — so the whole of it is
 * unit-testable and nothing here ever reads the clock behind a caller's back.
 */
import type { PaneStatus, UsageSnapshot, UsageWindow } from '../../../shared/types'

/**
 * The threshold every meter turns warm at. Deliberately the same number as
 * `ui/Meter`'s: that module owns the bar's paint and this one owns the text and
 * tone beside it, and neither may import the other (Meter pulls in CSS, which a
 * node-environment test cannot load).
 */
export const WARN_AT_PCT = 80

/** The key of the rolling window a pane's own spend is measured against. */
export const SESSION_WINDOW_KEY = 'session'
/** The key of the all-models weekly window. */
export const WEEKLY_ALL_KEY = 'weekly_all'
/** Per-model weekly windows carry the model after this prefix. */
export const WEEKLY_SCOPED_PREFIX = 'weekly_scoped:'

/** Narrowest a bar may be drawn while still standing for a non-zero value. */
const MIN_BAR_PCT = 2

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** What a meter — and the text beside it — paints with. */
export type UsageTone = 'accent' | 'neutral' | 'warn'

/** Whether a window is the one the user is spending in, or merely reported. */
export type WindowRole = 'session' | 'background'

/** One line of "this window, by session" in the popover. */
export interface SessionUsageRow {
  paneId: string
  name: string
  status: PaneStatus
  tokens: number
  /** the pane's share of the session window, as whole percent of the cap */
  pctOfWindow: number
  /** bar width, 0–100, relative to the biggest consumer in the window */
  barPct: number
}

/** The panes `rowsBySession` joins token spend to. */
export interface UsagePaneRef {
  paneId: string
  name: string
  status: PaneStatus
  /** the Claude transcript this pane is bound to, when it has claimed one */
  sessionId?: string
}

/* === percentages ============================================================ */

/**
 * A pane's share of the five-hour window, in the same unit as the window meter:
 * if the window is 62% spent and this pane produced two-thirds of that spend, it
 * reads 41%. Zero when nothing has been spent yet — a share of nothing is not
 * "everything", however tempting the division looks.
 */
export function sessionPctOfWindow(
  sessionTokens: number,
  windowTokens: number,
  sessionWindowPct: number
): number {
  if (windowTokens <= 0) return 0
  return Math.round((sessionTokens / windowTokens) * sessionWindowPct)
}

/**
 * How wide a session's bar is drawn: its size relative to the biggest consumer
 * in the window, not to the window itself — the rows compare sessions with each
 * other, and against a mostly-unspent window every bar would otherwise be a
 * sliver. A non-zero value never collapses to invisible.
 */
export function barWidthPct(value: number, maxValue: number): number {
  if (value <= 0 || maxValue <= 0) return 0
  const width = Math.round((value / maxValue) * 100)
  return Math.max(MIN_BAR_PCT, Math.min(100, width))
}

/** The percent of the session window, or 0 when there is no usage to read. */
export function sessionWindowPct(usage: UsageSnapshot | null): number {
  return findWindow(usage, SESSION_WINDOW_KEY)?.pct ?? 0
}

export function findWindow(usage: UsageSnapshot | null, key: string): UsageWindow | null {
  return usage?.windows.find((candidate) => candidate.key === key) ?? null
}

/**
 * The windows in the order the popover and the sidebar show them: the window in
 * play first, then the all-models week, then whatever per-model weeks the plan
 * reports (alphabetically, so the list does not reshuffle between polls).
 */
export function sortWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank = (window: UsageWindow): number => {
    if (window.key === SESSION_WINDOW_KEY) return 0
    if (window.key === WEEKLY_ALL_KEY) return 1
    return 2
  }
  return [...windows].sort((left, right) => {
    const byRank = rank(left) - rank(right)
    return byRank !== 0 ? byRank : left.key.localeCompare(right.key)
  })
}

/** The tone a window's meter, percent readout and footer copy all share. */
export function toneFor(pct: number, role: WindowRole): UsageTone {
  if (pct >= WARN_AT_PCT) return 'warn'
  return role === 'session' ? 'accent' : 'neutral'
}

/* === clock copy ============================================================= */

/** `"2h 14m"`, `"4d 9h"`, `"12m"`, `"now"`; empty when the window has no reset. */
export function timeLeft(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return ''
  const remaining = resetsAt - now
  if (remaining < MINUTE_MS) return 'now'
  if (remaining >= DAY_MS) {
    const days = Math.floor(remaining / DAY_MS)
    return `${days}d ${Math.floor((remaining % DAY_MS) / HOUR_MS)}h`
  }
  if (remaining >= HOUR_MS) {
    const hours = Math.floor(remaining / HOUR_MS)
    return `${hours}h ${Math.floor((remaining % HOUR_MS) / MINUTE_MS)}m`
  }
  return `${Math.floor(remaining / MINUTE_MS)}m`
}

/**
 * When the window comes back: a clock time for anything inside a day ("resets
 * 4:42 PM"), a weekday and a 24-hour time beyond it ("resets Mon 00:00") — past
 * midnight tonight the hour alone stops telling you which day it means.
 */
export function resetLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return ''
  const when = new Date(resetsAt)
  if (resetsAt - now < DAY_MS) {
    const time = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(when)
    return `resets ${time}`
  }
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(when)
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(when)
  return `resets ${weekday} ${clock}`
}

/** `"resets in 2h 14m"` — the sidebar's phrasing for the window in play. */
export function resetsInLabel(resetsAt: number | null, now: number): string {
  const left = timeLeft(resetsAt, now)
  if (!left) return ''
  return left === 'now' ? 'resets now' : `resets in ${left}`
}

/** `"updated 30s ago"` — the freshness of the cached snapshot, never blank. */
export function updatedAgo(updatedAt: number, now: number): string {
  const age = Math.max(0, now - updatedAt)
  if (age < MINUTE_MS) return `updated ${Math.floor(age / 1000)}s ago`
  if (age < HOUR_MS) return `updated ${Math.floor(age / MINUTE_MS)}m ago`
  if (age < DAY_MS) return `updated ${Math.floor(age / HOUR_MS)}h ago`
  return `updated ${Math.floor(age / DAY_MS)}d ago`
}

/**
 * The burn-rate warning — "at this rate you'll cap Friday" — or null when the
 * endpoint gave us nothing to project from. Near dates are named rather than
 * dated, because "Wednesday" is not what anyone calls tomorrow.
 */
export function capProjectionLabel(
  projectedCapAt: number | null | undefined,
  now: number
): string | null {
  if (projectedCapAt === null || projectedCapAt === undefined) return null
  const days = calendarDaysBetween(now, projectedCapAt)
  if (days <= 0) return "at this rate you'll cap today"
  if (days === 1) return "at this rate you'll cap tomorrow"
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(
    new Date(projectedCapAt)
  )
  return `at this rate you'll cap ${weekday}`
}

/** Whole calendar days from `from` to `to`, ignoring the time of day. */
function calendarDaysBetween(from: number, to: number): number {
  const start = startOfDay(new Date(from))
  const end = startOfDay(new Date(to))
  return Math.round((end - start) / DAY_MS)
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/* === per-session rows ======================================================= */

/**
 * "This window, by session": the panes that actually spent something, biggest
 * first. Panes with no transcript — or a transcript with no spend in this
 * window — are left out rather than listed at zero.
 */
export function rowsBySession(
  usage: UsageSnapshot | null,
  panes: UsagePaneRef[]
): SessionUsageRow[] {
  if (!usage?.available) return []
  const windowPct = sessionWindowPct(usage)
  const spent: SessionUsageRow[] = []
  for (const pane of panes) {
    const tokens = pane.sessionId ? (usage.bySessionId[pane.sessionId] ?? 0) : 0
    if (tokens <= 0) continue
    spent.push({
      paneId: pane.paneId,
      name: pane.name,
      status: pane.status,
      tokens,
      pctOfWindow: sessionPctOfWindow(tokens, usage.windowTokens, windowPct),
      barPct: 0
    })
  }
  spent.sort((left, right) => right.tokens - left.tokens)
  const largest = spent.length > 0 ? spent[0].tokens : 0
  return spent.map((row) => ({ ...row, barPct: barWidthPct(row.tokens, largest) }))
}
