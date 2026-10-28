/**
 * The todo board's rules: what a quick-add line means, how checking a box
 * ripples through a checklist, and how a todo handed to a Claude pane moves
 * from queued to finished. Pure — no React, no IPC — so the board's two windows
 * and the main window's agent watcher all run exactly the same logic.
 */
import type {
  PaneStatus,
  TodoAgentLink,
  TodoAgentPhase,
  TodoItem,
  TodoSubItem,
  TodoTargetPane,
  TodoTargets,
  TurnState
} from '../../../shared/types'

/** `@name` tags a workspace; letters, digits and `._-`, like a folder name. */
const TAG_RE = /(^|\s)@([\w.-]+)/

export interface QuickAdd {
  title: string
  workspace?: string
}

/** One quick-add line → its title and the workspace it was tagged with. */
export function parseQuickAdd(text: string): QuickAdd {
  const match = TAG_RE.exec(text)
  const title = (match ? text.replace(match[0], ' ') : text).replace(/\s+/g, ' ').trim()
  return match ? { title, workspace: match[2] } : { title }
}

/**
 * Lines of a paste worth turning into todos. Leading list markers (`-`, `*`,
 * `1.`, `- [ ]`) are what a pasted list carries; they are not part of the task.
 */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[[ xX]?\]\s*)?/, '').trim())
    .filter((line) => line.length > 0)
}

let counter = 0

