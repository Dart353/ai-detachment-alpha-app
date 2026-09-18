import { type JSX } from 'react'
import './Meter.css'

export type MeterTone = 'accent' | 'neutral'
/** What a meter actually paints with once the threshold has had its say. */
export type MeterPaint = MeterTone | 'warn'

export interface MeterProps {
  /** 0–100. Values outside the range are clamped rather than overflowing the track. */
  pct: number
  /** `accent` for the window in play, `neutral` for the ones merely reported. */
  tone?: MeterTone
  height?: 4 | 6
  className?: string
  /** Accessible name — "Weekly · Opus", say. */
  label?: string
}

/** The usage threshold above which every meter turns warn (settings' `warnAtPct`). */
const WARN_AT_PCT = 80

/**
 * The colour a meter at `pct` paints with. Exported because the percent readout and
 * the projection line beside a meter have to change colour with it, and they are
 * the caller's markup, not ours. The palette has no red: warn is as hot as it gets.
 */
export function meterTone(pct: number, tone: MeterTone = 'accent'): MeterPaint {
  return pct >= WARN_AT_PCT ? 'warn' : tone
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0
  return Math.max(0, Math.min(100, pct))
}

/**
 * The usage bar (design README 4a). One track, one fill, and the threshold rule
 * that every limit window in the app shares.
 */
export function Meter({
  pct,
  tone = 'accent',
  height = 6,
  className,
  label
}: MeterProps): JSX.Element {
  const value = clampPct(pct)
  const paint = meterTone(value, tone)
  return (
    <div
      className={`ada-meter ada-meter-${paint}${className ? ` ${className}` : ''}`}
      style={{ height, borderRadius: height / 2 }}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="ada-meter-fill"
        style={{ width: `${value}%`, borderRadius: height / 2 }}
      />
    </div>
  )
}

export default Meter
