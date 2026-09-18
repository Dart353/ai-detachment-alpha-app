import type { JSX, ReactNode } from 'react'
import { Minus, Plus } from 'lucide-react'
import './settings.css'

export interface SettingRowProps {
  label: string
  /** The second line under the label — what the setting actually does. */
  description?: string
  /** Greyed out because a master switch above it is off; the control still works. */
  dimmed?: boolean
  /** The control on the right of the row. */
  children: ReactNode
}

/**
 * One line of a settings card: wording on the left, control on the right, with a
 * hairline between neighbours. Every section builds from this so the label
 * column, the type sizes and the dividers can never drift between them.
 */
export function SettingRow({ label, description, dimmed, children }: SettingRowProps): JSX.Element {
  return (
    <div className={`ada-set-row${dimmed ? ' ada-set-row--dim' : ''}`}>
      <div className="ada-set-row-text">
        <div className="ada-set-row-label">{label}</div>
        {description && <div className="ada-set-row-desc">{description}</div>}
      </div>
      <div className="ada-set-row-control">{children}</div>
    </div>
  )
}

export interface StepperProps {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  /** Appended to the number, e.g. "px" or "%". */
  suffix?: string
  ariaLabel: string
}

/**
 * The numeric control settings use instead of a text field: the ranges here are
 * short and bounded (font size, a warning percentage), so a pair of nudge buttons
 * is both faster and impossible to type an invalid value into.
 */
export function Stepper({
  value,
  min,
  max,
  onChange,
  suffix,
  ariaLabel
}: StepperProps): JSX.Element {
  const step = (delta: number): void => {
    const next = Math.min(max, Math.max(min, value + delta))
    if (next !== value) onChange(next)
  }

  return (
    <div
      className="ada-set-stepper"
      role="spinbutton"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
    >
      <button
        type="button"
        className="ada-set-stepper-btn"
        aria-label={`${ariaLabel}: decrease`}
        disabled={value <= min}
        onClick={() => step(-1)}
      >
        <Minus size={12} />
      </button>
      <span className="ada-set-stepper-value">
        {value}
        {suffix}
      </span>
      <button
        type="button"
        className="ada-set-stepper-btn"
        aria-label={`${ariaLabel}: increase`}
        disabled={value >= max}
        onClick={() => step(1)}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

export default SettingRow
