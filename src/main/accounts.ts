import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_ACCOUNT_ID,
  type AddAccountInput,
  type ClaudeAccount,
  type ClaudeAccountBackend
} from '../shared/types'
import { claudeDir } from './platform'

/**
 * Multiple Claude logins in one app.
 *
 * Every extra account gets its OWN config dir under userData, so its identity,
 * transcripts and project state never touch the user's `~/.claude`. Panes bound
 * to an account run with `CLAUDE_CONFIG_DIR` pointed at that dir and with the
 * account's credential in the environment. The credential itself is encrypted
 * by the OS keychain (`safeStorage`) and never leaves the main process — the
 * renderer only ever learns `hasSecret`.
 *
 * `undefined` everywhere means "the user's own ~/.claude": no account record,
 * no env changes, the behaviour of the app before any account was added.
 */

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
export const CLAUDE_SETUP_TOKEN_PREFIX = 'sk-ant-oat01-'
/** Current setup tokens are longer than this. Keeping a conservative floor
 * rejects partial PTY captures without tying manual entry to one exact format. */
export const MIN_CLAUDE_SETUP_TOKEN_LENGTH = 64
const API_KEY_PREFIX = 'sk-ant-'
const MAX_LABEL_LENGTH = 80
/** Only a staging dir the mint flow created may be adopted as a config dir. */
const MINT_DIR_PREFIX = '.mint-'

/**
 * A failure whose message is written for the user and carries nothing private.
 * Anything else that escapes this module (an fs error with an absolute path in
 * it, a keychain internal) is logged main-side and reported generically.
 */
export class AccountError extends Error {
  override name = 'AccountError'
}

/* === persistence ========================================================== */

/** An extra account as written to disk. The default account is never stored. */
interface StoredAccount {
  id: string
  label: string
  backend: Exclude<ClaudeAccountBackend, 'default'>
  configDir: string
  /** epoch ms */
  addedAt: number
  /** Which generation of the shared-pieces layout this dir has been through. */
  sharesVersion?: number
}

interface AccountStore {
  accounts: StoredAccount[]
  /** account id → base64 of the keychain-encrypted credential. */
  secrets: Record<string, string>
}

const STORE_FILE = 'ada-accounts.json'

let overrideDir: string | null = null

/**
 * Point account persistence somewhere else — the unit tests use a temp dir.
 * Set before the first read/write so nothing lands in the real profile.
 */
export function setAccountsDir(dir: string): void {
  overrideDir = dir
}

function userDataDir(): string {
  if (overrideDir) return overrideDir
  // Electron is required lazily, and only on the path that actually needs it,
  // so this module can be imported by a plain vitest run (no Electron runtime)
  // as long as the test points it at a temp dir first.
  const electron = require('electron') as typeof import('electron')
  return electron.app.getPath('userData')
}

/** Where every account's isolated config dir lives. */
export function accountsRoot(): string {
  return path.join(userDataDir(), 'claude-accounts')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** One entry survives loading only if every field it is used by is intact. */
function validAccount(raw: unknown): StoredAccount | null {
  if (!isRecord(raw)) return null
  const { id, label, backend, configDir, addedAt, sharesVersion } = raw
  if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) return null
  if (typeof label !== 'string' || !label) return null
  if (backend !== 'api-key' && backend !== 'subscription') return null
  if (typeof configDir !== 'string' || !configDir) return null
  return {
    id,
    label,
    backend,
    configDir,
    addedAt: typeof addedAt === 'number' ? addedAt : 0,
    ...(typeof sharesVersion === 'number' ? { sharesVersion } : {})
  }
}

function loadStore(): AccountStore {
  let raw: unknown = null
  try {
    raw = JSON.parse(fs.readFileSync(path.join(userDataDir(), STORE_FILE), 'utf8'))
  } catch {
    // Absent or corrupt reads as "no accounts yet", never as a crash.
  }
  if (!isRecord(raw)) return { accounts: [], secrets: {} }
  const accounts = Array.isArray(raw['accounts'])
    ? raw['accounts'].map(validAccount).filter((entry): entry is StoredAccount => entry !== null)
    : []
  const secrets: Record<string, string> = {}
  if (isRecord(raw['secrets'])) {
    for (const [id, ciphertext] of Object.entries(raw['secrets'])) {
      if (typeof ciphertext === 'string') secrets[id] = ciphertext
    }
  }
  return { accounts, secrets }
}

/**
 * Write failures are NOT swallowed: an account whose record never reached the
 * disk would be reported as added and then vanish on the next launch, so the
 * error travels back to the caller and out to the user.
 */
