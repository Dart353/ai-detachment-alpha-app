import {
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { Check, ChevronRight, Folder, Send, X } from 'lucide-react'
import type { TodoItem, TodoTargets } from '../../../../shared/types'
import { AGENT_CHIP_LABEL, agentChip, findTargetPane, progress } from '../../lib/todos'
import { useTodos } from '../../store/todos'

/** Icon size for every glyph on the board (design: 12–14px, muted grey). */
export const ICON = 13

export interface TodoRowProps {
  item: TodoItem
  targets: TodoTargets
  expanded: boolean
  onToggleExpanded: () => void
  /** Open the send popover anchored to this element. */
  onSend: (anchor: HTMLElement) => void
  onContextMenu: (event: ReactMouseEvent) => void
  /** The title is being edited in place (F2 or the menu's Edit). */
  editing: boolean
  onEditingChange: (editing: boolean) => void
}

/** A text field that saves on Enter or blur and gives up on Escape. */
function InlineEdit({
  value,
  className,
  ariaLabel,
  onSave,
  onDone
}: {
  value: string
  className: string
  ariaLabel: string
  onSave: (value: string) => void
  onDone: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const finish = (save: boolean): void => {
    if (save && draft.trim() && draft.trim() !== value) onSave(draft)
    onDone()
  }
  return (
    <input
      className={className}
      value={draft}
      aria-label={ariaLabel}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') finish(true)
        else if (event.key === 'Escape') finish(false)
        event.stopPropagation()
      }}
    />
  )
}

function Checkbox({
  checked,
  small,
  label,
  onToggle
}: {
  checked: boolean
  small?: boolean
  label: string
  onToggle: () => void
}): JSX.Element {
  const classes = ['ada-todo-check']
  if (small) classes.push('ada-todo-check--sm')
  if (checked) classes.push('ada-todo-check--on')
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={classes.join(' ')}
      onClick={onToggle}
    >
      <Check size={small ? 9 : 10} strokeWidth={3.5} aria-hidden="true" />
    </button>
  )
}

/**
 * One todo: its checkbox and title, the chips that say where it belongs and who
 * is on it, the strip that asks for a decision when an agent has news, and — for
 * an open checklist — its lines.
 */
