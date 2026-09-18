import { useEffect, useState, type JSX } from 'react'
import { Select, TextInput, Toggle, type SelectOption } from '../ui'
import { useApp } from '../../store/app'
import { SettingRow } from './SettingRow'
import './settings.css'

/** WSL only exists on Windows; everywhere else the card is shown but inert. */
function isWindows(): boolean {
  return window.api?.platform === 'win32'
}

export default function Terminal(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const updateSettings = useApp((state) => state.updateSettings)
  // The field is edited freely and only committed on blur or Enter: saving per
  // keystroke would hand half-typed paths to every pane spawned meanwhile.
  const [shellDraft, setShellDraft] = useState(settings.shellPath ?? '')
  const [distros, setDistros] = useState<string[]>([])
  const windows = isWindows()

  // Re-sync when the setting changes underneath the field (another window, or a
  // settings file edit echoed back through onSettingsChanged).
  useEffect(() => {
    setShellDraft(settings.shellPath ?? '')
  }, [settings.shellPath])

  useEffect(() => {
    if (!windows) return
    let live = true
    void window.api?.wslDistros().then((list) => {
      if (live) setDistros(list)
    })
    return () => {
      live = false
    }
  }, [windows])

  const commitShell = (value: string): void => {
    const trimmed = value.trim()
    updateSettings({ shellPath: trimmed || undefined })
  }

  const distroOptions: SelectOption[] = distros.map((distro) => ({
    value: distro,
    label: distro
  }))

  return (
    <>
      <div className="ada-set-title">Terminal</div>
      <div className="ada-set-sub">How panes launch and how much of the pane a TUI may take.</div>

      <div className="ada-set-cards">
        <div className="ada-set-card">
          <SettingRow label="Shell path override" description="Used for new panes.">
            <TextInput
              value={shellDraft}
              mono
              size="sm"
              placeholder="Default login shell"
              aria-label="Shell path override"
              style={{ width: 260 }}
              onChange={setShellDraft}
              onEnter={commitShell}
              onBlur={(event) => commitShell(event.currentTarget.value)}
            />
          </SettingRow>
          <SettingRow
            label="Fullscreen TUI"
            description="Keeps Claude Code's input pinned to the bottom of the pane."
          >
            <Toggle
              checked={settings.fullscreenTui}
              ariaLabel="Fullscreen TUI"
              onChange={(checked) => updateSettings({ fullscreenTui: checked })}
            />
          </SettingRow>
        </div>

        <div className={`ada-set-card${windows ? '' : ' ada-set-card--dim'}`}>
          <div className="ada-set-card-head">
            <span className="ada-set-card-title">WSL</span>
            <span className="ada-set-card-spacer" />
            {!windows && <span className="ada-set-item-meta">Windows only</span>}
          </div>
          <div className="ada-set-rows">
            <SettingRow
              label="Run in WSL"
              description="Run terminals and read ~/.claude inside a WSL distro."
              dimmed={!windows}
            >
              <Toggle
                checked={settings.wsl.enabled}
                disabled={!windows}
                ariaLabel="Run in WSL"
                onChange={(checked) =>
                  updateSettings({ wsl: { ...settings.wsl, enabled: checked } })
                }
              />
            </SettingRow>
            <SettingRow label="Distro" dimmed={!windows || !settings.wsl.enabled}>
              <Select
                value={settings.wsl.distro ?? ''}
                options={distroOptions}
                width={190}
                size="sm"
                placeholder={distroOptions.length === 0 ? 'No distros found' : 'Default distro'}
                disabled={!windows || !settings.wsl.enabled}
                ariaLabel="WSL distro"
                onChange={(value) => updateSettings({ wsl: { ...settings.wsl, distro: value } })}
              />
            </SettingRow>
          </div>
        </div>
      </div>
    </>
  )
}
