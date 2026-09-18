import { describe, expect, it } from 'vitest'
import { filterMouseReports } from './mouseReports'

const focused = { dropHover: false }
const unfocused = { dropHover: true }
const x10 = (cb: number): string => `\x1b[M${String.fromCharCode(32 + cb)}!!`

describe('filterMouseReports', () => {
  it('passes plain typing through untouched', () => {
    expect(filterMouseReports('hello\r', focused)).toBe('hello\r')
    expect(filterMouseReports('\x1b[A', focused)).toBe('\x1b[A')
  })

  it('drops right-button press and release, focused or not', () => {
    expect(filterMouseReports('\x1b[<2;10;5M\x1b[<2;10;5m', focused)).toBe('')
    expect(filterMouseReports('\x1b[<2;10;5M', unfocused)).toBe('')
  })

  it('drops a right-click carrying modifiers, and a right-drag', () => {
    expect(filterMouseReports('\x1b[<18;1;1M', focused)).toBe('') // ctrl + right
    expect(filterMouseReports('\x1b[<6;1;1M', focused)).toBe('') // shift + right
    expect(filterMouseReports('\x1b[<34;4;4M', focused)).toBe('') // right-drag motion
  })

  it('keeps left and middle clicks and the wheel', () => {
    const left = '\x1b[<0;3;3M\x1b[<0;3;3m'
    const middle = '\x1b[<1;3;3M'
    const wheel = '\x1b[<64;3;3M\x1b[<65;3;3M\x1b[<66;3;3M'
    expect(filterMouseReports(left + middle + wheel, focused)).toBe(left + middle + wheel)
  })

  it('drops hover only when the pane is unfocused', () => {
    const hover = '\x1b[<35;7;7M'
    expect(filterMouseReports(hover, focused)).toBe(hover)
    expect(filterMouseReports(hover, unfocused)).toBe('')
    // a left-drag is not hover
    expect(filterMouseReports('\x1b[<32;7;7M', unfocused)).toBe('\x1b[<32;7;7M')
  })

  it('handles legacy X10 reports the same way', () => {
    expect(filterMouseReports(x10(2), focused)).toBe('')
    expect(filterMouseReports(x10(0), focused)).toBe(x10(0))
    expect(filterMouseReports(x10(35), unfocused)).toBe('')
    expect(filterMouseReports(x10(35), focused)).toBe(x10(35))
  })

  it('keeps the surrounding bytes when a report is removed', () => {
    expect(filterMouseReports('a\x1b[<2;1;1Mb', focused)).toBe('ab')
  })
})
