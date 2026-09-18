import { describe, expect, it } from 'vitest'
import type { JsonlStatus, PaneStatus, SessionInfo, TurnState } from '../../../shared/types'
import {
  BLOCKING_PROMPT_MARKERS,
  STATUS_LABEL,
  isRealOutput,
  resolveStatus,
  type StatusInput
} from './status'

const NOW = 1_000_000

function session(over: { turnState?: TurnState; jsonlStatus?: JsonlStatus; lastWriteMs?: number }): SessionInfo {
  return {
    paneId: 'pane-1',
    sessionId: 'abcdef12-3456',
    title: null,
    lastPrompt: null,
    model: null,
    permissionMode: null,
    gitBranch: null,
    jsonlStatus: over.jsonlStatus ?? 'unknown',
    turnState: over.turnState ?? 'open',
    lastWriteMs: over.lastWriteMs ?? NOW
  }
}

function claudePane(over: Partial<StatusInput> = {}): StatusInput {
  return {
    kind: 'claude',
    exited: false,
    now: NOW,
    lastActivityMs: NOW,
    promptOnScreen: false,
    unseenDone: false,
    ...over
  }
}

describe('resolveStatus', () => {
  it('reports an exited pane whatever else is true', () => {
    expect(resolveStatus(claudePane({ exited: true, promptOnScreen: true }))).toBe('exited')
  })

  const table: { name: string; input: StatusInput; expected: PaneStatus }[] = [
    {
      name: 'recent PTY output with an open turn is working',
      input: claudePane({ lastActivityMs: NOW - 1000, session: session({ turnState: 'open' }) }),
      expected: 'working'
    },
    {
      name: 'a settled ended turn overrules fresh repaint bytes',
      input: claudePane({
        lastActivityMs: NOW - 1000,
        session: session({ turnState: 'ended', lastWriteMs: NOW - 5000 })
      }),
      expected: 'idle'
    },
    {
      name: 'an ended turn inside the settle grace still reads working',
      input: claudePane({
        lastActivityMs: NOW - 1000,
        session: session({ turnState: 'ended', lastWriteMs: NOW - 1000 })
      }),
      expected: 'working'
    },
    {
      name: 'a blocking prompt on screen wins once the pane is quiet',
      input: claudePane({ lastActivityMs: NOW - 10_000, promptOnScreen: true }),
      expected: 'attention'
    },
    {
      name: 'pending-tool plus long quiet reads as attention',
      input: claudePane({
        lastActivityMs: NOW - 10_000,
        session: session({ jsonlStatus: 'pending-tool' })
      }),
      expected: 'attention'
    },
    {
      name: 'pending-tool that has not been quiet long enough is not attention yet',
      input: claudePane({
        lastActivityMs: NOW - 5000,
        session: session({ jsonlStatus: 'pending-tool' })
      }),
      expected: 'idle'
    },
    {
      name: 'a quiet pane with an unseen finished turn is done',
      input: claudePane({ lastActivityMs: NOW - 10_000, unseenDone: true }),
      expected: 'done'
    },
    {
      name: 'a quiet pane with nothing pending is idle',
      input: claudePane({ lastActivityMs: NOW - 10_000 }),
      expected: 'idle'
    },
    {
      name: 'a pane that has never produced output is idle',
      input: claudePane({ lastActivityMs: undefined }),
      expected: 'idle'
    },
    {
      name: 'a terminal pane painting right now is working',
      input: claudePane({ kind: 'terminal', lastActivityMs: NOW - 500 }),
      expected: 'working'
    },
    {
      name: 'a quiet terminal pane is idle',
      input: claudePane({ kind: 'terminal', lastActivityMs: NOW - 2000 }),
      expected: 'idle'
    },
    {
      name: 'an ssh pane follows the same PTY liveness rule',
      input: claudePane({ kind: 'ssh', lastActivityMs: NOW - 100 }),
      expected: 'working'
    },
    {
      name: 'a terminal pane never reads attention from a prompt probe',
      input: claudePane({ kind: 'terminal', lastActivityMs: NOW - 9000, promptOnScreen: true }),
      expected: 'idle'
    },
    {
      name: 'a viewer pane is always idle',
      input: claudePane({ kind: 'viewer', lastActivityMs: NOW, promptOnScreen: true }),
      expected: 'idle'
    }
  ]

  for (const row of table) {
    it(row.name, () => {
      expect(resolveStatus(row.input)).toBe(row.expected)
    })
  }
})

describe('isRealOutput', () => {
  it('ignores a chunk that is nothing but cursor-position polling', () => {
    expect(isRealOutput('\x1b[6n')).toBe(false)
    expect(isRealOutput('\x1b[?6n\x1b[6n')).toBe(false)
  })

  it('accepts a chunk carrying anything else', () => {
    expect(isRealOutput('\x1b[6nhello')).toBe(true)
    expect(isRealOutput('x'.repeat(100))).toBe(true)
  })

  it('treats an empty chunk as no output', () => {
    expect(isRealOutput('')).toBe(false)
  })
})

describe('BLOCKING_PROMPT_MARKERS', () => {
  it('matches Claude Code dialog wording but not the working hint', () => {
    expect(BLOCKING_PROMPT_MARKERS.test('Do you want to proceed?')).toBe(true)
    expect(BLOCKING_PROMPT_MARKERS.test('esc to cancel')).toBe(true)
    expect(BLOCKING_PROMPT_MARKERS.test('esc to interrupt')).toBe(false)
  })
})

describe('STATUS_LABEL', () => {
  it('names every status', () => {
    expect(STATUS_LABEL).toEqual({
      working: 'Working',
      attention: 'Needs input',
      idle: 'Idle',
      done: 'Done',
      exited: 'Exited'
    })
  })
})
