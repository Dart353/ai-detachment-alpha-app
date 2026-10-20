import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, TextInput } from '../ui'
import { useApp } from '../../store/app'
import type { SkillInfo, SkillSource } from '../../../../shared/types'
import './settings.css'

/** The groups, in the order they are shown: closest to the user first. */
const GROUPS: { source: SkillSource; label: string; hint: string }[] = [
  { source: 'personal', label: 'Personal', hint: '~/.claude/skills' },
  { source: 'project', label: 'Project', hint: 'in an open workspace' },
  { source: 'synced', label: 'Synced', hint: 'from claude.ai' },
  { source: 'plugin', label: 'Plugin', hint: 'installed plugins' }
]

/**
 * Settings → Skills: every SKILL.md Claude Code can see from this machine,
 * grouped by where it came from. Clicking one opens it in a viewer pane, which
 * is the whole point — a skill is a document, and the app already reads those.
 */
export default function Skills(): JSX.Element {
  const workspaces = useApp((state) => state.workspaces)
  const activeWorkspaceId = useApp((state) => state.activeWorkspaceId)
  const addPane = useApp((state) => state.addPane)
  const setView = useApp((state) => state.setView)
  const pushToast = useApp((state) => state.pushToast)

  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)

  // Project skills live under the workspaces that are open, so the roots go
  // with the ask rather than main guessing at them.
  const roots = useMemo(() => workspaces.map((workspace) => workspace.rootDir), [workspaces])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const found = await window.api?.listSkills(roots)
    setSkills(found ?? [])
    setLoading(false)
  }, [roots])

  useEffect(() => {
    void load()
  }, [load])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return skills ?? []
    return (skills ?? []).filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        (skill.origin ?? '').toLowerCase().includes(needle)
    )
  }, [skills, query])

  /** Open the SKILL.md in the workspace on screen, and go back to the grid. */
  const open = (skill: SkillInfo): void => {
    const workspaceId = activeWorkspaceId ?? workspaces[0]?.id
    if (!workspaceId) {
      pushToast('Open a workspace first — a skill opens in a pane.', { kind: 'error' })
      return
    }
    addPane(workspaceId, { kind: 'viewer', filePath: skill.path })
    setView('grid')
  }

  return (
    <>
      <div className="ada-set-title">Skills</div>
      <div className="ada-set-sub">
        What Claude Code can reach for on this machine. Open one to read what it does.
      </div>

      <div className="ada-skills-bar">
        <TextInput
          value={query}
          onChange={setQuery}
          placeholder="Search skills"
          aria-label="Search skills"
        />
        <Button
          size="sm"
          icon={<RefreshCw size={12} strokeWidth={1.5} />}
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Reading…' : 'Refresh'}
        </Button>
      </div>

      {skills === null ? (
        <div className="ada-skills-empty">Reading skill folders…</div>
      ) : matches.length === 0 ? (
        <div className="ada-skills-empty">
          {skills.length === 0
            ? 'No skills found. Personal ones live in ~/.claude/skills.'
            : `Nothing matches “${query.trim()}”.`}
        </div>
      ) : (
        <div className="ada-set-cards">
          {GROUPS.map((group) => {
            const rows = matches.filter((skill) => skill.source === group.source)
            if (rows.length === 0) return null
            return (
              <div className="ada-set-card" key={group.source}>
                <div className="ada-skills-group">
                  <span className="ada-skills-group-label">{group.label}</span>
                  <span className="ada-skills-group-hint">{group.hint}</span>
                  <span className="ada-skills-count">{rows.length}</span>
                </div>
                {rows.map((skill) => (
                  <SkillRow key={skill.id} skill={skill} onOpen={() => open(skill)} />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function SkillRow({ skill, onOpen }: { skill: SkillInfo; onOpen: () => void }): JSX.Element {
  return (
    <div
      className="ada-skills-row"
      role="button"
      tabIndex={0}
      title={skill.path}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
    >
      <div className="ada-skills-row-head">
        <span className="ada-skills-name">{skill.name}</span>
        {skill.origin && <span className="ada-skills-origin">{skill.origin}</span>}
      </div>
      {skill.description && <div className="ada-skills-desc">{skill.description}</div>}
    </div>
  )
}
