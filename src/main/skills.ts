import fs from 'node:fs'
import path from 'node:path'
import type { SkillInfo, SkillSource } from '../shared/types'
import { claudeDir, toHost, toStored } from './platform'

/**
 * Where Claude Code's skills live, and what each one says it does.
 *
 * A skill is a directory holding `SKILL.md`, whose YAML frontmatter carries the
 * `name` and `description` Claude matches against. They arrive from four
 * places, and the list keeps them apart because "mine" and "something a plugin
 * brought" are different kinds of thing to the person reading:
 *
 *   personal  ~/.claude/skills/<name>/SKILL.md
 *   synced    ~/.claude/skills/synced/<account>/<name>/SKILL.md   (from claude.ai)
 *   project   <workspace>/.claude/skills/<name>/SKILL.md
 *   plugin    <installPath>/skills/<name>/SKILL.md
 *
 * Plugins are read from `installed_plugins.json` rather than by walking the
 * plugin folder: that folder is a content-addressed cache holding every version
 * ever fetched, so globbing it lists the same skill a dozen times.
 */

/** A frontmatter line we can use, out of the block between the first two `---`. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

/**
 * `name` and `description` out of a SKILL.md. Deliberately not a YAML parser:
 * the two fields are flat strings, but `description` is very often a folded
 * block (`description: >`) running over many indented lines, so those are
 * joined back into one line.
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const block = FRONTMATTER.exec(text)
  if (!block) return {}
  const lines = block[1]?.split(/\r?\n/) ?? []
  const out: { name?: string; description?: string } = {}

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const match = /^(name|description):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as 'name' | 'description'
    let value = (match[2] ?? '').trim()

    // A folded or literal block: the value is the indented lines beneath it.
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? ''
        if (next.trim() && !/^\s/.test(next)) break
        parts.push(next.trim())
        i = j
      }
      value = parts.join(' ').trim()
    }
    out[key] = unquote(value)
  }
  return out
}

function unquote(value: string): string {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value.trim())
  if (!quoted) return value.trim()
  const inner = quoted[2] ?? ''
  // A double-quoted YAML scalar escapes its own quotes and backslashes; left
  // as-is they reach the list as literal \" and read as a typo.
  return (quoted[1] === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner).trim()
}

/** One skill directory → its entry, or null when it holds no readable SKILL.md. */
function readSkillDir(dir: string, source: SkillSource, origin?: string): SkillInfo | null {
  const file = path.join(dir, 'SKILL.md')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null // not a skill directory, or unreadable
  }
  const front = parseSkillFrontmatter(text)
  const stored = toStored(file)
  return {
    id: `${source}:${stored}`,
    // A skill with no frontmatter name still belongs in the list; its folder
    // is what Claude would call it anyway.
    name: front.name || path.basename(dir),
    description: front.description ?? '',
    source,
    origin,
    path: stored
  }
}

/** Every immediate child of `dir` that is a skill. */
function readSkillsIn(dir: string, source: SkillSource, origin?: string): SkillInfo[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(toHost(dir), { withFileTypes: true })
  } catch {
    return [] // no such directory is the normal case, not an error
  }
  const out: SkillInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const found = readSkillDir(path.join(toHost(dir), entry.name), source, origin)
    if (found) out.push(found)
  }
  return out
}

/**
 * Skills synced from claude.ai: one directory per account under `synced`, with
 * the skills inside it. The account id means nothing to the reader, so it is
 * not carried through as an origin.
 */
function readSyncedSkills(skillsDir: string): SkillInfo[] {
  const synced = path.join(toHost(skillsDir), 'synced')
  let accounts: fs.Dirent[] = []
  try {
    accounts = fs.readdirSync(synced, { withFileTypes: true })
  } catch {
    return []
  }
  return accounts
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readSkillsIn(path.join(synced, entry.name), 'synced'))
}

/** Installed plugins, as `<plugin name> → <install path>`. */
function installedPlugins(dir: string): { name: string; installPath: string }[] {
  const file = path.join(toHost(dir), 'plugins', 'installed_plugins.json')
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const plugins = (raw as { plugins?: Record<string, unknown> })?.plugins
  if (!plugins || typeof plugins !== 'object') return []

  const out: { name: string; installPath: string }[] = []
  for (const [key, value] of Object.entries(plugins)) {
    // One entry per install scope; each carries its own path.
    for (const install of Array.isArray(value) ? value : [value]) {
      const installPath = (install as { installPath?: unknown })?.installPath
      if (typeof installPath !== 'string' || !installPath) continue
      // "skill-creator@claude-plugins-official" reads as its plugin name.
      out.push({ name: key.split('@')[0] ?? key, installPath })
    }
  }
  return out
}

/**
 * Every skill this machine can offer, with the workspace roots the renderer
 * has open so project skills come along. `dir` is the `.claude` directory,
 * injectable so a test can point the whole walk at a temp tree. Unreadable sources are skipped rather
 * than failing the list: a missing plugin folder is not an error to report.
 */
export function listSkills(workspaceRoots: string[] = [], dir = claudeDir()): SkillInfo[] {
  const skillsDir = path.join(dir, 'skills')
  const out: SkillInfo[] = [
    ...readSkillsIn(skillsDir, 'personal'),
    ...readSyncedSkills(skillsDir)
  ]

  for (const plugin of installedPlugins(dir)) {
    out.push(...readSkillsIn(path.join(plugin.installPath, 'skills'), 'plugin', plugin.name))
  }

  for (const root of workspaceRoots) {
    if (typeof root !== 'string' || !root) continue
    out.push(
      ...readSkillsIn(path.join(root, '.claude', 'skills'), 'project', path.basename(root))
    )
  }

  // A plugin installed at both user and project scope is cached under one path
  // per scope, so the same skill is read twice from two different files: it is
  // one skill to the reader, and identity for a plugin skill is therefore the
  // plugin and the name, not the path it happened to be read from. Everything
  // else stays keyed by file, where two skills of the same name in different
  // folders really are two skills.
  const seen = new Set<string>()
  return out
    .filter((skill) => {
      const key =
        skill.source === 'plugin' ? `plugin:${skill.origin ?? ''}:${skill.name}` : skill.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
