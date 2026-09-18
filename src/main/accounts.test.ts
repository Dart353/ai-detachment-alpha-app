import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT_ID } from '../shared/types'
import {
  accountProjectsRoot,
  accountsRoot,
  addAccount,
  addAccountFromMint,
  applyAccountEnv,
  ensureSharedUserPieces,
  findAccount,
  hasExtraAccounts,
  listAccounts,
  removeAccount,
  resolveAccountEnv,
  setAccountsDir,
  setSecretCodec,
  validateAddAccountInput,
  type AccountEnv
} from './accounts'

/**
 * A stand-in for the OS keychain: reversible, and — the point of reversing the
 * string before encoding — never leaves the plaintext readable in the file the
 * "no plaintext on disk" assertions grep.
 */
const FAKE_CODEC = {
  encrypt: (secret: string): string =>
    Buffer.from([...secret].reverse().join(''), 'utf8').toString('base64'),
  decrypt: (ciphertext: string): string =>
    [...Buffer.from(ciphertext, 'base64').toString('utf8')].reverse().join('')
}

const API_KEY = 'sk-ant-api03-test-key-value'
const TOKEN = `sk-ant-oat01-${'a'.repeat(67)}`

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-accounts-'))
  setAccountsDir(dir)
  setSecretCodec(FAKE_CODEC)
})

afterEach(() => {
  setSecretCodec(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

function storeFile(): string {
  return fs.readFileSync(path.join(dir, 'ada-accounts.json'), 'utf8')
}

describe('applyAccountEnv', () => {
  const inherited = (): Record<string, string | undefined> => ({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-inherited',
    ANTHROPIC_AUTH_TOKEN: 'inherited',
    CLAUDE_CODE_OAUTH_TOKEN: 'inherited',
    CLAUDE_CONFIG_DIR: '/inherited'
  })

  it('leaves the environment untouched for the default account', () => {
    const env = inherited()
    applyAccountEnv(env, undefined)
    expect(env).toEqual(inherited())
  })

  it('replaces every inherited credential with an api-key account', () => {
    const env = inherited()
    applyAccountEnv(env, { configDir: '/accounts/work', apiKey: API_KEY })
    expect(env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/accounts/work',
      ANTHROPIC_API_KEY: API_KEY
    })
  })

  it('replaces every inherited credential with a subscription account', () => {
    const env = inherited()
    applyAccountEnv(env, { configDir: '/accounts/personal', oauthToken: TOKEN })
    expect(env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/accounts/personal',
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN
    })
  })

  it('strips inherited credentials even when the account carries none', () => {
    const env = inherited()
    applyAccountEnv(env, { configDir: '/accounts/staging' } satisfies AccountEnv)
    expect(env).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/accounts/staging' })
  })
})

describe('addAccount', () => {
  it('rejects credentials that are not what they claim to be', () => {
    expect(() => addAccount({ label: 'Work', backend: 'api-key', apiKey: 'nope' })).toThrow()
    expect(() => addAccount({ label: 'Work', backend: 'api-key', apiKey: '' })).toThrow()
    expect(() =>
      addAccount({
        label: 'Work',
        backend: 'subscription',
        oauthToken: `sk-ant-api03-${'a'.repeat(67)}`
      })
    ).toThrow()
    // Long enough to look real, short enough to be a truncated PTY capture.
    expect(() =>
      addAccount({
        label: 'Work',
        backend: 'subscription',
        oauthToken: `sk-ant-oat01-${'a'.repeat(20)}`
      })
    ).toThrow()
    expect(() => addAccount({ label: '  ', backend: 'api-key', apiKey: API_KEY })).toThrow()
    expect(listAccounts()).toHaveLength(1)
  })

  it('keeps the secret off disk and out of the list', () => {
    const account = addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })
    expect(account.hasSecret).toBe(true)
    expect(storeFile()).not.toContain(API_KEY)
    const listed = listAccounts()
    expect(listed[0]?.id).toBe(DEFAULT_ACCOUNT_ID)
    expect(listed[1]).toEqual({
      id: 'work',
      label: 'Work',
      backend: 'api-key',
      configDir: path.join(dir, 'claude-accounts', 'work'),
      addedAt: account.addedAt,
      hasSecret: true
    })
    expect(JSON.stringify(listed)).not.toContain(API_KEY)
    expect(hasExtraAccounts()).toBe(true)
  })

  it('creates the account config dir', () => {
    const account = addAccount({ label: 'Personal', backend: 'subscription', oauthToken: TOKEN })
    expect(fs.statSync(account.configDir).isDirectory()).toBe(true)
  })

  it('uniquifies ids, and a removed account keeps its name taken', () => {
    const first = addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })
    const second = addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })
    expect(first.id).toBe('work')
    expect(second.id).toBe('work-2')

    removeAccount('work')
    expect(findAccount('work')).toBeNull()
    // The removed dir is still on disk (its transcripts are user history), so
    // the next "Work" must not adopt it.
    const third = addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })
    expect(third.id).toBe('work-3')
    expect(fs.existsSync(path.join(dir, 'claude-accounts', 'work'))).toBe(true)
  })

  it('refuses to remove the default account', () => {
    expect(() => removeAccount(DEFAULT_ACCOUNT_ID)).toThrow()
  })

  it('leaves no directory and no burnt name behind when the keychain refuses', () => {
    setSecretCodec({
      encrypt: () => {
        throw new Error('keychain locked')
      },
      decrypt: () => ''
    })
    expect(() => addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })).toThrow()
    expect(fs.existsSync(path.join(dir, 'claude-accounts', 'work'))).toBe(false)
    expect(listAccounts()).toHaveLength(1)

    // The retry takes the name the failed attempt would otherwise have burnt.
    setSecretCodec(FAKE_CODEC)
    expect(addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY }).id).toBe('work')
  })

  it('reports a failed write instead of a phantom account', () => {
    // A directory where the store file belongs: the rename onto it cannot work.
    fs.mkdirSync(path.join(dir, 'ada-accounts.json'), { recursive: true })
    expect(() => addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })).toThrow()
  })
})

