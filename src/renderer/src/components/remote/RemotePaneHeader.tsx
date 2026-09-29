/**
 * The slim bar over a remote pane: what it is, where it lives, the size the
 * remote renders it at, and the three things you can do to it from here.
 * Styled as the local pane header so both read as the same kind of object.
 */
import type { JSX } from 'react'
import { Paperclip, RefreshCw, X } from 'lucide-react'
import { Button } from '../ui'
import { shortModel } from '../PaneHeader'
import { useApp } from '../../store/app'
import type { RemoteMachine } from '../../../../shared/types'
import type { FeedPane, FeedWorkspace } from '../../../../shared/relayProtocol'
import { dotStatus, machineName } from './remoteHelpers'
import '../PaneHeader.css'
import '../Sidebar.css'
import './remote.css'

/** Icon size (design: 12–14px, muted grey). */
const ICON = 13

export interface RemotePaneHeaderProps {
  machine: RemoteMachine
  workspace: FeedWorkspace
  pane: FeedPane
  /** The remote's grid size, once its first screen has arrived. */
  cols: number | null
  rows: number | null
  onRefresh: () => void
  onClose: () => void
}

function attachMessage(result: { ok: boolean; error?: string }): string {
  if (result.ok) return 'Picture sent — its path is in the prompt.'
  if (result.error === 'cancelled') return 'Cancelled.'
  return result.error ?? 'Could not send the picture.'
}

export function RemotePaneHeader({
  machine,
  workspace,
  pane,
  cols,
  rows,
  onRefresh,
  onClose
}: RemotePaneHeaderProps): JSX.Element {
  const pushToast = useApp((state) => state.pushToast)

  function sendPicture(): void {
    void window.api
      .attachToRemotePane(machine.hostId, pane.id)
      .then((result) => pushToast(attachMessage(result)))
      .catch(() => pushToast('Could not send the picture.'))
  }

  return (
    <div className="ada-pane-header is-focused">
      <span className={`ada-sb-dot ada-sb-dot--${dotStatus(pane.status)}`} aria-hidden="true" />
      <strong className="ada-pane-name">{pane.name}</strong>
      {pane.model && <span className="ada-pane-kind">{shortModel(pane.model)}</span>}
      <span className="ada-remote-crumb">
        {machineName(machine)} · {workspace.name}
      </span>
      <span className="ada-pane-spacer" />
      {cols !== null && rows !== null && (
        <span className="ada-remote-chip">
          {cols}×{rows}
        </span>
      )}
      <Button
        variant="icon"
        size="sm"
        icon={<RefreshCw size={ICON} />}
        aria-label="Reload the screen from the machine"
        title="Reload the screen from the machine"
        onClick={onRefresh}
      />
      <Button
        variant="icon"
        size="sm"
        icon={<Paperclip size={ICON} />}
        aria-label="Send a picture to this pane"
        title="Send a picture to this pane"
        onClick={sendPicture}
      />
      <Button
        variant="icon"
        size="sm"
        icon={<X size={ICON} />}
        aria-label="Close"
        title="Close"
        onClick={onClose}
      />
    </div>
  )
}
