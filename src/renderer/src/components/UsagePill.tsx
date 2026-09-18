import { useRef, useState, type JSX } from 'react'
import UsagePopover from './UsagePopover'
import { useNow, useUsageSync } from '../hooks/useUsage'
import { useRuntime } from '../store/runtime'
import { SESSION_WINDOW_KEY, findWindow, timeLeft, toneFor } from '../lib/usageMath'
import './UsagePill.css'

/** How often the pill's countdown re-reads the clock, closed and open. */
const TICK_MS = 30_000
const OPEN_TICK_MS = 1000

/**
 * The titlebar's usage readout (design README 4a): the five-hour window's
 * percentage, a short bar and the time left on it, opening the usage popover
 * when clicked.
 *
 * It also owns the usage subscription for the whole renderer — the pill is the
 * one usage surface that is up whenever the working screen is.
 *
 * When usage is unavailable the pill disappears rather than showing zeros: a
 * meter reading 0% is a claim about spend, and we would be making it up.
 */
export default function UsagePill(): JSX.Element | null {
  useUsageSync()
  const usage = useRuntime((state) => state.usage)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const now = useNow(open ? OPEN_TICK_MS : TICK_MS)

  if (!usage?.available) return null

  const sessionWindow = findWindow(usage, SESSION_WINDOW_KEY)
  const pct = sessionWindow?.pct ?? 0
  const left = timeLeft(sessionWindow?.resetsAt ?? null, now)
  const tone = toneFor(pct, 'session')

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ada-nodrag ada-usage-pill"
        aria-label="Usage"
        aria-expanded={open}
        title="Usage"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="ada-usage-pill-pct">{pct}%</span>
        <span className="ada-usage-pill-track" aria-hidden="true">
          <span
            className={`ada-usage-pill-fill ada-usage-fill--${tone}`}
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </span>
        {left && <span className="ada-usage-pill-left">{left}</span>}
      </button>

      <UsagePopover open={open} anchorRef={anchor} onClose={() => setOpen(false)} />
    </>
  )
}
