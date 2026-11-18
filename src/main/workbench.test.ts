import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKBENCH_CAPTURES_DIR,
  WORKBENCH_FILE,
  WORKBENCH_INSTRUCTIONS,
  WORKBENCH_RULES_FILE,
  WORKBENCH_SKELETON
} from '../shared/workbench'
import type { WorkbenchSnapshot } from '../shared/types'
import {
  excludePatterns,
  findRepo,
  readWorkbench,
  rulesFileText,
  rulesStateOf,
  setupWorkbench,
  WorkbenchWatcher,
  workbenchState
} from './workbench'

/** Real temp folders throughout: this module is the disk, not logic. */
let root = ''

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ada-wb-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const at = (...parts: string[]): string => path.join(root, ...parts)
const read = (...parts: string[]): string => fs.readFileSync(at(...parts), 'utf8')

/** A folder that looks like a git repository to `findRepo`. */
function gitInit(dir = root): void {
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true })
}

function section(agent: string, status: string): string {
  return `<section data-agent="${agent}" data-status="${status}"><h2>${agent}</h2></section>`
}

describe('rulesStateOf', () => {
  it('reads what this build writes as current', () => {
    expect(rulesStateOf(rulesFileText())).toBe('current')
  })

  it('is missing when there is no file', () => {
    expect(rulesStateOf(null)).toBe('missing')
  })

  it('calls an untouched rule from another version outdated', () => {
    const old = 'old instructions\n'
    const hash = createHash('sha256').update(old).digest('hex')
    expect(rulesStateOf(`<!-- ada:workbench v0 sha256:${hash} -->\n${old}`)).toBe('outdated')
  })

  it('calls a hand-edited rule modified', () => {
    expect(rulesStateOf(`${rulesFileText()}\n- my own extra line\n`)).toBe('modified')
  })

  it('calls a file without our marker modified, so it is never overwritten unasked', () => {
    expect(rulesStateOf(WORKBENCH_INSTRUCTIONS)).toBe('modified')
  })
})

describe('setupWorkbench', () => {
  it('installs the rule, the page and the captures folder, and excludes them', () => {
    gitInit()
    const result = setupWorkbench(root)
    expect(result).toEqual({ ok: true, state: { rules: 'current', page: true, excluded: true } })
    expect(read(WORKBENCH_RULES_FILE)).toBe(rulesFileText())
    expect(read(WORKBENCH_FILE)).toBe(WORKBENCH_SKELETON)
    expect(fs.statSync(at(WORKBENCH_CAPTURES_DIR)).isDirectory()).toBe(true)
    const exclude = read('.git', 'info', 'exclude')
    for (const pattern of excludePatterns('')) expect(exclude).toContain(`${pattern}\n`)
  })

  it('is idempotent: running it again adds no second set of exclude lines', () => {
    gitInit()
    setupWorkbench(root)
    const once = read('.git', 'info', 'exclude')
    setupWorkbench(root)
    expect(read('.git', 'info', 'exclude')).toBe(once)
  })

  it('keeps what the exclude file already had', () => {
    gitInit()
    fs.writeFileSync(at('.git', 'info', 'exclude'), '# mine\n*.log')
    setupWorkbench(root)
    expect(read('.git', 'info', 'exclude').startsWith('# mine\n*.log\n')).toBe(true)
  })

  it('never touches .gitignore', () => {
    gitInit()
    fs.writeFileSync(at('.gitignore'), 'node_modules\n')
    setupWorkbench(root)
    expect(read('.gitignore')).toBe('node_modules\n')
  })

  it('never replaces a page an agent already wrote', () => {
    const page = `<html>${section('claude: a', 'working')}</html>`
    fs.writeFileSync(at(WORKBENCH_FILE), page)
    setupWorkbench(root)
    expect(read(WORKBENCH_FILE)).toBe(page)
  })

  it('updates an outdated rule but leaves a hand-edited one alone unless asked', () => {
    fs.mkdirSync(path.dirname(at(WORKBENCH_RULES_FILE)), { recursive: true })
    const edited = `${rulesFileText()}\n- my own line\n`
    fs.writeFileSync(at(WORKBENCH_RULES_FILE), edited)

    const kept = setupWorkbench(root)
    expect(kept.ok && kept.state.rules).toBe('modified')
    expect(read(WORKBENCH_RULES_FILE)).toBe(edited)

    const replaced = setupWorkbench(root, { replaceModifiedRules: true })
    expect(replaced.ok && replaced.state.rules).toBe('current')
  })

  it('works outside git, and says so', () => {
    expect(setupWorkbench(root)).toEqual({
      ok: true,
      state: { rules: 'current', page: true, excluded: null }
    })
  })

  it('fails cleanly for a folder that is gone', () => {
    expect(setupWorkbench(at('nope'))).toEqual({ ok: false, error: 'The folder no longer exists.' })
  })
})

