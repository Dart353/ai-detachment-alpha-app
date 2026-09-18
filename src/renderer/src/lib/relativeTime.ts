/**
 * "Closed 5 minutes ago": epoch milliseconds as the phrase a person would use.
 *
 * Pure — `now` is always passed in, never read from the clock — so the same two
 * stamps always produce the same string and every boundary is testable.
 *
 * The scale coarsens as it goes (minutes → hours → days → weeks) and gives up at
 * roughly a month, where a calendar date says more than "5 weeks ago" does.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
/** Past this, a date reads better than a count of weeks. */
const CALENDAR_AFTER = 4 * WEEK

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

/** "3 hours ago" / "1 hour ago" — the unit is pluralized by the count. */
function ago(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}

/** "Mar 4", carrying the year only when it is not the year we are in now. */
function shortDate(then: Date, now: Date): string {
  const label = `${MONTHS[then.getMonth()]} ${then.getDate()}`
  return then.getFullYear() === now.getFullYear() ? label : `${label}, ${then.getFullYear()}`
}

/** How long ago `thenMs` was, as of `nowMs`. Future stamps read as "just now". */
export function relativeTime(thenMs: number, nowMs: number): string {
  const elapsed = nowMs - thenMs
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return ago(Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return ago(Math.floor(elapsed / HOUR), 'hour')
  if (elapsed < 2 * DAY) return 'yesterday'
  if (elapsed < WEEK) return ago(Math.floor(elapsed / DAY), 'day')
  if (elapsed < CALENDAR_AFTER) return ago(Math.floor(elapsed / WEEK), 'week')
  return shortDate(new Date(thenMs), new Date(nowMs))
}

export default relativeTime
