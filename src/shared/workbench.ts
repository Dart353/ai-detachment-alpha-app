/**
 * The workbench: one live HTML page per workspace that every agent working in
 * it keeps up to date, so the user can follow the work without reading a
 * terminal.
 *
 * The page belongs to the agents. ADA writes the skeleton once, when the user
 * sets the workbench up, and never edits it again — several agents rewrite
 * their own sections of it, and a third writer would only race them. ADA's
 * side is reading: the viewer pane renders the page, and `parseWorkbench`
 * pulls out what the status engine and the phone need (who is on what, and
 * who is waiting on the user) as plain data.
 *
 * Claude learns the contract from `WORKBENCH_INSTRUCTIONS`, installed as a
 * project rule (`.claude/rules/ada-workbench.md`), which Claude Code loads
 * into every session started in the folder — ADA's panes, a resumed session,
 * or `claude` typed by hand.
 *
 * Pure and dependency-free: main parses with it, the tests run it, and
 * nothing here may touch the DOM, because main has none.
 */

/** The page, at the workspace root. */
export const WORKBENCH_FILE = 'workbench.html'

/** Where the instructions are installed, relative to the workspace root. */
export const WORKBENCH_RULES_FILE = '.claude/rules/ada-workbench.md'

/**
 * Where agents keep screenshots and recordings the page links to. Kept out of
 * git with the page, so captures never end up in a commit.
 */
export const WORKBENCH_CAPTURES_DIR = '.workbench'

/**
 * Bumped whenever the instructions change in a way an installed copy should
 * be offered the update for. The installed file carries it in its marker.
 */
export const WORKBENCH_INSTRUCTIONS_VERSION = 1

/** What an agent declares about its own task. */
export type WorkbenchStatus = 'working' | 'needs-input' | 'blocked' | 'done'

export const WORKBENCH_STATUSES: readonly WorkbenchStatus[] = [
  'working',
  'needs-input',
  'blocked',
  'done'
]

/**
 * The page's colours. A standalone page cannot read the app's CSS variables,
 * so these repeat `styles/tokens.css` — the test holds them to it, so the
 * palette (and its no-red rule) cannot drift here.
 */
export const WORKBENCH_TOKENS = {
  '--ada-accent': '#f05219',
  '--ada-warn': '#e0784a',
  '--ada-done': '#7ec27a',
  '--ada-bg-window': '#1c1c1f',
  '--ada-bg-pane-header': '#141417',
  '--ada-text-strong': '#f0f0f3',
  '--ada-text-primary': '#e7e7ea',
  '--ada-text-tertiary': '#a3a3aa',
  '--ada-text-muted': '#8b8b93',
  '--ada-line-10': 'rgba(255, 255, 255, 0.1)'
} as const

const TOKEN_CSS = Object.entries(WORKBENCH_TOKENS)
  .map(([name, value]) => `${name}:${value}`)
  .join(';')

/**
 * The shared style block. Agents are told to keep it as it is, so every task
 * on the page — whoever wrote it — looks the same.
 */
export const WORKBENCH_STYLE_TAG = `<style id="ada-workbench-style">
:root{${TOKEN_CSS};color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--ada-bg-window);color:var(--ada-text-primary);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{margin-bottom:14px}
h1{margin:0;font-size:16px;color:var(--ada-text-strong)}
h2{margin:0 0 6px;font-size:14px;color:var(--ada-text-strong)}
h3{margin:12px 0 4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ada-text-muted)}
section{margin:0 0 12px;padding:12px 14px;border:1px solid var(--ada-line-10);border-left:3px solid var(--ada-accent);border-radius:8px;background:var(--ada-bg-pane-header)}
section[data-status="needs-input"],section[data-status="blocked"]{border-left-color:var(--ada-warn)}
section[data-status="done"]{border-left-color:var(--ada-done)}
.status{display:inline-block;margin-bottom:6px;font-size:11px;color:var(--ada-text-tertiary)}
.now{margin:4px 0}
.counts,.muted{color:var(--ada-text-muted)}
ul{margin:4px 0;padding-left:18px}
li[data-state="done"]{color:var(--ada-text-muted);text-decoration:line-through}
li[data-state="working"]{color:var(--ada-text-strong)}
li[data-state="queued"]{color:var(--ada-text-tertiary)}
a{color:var(--ada-accent)}
img,video{display:block;max-width:100%;margin:6px 0;border:1px solid var(--ada-line-10);border-radius:6px}
</style>`