describe('findRepo', () => {
  it('finds the repository above a workspace opened in a subfolder', () => {
    gitInit()
    fs.mkdirSync(at('packages', 'web'), { recursive: true })
    expect(findRepo(at('packages', 'web'))).toEqual({
      infoDir: at('.git', 'info'),
      prefix: 'packages/web'
    })
    expect(excludePatterns('packages/web')[0]).toBe(`/packages/web/${WORKBENCH_FILE}`)
  })

  it('follows a worktree pointer to the shared git dir', () => {
    // main/.git is the real repo; wt/.git points at main/.git/worktrees/wt,
    // which names the shared dir in `commondir`.
    const main = at('main')
    const wtGit = path.join(main, '.git', 'worktrees', 'wt')
    fs.mkdirSync(wtGit, { recursive: true })
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n')
    fs.mkdirSync(at('wt'))
    fs.writeFileSync(at('wt', '.git'), `gitdir: ${wtGit}\n`)
    expect(findRepo(at('wt'))).toEqual({ infoDir: path.join(main, '.git', 'info'), prefix: '' })
  })

  it('reports no repository for a plain folder', () => {
    expect(findRepo(root)).toBeNull()
  })
})

describe('workbenchState', () => {
  it('describes a folder with nothing set up', () => {
    gitInit()
    expect(workbenchState(root)).toEqual({ rules: 'missing', page: false, excluded: false })
  })
})

describe('readWorkbench', () => {
  it('parses the page', () => {
    fs.writeFileSync(at(WORKBENCH_FILE), section('claude: a', 'needs-input'))
    const snapshot = readWorkbench(root)
    expect(snapshot.exists).toBe(true)
    expect(snapshot.sections.map((s) => [s.agent, s.status])).toEqual([['claude: a', 'needs-input']])
  })

  it('reports a missing page as no sections', () => {
    expect(readWorkbench(root)).toMatchObject({ rootDir: root, exists: false, sections: [] })
  })
})

describe('WorkbenchWatcher', () => {
  /** Resolve with the next snapshot the watcher pushes that satisfies `match`. */
  function next(
    pushed: WorkbenchSnapshot[],
    match: (snapshot: WorkbenchSnapshot) => boolean
  ): Promise<WorkbenchSnapshot> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000
      const poll = (): void => {
        const hit = pushed.find(match)
        if (hit) return resolve(hit)
        if (Date.now() > deadline) return reject(new Error(`no match in ${JSON.stringify(pushed)}`))
        setTimeout(poll, 20)
      }
      poll()
    })
  }

  it('pushes the page on subscribe and again when an agent rewrites it', async () => {
    const pushed: WorkbenchSnapshot[] = []
    const watcher = new WorkbenchWatcher((snapshot) => pushed.push(snapshot), { debounceMs: 20 })
    try {
      watcher.watch('w1', root)
      expect(pushed).toEqual([expect.objectContaining({ exists: false, sections: [] })])

      // Written the way an editor or agent replaces a file: temp + rename.
      fs.writeFileSync(at('tmp'), section('claude: a', 'blocked'))
      fs.renameSync(at('tmp'), at(WORKBENCH_FILE))
      const hit = await next(pushed, (s) => s.sections[0]?.status === 'blocked')
      expect(hit.rootDir).toBe(root)
    } finally {
      watcher.dispose()
    }
  })

  it('still sees a rewrite when no file events arrive at all (WSL shares)', async () => {
    const pushed: WorkbenchSnapshot[] = []
    const watcher = new WorkbenchWatcher((snapshot) => pushed.push(snapshot), {
      debounceMs: 20,
      pollMs: 40,
      useFsWatch: false
    })
    try {
      watcher.watch('w1', root)
      fs.writeFileSync(at(WORKBENCH_FILE), section('claude: a', 'needs-input'))
      await next(pushed, (s) => s.sections[0]?.status === 'needs-input')
    } finally {
      watcher.dispose()
    }
  })

  it('pushes nothing for a rewrite that changes nothing', async () => {
    fs.writeFileSync(at(WORKBENCH_FILE), section('claude: a', 'working'))
    const pushed: WorkbenchSnapshot[] = []
    const watcher = new WorkbenchWatcher((snapshot) => pushed.push(snapshot), { debounceMs: 20 })
    try {
      watcher.watch('w1', root)
      fs.writeFileSync(at(WORKBENCH_FILE), section('claude: a', 'working'))
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(pushed).toHaveLength(1)
    } finally {
      watcher.dispose()
    }
  })

  it('ignores other files in the root', async () => {
    const pushed: WorkbenchSnapshot[] = []
    const watcher = new WorkbenchWatcher((snapshot) => pushed.push(snapshot), { debounceMs: 20 })
    try {
      watcher.watch('w1', root)
      fs.writeFileSync(at('other.txt'), 'x')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(pushed).toHaveLength(1)
    } finally {
      watcher.dispose()
    }
  })

  it('resends the page to a subscriber that comes back, as a reloaded renderer does', () => {
    const pushed: WorkbenchSnapshot[] = []
    const watcher = new WorkbenchWatcher((snapshot) => pushed.push(snapshot), { debounceMs: 20 })
    try {
      watcher.watch('w1', root)
      watcher.watch('w1', root)
      expect(pushed).toHaveLength(2)
      expect(watcher.rootCount).toBe(1)
    } finally {
      watcher.dispose()
    }
  })

  it('closes a root once its last subscriber leaves', () => {
    const watcher = new WorkbenchWatcher(() => {}, { debounceMs: 20 })
    watcher.watch('a', root)
    watcher.watch('b', root)
    watcher.unwatch('a', root)
    expect(watcher.rootCount).toBe(1)
    watcher.unwatch('b', root)
    expect(watcher.rootCount).toBe(0)
  })
})
