import { type JSX } from 'react'
import { Meter } from './ui'
import { useNow, useUsageSync } from '../hooks/useUsage'
import { useRuntime } from '../store/runtime'
import {
  SESSION_WINDOW_KEY,
  WEEKLY_ALL_KEY,
  findWindow,
  resetLabel,
  resetsInLabel
} from '../lib/usageMath'
import type { UsageWindow } from '../../../shared/types'
import './SidebarUsage.css'

/** How often the reset countdown re-reads the clock. */
const TICK_MS = 30_000

/**
 * The sidebar footer's two meters (design README 4a): the window being spent
 * right now, and the week behind it. The sidebar only mounts this when it is
 * expanded — the 46px rail has no room for a number, let alone a bar.
 */
export default function SidebarUsage(): JSX.Element {
  useUsageSync()
  const usage = useRuntime((state) => state.usage)
  const now = useNow(TICK_MS)

  // Zeros would be a claim about spend we cannot make; say so instead.
  if (!usage?.available) return <div className="ada-sbu-unavailable">Usage unavailable</div>

  const session = findWindow(usage, SESSION_WINDOW_KEY)
  const weekly = findWindow(usage, WEEKLY_ALL_KEY)

  return (
    <div className="ada-sbu">
      {session && (
        <SidebarMeter
          usageWindow={session}
          label="SESSION WINDOW"
          tone="accent"
          reset={resetsInLabel(session.resetsAt, now)}
        />
      )}
      {weekly && (
        <SidebarMeter
          usageWindow={weekly}
          label="WEEKLY · ALL"
          tone="neutral"
          reset={resetLabel(weekly.resetsAt, now)}
        />
      )}
    </div>
  )
}

interface SidebarMeterProps {
  usageWindow: UsageWindow
  /** The all-caps caption; the snapshot's own label is written for the popover. */
  label: string
  tone: 'accent' | 'neutral'
  reset: string
}

function SidebarMeter({ usageWindow, label, tone, reset }: SidebarMeterProps): JSX.Element {
  return (
    <div className="ada-sbu-block">
      <div className="ada-sbu-head">
        <span className="ada-sbu-label">{label}</span>
        <span className="ada-sbu-pct">{usageWindow.pct}%</span>
      </div>
      <Meter pct={usageWindow.pct} tone={tone} height={4} label={label} />
      {reset && <div className="ada-sbu-reset">{reset}</div>}
    </div>
  )
}
