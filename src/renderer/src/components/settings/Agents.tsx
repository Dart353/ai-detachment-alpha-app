import { useEffect, useState, type JSX } from 'react'
import { Button, Select, TextInput, Toggle, type SelectOption } from '../ui'
import { useApp } from '../../store/app'
import { useRuntime } from '../../store/runtime'
import { SettingRow, Stepper } from './SettingRow'
import type { CliProbe, Settings } from '../../../../shared/types'
import './settings.css'

const PANE_KIND_OPTIONS: SelectOption[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'terminal', label: 'Terminal' }
]

const MIN_WARN_PCT = 50
const MAX_WARN_PCT = 100

/** The two events a pane can report, and how each may announce itself. */
type NotifyEvent = 'attention' | 'done'
type NotifyChannel = 'banner' | 'sound'

const NOTIFY_ROWS: { event: NotifyEvent; label: string }[] = [
  { event: 'attention', label: 'Needs input' },
  { event: 'done', label: 'Done' }
]

export default function Agents(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const updateSettings = useApp((state) => state.updateSettings)
  const pushToast = useApp((state) => state.pushToast)
  const hooksInstalled = useRuntime((state) => state.hooksInstalled)
  const setHooksInstalled = useRuntime((state) => state.setHooksInstalled)

  const [claudePath, setClaudePath] = useState(settings.cliPaths.claude ?? '')
  const [probe, setProbe] = useState<CliProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    setClaudePath(settings.cliPaths.claude ?? '')
  }, [settings.cliPaths.claude])

  const commitClaudePath = (value: string): void => {
    const trimmed = value.trim()
    updateSettings({ cliPaths: { ...settings.cliPaths, claude: trimmed || undefined } })
  }

  const check = async (): Promise<void> => {
    const candidate = claudePath.trim()
    setProbing(true)
    setProbe(null)
    const result = await window.api?.cliProbe(candidate || undefined)
    setProbing(false)
    if (result) setProbe(result)
  }

  const install = async (): Promise<void> => {
    setInstalling(true)
    const result = await window.api?.installHooks()
    const installed = await window.api?.hooksInstalled()
    setInstalling(false)
    setHooksInstalled(Boolean(installed))
    if (result && !result.ok) pushToast(`Hooks not installed: ${result.error}`, { kind: 'error' })
  }

  /**
   * Settings partials are shallow, so every notification switch has to send the
   * whole `notifications` object with only its own field changed.
   */
  const setChannel = (event: NotifyEvent, channel: NotifyChannel, value: boolean): void => {
    const notifications: Settings['notifications'] = {
      ...settings.notifications,
      [event]: { ...settings.notifications[event], [channel]: value }
    }
    updateSettings({ notifications })
  }

  const muted = settings.notifications.muted

  return (
    <>
      <div className="ada-set-title">Agents</div>
      <div className="ada-set-sub">
        What a new pane runs, where its CLI lives, and how finished work reaches you.
      </div>

      <div className="ada-set-cards">
        <div className="ada-set-card">
          <SettingRow label="Default pane" description="What a split or a new tile opens as.">
            <Select
              value={settings.defaultPaneKind}
              options={PANE_KIND_OPTIONS}
              width={190}
              ariaLabel="Default pane"
              onChange={(value) =>
                updateSettings({ defaultPaneKind: value === 'terminal' ? 'terminal' : 'claude' })
              }
            />
          </SettingRow>
          <SettingRow
            label="Claude CLI path"
            description="Only needed when the login shell cannot find it."
          >
            <TextInput
              value={claudePath}
              mono
              size="sm"
              placeholder="claude"
              aria-label="Claude CLI path"
              style={{ width: 220 }}
              onChange={setClaudePath}
              onEnter={commitClaudePath}
              onBlur={(event) => commitClaudePath(event.currentTarget.value)}
            />
            <Button size="sm" disabled={probing} onClick={() => void check()}>
              {probing ? 'Checking…' : 'Check'}
            </Button>
          </SettingRow>
          {probe && (
            <div className={`ada-set-probe ${probe.ok ? 'ada-set-ok' : 'ada-set-warn'}`}>
              {probe.ok
                ? `✓ ${probe.command} · ${probe.version ?? 'unknown version'} (${probe.source})`
                : probe.error ?? 'Not found.'}
            </div>
          )}
        </div>

        <div className="ada-set-card">
          <div className="ada-set-card-head">
            <span className={`ada-set-dot${hooksInstalled ? ' ada-set-dot--on' : ''}`} />
            <span className="ada-set-card-title">Hooks</span>
            <span className="ada-set-item-name">
              {hooksInstalled ? 'Installed' : 'Not installed'}
            </span>
            <span className="ada-set-card-spacer" />
            <Button
              size="sm"
              disabled={hooksInstalled || installing}
              onClick={() => void install()}
            >
              {installing ? 'Installing…' : 'Install hooks'}
            </Button>
          </div>
          <div className="ada-set-card-hint">
            Adds Stop and Notification hooks to ~/.claude/settings.json so panes report &quot;needs
            input&quot; and &quot;done&quot; precisely. Your existing hooks are left untouched.
          </div>
        </div>

        <div className="ada-set-card">
          <div className="ada-set-card-head">
            <span className="ada-set-card-title">Notifications</span>
          </div>
          <div className="ada-set-rows">
            <SettingRow label="Mute all" description="Nothing banners or chimes while this is on.">
              <Toggle
                checked={muted}
                ariaLabel="Mute all notifications"
                onChange={(checked) =>
                  updateSettings({ notifications: { ...settings.notifications, muted: checked } })
                }
              />
            </SettingRow>
            {NOTIFY_ROWS.map(({ event, label }) => (
              <SettingRow key={event} label={label} dimmed={muted}>
                <Toggle
                  checked={settings.notifications[event].banner}
                  label="Banner"
                  disabled={muted}
                  onChange={(checked) => setChannel(event, 'banner', checked)}
                />
                <Toggle
                  checked={settings.notifications[event].sound}
                  label="Sound"
                  disabled={muted}
                  onChange={(checked) => setChannel(event, 'sound', checked)}
                />
              </SettingRow>
            ))}
          </div>
        </div>

        <div className="ada-set-card">
          <SettingRow
            label="Warn on usage"
            description="Tints the limit meter once a window passes the threshold."
          >
            <Toggle
              checked={settings.warnEnabled}
              ariaLabel="Warn on usage"
              onChange={(checked) => updateSettings({ warnEnabled: checked })}
            />
            <Stepper
              value={settings.warnAtPct}
              min={MIN_WARN_PCT}
              max={MAX_WARN_PCT}
              suffix="%"
              ariaLabel="Usage warning threshold"
              onChange={(value) => updateSettings({ warnAtPct: value })}
            />
          </SettingRow>
        </div>
      </div>
    </>
  )
}
