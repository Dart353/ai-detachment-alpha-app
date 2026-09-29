/**
 * A live view of one pane on a remote machine, streamed through the relay.
 *
 * CLAUDE.md hard rule 3 (fit the terminal, then send the new cols/rows to the
 * PTY) deliberately does not apply here: the remote desktop owns the PTY and its
 * size. This terminal has no fit addon, no ResizeObserver and never resizes a
 * PTY — it renders at whatever cols/rows the remote reports in each
 * `remote:screen`, and the surrounding box scrolls when that grid is larger
 * than the space it has.
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
  refreshToken
}: RemoteTerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Read through refs so a re-render never tears the terminal down.
  const propsRef = useRef({ fontSize, fontFamily, focused, onFocus })
  propsRef.current = { fontSize, fontFamily, focused, onFocus }

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
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

    const offScreen = window.api.onRemoteScreen((screen) => {
      if (screen.hostId !== hostId || screen.paneId !== paneId) return
      paintScreen(term, screen.data, screen.cols, screen.rows)
    })
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

  // The caret says which pane the keyboard is pointed at, without a remount.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = termTheme(focused)
  }, [focused])

  // Typography follows the settings; the grid stays at the remote's cols/rows.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.fontFamily = fontStack(fontFamily)
    term.options.lineHeight = rowLineHeight(fontSize, fontFamily)
  }, [fontSize, fontFamily])

  return (
    <div className="ada-remote-term">
      <div className="ada-remote-term-inner" ref={containerRef} />
    </div>
  )
}
