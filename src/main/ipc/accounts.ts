import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import type { ClaudeAccount } from '../../shared/types'
import {
  AccountError,
  addAccount,
  listAccounts,
  removeAccount,
  validateAddAccountInput
} from '../accounts'
import { beginMint, cancelMint, completeMint } from '../accountMint'
import { log } from '../log'
import type { IpcCtx } from './index'

/**
 * The accounts surface. Credentials never cross this boundary outward: the
 * renderer sends a secret in (add / paste-the-token) and from then on only ever
 * sees the public `ClaudeAccount`, whose `hasSecret` is all it needs.
 *
 * Every payload arrives as `unknown` and is narrowed here — these handlers sit
 * directly on top of code that creates directories and renames them, so nothing
 * from the renderer is ever forwarded as a whole object. Failures come back as
 * plain result objects (an `ipcMain.handle` throw would reach the renderer as an
 * opaque rejection), and only messages this app wrote itself are passed on:
 * anything else could carry an absolute path or a keychain internal, so it is
 * logged main-side and reported generically.
 */

type MintResult = { ok: true; account: ClaudeAccount } | { ok: false; error: string }

const GENERIC_ADD_ERROR = 'That Claude account could not be saved.'
const GENERIC_MINT_ERROR = 'That sign-in could not be started.'

function publicMessage(error: unknown, fallback: string): string {
  if (error instanceof AccountError) return error.message
  log.warn('accounts:', error instanceof Error ? error.message : String(error))
  return fallback
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Push the fresh list after any mutation; every window reads the same truth. */
function broadcastAccounts(ctx: IpcCtx): void {
  ctx.send(CH.accountsChanged, listAccounts())
}

/**
 * Turn a captured or pasted token into an account and tell the renderer how it
 * went. Shared by the paste channel and the PTY auto-capture path so both
 * broadcast the same two events — and so the token, which main already holds,
 * never has to travel anywhere to be used.
 */
export function finishMintFromOutput(ctx: IpcCtx, ptyId: string, token: string): MintResult {
  let result: MintResult
  try {
    const account = completeMint(ptyId, token)
    broadcastAccounts(ctx)
    result = { ok: true, account }
  } catch (error) {
    result = { ok: false, error: publicMessage(error, GENERIC_ADD_ERROR) }
  }
  ctx.send(CH.accountsMintDone, {
    ptyId,
    ok: result.ok,
    ...(result.ok ? { account: result.account } : { error: result.error })
  })
  return result
}

export function registerAccountsIpc(ctx: IpcCtx): void {
  ipcMain.handle(CH.accountsList, () => listAccounts())

  ipcMain.handle(CH.accountsAdd, (_event, payload: unknown) => {
    try {
      // Rebuilt field by field: the payload must not be able to carry options
      // (a config dir to adopt, above all) the renderer was never offered.
      const account = addAccount(validateAddAccountInput(payload))
      broadcastAccounts(ctx)
      return { ok: true as const, account }
    } catch (error) {
      return { ok: false as const, error: publicMessage(error, GENERIC_ADD_ERROR) }
    }
  })

  ipcMain.handle(CH.accountsRemove, (_event, payload: unknown) => {
    try {
      const id = asString(payload)
      if (!id) return false
      removeAccount(id)
      broadcastAccounts(ctx)
      return true
    } catch (error) {
      publicMessage(error, GENERIC_ADD_ERROR)
      return false
    }
  })

  ipcMain.handle(CH.accountsBeginMint, (_event, payload: unknown) => {
    try {
      if (!isRecord(payload)) throw new AccountError(GENERIC_MINT_ERROR)
      const label = asString(payload['label'])
      if (!label) throw new AccountError('Account label is required.')
      const replaceAccountId = asString(payload['replaceAccountId'])
      return beginMint(label, replaceAccountId ?? undefined)
    } catch (error) {
      return { error: publicMessage(error, GENERIC_MINT_ERROR) }
    }
  })

  // The paste path. Auto-capture reaches the same code from the PTY data
  // stream; either way the token is re-validated before anything is stored.
  ipcMain.handle(CH.accountsCompleteMint, (_event, payload: unknown) => {
    if (!isRecord(payload)) return { ok: false as const, error: GENERIC_ADD_ERROR }
    const ptyId = asString(payload['ptyId'])
    const token = asString(payload['token'])
    if (!ptyId || token === null) return { ok: false as const, error: GENERIC_ADD_ERROR }
    return finishMintFromOutput(ctx, ptyId, token)
  })

  ipcMain.handle(CH.accountsCancelMint, (_event, payload: unknown) => {
    try {
      const ptyId = asString(payload)
      if (ptyId) cancelMint(ptyId)
    } catch (error) {
      publicMessage(error, 'That sign-in could not be cancelled.')
    }
  })
}