function saveStore(store: AccountStore): void {
  const file = path.join(userDataDir(), STORE_FILE)
  // Temp file + rename, so a crash mid-write leaves the previous file intact
  // rather than a truncated one. The PID keeps two instances on one profile
  // from racing on a single shared temp path. 0600 because the ciphertext in
  // here is only as private as the file holding it.
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/* === secrets ============================================================== */

/** The encrypt/decrypt pair; injectable so tests need no keychain. */
export interface SecretCodec {
  /** plaintext → base64 ciphertext */
  encrypt(secret: string): string
  /** base64 ciphertext → plaintext */
  decrypt(ciphertext: string): string
}

let codec: SecretCodec | null = null

export function setSecretCodec(next: SecretCodec | null): void {
  codec = next
}

/**
 * The real codec: the OS keychain. When it is unavailable we throw rather than
 * fall back to plaintext — a credential on disk in the clear is worse than an
 * account that cannot be added.
 */
function keychainCodec(): SecretCodec {
  const { safeStorage } = require('electron') as typeof import('electron')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new AccountError(
      'The OS keychain is unavailable, so Claude account credentials cannot be stored securely.'
    )
  }
  return {
    encrypt: (secret) => safeStorage.encryptString(secret).toString('base64'),
    decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
  }
}

function secretCodec(): SecretCodec {
  return codec ?? keychainCodec()
}

function accountSecret(id: string): string | null {
  const ciphertext = loadStore().secrets[id]
  if (!ciphertext) return null
  try {
    return secretCodec().decrypt(ciphertext)
  } catch {
    // An undecryptable secret (keychain rotated, profile copied between
    // machines) reads as "no credential", which the caller reports honestly.
    return null
  }
}

/* === validation =========================================================== */

/**
 * Rebuild an add-account request from an untrusted IPC payload, field by field.
 * Passing the payload through would let a renderer smuggle in fields the caller
 * never meant to accept — `adoptConfigDir` above all, which renames a directory.
 */
export function validateAddAccountInput(payload: unknown): AddAccountInput {
  if (!isRecord(payload)) throw new AccountError('That account could not be read.')
  const { label, backend, apiKey, oauthToken } = payload
  if (typeof label !== 'string' || !label.trim()) {
    throw new AccountError('Account label is required.')
  }
  if (label.length > MAX_LABEL_LENGTH) {
    throw new AccountError(`An account label is at most ${MAX_LABEL_LENGTH} characters.`)
  }
  if (backend !== 'api-key' && backend !== 'subscription') {
    throw new AccountError('Choose an API key or a subscription sign-in.')
  }
  return {
    label,
    backend,
    ...(typeof apiKey === 'string' ? { apiKey } : {}),
    ...(typeof oauthToken === 'string' ? { oauthToken } : {})
  }
}

function validatedSetupToken(value: string | undefined): string {
  const token = value?.trim() ?? ''
  if (!token) throw new AccountError('A long-lived token from `claude setup-token` is required.')
  // A truncated token caused a 401 on every new session, so length is checked
  // as strictly as the prefix: a partial PTY capture must never be stored.
  if (
    !token.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) ||
    token.length < MIN_CLAUDE_SETUP_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new AccountError(
      'That setup-token credential is incomplete or invalid. Mint a fresh token and paste the entire value.'
    )
  }
  return token
}

function validatedApiKey(value: string | undefined): string {
  const key = value?.trim() ?? ''
  if (!key) throw new AccountError('An Anthropic API key is required.')
  if (!key.startsWith(API_KEY_PREFIX)) {
    throw new AccountError(`An Anthropic API key starts with ${API_KEY_PREFIX}.`)
  }
  return key
}

/* === the account list ===================================================== */

function publicAccount(account: StoredAccount, hasSecret: boolean): ClaudeAccount {
  return {
    id: account.id,
    label: account.label,
    backend: account.backend,
    configDir: account.configDir,
    addedAt: account.addedAt,
    hasSecret
  }
}

/** The built-in account: the user's own ~/.claude, with no stored credential. */
export function defaultAccount(): ClaudeAccount {
  return {
    id: DEFAULT_ACCOUNT_ID,
    label: 'Default',
    backend: 'default',
    configDir: '',
    addedAt: 0,
    hasSecret: false
  }
}

/** Every account, default first. Secrets are reported only as `hasSecret`. */
export function listAccounts(): ClaudeAccount[] {
  const store = loadStore()
  return [
    defaultAccount(),
    ...store.accounts.map((account) => publicAccount(account, Boolean(store.secrets[account.id])))
  ]
}

