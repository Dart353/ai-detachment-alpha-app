import { useMemo, useState, type JSX, type RefObject } from 'react'
import type { PaneStatus, TodoItem, TodoTargets } from '../../../../shared/types'
import { STATUS_LABEL } from '../../lib/status'
import { defaultMessage, workspaceForTag } from '../../lib/todos'
import { Button, Popover, Select, Toggle } from '../ui'

export interface TodoSendProps {
  item: TodoItem
  targets: TodoTargets
  anchor: HTMLElement
  onClose: () => void
}

/** The radio value that means "spawn a new Claude pane for it". */
const NEW_PANE = '__new__'

/** What picking a pane in this state will do, in a few words. */
function paneHint(status: PaneStatus): string {
  if (status === 'working') return 'working · queues until its turn ends'
  if (status === 'attention') return 'waiting on you · queues until answered'
  if (status === 'exited') return 'exited'
  return `${STATUS_LABEL[status].toLowerCase()} · ready now`
}

/**
 * Hand a todo to a Claude pane: pick the workspace (the todo's tag when one is
 * open), the pane (or a new one), and what to say. The main window carries it
 * out, so the same popover works from the popped-out board.
 */
export function TodoSend({ item, targets, anchor, onClose }: TodoSendProps): JSX.Element {
  // A stable ref, not a fresh rect per render: the popover re-measures whenever
  // its anchor changes, and a new DOMRect every render would never settle.
  const anchorRef = useMemo<RefObject<HTMLElement>>(() => ({ current: anchor }), [anchor])
  const workspaces = targets.workspaces
  const [workspaceId, setWorkspaceId] = useState<string>(
    () => workspaceForTag(targets, item.workspace) ?? workspaces[0]?.workspaceId ?? ''
  )
  const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId)
  const panes = useMemo(
    () => (workspace?.panes ?? []).filter((pane) => pane.status !== 'exited'),
    [workspace]
  )
  const firstChoice = (): string =>
    (panes.find((pane) => pane.status === 'idle' || pane.status === 'done') ?? panes[0])?.paneId ??
    NEW_PANE
  const [paneChoice, setPaneChoice] = useState<string>(firstChoice)
  const [message, setMessage] = useState(() => defaultMessage(item))
  const [autoComplete, setAutoComplete] = useState(false)
  const [submit, setSubmit] = useState(true)

  // A pane from the previous workspace is no choice in this one.
  const choice =
    paneChoice === NEW_PANE || panes.some((pane) => pane.paneId === paneChoice)
      ? paneChoice
      : firstChoice()

  const canSend = !!workspace && message.trim().length > 0
  const doSend = (): void => {
    if (!canSend) return
    window.api?.sendTodo({
      todoId: item.id,
      workspaceId,
      paneId: choice === NEW_PANE ? null : choice,
      message,
      submit,
      autoComplete
    })
    onClose()
  }

  return (
    <Popover
      open
      anchorRef={anchorRef}
      placement="bottom-end"
      width={320}
      onClose={onClose}
      ariaLabel="Send to an agent"
      className="ada-todo-send"
    >
      <div className="ada-todo-send-head">
        <span className="ada-todo-send-title">Send to an agent</span>
        <span className="ada-todo-send-sub">{item.title}</span>
      </div>

      {workspaces.length === 0 ? (
        <p className="ada-todo-send-empty">Open a workspace in the main window first.</p>
      ) : (
        <>
          <div className="ada-todo-send-field">
            <span className="ada-todo-cap">Workspace</span>
            <Select
              value={workspaceId}
              options={workspaces.map((candidate) => ({
                value: candidate.workspaceId,
                label: candidate.name
              }))}
              onChange={setWorkspaceId}
              size="sm"
              ariaLabel="Workspace"
            />
          </div>

          <div className="ada-todo-send-field" role="radiogroup" aria-label="Agent">
            <span className="ada-todo-cap">Agent</span>
            {panes.map((pane) => (
              <button
                key={pane.paneId}
                type="button"
                role="radio"
                aria-checked={choice === pane.paneId}
                className={`ada-todo-pick${choice === pane.paneId ? ' ada-todo-pick--on' : ''}`}
                onClick={() => setPaneChoice(pane.paneId)}
              >
                <span className="ada-todo-radio" aria-hidden="true" />
                <span className={`ada-todo-pick-dot ada-todo-pick-dot--${pane.status}`} aria-hidden="true" />
                <span className="ada-todo-pick-text">
                  <span className="ada-todo-pick-name">{pane.name}</span>
                  <span
                    className={`ada-todo-pick-hint${pane.status === 'working' || pane.status === 'attention' ? ' ada-todo-pick-hint--warn' : ''}`}
                  >
                    {paneHint(pane.status)}
                  </span>
                </span>
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={choice === NEW_PANE}
              className={`ada-todo-pick${choice === NEW_PANE ? ' ada-todo-pick--on' : ''}`}
              onClick={() => setPaneChoice(NEW_PANE)}
            >
              <span className="ada-todo-radio" aria-hidden="true" />
              <span className="ada-todo-pick-glyph" aria-hidden="true">
                ✻
              </span>
              <span className="ada-todo-pick-text">
                <span className="ada-todo-pick-name">New Claude pane</span>
                <span className="ada-todo-pick-hint">spawns in this workspace</span>
              </span>
            </button>
          </div>

          <label className="ada-todo-send-field">
            <span className="ada-todo-cap">Message</span>
            <textarea
              className="ada-todo-send-message"
              value={message}
              rows={4}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  doSend()
                }
              }}
            />
          </label>

          <div className="ada-todo-send-toggles">
            <Toggle
              checked={autoComplete}
              onChange={setAutoComplete}
              label="Check it off when the agent's turn ends"
            />
            <Toggle checked={submit} onChange={setSubmit} label="Press Enter for me (off = paste only)" />
          </div>
        </>
      )}

      <div className="ada-todo-send-foot">
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!canSend} onClick={doSend} title="Ctrl+Enter">
          Send
        </Button>
      </div>
    </Popover>
  )
}

export default TodoSend
