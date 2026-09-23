import { describe, expect, it } from 'vitest'
import {
  DRAFT_GIVE_UP_MS,
  DRAFT_SETTLE_MS,
  claudeInputReady,
  draftDecision,
  fileMention
} from './draftGate'

const RULE = '─'.repeat(80)

/** Claude Code 2.1's idle screen, as xterm's rows read it. */
const READY = [
  ' ▐▛███▜▌   Claude Code v2.1.280',
  '',
  RULE,
  '❯ Try "fix lint errors"',
  RULE,
  '  ⏵⏵ auto mode on (shift+tab to cycle)'
]

describe('claudeInputReady', () => {
  it('sees the input box between two rules', () => {
    expect(claudeInputReady(READY)).toBe(true)
  })

  it('sees the older boxed `>` input', () => {
    expect(claudeInputReady(['╭' + RULE + '╮', '│ >                │', '╰' + RULE + '╯'])).toBe(true)
  })

  it('waits while only the shell is on screen, even a ❯ prompt', () => {
    expect(claudeInputReady(['~/project main', '❯ claude'])).toBe(false)
  })

  it('waits through the trust dialog', () => {
    const trust = [
      RULE,
      ' Do you trust the files in this folder?',
      RULE,
      ' ❯ 1. Yes, proceed',
      '   2. No, exit',
      ' Enter to confirm · Esc to exit'
    ]
    expect(claudeInputReady(trust)).toBe(false)
  })

  it('does not take a numbered option under a rule for the input', () => {
    expect(claudeInputReady([RULE, '❯ 1. Yes'])).toBe(false)
  })
})

describe('draftDecision', () => {
  const at = { startedAt: 0, rows: READY }

  it('writes once the input box is up and output has settled', () => {
    expect(draftDecision({ ...at, now: 5000, lastOutputAt: 5000 - DRAFT_SETTLE_MS })).toBe('write')
  })

  it('waits while output is still arriving', () => {
    expect(draftDecision({ ...at, now: 5000, lastOutputAt: 4900 })).toBe('wait')
  })

  it('waits while the input box is not up', () => {
    expect(draftDecision({ startedAt: 0, rows: ['$ claude'], now: 5000, lastOutputAt: 0 })).toBe('wait')
  })

  it('gives up eventually', () => {
    expect(
      draftDecision({ startedAt: 0, rows: ['$'], now: DRAFT_GIVE_UP_MS + 1, lastOutputAt: 0 })
    ).toBe('give-up')
  })
})

describe('fileMention', () => {
  it('mentions a plain path with a trailing space', () => {
    expect(fileMention('src/app.ts')).toBe('@src/app.ts ')
  })

  it('quotes a path with whitespace', () => {
    expect(fileMention('docs/my notes.md')).toBe('@"docs/my notes.md" ')
  })

  it('uses forward slashes for a Windows relative path', () => {
    expect(fileMention('src\\main\\index.ts')).toBe('@src/main/index.ts ')
  })
})