export function hasExtraAccounts(): boolean {
  return loadStore().accounts.length > 0
}

export function findAccount(id: string | undefined): ClaudeAccount | null {
  if (!id || id === DEFAULT_ACCOUNT_ID) return defaultAccount()
  return listAccounts().find((account) => account.id === id) ?? null
}

function slug(value: string): string {
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return clean || 'account'
}

function uniqueId(label: string, taken: Set<string>): string {
  const base = slug(label)
  let id = base
  let suffix = 2
  while (taken.has(id) || id === DEFAULT_ACCOUNT_ID) id = `${base}-${suffix++}`
  return id
}

/** Add an account with a credential the user supplied, in a fresh config dir. */
export function addAccount(input: AddAccountInput): ClaudeAccount {
  return createAccount(input)
}

/**
 * Add an account that adopts a staging config dir, so whatever state the
 * `claude setup-token` sign-in wrote becomes the account's state. Only the mint
 * flow may call this, and only with a dir it created: the path is asserted to be
 * a direct child of the accounts root named like a staging dir, because adopting
 * an arbitrary directory would rename it into place and clobber its contents.
 */
export function addAccountFromMint(input: AddAccountInput, stagingDir: string): ClaudeAccount {
  const resolved = path.resolve(stagingDir)
  if (
    path.dirname(resolved) !== path.resolve(accountsRoot()) ||
    !path.basename(resolved).startsWith(MINT_DIR_PREFIX)
  ) {
    throw new AccountError('That sign-in did not run in a staging area this app created.')
  }
  return createAccount(input, resolved)
}

function createAccount(input: AddAccountInput, adoptConfigDir?: string): ClaudeAccount {
  const label = input.label.trim()
  if (!label) throw new AccountError('Account label is required.')
  const secret =
    input.backend === 'subscription'
      ? validatedSetupToken(input.oauthToken)
      : validatedApiKey(input.apiKey)
  // Encrypt before anything touches the disk. A keychain that refuses here would
  // otherwise leave an orphaned config dir behind and burn the name it took.
  const ciphertext = secretCodec().encrypt(secret)

  const store = loadStore()
  const root = accountsRoot()
  // A removed account's config dir stays on disk (its transcripts are the
  // user's history); a new account must never adopt or rename into it. Names
  // already sitting in the accounts root count as taken alongside store ids.
  const taken = new Set(store.accounts.map((account) => account.id))
  try {
    for (const entry of fs.readdirSync(root)) taken.add(entry)
  } catch {
    // No accounts root yet; nothing extra is taken.
  }
  const id = uniqueId(label, taken)
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new AccountError('Could not create a safe account identifier.')
  }
  const configDir = path.join(root, id)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  if (adoptConfigDir && fs.existsSync(adoptConfigDir)) {
    fs.renameSync(adoptConfigDir, configDir)
  } else {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  }
  const account: StoredAccount = {
    id,
    label,
    backend: input.backend,
    configDir,
    addedAt: Date.now(),
    sharesVersion: ACCOUNT_SHARES_VERSION
  }
  // Make the new profile feel like the user's own from its first launch:
  // shared pieces linked in, onboarding pre-answered, theme carried over.
  ensureSharedUserPieces(configDir, undefined, 'adopt')
  seedAccountClaudeJson(configDir)
  store.accounts.push(account)
  store.secrets[id] = ciphertext
  saveStore(store)
  return publicAccount(account, true)
}

/** Replace a subscription account's credential without disturbing its config,
 * transcripts, id, or any workspace and pane assignments that refer to it. */
export function replaceAccountOauthToken(id: string, oauthToken: string): ClaudeAccount {
  const token = validatedSetupToken(oauthToken)
  const store = loadStore()
  const account = store.accounts.find((entry) => entry.id === id)
  if (!account) throw new AccountError('That Claude account no longer exists.')
  if (account.backend !== 'subscription') {
    throw new AccountError('Only subscription accounts use setup-token credentials.')
  }
  store.secrets[id] = secretCodec().encrypt(token)
  saveStore(store)
  return publicAccount(account, true)
}

/**
 * Forget an account. Its config dir is deliberately left on disk: the
 * transcripts in it are the user's own history, and the name staying taken is
 * what stops a later account adopting the leftovers.
 */
export function removeAccount(id: string): void {
  if (id === DEFAULT_ACCOUNT_ID) {
    throw new AccountError('The default Claude account cannot be removed.')
  }
  const store = loadStore()
  store.accounts = store.accounts.filter((account) => account.id !== id)
  delete store.secrets[id]
  saveStore(store)
}

