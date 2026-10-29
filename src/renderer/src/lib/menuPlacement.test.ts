import { describe, expect, it } from 'vitest'
import { menuLeft } from './menuPlacement'

const PAD = 8

describe('menuLeft', () => {
  it('lines up left edges when the menu fits', () => {
    expect(menuLeft(100, 200, 160, 1000, PAD)).toBe(100)
  })

  it('lines up right edges when a wide menu would run off the right side', () => {
    // the Todo board: a 90 px filter at the window's right edge, a 180 px menu
    expect(menuLeft(282, 372, 180, 380, PAD)).toBe(192)
  })

  it('stays inside the window when neither alignment fits', () => {
    expect(menuLeft(20, 60, 300, 320, PAD)).toBe(PAD)
    expect(menuLeft(250, 310, 400, 320, PAD)).toBe(PAD)
  })

  it('never lets the right edge pass the padding', () => {
    const left = menuLeft(300, 370, 100, 380, PAD)
    expect(left + 100).toBeLessThanOrEqual(380 - PAD)
  })
})
