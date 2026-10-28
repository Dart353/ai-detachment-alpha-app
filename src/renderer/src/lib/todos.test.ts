import { describe, expect, it } from 'vitest'
import type { TodoAgentLink, TodoItem, TodoTargets } from '../../../shared/types'
import {
  CLOCK_SLACK_MS,
  DELIVER_SETTLE_MS,
  addSub,
  advanceAgent,
  agentChip,
  boardBadge,
  canDeliver,
  defaultMessage,
  newTodo,
  parseQuickAdd,
  removeSub,
  splitLines,
  toggleSub,
  toggleTodo,
  workspaceFilterNames,
  workspaceForTag,
  type AgentObservation
} from './todos'

const NOW = 1_000_000

function item(partial: Partial<TodoItem> = {}): TodoItem {
  return { id: 't1', title: 'Task', done: false, createdAt: 1, ...partial }
}

function link(partial: Partial<TodoAgentLink> = {}): TodoAgentLink {
  return {
    paneId: 'p1',
    paneName: 'api-refactor',
    phase: 'sent',
    message: 'Task',
    submit: true,
    autoComplete: false,
    sentAt: NOW,
    ...partial
  }
}

function obs(partial: Partial<AgentObservation> = {}): AgentObservation {
  return {
    now: NOW + 10_000,
    status: 'idle',
    turnState: 'ended',
    lastWriteMs: 0,
    promptOnScreen: false,
    lastOutputAt: 0,
    ...partial
  }
}

const TARGETS: TodoTargets = {
  ready: true,
  workspaces: [
    {
      workspaceId: 'w1',
      name: 'ada-app',
      panes: [
        { paneId: 'p1', name: 'api-refactor', status: 'working' },
        { paneId: 'p2', name: 'deps', status: 'attention' },
        { paneId: 'p3', name: 'old', status: 'exited' }
      ]
    }
  ]
}

describe('quick add', () => {
  it('takes the first @tag as the workspace and leaves a clean title', () => {
    expect(parseQuickAdd('Fix  flaky @ada-app smoke step')).toEqual({
      title: 'Fix flaky smoke step',
      workspace: 'ada-app'
    })
    expect(parseQuickAdd('@relay rotate key')).toEqual({ title: 'rotate key', workspace: 'relay' })
  })

  it('does not read an email address as a tag', () => {
    expect(parseQuickAdd('mail a@b.com')).toEqual({ title: 'mail a@b.com' })
  })

  it('makes no todo out of a bare tag', () => {
    expect(newTodo('@relay', NOW)).toBeNull()
    expect(newTodo('  ', NOW)).toBeNull()
  })

  it('starts a checklist with an empty list of lines', () => {
    expect(newTodo('Ship it', NOW, true)).toMatchObject({ title: 'Ship it', items: [], done: false })
  })

  it('strips list markers from pasted lines and drops blanks', () => {
    expect(splitLines('- one\n\n* [ ] two\r\n3. three\n  [x] four  ')).toEqual([
      'one',
      'two',
      'three',
      'four'
    ])
  })
})

describe('checklists', () => {
  const list = item({
    items: [
      { id: 'a', title: 'A', done: true },
      { id: 'b', title: 'B', done: false }
    ]
  })

  it('checks the parent when its last line is checked, and unchecks it after', () => {
    const done = toggleSub(list, 'b', NOW)
    expect(done.done).toBe(true)
    expect(done.doneAt).toBe(NOW)
    const reopened = toggleSub(done, 'a', NOW + 1)
    expect(reopened.done).toBe(false)
    expect(reopened.doneAt).toBeUndefined()
  })

  it('checks every line when the parent is checked, and leaves them when unchecked', () => {
    const done = toggleTodo(list, NOW)
    expect(done.items?.every((sub) => sub.done)).toBe(true)
    expect(toggleTodo(done, NOW).items?.every((sub) => sub.done)).toBe(true)
  })

  it('reopens a finished checklist when a line is added', () => {
    const added = addSub(toggleTodo(list, NOW), 'C', NOW)
    expect(added.done).toBe(false)
    expect(added.items?.map((sub) => sub.title)).toEqual(['A', 'B', 'C'])
  })

  it('finishes the checklist when its only open line is removed', () => {
    expect(removeSub(list, 'b', NOW).done).toBe(true)
  })

  it('sends a checklist with its open lines', () => {
    expect(defaultMessage(list)).toBe('Task\n\n- [ ] B')
    expect(defaultMessage(item())).toBe('Task')
  })
})

