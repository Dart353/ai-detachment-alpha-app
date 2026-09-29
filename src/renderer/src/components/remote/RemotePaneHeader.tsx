/**
 * The bar over one remote pane in the canvas. It reads as the local pane header
 * does — dot, name, model, status, and actions that appear on hover or focus —
 * because it is the same kind of object, seen from another machine.
 */
import type { JSX } from 'react'
import { Maximize2, Minimize2, Paperclip, RefreshCw } from 'lucide-react'
import { shortModel } from '../PaneHeader'
import { useApp } from '../../store/app'
import { STATUS_LABEL } from '../../lib/status'
import type { FeedPane } from '../../../../shared/relayProtocol'
import { dotStatus, kindLabel } from './remoteHelpers'
import '../PaneHeader.css'
import './remote.css'

/** Icon size (design: 12–14px, muted grey). */
const ICON = 13

export interface RemotePaneHeaderProps {
  hostId: string
  pane: FeedPane
  focused: boolean
  maximized: boolean
  /** The remote's grid size, once its first screen has arrived. */
  cols: number | null
  rows: number | null
  onRefresh: () => void
  onToggleMaximize: () => void
}

function attachMessage(result: { ok: boolean; error?: string }): string {
  if (result.ok) return 'Picture sent — its path is in the prompt.'
  if (result.error === 'cancelled') return 'Cancelled.'
  return result.error ?? 'Could not send the picture.'
}

export function RemotePaneHeader({
  hostId,
  pane,
  focused,
  maximized,
  cols,
  rows,
  onRefresh,
  onToggleMaximize
}: RemotePaneHeaderProps): JSX.Element {
  const pushToast = useApp((state) => state.pushToast)
  const status = dotStatus(pane.status)

  function sendPicture(): void {
    void window.api
      .attachToRemotePane(hostId, pane.id)
      .then((result) => pushToast(attachMessage(result)))
      .catch(() => pushToast('Could not send the picture.'))
  }

  return (
    <div className={`ada-pane-header${focused ? ' is-focused' : ''}`}>
      <span className={`ada-pane-dot ada-pane-dot-${status}`} title={STATUS_LABEL[status]} />
      <span className="ada-pane-name" title={pane.summary ?? pane.name}>
        {pane.name}
      </span>
      <span className="ada-pane-kind">{pane.model ? shortModel(pane.model) : kindLabel(pane.kind)}</span>
      <span className="ada-pane-spacer" />
      {cols !== null && rows !== null && (
        <span className="ada-pane-share" title="The size this pane has on its own machine">
          {cols}×{rows}
        </span>
      )}
      <span className={`ada-pane-status ada-pane-status-${status}`}>
        {pane.status === 'starting' ? 'Starting' : STATUS_LABEL[status]}
      </span>
      <span className="ada-pane-actions">
        <button
          type="button"
          className="ada-pane-action"
          title="Reload the screen from the machine"
          aria-label="Reload the screen from the machine"
          onClick={onRefresh}
        >
          <RefreshCw size={ICON} />
        </button>
        <button
          type="button"
          className="ada-pane-action"
          title="Send a picture to this pane"
          aria-label="Send a picture to this pane"
          onClick={sendPicture}
        >
          <Paperclip size={ICON} />
        </button>
        <button
          type="button"
          className="ada-pane-action"
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={onToggleMaximize}
        >
          {maximized ? <Minimize2 size={ICON} /> : <Maximize2 size={ICON} />}
        </button>
      </span>
    </div>
  )
}
