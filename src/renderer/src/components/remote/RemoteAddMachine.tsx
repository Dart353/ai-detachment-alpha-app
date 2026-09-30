/**
 * Pair another desktop so this one can watch and drive it: a label for the
 * sidebar and the pairing key from that desktop's Settings → Remote. The key goes
 * straight to main, which keeps it; a rejected pairing keeps the dialog open with
 * main's reason under the fields.
 */
import { useEffect, useState, type JSX } from 'react'
import { Button, Modal, TextInput } from '../ui'
import { isPairingKey, normalizePairingKey } from './remoteHelpers'
import './remote.css'

export interface RemoteAddMachineProps {
  open: boolean
  onClose: () => void
}

export function RemoteAddMachine({ open, onClose }: RemoteAddMachineProps): JSX.Element {
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)

  // Every opening starts from empty fields.
  useEffect(() => {
    if (!open) return
    setLabel('')
    setKey('')
    setError(null)
    setPairing(false)
  }, [open])

  const keyValid = isPairingKey(key)

  async function pair(): Promise<void> {
    if (!keyValid || pairing) return
    setPairing(true)
    const result = await window.api.addRemoteMachine(key, label.trim())
    setPairing(false)
    if (result.ok) onClose()
    else setError(result.error)
  }

  return (
    <Modal
      open={open}
      title="Add machine"
      width={460}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!keyValid || pairing} onClick={() => void pair()}>
            {pairing ? 'Pairing…' : 'Pair'}
          </Button>
        </>
      }
    >
      <div className="ada-remote-form">
        <label className="ada-remote-field">
          <span className="ada-remote-field-label">Name</span>
          <TextInput
            value={label}
            placeholder="home-desktop"
            autoFocus
            onChange={(value) => {
              setLabel(value)
              setError(null)
            }}
            onEnter={() => void pair()}
          />
          <span className="ada-remote-field-hint">Empty uses the machine&apos;s own name.</span>
        </label>
        <label className="ada-remote-field">
          <span className="ada-remote-field-label">Pairing key</span>
          <TextInput
            mono
            value={key}
            placeholder="64 hex characters"
            onChange={(value) => {
              setKey(normalizePairingKey(value))
              setError(null)
            }}
            onEnter={() => void pair()}
          />
          <span className="ada-remote-field-hint">
            From the other desktop&apos;s Settings → Remote → Pairing key.
          </span>
        </label>
        {error && <div className="ada-remote-field-error">{error}</div>}
      </div>
    </Modal>
  )
}
