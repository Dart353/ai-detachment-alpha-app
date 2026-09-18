/**
 * A `viewer` pane: a read-only look at one file, in the same frame every other
 * pane wears.
 *
 * It owns no process — it reads its own bytes through `window.api.readFile` and
 * renders by kind: text in a monospace scroll view with a line-number gutter,
 * markdown with a Preview/Source toggle (the preview chunk is lazy so
 * react-markdown and highlight.js stay out of the initial bundle), images
 * centred, and anything binary, oversized or unreadable as a quiet notice with a
 * way to open the containing folder. The file's directory is watched, so an edit
 * made by an agent in a neighbouring pane reloads the view in place.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { Code, Eye, FolderOpen } from 'lucide-react'
import type { FileReadResult } from '../../../shared/types'
import { useApp } from '../store/app'
import { baseName } from '../lib/ids'
import { PaneHeader, type MenuAnchor } from './PaneHeader'
import { paneColorVars } from './paneColor'
import { PANE_DND_TYPE } from './TerminalPane'
import { revealLabel } from './paneMenu'
import { Button } from './ui'
import './TerminalPane.css'
import './ViewerPane.css'

// Code-split: the markdown chunk (react-markdown + highlight.js) is only fetched
// once a markdown file is actually opened.
const MarkdownPreview = lazy(() => import('./MarkdownPreview'))

/** Extensions that get the rendered-preview treatment (case-insensitive). */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])

/** How many lines the text view draws before it stops and says so. */
const MAX_LINES = 5000

/** A burst of writes (a formatter, a git checkout) is one reload, not twenty. */
const RELOAD_DEBOUNCE_MS = 150

export interface ViewerPaneProps {
  workspaceId: string
  paneId: string
  /** Raised for a right-click anywhere in the pane and for the header's ⋯. */
  onContextMenu?: (anchor: ReactMouseEvent | MenuAnchor) => void
  onHeaderDragStart?: (event: ReactDragEvent) => void
  onHeaderDragEnd?: () => void
}

/** True when the file's name carries a markdown extension. */
function isMarkdown(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && MARKDOWN_EXTS.has(name.slice(dot + 1).toLowerCase())
}

/** Containing directory of a stored-form path, tolerant of both separators. */
function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : path
}

/** Human-readable byte size for the "too large" notice. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let size = bytes / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(1)} ${units[unit]}`
}

/** What a non-renderable read says, in one sentence. */
function notice(result: FileReadResult): string {
  if (result.kind === 'toolarge') {
    return `This file is ${formatSize(result.size)}, too large to preview here.`
  }
  if (result.kind === 'binary') return 'This looks like a binary file, so there is nothing to show.'
  if (result.kind === 'error') {
    return `This file could not be read.${result.message ? ` (${result.message})` : ''}`
  }
  return ''
}

