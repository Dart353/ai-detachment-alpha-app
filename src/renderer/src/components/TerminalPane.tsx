/**
 * One live pane: the header, the xterm body, and the PTY behind it.
 *
 * MOUNTING CONTRACT — the caller must key this component with
 * `useRuntime.getState().remountKey[paneId]`. A remount is the ONLY way to
 * restart a pane's process (Start fresh, switch account), and everything else —
 * a rename, a status tick, a resize — must be a plain re-render: the spawn runs
 * exactly once per mount and the unmount kills the PTY, so an accidental key
 * change costs the operator their session.
 *
 * Nothing here reparents the terminal container. xterm measures and paints into
 * the node it was opened on; moving that node in the DOM throws the renderer's
 * measurements away and blanks the pane.
 */
import {
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { Terminal } from '@xterm/xterm'
import { DEFAULT_ACCOUNT_ID, type Pane, type SpawnOpts } from '../../../shared/types'
import { useApp } from '../store/app'
import {
  registerFocusFn,
  registerPromptProbe,
  registerSelectionFn,
  useRuntime,
  type RuntimeState
} from '../store/runtime'
import { BLOCKING_PROMPT_MARKERS } from '../lib/status'
import { buildLaunchCommand } from '../lib/launch'
import { shellQuote } from '../lib/shellQuote'
import { useTerminalPane } from '../hooks/useTerminalPane'
import { PaneHeader, type MenuAnchor } from './PaneHeader'
import { Button, Modal } from './ui'
import './TerminalPane.css'

/**
 * The dataTransfer MIME a pane being dragged by its header carries. A custom
 * type so it never collides with file drops (which carry 'Files') or with a path
 * dragged out of the explorer (which carries 'text/plain').
 */
export const PANE_DND_TYPE = 'application/x-ada-pane'

/** How many visible rows the blocking-prompt probe reads. */
const PROMPT_PROBE_ROWS = 12

export interface TerminalPaneProps {
  workspaceId: string
  paneId: string
  /** This pane's share of the usage window; the grid does the arithmetic. */
  sharePct?: number | null
  /** Raised for a right-click anywhere in the pane and for the header's ⋯. */
  onContextMenu?: (anchor: ReactMouseEvent | MenuAnchor) => void
  onHeaderDragStart?: (event: ReactDragEvent) => void
  onHeaderDragEnd?: () => void
}

/** Absolute on any host we run on: POSIX, drive-lettered Windows, or UNC. */
function isAbsolutePath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
}

/**
 * Chords the window-level shortcut listener owns. xterm would otherwise encode
 * them and send them down the wire, so the handler declines them (returns false)
 * and lets the keystroke reach the app.
 */
function isAppShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false
  const key = event.key.toLowerCase()
  if (!event.shiftKey) return /^[1-9]$/.test(key) || key === 'b'
  // Shift+[ and Shift+] arrive as { and } on most layouts, so both spellings count.
  return key === 'm' || key === 'l' || key === '[' || key === ']' || key === '{' || key === '}'
}

