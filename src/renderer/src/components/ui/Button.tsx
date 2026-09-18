import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import './Button.css'

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'icon'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. Defaults to 'outline' — the hairline-bordered button. */
  variant?: ButtonVariant
  size?: ButtonSize
  /** Rendered before the children, inside the same flex row. */
  icon?: ReactNode
  /** Pressed / "the flyout this opens is up" state. Also reflected as aria-pressed. */
  active?: boolean
  /**
   * Tints the label with the warn colour. The palette has NO red, so a caution
   * action is a shade warmer than its neighbours rather than a different animal.
   */
  danger?: boolean
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ada-btn-primary',
  outline: 'ada-btn-outline',
  ghost: 'ada-btn-ghost',
  icon: 'ada-btn-icon'
}

/**
 * The app's one button. Every surface draws from the same four weights so a
 * toolbar, a dialog footer and a pane header agree on what "the loud one" looks
 * like. Native button props (including `type`) pass straight through and the ref
 * forwards, so a caller can anchor a Popover to it.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'outline',
    size = 'md',
    icon,
    active,
    danger,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const classes = ['ada-btn', VARIANT_CLASS[variant]]
  if (size !== 'md') classes.push(`ada-btn-${size}`)
  if (active) classes.push('ada-btn-active')
  if (danger) classes.push('ada-btn-danger')
  if (className) classes.push(className)

  return (
    <button
      ref={ref}
      type={type}
      className={classes.join(' ')}
      aria-pressed={active}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

export default Button
