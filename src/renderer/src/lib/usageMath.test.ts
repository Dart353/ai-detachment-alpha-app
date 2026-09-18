import { describe, expect, it } from 'vitest'
import {
  WARN_AT_PCT,
  barWidthPct,
  capProjectionLabel,
  findWindow,
  resetLabel,
  resetsInLabel,
  rowsBySession,
  sessionPctOfWindow,
  sessionWindowPct,
  sortWindows,
  timeLeft,
  toneFor,
  updatedAgo,
  type UsagePaneRef
} from './usageMath'
import type { PaneStatus, UsageSnapshot, UsageWindow } from '../../../shared/types'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** A fixed wall-clock anchor: Monday 2025-06-02, 09:00 local time. */
const NOW = new Date(2025, 5, 2, 9, 0, 0).getTime()

function makeWindow(over: Partial<UsageWindow> & { key: string }): UsageWindow {
  return { label: over.key, pct: 0, resetsAt: null, ...over }
}

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    available: true,
    plan: 'Max 20×',
    updatedAt: NOW,
    windows: [makeWindow({ key: 'session', label: 'Current session', pct: 62 })],
    bySessionId: {},
    windowTokens: 0,
    ...over
  }
}

function pane(paneId: string, sessionId?: string, status: PaneStatus = 'idle'): UsagePaneRef {
  return { paneId, name: paneId, status, sessionId }
}

describe('sessionPctOfWindow', () => {
  it('splits the window percentage across the sessions that spent it', () => {
    // the mockup's numbers: a 62% window shared 41 / 14 / 7
    expect(sessionPctOfWindow(6600, 10_000, 62)).toBe(41)
    expect(sessionPctOfWindow(2300, 10_000, 62)).toBe(14)
    expect(sessionPctOfWindow(1100, 10_000, 62)).toBe(7)
  })

  it('is zero when the window holds no tokens at all', () => {
    expect(sessionPctOfWindow(0, 0, 62)).toBe(0)
    expect(sessionPctOfWindow(500, 0, 62)).toBe(0)
  })
})

describe('barWidthPct', () => {
  it('measures a value against the largest consumer', () => {
    expect(barWidthPct(41, 62)).toBe(66)
    expect(barWidthPct(14, 62)).toBe(23)
    expect(barWidthPct(7, 62)).toBe(11)
    expect(barWidthPct(41, 41)).toBe(100)
  })

  it('keeps a non-zero value visible and never overflows the track', () => {
    expect(barWidthPct(1, 10_000)).toBe(2)
    expect(barWidthPct(200, 100)).toBe(100)
  })

  it('is zero for nothing spent and for an empty window', () => {
    expect(barWidthPct(0, 62)).toBe(0)
    expect(barWidthPct(10, 0)).toBe(0)
  })
})

describe('toneFor', () => {
  it('paints the window in play accent and the reported ones neutral', () => {
    expect(toneFor(0, 'session')).toBe('accent')
    expect(toneFor(79, 'session')).toBe('accent')
    expect(toneFor(38, 'background')).toBe('neutral')
  })

  it('turns warm at the threshold, whatever the role', () => {
    expect(toneFor(WARN_AT_PCT, 'session')).toBe('warn')
    expect(toneFor(81, 'background')).toBe('warn')
    expect(toneFor(100, 'session')).toBe('warn')
  })
})

describe('timeLeft', () => {
  it('formats days, hours and minutes', () => {
    expect(timeLeft(NOW + 2 * HOUR + 14 * MINUTE, NOW)).toBe('2h 14m')
    expect(timeLeft(NOW + 4 * DAY + 9 * HOUR, NOW)).toBe('4d 9h')
    expect(timeLeft(NOW + 12 * MINUTE, NOW)).toBe('12m')
  })

  it('handles the boundaries and a window that is already up', () => {
    expect(timeLeft(NOW + DAY, NOW)).toBe('1d 0h')
    expect(timeLeft(NOW + HOUR, NOW)).toBe('1h 0m')
    expect(timeLeft(NOW + MINUTE, NOW)).toBe('1m')
    expect(timeLeft(NOW + 59_000, NOW)).toBe('now')
    expect(timeLeft(NOW - HOUR, NOW)).toBe('now')
  })

  it('is empty when the endpoint reported no reset', () => {
    expect(timeLeft(null, NOW)).toBe('')
  })
})

describe('resetLabel', () => {
  it('names the clock time within a day', () => {
    const resetsAt = new Date(2025, 5, 2, 16, 42).getTime()
    expect(resetLabel(resetsAt, NOW)).toMatch(/^resets \d{1,2}:42/)
  })

  it('names the weekday on a 24-hour clock beyond a day', () => {
    const resetsAt = new Date(2025, 5, 9, 0, 0).getTime()
    expect(resetLabel(resetsAt, NOW)).toMatch(/^resets \S+ 00:00$/)
  })

  it('is empty without a reset', () => {
    expect(resetLabel(null, NOW)).toBe('')
  })
})

