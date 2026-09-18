import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  areBellHooksInstalled,
  hookCommand,
  installHooks,
  isHookInstalled,
  parentSessionOf,
  parseHookLine,
  setHooksDir,
  turnContextFromTail
} from './hooks'

/**
 * Two things have to hold here: a hook line is read exactly as Claude Code wrote
 * it (including the subagent Stop we drop), and installing into a real
 * settings.json is safe to run twice over a file the user also owns.
 */

let dir = ''

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-hooks-'))
  setHooksDir(dir)
})

afterAll(() => {
  setHooksDir(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
}

function hookGroups(event: string): unknown[] {
  const hooks = readSettings().hooks as Record<string, unknown>
  return hooks[event] as unknown[]
}

describe('parseHookLine', () => {
  it('reads a Stop', () => {
    const line = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'abc-123',
      cwd: '/home/dev/project',
      transcript_path: '/home/dev/.claude/projects/-home-dev-project/abc-123.jsonl',
      prompt_id: 'prompt-1'
    })
    const event = parseHookLine(line, 1000)
    expect(event).toMatchObject({
      event: 'Stop',
      sessionId: 'abc-123',
      cwd: '/home/dev/project',
      promptId: 'prompt-1',
      parentSessionId: null,
      agentsRunning: false,
      ts: 1000
    })
  })

  it('reads a Notification with its message', () => {
    const line = JSON.stringify({
      hook_event_name: 'Notification',
      session_id: 'abc-123',
      message: 'Claude needs your permission to use Bash'
    })
    const event = parseHookLine(line, 2000)
    expect(event?.event).toBe('Notification')
    expect(event?.message).toBe('Claude needs your permission to use Bash')
  })

  it('reads a SubagentStop even when it quotes the subagent transcript', () => {
    const line = JSON.stringify({
      hook_event_name: 'SubagentStop',
      session_id: 'sub-9',
      transcript_path: '/p/abc-123/subagents/agent-7.jsonl'
    })
    const event = parseHookLine(line, 3000)
    expect(event?.event).toBe('SubagentStop')
    expect(event?.parentSessionId).toBe('abc-123')
  })

  it('drops a plain Stop fired by a subagent session', () => {
    const line = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sub-9',
      transcript_path: '/p/abc-123/subagents/agent-7.jsonl'
    })
    expect(parseHookLine(line, 4000)).toBeNull()
  })

  it('ignores anything that is not one of our events', () => {
    expect(parseHookLine('', 0)).toBeNull()
    expect(parseHookLine('not json', 0)).toBeNull()
    expect(parseHookLine(JSON.stringify({ hook_event_name: 'PreToolUse' }), 0)).toBeNull()
  })

  it('flags a still-running background agent', () => {
    const line = JSON.stringify({
      hook_event_name: 'Stop',
      background_tasks: [
        { type: 'shell', status: 'running' },
        { type: 'agent', status: 'running' }
      ]
    })
    expect(parseHookLine(line, 0)?.agentsRunning).toBe(true)
  })

  it('carries the turn context a Stop is given', () => {
    const line = JSON.stringify({ hook_event_name: 'Stop', transcript_path: '/p/abc.jsonl' })
    const event = parseHookLine(line, 0, () => ({
      fromTaskNotification: true,
      agentsLaunched: true
    }))
    expect(event?.fromTaskNotification).toBe(true)
    expect(event?.agentsLaunched).toBe(true)
  })
})

describe('parentSessionOf', () => {
  it('names the session above a subagent transcript', () => {
    expect(parentSessionOf('/p/abc-123/subagents/agent-7.jsonl')).toBe('abc-123')
  })

  it('handles Windows separators', () => {
    expect(parentSessionOf('C:\\p\\abc-123\\subagents\\agent-7.jsonl')).toBe('abc-123')
  })

  it('is null for an ordinary transcript', () => {
    expect(parentSessionOf('/p/enc/abc-123.jsonl')).toBeNull()
    expect(parentSessionOf(null)).toBeNull()
  })
})

describe('turnContextFromTail', () => {
  it('spots a turn woken by a subagent reporting in', () => {
    const tail = [
      JSON.stringify({ type: 'user', origin: { kind: 'task-notification' } }),
      JSON.stringify({ type: 'assistant' })
    ].join('\n')
    expect(turnContextFromTail(tail)).toEqual({
      fromTaskNotification: true,
      agentsLaunched: false
    })
  })

  it('spots background agents launched by the turn', () => {
    const tail = [
      JSON.stringify({ type: 'user', promptSource: 'user' }),
      JSON.stringify({ type: 'user', toolUseResult: { status: 'async_launched' } })
    ].join('\n')
    expect(turnContextFromTail(tail)).toEqual({
      fromTaskNotification: false,
      agentsLaunched: true
    })
  })
})

describe('installHooks', () => {
  it('writes all three events into a fresh settings file', () => {
    expect(isHookInstalled()).toBe(false)
    expect(installHooks()).toEqual({ ok: true, alreadyInstalled: false })
    expect(isHookInstalled()).toBe(true)
    expect(areBellHooksInstalled()).toBe(true)
    expect(hookGroups('Stop')).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: hookCommand() }] }
    ])
  })

  it('is idempotent', () => {
    expect(installHooks()).toEqual({ ok: true, alreadyInstalled: true })
    expect(hookGroups('Notification')).toHaveLength(1)
  })

  it('tops up only the missing event and keeps the user their own hooks', () => {
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        model: 'claude-opus-5[1m]',
        hooks: {
          Stop: [userHook, { matcher: '', hooks: [{ type: 'command', command: hookCommand() }] }],
          Notification: [{ matcher: '', hooks: [{ type: 'command', command: hookCommand() }] }]
        }
      })
    )
    expect(isHookInstalled()).toBe(false)
    expect(areBellHooksInstalled()).toBe(true)

    expect(installHooks()).toEqual({ ok: true, alreadyInstalled: false })
    expect(hookGroups('Stop')).toHaveLength(2)
    expect(hookGroups('Stop')[0]).toEqual(userHook)
    expect(hookGroups('Notification')).toHaveLength(1)
    expect(hookGroups('SubagentStop')).toHaveLength(1)
    // unrelated settings survive the merge
    expect(readSettings().model).toBe('claude-opus-5[1m]')
  })
})
