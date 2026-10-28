/**
 * The todo board's link to the panes, mounted once from the main window — the
 * only renderer that has panes. It owns three jobs:
 *
 *   • publishing the workspaces and Claude panes a todo can go to, so the
 *     popped-out board can render its picker and agent chips;
 *   • carrying out what either board asks for (send a todo, open a pane);
 *   • walking every linked todo through `advanceAgent` as its pane's status and
 *     transcript change: typing a queued send once the pane is free, and
 *     noticing when the turn it started has ended.
 *
 * Like the status engine it reads the stores in callbacks rather than through
 * React state, so a status tick never re-renders the shell.
 */
import { useEffect } from 'react'
import type {
  TodoAgentLink,
  TodoItem,
  TodoSendRequest,
  TodoTargets
} from '../../../shared/types'
import { bracketedPaste } from '../lib/draftGate'
import { advanceAgent, canDeliver, type AgentObservation } from '../lib/todos'
import { findPane, useApp } from '../store/app'
import { getLastActivity, setPendingDraft, useRuntime } from '../store/runtime'
import { useTodos } from '../store/todos'

/** Bursts of status ticks collapse into one publish. */
const PUBLISH_DEBOUNCE_MS = 300
/** Settle windows are measured in time, not events, so the watcher also ticks. */
const WATCH_TICK_MS = 1000
/** Between a paste and its Enter, so Claude has taken the paste in. */
const SUBMIT_AFTER_PASTE_MS = 150

function buildTargets(): TodoTargets {
  const { workspaces } = useApp.getState()
  const { status } = useRuntime.getState()
  return {
    ready: true,
    workspaces: workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      name: workspace.name,
      panes: workspace.panes
        .filter((pane) => pane.kind === 'claude')
        .map((pane) => ({ paneId: pane.id, name: pane.name, status: status[pane.id] ?? 'idle' }))
    }))
  }
}

function observe(paneId: string): AgentObservation {
  const runtime = useRuntime.getState()
  const session = runtime.sessions[paneId]
  return {
    now: Date.now(),
    status: runtime.status[paneId] ?? 'idle',
    turnState: session?.turnState ?? 'unknown',
    lastWriteMs: session?.lastWriteMs ?? 0,
    promptOnScreen: !!runtime.promptOnScreen[paneId],
    lastOutputAt: getLastActivity(paneId)
  }
}

/** Paste into a live Claude input, then (optionally) press Enter. */
function typeInto(paneId: string, message: string, submit: boolean): void {
  window.api?.writePty(paneId, bracketedPaste(message))
  if (submit) setTimeout(() => window.api?.writePty(paneId, '\r'), SUBMIT_AFTER_PASTE_MS)
}

function send(request: TodoSendRequest): void {
  const todos = useTodos.getState()
  const item = todos.items.find((candidate) => candidate.id === request.todoId)
  const message = request.message.trim()
  if (!item || !message) return
  const app = useApp.getState()
  const workspace = app.workspaces.find((candidate) => candidate.id === request.workspaceId)
  if (!workspace) {
    app.pushToast('That workspace is no longer open.', { kind: 'error' })
    return
  }

  const base = {
    message,
    submit: request.submit,
    autoComplete: request.autoComplete,
    sentAt: Date.now()
  }

  if (request.paneId === null) {
    // A new pane types the message itself once Claude's input is up (the draft
    // gate). A paste-only draft still goes in as a bracketed paste, so its
    // newlines stay newlines instead of each one submitting a line.
    const paneId = app.addPane(workspace.id, { kind: 'claude' })
    if (!paneId) return
    setPendingDraft(paneId, request.submit ? message : bracketedPaste(message), request.submit)
    const pane = findPane(useApp.getState(), paneId)?.pane
    todos.setAgent(item.id, { ...base, paneId, paneName: pane?.name ?? 'Claude', phase: 'sent' })
    return
  }

  const found = findPane(app, request.paneId)
  if (!found) {
    app.pushToast('That pane has been closed.', { kind: 'error' })
    return
  }
  const ready = canDeliver(observe(request.paneId))
  if (ready) typeInto(request.paneId, message, request.submit)
  const link: TodoAgentLink = {
    ...base,
    paneId: request.paneId,
    paneName: found.pane.name,
    phase: ready ? 'sent' : 'queued'
  }
  todos.setAgent(item.id, link)
  app.focusPane(request.paneId)
}

/** One pass over every linked, open todo. */
function watch(): void {
  const todos = useTodos.getState()
  if (!todos.hydrated) return
  const app = useApp.getState()
  const changes = new Map<string, TodoItem>()
  for (const item of todos.items) {
    const agent = item.agent
    if (!agent || item.done || agent.phase === 'finished') continue
    if (!findPane(app, agent.paneId)) continue
    const step = advanceAgent(agent, observe(agent.paneId))
    if (step.deliver) typeInto(agent.paneId, agent.message, agent.submit)
    if (step.link === agent && !step.complete) continue
    const next: TodoItem = { ...item, agent: step.link }
    if (step.complete) {
      next.done = true
      next.doneAt = Date.now()
    }
    changes.set(item.id, next)
  }
  todos.patch(changes)
}

export function useTodoAgents(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const publish = (): void => {
      timer = null
      const targets = buildTargets()
      useTodos.getState().setTargets(targets)
      window.api?.publishTodoTargets(targets)
    }
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(publish, PUBLISH_DEBOUNCE_MS)
    }

    const offApp = useApp.subscribe((state, previous) => {
      if (state.workspaces !== previous.workspaces) schedule()
    })
    const offRuntime = useRuntime.subscribe((state, previous) => {
      if (state.status !== previous.status) schedule()
      if (
        state.status !== previous.status ||
        state.sessions !== previous.sessions ||
        state.promptOnScreen !== previous.promptOnScreen
      ) {
        watch()
      }
    })
    const tick = setInterval(watch, WATCH_TICK_MS)
    // Only once the workspaces are on screen: an early empty picture would read
    // as "every linked pane was closed".
    const offHydrated = useApp.subscribe((state, previous) => {
      if (state.hydrated && !previous.hydrated) publish()
    })
    if (useApp.getState().hydrated) publish()

    const offCommand = window.api?.onTodoCommand((command) => {
      if (command.type === 'send') send(command.request)
      else if (findPane(useApp.getState(), command.paneId)) useApp.getState().focusPane(command.paneId)
    })

    return () => {
      offApp()
      offRuntime()
      offHydrated()
      offCommand?.()
      clearInterval(tick)
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
}

export default useTodoAgents
