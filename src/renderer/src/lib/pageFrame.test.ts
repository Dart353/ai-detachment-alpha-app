import { describe, expect, it } from 'vitest'
import { baseUrlOf, buildFrameDoc, FRAME_CSP, fileUrl, isFrameScrollMessage } from './pageFrame'

describe('fileUrl and baseUrlOf', () => {
  it('encodes each segment and keeps the slashes', () => {
    expect(fileUrl('/Users/me/my app/a#b.html')).toBe('ada-file://local/Users/me/my%20app/a%23b.html')
  })

  it('points relative links at the file’s own folder', () => {
    expect(baseUrlOf('/Users/me/proj/workbench.html')).toBe('ada-file://local/Users/me/proj/')
  })
})

describe('buildFrameDoc', () => {
  const file = '/p/workbench.html'

  it('goes straight after <head>, ahead of anything the page loads', () => {
    const doc = buildFrameDoc('<!doctype html><html><head lang="x"><title>T</title></head></html>', file)
    expect(doc.startsWith('<!doctype html><html><head lang="x"><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(doc.indexOf('<base href="ada-file://local/p/">')).toBeLessThan(doc.indexOf('<title>'))
  })

  it('keeps the doctype first when the page has no <head>', () => {
    const doc = buildFrameDoc('<!DOCTYPE html><p>hi</p>', file)
    expect(doc.startsWith('<!DOCTYPE html><meta')).toBe(true)
    expect(doc.endsWith('<p>hi</p>')).toBe(true)
  })

  it('prepends to a bare fragment', () => {
    expect(buildFrameDoc('<p>hi</p>', file).startsWith('<meta')).toBe(true)
  })

  it('carries a policy with no network', () => {
    const doc = buildFrameDoc('<p/>', file)
    expect(FRAME_CSP).toContain("default-src 'none'")
    expect(FRAME_CSP).not.toMatch(/https?:/)
    expect(doc).toContain(FRAME_CSP)
  })

  it('restores the given scroll, sanitized to a whole non-negative number', () => {
    expect(buildFrameDoc('<p/>', file, 412.6)).toContain('var y=413;')
    expect(buildFrameDoc('<p/>', file, -5)).toContain('var y=0;')
    expect(buildFrameDoc('<p/>', file, Number.NaN)).toContain('var y=0;')
  })

  it('escapes a folder name that would break out of the base attribute', () => {
    expect(buildFrameDoc('<p/>', '/a"b/x.html')).toContain('<base href="ada-file://local/a%22b/">')
  })
})

describe('isFrameScrollMessage', () => {
  it('accepts only the frame’s own message shape', () => {
    expect(isFrameScrollMessage({ adaFrameScroll: 10 })).toBe(true)
    expect(isFrameScrollMessage({ adaFrameScroll: '10' })).toBe(false)
    expect(isFrameScrollMessage(null)).toBe(false)
    expect(isFrameScrollMessage('x')).toBe(false)
  })
})
