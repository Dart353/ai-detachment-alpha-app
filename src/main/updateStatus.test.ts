import { describe, expect, it } from 'vitest'
import {
  friendlyUpdateError,
  initialUpdateStatus,
  progressPercent,
  unsupportedReason
} from './updateStatus'

describe('the starting status', () => {
  it('is idle, with nothing found and nothing checked', () => {
    expect(initialUpdateStatus()).toEqual({
      stage: 'idle',
      version: null,
      percent: 0,
      checkedAt: null
    })
  })
})

describe('whether a build can update itself', () => {
  it('refuses a dev run on any platform', () => {
    expect(unsupportedReason({ packaged: false, platform: 'win32', appImage: undefined })).toMatch(
      /installed build/
    )
  })

  it('allows a packaged Windows or macOS build', () => {
    expect(unsupportedReason({ packaged: true, platform: 'win32', appImage: undefined })).toBeNull()
    expect(unsupportedReason({ packaged: true, platform: 'darwin', appImage: undefined })).toBeNull()
  })

  it('allows Linux only when it is running as the AppImage', () => {
    expect(
      unsupportedReason({ packaged: true, platform: 'linux', appImage: '/tmp/ada.AppImage' })
    ).toBeNull()
    expect(unsupportedReason({ packaged: true, platform: 'linux', appImage: undefined })).toMatch(
      /AppImage/
    )
  })
})

describe('download progress', () => {
  it('rounds to a whole percent and clamps to 0–100', () => {
    expect(progressPercent(41.6)).toBe(42)
    expect(progressPercent(-3)).toBe(0)
    expect(progressPercent(140)).toBe(100)
  })

  it('treats a missing or broken reading as zero', () => {
    expect(progressPercent(undefined)).toBe(0)
    expect(progressPercent(Number.NaN)).toBe(0)
  })
})

describe('what an update failure says', () => {
  it('names a network failure rather than quoting errno', () => {
    expect(friendlyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toMatch(
      /could not reach github/i
    )
  })

  it('explains an empty releases list', () => {
    expect(friendlyUpdateError(new Error('HttpError: 404 Not Found'))).toMatch(/no published/i)
  })

  it('keeps an unfamiliar message instead of hiding it', () => {
    expect(friendlyUpdateError(new Error('signature verification failed'))).toBe(
      'signature verification failed'
    )
  })

  it('always says something, even for an empty throw', () => {
    expect(friendlyUpdateError(new Error(''))).toBe('The update check failed.')
    expect(friendlyUpdateError(undefined)).toBe('The update check failed.')
  })
})
