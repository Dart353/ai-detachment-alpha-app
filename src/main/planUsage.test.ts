import { describe, expect, it } from 'vitest'
import { parseUsageResponse, planLabel, projectCapAt } from './planUsage'

/**
 * The endpoint is undocumented and has already changed shape once, so both
 * response forms are pinned here as literal payloads: the modern `limits[]`
 * array (the only place model-scoped weeklies exist) and the legacy top-level
 * keys an older account still gets.
 */

const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS

describe('parseUsageResponse', () => {
  it('reads the modern limits[] array, including a model-scoped weekly', () => {
    const windows = parseUsageResponse({
      limits: [
        { kind: 'session', percent: 41.5, resets_at: '2026-09-17T18:00:00.000Z', severity: 'normal' },
        { kind: 'weekly_all', percent: 63, resets_at: '2026-09-20T07:00:00.000Z', severity: 'normal' },
        {
          kind: 'weekly_scoped',
          percent: 12,
          resets_at: '2026-09-20T07:00:00.000Z',
          severity: 'normal',
          scope: { model: { display_name: 'Opus' } }
        }
      ],
      member_dashboard_available: true
    })

    expect(windows).toEqual([
      {
        key: 'session',
        label: 'Current session',
        pct: 41.5,
        resetsAt: Date.parse('2026-09-17T18:00:00.000Z')
      },
      {
        key: 'weekly_all',
        label: 'Weekly · all models',
        pct: 63,
        resetsAt: Date.parse('2026-09-20T07:00:00.000Z')
      },
      {
        key: 'weekly_scoped:Opus',
        label: 'Weekly · Opus',
        pct: 12,
        resetsAt: Date.parse('2026-09-20T07:00:00.000Z')
      }
    ])
  })

  it('humanizes a kind it has never seen rather than dropping it', () => {
    const windows = parseUsageResponse({ limits: [{ kind: 'monthly_all', percent: 3 }] })
    expect(windows).toEqual([{ key: 'monthly_all', label: 'Monthly all', pct: 3, resetsAt: null }])
  })

  it('falls back to the legacy top-level keys and aliases them onto the same ids', () => {
    const windows = parseUsageResponse({
      five_hour: { utilization: 22, resets_at: '2026-09-17T18:00:00.000Z' },
      seven_day: { utilization: 55, resets_at: '2026-09-20T07:00:00.000Z' },
      seven_day_opus: { utilization: 9, resets_at: '2026-09-20T07:00:00.000Z' },
      spend: { enabled: true, used: { amount_minor: 44, exponent: 2 } }
    })

    expect(windows.map((window) => [window.key, window.label, window.pct])).toEqual([
      ['session', 'Current session', 22],
      ['weekly_all', 'Weekly · all models', 55],
      ['weekly_opus', 'Weekly · Opus', 9]
    ])
    expect(windows[0].resetsAt).toBe(Date.parse('2026-09-17T18:00:00.000Z'))
  })

  it('returns nothing for a response that carries no windows', () => {
    expect(parseUsageResponse({})).toEqual([])
    expect(parseUsageResponse(null)).toEqual([])
  })
})

describe('planLabel', () => {
  it('labels the known subscription tiers', () => {
    expect(planLabel('max')).toBe('Max')
    expect(planLabel('max20x')).toBe('Max 20x')
    expect(planLabel('pro')).toBe('Pro')
  })

  it('humanizes an unknown tier and passes null through', () => {
    expect(planLabel('special_plan')).toBe('Special plan')
    expect(planLabel(null)).toBeNull()
  })
})

describe('projectCapAt', () => {
  const start = Date.parse('2026-09-14T00:00:00.000Z')
  const resetsAt = start + WEEK_MS

  it('projects the current burn rate onto the whole window', () => {
    // a quarter of the window gone, 50% spent → the whole of it goes in half the window
    const now = start + WEEK_MS / 4
    expect(projectCapAt(50, start, resetsAt, now)).toBe(start + WEEK_MS / 2)
  })

  it('is null when the projected cap lands after the reset', () => {
    const now = start + WEEK_MS / 2
    expect(projectCapAt(40, start, resetsAt, now)).toBeNull()
  })

  it('is null over the first tenth of the window, where the rate is noise', () => {
    const now = start + WEEK_MS * 0.05
    expect(projectCapAt(30, start, resetsAt, now)).toBeNull()
  })

  it('is null at zero usage, at 100%, and for a window that has not started', () => {
    const now = start + WEEK_MS / 2
    expect(projectCapAt(0, start, resetsAt, now)).toBeNull()
    expect(projectCapAt(100, start, resetsAt, now)).toBeNull()
    expect(projectCapAt(50, start, resetsAt, start)).toBeNull()
  })
})