describe('advanceAgent', () => {
  it('delivers a queued send once the pane is idle and quiet', () => {
    const queued = link({ phase: 'queued', sentAt: 0 })
    expect(advanceAgent(queued, obs({ status: 'working' })).deliver).toBe(false)
    expect(advanceAgent(queued, obs({ promptOnScreen: true })).deliver).toBe(false)
    expect(advanceAgent(queued, obs({ lastOutputAt: NOW + 10_000 - DELIVER_SETTLE_MS + 1 })).deliver).toBe(false)
    const step = advanceAgent(queued, obs())
    expect(step.deliver).toBe(true)
    expect(step.link).toMatchObject({ phase: 'sent', sentAt: NOW + 10_000 })
  })

  it('counts a turn as started only once the transcript opens one after the send', () => {
    // A booting Claude paints (status working) before any turn exists.
    expect(advanceAgent(link(), obs({ status: 'working', turnState: 'unknown' })).link.phase).toBe('sent')
    // The previous turn, written well before the send, is not this one.
    expect(advanceAgent(link(), obs({ turnState: 'open', lastWriteMs: NOW - CLOCK_SLACK_MS - 1 })).link.phase).toBe('sent')
    expect(advanceAgent(link(), obs({ turnState: 'open', lastWriteMs: NOW - 500 })).link.phase).toBe('working')
  })

  it('finishes when the turn has ended and the pane has settled', () => {
    const working = link({ phase: 'working' })
    expect(advanceAgent(working, obs({ status: 'working', turnState: 'ended' })).link.phase).toBe('working')
    expect(advanceAgent(working, obs({ status: 'attention', turnState: 'ended' })).link.phase).toBe('working')
    const step = advanceAgent(working, obs({ status: 'done', turnState: 'ended' }))
    expect(step.link.phase).toBe('finished')
    expect(step.complete).toBe(false)
    expect(advanceAgent(link({ phase: 'working', autoComplete: true }), obs()).complete).toBe(true)
  })

  it('leaves a link alone while its pane is exited', () => {
    const queued = link({ phase: 'queued' })
    expect(advanceAgent(queued, obs({ status: 'exited' })).link).toBe(queued)
  })

  it('returns the same link when nothing moved', () => {
    const sent = link()
    expect(advanceAgent(sent, obs()).link).toBe(sent)
  })

  it('refuses delivery into a busy or prompting pane', () => {
    expect(canDeliver(obs({ status: 'attention' }))).toBe(false)
    expect(canDeliver(obs({ status: 'done' }))).toBe(true)
  })
})

describe('agent chips and the badge', () => {
  it('mirrors the pane, and calls a vanished or exited pane closed', () => {
    expect(agentChip(item({ agent: link({ phase: 'working' }) }), TARGETS)).toBe('working')
    expect(agentChip(item({ agent: link({ paneId: 'p2', phase: 'working' }) }), TARGETS)).toBe('attention')
    expect(agentChip(item({ agent: link({ paneId: 'p3' }) }), TARGETS)).toBe('closed')
    expect(agentChip(item({ agent: link({ paneId: 'gone' }) }), TARGETS)).toBe('closed')
    expect(agentChip(item({ done: true, agent: link() }), TARGETS)).toBe('done')
    expect(agentChip(item(), TARGETS)).toBeNull()
  })

  it('does not call a pane closed before the main window has published', () => {
    const unknown = { ready: false, workspaces: [] }
    expect(agentChip(item({ agent: link({ paneId: 'gone', phase: 'queued' }) }), unknown)).toBe('queued')
  })

  it('shouts attention over finished over the open count', () => {
    const finished = item({ id: 'f', agent: link({ phase: 'finished' }) })
    const attention = item({ id: 'a', agent: link({ paneId: 'p2', phase: 'working' }) })
    const plain = item({ id: 'p' })
    expect(boardBadge([plain, finished, attention], TARGETS)).toEqual({ count: 1, tone: 'attention' })
    expect(boardBadge([plain, finished], TARGETS)).toEqual({ count: 1, tone: 'finished' })
    expect(boardBadge([plain, item({ id: 'q' })], TARGETS)).toEqual({ count: 2, tone: 'neutral' })
    expect(boardBadge([item({ done: true })], TARGETS)).toBeNull()
  })
})

describe('workspaces', () => {
  it('matches a tag to an open workspace ignoring case', () => {
    expect(workspaceForTag(TARGETS, 'ADA-app')).toBe('w1')
    expect(workspaceForTag(TARGETS, 'relay')).toBeNull()
    expect(workspaceForTag(TARGETS, undefined)).toBeNull()
  })

  it('offers open workspaces first, then tags nobody has open', () => {
    const items = [item({ workspace: 'relay' }), item({ workspace: 'Ada-App' })]
    expect(workspaceFilterNames(items, TARGETS)).toEqual(['ada-app', 'relay'])
  })
})
