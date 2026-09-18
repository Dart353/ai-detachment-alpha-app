import { describe, expect, it } from 'vitest'
import { relativeTime } from './relativeTime'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** A fixed "now" in local time, so the calendar cases are not clock-dependent. */
const NOW = new Date(2025, 2, 20, 12, 0, 0).getTime()

/** `NOW` minus an elapsed span, the way every case here is stated. */
function agoBy(elapsed: number): number {
  return NOW - elapsed
}

describe('relativeTime', () => {
  it('reads as "just now" under a minute, at both ends', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now')
    expect(relativeTime(agoBy(MINUTE - 1), NOW)).toBe('just now')
  })

  it('treats a stamp from the future as "just now"', () => {
    expect(relativeTime(NOW + HOUR, NOW)).toBe('just now')
  })

  it('counts minutes from one minute up to the hour', () => {
    expect(relativeTime(agoBy(MINUTE), NOW)).toBe('1 minute ago')
    expect(relativeTime(agoBy(5 * MINUTE), NOW)).toBe('5 minutes ago')
    expect(relativeTime(agoBy(HOUR - 1), NOW)).toBe('59 minutes ago')
  })

  it('counts hours from one hour up to the day', () => {
    expect(relativeTime(agoBy(HOUR), NOW)).toBe('1 hour ago')
    expect(relativeTime(agoBy(3 * HOUR), NOW)).toBe('3 hours ago')
    expect(relativeTime(agoBy(DAY - 1), NOW)).toBe('23 hours ago')
  })

  it('says "yesterday" for the whole second day', () => {
    expect(relativeTime(agoBy(DAY), NOW)).toBe('yesterday')
    expect(relativeTime(agoBy(2 * DAY - 1), NOW)).toBe('yesterday')
  })

  it('counts days from the second day up to the week', () => {
    expect(relativeTime(agoBy(2 * DAY), NOW)).toBe('2 days ago')
    expect(relativeTime(agoBy(4 * DAY), NOW)).toBe('4 days ago')
    expect(relativeTime(agoBy(WEEK - 1), NOW)).toBe('6 days ago')
  })

  it('counts weeks up to four of them', () => {
    expect(relativeTime(agoBy(WEEK), NOW)).toBe('1 week ago')
    expect(relativeTime(agoBy(3 * WEEK), NOW)).toBe('3 weeks ago')
    expect(relativeTime(agoBy(4 * WEEK - 1), NOW)).toBe('3 weeks ago')
  })

  it('falls back to a short date once four weeks have passed', () => {
    // 2025-03-20 minus 28 days
    expect(relativeTime(agoBy(4 * WEEK), NOW)).toBe('Feb 20')
  })

  it('carries the year when it differs from the current one', () => {
    const lastYear = new Date(2024, 2, 4, 9, 30, 0).getTime()
    expect(relativeTime(lastYear, NOW)).toBe('Mar 4, 2024')
  })
})