describe('validateAddAccountInput', () => {
  it('rebuilds the request from known fields only', () => {
    expect(
      validateAddAccountInput({
        label: 'Work',
        backend: 'api-key',
        apiKey: API_KEY,
        adoptConfigDir: '/etc',
        extra: 1
      })
    ).toEqual({ label: 'Work', backend: 'api-key', apiKey: API_KEY })
  })

  it('rejects anything it cannot read as a request', () => {
    expect(() => validateAddAccountInput(null)).toThrow()
    expect(() => validateAddAccountInput('work')).toThrow()
    expect(() => validateAddAccountInput({ backend: 'api-key' })).toThrow()
    expect(() => validateAddAccountInput({ label: '   ', backend: 'api-key' })).toThrow()
    expect(() => validateAddAccountInput({ label: 'a'.repeat(81), backend: 'api-key' })).toThrow()
    expect(() => validateAddAccountInput({ label: 'Work', backend: 'default' })).toThrow()
    expect(() => validateAddAccountInput({ label: 'Work' })).toThrow()
  })
})

describe('addAccountFromMint', () => {
  const input = { label: 'Personal', backend: 'subscription' as const, oauthToken: TOKEN }

  it('adopts only a staging dir inside the accounts root', () => {
    const outsider = path.join(dir, '.mint-elsewhere')
    fs.mkdirSync(outsider, { recursive: true })
    expect(() => addAccountFromMint(input, outsider)).toThrow(/staging area/)
    expect(fs.existsSync(outsider)).toBe(true)

    const notStaging = path.join(accountsRoot(), 'someone-elses-account')
    fs.mkdirSync(notStaging, { recursive: true })
    expect(() => addAccountFromMint(input, notStaging)).toThrow(/staging area/)
    expect(fs.existsSync(notStaging)).toBe(true)

    const nested = path.join(accountsRoot(), 'nested', '.mint-abc')
    fs.mkdirSync(nested, { recursive: true })
    expect(() => addAccountFromMint(input, nested)).toThrow(/staging area/)
  })

  it('adopts a real staging dir', () => {
    const staging = path.join(accountsRoot(), '.mint-abcdef012345')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'signed-in.json'), '{}')
    const account = addAccountFromMint(input, staging)
    expect(fs.existsSync(path.join(account.configDir, 'signed-in.json'))).toBe(true)
    expect(fs.existsSync(staging)).toBe(false)
  })
})

