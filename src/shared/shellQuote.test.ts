import { describe, expect, it } from 'vitest'
import { shellQuote } from './shellQuote'

describe('shellQuote', () => {
  it('wraps a path in single quotes', () => {
    expect(shellQuote('/home/me/My Tools/claude')).toBe(`'/home/me/My Tools/claude'`)
  })

  it('escapes an embedded single quote', () => {
    expect(shellQuote(`/home/me/it's/claude`)).toBe(`'/home/me/it'\\''s/claude'`)
  })

  it('leaves shell metacharacters literal', () => {
    expect(shellQuote('a; rm -rf /')).toBe(`'a; rm -rf /'`)
  })
})
