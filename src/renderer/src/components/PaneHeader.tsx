/**
 * The 32px bar on top of every pane (design 2a "Pane headers", 4a).
 *
 * Purely presentational: it reports gestures and renders what it is handed. The
 * pane owns the terminal, the store and the menu; this owns the inline rename
 * and nothing else.
 */
import { useEffect, useRef, useState, type DragEvent, type JSX, type MouseEvent } from 'react'
import { Maximize2, Minimize2, MoreHorizontal, X } from 'lucide-react'
import type { PaneKind, PaneStatus } from '../../../shared/types'
import { STATUS_LABEL } from '../lib/status'
import { TextInput } from './ui'
import './PaneHeader.css'

/** Where a menu should open: a right-click, or the ⋯ button's own corner. */
export interface MenuAnchor {
  clientX: number
  clientY: number
}

export interface PaneHeaderProps {
  paneId: string
  name: string
  kind: PaneKind
  /** The model the transcript last reported, when one is known. */
  modelLabel?: string
  /** Only set in a multi-account household — a single account is not news. */
  accountLabel?: string
  status: PaneStatus
  /** This pane's share of the current usage window, if it can be attributed. */
  sharePct?: number | null
  focused: boolean
  maximized: boolean
  onRename: (name: string) => void
  onMenu: (anchor: MenuAnchor) => void
  onToggleMaximize: () => void
  onClose: () => void
  /** The header is the pane's drag handle; the grid supplies the payload. */
  draggable?: boolean
  onDragStart?: (event: DragEvent) => void
  onDragEnd?: () => void
}

/** What a pane runs, for the panes whose transcript reports no model. */
const KIND_LABEL: Record<PaneKind, string> = {
  claude: 'claude',
  terminal: 'shell',
  ssh: 'ssh',
  viewer: 'file'
}

/**
 * The model as the header says it: `claude-opus-4-6-20260115` → `opus 4.6`.
 * Leaves anything it does not recognise alone, and is idempotent, so a label
 * that was already shortened survives a second pass.
 */
export function shortModel(model: string): string {
  const match = /(opus|sonnet|haiku)[-_ ]?(\d+)[-_. ](\d+)/i.exec(model)
  if (!match) return model
  return `${match[1].toLowerCase()} ${match[2]}.${match[3]}`
}

export function PaneHeader({
  paneId,
  name,
  kind,
  modelLabel,
  accountLabel,
  status,
  sharePct,
  focused,
  maximized,
  onRename,
  onMenu,
  onToggleMaximize,
  onClose,
  draggable,
  onDragStart,
  onDragEnd
}: PaneHeaderProps): JSX.Element {
  // null = not renaming; a string is the draft
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const renaming = draft !== null

  // Focus + select the field the moment the editor opens. Depends on the
  // open/closed boolean, NOT on the draft — otherwise every keystroke would
  // re-select the whole field and the next letter would overwrite it.
  useEffect(() => {
    if (!renaming) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [renaming])

  const commit = (value: string): void => {
    onRename(value)
    setDraft(null)
  }

  const classes = ['ada-pane-header']
  if (focused) classes.push('is-focused')

  return (
    <div
      className={classes.join(' ')}
      data-pane-header={paneId}
      // renaming disables the drag so the name field keeps normal text selection
      draggable={draggable === true && !renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault()
        onMenu({ clientX: event.clientX, clientY: event.clientY })
      }}
      // a double-click on empty header space is the house gesture for maximize;
      // the name swallows its own so renaming stays reachable
      onDoubleClick={onToggleMaximize}
    >
      <span className={`ada-pane-dot ada-pane-dot-${status}`} title={STATUS_LABEL[status]} />
      {renaming ? (
        <TextInput
          ref={inputRef}
          className="ada-pane-rename"
          size="sm"
          value={draft}
          maxLength={40}
          onChange={setDraft}
          onEnter={commit}
          onEscape={() => setDraft(null)}
          onBlur={(event) => commit(event.currentTarget.value)}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ) : (
        <span
          className="ada-pane-name"
          title="Double-click to rename"
          onDoubleClick={(event) => {
            event.stopPropagation()
            setDraft(name)
          }}
        >
          {name}
        </span>
      )}
      <span className="ada-pane-kind">
        {modelLabel ? shortModel(modelLabel) : KIND_LABEL[kind]}
      </span>
      {accountLabel && (
        <span className="ada-pane-account" title={`Claude account: ${accountLabel}`}>
          {accountLabel}
        </span>
      )}
      <span className="ada-pane-spacer" />
      {sharePct != null && (
        <span className="ada-pane-share" title="Share of the current usage window">
          {sharePct}% of window
        </span>
      )}
      <span className={`ada-pane-status ada-pane-status-${status}`}>{STATUS_LABEL[status]}</span>
      <span className="ada-pane-actions">
        <button
          className="ada-pane-action"
          title="Pane menu"
          aria-label="Pane menu"
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            onMenu({ clientX: rect.left, clientY: rect.bottom + 4 })
          }}
        >
          <MoreHorizontal size={13} />
        </button>
        <button
          className="ada-pane-action"
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={(event) => {
            event.stopPropagation()
            onToggleMaximize()
          }}
        >
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          className="ada-pane-action"
          title="Close pane"
          aria-label="Close pane"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <X size={13} />
        </button>
      </span>
    </div>
  )
}

export default PaneHeader
