import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Folder,
  ListChecks,
  ListTodo,
  Pencil,
  PictureInPicture2,
  Pin,
  Plus,
  Send,
  Trash2,
  Unlink,
  X
} from 'lucide-react'
import type { TodoItem } from '../../../../shared/types'
import {
  agentChip,
  matchesWorkspace,
  splitLines,
  workspaceFilterNames
} from '../../lib/todos'
import { previewTag, useTodos } from '../../store/todos'
import { ContextMenu, Select, type MenuItem } from '../ui'
import { ICON, TodoRow } from './TodoRow'
import { TodoSend } from './TodoSend'
import './TodoBoard.css'

export type TodoBoardMode = 'docked' | 'window'

type Filter = 'open' | 'done' | 'all'

/** A todo checked off from the Open list stays put this long, so a mis-click can be undone in place. */
const LINGER_MS = 1500

/** The filter Select's value for "every workspace". */
const ALL_WORKSPACES = ''

/** Newest-finished first; the order a "what did I get done" glance wants. */
function byDoneAt(a: TodoItem, b: TodoItem): number {
  return (b.doneAt ?? 0) - (a.doneAt ?? 0)
}

/**
 * The todo board: a quick-add line, the list, and the chrome for wherever it is
 * showing — a panel docked over the main window's grid, or its own small
 * always-on-top window that can roll up to its header.
 */
