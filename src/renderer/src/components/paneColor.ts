import type { CSSProperties } from 'react'

/**
 * The operator's chosen pane colour, handed to CSS as a custom property so the
 * stylesheet decides where it shows (border, header tint, seam) and in what
 * strength. `undefined` for an uncoloured pane: no inline style at all.
 */
export function paneColorVars(color: string | undefined): CSSProperties | undefined {
  if (!color) return undefined
  return { ['--ada-pane-color' as string]: color } as CSSProperties
}
