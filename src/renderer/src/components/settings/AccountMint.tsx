import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { Button, Modal, TextInput } from '../ui'
import { useApp } from '../../store/app'
import { useTerminalPane } from '../../hooks/useTerminalPane'
import { ROW_RATIO } from '../../lib/termLineHeight'
import type { PendingMint } from '../../../../shared/types'
import './settings.css'

export interface AccountMintProps {
  open: boolean
  onClose: () => void
}

/** How tall the embedded sign-in terminal is, in rows. */
const MINT_ROWS = 16

interface MintTerminalProps {
  mint: PendingMint
  fontSize: number
  fontFamily: string
}

/**
 * The `claude setup-token` run, embedded. Main owns the command: `spawnPty` is
 * handed only the pending mint's id and staging dir, and main types the rest
 * itself. The token is read out of the stream by main and never reaches here.
 */
function MintTerminal({ mint, fontSize, fontFamily }: MintTerminalProps): JSX.Element {
  const { containerRef } = useTerminalPane({
    id: mint.ptyId,
    fontSize,
    fontFamily,
    focused: true,
    onFocus: () => {},
    onActivity: () => {},
    onExit: () => {},
    killOnUnmount: true,
    spawn: async (term: XTerm) => {
      const started = await window.api?.spawnPty({
        id: mint.ptyId,
        kind: 'terminal',
        mint: { configDir: mint.configDir },
        cols: term.cols,
        rows: term.rows
      })
      if (!started) {
        term.write('\r\n[The sign-in session could not start. Close and try again.]\r\n')
        return false
      }
      return true
    }
  })

  return (
    <div
      className="ada-mint-term"
      ref={containerRef}
      style={{ height: Math.round(fontSize * ROW_RATIO * MINT_ROWS) }}
    />
  )
}

/**
 * Add a second Claude subscription. Two steps: name it, then sign in with that
 * account in the terminal the modal embeds. Main completes the account the
 * moment the token prints; the paste field is the fallback for a narrow pane
 * that wrapped the credential past what main can read.
 *
 * Nothing here holds a credential: the pasted value is handed straight to main
 * and cleared, and no value is ever logged or toasted.
 */
export default function AccountMint({ open, onClose }: AccountMintProps): JSX.Element | null {
  const pushToast = useApp((state) => state.pushToast)
  const settings = useApp((state) => state.settings)

  const [label, setLabel] = useState('')
  const [mint, setMint] = useState<PendingMint | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [token, setToken] = useState('')
  // The teardown paths (unmount, Escape, Cancel) must see the CURRENT mint.
  const mintRef = useRef<PendingMint | null>(null)
  mintRef.current = mint

  const close = useCallback((): void => {
    // Leaving before the account exists abandons the mint: main kills the PTY
    // and removes the staging dir. A completed mint has nothing pending.
    const pending = mintRef.current
    mintRef.current = null
    if (pending) void window.api?.cancelMint(pending.ptyId)
    setMint(null)
    setLabel('')
    setError(null)
    setBusy(false)
    setPasteOpen(false)
    setToken('')
    onClose()
  }, [onClose])

  // Nothing may outlive this component: an unmount while a mint is pending (the
  // settings view closing under it) cancels the same way a dismissal does.
  useEffect(
    () => () => {
      const pending = mintRef.current
      if (pending) void window.api?.cancelMint(pending.ptyId)
    },
    []
  )

  // Main captured the token off the stream and finished the account.
  useEffect(() => {
    if (!open) return
    return window.api?.onMintDone((event) => {
      const pending = mintRef.current
      if (!pending || event.ptyId !== pending.ptyId) return
      if (!event.ok) {
        setError(event.error ?? 'The sign-in did not complete.')
        return
      }
      // Cleared first, so `close` finds nothing left to cancel.
      mintRef.current = null
      const added = event.account?.label ?? label
      close()
      pushToast(`Account ${added} added`)
    })
  }, [open, label, close, pushToast])

  const begin = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await window.api?.beginMint(label.trim())
    setBusy(false)
    if (!result) return
    if ('error' in result) {
      setError(result.error)
      return
    }
    setMint(result)
  }

  const submitToken = async (): Promise<void> => {
    const pending = mintRef.current
    if (!pending) return
    setBusy(true)
    setError(null)
    const result = await window.api?.completeMint(pending.ptyId, token)
    // The pasted credential lives no longer than the call that consumed it.
    setToken('')
    setBusy(false)
    if (!result) return
    if (!result.ok) {
      setError(result.error)
      return
    }
    mintRef.current = null
    const added = result.account.label
    close()
    pushToast(`Account ${added} added`)
  }

  if (!open) return null

  return (
    <Modal open={open} title="Add a Claude account" width={640} onClose={close}>
      {!mint ? (
        <>
          <div className="ada-set-field">
            <label className="ada-set-field-label" htmlFor="ada-mint-label">
              Account name
            </label>
            <TextInput
              id="ada-mint-label"
              value={label}
              placeholder="work-account"
              onChange={setLabel}
              onEnter={() => {
                if (label.trim()) void begin()
              }}
            />
          </div>
          <div className="ada-set-card-hint">
            The account gets its own config folder, so its panes never touch your own login.
          </div>
          {error && <div className="ada-set-error">{error}</div>}
          <div className="ada-mint-actions">
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={busy || !label.trim()} onClick={() => void begin()}>
              {busy ? 'Preparing…' : 'Continue'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="ada-set-card-hint" style={{ marginTop: 0 }}>
            Sign in with the other account in the browser window that opens. The account is added as
            soon as the token prints.
          </div>
          <MintTerminal
            mint={mint}
            fontSize={settings.termFontSize}
            fontFamily={settings.termFontFamily}
          />
          <button
            type="button"
            className="ada-mint-paste-toggle"
            aria-expanded={pasteOpen}
            onClick={() => setPasteOpen((value) => !value)}
          >
            {pasteOpen ? '▾' : '▸'} Paste token instead
          </button>
          {pasteOpen && (
            <div className="ada-set-field">
              <TextInput
                value={token}
                type="password"
                mono
                placeholder="Paste the printed token"
                aria-label="Setup token"
                onChange={setToken}
                onEnter={() => {
                  if (token.trim()) void submitToken()
                }}
              />
              <div className="ada-mint-actions">
                <Button
                  size="sm"
                  disabled={busy || !token.trim()}
                  onClick={() => void submitToken()}
                >
                  Add account
                </Button>
              </div>
            </div>
          )}
          {error && <div className="ada-set-error">{error}</div>}
          <div className="ada-mint-actions">
            <Button onClick={close}>Cancel</Button>
          </div>
        </>
      )}
    </Modal>
  )
}
