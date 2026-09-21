/**
 * End-to-end smoke test: launches the built app under a throwaway userData
 * profile and drives it over the Chrome DevTools Protocol.
 *
 * It talks to the app the way the UI does — through the zustand stores, which
 * `main.tsx` exposes as `window.__ada` when main loads the renderer with
 * `?e2e=1` (it only does that when ADA_USER_DATA is set) — rather than by
 * synthesizing clicks at coordinates any layout change would invalidate. The
 * assertions are about the DOM and the PTYs, which is where the regressions
 * this guards against actually show up: a pane respawned by a layout change, a
 * terminal blanked by a reparent, scrollback lost on a workspace switch.
 *
 * Node >= 22, no dependencies: global fetch and global WebSocket only.
 *
 * Run it with `pnpm test:e2e` (which builds first).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsDir, '..')

const DEBUG_PORT = 9234
/** How long a "the app should have done this by now" wait gets. */
const WAIT_MS = 10_000
/** PTY output is the slowest thing here: a shell has to start and echo. */
const PTY_WAIT_MS = 10_000

/** Vars that must NOT reach the child (see the README's ELECTRON_RUN_AS_NODE note). */
const STRIPPED_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT'
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A failed assertion, carrying whatever the page said at the time. */
class StepError extends Error {
  constructor(message, state) {
    super(message)
    this.state = state
  }
}

/* === the app under test ===================================================== */