/** What a fresh page looks like: one example task, so the shape is obvious. */
export const WORKBENCH_SKELETON = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Workbench</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${WORKBENCH_STYLE_TAG}
</head><body>
<header><h1>Workbench</h1><p class="muted">What the agents in this folder are doing, and what they need from you.</p></header>
<section data-agent="claude: your-task-slug" data-status="working">
<h2>Task</h2><span class="status">Working</span>
<div class="now"><strong>Right now</strong><br>Describe the step you are on.</div>
<h3>Progress</h3><p class="counts">0 done · 1 in progress · 1 queued</p>
<ul class="progress"><li data-state="working">Current step</li><li data-state="queued">Next step</li></ul>
<h3>Artifacts</h3><p class="muted">No outputs yet.</p>
<h3>Open questions</h3><p class="question">None.</p>
</section>
</body></html>`

/**
 * The project rule Claude reads. Kept short enough that it costs little in
 * every session's context, and ending with the skeleton so an agent that finds
 * no page can create one without guessing.
 */
export const WORKBENCH_INSTRUCTIONS = `# Workbench

This folder has a workbench: \`${WORKBENCH_FILE}\` at the project root, shown live
in AI Detachment Alpha so the user can follow your work without reading the
terminal. Several agents may work here at once and share the one page, so it is
a list of sections, one per task.

- For any task with more than one step, add your section before your first file
  change, then update it after every step: a step finished, a file produced, a
  blocker hit, a question for the user. Skip it for one-step tasks and plain
  questions.
- Your section is \`<section data-agent="claude: <task-slug>" data-status="working">\`
  with an \`<h2>\` naming the task. Pick the slug when you start and keep it.
- Read the file first and rewrite only your own section. Leave every other
  section exactly as it is, and never delete another agent's. If the file is
  missing, create it from the skeleton below.
- Keep \`data-status\` honest — the app reads it and alerts the user:
  \`working\`, \`needs-input\` (you asked the user something and are waiting),
  \`blocked\` (you cannot continue), \`done\`.
- Every section has: \`<div class="now">\` with what you are doing right now; a
  \`<p class="counts">\` reading "N done · N in progress · N queued" over a
  \`<ul class="progress">\` whose items carry \`data-state\` done, working or
  queued; artifacts as relative links to files in the project; and
  \`<p class="question">\` with your open question for the user, or "None.".
- When you finish, set \`data-status="done"\` and replace "Right now" with a
  one-line result.
- For visual changes, show them: if you have a way to capture the screen (a
  browser tool such as Playwright, \`screencapture\` on macOS, the project's own
  tooling), save before/after screenshots — or a short recording for an
  interaction — under \`${WORKBENCH_CAPTURES_DIR}/\` and show them in your section
  with \`<img src="${WORKBENCH_CAPTURES_DIR}/…">\` or \`<video src="${WORKBENCH_CAPTURES_DIR}/…" controls>\`.
  No way to capture? Skip it; never fake one.
- Write the whole file in one write or edit, ending with \`</html>\`. No temporary
  files, no renames.
- Self-contained: no external URLs, scripts, fonts or images — the page has no
  network. Link project files by relative path; never inline them as data URIs.
  Keep the file under 200 KB.
- Keep the \`<style id="ada-workbench-style">\` block as it is and use its classes;
  do not restyle the page or other tasks. Lists, not layouts: it is often shown
  in a narrow pane.
- The page, \`${WORKBENCH_CAPTURES_DIR}/\` and this rule are kept out of git, so
  search tools may skip them; open the page by its path.
- Do not edit this file. AI Detachment Alpha manages it.

Skeleton:

\`\`\`html
${WORKBENCH_SKELETON}
\`\`\`
`

/* === Reading the page === */

export interface WorkbenchCounts {
  done: number
  working: number
  queued: number
}

