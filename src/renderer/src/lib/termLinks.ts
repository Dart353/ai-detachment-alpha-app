/**
 * Clickable link provider for the xterm terminals.
 *
 * URIs printed inside a pane become clickable: `http(s)://` opens in the default
 * browser and `figma://` deep-links into the Figma desktop app. Both flow through
 * the existing external-open path (window.api.openExternal); the caller supplies
 * the `onOpen` callback so this module stays free of app wiring.
 *
 * @xterm/addon-web-links is deliberately NOT used: it only handles http(s) and
 * would need a second provider for figma://. One custom provider covers both.
 *
 * A URL can span several buffer rows in two distinct ways, and both are stitched
 * back together here:
 *
 * SOFT WRAP. xterm itself wraps at the right margin and marks each continuation
 * row `isWrapped`. Walking that flag reassembles the logical line exactly.
 *
 * HARD WRAP. Claude Code's TUI does its own text layout: it breaks a long token
 * with a REAL newline plus a shallow indent, so the continuation row is a
 * separate logical line with isWrapped === false and the flag walk cannot see
 * it. Those rows are stitched heuristically: when a URI match runs flush into
 * the final column, the next row's first indented token is treated as the
 * continuation (see assembleSegments / candidateStarts below).
 */
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

// A URL found inside a plain string, with 0-based inclusive character offsets.
// Kept free of any xterm types so the scanning logic can be unit-tested without
// a live Terminal.
export interface ScannedLink {
  url: string
  start: number // index of the first character of the URL
  end: number // index of the LAST character of the URL (inclusive)
}

// One physical buffer row as the pure core sees it.
export interface RowInfo {
  text: string // full row, exactly `cols` characters wide (padded with spaces)
  isWrapped: boolean // xterm's soft-wrap continuation flag
}

// Accessor the pure core uses instead of a live Terminal, so tests can back it
// with a plain array.
export type RowLookup = (row: number) => RowInfo | undefined

// A slice of one physical row that contributes to a logical line. Soft-wrapped
// rows contribute their full width at startCol 0; hard-wrap continuations
// contribute only their first token, at startCol = indent width.
export interface Segment {
  row: number // absolute buffer row, 0-based
  startCol: number // 0-based column of the segment's first character
  text: string
}

// A link resolved to buffer cells, 0-based, end inclusive of the last char.
export interface CellLink {
  url: string
  start: { row: number; col: number }
  end: { row: number; col: number }
}

// Match http(s):// and figma:// URIs. The character class stops the URL at
// whitespace and at quoting/bracket-pair characters that never belong inside a
// bare URL, so a URL sitting in prose or wrapped in `"..."` is bounded cleanly.
const URI_PATTERN = /(?:https?|figma):\/\/[^\s"'`<>{}]+/g

// A hard-wrap continuation row: an optional shallow indent, then a run of
// URI-safe characters. Only the first whitespace-delimited run is stitched on;
// anything after a space on that row is ordinary text.
const HARD_CONTINUATION_RE = /^(\s{0,16})([^\s"'`<>{}]+)/

// A single character that could sit inside a URI (same class as URI_PATTERN).
const URI_CHAR_RE = /[^\s"'`<>{}]/

// Hard cap on physical rows stitched into one logical line, so a pathological
// buffer full of flush-to-edge rows cannot make one hover walk the world.
const MAX_LOGICAL_ROWS = 12

// Trailing sentence punctuation that is almost always prose, not part of the URL.
const TRAILING_PUNCTUATION = '.,;:!?'

function countOccurrences(text: string, ch: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text[i] === ch) n++
  return n
}

/**
 * Trim characters that commonly abut a URL in prose or markdown but are not part
 * of it: trailing sentence punctuation, and an UNBALANCED closing `)` or `]`.
 *
 * The bracket rule is the classic linkifier heuristic: a trailing `)` is dropped
 * only when the URL contains no matching `(`, so markdown like `(figma://x)`
 * loses its `)` while a real query string such as `?set=(a,b)` keeps it.
 */
function trimTrailing(url: string): string {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    if (TRAILING_PUNCTUATION.includes(ch)) {
      end--
      continue
    }
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '['
      const slice = url.slice(0, end)
      if (countOccurrences(slice, ch) > countOccurrences(slice, open)) {
        end--
        continue
      }
    }
    break
  }
  return url.slice(0, end)
}

/**
 * Pure text scan: find every clickable URI in a string and return each with its
 * trimmed text and 0-based inclusive character offsets. No xterm dependency, so
 * this is the unit-testable core of the provider.
 */
export function scanLinks(line: string): ScannedLink[] {
  const out: ScannedLink[] = []
  URI_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URI_PATTERN.exec(line)) !== null) {
    const url = trimTrailing(match[0])
    if (url.length === 0) continue
    out.push({ url, start: match.index, end: match.index + url.length - 1 })
  }
  return out
}

