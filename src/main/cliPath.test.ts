import { describe, expect, it, vi } from 'vitest'

vi.mock('./store', () => ({ loadSettings: () => ({ cliPaths: {} }) }))
vi.mock('./platform', () => ({ isWsl: () => false, wslDistro: () => undefined }))

import { parseModelAliases } from './cliPath'

describe('parseModelAliases', () => {
  it('reads the aliases off the --model help text, wrapped as the CLI wraps it', () => {
    const help = `  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').`
    expect(parseModelAliases(help)).toEqual(['fable', 'opus', 'sonnet'])
  })

  it('finds nothing in help that has no such line', () => {
    expect(parseModelAliases('Usage: claude [options]')).toEqual([])
    expect(parseModelAliases('')).toEqual([])
  })
})
