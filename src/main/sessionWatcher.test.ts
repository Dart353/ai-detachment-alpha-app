import { describe, expect, it } from 'vitest'
import { encodeCwd, parseTail } from './sessionWatcher'

/**
 * The transcript parser is the one piece of session awareness that has to be right
 * without a running Claude: everything the renderer shows on a pane (title, model,
 * "working" vs "needs input") is derived from these tails, so they are exercised
 * here as literal JSONL rather than through the poller.
 */

/** One JSONL document from a list of entries, as the watcher reads it. */
function jsonl(entries: Record<string, unknown>[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content }, ...extra }
}

function user(content: unknown, extra: Record<string, unknown> = {}) {
  return { type: 'user', message: { role: 'user', content }, ...extra }
}

describe('encodeCwd', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeCwd('/home/dev/my_project.v2')).toBe('-home-dev-my-project-v2')
  })

  it('leaves an already-safe name alone', () => {
    expect(encodeCwd('abc123')).toBe('abc123')
  })
})

describe('parseTail status', () => {
  it('reports pending-tool while a tool_use has no result', () => {
    const tail = jsonl([
      user('run the tests'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash' }])
    ])
    const parsed = parseTail(tail)
    expect(parsed.jsonlStatus).toBe('pending-tool')
    expect(parsed.turnState).toBe('open')
  })

  it('reports turn-idle once every tool_use has a result', () => {
    // the result lands in an entry the status walk skips, so the assistant entry
    // is what the walk sees — with its tool already resolved, nothing is pending
    const tail = jsonl([
      user('run the tests'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash' }]),
      user([{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }], {
        isVisibleInTranscriptOnly: true
      })
    ])
    const parsed = parseTail(tail)
    expect(parsed.jsonlStatus).toBe('turn-idle')
    expect(parsed.turnState).toBe('open')
  })

  it('keeps a turn open while a tool_result is on its way back', () => {
    const tail = jsonl([
      user('run the tests'),
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash' }]),
      user([{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }])
    ])
    const parsed = parseTail(tail)
    expect(parsed.jsonlStatus).toBe('turn-idle')
    expect(parsed.turnState).toBe('open')
  })

  it('ends the turn on an assistant message with prose and no tool', () => {
    const tail = jsonl([user('hello'), assistant([{ type: 'text', text: 'All done.' }])])
    const parsed = parseTail(tail)
    expect(parsed.jsonlStatus).toBe('turn-idle')
    expect(parsed.turnState).toBe('ended')
  })

  it('keeps the turn open when the assistant has only thought so far', () => {
    const tail = jsonl([
      user('hello'),
      assistant([{ type: 'thinking', thinking: 'weighing the options' }])
    ])
    expect(parseTail(tail).turnState).toBe('open')
  })

  it('keeps the turn open when the assistant text is blank', () => {
    const tail = jsonl([user('hello'), assistant([{ type: 'text', text: '   ' }])])
    expect(parseTail(tail).turnState).toBe('open')
  })

  it('opens the turn on a trailing user prompt', () => {
    const tail = jsonl([assistant([{ type: 'text', text: 'Done.' }]), user('now the docs')])
    expect(parseTail(tail).turnState).toBe('open')
  })

  it('ends the turn on an interrupt', () => {
    const tail = jsonl([
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash' }]),
      user('[Request interrupted by user for tool use]')
    ])
    expect(parseTail(tail).turnState).toBe('ended')
  })

  it('reports unknown for an empty or unusable tail', () => {
    expect(parseTail('').jsonlStatus).toBe('unknown')
    expect(parseTail('not json\n{"broken":\n').turnState).toBe('unknown')
  })

  it('ignores sidechain entries when reading the status', () => {
    const tail = jsonl([
      user('hello'),
      assistant([{ type: 'text', text: 'All done.' }]),
      assistant([{ type: 'tool_use', id: 'sub-1', name: 'Bash' }], { isSidechain: true })
    ])
    const parsed = parseTail(tail)
    expect(parsed.jsonlStatus).toBe('turn-idle')
    expect(parsed.turnState).toBe('ended')
  })

  it('ignores the echoes a local slash command leaves behind', () => {
    const tail = jsonl([
      user('hello'),
      assistant([{ type: 'text', text: 'All done.' }]),
      user('<command-name>/compact</command-name>'),
      user('/compact'),
      user('<local-command-stdout>compacted</local-command-stdout>')
    ])
    expect(parseTail(tail).turnState).toBe('ended')
  })

  it('still treats a slash command with no local output as a live turn', () => {
    const tail = jsonl([
      assistant([{ type: 'text', text: 'All done.' }]),
      user('/review the diff')
    ])
    expect(parseTail(tail).turnState).toBe('open')
  })

  it('ignores transcript bookkeeping entries', () => {
    const tail = jsonl([
      assistant([{ type: 'text', text: 'All done.' }]),
      user('caveat: this message was generated locally', { isMeta: true }),
      user('summary of the conversation so far', { isCompactSummary: true }),
      user('shown in the transcript only', { isVisibleInTranscriptOnly: true })
    ])
    expect(parseTail(tail).turnState).toBe('ended')
  })
})

describe('parseTail fields', () => {
  it('extracts the ai title, last prompt, model, permission mode and branch', () => {
    const tail = jsonl([
      { type: 'ai-title', aiTitle: 'Port the session watcher' },
      { type: 'last-prompt', lastPrompt: 'port the watcher' },
      { sessionId: 'abc-123', gitBranch: 'main', permissionMode: 'plan' },
      assistant([{ type: 'text', text: 'On it.' }])
    ])
    const parsed = parseTail(tail)
    expect(parsed.title).toBe('Port the session watcher')
    expect(parsed.lastPrompt).toBe('port the watcher')
    expect(parsed.sessionId).toBe('abc-123')
    expect(parsed.gitBranch).toBe('main')
    expect(parsed.permissionMode).toBe('plan')
    expect(parsed.model).toBe('claude-opus-5')
  })

  it('never reports the synthetic model', () => {
    const tail = jsonl([
      assistant([{ type: 'text', text: 'On it.' }]),
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [] } }
    ])
    expect(parseTail(tail).model).toBe('claude-opus-5')
  })

  it('sums the context tokens of the last assistant turn carrying usage', () => {
    const tail = jsonl([
      assistant([{ type: 'text', text: 'first' }], {}),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'second' }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 1000
          }
        }
      }
    ])
    expect(parseTail(tail).contextTokens).toBe(1110)
  })

  it('leaves the context tokens undefined when the tail carries no usage', () => {
    expect(parseTail(jsonl([assistant([{ type: 'text', text: 'hi' }])])).contextTokens).toBeUndefined()
  })

  it('ignores a sidechain turn when reading the context tokens', () => {
    const tail = jsonl([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'main' }],
          usage: { input_tokens: 5, cache_read_input_tokens: 5 }
        }
      },
      {
        type: 'assistant',
        isSidechain: true,
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'subagent' }],
          usage: { input_tokens: 9999 }
        }
      }
    ])
    expect(parseTail(tail).contextTokens).toBe(10)
  })
})
