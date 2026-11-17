import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_FILE,
  WORKBENCH_INSTRUCTIONS,
  WORKBENCH_MAX_BYTES,
  WORKBENCH_SKELETON,
  WORKBENCH_TOKENS,
  parseWorkbench,
  wantsUser
} from './workbench'

const tokensCss = readFileSync(
  fileURLToPath(new URL('../renderer/src/styles/tokens.css', import.meta.url)),
  'utf8'
)

/** A section the way an agent following the rules writes one. */
function section(attrs: string, body: string): string {
  return `<section ${attrs}>${body}</section>`
}

function page(...sections: string[]): string {
  return WORKBENCH_SKELETON.replace(/<section[\s\S]*<\/section>/, sections.join('\n'))
}

describe('the workbench contract', () => {
  it('ships a skeleton that parses as one working task', () => {
    expect(parseWorkbench(WORKBENCH_SKELETON)).toEqual([
      {
        agent: 'claude: your-task-slug',
        title: 'Task',
        status: 'working',
        now: 'Describe the step you are on.',
        counts: { done: 0, working: 1, queued: 1 },
        question: null
      }
    ])
  })

  it('ends the instructions with the skeleton, so an agent can create the page', () => {
    expect(WORKBENCH_INSTRUCTIONS).toContain(WORKBENCH_SKELETON)
    expect(WORKBENCH_INSTRUCTIONS).toContain(WORKBENCH_FILE)
  })

  it('keeps the rule small enough to load into every session', () => {
    expect(Buffer.byteLength(WORKBENCH_INSTRUCTIONS)).toBeLessThan(8 * 1024)
  })

  it('gives the page no network: no remote URL anywhere in the skeleton', () => {
    expect(WORKBENCH_SKELETON).not.toMatch(/https?:\/\//)
  })

  it('repeats the app tokens exactly, so the page cannot drift from the palette', () => {
    for (const [name, value] of Object.entries(WORKBENCH_TOKENS)) {
      const declared = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss)
      expect(declared?.[1].trim(), name).toBe(value)
    }
  })
})

describe('parseWorkbench', () => {
  it('reads every part of a full section', () => {
    const html = page(
      section(
        'data-agent="claude: fix-login" data-status="needs-input"',
        `<h2>Fix the login redirect</h2>
         <div class="now"><strong>Right now</strong><br>Waiting on which page to return to.</div>
         <p class="counts">2 done · 0 in progress · 1 queued</p>
         <p class="question">Should sign-in return to <em>the last page</em> or the dashboard?</p>`
      )
    )
    expect(parseWorkbench(html)).toEqual([
      {
        agent: 'claude: fix-login',
        title: 'Fix the login redirect',
        status: 'needs-input',
        now: 'Waiting on which page to return to.',
        counts: { done: 2, working: 0, queued: 1 },
        question: 'Should sign-in return to the last page or the dashboard?'
      }
    ])
  })

  it('keeps several agents apart, in page order', () => {
    const html = page(
      section('data-agent="claude: a" data-status="done"', '<h2>A</h2>'),
      section('data-agent="claude: b" data-status="blocked"', '<h2>B</h2>')
    )
    expect(parseWorkbench(html).map((s) => [s.agent, s.status])).toEqual([
      ['claude: a', 'done'],
      ['claude: b', 'blocked']
    ])
  })

  it('takes attributes in any order and quoted either way', () => {
    const html = `<section class="x" data-status='done' data-agent=claude:solo><h2>Solo</h2></section>`
    expect(parseWorkbench(html)[0]).toMatchObject({ agent: 'claude:solo', status: 'done' })
  })

  it('reads an unknown or missing status as working', () => {
    const html = page(
      section('data-agent="claude: a" data-status="thinking"', '<h2>A</h2>'),
      section('data-agent="claude: b"', '<h2>B</h2>')
    )
    expect(parseWorkbench(html).map((s) => s.status)).toEqual(['working', 'working'])
  })

  it('falls back to the agent for a section with no heading, and nulls for missing parts', () => {
    expect(parseWorkbench(section('data-agent="claude: bare"', '<p>hi</p>'))).toEqual([
      { agent: 'claude: bare', title: 'claude: bare', status: 'working', now: null, counts: null, question: null }
    ])
  })

  it('skips sections that are not tasks, and commented-out ones', () => {
    const html = `<section><h2>About</h2></section>
      <!-- <section data-agent="claude: old" data-status="blocked"><h2>Old</h2></section> -->
      <section data-agent="claude: live"><h2>Live</h2></section>`
    expect(parseWorkbench(html).map((s) => s.agent)).toEqual(['claude: live'])
  })

  it('treats "None." and friends as no question', () => {
    for (const none of ['None.', 'None. No input needed.', 'none', 'N/A', 'Nothing yet']) {
      const html = section('data-agent="claude: a"', `<p class="question">${none}</p>`)
      expect(parseWorkbench(html)[0].question, none).toBeNull()
    }
  })

  it('decodes entities and flattens markup to one line', () => {
    const html = section(
      'data-agent="claude: a"',
      '<h2>Fish &amp; chips &#8212; &lt;now&gt;</h2><div class="now">one<br/>two\n\nthree</div>'
    )
    expect(parseWorkbench(html)[0]).toMatchObject({ title: 'Fish & chips — <now>', now: 'one two three' })
  })

  it('ignores script and style text', () => {
    const html = section(
      'data-agent="claude: a"',
      '<h2>T</h2><div class="now"><script>alert(1)</script>Building<style>p{}</style></div>'
    )
    expect(parseWorkbench(html)[0].now).toBe('Building')
  })

  it('caps long text', () => {
    const html = section('data-agent="claude: a"', `<h2>${'x'.repeat(5000)}</h2>`)
    expect(parseWorkbench(html)[0].title.length).toBeLessThanOrEqual(300)
  })

  it('caps the number of sections', () => {
    const many = Array.from({ length: 80 }, (_, i) => section(`data-agent="claude: t${i}"`, `<h2>${i}</h2>`))
    expect(parseWorkbench(many.join(''))).toHaveLength(50)
  })

  it('refuses an oversized page instead of parsing it', () => {
    const huge = section('data-agent="claude: a"', 'x'.repeat(WORKBENCH_MAX_BYTES))
    expect(parseWorkbench(huge)).toEqual([])
  })

  it('survives an unclosed section without hanging', () => {
    expect(parseWorkbench('<section data-agent="claude: a"><h2>Half')).toEqual([])
  })
})

describe('wantsUser', () => {
  it('is true only for needs-input and blocked', () => {
    expect(wantsUser({ status: 'needs-input' })).toBe(true)
    expect(wantsUser({ status: 'blocked' })).toBe(true)
    expect(wantsUser({ status: 'working' })).toBe(false)
    expect(wantsUser({ status: 'done' })).toBe(false)
  })
})
