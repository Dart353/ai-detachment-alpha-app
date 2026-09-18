import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listAccounts, setAccountsDir, setSecretCodec } from './accounts'
import {
  beginMint,
  cancelMint,
  completeMint,
  createOauthTokenScanner,
  feedMintOutput,
  mintCommandFor,
  mintForSpawn,
  sweepOrphanedMintDirs
} from './accountMint'

const FAKE_CODEC = {
  encrypt: (secret: string): string =>
    Buffer.from([...secret].reverse().join(''), 'utf8').toString('base64'),
  decrypt: (ciphertext: string): string =>
    [...Buffer.from(ciphertext, 'base64').toString('utf8')].reverse().join('')
}

const TOKEN = `sk-ant-oat01-${'a'.repeat(67)}`

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-mint-'))
  setAccountsDir(dir)
  setSecretCodec(FAKE_CODEC)
})

afterEach(() => {
  setSecretCodec(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the mint lifecycle', () => {
  it('stages a sign-in main itself created', () => {
    const mint = beginMint('Personal')
    expect(mint.ptyId).toMatch(/^mint:[0-9a-f]{12}$/)
    expect(mint.command).toBe('claude setup-token')
    expect(fs.statSync(mint.configDir).isDirectory()).toBe(true)
    expect(path.dirname(mint.configDir)).toBe(path.join(dir, 'claude-accounts'))
  })

  it('honours a spawn only for the pending id and its own staging dir', () => {
    const mint = beginMint('Personal')
    expect(mintForSpawn(mint.ptyId, mint.configDir)).toBe(true)
    expect(mintForSpawn(mint.ptyId, path.join(dir, 'elsewhere'))).toBe(false)
    expect(mintForSpawn('mint:deadbeefcafe', mint.configDir)).toBe(false)
  })

  it('hands out its own command rather than trusting the spawn request', () => {
    const mint = beginMint('Personal')
    expect(mintCommandFor(mint.ptyId, mint.configDir)).toBe('claude setup-token')
    expect(mintCommandFor(mint.ptyId, path.join(dir, 'elsewhere'))).toBeNull()
    expect(mintCommandFor('mint:deadbeefcafe', mint.configDir)).toBeNull()
    cancelMint(mint.ptyId)
    expect(mintCommandFor(mint.ptyId, mint.configDir)).toBeNull()
  })

  it('adopts the staging dir as the account config dir on completion', () => {
    const mint = beginMint('Personal')
    fs.writeFileSync(path.join(mint.configDir, 'signed-in.json'), '{"ok":true}')

    const account = completeMint(mint.ptyId, TOKEN)

    expect(account.label).toBe('Personal')
    expect(account.backend).toBe('subscription')
    expect(account.hasSecret).toBe(true)
    expect(fs.existsSync(mint.configDir)).toBe(false)
    expect(fs.readFileSync(path.join(account.configDir, 'signed-in.json'), 'utf8')).toBe(
      '{"ok":true}'
    )
    expect(listAccounts().map((entry) => entry.id)).toEqual(['default', 'personal'])
    // The spawn claim is spent along with the mint.
    expect(mintForSpawn(mint.ptyId, mint.configDir)).toBe(false)
  })

  it('keeps the mint alive when the token is rejected', () => {
    const mint = beginMint('Personal')
    expect(() => completeMint(mint.ptyId, 'sk-ant-oat01-short')).toThrow()
    expect(mintForSpawn(mint.ptyId, mint.configDir)).toBe(true)
    expect(completeMint(mint.ptyId, TOKEN).id).toBe('personal')
  })

  it('swaps the token in place when the mint replaces an account', () => {
    const first = completeMint(beginMint('Personal').ptyId, TOKEN)
    const replacement = beginMint('Personal', first.id)
    const rotated = `sk-ant-oat01-${'b'.repeat(67)}`

    const account = completeMint(replacement.ptyId, rotated)

    expect(account.id).toBe(first.id)
    expect(account.configDir).toBe(first.configDir)
    expect(fs.existsSync(replacement.configDir)).toBe(false)
    expect(listAccounts()).toHaveLength(2)
  })

  it('refuses to replace an account that is not a subscription one', () => {
    expect(() => beginMint('Personal', 'nobody')).toThrow()
    expect(() => beginMint('   ')).toThrow()
  })

  it('removes the staging dir on cancel', () => {
    const mint = beginMint('Personal')
    cancelMint(mint.ptyId)
    expect(fs.existsSync(mint.configDir)).toBe(false)
    expect(mintForSpawn(mint.ptyId, mint.configDir)).toBe(false)
    // Cancelling twice is not an error.
    cancelMint(mint.ptyId)
  })

  it('sweeps staging dirs a crash left behind, but never a live one', () => {
    const live = beginMint('Personal')
    const orphan = path.join(dir, 'claude-accounts', '.mint-0123456789ab')
    fs.mkdirSync(orphan, { recursive: true })

    sweepOrphanedMintDirs()

    expect(fs.existsSync(orphan)).toBe(false)
    expect(fs.existsSync(live.configDir)).toBe(true)
  })

  it('feeds the output of a pending mint through its own scanner', () => {
    const mint = beginMint('Personal')
    expect(feedMintOutput(mint.ptyId, `Your token: ${TOKEN.slice(0, 40)}`)).toBeNull()
    expect(feedMintOutput(mint.ptyId, `${TOKEN.slice(40)}\n`)).toBe(TOKEN)
    // Once only: the scanner still matches its tail on every later repaint.
    expect(feedMintOutput(mint.ptyId, 'redrawn\n')).toBeNull()
    expect(feedMintOutput('mint:deadbeefcafe', `${TOKEN}\n`)).toBeNull()
  })
})

describe('the oauth token scanner', () => {
  it('captures a whole token followed by a delimiter', () => {
    expect(createOauthTokenScanner().feed(`token: ${TOKEN}\n`)).toBe(TOKEN)
  })

  it('never captures a token that has not ended yet', () => {
    const scanner = createOauthTokenScanner()
    expect(scanner.feed(`token: ${TOKEN}`)).toBeNull()
    expect(scanner.feed(' ')).toBe(TOKEN)
  })

  it('captures a token split across chunks at any boundary', () => {
    for (const cut of [1, 13, 14, 40, 79]) {
      const scanner = createOauthTokenScanner()
      expect(scanner.feed(`token: ${TOKEN.slice(0, cut)}`)).toBeNull()
      expect(scanner.feed(`${TOKEN.slice(cut)}\r\n`)).toBe(TOKEN)
    }
  })

  it('captures a token byte by byte', () => {
    const scanner = createOauthTokenScanner()
    let captured: string | null = null
    for (const char of `${TOKEN}\n`) captured = scanner.feed(char) ?? captured
    expect(captured).toBe(TOKEN)
  })

  it('sees through styling emitted mid-token', () => {
    const styled = `\x1b[1mtoken:\x1b[0m ${TOKEN.slice(0, 30)}\x1b[32m${TOKEN.slice(30)}\x1b[0m\n`
    expect(createOauthTokenScanner().feed(styled)).toBe(TOKEN)
  })

  it('sees through an indented terminal line wrap', () => {
    const wrapped = `token: ${TOKEN.slice(0, 50)}\n    ${TOKEN.slice(50)}\n`
    expect(createOauthTokenScanner().feed(wrapped)).toBe(TOKEN)
  })

  it('never captures a prefix on its own', () => {
    const scanner = createOauthTokenScanner()
    expect(scanner.feed('sk-ant-oat01-\n')).toBeNull()
    expect(scanner.feed(`${TOKEN.slice(0, 60)}\n`)).toBeNull()
  })
})
