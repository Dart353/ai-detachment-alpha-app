/**
 * A live view of one pane on a remote machine, streamed through the relay.
 *
 * CLAUDE.md hard rule 3 (fit the terminal, then send the new cols/rows to the
 * PTY) deliberately does not apply here: the remote desktop owns the PTY and its
 * size. This terminal has no fit addon and never resizes a PTY — it renders at
 * whatever cols/rows the remote reports in each `remote:screen`.
 *
 * What it fits instead is the TYPE: the font is scaled until that grid fills
 * the tile it was given, so a pane that is 140 columns wide over there is 140
 * columns wide here, larger or smaller as the tile allows. The box is watched
 * for that alone.
 *
 * The terminal is created once per host/pane, so the parent should key this
 * component by `${hostId}/${paneId}`.
 */
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { filterMouseReports } from '../../lib/mouseReports'
import { fontStack, rowLineHeight, termTheme } from '../../hooks/useTerminalPane'
import '@xterm/xterm/css/xterm.css'
import './remote.css'

export interface RemoteTerminalProps {
  hostId: string
  paneId: string
  /** settings.termFontSize */
  fontSize: number
  /** settings.termFontFamily */
  fontFamily: string
  focused: boolean
  onFocus: () => void
  /** Bump to re-watch: the remote answers with a fresh screen at its current size. */
  refreshToken?: number
  /** The remote's grid, each time a screen says what it is. */
  onSize?: (cols: number, rows: number) => void
}

/** The type never gets smaller or larger than this, whatever the tile. */
const MIN_FONT = 6
const MAX_FONT = 28
/** Room kept between the grid and the tile's edge, per side. */
const PAD = 6

/**
 * Scale the font so the terminal's grid fills `box`. The rendered size of the
 * grid is proportional to the font, so one measurement gives the factor; cell
 * sizes round to whole pixels, so the result is then walked down until it
 * really fits.
 */
function fitFont(term: Terminal, host: HTMLElement, box: HTMLElement, fontFamily: string): void {
  const screen = host.querySelector<HTMLElement>('.xterm-screen')
  const availW = box.clientWidth - PAD * 2
  const availH = box.clientHeight - PAD * 2
  if (!screen || screen.offsetWidth === 0 || screen.offsetHeight === 0 || availW <= 0 || availH <= 0) return

  const apply = (size: number): void => {
    term.options.fontSize = size
    term.options.lineHeight = rowLineHeight(size, fontFamily)
  }
  const current = term.options.fontSize ?? MIN_FONT
  const factor = Math.min(availW / screen.offsetWidth, availH / screen.offsetHeight)
  let size = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.floor(current * factor * 2) / 2))
  if (size !== current) apply(size)
  for (let step = 0; step < 8 && size > MIN_FONT; step++) {
    if (screen.offsetWidth <= availW && screen.offsetHeight <= availH) break
    size -= 0.5
    apply(size)
  }
}

const INITIAL_COLS = 80
const INITIAL_ROWS = 24
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

/**
 * Chords the window-level shortcut listener owns — the same set TerminalPane
 * declines, so they reach the app instead of being sent to the remote.
 */
function isAppShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false
  const key = event.key.toLowerCase()
  if (!event.shiftKey) return /^[1-9]$/.test(key) || key === 'b'
  // Shift+[ and Shift+] arrive as { and } on most layouts, so both spellings count.
  return key === 'm' || key === 'l' || key === '[' || key === ']' || key === '{' || key === '}'
}

function isCopyChord(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  const withModifier = event.ctrlKey || event.metaKey
  return (withModifier && event.shiftKey && key === 'c') || (event.metaKey && !event.shiftKey && key === 'c')
}

function isPasteChord(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  const withModifier = event.ctrlKey || event.metaKey
  return (withModifier && event.shiftKey && key === 'v') || (event.metaKey && !event.shiftKey && key === 'v')
}

function pasteClipboardInto(hostId: string, paneId: string): void {
  void navigator.clipboard
    .readText()
    .then((text) => {
      if (text) window.api.writeRemotePane(hostId, paneId, `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`)
    })
    .catch(() => {})
}

/** Copy/paste chords handled locally; app shortcuts passed up to the window. */
function attachKeyHandler(term: Terminal, hostId: string, paneId: string): void {
  term.attachCustomKeyEventHandler((event) => {
    if (isAppShortcut(event)) return false
    if (isCopyChord(event)) {
      const selection = term.getSelection()
      // With nothing selected, Ctrl+C is still the interrupt the remote expects.
      if (!selection) return true
      if (event.type === 'keydown') window.api.copyText(selection)
      return false
    }
    if (isPasteChord(event)) {
      if (event.type === 'keydown') pasteClipboardInto(hostId, paneId)
      return false
    }
    return true
  })
}

