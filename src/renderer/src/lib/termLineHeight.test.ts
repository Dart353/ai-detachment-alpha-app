import { describe, expect, it } from 'vitest'
import { ROW_RATIO, measureNaturalHeight, xtermLineHeight } from './termLineHeight'

describe('xtermLineHeight', () => {
  it('lands rows at fontSize × 1.6 for a face with tall natural metrics', () => {
    // JetBrains Mono at 12px measures ~15.6px with line-height: normal
    const lh = xtermLineHeight(12, 15.6)
    expect(lh * 15.6).toBeCloseTo(12 * ROW_RATIO, 1)
  })

  it('is exactly the CSS ratio for a face whose natural height equals its size', () => {
    expect(xtermLineHeight(12, 12)).toBe(1.6)
  })

  it('never squashes a face taller than the target row', () => {
    expect(xtermLineHeight(12, 30)).toBe(1)
  })

  it('falls back to 1 on a missing or nonsense measurement', () => {
    expect(xtermLineHeight(12, 0)).toBe(1)
    expect(xtermLineHeight(0, 15)).toBe(1)
    expect(xtermLineHeight(12, Number.NaN)).toBe(1)
  })
})

describe('measureNaturalHeight', () => {
  it('is null without a DOM', () => {
    expect(measureNaturalHeight('monospace', 12)).toBeNull()
  })
})