function launchApp(userDataDir) {
  const electron = require('electron')
  const env = { ...process.env, ADA_USER_DATA: userDataDir }
  for (const key of STRIPPED_ENV) delete env[key]
  // --no-sandbox: Electron's sandbox needs privileges a plain WSL/Linux shell
  // does not have. It is a property of THIS harness, never of the app.
  const child = spawn(
    electron,
    ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${DEBUG_PORT}`],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const output = []
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))
  child.on('exit', (code) => {
    child.exitedWith = code
  })
  return { child, output }
}

async function waitForPageTarget(child) {
  const deadline = Date.now() + 30_000
  for (;;) {
    if (child.exitedWith !== undefined) {
      throw new Error(`the app exited with code ${child.exitedWith} before opening a window`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
      const targets = await response.json()
      const page = targets.find(
        (target) => target.type === 'page' && target.webSocketDebuggerUrl
      )
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* the debugger port is not listening yet */
    }
    if (Date.now() > deadline) throw new Error('no CDP page target appeared within 30s')
    await sleep(200)
  }
}

/* === the CDP client ========================================================= */

async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket failed to open')), {
      once: true
    })
  })

  let nextId = 1
  const pending = new Map()
  /** Everything the page complained about, for the whole run. */
  const consoleErrors = []

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(`${message.error.message} (${waiter.method})`))
      else waiter.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      consoleErrors.push(
        `uncaught: ${details.exception?.description ?? details.text ?? 'unknown exception'}`
      )
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args
        .map((arg) => arg.description ?? JSON.stringify(arg.value))
        .join(' ')
      consoleErrors.push(`console.error: ${text}`)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject, method })
      socket.send(JSON.stringify({ id, method, params }))
    })

  await send('Runtime.enable')
  await send('Page.enable')

  /** Run an async function body in the page and bring its return value back. */
  const evaluate = async (body) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      const { exception, text } = result.exceptionDetails
      throw new Error(`evaluate threw: ${exception?.description ?? text}`)
    }
    return result.result.value
  }

  return { send, evaluate, consoleErrors, close: () => socket.close() }
}

/* === assertions ============================================================= */

/**
 * Poll an expression that returns `{ ok, ... }` until it is ok. The whole object
 * is what gets printed on failure, so put the diagnosis in it.
 */
async function waitFor(cdp, what, body, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await cdp.evaluate(body)
    if (last && last.ok) return last
    if (Date.now() > deadline) throw new StepError(`timed out waiting for ${what}`, last)
    await sleep(120)
  }
}

/* === the steps ============================================================== */

/**
 * Every step is `[label, fn]`; `fn` gets the shared scratch object so a later
 * step can use ids an earlier one found.
 */
function buildSteps(cdp, dirs) {
  const json = JSON.stringify
  const store = 'window.__ada.useApp.getState()'

  return [
    [
      'first run is showing',
      async () => {
        await waitFor(
          cdp,
          'the renderer to hydrate',
          `const ada = window.__ada
           if (!ada) return { ok: false, why: 'window.__ada is missing — was ?e2e=1 applied?' }
           const state = ada.useApp.getState()
           return { ok: state.hydrated && state.view === 'firstRun', view: state.view, hydrated: state.hydrated }`,
          20_000
        )
      }
    ],
    [
      'openWorkspace shows the grid',
      async (scratch) => {
        const result = await cdp.evaluate(
          `${store}.openWorkspace(${json(dirs.projectA)})
           const state = window.__ada.useApp.getState()
           return { ok: state.view === 'grid' && state.workspaces.length === 1,
                    view: state.view,
                    count: state.workspaces.length,
                    wsId: state.workspaces[0]?.id ?? null }`
        )
        if (!result.ok) throw new StepError('opening a folder did not produce one grid', result)
        scratch.wsA = result.wsId
      }
    ],
    [
      'a terminal pane spawns and prints a prompt',
      async (scratch) => {
        scratch.paneOne = await cdp.evaluate(
          `return ${store}.addPane(${json(scratch.wsA)}, { kind: 'terminal', name: 'smoke' })`
        )
        await waitFor(
          cdp,
          'the xterm element',
          `const pane = document.querySelector('[data-pane-id="' + ${json(scratch.paneOne)} + '"]')
           return { ok: !!pane?.querySelector('.xterm'), pane: !!pane }`
        )
        await waitFor(
          cdp,
          'the shell prompt',
          `const rows = document.querySelector('[data-pane-id="' + ${json(
            scratch.paneOne
          )} + '"] .xterm-rows')
           const text = (rows?.innerText ?? '').trim()
           return { ok: text.length > 0, text }`,
          PTY_WAIT_MS
        )
      }
    ],
    [
      'the PTY runs what is typed into it',
      async (scratch) => {
        await cdp.evaluate(
          `window.api.writePty(${json(scratch.paneOne)}, 'echo ada-ok-$((6*7))\\r')
           return true`
        )
        await waitFor(
          cdp,
          'the command output',
          `const rows = document.querySelector('[data-pane-id="' + ${json(
            scratch.paneOne
          )} + '"] .xterm-rows')
           const text = rows?.innerText ?? ''
           return { ok: text.includes('ada-ok-42'), tail: text.slice(-400) }`,
          PTY_WAIT_MS
        )
      }
    ],
    [
      'layout presets never respawn or reparent a pane',
      async (scratch) => {
        scratch.paneTwo = await cdp.evaluate(
          `return ${store}.addPane(${json(scratch.wsA)}, { kind: 'terminal', name: 'second' })`
        )
        await waitFor(
          cdp,
          'the second pane to mount',
          `return { ok: !!document.querySelector('[data-pane-id="' + ${json(
            scratch.paneTwo
          )} + '"] .xterm') }`
        )
        const marked = await cdp.evaluate(
          `const ids = ${json([scratch.paneOne, scratch.paneTwo])}
           const marked = ids.map((id) => {
             const el = document.querySelector('[data-pane-id="' + id + '"]')
             if (el) el.__mark = 1
             return !!el
           })
           return { ok: marked.every(Boolean), marked }`
        )
        if (!marked.ok) throw new StepError('could not mark both pane elements', marked)

        for (const preset of ['cols-2', 'rows-2']) {
          await cdp.evaluate(
            `${store}.applyPreset(${json(scratch.wsA)}, ${json(preset)})
             return true`
          )
          await sleep(250)
          const after = await cdp.evaluate(
            `const ids = ${json([scratch.paneOne, scratch.paneTwo])}
             const els = ids.map((id) => document.querySelector('[data-pane-id="' + id + '"]'))
             const rows = document.querySelector('[data-pane-id="' + ids[0] + '"] .xterm-rows')
             return {
               ok: els.every((el) => el && el.__mark === 1) && (rows?.innerText ?? '').includes('ada-ok-42'),
               present: els.map((el) => !!el),
               marks: els.map((el) => el?.__mark ?? null),
               keptText: (rows?.innerText ?? '').includes('ada-ok-42')
             }`
          )
          if (!after.ok) throw new StepError(`preset ${preset} disturbed the panes`, after)
        }
      }
    ],
    [
      'maximize covers the canvas without unmounting the others',
      async (scratch) => {
        await cdp.evaluate(`${store}.toggleMaximize(${json(scratch.paneOne)})
                            return true`)
        const maximized = await waitFor(
          cdp,
          'the maximized geometry',
          `const first = document.querySelector('[data-pane-id="' + ${json(scratch.paneOne)} + '"]')
           const second = document.querySelector('[data-pane-id="' + ${json(scratch.paneTwo)} + '"]')
           if (!first || !second) return { ok: false, first: !!first, second: !!second }
           const grid = first.closest('.ada-grid')
           const gridBox = grid.getBoundingClientRect()
           const firstBox = first.getBoundingClientRect()
           const fills =
             Math.abs(firstBox.width - gridBox.width) < 16 && Math.abs(firstBox.height - gridBox.height) < 16
           const hidden = getComputedStyle(second).visibility === 'hidden'
           return { ok: fills && hidden && second.isConnected, fills, hidden, stillMounted: second.isConnected }`
        )
        if (!maximized.ok) throw new StepError('maximize did not behave', maximized)
        await cdp.evaluate(`${store}.toggleMaximize(${json(scratch.paneOne)})
                            return true`)
        await waitFor(
          cdp,
          'the restored geometry',
          `const second = document.querySelector('[data-pane-id="' + ${json(scratch.paneTwo)} + '"]')
           return { ok: !!second && getComputedStyle(second).visibility !== 'hidden' }`
        )
      }
    ],
    [
      'the sidebar tracks a pane rename',
      async (scratch) => {
        const before = await cdp.evaluate(
          `const names = [...document.querySelectorAll('.ada-sb-pane-name')].map((el) => el.textContent)
           return { ok: names.includes('smoke'), names }`
        )
        if (!before.ok) throw new StepError('the sidebar is not listing the pane', before)
        await cdp.evaluate(
          `${store}.renamePane(${json(scratch.paneOne)}, 'renamed')
           return true`
        )
        await waitFor(
          cdp,
          'the rename to reach sidebar and header',
          `const names = [...document.querySelectorAll('.ada-sb-pane-name')].map((el) => el.textContent)
           const header = document.querySelector('[data-pane-id="' + ${json(
             scratch.paneOne
           )} + '"] .ada-pane-name')
           return { ok: names.includes('renamed') && header?.textContent === 'renamed',
                    names, header: header?.textContent ?? null }`
        )
      }
    ],
    [
      'scrollback survives a workspace switch',
      async (scratch) => {
        const opened = await cdp.evaluate(
          `${store}.openWorkspace(${json(dirs.projectB)})
           const state = window.__ada.useApp.getState()
           return { ok: state.workspaces.length === 2, count: state.workspaces.length,
                    active: state.activeWorkspaceId }`
        )
        if (!opened.ok) throw new StepError('the second workspace did not open', opened)
        scratch.wsB = opened.active
        await sleep(300)
        await cdp.evaluate(`${store}.selectWorkspace(${json(scratch.wsA)})
                            return true`)
        await waitFor(
          cdp,
          'the first pane to still hold its output',
          `const rows = document.querySelector('[data-pane-id="' + ${json(
            scratch.paneOne
          )} + '"] .xterm-rows')
           const text = rows?.innerText ?? ''
           return { ok: text.includes('ada-ok-42'), tail: text.slice(-200) }`
        )
      }
    ],
    [
      'state survives a reload',
      async (scratch) => {
        // Longer than the persistence debounce, so the last rename is on disk.
        await sleep(1000)
        const before = await cdp.evaluate(
          `const state = window.__ada.useApp.getState()
           return JSON.stringify(state.workspaces.map((ws) => ({
             id: ws.id, rootDir: ws.rootDir, layout: ws.layout,
             panes: ws.panes.map((pane) => ({ id: pane.id, name: pane.name, kind: pane.kind }))
           })))`
        )
        await cdp.send('Page.reload')
        await waitFor(
          cdp,
          'the reloaded renderer to hydrate',
          `const ada = window.__ada
           if (!ada) return { ok: false, why: 'window.__ada is missing after reload' }
           const state = ada.useApp.getState()
           return { ok: state.hydrated && state.view === 'grid', hydrated: state.hydrated, view: state.view }`,
          20_000
        )
        const after = await cdp.evaluate(
          `const state = window.__ada.useApp.getState()
           const names = state.workspaces.flatMap((ws) => ws.panes.map((pane) => pane.name))
           return {
             count: state.workspaces.length,
             names,
             shape: JSON.stringify(state.workspaces.map((ws) => ({
               id: ws.id, rootDir: ws.rootDir, layout: ws.layout,
               panes: ws.panes.map((pane) => ({ id: pane.id, name: pane.name, kind: pane.kind }))
             })))
           }`
        )
        if (after.count !== 2) throw new StepError('the reload lost a workspace', after)
        if (!after.names.includes('renamed')) throw new StepError('the reload lost the rename', after)
        if (after.shape !== before) {
          throw new StepError('the layout changed across the reload', { before, after: after.shape })
        }
      }
    ],
    [
      'closing a workspace archives it, reopening offers a restore',
      async (scratch) => {
        await cdp.evaluate(`${store}.closeWorkspace(${json(scratch.wsA)})
                            return true`)
        await sleep(300)
        await cdp.evaluate(`${store}.openWorkspace(${json(dirs.projectA)})
                            return true`)
        await waitFor(
          cdp,
          'the restore dialog',
          `const state = window.__ada.useApp.getState()
           const dialog = document.querySelector('.ada-restore')
           return { ok: !!state.pendingRestore && !!dialog && dialog.innerText.includes('Restore'),
                    pending: !!state.pendingRestore, dialog: !!dialog }`
        )
        await cdp.evaluate(`${store}.confirmRestore('restore')
                            return true`)
        const restored = await waitFor(
          cdp,
          'the restored workspace',
          `const state = window.__ada.useApp.getState()
           const ws = state.workspaces.find((candidate) => candidate.rootDir === ${json(
             dirs.projectA
           )})
           const names = ws ? ws.panes.map((pane) => pane.name) : []
           return { ok: !!ws && names.includes('renamed'), names, wsId: ws?.id ?? null }`
        )
        scratch.wsA = restored.wsId
        // The restored panes are new DOM nodes; everything after this addresses
        // them by the ids the restore produced.
        const ids = await waitFor(
          cdp,
          'the restored panes to mount',
          `const state = window.__ada.useApp.getState()
           const ws = state.workspaces.find((candidate) => candidate.id === ${json(
             restored.wsId
           )})
           const renamed = ws?.panes.find((pane) => pane.name === 'renamed')
           const mounted = renamed
             ? !!document.querySelector('[data-pane-id="' + renamed.id + '"] .xterm')
             : false
           return { ok: mounted, paneId: renamed?.id ?? null }`
        )
        scratch.paneOne = ids.paneId
      }
    ],
    [
      'the explorer lists the workspace folder',
      async (scratch) => {
        await cdp.evaluate(
          `${store}.setExplorer(${json(scratch.wsA)}, { open: true })
           return true`
        )
        await waitFor(
          cdp,
          'the explorer to list the seeded file',
          `const panel = document.querySelector('.ada-explorer')
           const text = panel?.innerText ?? ''
           return { ok: text.includes('smoke-file.txt'), text: text.slice(0, 400) }`
        )
      }
    ],
    [
      'settings and back leave the terminal untouched',
      async (scratch) => {
        await cdp.evaluate(
          `const el = document.querySelector('[data-pane-id="' + ${json(scratch.paneOne)} + '"]')
           if (el) el.__mark = 2
           ${store}.setView('settings')
           return true`
        )
        await waitFor(
          cdp,
          'the settings view',
          `const state = window.__ada.useApp.getState()
           return { ok: state.view === 'settings' && document.body.innerText.includes('Accounts'),
                    view: state.view }`
        )
        await cdp.evaluate(`${store}.setView('grid')
                            return true`)
        const back = await waitFor(
          cdp,
          'the grid to come back',
          `const el = document.querySelector('[data-pane-id="' + ${json(scratch.paneOne)} + '"]')
           return { ok: !!el && el.__mark === 2, present: !!el, mark: el?.__mark ?? null }`
        )
        if (!back.ok) throw new StepError('the terminal was remounted by the detour', back)
      }
    ],
    [
      'remote registers with a relay and publishes the pane list',
      async (scratch) => {
        // A stand-in relay in this process: the real one lives in its own repo
        // and has its own tests. This one speaks just enough of the handshake
        // to register a host and collect what it publishes.
        const relay = await startFakeRelay()
        try {
          await cdp.evaluate(
            `${store}.updateSettings({ relay: { enabled: true, url: ${json(relay.url)}, name: 'smoke' } })
             return true`
          )
          await waitFor(
            cdp,
            'the relay link to report itself connected',
            `const status = await window.api.relayStatus()
             return { ok: status.state === 'connected' && !!status.hostId, ...status }`
          )
          const key = await cdp.evaluate(`return window.api.relayKey()`)
          if (!/^[0-9a-f]{64}$/.test(key ?? '')) {
            throw new StepError('the pairing key is not 64 hex chars', { key })
          }
          if (relay.auth.key !== key) {
            throw new StepError('the app registered with a different key than it shows', {
              shown: key,
              sent: relay.auth.key
            })
          }

          // The publisher debounces, so the first feed after enabling may be empty.
          const deadline = Date.now() + WAIT_MS
          let feed = null
          while (Date.now() < deadline) {
            feed = relay.feeds.at(-1) ?? null
            if (feed?.workspaces.some((ws) => ws.panes.some((pane) => pane.id === scratch.paneOne))) break
            await sleep(250)
          }
          const pane = feed?.workspaces.flatMap((ws) => ws.panes).find((p) => p.id === scratch.paneOne)
          if (!pane || !pane.status || feed.host?.name !== 'smoke') {
            throw new StepError('the relay never received the terminal pane', feed)
          }

          await cdp.evaluate(
            `${store}.updateSettings({ relay: { enabled: false, url: ${json(relay.url)}, name: 'smoke' } })
             return true`
          )
          await waitFor(
            cdp,
            'the relay link to close',
            `const status = await window.api.relayStatus()
             return { ok: status.state === 'off', ...status }`
          )
        } finally {
          await relay.close()
        }
      }
    ]
  ]
}

/**
 * The relay's host-side handshake, minus everything the phone side needs:
 * accept a host with a well-formed key, say `registered`, keep its feeds.
 */
async function startFakeRelay() {
  const { createServer } = await import('node:http')
  const { Server } = require('socket.io')
  const server = createServer()
  const io = new Server(server)
  const state = { auth: null, feeds: [] }
  io.on('connection', (socket) => {
    const auth = socket.handshake.auth
    if (auth.role !== 'host' || !/^[0-9a-f]{64}$/.test(auth.key ?? '')) {
      socket.emit('authError', { code: 'bad-key', message: 'bad key', protocolVersion: 1 })
      setImmediate(() => socket.disconnect(true))
      return
    }
    state.auth = auth
    socket.on('feed', (feed) => state.feeds.push(feed))
    socket.emit('registered', { hostId: 'smoke', viewers: 0 })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get auth() {
      return state.auth
    },
    feeds: state.feeds,
    close: () => new Promise((resolve) => io.close(() => resolve()))
  }
}

/* === the run ================================================================ */

async function main() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'ada-smoke-data-'))
  const projectA = await mkdtemp(path.join(tmpdir(), 'ada-smoke-a-'))
  const projectB = await mkdtemp(path.join(tmpdir(), 'ada-smoke-b-'))
  await writeFile(path.join(projectA, 'smoke-file.txt'), 'ada smoke\n')

  const { child, output } = launchApp(userDataDir)
  let cdp = null
  let currentStep = 'launch'
  let failed = false

  try {
    const target = await waitForPageTarget(child)
    cdp = await connect(target)

    const scratch = {}
    const steps = buildSteps(cdp, { projectA, projectB })
    for (const [index, [label, run]] of steps.entries()) {
      currentStep = `${index + 1}. ${label}`
      await run(scratch)
      console.log(`✓ ${currentStep}`)
    }

    currentStep = 'the renderer logged nothing'
    if (cdp.consoleErrors.length > 0) {
      throw new StepError('the renderer logged errors during the run', null)
    }
    console.log('\nall smoke steps passed')
  } catch (error) {
    failed = true
    console.error(`\n✗ step ${currentStep}: ${error.message}`)
    if (error instanceof StepError && error.state !== null && error.state !== undefined) {
      console.error('  page state:', JSON.stringify(error.state, null, 2))
    }
    if (cdp?.consoleErrors.length) {
      console.error('  renderer errors:')
      for (const line of cdp.consoleErrors) console.error(`    ${line}`)
    }
    const tail = output.join('').trim()
    if (tail) console.error(`  app output:\n${tail.split('\n').slice(-20).join('\n')}`)
    if (cdp) {
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
        const file = path.join(scriptsDir, '.smoke-failure.png')
        await writeFile(file, Buffer.from(shot.data, 'base64'))
        console.error(`  screenshot: ${file}`)
      } catch (shotError) {
        console.error(`  screenshot failed: ${shotError.message}`)
      }
    }
  } finally {
    cdp?.close()
    // BY PID, never by pattern: a sibling checkout may be running the same
    // command shape and would be reaped with it.
    await killApp(child)
    await Promise.all(
      [userDataDir, projectA, projectB].map((dir) =>
        rm(dir, { recursive: true, force: true }).catch(() => {})
      )
    )
  }

  process.exit(failed ? 1 : 0)
}

async function killApp(child) {
  if (child.exitedWith !== undefined) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    process.kill(child.pid, 'SIGTERM')
  } catch {
    return
  }
  const timer = setTimeout(() => {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 5000)
  await exited
  clearTimeout(timer)
}

await main()
