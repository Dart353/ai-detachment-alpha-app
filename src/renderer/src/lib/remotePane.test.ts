import { describe, expect, it } from 'vitest'
import { isInsideFolder, remotePaneFor } from './remotePane'

describe('isInsideFolder', () => {
  it('accepts the root itself and folders below it', () => {
    expect(isInsideFolder('/home/me/reviews', '/home/me/reviews')).toBe(true)
    expect(isInsideFolder('/home/me/reviews/', '/home/me/reviews/api-12')).toBe(true)
    expect(isInsideFolder('C:\\Users\\me\\reviews', 'c:\\users\\me\\reviews\\api-12')).toBe(true)
  })

  it('refuses siblings, prefixes, parents and climbs', () => {
    expect(isInsideFolder('/home/me/reviews', '/home/me/reviews-old')).toBe(false)
    expect(isInsideFolder('/home/me/reviews', '/home/me')).toBe(false)
    expect(isInsideFolder('/home/me/reviews', '/home/me/reviews/../secrets')).toBe(false)
    expect(isInsideFolder('/home/me/reviews', 'home/me/reviews/x')).toBe(false)
    expect(isInsideFolder('/home/me/reviews', '/home/Me/reviews/x')).toBe(false)
  })
})

describe('remotePaneFor', () => {
  const base = { type: 'addPane' as const, workspaceId: 'w1' }

  it('carries the tag, an inside cwd, the prompt and the background flag', () => {
    expect(
      remotePaneFor(
        {
          ...base,
          kind: 'claude',
          name: 'review api#12',
          tag: 'claudeometer:review:acme/api#12',
          cwd: '/home/me/reviews/api-12',
          prompt: '/review-backend-pr api 12 --post',
          background: true
        },
        '/home/me/reviews'
      )
    ).toEqual({
      init: {
        kind: 'claude',
        name: 'review api#12',
        tag: 'claudeometer:review:acme/api#12',
        cwd: '/home/me/reviews/api-12'
      },
      opts: { background: true },
      prompt: '/review-backend-pr api 12 --post'
    })
  })

  it('drops a cwd outside the workspace and a prompt for a terminal', () => {
    expect(
      remotePaneFor({ ...base, kind: 'terminal', cwd: '/etc', prompt: 'rm -rf ~' }, '/home/me/reviews')
    ).toEqual({ init: { kind: 'terminal' }, opts: {} })
  })
})
