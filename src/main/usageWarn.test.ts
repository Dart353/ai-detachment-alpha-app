import { describe, expect, it } from 'vitest'
import { shouldWarn, warnKey } from './usageWarn'
import type { UsageWindow } from '../shared/types'

function window(over: Partial<UsageWindow> = {}): UsageWindow {
  return { key: 'weekly_scoped:Fable', label: 'Weekly · Fable', pct: 80, resetsAt: null, ...over }
}

const MONDAY = Date.parse('2026-09-21T13:59:59.960Z')

describe('shouldWarn', () => {
  it('stays quiet under the threshold', () => {
    expect(shouldWarn(new Set(), window({ pct: 79.9 }), 80)).toBe(false)
  })

  it('rings once, then drops the same window on every later poll', () => {
    const latch = new Set<string>()
    expect(shouldWarn(latch, window({ resetsAt: MONDAY }), 80)).toBe(true)
    expect(shouldWarn(latch, window({ resetsAt: MONDAY, pct: 84 }), 80)).toBe(false)
  })

  it('ignores the fractional-second jitter the endpoint puts on resets_at', () => {
    const latch = new Set<string>()
    expect(shouldWarn(latch, window({ resetsAt: MONDAY }), 80)).toBe(true)
    // .960969 → .961146 a poll later: a different millisecond, the same window
    expect(shouldWarn(latch, window({ resetsAt: MONDAY + 1 }), 80)).toBe(false)
    expect(shouldWarn(latch, window({ resetsAt: MONDAY + 29_000 }), 80)).toBe(false)
  })

  it('rings again once the window has rolled over', () => {
    const latch = new Set<string>()
    expect(shouldWarn(latch, window({ resetsAt: MONDAY }), 80)).toBe(true)
    const WEEK = 7 * 24 * 60 * 60 * 1000
    expect(shouldWarn(latch, window({ resetsAt: MONDAY + WEEK }), 80)).toBe(true)
  })

  it('keeps windows apart and never latches without a reset time', () => {
    const latch = new Set<string>()
    expect(shouldWarn(latch, window({ key: 'weekly_all', resetsAt: MONDAY }), 80)).toBe(true)
    expect(shouldWarn(latch, window({ key: 'session', resetsAt: MONDAY }), 80)).toBe(true)
    expect(warnKey(window())).toBe('weekly_scoped:Fable:unknown')
  })
})