describe('resolveAccountEnv', () => {
  it('answers undefined for the default account and for unknown ids', () => {
    expect(resolveAccountEnv()).toBeUndefined()
    expect(resolveAccountEnv(DEFAULT_ACCOUNT_ID)).toBeUndefined()
    expect(resolveAccountEnv('gone')).toBeUndefined()
  })

  it('answers the stored credential for an extra account', () => {
    const apiAccount = addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })
    const tokenAccount = addAccount({
      label: 'Personal',
      backend: 'subscription',
      oauthToken: TOKEN
    })
    expect(resolveAccountEnv(apiAccount.id)).toEqual({
      configDir: apiAccount.configDir,
      apiKey: API_KEY
    })
    expect(resolveAccountEnv(tokenAccount.id)).toEqual({
      configDir: tokenAccount.configDir,
      oauthToken: TOKEN
    })
  })

  it('throws when the account exists but its credential does not', () => {
    const account = addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })
    const file = path.join(dir, 'ada-accounts.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { secrets: Record<string, string> }
    stored.secrets = {}
    fs.writeFileSync(file, JSON.stringify(stored))
    expect(() => resolveAccountEnv(account.id)).toThrow(/no stored credential/)
  })
})

describe('accountProjectsRoot', () => {
  it('is undefined for the default account and a subdir for an extra one', () => {
    expect(accountProjectsRoot()).toBeUndefined()
    expect(accountProjectsRoot(DEFAULT_ACCOUNT_ID)).toBeUndefined()
    expect(accountProjectsRoot('gone')).toBeUndefined()
    const account = addAccount({ label: 'Work', backend: 'api-key', apiKey: API_KEY })
    expect(accountProjectsRoot(account.id)).toBe(path.join(account.configDir, 'projects'))
  })
})

describe('ensureSharedUserPieces', () => {
  let sourceDir = ''
  let configDir = ''

  beforeEach(() => {
    sourceDir = path.join(dir, 'home-claude')
    configDir = path.join(dir, 'account-claude')
    fs.mkdirSync(path.join(sourceDir, 'skills'), { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'settings.json'), JSON.stringify({ model: 'opus' }))
    fs.mkdirSync(configDir, { recursive: true })
  })

  it('adopts: links the shared pieces in and moves anything in the way aside', () => {
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{"model":"own"}')
    ensureSharedUserPieces(configDir, sourceDir, 'adopt')

    expect(fs.lstatSync(path.join(configDir, 'skills')).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(configDir, 'settings.json')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(configDir, 'settings.json.pre-share'), 'utf8')).toBe(
      '{"model":"own"}'
    )
    // A piece the source does not have is simply not linked.
    expect(fs.existsSync(path.join(configDir, 'CLAUDE.md'))).toBe(false)
  })

  it('heals: recreates a link that went missing', () => {
    ensureSharedUserPieces(configDir, sourceDir, 'adopt')
    fs.rmSync(path.join(configDir, 'skills'))
    ensureSharedUserPieces(configDir, sourceDir, 'heal')
    expect(fs.lstatSync(path.join(configDir, 'skills')).isSymbolicLink()).toBe(true)
  })

  it('heals: un-forks a settings.json a CLI write replaced with a real file', () => {
    ensureSharedUserPieces(configDir, sourceDir, 'adopt')
    // What a temp-file-plus-rename write leaves behind: a real file, not a link.
    fs.rmSync(path.join(configDir, 'settings.json'))
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{"model":"sonnet"}')

    ensureSharedUserPieces(configDir, sourceDir, 'heal')

    expect(fs.lstatSync(path.join(configDir, 'settings.json')).isSymbolicLink()).toBe(true)
    const healed = '{"model":"sonnet"}'
    expect(fs.readFileSync(path.join(sourceDir, 'settings.json'), 'utf8')).toBe(healed)
    expect(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).toBe(healed)
  })

  it('heals: replaces a link that points somewhere other than the shared source', () => {
    const impostor = path.join(dir, 'impostor-settings.json')
    fs.writeFileSync(impostor, '{"model":"impostor"}')
    fs.symlinkSync(impostor, path.join(configDir, 'settings.json'))

    ensureSharedUserPieces(configDir, sourceDir, 'heal')

    expect(fs.realpathSync(path.join(configDir, 'settings.json'))).toBe(
      fs.realpathSync(path.join(sourceDir, 'settings.json'))
    )
    expect(fs.readFileSync(impostor, 'utf8')).toBe('{"model":"impostor"}')
  })

  it('heals: quarantines a diverged settings.json that is not valid JSON', () => {
    ensureSharedUserPieces(configDir, sourceDir, 'adopt')
    fs.rmSync(path.join(configDir, 'settings.json'))
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ not json')

    ensureSharedUserPieces(configDir, sourceDir, 'heal')

    expect(fs.lstatSync(path.join(configDir, 'settings.json')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(configDir, 'settings.json.pre-share'), 'utf8')).toBe(
      '{ not json'
    )
    expect(fs.readFileSync(path.join(sourceDir, 'settings.json'), 'utf8')).toBe('{"model":"opus"}')
  })
})