/** Ids only need to be unique within one list, across both windows. */
export function todoId(prefix = 't'): string {
  counter = (counter + 1) % 1_000_000
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function newTodo(text: string, now: number, checklist = false): TodoItem | null {
  const { title, workspace } = parseQuickAdd(text)
  if (!title) return null
  const item: TodoItem = { id: todoId(), title, done: false, createdAt: now }
  if (workspace) item.workspace = workspace
  if (checklist) item.items = []
  return item
}

function withDone(item: TodoItem, done: boolean, now: number): TodoItem {
  const next: TodoItem = { ...item, done }
  if (done) next.doneAt = item.done ? (item.doneAt ?? now) : now
  else delete next.doneAt
  return next
}

/** Checking a checklist checks all of it; unchecking leaves its lines as they were. */
export function toggleTodo(item: TodoItem, now: number): TodoItem {
  const done = !item.done
  const next = withDone(item, done, now)
  if (done && item.items) next.items = item.items.map((sub) => ({ ...sub, done: true }))
  return next
}

/** The parent is done exactly when every one of its lines is. */
export function toggleSub(item: TodoItem, subId: string, now: number): TodoItem {
  if (!item.items) return item
  const items = item.items.map((sub) => (sub.id === subId ? { ...sub, done: !sub.done } : sub))
  return withDone({ ...item, items }, items.length > 0 && items.every((sub) => sub.done), now)
}

/** A new, unchecked line reopens a checklist that had been finished. */
export function addSub(item: TodoItem, title: string, now: number): TodoItem {
  const clean = title.trim()
  if (!clean) return item
  const sub: TodoSubItem = { id: todoId('s'), title: clean, done: false }
  return withDone({ ...item, items: [...(item.items ?? []), sub] }, false, now)
}

export function removeSub(item: TodoItem, subId: string, now: number): TodoItem {
  if (!item.items) return item
  const items = item.items.filter((sub) => sub.id !== subId)
  const done = items.length > 0 ? items.every((sub) => sub.done) : item.done
  return withDone({ ...item, items }, done, now)
}

export function progress(item: TodoItem): { done: number; total: number } {
  const items = item.items ?? []
  return { done: items.filter((sub) => sub.done).length, total: items.length }
}

/** What the send dialog starts with: the task, and a checklist's open lines. */
export function defaultMessage(item: TodoItem): string {
  const open = (item.items ?? []).filter((sub) => !sub.done)
  if (open.length === 0) return item.title
  return `${item.title}\n\n${open.map((sub) => `- [ ] ${sub.title}`).join('\n')}`
}

/* === agents ================================================================ */

export function findTargetPane(
  targets: TodoTargets,
  paneId: string
): { pane: TodoTargetPane; workspaceName: string } | null {
  for (const workspace of targets.workspaces) {
    const pane = workspace.panes.find((candidate) => candidate.paneId === paneId)
    if (pane) return { pane, workspaceName: workspace.name }
  }
  return null
}

/** The workspace a todo's tag names, matched the way a person would type it. */
export function workspaceForTag(targets: TodoTargets, tag: string | undefined): string | null {
  if (!tag) return null
  const lower = tag.toLowerCase()
  return targets.workspaces.find((workspace) => workspace.name.toLowerCase() === lower)?.workspaceId ?? null
}

/** What a todo's agent chip says. */
export type AgentChipState = 'queued' | 'working' | 'attention' | 'finished' | 'closed' | 'done'

export const AGENT_CHIP_LABEL: Record<AgentChipState, string> = {
  queued: 'queued',
  working: 'working',
  attention: 'needs you',
  finished: 'done',
  closed: 'pane closed',
  done: ''
}

export function agentChip(item: TodoItem, targets: TodoTargets): AgentChipState | null {
  const agent = item.agent
  if (!agent) return null
  if (item.done) return 'done'
  const found = findTargetPane(targets, agent.paneId)
  // Before the main window has spoken, a missing pane is unknown, not gone.
  if (!found) return targets.ready ? 'closed' : agent.phase === 'queued' ? 'queued' : 'working'
  if (found.pane.status === 'exited') return 'closed'
  if (agent.phase === 'queued') return 'queued'
  if (agent.phase === 'finished') return 'finished'
  if (found.pane.status === 'attention') return 'attention'
  return 'working'
}

/** What the agent watcher can see of a linked pane at one instant. */
export interface AgentObservation {
  now: number
  status: PaneStatus
  turnState: TurnState
  /** epoch ms the pane's transcript was last written; 0 when unknown */
  lastWriteMs: number
  /** a permission or trust dialog is on screen */
  promptOnScreen: boolean
  /** epoch ms of the pane's last real PTY output */
  lastOutputAt: number
}

/** Output must have been quiet this long before a queued send is typed. */
export const DELIVER_SETTLE_MS = 800
/**
 * The transcript's mtime comes from the filesystem (in WSL mode, another
 * kernel's clock), so a write "before" the send by less than this still counts
 * as the turn the send started.
 */
export const CLOCK_SLACK_MS = 2000

/** Can text go into this pane's input now without landing mid-turn or in a dialog? */
export function canDeliver(obs: AgentObservation): boolean {
  if (obs.status !== 'idle' && obs.status !== 'done') return false
  if (obs.promptOnScreen) return false
  return obs.now - obs.lastOutputAt >= DELIVER_SETTLE_MS
}

export interface AgentStep {
  link: TodoAgentLink
  /** Type `link.message` into the pane now. */
  deliver: boolean
  /** Check the todo off (the turn ended and it asked for that). */
  complete: boolean
}

/**
 * One step of the hand-off. A queued send waits for its pane to be free; a sent
 * one becomes `working` only once the TRANSCRIPT shows a turn opened after the
 * send — PTY output alone cannot tell a booting Claude from a working one — and
 * a working one finishes when that turn has ended and the pane has settled.
 */
export function advanceAgent(link: TodoAgentLink, obs: AgentObservation): AgentStep {
  const step = (phase: TodoAgentPhase, extra: Partial<TodoAgentLink> = {}): TodoAgentLink =>
    phase === link.phase && Object.keys(extra).length === 0 ? link : { ...link, ...extra, phase }

  if (obs.status === 'exited') return { link, deliver: false, complete: false }

  switch (link.phase) {
    case 'queued':
      if (!canDeliver(obs)) return { link, deliver: false, complete: false }
      return { link: step('sent', { sentAt: obs.now }), deliver: true, complete: false }
    case 'sent': {
      const turnSinceSend = obs.turnState === 'open' && obs.lastWriteMs >= link.sentAt - CLOCK_SLACK_MS
      return { link: turnSinceSend ? step('working') : link, deliver: false, complete: false }
    }
    case 'working': {
      const ended = obs.turnState === 'ended' && obs.status !== 'working' && obs.status !== 'attention'
      if (!ended) return { link, deliver: false, complete: false }
      return { link: step('finished'), deliver: false, complete: link.autoComplete }
    }
    case 'finished':
      return { link, deliver: false, complete: false }
  }
}

/** The titlebar button's badge: the loudest thing the board has to say. */
export interface BoardBadge {
  count: number
  tone: 'attention' | 'finished' | 'neutral'
}

export function boardBadge(items: TodoItem[], targets: TodoTargets): BoardBadge | null {
  const open = items.filter((item) => !item.done)
  const chips = open.map((item) => agentChip(item, targets))
  const attention = chips.filter((chip) => chip === 'attention').length
  if (attention > 0) return { count: attention, tone: 'attention' }
  const finished = chips.filter((chip) => chip === 'finished').length
  if (finished > 0) return { count: finished, tone: 'finished' }
  return open.length > 0 ? { count: open.length, tone: 'neutral' } : null
}

/** Every workspace name worth filtering by: open ones, then tags on todos. */
export function workspaceFilterNames(items: TodoItem[], targets: TodoTargets): string[] {
  const names = targets.workspaces.map((workspace) => workspace.name)
  const seen = new Set(names.map((name) => name.toLowerCase()))
  for (const item of items) {
    if (item.workspace && !seen.has(item.workspace.toLowerCase())) {
      seen.add(item.workspace.toLowerCase())
      names.push(item.workspace)
    }
  }
  return names
}

export function matchesWorkspace(item: TodoItem, filter: string | null): boolean {
  if (!filter) return true
  return item.workspace?.toLowerCase() === filter.toLowerCase()
}
