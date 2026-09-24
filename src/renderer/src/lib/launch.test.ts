import { describe, expect, it } from 'vitest'
import type { Pane, PaneKind } from '../../../shared/types'
import { buildLaunchCommand } from './launch'

function pane(kind: PaneKind, over: Partial<Pane> = {}): Pane {
  return { id: 'pane-1', name: 'Pane', kind, cwd: '/p', createdAt: 0, ...over }
}

const SESSION_ID = '0f8c1b2a-3d4e-5f60-7182-93a4b5c6d7e8'

describe('buildLaunchCommand — claude', () => {
  it('is a bare `claude` with nothing to resume', () => {
    expect(buildLaunchCommand(pane('claude'), { hasTranscript: false })).toBe('claude')
  })

  it('resumes only when the transcript still exists', () => {
    const withSession = pane('claude', { sessionId: SESSION_ID })
    expect(buildLaunchCommand(withSession, { hasTranscript: true })).toBe(
      `claude --resume ${SESSION_ID}`
    )
    expect(buildLaunchCommand(withSession, { hasTranscript: false })).toBe('claude')
  })

  it('appends plan mode after the resume flag', () => {
    const planned = pane('claude', { sessionId: SESSION_ID, planMode: true })
    expect(buildLaunchCommand(planned, { hasTranscript: true })).toBe(
      `claude --resume ${SESSION_ID} --permission-mode plan`
    )
    expect(buildLaunchCommand(pane('claude', { planMode: true }), { hasTranscript: false })).toBe(
      'claude --permission-mode plan'
    )
  })

  it('passes model and effort through, and drops ones the CLI would not take', () => {
    expect(
      buildLaunchCommand(pane('claude', { model: 'sonnet', effort: 'max', planMode: true }), {
        hasTranscript: false
      })
    ).toBe('claude --permission-mode plan --model sonnet --effort max')
    expect(buildLaunchCommand(pane('claude', { model: 'claude-opus-5' }), { hasTranscript: false })).toBe(
      'claude --model claude-opus-5'
    )
    for (const model of ['opus; rm -rf /', 'Opus', ' sonnet', '']) {
      expect(buildLaunchCommand(pane('claude', { model }), { hasTranscript: false })).toBe('claude')
    }
    expect(
      buildLaunchCommand(pane('claude', { effort: 'turbo' as unknown as 'max' }), { hasTranscript: false })
    ).toBe('claude')
  })

  it('omits the resume flag for a session id that is not one', () => {
    for (const sessionId of ['../../etc/passwd', 'abc; rm -rf /', 'short', '']) {
      expect(buildLaunchCommand(pane('claude', { sessionId }), { hasTranscript: true })).toBe(
        'claude'
      )
    }
  })

  it('uses a configured CLI path, quoting it only when it has whitespace', () => {
    expect(buildLaunchCommand(pane('claude'), { hasTranscript: false, cliPath: '/opt/bin/claude' }))
      .toBe('/opt/bin/claude')
    expect(
      buildLaunchCommand(pane('claude'), { hasTranscript: false, cliPath: '/opt/my tools/claude' })
    ).toBe(`'/opt/my tools/claude'`)
  })
})

describe('buildLaunchCommand — ssh', () => {
  it('opens a shell on the configured host', () => {
    expect(buildLaunchCommand(pane('ssh', { sshHost: 'build-box' }), { hasTranscript: false })).toBe(
      'ssh build-box'
    )
    expect(
      buildLaunchCommand(pane('ssh', { sshHost: 'me@10.0.0.4:2222' }), { hasTranscript: false })
    ).toBe('ssh me@10.0.0.4:2222')
  })

  it('refuses a missing or unsafe host', () => {
    expect(buildLaunchCommand(pane('ssh'), { hasTranscript: false })).toBeUndefined()
    for (const sshHost of ['box; rm -rf /', 'box $(whoami)', 'box host', '`id`']) {
      expect(buildLaunchCommand(pane('ssh', { sshHost }), { hasTranscript: false })).toBeUndefined()
    }
  })
})

describe('buildLaunchCommand — processless kinds', () => {
  it('leaves terminal panes to the login shell and viewer panes with no process', () => {
    expect(buildLaunchCommand(pane('terminal'), { hasTranscript: false })).toBeUndefined()
    expect(
      buildLaunchCommand(pane('viewer', { filePath: '/p/README.md' }), { hasTranscript: false })
    ).toBeUndefined()
  })
})
