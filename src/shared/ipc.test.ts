import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { API_KEYS, CH } from './ipc'

/**
 * The preload cannot be imported here — it calls `contextBridge` at module load
 * and only exists inside Electron — so the contract is checked against its
 * source text instead: every key of `Api` must appear as a top-level property
 * of the `api` object literal. That is enough to catch the failure mode this
 * guards against: adding a member to `Api` and forgetting to wire it up, which
 * would otherwise surface as `window.api.foo is not a function` at runtime.
 */
const preloadSource = readFileSync(
  fileURLToPath(new URL('../preload/index.ts', import.meta.url)),
  'utf8'
)

describe('API_KEYS', () => {
  it('lists every key exactly once', () => {
    expect(new Set(API_KEYS).size).toBe(API_KEYS.length)
  })

  it('is implemented in full by the preload', () => {
    const missing = API_KEYS.filter((key) => !new RegExp(`^ {2}${key}:`, 'm').test(preloadSource))
    expect(missing).toEqual([])
  })
})

describe('CH', () => {
  it('names every channel exactly once', () => {
    const channels = Object.values(CH)
    expect(new Set(channels).size).toBe(channels.length)
  })
})
