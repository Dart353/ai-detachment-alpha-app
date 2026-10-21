import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowLeft, Code, Copy, Eye, RefreshCw } from 'lucide-react'
import { Button, TextInput } from '../ui'
import { useApp } from '../../store/app'
import type { FileReadResult, SkillInfo, SkillSource } from '../../../../shared/types'
import './settings.css'

// The same lazy chunk the viewer pane renders markdown with.
const MarkdownPreview = lazy(() => import('../MarkdownPreview'))

/** The groups, in the order they are shown: closest to the user first. */
const GROUPS: { source: SkillSource; label: string; hint: string }[] = [
  { source: 'personal', label: 'Personal', hint: '~/.claude/skills' },
  { source: 'project', label: 'Project', hint: 'in an open workspace' },
  { source: 'synced', label: 'Synced', hint: 'from claude.ai' },
  { source: 'plugin', label: 'Plugin', hint: 'installed plugins' }
]

/**
 * Settings → Skills: every SKILL.md Claude Code can see from this machine,
 * grouped by where it came from. Clicking one reads it right here, in place of
 * the list — a skill is a document, and Settings should not send you elsewhere
 * to read one.
 */
export default function Skills(): JSX.Element {
  const workspaces = useApp((state) => state.workspaces)

  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  /** The skill being read; null shows the list. */
  const [opened, setOpened] = useState<SkillInfo | null>(null)
  const closeDetail = useCallback(() => setOpened(null), [])

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

  if (opened) return <SkillDetail skill={opened} onBack={closeDetail} />

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
                  <SkillRow key={skill.id} skill={skill} onOpen={() => setOpened(skill)} />
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

/** SKILL.md without its YAML frontmatter, which the detail header already shows. */
function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(content)
  return match ? content.slice(match[0].length) : content
}

/** One skill read in place: its SKILL.md rendered, with a way back to the list. */
function SkillDetail({ skill, onBack }: { skill: SkillInfo; onBack: () => void }): JSX.Element {
  const pushToast = useApp((state) => state.pushToast)
  const [result, setResult] = useState<FileReadResult | null>(null)
  /** Opens rendered, like the viewer pane; the toggle flips to the raw file. */
  const [mode, setMode] = useState<'preview' | 'source'>('preview')

  useEffect(() => {
    let live = true
    setResult(null)
    void window.api.readFile(skill.path).then((next) => {
      if (live) setResult(next)
    })
    return () => {
      live = false
    }
  }, [skill.path])

  // Escape goes back to the list first. Captured, and marked handled, so the
  // Settings screen's own Escape (which leaves Settings) waits for the next one.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      onBack()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onBack])

  const renderBody = (): JSX.Element => {
    if (result === null) return <div className="ada-skills-empty">Reading…</div>
    if (result.kind !== 'text') {
      return (
        <div className="ada-skills-empty">
          This skill could not be read.
          {result.kind === 'error' && result.message ? ` (${result.message})` : ''}
        </div>
      )
    }
    if (mode === 'source') return <pre className="ada-skill-source">{result.content}</pre>
    return (
      <Suspense fallback={<div className="ada-skills-empty">Rendering…</div>}>
        <MarkdownPreview content={stripFrontmatter(result.content)} filePath={skill.path} />
      </Suspense>
    )
  }

  return (
    <>
      <div className="ada-skill-nav">
        <Button size="sm" icon={<ArrowLeft size={12} strokeWidth={1.5} />} onClick={onBack}>
          Skills
        </Button>
        {result?.kind === 'text' && (
          <div className="ada-skill-actions">
            <Button
              size="sm"
              variant="ghost"
              icon={
                mode === 'preview' ? (
                  <Code size={12} strokeWidth={1.5} />
                ) : (
                  <Eye size={12} strokeWidth={1.5} />
                )
              }
              onClick={() => setMode((current) => (current === 'preview' ? 'source' : 'preview'))}
            >
              {mode === 'preview' ? 'Source' : 'Preview'}
            </Button>
            {/* The whole SKILL.md, frontmatter included, so whoever it is pasted
                to can drop it straight into their own skills folder. */}
            <Button
              size="sm"
              icon={<Copy size={12} strokeWidth={1.5} />}
              title="Copy the SKILL.md to share it"
              onClick={() => {
                window.api.copyText(result.content)
                pushToast(`Copied ${skill.name}'s SKILL.md.`)
              }}
            >
              Copy
            </Button>
          </div>
        )}
      </div>

      <div className="ada-set-title ada-skill-title">{skill.name}</div>
      {skill.description && <div className="ada-set-sub">{skill.description}</div>}
      <div className="ada-skill-path" title={skill.path}>
        {skill.origin ? `${skill.origin} · ` : ''}
        {skill.path}
      </div>

      <div className="ada-set-card ada-skill-body">{renderBody()}</div>
    </>
  )
}
