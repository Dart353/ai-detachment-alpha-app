import type { JSX } from 'react'
import './Logo.css'

interface LogoProps {
  width: number
  height: number
  /** Stroke width in viewBox units; the title bar mark uses the default. */
  strokeWidth?: number
  /** Loop the left-to-right chevron fade; honours prefers-reduced-motion. */
  animated?: boolean
  className?: string
}

/**
 * The app mark: three chevrons fading back, drawn inline so it scales with the
 * chrome and picks up the accent token rather than shipping a colour-baked file.
 * Resting opacities come from Logo.css so the static and animated marks agree.
 */
export default function Logo({
  width,
  height,
  strokeWidth = 3,
  animated = true,
  className
}: LogoProps): JSX.Element {
  const classes = ['ada-logo']
  if (animated) classes.push('ada-logo--animated')
  if (className) classes.push(className)

  return (
    <svg
      className={classes.join(' ')}
      width={width}
      height={height}
      viewBox="0 0 30 18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="ada-logo__c1"
        d="M2 2 L9 9 L2 16"
        stroke="var(--ada-accent)"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="ada-logo__c2"
        d="M11 2 L18 9 L11 16"
        stroke="var(--ada-accent)"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="ada-logo__c3"
        d="M20 2 L27 9 L20 16"
        stroke="var(--ada-accent)"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