/** One task on the page, as much of it as the app acts on. */
export interface WorkbenchSection {
  /** `data-agent`, e.g. `claude: fix-login`. Identifies the task across rewrites. */
  agent: string
  title: string
  status: WorkbenchStatus
  /** The "Right now" line, or the result once done. */
  now: string | null
  counts: WorkbenchCounts | null
  /** The agent's open question for the user; null when it has none. */
  question: string | null
  /** How many screenshots and recordings the section shows. */
  captures: number
}

/** Pages over this are refused rather than parsed; the rules cap them at 200 KB. */
export const WORKBENCH_MAX_BYTES = 512 * 1024
/** A page with more tasks than this is somebody's mistake; the first ones win. */
const MAX_SECTIONS = 50
/** Every string the parser hands on is cut to this. */
const MAX_TEXT = 300

const SECTION_RE = /<section\b([^>]*)>([\s\S]*?)<\/section\s*>/gi
const H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/i
const CAPTURE_RE = /<(img|video)\b/gi
const COUNTS_RE = /(\d+)\s*done\D+?(\d+)\s*in progress\D+?(\d+)\s*queued/i
/** "None", "None.", "None. No input needed." — the ways an agent says it has no question. */
const NO_QUESTION_RE = /^(none|n\/a|no(thing)?)\b/i

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Markup → one line of readable text, capped. */
function textOf(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/** One attribute's value from a tag's attribute text, quoted either way or bare. */
function attr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const match = re.exec(attrs)
  if (!match) return null
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim()
}

/** The inner HTML of the first element carrying `className`, when there is one. */
function byClass(html: string, className: string): string | null {
  const open = new RegExp(
    `<(\\w+)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
    'i'
  ).exec(html)
  if (!open) return null
  const start = open.index + open[0].length
  const close = new RegExp(`</${open[1]}\\s*>`, 'i').exec(html.slice(start))
  return close ? html.slice(start, start + close.index) : html.slice(start)
}

function parseStatus(raw: string | null): WorkbenchStatus {
  const value = (raw ?? '').toLowerCase()
  return (WORKBENCH_STATUSES as readonly string[]).includes(value)
    ? (value as WorkbenchStatus)
    : 'working'
}

function parseCounts(body: string): WorkbenchCounts | null {
  const inner = byClass(body, 'counts')
  const match = inner === null ? null : COUNTS_RE.exec(textOf(inner))
  if (!match) return null
  return { done: Number(match[1]), working: Number(match[2]), queued: Number(match[3]) }
}

function parseNow(body: string): string | null {
  const inner = byClass(body, 'now')
  if (inner === null) return null
  // The label is the skeleton's furniture, not what the agent is doing.
  const text = textOf(inner).replace(/^(right now|result)\s*:?\s*/i, '')
  return text || null
}

function parseQuestion(body: string): string | null {
  const inner = byClass(body, 'question')
  if (inner === null) return null
  const text = textOf(inner)
  return text && !NO_QUESTION_RE.test(text) ? text : null
}

/**
 * Every task section on a workbench page. Tolerant by design — agents write
 * this file by hand — so a section missing its parts still counts, an unknown
 * status reads as `working`, and only a section without `data-agent` (the
 * page's own furniture, or not a task at all) is skipped.
 */
export function parseWorkbench(html: string): WorkbenchSection[] {
  if (html.length > WORKBENCH_MAX_BYTES) return []
  const page = html.replace(/<!--[\s\S]*?-->/g, '')
  const sections: WorkbenchSection[] = []
  for (const match of page.matchAll(SECTION_RE)) {
    if (sections.length >= MAX_SECTIONS) break
    const [, attrs, body] = match
    const agent = attr(attrs, 'data-agent')
    if (!agent) continue
    const h2 = H2_RE.exec(body)
    sections.push({
      agent: agent.length > MAX_TEXT ? agent.slice(0, MAX_TEXT) : agent,
      title: (h2 && textOf(h2[1])) || agent,
      status: parseStatus(attr(attrs, 'data-status')),
      now: parseNow(body),
      counts: parseCounts(body),
      question: parseQuestion(body),
      captures: body.match(CAPTURE_RE)?.length ?? 0
    })
  }
  return sections
}

/** The section statuses that mean the user is wanted. */
export function wantsUser(section: Pick<WorkbenchSection, 'status'>): boolean {
  return section.status === 'needs-input' || section.status === 'blocked'
}