export function TodoBoard({ mode }: { mode: TodoBoardMode }): JSX.Element {
  const items = useTodos((state) => state.items)
  const targets = useTodos((state) => state.targets)
  const board = useTodos((state) => state.board)
  const setBoard = useTodos((state) => state.setBoard)
  const add = useTodos((state) => state.add)
  const addLines = useTodos((state) => state.addLines)
  const clearDone = useTodos((state) => state.clearDone)

  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState<Filter>('open')
  const [workspaceFilter, setWorkspaceFilter] = useState(ALL_WORKSPACES)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [sending, setSending] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [lingering, setLingering] = useState<Set<string>>(() => new Set())
  const lingerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const inputRef = useRef<HTMLInputElement>(null)
  const previousDone = useRef(new Map(items.map((item) => [item.id, item.done])))

  const collapsed = mode === 'window' && board.collapsed

  // Whatever just turned done lingers on the Open list for a moment.
  useEffect(() => {
    const before = previousDone.current
    for (const item of items) {
      if (item.done && before.get(item.id) === false) {
        const timers = lingerTimers.current
        clearTimeout(timers.get(item.id))
        setLingering((current) => new Set(current).add(item.id))
        timers.set(
          item.id,
          setTimeout(() => {
            timers.delete(item.id)
            setLingering((current) => {
              const next = new Set(current)
              next.delete(item.id)
              return next
            })
          }, LINGER_MS)
        )
      }
    }
    previousDone.current = new Map(items.map((item) => [item.id, item.done]))
  }, [items])

  useEffect(() => {
    const timers = lingerTimers.current
    return () => timers.forEach((timer) => clearTimeout(timer))
  }, [])

  // The board opens ready to type into.
  useEffect(() => {
    if (!collapsed) inputRef.current?.focus()
  }, [collapsed])

  const scoped = useMemo(
    () => items.filter((item) => matchesWorkspace(item, workspaceFilter || null)),
    [items, workspaceFilter]
  )
  const open = scoped.filter((item) => !item.done || lingering.has(item.id))
  const done = scoped.filter((item) => item.done).sort(byDoneAt)
  const openCount = items.filter((item) => !item.done).length
  const withAgents = items.filter((item) => !item.done && item.agent).length
  const workspaceNames = workspaceFilterNames(items, targets)
  const tag = previewTag(draft)

  const sections: { label: string | null; items: TodoItem[] }[] =
    filter === 'open'
      ? [{ label: null, items: open }]
      : filter === 'done'
        ? [{ label: null, items: done }]
        : [
            { label: 'Open', items: scoped.filter((item) => !item.done) },
            { label: 'Done', items: done }
          ]
  const visibleCount = sections.reduce((sum, section) => sum + section.items.length, 0)

  const toggleExpanded = (id: string): void =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onAddKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const checklist = event.shiftKey
      const id = add(draft, checklist)
      if (!id) return
      setDraft('')
      if (checklist) setExpanded((current) => new Set(current).add(id))
      if (filter === 'done') setFilter('open')
    } else if (event.key === 'Escape') {
      setDraft('')
    }
  }

  // A pasted list becomes one todo per line, each tagged like the line it was
  // pasted into ("@relay " then paste tags them all).
  const onAddPaste = (event: ReactClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text')
    if (!/\r?\n/.test(text.trim())) return
    event.preventDefault()
    addLines(splitLines(text), previewTag(draft))
    setDraft('')
  }

  const menuItems = (id: string): MenuItem[] => {
    const item = items.find((candidate) => candidate.id === id)
    if (!item) return []
    const store = useTodos.getState()
    const tagItems: MenuItem[] = workspaceNames.map((name) => ({
      label: name,
      hint: item.workspace?.toLowerCase() === name.toLowerCase() ? '✓' : undefined,
      onClick: () => store.setWorkspace(id, name)
    }))
    if (item.workspace) {
      tagItems.push({ label: 'No workspace', divider: true, onClick: () => store.setWorkspace(id, undefined) })
    }
    const result: MenuItem[] = [
      {
        label: 'Send to agent…',
        icon: <Send size={12} />,
        onClick: () => {
          const row = document.querySelector<HTMLElement>(`[data-todo-id="${id}"] .ada-todo-actions`)
          if (row) setSending({ id, anchor: row })
        }
      },
      { label: 'Edit', icon: <Pencil size={12} />, onClick: () => setEditing(id) }
    ]
    if (!item.items) {
      result.push({
        label: 'Convert to checklist',
        icon: <ListChecks size={12} />,
        onClick: () => {
          store.makeChecklist(id)
          setExpanded((current) => new Set(current).add(id))
        }
      })
    }
    result.push({
      label: 'Tag workspace',
      icon: <Folder size={12} />,
      submenu: tagItems.length > 0 ? tagItems : [{ label: 'No workspaces yet', disabled: true }]
    })
    if (item.agent) {
      result.push({ label: 'Unlink agent', icon: <Unlink size={12} />, onClick: () => store.setAgent(id, undefined) })
    }
    result.push({ label: 'Delete', icon: <Trash2 size={12} />, divider: true, onClick: () => store.remove(id) })
    return result
  }

  const onRowMenu = (id: string) => (event: ReactMouseEvent): void => {
    if ((event.target as HTMLElement).closest('input, textarea')) return
    event.preventDefault()
    setMenu({ id, x: event.clientX, y: event.clientY })
  }

  const attention = items.some((item) => !item.done && agentChip(item, targets) === 'attention')
  const nextUp = items.find((item) => !item.done)

  const header = (
    <div
      className={`ada-todo-head${mode === 'window' ? ' ada-todo-head--drag' : ''}`}
      onDoubleClick={(event) => {
        if (mode !== 'window' || (event.target as HTMLElement).closest('button')) return
        setBoard({ collapsed: !board.collapsed })
      }}
    >
      <ListTodo size={14} className="ada-todo-head-icon" aria-hidden="true" />
      {collapsed ? (
        <>
          <span className="ada-todo-head-count">{openCount}</span>
          <span className="ada-todo-head-next">{nextUp?.title ?? 'All clear'}</span>
          {attention && <span className="ada-todo-head-alert" title="An agent is waiting on you" />}
        </>
      ) : (
        <>
          <span className="ada-todo-head-title">Todo board</span>
          <span className="ada-todo-head-count">{openCount} open</span>
          <span className="ada-todo-head-spacer" />
        </>
      )}
      {mode === 'window' && !collapsed && (
        <>
          <button
            type="button"
            className={`ada-todo-icon${board.alwaysOnTop ? ' ada-todo-icon--on' : ''}`}
            aria-pressed={board.alwaysOnTop}
            aria-label="Keep on top"
            title="Keep on top"
            onClick={() => setBoard({ alwaysOnTop: !board.alwaysOnTop })}
          >
            <Pin size={ICON} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ada-todo-icon"
            aria-label="Dock back into the app"
            title="Dock back into the app"
            onClick={() => setBoard({ poppedOut: false, docked: true })}
          >
            <PictureInPicture2 size={ICON} aria-hidden="true" />
          </button>
        </>
      )}
      {mode === 'window' && (
        <button
          type="button"
          className="ada-todo-icon"
          aria-label={collapsed ? 'Expand' : 'Roll up'}
          title={collapsed ? 'Expand' : 'Roll up (or double-click the header)'}
          onClick={() => setBoard({ collapsed: !collapsed })}
        >
          {collapsed ? <ChevronDown size={ICON} aria-hidden="true" /> : <ChevronUp size={ICON} aria-hidden="true" />}
        </button>
      )}
      {mode === 'docked' && (
        <button
          type="button"
          className="ada-todo-icon"
          aria-label="Pop out into its own window"
          title="Pop out into its own window"
          onClick={() => setBoard({ poppedOut: true })}
        >
          <ExternalLink size={ICON} aria-hidden="true" />
        </button>
      )}
      {!collapsed && (
        <button
          type="button"
          className="ada-todo-icon"
          aria-label="Close"
          title="Close"
          onClick={() => setBoard(mode === 'window' ? { poppedOut: false } : { docked: false })}
        >
          <X size={ICON} aria-hidden="true" />
        </button>
      )}
    </div>
  )

  if (collapsed) {
    return <div className={`ada-todo ada-todo--${mode} ada-todo--collapsed`}>{header}</div>
  }

  const sendingItem = sending ? items.find((item) => item.id === sending.id) : undefined

  return (
    <div className={`ada-todo ada-todo--${mode}`}>
      {header}

      <div className="ada-todo-top">
        <label className="ada-todo-add">
          <Plus size={ICON} aria-hidden="true" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onAddKey}
            onPaste={onAddPaste}
            placeholder="Add a task…  @workspace to tag"
            aria-label="Add a task. Enter adds, Shift+Enter adds a checklist."
          />
          {tag ? <span className="ada-todo-add-tag">@{tag}</span> : <span className="ada-todo-add-hint">↵</span>}
        </label>
        <div className="ada-todo-filters">
          <div className="ada-todo-tabs" role="tablist" aria-label="Show">
            {(
              [
                ['open', 'Open', scoped.filter((item) => !item.done).length],
                ['done', 'Done', done.length],
                ['all', 'All', scoped.length]
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={`ada-todo-tab${filter === key ? ' ada-todo-tab--on' : ''}`}
                onClick={() => setFilter(key)}
              >
                {label} <span className="ada-todo-tab-count">{count}</span>
              </button>
            ))}
          </div>
          <Select
            className="ada-todo-scope"
            size="sm"
            value={workspaceFilter}
            options={[
              { value: ALL_WORKSPACES, label: 'All workspaces' },
              ...workspaceNames.map((name) => ({ value: name, label: name }))
            ]}
            onChange={setWorkspaceFilter}
            ariaLabel="Workspace filter"
          />
        </div>
      </div>

      <div className="ada-todo-list">
        {visibleCount === 0 && (
          <div className="ada-todo-empty">
            <span className="ada-todo-empty-title">
              {filter === 'done' ? 'Nothing checked off yet' : 'All clear'}
            </span>
            <span className="ada-todo-empty-hint">
              Type above and press Enter. Shift+Enter starts a checklist.
            </span>
          </div>
        )}
        {sections.map((section) =>
          section.items.length === 0 ? null : (
            <div key={section.label ?? 'list'} className="ada-todo-section">
              {section.label && <div className="ada-todo-cap ada-todo-section-label">{section.label}</div>}
              {section.items.map((item) => (
                <div key={item.id} data-todo-id={item.id}>
                  <TodoRow
                    item={item}
                    targets={targets}
                    expanded={expanded.has(item.id)}
                    onToggleExpanded={() => toggleExpanded(item.id)}
                    onSend={(anchor) => setSending({ id: item.id, anchor })}
                    onContextMenu={onRowMenu(item.id)}
                    editing={editing === item.id}
                    onEditingChange={(on) => setEditing(on ? item.id : null)}
                  />
                </div>
              ))}
            </div>
          )
        )}
      </div>

      <div className="ada-todo-foot">
        <span>
          <span className="ada-todo-mono">{items.length - openCount}</span> done ·{' '}
          <span className="ada-todo-mono">{withAgents}</span> with agents
        </span>
        <button type="button" className="ada-todo-link" onClick={clearDone} disabled={openCount === items.length}>
          Clear done
        </button>
      </div>

      {sending && sendingItem && (
        <TodoSend
          item={sendingItem}
          targets={targets}
          anchor={sending.anchor}
          onClose={() => setSending(null)}
        />
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

export default TodoBoard