export function TerminalPane({
  workspaceId,
  paneId,
  sharePct,
  onContextMenu,
  onHeaderDragStart,
  onHeaderDragEnd
}: TerminalPaneProps): JSX.Element | null {
  const workspace = useApp((state) => state.workspaces.find((candidate) => candidate.id === workspaceId))
  const pane = workspace?.panes.find((candidate) => candidate.id === paneId)
  const focused = workspace?.focusedPaneId === paneId
  const maximized = workspace?.maximizedPaneId === paneId
  const settings = useApp((state) => state.settings)
  const focusPane = useApp((state) => state.focusPane)
  const renamePane = useApp((state) => state.renamePane)
  const closePane = useApp((state) => state.closePane)
  const toggleMaximize = useApp((state) => state.toggleMaximize)

  const status = useRuntime((state: RuntimeState) => state.status[paneId]) ?? 'idle'
  const model = useRuntime((state: RuntimeState) => state.sessions[paneId]?.model)
  const accounts = useRuntime((state: RuntimeState) => state.accounts)
  const setExited = useRuntime((state: RuntimeState) => state.setExited)
  const noteActivity = useRuntime((state: RuntimeState) => state.noteActivity)

  const [confirmClose, setConfirmClose] = useState(false)

  // The pane as the mount-time callbacks see it: they run once, long after this
  // render, and must read the current record rather than the one they closed over.
  const paneRef = useRef<Pane | undefined>(pane)
  paneRef.current = pane
  const cliPathRef = useRef<string | undefined>(settings.cliPaths.claude)
  cliPathRef.current = settings.cliPaths.claude
  // The terminal, captured in onTerminal so the exit notice and the drop handlers
  // can reach it without depending on the hook's own ref.
  const terminalRef = useRef<Terminal | null>(null)
  // One spawn per mount, whatever React does with effects in development.
  const spawnedRef = useRef(false)
  const isClaude = pane?.kind === 'claude'

  const { containerRef } = useTerminalPane({
    id: paneId,
    fontSize: settings.termFontSize,
    fontFamily: settings.termFontFamily,
    focused,
    onFocus: () => focusPane(paneId),
    onActivity: (at) => noteActivity(paneId, at),
    onExit: (code) => {
      setExited(paneId, true)
      // A dim notice rather than a cleared pane: the scrollback is still the
      // record of what happened, and the operator may want to read it.
      terminalRef.current?.write(`\r\n\x1b[90m[process exited — code ${code}]\x1b[0m\r\n`)
    },
    onTerminal: (term) => {
      terminalRef.current = term
      const offFocus = registerFocusFn(paneId, () => term.focus())
      // The pane menu's Copy row asks here: xterm's selection lives in the
      // terminal, not in the document, so nothing else can see it.
      const offSelection = registerSelectionFn(paneId, () => term.getSelection())

      // Blocking prompts (permission / trust / plan approval) are drawn on screen
      // but NEVER written to the transcript, so the transcript watcher cannot see
      // them. Report one by scanning the tail of the visible viewport.
      const offProbe = isClaude
        ? registerPromptProbe(paneId, () => {
            const buffer = term.buffer.active
            const from = Math.max(buffer.viewportY, buffer.viewportY + term.rows - PROMPT_PROBE_ROWS)
            const rows: string[] = []
            for (let row = from; row < buffer.viewportY + term.rows; row++) {
              const line = buffer.getLine(row)
              if (line) rows.push(line.translateToString(true))
            }
            return BLOCKING_PROMPT_MARKERS.test(rows.join('\n'))
          })
        : null

      term.attachCustomKeyEventHandler((event) => {
        // App chords belong to the window listener, not to the shell.
        if (isAppShortcut(event)) return false
        const mod = event.ctrlKey || event.metaKey
        const copyChord = (mod && event.shiftKey && event.key.toLowerCase() === 'c') ||
          (event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'c')
        if (copyChord) {
          const selection = term.getSelection()
          // With nothing selected, Ctrl+C is still the interrupt the shell expects.
          if (!selection) return true
          if (event.type === 'keydown') window.api.copyText(selection)
          return false
        }
        if (mod && event.shiftKey && event.key.toLowerCase() === 'v') {
          if (event.type === 'keydown') {
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (text) window.api.writePty(paneId, text)
              })
              .catch(() => {})
          }
          return false
        }
        // Shift+Enter should insert a line break, not submit. xterm has no encoding
        // for it (the shift is dropped and a bare \r goes down the wire, identical
        // to Enter), so intercept the keystroke and send ESC+CR, the meta-Enter
        // sequence Claude Code reads as "insert newline". Claude panes only: in a
        // plain shell or a full-screen TUI (vim, less) the stray ESC would leak.
        if (isClaude && event.key === 'Enter' && event.shiftKey && !mod && !event.altKey) {
          // the handler fires for keydown/keypress/keyup; write once, swallow all three
          if (event.type === 'keydown') window.api.writePty(paneId, '\x1b\r')
          return false
        }
        return true
      })

      return () => {
        offFocus()
        offSelection()
        offProbe?.()
        window.api.unregisterSession(paneId)
        terminalRef.current = null
      }
    },
    spawn: async (term) => {
      const current = paneRef.current
      if (!current || spawnedRef.current) return false
      spawnedRef.current = true
      const spawnedAt = Date.now()

      // Resume a prior chat only when its transcript still exists on disk — a
      // `--resume` against a transcript the user (or a different account) no longer
      // has makes the CLI exit instead of starting.
      const hasTranscript =
        current.kind === 'claude' && current.sessionId
          ? await window.api.transcriptExists(current.cwd, current.sessionId, current.accountId)
          : false
      const command = buildLaunchCommand(current, {
        hasTranscript,
        ...(cliPathRef.current === undefined ? {} : { cliPath: cliPathRef.current })
      })

      const opts: SpawnOpts = { id: paneId, kind: current.kind, cols: term.cols, rows: term.rows }
      // An ssh pane runs `ssh <host>` from the user's home: the workspace root is a
      // local path and means nothing on the far side of the connection.
      if (current.kind !== 'ssh') opts.cwd = current.cwd
      if (command !== undefined) opts.command = command
      if (current.accountId !== undefined) opts.accountId = current.accountId

      try {
        await window.api.spawnPty(opts)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        term.write(`\r\n\x1b[90m[${current.name} could not start: ${message}]\x1b[0m\r\n`)
        setExited(paneId, true)
        return false
      }

      // Watch the transcript, binding straight to the resumed session when there is
      // one so the watcher does not have to guess which file this pane claimed.
      if (current.kind === 'claude') {
        window.api.registerSession({
          id: paneId,
          cwd: current.cwd,
          spawnedAt,
          ...(hasTranscript && current.sessionId ? { sessionId: current.sessionId } : {}),
          ...(current.accountId === undefined ? {} : { accountId: current.accountId })
        })
      }
      return true
    }
  })

  if (!pane) return null

  const account = accounts.find(
    (candidate) => candidate.id === (pane.accountId ?? DEFAULT_ACCOUNT_ID)
  )

  /** A pane drag belongs to the grid; anything else may land in the terminal. */
  const acceptsDrop = (event: ReactDragEvent): boolean => {
    const types = Array.from(event.dataTransfer.types)
    if (types.includes(PANE_DND_TYPE)) return false
    return types.includes('Files') || types.includes('text/plain')
  }

  const onTermDragOver = (event: ReactDragEvent): void => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  // A dropped file (or a row dragged out of the explorer) writes its shell-quoted
  // absolute path into the terminal with a trailing space and NO submit, so the
  // operator can weave it into whatever command they are composing. Electron
  // strips File.path in a sandboxed renderer, so the preload resolves each handle.
  const onTermDrop = (event: ReactDragEvent): void => {
    if (!acceptsDrop(event)) return
    const dropped = Array.from(event.dataTransfer.files)
      .map((file) => window.api.getDroppedFilePath(file))
      .filter((path) => path.length > 0)
    const text = event.dataTransfer.getData('text/plain')
    const paths = dropped.length > 0 ? dropped : isAbsolutePath(text) ? [text] : []
    if (paths.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    window.api.writePty(paneId, paths.map(shellQuote).join(' ') + ' ')
    terminalRef.current?.focus()
  }

  const requestClose = (): void => {
    if (status === 'working') setConfirmClose(true)
    else closePane(paneId)
  }

  const classes = ['ada-pane']
  if (focused) classes.push('is-focused')

  return (
    <div
      className={classes.join(' ')}
      data-pane-id={paneId}
      onPointerDown={() => focusPane(paneId)}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu?.(event)
      }}
    >
      <PaneHeader
        paneId={paneId}
        name={pane.name}
        kind={pane.kind}
        {...(model ? { modelLabel: model } : {})}
        {...(accounts.length > 1 && account ? { accountLabel: account.label } : {})}
        status={status}
        sharePct={sharePct}
        focused={focused}
        maximized={maximized}
        onRename={(name) => renamePane(paneId, name)}
        onMenu={(anchor) => onContextMenu?.(anchor)}
        onToggleMaximize={() => toggleMaximize(paneId)}
        onClose={requestClose}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(PANE_DND_TYPE, paneId)
          event.dataTransfer.effectAllowed = 'move'
          onHeaderDragStart?.(event)
        }}
        onDragEnd={onHeaderDragEnd}
      />
      {/* the operator's chosen colour, as a hairline seam under the bar */}
      {pane.color && (
        <span className="ada-pane-seam" style={{ background: pane.color }} aria-hidden />
      )}
      <div
        className="ada-pane-body"
        ref={containerRef}
        onDragOver={onTermDragOver}
        onDrop={onTermDrop}
      />
      <Modal
        open={confirmClose}
        title="Close pane"
        onClose={() => setConfirmClose(false)}
        width={380}
        footer={
          <>
            <Button onClick={() => setConfirmClose(false)}>Keep it open</Button>
            <Button
              variant="primary"
              danger
              onClick={() => {
                setConfirmClose(false)
                closePane(paneId)
              }}
            >
              Close pane
            </Button>
          </>
        }
      >
        Close {pane.name}? It is still working.
      </Modal>
    </div>
  )
}

export default TerminalPane
