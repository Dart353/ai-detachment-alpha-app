import type { JSX } from 'react'
import { Button } from './ui'
import { useApp } from '../store/app'
import { useRemote } from '../store/remote'
import './ModeSwitch.css'

const NO_RELAY_TITLE = 'Set the relay address in Settings → Remote first'

/**
 * The title bar's Local / Remote segmented switch: whether the body shows this
 * machine's workspaces or other machines seen through the relay. Remote stays
 * disabled until a relay address exists, since there would be nothing to reach.
 */
export function ModeSwitch(): JSX.Element {
  const mode = useRemote((state) => state.mode)
  const setMode = useRemote((state) => state.setMode)
  const relayConfigured = useApp((state) => state.settings.relay.url.trim() !== '')

  return (
    <div className="ada-mode-switch ada-nodrag" role="group" aria-label="Mode">
      <Button
        className="ada-nodrag"
        variant="ghost"
        size="sm"
        active={mode === 'local'}
        aria-pressed={mode === 'local'}
        onClick={() => setMode('local')}
      >
        Local
      </Button>
      <Button
        className="ada-nodrag"
        variant="ghost"
        size="sm"
        active={mode === 'remote'}
        aria-pressed={mode === 'remote'}
        disabled={!relayConfigured}
        title={relayConfigured ? undefined : NO_RELAY_TITLE}
        onClick={() => setMode('remote')}
      >
        Remote
      </Button>
    </div>
  )
}

export default ModeSwitch
