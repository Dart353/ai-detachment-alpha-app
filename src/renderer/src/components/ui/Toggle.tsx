import { type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import './Toggle.css'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Caption rendered beside the switch; pressing it flips the switch too. */
  label?: string
  disabled?: boolean
  className?: string
  /** Accessible name when there is no visible `label`. */
  ariaLabel?: string
}

/**
 * The settings switch. A button rather than a checkbox, because `role="switch"`
 * is what announces "on / off" instead of "checked"; the whole row is the hit
 * target so the 28×16 track never has to be aimed at.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  className,
  ariaLabel
}: ToggleProps): JSX.Element {
  const toggle = (): void => {
    if (!disabled) onChange(!checked)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    // Enter is not a native button activation for Space-only controls, and a
    // switch should answer to both.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      disabled={disabled}
      className={`ada-toggle${checked ? ' ada-toggle-on' : ''}${className ? ` ${className}` : ''}`}
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      <span className="ada-toggle-track" aria-hidden="true">
        <span className="ada-toggle-knob" />
      </span>
      {label && <span className="ada-toggle-label">{label}</span>}
    </button>
  )
}

export default Toggle