/** Replace the whole screen with the remote's snapshot, at the remote's size. */
function paintScreen(term: Terminal, data: string, cols: number, rows: number): void {
  term.resize(cols, rows)
  term.reset()
  term.write(data, () => {
    term.scrollToBottom()
    term.refresh(0, term.rows - 1)
  })
}

export function RemoteTerminal({
  hostId,
  paneId,
  fontSize,
  fontFamily,
  focused,
  onFocus,
  refreshToken,
  onSize
}: RemoteTerminalProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Read through refs so a re-render never tears the terminal down.
  const propsRef = useRef({ fontSize, fontFamily, focused, onFocus, onSize })
  propsRef.current = { fontSize, fontFamily, focused, onFocus, onSize }

  useEffect(() => {
    const element = containerRef.current
    const box = boxRef.current
    if (!element || !box) return
    const initial = propsRef.current

    const term = new Terminal({
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      fontSize: initial.fontSize,
      fontFamily: fontStack(initial.fontFamily),
      lineHeight: rowLineHeight(initial.fontSize, initial.fontFamily),
      cursorBlink: false,
      theme: termTheme(initial.focused),
      scrollback: 8000
    })
    term.open(element)
    termRef.current = term
    attachKeyHandler(term, hostId, paneId)

    // One fit per frame at most: a burst of box changes is one new size.
    let fitQueued = 0
    const queueFit = (): void => {
      if (fitQueued) return
      fitQueued = requestAnimationFrame(() => {
        fitQueued = 0
        fitFont(term, element, box, propsRef.current.fontFamily)
      })
    }

    const offScreen = window.api.onRemoteScreen((screen) => {
      if (screen.hostId !== hostId || screen.paneId !== paneId) return
      paintScreen(term, screen.data, screen.cols, screen.rows)
      propsRef.current.onSize?.(screen.cols, screen.rows)
      queueFit()
    })
    // The tile changing size changes the type, never the remote's grid.
    const observer = new ResizeObserver(queueFit)
    observer.observe(box)
    const offOutput = window.api.onRemoteOutput((output) => {
      if (output.hostId !== hostId || output.paneId !== paneId) return
      term.write(output.data)
    })
    window.api.watchRemotePane(hostId, paneId)

    // Hovering an unfocused terminal must not send motion reports, and
    // right-button reports never go through (see useTerminalPane).
    const inputDisposable = term.onData((data) => {
      const out = filterMouseReports(data, { dropHover: !element.contains(document.activeElement) })
      if (out) window.api.writeRemotePane(hostId, paneId, out)
    })

    const handleFocusIn = (): void => propsRef.current.onFocus()
    element.addEventListener('focusin', handleFocusIn)

    return () => {
      observer.disconnect()
      if (fitQueued) cancelAnimationFrame(fitQueued)
      window.api.unwatchRemotePane(hostId, paneId)
      element.removeEventListener('focusin', handleFocusIn)
      offScreen()
      offOutput()
      inputDisposable.dispose()
      term.dispose()
      termRef.current = null
      element.replaceChildren()
    }
  }, [hostId, paneId])

  // Re-watch on demand; the first run is the mount effect's own watch.
  const isFirstRefreshRef = useRef(true)
  useEffect(() => {
    if (isFirstRefreshRef.current) {
      isFirstRefreshRef.current = false
      return
    }
    window.api.watchRemotePane(hostId, paneId)
    // Only a bumped token re-watches; an id change remounts via the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  // The caret says which pane the keyboard is pointed at, without a remount;
  // picking the pane in the list puts the keyboard in it too.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = termTheme(focused)
    if (focused) term.focus()
  }, [focused])

  // The face follows the settings; its size follows the tile.
  useEffect(() => {
    const term = termRef.current
    const element = containerRef.current
    const box = boxRef.current
    if (!term || !element || !box) return
    term.options.fontFamily = fontStack(fontFamily)
    fitFont(term, element, box, fontFamily)
  }, [fontSize, fontFamily])

  return (
    <div className="ada-remote-term" ref={boxRef}>
      <div className="ada-remote-term-inner" ref={containerRef} />
    </div>
  )
}