export function TodoRow({
  item,
  targets,
  expanded,
  onToggleExpanded,
  onSend,
  onContextMenu,
  editing,
  onEditingChange
}: TodoRowProps): JSX.Element {
  const toggle = useTodos((state) => state.toggle)
  const rename = useTodos((state) => state.rename)
  const toggleSub = useTodos((state) => state.toggleSub)
  const addSub = useTodos((state) => state.addSub)
  const renameSub = useTodos((state) => state.renameSub)
  const removeSub = useTodos((state) => state.removeSub)
  const remove = useTodos((state) => state.remove)
  const [editingSub, setEditingSub] = useState<string | null>(null)
  const [subDraft, setSubDraft] = useState('')

  const chip = agentChip(item, targets)
  const isList = Array.isArray(item.items)
  const { done: doneCount, total } = progress(item)
  const paneName =
    (item.agent && findTargetPane(targets, item.agent.paneId)?.pane.name) || item.agent?.paneName
  const openPane = (): void => {
    if (item.agent) window.api?.openTodoPane(item.agent.paneId)
  }

  return (
    <div
      className={`ada-todo-row${item.done ? ' ada-todo-row--done' : ''}`}
      onContextMenu={onContextMenu}
    >
      <div className="ada-todo-line">
        <Checkbox
          checked={item.done}
          label={item.done ? `Reopen ${item.title}` : `Check off ${item.title}`}
          onToggle={() => toggle(item.id)}
        />
        <div className="ada-todo-body">
          {editing ? (
            <InlineEdit
              className="ada-todo-edit"
              value={item.title}
              ariaLabel="Edit todo"
              onSave={(title) => rename(item.id, title)}
              onDone={() => onEditingChange(false)}
            />
          ) : (
            <span className="ada-todo-title" onDoubleClick={() => onEditingChange(true)}>
              {item.title}
            </span>
          )}
          {(isList || item.workspace || chip) && (
            <div className="ada-todo-meta">
              {isList && (
                <button
                  type="button"
                  className="ada-todo-progress"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Hide' : 'Show'} checklist, ${doneCount} of ${total} done`}
                  onClick={onToggleExpanded}
                >
                  <ChevronRight
                    size={10}
                    strokeWidth={2.5}
                    className={`ada-todo-chev${expanded ? ' ada-todo-chev--open' : ''}`}
                    aria-hidden="true"
                  />
                  {doneCount}/{total}
                  <span className="ada-todo-bar" aria-hidden="true">
                    <span
                      className="ada-todo-bar-fill"
                      style={{ width: `${total ? Math.round((doneCount / total) * 100) : 0}%` }}
                    />
                  </span>
                </button>
              )}
              {item.workspace && (
                <span className="ada-todo-chip ada-todo-chip--ws">
                  <Folder size={10} aria-hidden="true" />
                  {item.workspace}
                </span>
              )}
              {chip && (
                <button
                  type="button"
                  className={`ada-todo-chip ada-todo-agent ada-todo-agent--${chip}`}
                  title="Open this pane"
                  onClick={openPane}
                  disabled={chip === 'closed'}
                >
                  <span className="ada-todo-agent-dot" aria-hidden="true" />
                  <span>✻ {paneName}</span>
                  {AGENT_CHIP_LABEL[chip] && <span>· {AGENT_CHIP_LABEL[chip]}</span>}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="ada-todo-actions">
          <button
            type="button"
            className="ada-todo-icon"
            aria-label="Send to an agent"
            title="Send to an agent"
            onClick={(event) => onSend(event.currentTarget)}
          >
            <Send size={ICON} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ada-todo-icon"
            aria-label="Delete"
            title="Delete"
            onClick={() => remove(item.id)}
          >
            <X size={ICON} aria-hidden="true" />
          </button>
        </div>
      </div>

      {!item.done && chip === 'finished' && (
        <div className="ada-todo-ask ada-todo-ask--finished">
          <span>Agent finished.</span>
          <button type="button" className="ada-todo-pill ada-todo-pill--done" onClick={() => toggle(item.id)}>
            Check off
          </button>
          <button type="button" className="ada-todo-pill" onClick={openPane}>
            Open pane
          </button>
        </div>
      )}
      {!item.done && chip === 'attention' && (
        <div className="ada-todo-ask ada-todo-ask--attention">
          <span>The agent is waiting on you.</span>
          <button type="button" className="ada-todo-pill ada-todo-pill--warn" onClick={openPane}>
            Open pane
          </button>
        </div>
      )}
      {!item.done && chip === 'closed' && (
        <div className="ada-todo-ask">
          <span>The agent&apos;s pane was closed.</span>
          <button
            type="button"
            className="ada-todo-pill"
            onClick={(event) => onSend(event.currentTarget)}
          >
            Send again…
          </button>
        </div>
      )}

      {isList && expanded && (
        <div className="ada-todo-subs">
          {item.items?.map((sub) => (
            <div key={sub.id} className="ada-todo-sub">
              <Checkbox
                small
                checked={sub.done}
                label={sub.done ? `Reopen ${sub.title}` : `Check off ${sub.title}`}
                onToggle={() => toggleSub(item.id, sub.id)}
              />
              {editingSub === sub.id ? (
                <InlineEdit
                  className="ada-todo-edit ada-todo-edit--sub"
                  value={sub.title}
                  ariaLabel="Edit checklist item"
                  onSave={(title) => renameSub(item.id, sub.id, title)}
                  onDone={() => setEditingSub(null)}
                />
              ) : (
                <span
                  className={`ada-todo-sub-title${sub.done ? ' ada-todo-sub-title--done' : ''}`}
                  onDoubleClick={() => setEditingSub(sub.id)}
                >
                  {sub.title}
                </span>
              )}
              <button
                type="button"
                className="ada-todo-icon ada-todo-sub-remove"
                aria-label={`Remove ${sub.title}`}
                onClick={() => removeSub(item.id, sub.id)}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          ))}
          <input
            className="ada-todo-sub-add"
            placeholder="+ Add item"
            aria-label="Add checklist item"
            value={subDraft}
            onChange={(event) => setSubDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && subDraft.trim()) {
                addSub(item.id, subDraft)
                setSubDraft('')
              } else if (event.key === 'Escape') {
                setSubDraft('')
                event.currentTarget.blur()
              }
            }}
          />
        </div>
      )}
    </div>
  )
}

export default TodoRow
