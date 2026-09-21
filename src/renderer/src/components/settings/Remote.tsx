import { useEffect, useState, type JSX } from 'react'
import { Button, TextInput, Toggle } from '../ui'
import { useApp } from '../../store/app'
import { SettingRow } from './SettingRow'
import type { RelayStatus } from '../../../../shared/types'
import './settings.css'

const STATE_LABEL: Record<RelayStatus['state'], string> = {
  off: 'Off',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Not connected'
}

/**
 * Settings → Remote: the relay link a phone watches this machine through. The
 * pairing key is fetched only when the user asks to see it and is never kept
 * in a store, so it is on screen exactly as long as the section is.
 */
export default function Remote(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const updateSettings = useApp((state) => state.updateSettings)
  const pushToast = useApp((state) => state.pushToast)

  const [status, setStatus] = useState<RelayStatus>({
    state: 'off',
    hostId: null,
    viewers: 0,
    keyPersisted: true
  })
  const [key, setKey] = useState<string | null>(null)
  const [url, setUrl] = useState(settings.relay.url)
  const [name, setName] = useState(settings.relay.name)

  useEffect(() => {
    let live = true
    void window.api?.relayStatus().then((value) => {
      if (live) setStatus(value)
    })
    const off = window.api?.onRelayChanged(setStatus)
    return () => {
      live = false
      off?.()
    }
  }, [])

  useEffect(() => setUrl(settings.relay.url), [settings.relay.url])
  useEffect(() => setName(settings.relay.name), [settings.relay.name])

  const relay = settings.relay
  const commitUrl = (value: string): void => {
    const next = value.trim()
    if (next !== relay.url) updateSettings({ relay: { ...relay, url: next } })
  }
  const commitName = (value: string): void => {
    const next = value.trim()
    if (next !== relay.name) updateSettings({ relay: { ...relay, name: next } })
  }

  const reveal = async (): Promise<void> => {
    const value = await window.api?.relayKey()
    if (value) setKey(value)
  }
  const rotate = async (): Promise<void> => {
    const value = await window.api?.rotateRelayKey()
    if (!value) return
    setKey(value)
    pushToast('New pairing key — add this machine on your phone again.')
  }
  const copy = (text: string): void => {
    window.api?.copyText(text)
    pushToast('Copied.')
  }

  const on = status.state === 'connected'

  return (
    <>
      <div className="ada-set-title">Remote</div>
      <div className="ada-set-sub">
        Watch this machine&apos;s panes from your phone. The app connects out to your relay;
        the phone opens the relay&apos;s page and adds this machine with its pairing key.
      </div>

      <div className="ada-set-cards">
        <div className="ada-set-card">
          <div className="ada-set-card-head">
            <span className={`ada-set-dot${on ? ' ada-set-dot--on' : ''}`} />
            <span className="ada-set-card-title">Relay</span>
            <span className="ada-set-item-name" data-testid="relay-state">
              {STATE_LABEL[status.state]}
              {on && status.viewers > 0
                ? ` · ${status.viewers} ${status.viewers === 1 ? 'phone' : 'phones'} watching`
                : ''}
            </span>
            <span className="ada-set-card-spacer" />
            <Toggle
              checked={relay.enabled}
              ariaLabel="Connect to the relay"
              onChange={(checked) => updateSettings({ relay: { ...relay, enabled: checked } })}
            />
          </div>
          {status.error && (
            <div className="ada-set-probe ada-set-warn" data-testid="relay-error">
              {status.error}
            </div>
          )}
          <SettingRow label="Relay address" description="Where the relay is served, e.g. https://ada.example.com">
            <TextInput
              value={url}
              mono
              size="sm"
              placeholder="https://"
              aria-label="Relay address"
              style={{ width: 260 }}
              onChange={setUrl}
              onEnter={commitUrl}
              onBlur={(event) => commitUrl(event.currentTarget.value)}
            />
          </SettingRow>
          <SettingRow label="This machine's name" description="How the phone labels it. Empty means the hostname.">
            <TextInput
              value={name}
              size="sm"
              placeholder="hostname"
              aria-label="Machine name"
              style={{ width: 180 }}
              onChange={setName}
              onEnter={commitName}
              onBlur={(event) => commitName(event.currentTarget.value)}
            />
          </SettingRow>
        </div>

        <div className="ada-set-card">
          <SettingRow
            label="Pairing key"
            description={
              status.keyPersisted
                ? 'Typed once on the phone; it remembers it. Rotate if a device should lose access.'
                : 'No OS keychain here, so the key is kept in memory: add this machine on the phone again after each relaunch.'
            }
          >
            {key ? (
              <>
                <span className="ada-set-mono ada-set-key">{key}</span>
                <Button size="sm" onClick={() => copy(key)}>
                  Copy
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => void reveal()}>
                Show
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void rotate()}>
              Rotate
            </Button>
          </SettingRow>
          {status.hostId && (
            <div className="ada-set-card-hint">
              The relay knows this machine as <span className="ada-set-mono">{status.hostId.slice(0, 16)}…</span>,
              a hash of the key. The key itself is never stored on the relay.
            </div>
          )}
        </div>
      </div>
    </>
  )
}
