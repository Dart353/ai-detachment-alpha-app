# Working on AI Detachment Alpha

A minimal Electron terminal multiplexer for Claude Code. Read `README.md` first
for what it does and how to run it; this file is the map and the house rules.

## Vocabulary

| Word | Means |
| --- | --- |
| **workspace** | a folder you opened; owns a zone layout, panes and an explorer state |
| **pane** | one tile: a live PTY (`claude`, `terminal`, `ssh`) or a file `viewer` |
| **grid** | the canvas a workspace's panes are positioned on |
| **zone** | a rectangle in the layout; a pane is *assigned* to a zone |
| **status** | `working · attention · idle · done · exited` (`done` = the turn ended and the pane has not been focused since) |
| **archive** | the snapshot a closed workspace leaves behind, offered back on reopen |

There are no butlers, estates or floors here — that is the Claudler ancestor
(`/home/suessalex/redsky/claudler/claudler`, read-only reference), whose modules
this app ports with their reasoning comments and neutral vocabulary.

## Architecture

### `src/shared` — the contracts

- `types.ts` — the whole data model. Everything here crosses IPC, so it is plain
  JSON: no classes, no `Date`, no functions.
- `ipc.ts` — every channel name (`CH`) plus the full `Api` interface the preload
  exposes. **Change this first**, then main and renderer follow it.

### `src/main` — one module per concern

| Module | Owns |
| --- | --- |
| `index.ts` | app lifecycle, the userData profile switch, the window, navigation/popup guards |
| `store.ts` | the JSON files under userData (state, settings, archive, recents, layouts) |
| `ptyManager.ts` | node-pty processes, flow control, the prompt-ready gate, clean child env |
| `sessionWatcher.ts` | claims a Claude transcript per pane and reports what it says |
| `platform.ts` | WSL mode: the single source of truth for path translation and `.claude` |
| `cliPath.ts` | where the `claude` binary is (probe once, cache, Settings override) |
| `hooks.ts` | installing and tailing Claude Code's Stop/Notification hooks |
| `usage.ts` / `planUsage.ts` | per-session token attribution and the plan/limit windows |
| `accounts.ts` / `accountMint.ts` | multiple Claude accounts and their config dirs |
| `fileTree.ts`, `git.ts`, `ssh.ts` | explorer listings, branch + dirty flag, `~/.ssh/config` |
| `protocol.ts` | the `ada-file://` scheme the sandboxed renderer reads files through |
| `log.ts` | `logs/ada.log`, the ring buffer, and crash reports |

`src/main/ipc/*.ts` is **one file per area** (`pty`, `sessions`, `store`, `fs`,
`git`, `ssh`, `hooks`, `usage`, `accounts`, `window`, `misc`), all registered
once by `ipc/index.ts` before the window exists. Handlers reach the window only
through the `IpcCtx` they are given, never through a captured reference.

### `src/renderer/src`

- `store/app.ts` — the persisted world: workspaces, panes, layouts, settings,
  archive, toasts. Side effects (IPC saves, PTY kills) are fired from the actions
  so closing a workspace is one atomic step wherever the click came from.
- `store/runtime.ts` — the throwaway world: status, sessions, activity, usage,
  accounts. Also the **non-reactive registries** (`registerFocusFn`,
  `registerPromptProbe`, `registerSelectionFn`) — imperative handles a pane
  publishes, kept out of state so a terminal mounting does not re-render the app.
- `store/persist.ts` — `hydrate()` in, debounced save out, with sanitizing that
  turns a hand-edited state file into a working app rather than a crash.
- `lib/*` — the pure, unit-tested logic: `zones` (the layout model), `status`,
  `notify`, `completionGate`, `archive`, `recents`, `usageMath`, `launch`,
  `termLinks`, `savedLayouts`, `shellQuote`, `explorerTreeCache`.
- `hooks/*` — `useTerminalPane` (xterm + fit + PTY wiring), `useStatusEngine`
  (the one place that decides what a pane is doing and whether to notify),
  `useGlobalShortcuts`, `useUsage`, `useGitStatus`.
- `components/*` — one `.css` beside each component, tokens from
  `styles/tokens.css`. `Grid.tsx` owns the canvas gestures, `TerminalPane.tsx`
  one live pane, `paneMenu.tsx` the two context menus as pure builders.

## Hard rules

1. **Never reparent or re-key a pane's DOM.** Panes are absolutely positioned,
   id-keyed siblings; a layout change only rewrites a slot's inline geometry.
   Moving the node throws away xterm's measurements and blanks the terminal;
   re-keying it kills the process behind it. The ONE key that may change is
   `runtime.remountKey[paneId]` — that is how "Start fresh" and an account
   switch deliberately respawn.
2. **All workspaces stay mounted.** Switching workspaces hides a grid
   (`display:none`); it never unmounts one, or the scrollback and the PTYs go
   with it. A maximized pane's siblings are `visibility:hidden`, still mounted.
3. **FitAddon → `resizePty`.** Whatever resizes a terminal must fit it and then
   send the new cols/rows to the PTY, or the TUI on the far side paints into the
   wrong box.
4. **The prompt-ready gate.** Nothing may be written into a freshly spawned PTY
   until its shell has printed a prompt; `ptyManager` owns that gate. Bypassing
   it loses the first keystrokes.
5. **Secrets go through `safeStorage` only**, and never to the renderer. Account
   tokens are encrypted in main and stay there; nothing is written into an
   account's config directory in the clear.
6. **No red in the palette.** It tops out at the warn tone `#e0784a`; the accent
   is `#f05219`. Use a token from `styles/tokens.css`, never a literal colour
   that has one.
7. **Icons** come from `lucide-react` at 12–14px in the muted grey, except the
   `✻` glyph for Claude Code and the inline logo SVG.
8. **Never bake `--no-sandbox` into the app.** It belongs to the smoke harness.

## Verifying a change

```sh
pnpm typecheck && pnpm test          # types + pure logic
pnpm test:e2e                        # build, then drive the real app over CDP
pnpm package:dir                     # the packaged Linux build still assembles
```

`scripts/e2e-smoke.mjs` launches the built app with `ADA_USER_DATA` pointed at a
temp dir and drives it over the DevTools Protocol. It talks to the app through
the zustand stores — `main.tsx` puts them on `window.__ada` when main loads the
renderer with `?e2e=1`, which it only does for a throwaway profile — rather than
synthesizing clicks. Add a step there for any behaviour that only exists once a
real PTY, a real file and a real reload are in play; keep everything else in
vitest. When a step fails it prints the page state and writes
`scripts/.smoke-failure.png`.

If a smoke step exposes a bug, fix the app, not the assertion.