/**
 * True when an UNTRIMMED URI match runs to the very end of the text. This is
 * the join gate for hard-wrap stitching: only a URL visibly cut off by the row
 * edge may continue onto the next row, so a full-width prose row never absorbs
 * the line below it. The raw match is used instead of scanLinks so a URL that
 * happens to wrap right after a '.' or ')' still joins; trailing-punctuation
 * trimming applies only to the final assembled URL.
 */
function rawLinkReachesEnd(text: string): boolean {
  URI_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URI_PATTERN.exec(text)) !== null) {
    if (match.index + match[0].length === text.length) return true
  }
  return false
}

/** Walk soft-wrap flags back to the first row of a logical line. */
function softStart(row: number, getRow: RowLookup): number {
  let r = row
  while (r > 0) {
    const info = getRow(r)
    if (info && info.isWrapped) r--
    else break
  }
  return r
}

/**
 * Assemble the logical line starting at `start` into segments.
 *
 * First the soft-wrapped rows: each contributes its full width at startCol 0,
 * exactly `cols` characters (translateToString(false) pads with spaces), so
 * string offsets map onto cells by plain arithmetic.
 *
 * Then hard-wrap continuations: while the assembled text ends in a URI match
 * flush against the final column and the next row opens with an indented
 * URI-safe token, that token (and only that token) is appended as a segment.
 * The continuation may itself fill its row and continue, capped at
 * MAX_LOGICAL_ROWS total rows.
 */
export function assembleSegments(start: number, getRow: RowLookup, cols: number): Segment[] {
  const segments: Segment[] = []

  // Soft-wrapped rows of the logical line.
  let row = start
  for (;;) {
    const info = getRow(row)
    if (!info) break
    segments.push({ row, startCol: 0, text: info.text })
    if (segments.length >= MAX_LOGICAL_ROWS) return segments
    const next = getRow(row + 1)
    if (!next || !next.isWrapped) break
    row++
  }

  // Hard-wrap continuations.
  for (;;) {
    if (segments.length === 0 || segments.length >= MAX_LOGICAL_ROWS) break
    const last = segments[segments.length - 1]
    // The previous segment must run flush into the final column (always true
    // for a full soft row; a continuation token must reach the edge itself).
    if (last.startCol + last.text.length < cols) break
    if (!rawLinkReachesEnd(segments.map((s) => s.text).join(''))) break
    const next = getRow(last.row + 1)
    if (!next || next.isWrapped) break
    const m = HARD_CONTINUATION_RE.exec(next.text)
    if (!m) break
    segments.push({ row: last.row + 1, startCol: m[1].length, text: m[2] })
  }

  return segments
}

/**
 * Candidate logical-line starts for a hover on `requestedRow`, latest first.
 *
 * The hovered row may itself be a hard-wrap continuation (hovering "5002" must
 * light up the whole URL), so in addition to the soft-wrap walk we step back
 * one logical line whenever the current start looks like a continuation row
 * and the row above runs flush into the final column with a URI-safe char.
 * That test is deliberately weak (no scheme check: a middle continuation row
 * has no scheme on it); assembly's join gate does the strict check, and
 * findLinksAtRow simply tries the candidates until one yields a link touching
 * the requested row. Walking back too far over ordinary flush-to-edge prose is
 * therefore harmless: that candidate assembles no join and produces no link.
 */
function candidateStarts(requestedRow: number, getRow: RowLookup, cols: number): number[] {
  const starts: number[] = []
  let start = softStart(requestedRow, getRow)
  starts.push(start)
  for (let i = 0; i < MAX_LOGICAL_ROWS && start > 0; i++) {
    const first = getRow(start)
    if (!first || !HARD_CONTINUATION_RE.test(first.text)) break
    const prev = getRow(start - 1)
    if (!prev) break
    const lastCh = prev.text[cols - 1]
    if (lastCh === undefined || !URI_CHAR_RE.test(lastCh)) break
    start = softStart(start - 1, getRow)
    starts.push(start)
  }
  return starts
}