/* === the environment a pane runs under ==================================== */

/** The credentials one pane runs under, flattened to what the env needs. */
export interface AccountEnv {
  /** CLAUDE_CONFIG_DIR for this account; absent = the user's default. */
  configDir?: string
  apiKey?: string
  /** Long-lived `claude setup-token` credential; pins the pane to its own login. */
  oauthToken?: string
}

/** The account a pane runs under, or undefined for the default. */
export function resolveAccountEnv(accountId?: string): AccountEnv | undefined {
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) return undefined
  const store = loadStore()
  const account = store.accounts.find((entry) => entry.id === accountId)
  // An id with no record left (the account was removed while a pane still
  // referred to it) falls back to the legacy path rather than failing to spawn.
  if (!account) return undefined
  const secret = accountSecret(account.id)
  if (!secret) throw new AccountError(`Claude account ${account.label} has no stored credential.`)
  // Cheap lstat pass per spawn: recreate missing share links, and fold a
  // settings.json that a CLI write un-linked back into the shared source.
  ensureSharedUserPieces(account.configDir, undefined, 'heal')
  return account.backend === 'subscription'
    ? { configDir: account.configDir, oauthToken: secret }
    : { configDir: account.configDir, apiKey: secret }
}

/**
 * Stamp an account onto a child environment.
 *
 * Every credential variable is deleted first, unconditionally: the parent
 * process may well have `ANTHROPIC_API_KEY` set from the user's own shell, and
 * a pane bound to a subscription account must not silently inherit it. Only
 * what this account actually carries is put back.
 */
export function applyAccountEnv(
  env: Record<string, string | undefined>,
  account: AccountEnv | undefined
): void {
  if (!account) return
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  delete env.CLAUDE_CONFIG_DIR
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir
  if (account.apiKey) env.ANTHROPIC_API_KEY = account.apiKey
  if (account.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = account.oauthToken
}

/** The config dir an account's panes run under; the user's own for the default. */
export function accountConfigDir(accountId?: string): string {
  const account = findAccount(accountId)
  return account?.configDir || claudeDir()
}

/** Where this account's session transcripts live; undefined = the default root. */
export function accountProjectsRoot(accountId?: string): string | undefined {
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) return undefined
  const account = loadStore().accounts.find((entry) => entry.id === accountId)
  return account ? path.join(account.configDir, 'projects') : undefined
}

/**
 * Claim a spawn as the PTY half of an in-flight `claude setup-token` run.
 * False means "no such pending mint", and the spawn is refused.
 */
export function mintForSpawn(ptyId: string, configDir: string): boolean {
  return mintModule().mintForSpawn(ptyId, configDir)
}

/**
 * The command a pending mint is allowed to run, or null when the spawn matches
 * no pending mint. The PTY path spawns THIS rather than whatever command the
 * renderer sent, so a mint spawn can never be turned into an arbitrary one.
 */
export function mintCommandFor(ptyId: string, configDir: string): string | null {
  return mintModule().mintCommandFor(ptyId, configDir)
}

/**
 * Required lazily to break a cycle: the mint module owns the pending registry
 * and needs this module for validation and account creation, while the PTY IPC
 * only ever imports these checks from here.
 */
function mintModule(): typeof import('./accountMint') {
  return require('./accountMint') as typeof import('./accountMint')
}

/* === shared user pieces =================================================== */
/**
 * A second account's config dir keeps its own identity, transcripts, and
 * project state, but the pieces that make Claude Code feel like YOURS (skills,
 * commands, agents, plugins, settings.json, the global CLAUDE.md) should be
 * the same in every account. They are symlinked from the default `~/.claude`
 * into each account dir.
 *
 * Two maintenance modes:
 *  - `adopt` (account creation, one-time migration): anything already sitting
 *    at a shared path is moved aside to `<name>.pre-share` and replaced with
 *    the link.
 *  - `heal` (every account-pane spawn): cheap lstat pass that re-creates
 *    missing links. settings.json gets one extra grace: if a CLI settings
 *    write ever replaced the link with a real file (temp-file-plus-rename
 *    writes do that), the diverged content is written back to the shared
 *    source and the link restored, so an account pane's /config change lands
 *    in the shared settings instead of silently forking them.
 */
const SHARED_DIRS = ['skills', 'commands', 'agents', 'plugins']
const SHARED_FILES = ['settings.json', 'CLAUDE.md']
export const ACCOUNT_SHARES_VERSION = 1