/** The text body: a line-number gutter beside the file, both on one baseline. */
function TextView({ content }: { content: string }): JSX.Element {
  const lines = content.split('\n')
  const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines
  return (
    <div className="ada-viewer-text">
      <div className="ada-viewer-lines">
        <div className="ada-viewer-gutter" aria-hidden>
          {shown.map((_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
        <pre className="ada-viewer-code">{shown.join('\n')}</pre>
      </div>
      {lines.length > shown.length && (
        <div className="ada-viewer-cap">
          Showing the first {MAX_LINES.toLocaleString()} of {lines.length.toLocaleString()} lines.
        </div>
      )}
    </div>
  )
}

export function ViewerPane({
  workspaceId,
  paneId,
  onContextMenu,
  onHeaderDragStart,
  onHeaderDragEnd
}: ViewerPaneProps): JSX.Element | null {
  const workspace = useApp((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  )
  const focusPane = useApp((state) => state.focusPane)
  const renamePane = useApp((state) => state.renamePane)
  const closePane = useApp((state) => state.closePane)
  const toggleMaximize = useApp((state) => state.toggleMaximize)

  const pane = workspace?.panes.find((candidate) => candidate.id === paneId)
  const filePath = pane?.filePath ?? ''

  const [result, setResult] = useState<FileReadResult | null>(null)
  /** Markdown opens rendered; the toggle flips to the raw source. */
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  /** The scroll box, so a reload can put the reader back where they were. */
  const scrollRef = useRef<HTMLDivElement>(null)

  const read = useCallback(
    (keepScroll: boolean): void => {
      if (!filePath) return
      const scrollTop = keepScroll ? scrollRef.current?.scrollTop ?? 0 : 0
      void window.api.readFile(filePath).then((next) => {
        setResult(next)
        // Restored after the browser has laid the new content out. A reload is
        // usually the same file a few bytes different, so the old offset still
        // means roughly what the reader meant by it.
        requestAnimationFrame(() => {
          const box = scrollRef.current
          if (box) box.scrollTop = scrollTop
        })
      })
    },
    [filePath]
  )

  // First read (and again if the pane is ever re-pointed at another file).
  useEffect(() => {
    setResult(null)
    setMode('preview')
    read(false)
  }, [read])

  // Watch the containing directory, so an edit from a terminal pane, an agent or
  // another editor lands here. Debounced: one save often arrives as several writes.
  useEffect(() => {
    if (!filePath) return
    const dir = dirOf(filePath)
    const subscriberId = `viewer:${paneId}`
    window.api.watchDir(subscriberId, dir)
    let timer: number | undefined
    const unsubscribe = window.api.onFsChanged((changed) => {
      if (changed !== dir) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => read(true), RELOAD_DEBOUNCE_MS)
    })
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
      window.api.unwatchDir(subscriberId, dir)
    }
  }, [filePath, paneId, read])

  if (!pane) return null

  const focused = workspace?.focusedPaneId === paneId
  const maximized = workspace?.maximizedPaneId === paneId
  const name = baseName(filePath) || pane.name
  const showToggle = isMarkdown(name) && result?.kind === 'text'

  const classes = ['ada-pane']
  if (focused) classes.push('is-focused')
  if (pane.color) classes.push('has-color')

  const reveal = (): void => void window.api.revealPath(filePath)

  const renderBody = (): JSX.Element => {
    if (!filePath) return <div className="ada-viewer-quiet">This pane has no file.</div>
    if (result === null) return <div className="ada-viewer-quiet">Reading…</div>
    if (result.kind === 'text') {
      if (isMarkdown(name) && mode === 'preview') {
        return (
          <Suspense fallback={<div className="ada-viewer-quiet">Rendering…</div>}>
            <MarkdownPreview content={result.content} filePath={filePath} />
          </Suspense>
        )
      }
      return <TextView content={result.content} />
    }
    if (result.kind === 'image') {
      // `dataUrl` carries an `ada-file://` URL, which streams the bytes off disk
      // rather than copying them through IPC.
      return (
        <div className="ada-viewer-image">
          <img src={result.dataUrl} alt={name} />
        </div>
      )
    }
    return (
      <div className="ada-viewer-notice">
        <p className="ada-viewer-notice-msg">{notice(result)}</p>
        <Button icon={<FolderOpen size={13} strokeWidth={1.5} />} onClick={reveal}>
          {revealLabel(window.api.platform)}
        </Button>
      </div>
    )
  }

  return (
    <div
      className={classes.join(' ')}
      style={paneColorVars(pane.color)}
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
        status="idle"
        focused={focused}
        maximized={maximized}
        onRename={(next) => renamePane(paneId, next)}
        onMenu={(anchor) => onContextMenu?.(anchor)}
        onToggleMaximize={() => toggleMaximize(paneId)}
        onClose={() => closePane(paneId)}
        draggable
        onDragStart={(event) => {
          // the same payload a terminal pane carries, so the grid's drop logic
          // does not have to care which kind of pane is in flight
          event.dataTransfer.setData(PANE_DND_TYPE, paneId)
          event.dataTransfer.effectAllowed = 'move'
          onHeaderDragStart?.(event)
        }}
        onDragEnd={onHeaderDragEnd}
      />
      {pane.color && (
        <span className="ada-pane-seam" style={{ background: pane.color }} aria-hidden />
      )}
      <div className="ada-pane-body ada-viewer-body">
        {showToggle && (
          <button
            className="ada-viewer-toggle"
            title={mode === 'preview' ? 'View source' : 'View rendered preview'}
            aria-label={mode === 'preview' ? 'View source' : 'View rendered preview'}
            onClick={() => setMode((current) => (current === 'preview' ? 'source' : 'preview'))}
          >
            {mode === 'preview' ? (
              <Code size={13} strokeWidth={1.5} />
            ) : (
              <Eye size={13} strokeWidth={1.5} />
            )}
          </button>
        )}
        <div className="ada-viewer-scroll" ref={scrollRef}>
          {renderBody()}
        </div>
      </div>
    </div>
  )
}

export default ViewerPane
