import { useState, type JSX } from 'react'
import { Button, Modal, TextInput } from '../ui'
import { useApp } from '../../store/app'
import { useRuntime } from '../../store/runtime'
import { DEFAULT_ACCOUNT_ID, type ClaudeAccount, type Workspace } from '../../../../shared/types'
import AccountMint from './AccountMint'
import './settings.css'

/** The CLIs the accounts screen knows about; only Claude Code is wired up. */
const COMING_LATER = [
  { glyph: '◍', name: 'Codex' },
  { glyph: '✦', name: 'Gemini CLI' }
]

const HINT = 'No keys stored. Panes inherit whatever is in your environment.'

/** The second line under an account's name. */
function describe(account: ClaudeAccount): string {
  if (account.backend === 'default') return 'Your own login'
  if (account.backend === 'api-key') return 'API key'
  return 'Separate config folder'
}

/**
 * How many live panes run under an account. Only Claude panes carry an account;
 * the ones that never chose explicitly are running as the default login.
 */
function countPanes(workspaces: Workspace[], accountId: string): number {
  const isDefault = accountId === DEFAULT_ACCOUNT_ID
  let count = 0
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      if (pane.kind !== 'claude') continue
      if (pane.accountId === accountId || (isDefault && pane.accountId === undefined)) count += 1
    }
  }
  return count
}

export default function Accounts(): JSX.Element {
  const workspaces = useApp((state) => state.workspaces)
  const pushToast = useApp((state) => state.pushToast)
  const accounts = useRuntime((state) => state.accounts)

  const [mintOpen, setMintOpen] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyLabel, setKeyLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const closeKeyModal = (): void => {
    // The secret never outlives the dialog it was typed into.
    setApiKey('')
    setKeyLabel('')
    setKeyError(null)
    setKeyBusy(false)
    setKeyOpen(false)
  }

  const submitKey = async (): Promise<void> => {
    setKeyBusy(true)
    setKeyError(null)
    const result = await window.api?.addAccount({
      label: keyLabel.trim(),
      backend: 'api-key',
      apiKey
    })
    setKeyBusy(false)
    if (!result) return
    if (!result.ok) {
      setKeyError(result.error)
      return
    }
    const added = result.account.label
    closeKeyModal()
    pushToast(`Account ${added} added`)
  }

  const remove = async (account: ClaudeAccount): Promise<void> => {
    setConfirmRemove(null)
    await window.api?.removeAccount(account.id)
  }

  return (
    <>
      <div className="ada-set-title">Accounts</div>
      <div className="ada-set-sub">
        Run different panes as different accounts. Claude accounts get their own config folder;
        other CLIs get a key injected at launch.
      </div>

      <div className="ada-set-cards">
        <div className="ada-set-card">
          <div className="ada-set-card-head">
            <span className="ada-set-glyph ada-set-glyph--accent">✻</span>
            <span className="ada-set-card-title">Claude Code</span>
            <span className="ada-set-card-spacer" />
            <Button size="sm" onClick={() => setMintOpen(true)}>
              Sign in
            </Button>
            <Button size="sm" onClick={() => setKeyOpen(true)}>
              API key
            </Button>
          </div>

          <div className="ada-set-list">
            {accounts.map((account) => {
              const panes = countPanes(workspaces, account.id)
              const removable = account.id !== DEFAULT_ACCOUNT_ID
              return (
                <div
                  key={account.id}
                  className={`ada-set-item${panes > 0 ? ' ada-set-item--active' : ''}`}
                >
                  <span className={`ada-set-dot${panes > 0 ? ' ada-set-dot--on' : ''}`} />
                  <div>
                    <div className="ada-set-item-name">{account.label}</div>
                    <div className="ada-set-item-desc">{describe(account)}</div>
                  </div>
                  <span className="ada-set-card-spacer" />
                  <span className="ada-set-item-meta">
                    {panes > 0 ? `used by ${panes} ${panes === 1 ? 'pane' : 'panes'}` : 'idle'}
                  </span>
                  {removable &&
                    (confirmRemove === account.id ? (
                      <span className="ada-set-confirm">
                        Remove?
                        <Button size="sm" variant="ghost" danger onClick={() => void remove(account)}>
                          Yes
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>
                          No
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmRemove(account.id)}
                      >
                        Remove
                      </Button>
                    ))}
                </div>
              )
            })}
          </div>
        </div>

        {COMING_LATER.map(({ glyph, name }) => (
          <div key={name} className="ada-set-card ada-set-card--dim">
            <div className="ada-set-card-head">
              <span className="ada-set-glyph">{glyph}</span>
              <span className="ada-set-card-title">{name}</span>
              <span className="ada-set-card-spacer" />
              <Button size="sm" disabled title="Coming later">
                API key
              </Button>
            </div>
            <div className="ada-set-card-hint">{HINT}</div>
          </div>
        ))}
      </div>

      <AccountMint open={mintOpen} onClose={() => setMintOpen(false)} />

      <Modal open={keyOpen} title="Add an API key account" width={440} onClose={closeKeyModal}>
        <div className="ada-set-field">
          <label className="ada-set-field-label" htmlFor="ada-key-label">
            Account name
          </label>
          <TextInput
            id="ada-key-label"
            value={keyLabel}
            placeholder="api-account"
            onChange={setKeyLabel}
          />
        </div>
        <div className="ada-set-field">
          <label className="ada-set-field-label" htmlFor="ada-key-value">
            API key
          </label>
          <TextInput
            id="ada-key-value"
            value={apiKey}
            type="password"
            mono
            placeholder="sk-ant-…"
            onChange={setApiKey}
            onEnter={() => {
              if (keyLabel.trim() && apiKey) void submitKey()
            }}
          />
        </div>
        <div className="ada-set-card-hint">
          The key is held in the OS keychain and injected when a pane on this account launches.
        </div>
        {keyError && <div className="ada-set-error">{keyError}</div>}
        <div className="ada-mint-actions">
          <Button onClick={closeKeyModal}>Cancel</Button>
          <Button
            variant="primary"
            disabled={keyBusy || !keyLabel.trim() || !apiKey}
            onClick={() => void submitKey()}
          >
            {keyBusy ? 'Adding…' : 'Add account'}
          </Button>
        </div>
      </Modal>
    </>
  )
}
