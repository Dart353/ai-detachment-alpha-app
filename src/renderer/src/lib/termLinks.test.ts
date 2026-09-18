import { describe, expect, it } from 'vitest'
import { assembleSegments, findLinksAtRow, scanLinks, type RowInfo } from './termLinks'

describe('scanLinks', () => {
  it('finds a plain URL with inclusive offsets', () => {
    const line = 'see https://example.com/x now'
    expect(scanLinks(line)).toEqual([
      { url: 'https://example.com/x', start: 4, end: 24 }
    ])
    expect(line.slice(4, 25)).toBe('https://example.com/x')
  })

  it('trims trailing sentence punctuation', () => {
    expect(scanLinks('go to http://a.test/page.').map((l) => l.url)).toEqual([
      'http://a.test/page'
    ])
  })

  it('drops an unbalanced closing bracket but keeps a balanced one', () => {
    expect(scanLinks('(https://a.test/p)').map((l) => l.url)).toEqual(['https://a.test/p'])
    expect(scanLinks('https://a.test/p?set=(a,b)').map((l) => l.url)).toEqual([
      'https://a.test/p?set=(a,b)'
    ])
  })

  it('matches figma:// deep links', () => {
    expect(scanLinks('open figma://file/abc123/Design').map((l) => l.url)).toEqual([
      'figma://file/abc123/Design'
    ])
  })

  it('finds two links on one line', () => {
    expect(scanLinks('https://a.test/1 and figma://b/2').map((l) => l.url)).toEqual([
      'https://a.test/1',
      'figma://b/2'
    ])
  })

  it('returns nothing for a line without a URI', () => {
    expect(scanLinks('no links here, just prose://')).toEqual([])
  })
})

/** Back the pure core with a plain array of rows padded to `cols`. */
function lookupOf(rows: RowInfo[], cols: number) {
  return (row: number): RowInfo | undefined => {
    const info = rows[row]
    return info ? { text: info.text.padEnd(cols, ' '), isWrapped: info.isWrapped } : undefined
  }
}

describe('assembleSegments', () => {
  it('joins soft-wrapped rows at full width', () => {
    const cols = 10
    const rows: RowInfo[] = [
      { text: 'https://a.', isWrapped: false },
      { text: 'test/page1', isWrapped: true }
    ]
    const segments = assembleSegments(0, lookupOf(rows, cols), cols)
    expect(segments.map((s) => s.text).join('')).toBe('https://a.test/page1')
  })

  it('stitches a hard-wrapped continuation token', () => {
    const cols = 10
    const rows: RowInfo[] = [
      { text: 'https://a.', isWrapped: false },
      { text: '  test/p rest', isWrapped: false }
    ]
    const segments = assembleSegments(0, lookupOf(rows, cols), cols)
    expect(segments.map((s) => s.text).join('')).toBe('https://a.test/p')
    expect(segments[1].startCol).toBe(2)
  })
})

describe('findLinksAtRow', () => {
  it('reports the same range from either row of a wrapped URL', () => {
    const cols = 10
    const rows: RowInfo[] = [
      { text: 'https://a.', isWrapped: false },
      { text: 'test/page1', isWrapped: true }
    ]
    const getRow = lookupOf(rows, cols)
    const first = findLinksAtRow(0, getRow, cols)
    const second = findLinksAtRow(1, getRow, cols)
    expect(first).toEqual(second)
    expect(first).toEqual([
      { url: 'https://a.test/page1', start: { row: 0, col: 0 }, end: { row: 1, col: 9 } }
    ])
  })
})