function linkInto(target: string, source: string, isDir: boolean): void {
  try {
    // Windows directory links need no privilege as junctions; 'file' type is
    // ignored off-Windows. A refused file symlink falls back to a one-time copy.
    fs.symlinkSync(
      source,
      target,
      isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'
    )
  } catch {
    if (!isDir) {
      try {
        fs.copyFileSync(source, target)
      } catch {
        // Unreadable source; the pane simply runs without this piece.
      }
    }
  }
}

export function ensureSharedUserPieces(
  configDir: string,
  sourceDir: string = claudeDir(),
  mode: 'adopt' | 'heal' = 'heal'
): void {
  const entries = [
    ...SHARED_DIRS.map((name) => ({ name, isDir: true })),
    ...SHARED_FILES.map((name) => ({ name, isDir: false }))
  ]
  for (const { name, isDir } of entries) {
    const source = path.join(sourceDir, name)
    const target = path.join(configDir, name)
    let sourceStat: fs.Stats
    try {
      sourceStat = fs.statSync(source)
    } catch {
      continue
    }
    if (sourceStat.isDirectory() !== isDir) continue
    let targetStat: fs.Stats | null
    try {
      targetStat = fs.lstatSync(target)
    } catch {
      targetStat = null
    }
    if (targetStat?.isSymbolicLink()) {
      // A link is only the right link if it still points at the shared source;
      // one aimed anywhere else (a stale dir from an older layout, or something
      // that redirected the account's settings) is replaced.
      let linked = ''
      try {
        linked = path.resolve(configDir, fs.readlinkSync(target))
      } catch {
        // Unreadable link: treat it as wrong and rebuild it.
      }
      if (linked === path.resolve(source)) continue
      try {
        fs.rmSync(target)
      } catch {
        continue
      }
      linkInto(target, source, isDir)
      continue
    }
    if (targetStat === null) {
      linkInto(target, source, isDir)
      continue
    }
    // A real file or dir sits where the link belongs.
    if (mode === 'adopt') {
      try {
        fs.renameSync(target, `${target}.pre-share`)
        linkInto(target, source, isDir)
      } catch {
        // Leave the existing piece in place rather than half-move it.
      }
    } else if (!isDir && name === 'settings.json') {
      // Heal: propagate the diverged settings back into the shared source,
      // then relink. Invalid JSON is quarantined instead of propagated.
      try {
        const content = fs.readFileSync(target, 'utf8')
        JSON.parse(content)
        fs.writeFileSync(source, content)
        fs.rmSync(target)
        linkInto(target, source, false)
      } catch {
        try {
          fs.renameSync(target, `${target}.pre-share`)
          linkInto(target, source, false)
        } catch {
          // Unquarantinable; leave it diverged.
        }
      }
    }
  }
}

/**
 * Pre-seed a new account's `.claude.json` so a fresh profile skips the
 * first-run interview and keeps the user's look: onboarding marked done,
 * theme and the bypass-permissions consent carried over when the default
 * profile has them. Existing keys in the account file always win.
 */
export function seedAccountClaudeJson(configDir: string, sourceDir: string = claudeDir()): void {
  const seed: Record<string, unknown> = { hasCompletedOnboarding: true }
  try {
    const main: unknown = JSON.parse(
      fs.readFileSync(path.join(path.dirname(sourceDir), '.claude.json'), 'utf8')
    )
    if (isRecord(main)) {
      if (main['theme']) seed['theme'] = main['theme']
      if (main['bypassPermissionsModeAccepted'] === true) {
        seed['bypassPermissionsModeAccepted'] = true
      }
    }
  } catch {
    // No readable default profile; the bare onboarding flag still helps.
  }
  const file = path.join(configDir, '.claude.json')
  let existing: Record<string, unknown> = {}
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (isRecord(raw)) existing = raw
  } catch {
    // Fresh or unreadable: start from the seed alone.
  }
  try {
    fs.writeFileSync(file, JSON.stringify({ ...seed, ...existing }, null, 2))
  } catch {
    // A failed seed only costs the first-run niceties.
  }
}

/** Startup pass: retro-fit sharing onto accounts created before it existed. */
export function reconcileAccountShares(): void {
  const store = loadStore()
  let changed = false
  for (const account of store.accounts) {
    if ((account.sharesVersion ?? 0) < ACCOUNT_SHARES_VERSION) {
      ensureSharedUserPieces(account.configDir, undefined, 'adopt')
      seedAccountClaudeJson(account.configDir)
      account.sharesVersion = ACCOUNT_SHARES_VERSION
      changed = true
    } else {
      ensureSharedUserPieces(account.configDir, undefined, 'heal')
    }
  }
  if (changed) saveStore(store)
}
