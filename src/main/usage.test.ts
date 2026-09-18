import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sessionWindowTokens } from './usage'

const HOUR_MS = 60 * 60 * 1000
// Anchored to the real clock: files written by the test carry a live mtime, and
// a file whose mtime predates the window start is (correctly) skipped.
const NOW = Date.now()
const WINDOW_START = NOW - 5 * HOUR_MS

let root = ''

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-usage-'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

interface LineInput {
  ts: number
  messageId: string
  requestId: string
  input?: number
  output?: number
  cacheCreate?: number
  cacheRead?: number
}

/** One assistant transcript line carrying usage, as Claude Code writes it. */
function line(input: LineInput): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(input.ts).toISOString(),
      requestId: input.requestId,
      message: {
        id: input.messageId,
        model: 'claude-opus-5',
        usage: {
          input_tokens: input.input ?? 0,
          output_tokens: input.output ?? 0,
          cache_creation_input_tokens: input.cacheCreate ?? 0,
          cache_read_input_tokens: input.cacheRead ?? 0
        }
      }
    }) + '\n'
  )
}

/** A projects tree of its own per test, so the incremental cache never bleeds. */
function projectDir(name: string): string {
  const dir = path.join(root, name, '-home-dev-proj')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function tokensIn(name: string): ReturnType<typeof sessionWindowTokens> {
  return sessionWindowTokens(WINDOW_START, NOW, path.join(root, name))
}

describe('sessionWindowTokens', () => {
  it('counts input, output and cache creation, but not cache reads', () => {
    const dir = projectDir('simple')
    fs.writeFileSync(
      path.join(dir, 'session-a.jsonl'),
      line({
        ts: NOW - HOUR_MS,
        messageId: 'msg_1',
        requestId: 'req_1',
        input: 100,
        output: 20,
        cacheCreate: 5,
        cacheRead: 9000
      })
    )

    expect(tokensIn('simple')).toEqual({ bySessionId: { 'session-a': 125 }, windowTokens: 125 })
  })

  it('keeps the largest usage for a repeated message id', () => {
    const dir = projectDir('dedup')
    // A streaming response rewrites the same id with growing output_tokens;
    // first-wins would report 5 instead of the final 400.
    fs.writeFileSync(
      path.join(dir, 'session-b.jsonl'),
      line({ ts: NOW - HOUR_MS, messageId: 'msg_1', requestId: 'req_1', output: 5 }) +
        line({ ts: NOW - HOUR_MS, messageId: 'msg_1', requestId: 'req_1', output: 400 }) +
        line({ ts: NOW - HOUR_MS, messageId: 'msg_1', requestId: 'req_1', output: 120 })
    )

    expect(tokensIn('dedup')).toEqual({ bySessionId: { 'session-b': 400 }, windowTokens: 400 })
  })

  it('attributes a subagent transcript to its parent session', () => {
    const dir = projectDir('subagents')
    fs.writeFileSync(
      path.join(dir, 'session-c.jsonl'),
      line({ ts: NOW - HOUR_MS, messageId: 'msg_1', requestId: 'req_1', output: 10 })
    )
    const subagentDir = path.join(dir, 'session-c', 'subagents')
    fs.mkdirSync(subagentDir, { recursive: true })
    fs.writeFileSync(
      path.join(subagentDir, 'agent-1.jsonl'),
      line({ ts: NOW - HOUR_MS, messageId: 'msg_2', requestId: 'req_2', output: 90 })
    )

    expect(tokensIn('subagents')).toEqual({ bySessionId: { 'session-c': 100 }, windowTokens: 100 })
  })

  it('ignores records outside the window', () => {
    const dir = projectDir('window')
    fs.writeFileSync(
      path.join(dir, 'session-d.jsonl'),
      line({ ts: WINDOW_START - HOUR_MS, messageId: 'msg_1', requestId: 'req_1', output: 999 }) +
        line({ ts: NOW + HOUR_MS, messageId: 'msg_2', requestId: 'req_2', output: 777 }) +
        line({ ts: NOW - HOUR_MS, messageId: 'msg_3', requestId: 'req_3', output: 42 })
    )

    expect(tokensIn('window')).toEqual({ bySessionId: { 'session-d': 42 }, windowTokens: 42 })
  })

  it('reads only the bytes appended since the previous pass', () => {
    const dir = projectDir('incremental')
    const file = path.join(dir, 'session-e.jsonl')
    const first = line({ ts: NOW - HOUR_MS, messageId: 'msg_1', requestId: 'req_1', output: 10 })
    fs.writeFileSync(file, first)
    expect(tokensIn('incremental').windowTokens).toBe(10)

    // Rewrite the already-consumed prefix in place (same byte length, different
    // numbers) and append a new record: only the appended bytes may be read, so
    // the rewritten prefix must not change the total.
    const rewritten = line({ ts: NOW - HOUR_MS, messageId: 'msg_9', requestId: 'req_9', output: 99 })
    expect(rewritten).toHaveLength(first.length)
    const appended = line({ ts: NOW - HOUR_MS, messageId: 'msg_2', requestId: 'req_2', output: 7 })
    fs.writeFileSync(file, rewritten + appended)

    expect(tokensIn('incremental')).toEqual({ bySessionId: { 'session-e': 17 }, windowTokens: 17 })
  })

  it('forgets a file that has vanished, so a new one at the same path is read whole', () => {
    const dir = projectDir('evict')
    const file = path.join(dir, 'session-f.jsonl')
    fs.writeFileSync(
      file,
      line({ ts: NOW - HOUR_MS, messageId: 'msg_1', requestId: 'req_1', output: 10 })
    )
    expect(tokensIn('evict').windowTokens).toBe(10)

    fs.rmSync(file)
    expect(tokensIn('evict')).toEqual({ bySessionId: {}, windowTokens: 0 })

    // Same path, same byte length: a stale cache would skip these bytes entirely
    // and keep reporting the old 10.
    fs.writeFileSync(
      file,
      line({ ts: NOW - HOUR_MS, messageId: 'msg_1', requestId: 'req_1', output: 17 })
    )
    expect(tokensIn('evict')).toEqual({ bySessionId: { 'session-f': 17 }, windowTokens: 17 })
  })

  it('reports nothing when the projects root does not exist', () => {
    expect(sessionWindowTokens(WINDOW_START, NOW, path.join(root, 'missing'))).toEqual({
      bySessionId: {},
      windowTokens: 0
    })
  })
})