/**
 * Map a string offset in the joined segment text back to a buffer cell.
 *
 * WIDE CHARACTERS. This assumes one cell per character. A double-width glyph
 * (CJK, some emoji) occupies two cells but one string index, which would shift
 * later offsets. URLs are ASCII, so for the link text itself the mapping is
 * exact; a wide glyph sitting earlier on the same logical line is the only case
 * that could nudge a URL's underline, and terminal URLs virtually never share a
 * line with wide glyphs. Kept simple on purpose.
 */
function offsetToCell(segments: Segment[], offset: number): { row: number; col: number } {
  let acc = 0
  for (const s of segments) {
    if (offset < acc + s.text.length) {
      return { row: s.row, col: s.startCol + (offset - acc) }
    }
    acc += s.text.length
  }
  const last = segments[segments.length - 1]
  return { row: last.row, col: last.startCol + last.text.length - 1 }
}

/** Scan a segment list and resolve every found URL to buffer cells. */
function linksInSegments(segments: Segment[]): CellLink[] {
  if (segments.length === 0) return []
  const joined = segments.map((s) => s.text).join('')
  return scanLinks(joined).map((l) => ({
    url: l.url,
    start: offsetToCell(segments, l.start),
    end: offsetToCell(segments, l.end)
  }))
}

/**
 * The pure core of provideLinks: every link whose range touches `requestedRow`,
 * in 0-based buffer cells. Candidates are tried earliest-first so a hover on
 * any row of a stitched URL assembles from the same logical start and returns
 * an identical range (xterm caches links by range, so this must be stable).
 *
 * KNOWN FALSE POSITIVE, accepted: a genuine URL ending exactly at the final
 * column whose NEXT line happens to start with an indented token gets that
 * token glued on. The join gate (rawLinkReachesEnd) confines this to lines
 * that really do end in a URI match at the edge; ordinary full-width text
 * never joins. Also unfixable at this layer: a URL whose scheme itself is
 * split by the hard wrap ("figm" / "a://...") has no visible scheme on the
 * first row, so no match is found to extend.
 */
export function findLinksAtRow(requestedRow: number, getRow: RowLookup, cols: number): CellLink[] {
  const out: CellLink[] = []
  const seen = new Set<string>()
  const starts = candidateStarts(requestedRow, getRow, cols)
  for (let i = starts.length - 1; i >= 0; i--) {
    const segments = assembleSegments(starts[i], getRow, cols)
    for (const link of linksInSegments(segments)) {
      if (requestedRow < link.start.row || requestedRow > link.end.row) continue
      const key = `${link.start.row},${link.start.col},${link.end.row},${link.end.col}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(link)
    }
  }
  return out
}

/**
 * Build an xterm ILinkProvider that makes printed URIs clickable.
 *
 * provideLinks is called once per buffer row (1-based). All the real work is in
 * the pure helpers above; this only adapts the live buffer to RowLookup and
 * converts 0-based cells to xterm's 1-based IBufferRange, whose end.x is
 * INCLUSIVE of the last character cell (see ILink / IBufferRange typings).
 */
export function createUrlLinkProvider(
  term: Terminal,
  onOpen: (url: string) => void
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback): void {
      // Read cols and the buffer live on every call so pane resizes are
      // reflected (the provider is registered once but the terminal is not).
      const cols = term.cols
      const buffer = term.buffer.active
      const getRow: RowLookup = (row) => {
        const line = buffer.getLine(row)
        // Clamp to [0, cols): a buffer line's array length may EXCEED cols after
        // a resize (it is not trimmed), so translateToString with no bounds
        // would return more than cols characters and skew the offset arithmetic
        // in offsetToCell. Bounding to cols yields exactly `cols` characters
        // (out-of-range cells translate to whitespace), keeping every row the
        // same width the pure core assumes.
        return line
          ? { text: line.translateToString(false, 0, cols), isWrapped: line.isWrapped }
          : undefined
      }
      const links: ILink[] = findLinksAtRow(bufferLineNumber - 1, getRow, cols).map(
        (found) => ({
          range: {
            start: { x: found.start.col + 1, y: found.start.row + 1 },
            end: { x: found.end.col + 1, y: found.end.row + 1 }
          },
          text: found.url,
          // Left-click opens the link. xterm underlines provider links on hover
          // by default, so no hover/leave handlers are needed.
          activate: () => onOpen(found.url)
        })
      )
      callback(links.length > 0 ? links : undefined)
    }
  }
}
