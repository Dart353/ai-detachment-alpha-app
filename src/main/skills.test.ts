import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSkills, parseSkillFrontmatter } from './skills'

describe('reading a SKILL.md header', () => {
  it('takes the name and a one-line description', () => {
    expect(
      parseSkillFrontmatter('---\nname: restura\ndescription: Edits schema files.\n---\n\n# Restura')
    ).toEqual({ name: 'restura', description: 'Edits schema files.' })
  })

  it('joins a folded description back into one line', () => {
    // `description: >` is how most real skills are written; without folding,
    // the list would show the first line only.
    const text = [
      '---',
      'name: review-backend-pr',
      'description: >',
      "  Analyze a pull request's backend code for assumptions,",
      '  simplification opportunities and naming issues.',
      'metadata: {}',
      '---'
    ].join('\n')
    expect(parseSkillFrontmatter(text)).toMatchObject({
      name: 'review-backend-pr',
      description:
        "Analyze a pull request's backend code for assumptions, simplification opportunities and naming issues."
    })
  })

  it('strips the quotes a quoted value carries', () => {
    expect(parseSkillFrontmatter('---\nname: "my-skill"\ndescription: \'Does a thing.\'\n---')).toEqual(
      { name: 'my-skill', description: 'Does a thing.' }
    )
  })

  it('unescapes the quotes inside a double-quoted description', () => {
    const text = '---\nname: built-in-browser\ndescription: "Also called \\"your own browser\\"."\n---'
    expect(parseSkillFrontmatter(text).description).toBe('Also called "your own browser".')
  })

  it('returns nothing for a file with no frontmatter', () => {
    expect(parseSkillFrontmatter('# Just a heading\n')).toEqual({})
    expect(parseSkillFrontmatter('')).toEqual({})
  })
})

/* === discovery, against a real tree ========================================= */

let home = ''
/** The `.claude` directory each case builds; passed to listSkills explicitly. */
let claudeDir = ''

/** A skill directory holding the given frontmatter. */
function writeSkill(dir: string, name: string, description: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`
  )
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ada-skills-')))
  claudeDir = path.join(home, '.claude')
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('listing what is on disk', () => {
  it('finds personal, synced, plugin and project skills, and labels each', () => {
    const claude = claudeDir
    writeSkill(path.join(claude, 'skills', 'restura'), 'restura', 'Edits schemas.')
    writeSkill(
      path.join(claude, 'skills', 'synced', 'account-1', 'morning'),
      'morning',
      'The morning brief.'
    )

    const installPath = path.join(claude, 'plugins', 'cache', 'official', 'figma', '2.2.157')
    writeSkill(path.join(installPath, 'skills', 'figma-use'), 'figma-use', 'Drives Figma.')
    fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true })
    fs.writeFileSync(
      path.join(claude, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'figma@official': [{ scope: 'user', installPath }] } })
    )

    const project = path.join(home, 'work', 'my-app')
    writeSkill(path.join(project, '.claude', 'skills', 'deploy'), 'deploy', 'Ships it.')

    const skills = listSkills([project], claudeDir)
    const bySource = Object.fromEntries(skills.map((s) => [s.name, s]))

    expect(skills.map((s) => s.name)).toEqual(['deploy', 'figma-use', 'morning', 'restura'])
    expect(bySource['restura']).toMatchObject({ source: 'personal', description: 'Edits schemas.' })
    expect(bySource['morning']).toMatchObject({ source: 'synced' })
    expect(bySource['figma-use']).toMatchObject({ source: 'plugin', origin: 'figma' })
    expect(bySource['deploy']).toMatchObject({ source: 'project', origin: 'my-app' })
  })

  it('names a skill after its folder when the frontmatter has none', () => {
    const dir = path.join(claudeDir, 'skills', 'nameless')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# no frontmatter here\n')
    expect(listSkills([], claudeDir)).toMatchObject([{ name: 'nameless', description: '' }])
  })

  it('ignores a directory that holds no SKILL.md', () => {
    fs.mkdirSync(path.join(claudeDir, 'skills', 'not-a-skill', 'src'), { recursive: true })
    expect(listSkills([], claudeDir)).toEqual([])
  })

  it('is empty, not broken, when nothing exists', () => {
    fs.rmSync(claudeDir, { recursive: true, force: true })
    expect(listSkills(['/nope'], claudeDir)).toEqual([])
  })

  it('lists a plugin installed at two scopes once, even from two cached paths', () => {
    // How the real cache looks: one directory per scope, same plugin.
    const claude = claudeDir
    const userPath = path.join(claude, 'plugins', 'cache', 'official', 'fd', 'dfffc8c43f48')
    const projectPath = path.join(claude, 'plugins', 'cache', 'official', 'fd', 'unknown')
    writeSkill(path.join(userPath, 'skills', 'frontend-design'), 'frontend-design', 'Design.')
    writeSkill(path.join(projectPath, 'skills', 'frontend-design'), 'frontend-design', 'Design.')
    fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true })
    fs.writeFileSync(
      path.join(claude, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'frontend-design@official': [
            { scope: 'user', installPath: userPath },
            { scope: 'project', installPath: projectPath }
          ]
        }
      })
    )
    expect(listSkills([], claudeDir).filter((s) => s.name === 'frontend-design')).toHaveLength(1)
  })

  it('lists a plugin installed at two scopes once', () => {
    const claude = claudeDir
    const installPath = path.join(claude, 'plugins', 'cache', 'official', 'dup', '1.0.0')
    writeSkill(path.join(installPath, 'skills', 'dup-skill'), 'dup-skill', 'Once only.')
    fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true })
    fs.writeFileSync(
      path.join(claude, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'dup@official': [
            { scope: 'user', installPath },
            { scope: 'project', installPath }
          ]
        }
      })
    )
    expect(listSkills([], claudeDir).filter((s) => s.name === 'dup-skill')).toHaveLength(1)
  })
})
