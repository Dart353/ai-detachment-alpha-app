import { useEffect, useState, type JSX } from 'react'
import { Button } from './ui'
import { useApp } from '../store/app'
import Appearance from './settings/Appearance'
import Terminal from './settings/Terminal'
import Agents from './settings/Agents'
import Accounts from './settings/Accounts'
import Workspaces from './settings/Workspaces'
import Remote from './settings/Remote'
import About from './settings/About'
import './SettingsView.css'

/** The sections, in nav order. */
type SectionId =
  | 'appearance'
  | 'terminal'
  | 'agents'
  | 'accounts'
  | 'workspaces'
  | 'remote'
  | 'about'

const SECTIONS: { id: SectionId; label: string; render: () => JSX.Element }[] = [
  { id: 'appearance', label: 'Appearance', render: () => <Appearance /> },
  { id: 'terminal', label: 'Terminal', render: () => <Terminal /> },
  { id: 'agents', label: 'Agents', render: () => <Agents /> },
  { id: 'accounts', label: 'Accounts', render: () => <Accounts /> },
  { id: 'workspaces', label: 'Workspaces', render: () => <Workspaces /> },
  { id: 'remote', label: 'Remote', render: () => <Remote /> },
  { id: 'about', label: 'About', render: () => <About /> }
]

/**
 * Settings (design README 1f): a left nav, one section at a time, and Done. Every
 * control writes through `updateSettings` the moment it is touched — there is no
 * Save button and nothing to lose by leaving.
 *
 * The open section is component state on purpose: which page of settings you last
 * read is not worth persisting, and the screen should open somewhere neutral.
 */
export default function SettingsView(): JSX.Element {
  const setView = useApp((state) => state.setView)
  const [section, setSection] = useState<SectionId>('appearance')

  // Escape leaves settings, the same as Done — unless a dialog is up, in which
  // case the Escape belongs to it and closing the screen underneath would tear
  // the dialog off mid-task.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"]')) return
      setView('grid')
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [setView])

  const active = SECTIONS.find((candidate) => candidate.id === section) ?? SECTIONS[0]

  return (
    <div className="ada-settings">
      <nav className="ada-settings-nav" aria-label="Settings sections">
        {SECTIONS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={`ada-settings-nav-item${
              candidate.id === section ? ' ada-settings-nav-item--active' : ''
            }`}
            aria-current={candidate.id === section}
            onClick={() => setSection(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
        <span className="ada-settings-nav-spacer" />
        <Button variant="outline" className="ada-settings-done" onClick={() => setView('grid')}>
          Done
        </Button>
      </nav>
      <div className="ada-settings-content">{active.render()}</div>
    </div>
  )
}
