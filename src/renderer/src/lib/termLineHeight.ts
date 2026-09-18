/**
 * The design says "JetBrains Mono 12px, line-height 1.6" in the CSS sense: a
 * 12px face on 19.2px rows. xterm's `lineHeight` option means something else —
 * it multiplies the font's NATURAL cell height, the one `line-height: normal`
 * gives, which a face with generous built-in metrics (JetBrains Mono: ~1.32×)
 * already pads. Passing 1.6 straight through therefore paints 12px glyphs on
 * 25px rows and the terminal reads as sparse next to the rest of the UI. Convert
 * the CSS ratio into what xterm wants by measuring that natural height first.
 */

/** Row height as a multiple of the font size — the spec's CSS line-height. */
export const ROW_RATIO = 1.6

/**
 * The xterm `lineHeight` that puts rows at `fontSize * ROW_RATIO` when the face
 * measures `naturalPx` tall at that size. Never below 1: xterm clamps there
 * anyway, and a font taller than the target row should not be squashed.
 */
export function xtermLineHeight(fontSize: number, naturalPx: number): number {
  if (!(fontSize > 0) || !(naturalPx > 0)) return 1
  const ratio = (fontSize * ROW_RATIO) / naturalPx
  return Math.max(1, Math.round(ratio * 1000) / 1000)
}

/**
 * The natural line box of `fontStack` at `fontSize`, measured the way xterm
 * measures it: a `line-height: normal` element holding a glyph. Returns null
 * outside a DOM (tests) or when the measurement comes back empty.
 */
export function measureNaturalHeight(fontStack: string, fontSize: number): number | null {
  if (typeof document === 'undefined') return null
  const probe = document.createElement('span')
  probe.textContent = 'W'
  Object.assign(probe.style, {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'pre',
    lineHeight: 'normal',
    fontFamily: fontStack,
    fontSize: `${fontSize}px`
  })
  document.body.appendChild(probe)
  const height = probe.getBoundingClientRect().height
  probe.remove()
  return height > 0 ? height : null
}
