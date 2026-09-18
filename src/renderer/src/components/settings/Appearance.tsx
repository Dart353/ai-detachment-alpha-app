import type { JSX } from 'react'
import { Select, type SelectOption } from '../ui'
import { useApp } from '../../store/app'
import { SettingRow, Stepper } from './SettingRow'
import './settings.css'

/** The two faces panes may run in; the stack's fallbacks are added at render. */
const FONT_OPTIONS: SelectOption[] = [
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'ui-monospace', label: 'System monospace' }
]

const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 18

/** What the preview line shows: glyphs whose shapes differ face to face. */
const PREVIEW_TEXT = '⏵ claude --resume  0Ol1i {}[]  100%'

export default function Appearance(): JSX.Element {
  const settings = useApp((state) => state.settings)
  const updateSettings = useApp((state) => state.updateSettings)

  return (
    <>
      <div className="ada-set-title">Appearance</div>
      <div className="ada-set-sub">Applies to open terminals immediately.</div>

      <div className="ada-set-cards">
        <div className="ada-set-card">
          <SettingRow label="Terminal font">
            <Select
              value={settings.termFontFamily}
              options={FONT_OPTIONS}
              width={190}
              ariaLabel="Terminal font"
              onChange={(value) => updateSettings({ termFontFamily: value })}
            />
          </SettingRow>
          <SettingRow label="Terminal font size">
            <Stepper
              value={settings.termFontSize}
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              suffix="px"
              ariaLabel="Terminal font size"
              onChange={(value) => updateSettings({ termFontSize: value })}
            />
          </SettingRow>
          <div
            className="ada-appearance-preview"
            style={{
              fontFamily: `${settings.termFontFamily}, ui-monospace, monospace`,
              fontSize: settings.termFontSize
            }}
          >
            {PREVIEW_TEXT}
          </div>
        </div>
      </div>
    </>
  )
}
