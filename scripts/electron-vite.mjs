// Cross-platform launcher for electron-vite.
//
// VS Code's integrated terminal exports ELECTRON_RUN_AS_NODE, which makes
// Electron boot as plain Node and exit silently. The scripts used to strip it
// with `env -u`, but that is a POSIX-only tool and breaks `pnpm dev` / `pnpm
// build` in PowerShell and cmd. This wrapper does the same thing in Node.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

// The bin is not in electron-vite's `exports` map, so resolve the package
// root via package.json and join the path by hand.
const require = createRequire(import.meta.url)
const bin = path.join(
  path.dirname(require.resolve('electron-vite/package.json')),
  'bin/electron-vite.js'
)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// A `claude` spawned from inside a Claude Code session would otherwise inherit
// the parent's identity; the app strips these per PTY too, this is belt-and-braces
// for the dev server's own Electron process.
delete env.CLAUDECODE
delete env.CLAUDE_CODE_SESSION_ID
delete env.CLAUDE_CODE_CHILD_SESSION
delete env.CLAUDE_CODE_ENTRYPOINT

const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
