/**
 * Ask a remote machine to open a folder as a workspace, as its own open dialog
 * would: type a path, or pick one of the folders it opened recently and has not
 * got open right now.
 */
import { useEffect, useState, type JSX } from 'react'
import { Folder } from 'lucide-react'
import { Button, Modal, TextInput } from '../ui'
import type { RemoteMachine } from '../../../../shared/types'
import type { FeedRecent } from '../../../../shared/relayProtocol'
import { machineName } from './remoteHelpers'
import './remote.css'

/** Icon size (design: 12–14px, muted grey). */
const ICON = 13

export interface RemoteOpenWorkspaceProps {
  open: boolean
  machine: RemoteMachine
  onClose: () => void
}

/** Recent folders the machine does not already have open. */
function closedRecents(machine: RemoteMachine): FeedRecent[] {
  const feed = machine.feed
  if (!feed) return []
  const openRoots = new Set(feed.workspaces.map((workspace) => workspace.rootDir))
  return feed.recents.filter((recent) => !openRoots.has(recent.rootDir))
}

export function RemoteOpenWorkspace({ open, machine, onClose }: RemoteOpenWorkspaceProps): JSX.Element {
  const [rootDir, setRootDir] = useState('')

  // Every opening starts from an empty field.
  useEffect(() => {
    if (open) setRootDir('')
  }, [open])

  const recents = closedRecents(machine)
  const trimmedRootDir = rootDir.trim()

  function openWorkspace(): void {
    if (!trimmedRootDir) return
    window.api.openRemoteWorkspace(machine.hostId, trimmedRootDir)
    onClose()
  }

  return (
    <Modal
      open={open}
      title="Open workspace"
      width={460}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!trimmedRootDir} onClick={openWorkspace}>
            Open
          </Button>
        </>
      }
    >
      <div className="ada-remote-dialog-sub">{machineName(machine)}</div>
      <div className="ada-remote-form">
        <label className="ada-remote-field">
          <span className="ada-remote-field-label">Folder</span>
          <TextInput
            mono
            value={rootDir}
            placeholder="~/code/project"
            autoFocus
            onChange={setRootDir}
            onEnter={openWorkspace}
          />
        </label>
        {recents.length > 0 && (
          <div className="ada-remote-field">
            <span className="ada-remote-field-label">Recent</span>
            <div className="ada-remote-recents">
              {recents.map((recent) => (
                <button
                  key={recent.rootDir}
                  type="button"
                  className={`ada-remote-recent${recent.rootDir === rootDir ? ' ada-remote-recent--active' : ''}`}
                  title={recent.name}
                  onClick={() => setRootDir(recent.rootDir)}
                >
                  <Folder size={ICON} className="ada-remote-icon" aria-hidden="true" />
                  <span className="ada-remote-recent-path">{recent.rootDir}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