describe('resetsInLabel', () => {
  it('counts down, and drops the "in" once the window is up', () => {
    expect(resetsInLabel(NOW + 2 * HOUR + 14 * MINUTE, NOW)).toBe('resets in 2h 14m')
    expect(resetsInLabel(NOW, NOW)).toBe('resets now')
    expect(resetsInLabel(null, NOW)).toBe('')
  })
})

describe('updatedAgo', () => {
  it('reports the age of the cached snapshot at every scale', () => {
    expect(updatedAgo(NOW - 30_000, NOW)).toBe('updated 30s ago')
    expect(updatedAgo(NOW - 2 * MINUTE, NOW)).toBe('updated 2m ago')
    expect(updatedAgo(NOW - 3 * HOUR, NOW)).toBe('updated 3h ago')
    expect(updatedAgo(NOW - 2 * DAY, NOW)).toBe('updated 2d ago')
  })

  it('never reads negative when the clock skews', () => {
    expect(updatedAgo(NOW + 5000, NOW)).toBe('updated 0s ago')
  })
})

describe('capProjectionLabel', () => {
  it('names the weekday the burn rate would cap on', () => {
    const friday = new Date(2025, 5, 6, 13, 0).getTime()
    expect(capProjectionLabel(friday, NOW)).toBe("at this rate you'll cap Friday")
  })

  it('says today and tomorrow rather than naming those days', () => {
    expect(capProjectionLabel(NOW + 4 * HOUR, NOW)).toBe("at this rate you'll cap today")
    expect(capProjectionLabel(NOW + 20 * HOUR, NOW)).toBe("at this rate you'll cap tomorrow")
    expect(capProjectionLabel(NOW - HOUR, NOW)).toBe("at this rate you'll cap today")
  })

  it('is null when there is nothing to project', () => {
    expect(capProjectionLabel(null, NOW)).toBeNull()
    expect(capProjectionLabel(undefined, NOW)).toBeNull()
  })
})

describe('window lookup and ordering', () => {
  const windows = [
    makeWindow({ key: 'weekly_scoped:Sonnet', pct: 12 }),
    makeWindow({ key: 'weekly_all', pct: 38 }),
    makeWindow({ key: 'weekly_scoped:Opus', pct: 81 }),
    makeWindow({ key: 'session', pct: 62 })
  ]

  it('orders session, then the week, then each model', () => {
    expect(sortWindows(windows).map((each) => each.key)).toEqual([
      'session',
      'weekly_all',
      'weekly_scoped:Opus',
      'weekly_scoped:Sonnet'
    ])
  })

  it('leaves the source array untouched', () => {
    const before = windows.map((each) => each.key)
    sortWindows(windows)
    expect(windows.map((each) => each.key)).toEqual(before)
  })

  it('finds a window by key, and the session percentage', () => {
    const usage = snapshot({ windows })
    expect(findWindow(usage, 'weekly_all')?.pct).toBe(38)
    expect(findWindow(usage, 'nope')).toBeNull()
    expect(findWindow(null, 'session')).toBeNull()
    expect(sessionWindowPct(usage)).toBe(62)
    expect(sessionWindowPct(null)).toBe(0)
  })
})

describe('rowsBySession', () => {
  const usage = snapshot({
    windowTokens: 10_000,
    bySessionId: { 's-auth': 6600, 's-tests': 2300, 's-runner': 1100, 's-gone': 400 }
  })
  const panes = [
    pane('p-tests', 's-tests'),
    pane('p-auth', 's-auth', 'working'),
    pane('p-runner', 's-runner', 'done'),
    pane('p-shell'),
    pane('p-fresh', 's-unspent')
  ]

  it('joins spend to panes, biggest first, with shares and bar widths', () => {
    const rows = rowsBySession(usage, panes)
    expect(rows.map((row) => row.paneId)).toEqual(['p-auth', 'p-tests', 'p-runner'])
    expect(rows.map((row) => row.pctOfWindow)).toEqual([41, 14, 7])
    expect(rows.map((row) => row.barPct)).toEqual([100, 35, 17])
    expect(rows[0].status).toBe('working')
  })

  it('omits panes with no session and panes that spent nothing', () => {
    const rows = rowsBySession(usage, panes)
    expect(rows.some((row) => row.paneId === 'p-shell')).toBe(false)
    expect(rows.some((row) => row.paneId === 'p-fresh')).toBe(false)
  })

  it('is empty when usage is unavailable or nothing has been spent', () => {
    expect(rowsBySession(null, panes)).toEqual([])
    expect(rowsBySession(snapshot({ available: false }), panes)).toEqual([])
    expect(rowsBySession(snapshot({ windowTokens: 0 }), panes)).toEqual([])
  })
})
