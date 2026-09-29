/**
 * Ask a remote machine for a new Claude agent in one of its workspaces, with the
 * same choices its own add-pane dialog offers: a name, a model the machine
 * reports it has, an effort level and plan mode.
 */
import { useEffect, useState, type JSX } from 'react'
import { Button, Modal, Select, TextInput, Toggle, type SelectOption } from '../ui'
import type { RemoteMachine } from '../../../../shared/types'
import { EFFORTS, type Effort, type FeedWorkspace } from '../../../../shared/relayProtocol'
import './remote.css'

const DEFAULT_EFFORT: Effort = 'high'

const EFFORT_OPTIONS: SelectOption[] = EFFORTS.map((effort) => ({ value: effort, label: effort }))

function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value)
}

export interface RemoteNewAgentProps {
  open: boolean
  machine: RemoteMachine
  workspace: FeedWorkspace
  onClose: () => void
}

export function RemoteNewAgent({ open, machine, workspace, onClose }: RemoteNewAgentProps): JSX.Element {
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<Effort>(DEFAULT_EFFORT)
  const [planMode, setPlanMode] = useState(false)

  // Every opening starts from a blank form.
  useEffect(() => {
    if (!open) return
    setName('')
    setModel('')
    setEffort(DEFAULT_EFFORT)
    setPlanMode(false)
  }, [open])

  const models = machine.feed?.host.models ?? []
  const modelOptions: SelectOption[] = [
    { value: '', label: 'default' },
    ...models.map((modelName) => ({ value: modelName, label: modelName }))
  ]
  const trimmedName = name.trim()

  function startAgent(): void {
    if (!trimmedName) return
    window.api.addRemotePane({
      hostId: machine.hostId,
      workspaceId: workspace.id,
      kind: 'claude',
      name: trimmedName,
      ...(model ? { model } : {}),
      effort,
      ...(planMode ? { planMode: true } : {})
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      title="New agent"
      width={420}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!trimmedName} onClick={startAgent}>
            Start agent
          </Button>
        </>
      }
    >
      <div className="ada-remote-dialog-sub">{workspace.name}</div>
      <div className="ada-remote-form">
        <label className="ada-remote-field">
          <span className="ada-remote-field-label">Name</span>
          <TextInput
            value={name}
            placeholder="e.g. Test Fixer"
            autoFocus
            onChange={setName}
            onEnter={startAgent}
          />
        </label>
        <div className="ada-remote-field">
          <span className="ada-remote-field-label">Model</span>
          <Select value={model} options={modelOptions} onChange={setModel} ariaLabel="Model" />
        </div>
        <div className="ada-remote-field">
          <span className="ada-remote-field-label">Effort</span>
          <Select
            value={effort}
            options={EFFORT_OPTIONS}
            onChange={(value) => {
              if (isEffort(value)) setEffort(value)
            }}
            ariaLabel="Effort"
          />
        </div>
        <div className="ada-remote-field">
          <Toggle checked={planMode} onChange={setPlanMode} label="Start in plan mode" />
          <span className="ada-remote-field-hint">Agent proposes a plan before editing files</span>
        </div>
      </div>
    </Modal>
  )
}
