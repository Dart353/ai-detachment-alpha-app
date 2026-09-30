import { useState, type JSX } from 'react'
import { Button, Modal, TextInput } from '../ui'
import { useApp } from '../../store/app'
import { uid } from '../../lib/ids'
import type { CustomAgent } from '../../../../shared/types'
import './settings.css'

/** What the editor is working on: a new agent (no id yet) or an existing one. */
interface Draft {
  id: string | null
  name: string
  prompt: string
}

/** The first line of a prompt, for the list row. */
function preview(prompt: string): string {
  const first = prompt.trim().split('\n')[0] ?? ''
  return first.length > 90 ? `${first.slice(0, 90)}…` : first
}

/**
 * Settings → Custom agents: the saved roles an empty zone's right-click menu
 * offers under "Custom agent". Opening one spawns Claude Code and sends the
 * prompt as its first message, so a reviewer starts reviewing without the
 * slash command being typed each time.
 */
export default function CustomAgents(): JSX.Element {
  const agents = useApp((state) => state.settings.customAgents)
  const updateSettings = useApp((state) => state.updateSettings)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const canSave = !!draft && draft.name.trim() !== '' && draft.prompt.trim() !== ''

  const save = (): void => {
    if (!draft || !canSave) return
    const agent: CustomAgent = {
      id: draft.id ?? uid('agent'),
      name: draft.name.trim(),
      prompt: draft.prompt.trim()
    }
    const customAgents = draft.id
      ? agents.map((existing) => (existing.id === draft.id ? agent : existing))
      : [...agents, agent]
    updateSettings({ customAgents })
    setDraft(null)
  }

  const remove = (id: string): void => {
    updateSettings({ customAgents: agents.filter((agent) => agent.id !== id) })
    setConfirmDelete(null)
  }

  return (
    <>
      <div className="ada-set-title">Custom agents</div>
      <div className="ada-set-sub">
        Saved roles for Claude Code. Right-click an empty zone → Custom agent to open one: a new
        Claude Code pane starts and is sent the prompt as its first message.
      </div>

      <div className="ada-set-cards">
        <div className="ada-set-card">
          <div className="ada-set-card-head">
            <span className="ada-set-glyph ada-set-glyph--accent">✻</span>
            <span className="ada-set-card-title">Agents</span>
            <span className="ada-set-card-spacer" />
            <Button size="sm" onClick={() => setDraft({ id: null, name: '', prompt: '' })}>
              New agent
            </Button>
          </div>

          {agents.length === 0 ? (
            <div className="ada-set-list-empty">
              No custom agents yet — for example a “Backend reviewer” whose prompt is
              /review-backend-pr.
            </div>
          ) : (
            <div className="ada-set-list">
              {agents.map((agent) => (
                <div key={agent.id} className="ada-set-item">
                  <div className="ada-set-item-text">
                    <div className="ada-set-item-name">{agent.name}</div>
                    <div className="ada-set-item-desc">{preview(agent.prompt)}</div>
                  </div>
                  <span className="ada-set-card-spacer" />
                  {confirmDelete === agent.id ? (
                    <span className="ada-set-confirm">
                      Delete?
                      <Button size="sm" variant="ghost" danger onClick={() => remove(agent.id)}>
                        Yes
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        No
                      </Button>
                    </span>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDraft({ id: agent.id, name: agent.name, prompt: agent.prompt })}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(agent.id)}>
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="ada-set-card-hint">
            The prompt is sent once, when the session starts. A pane that resumes its session keeps
            the role it already has; Start fresh sends the prompt again.
          </div>
        </div>
      </div>

      <Modal
        open={draft !== null}
        title={draft?.id ? 'Edit custom agent' : 'New custom agent'}
        width={560}
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        {draft && (
          <>
            <div className="ada-set-field">
              <label className="ada-set-field-label" htmlFor="ada-agent-name">
                Name
              </label>
              <TextInput
                id="ada-agent-name"
                value={draft.name}
                placeholder="Backend reviewer"
                autoFocus
                onChange={(name) => setDraft({ ...draft, name })}
              />
            </div>
            <div className="ada-set-field">
              <label className="ada-set-field-label" htmlFor="ada-agent-prompt">
                Prompt — what this agent is and what it should do
              </label>
              <textarea
                id="ada-agent-prompt"
                className="ada-input ada-set-textarea"
                value={draft.prompt}
                placeholder={'You review backend pull requests…\n\nor a slash command, e.g. /review-backend-pr'}
                rows={12}
                spellCheck
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              />
            </div>
          </>
        )}
      </Modal>
    </>
  )
}
