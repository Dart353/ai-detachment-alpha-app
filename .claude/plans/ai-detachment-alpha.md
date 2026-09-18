# AI Detachment Alpha — minimal terminal multiplexer (Claudler successor)

## Context
The Claudler (`/home/suessalex/redsky/claudler/claudler`) grew into a 90k-line butler-themed app. The user
wants a **minimal** successor in a new, empty repo `/home/suessalex/redsky/ai-detachment-alpha` (only `.git`
exists), with no butler/estate analogy, following the high-fidelity design handoff at
`/mnt/c/Users/Suess/Downloads/Claude Code Terminal Multiplexer/design_handoff_ai_detachment_alpha/`
(`README.md` + `Terminal Multiplexer Mockups.dc.html`).

Approach: **port, don't reinvent.** Claudler's hard-won modules (PTY prompt-ready gate, transcript
claiming, zone model, xterm refit/scroll preservation, link provider, hooks, usage endpoint, accounts)
are copied with their explanatory comments, stripped of dropped features, renamed to neutral vocabulary,
and re-skinned to the new design. The 8.5k-line `App.tsx` is NOT ported; it is replaced by a zustand
store + small components.

## Objective (confirmed with user)
**Keep:** tiled xterm panes · workspaces bound to a folder, persisted, drag-reorder, rename, scrollback
kept on switch · close→archive, reopen→preview + opt-in restore · FancyZones layout + zone editor +
dividers + drag swap/split + maximize · pane kinds: `claude`, `terminal`, `ssh`, file `viewer` (+ explorer
panel) · user-named panes **nested under their workspace in the sidebar; clicking one focuses that pane**
(this is what the design's "sub-agents" means — NOT Claude Task sub-agents) · pane status · full restore
on app relaunch · `claude --resume`, Start fresh, stale-resume toast · pane context menu · clickable
links · file drop → path · scroll position kept across resize.
**New from design:** custom frameless titlebar w/ workspace tabs, collapsible sidebar (244px ↔ 46px rail),
layout picker (1b), quick-spawn menu (1c), zone editor skin (1d), first-run (1e), settings (1f),
usage & limit meters (4a), OS notifications + Claude Code hooks (adds a "needs input" status),
multi-account Claude (1f). **Platforms:** Windows (with WSL mode), macOS, Linux — all packaged.

## Scope
**In scope:** everything under `/home/suessalex/redsky/ai-detachment-alpha/`.
**Out of scope:** any edit to the Claudler repo (read-only reference). Dropped Claudler features: Duty
Board, Steward/Scrivener/Salver, Quick Chat, Quick Shell windows, Codex/Gemini pane kinds (Accounts page
shows their cards as inert "coming later"), Cellarer/DB, media/gallery/print room, MCP server, ledger
cost tables, water tally, themes/typography system, tray, licensing, auto-updater, git worktrees, browser
panes, PDF viewer, streamer mode, guided tour, grid→zone migration (`layout.ts`).

## Key decisions
- Stack: Electron 37, electron-vite 3, React 18, TypeScript strict, pnpm, node-pty 1, `@xterm/xterm` 5.5 +
  `@xterm/addon-fit`, **zustand** (state), `lucide-react` (icons), `@headless-tree/react` +`/core` (explorer),
  `react-markdown`+`remark-gfm`+`rehype-highlight` (viewer), `@fontsource/jetbrains-mono`, **vitest** (pure logic).
- Identity: productName `AI Detachment Alpha`, appId `io.redsky.ai-detachment-alpha`, package name
  `ai-detachment-alpha`. userData files: `ada-state.json`, `ada-settings.json`, `ada-archive.json`,
  `ada-recents.json`, `ada-accounts.json`, `ada-layouts.json`. Hook signal file `<claudeDir>/ada-hooks.jsonl`.
  File protocol `ada-file://`. Account config dirs `<userData>/claude-accounts/<id>`.
- Window: `frame:false` on win/linux with custom ─ ▢ ✕; macOS `titleBarStyle:'hidden'` + traffic lights
  (custom controls hidden, 78px left inset). `backgroundThrottling:false`.
- Vocabulary: estate→workspace, butler→pane, floor→grid. Status: `working | attention | idle | done | exited`
  (`done` = turn ended and pane not focused since; focusing clears it to `idle`).
- Workspace switching is available both as titlebar tabs (design) and as the sidebar tree (user request);
  both read the same store, both support drag-reorder and double-click rename.
- IPC contract first: `src/shared/ipc.ts` declares every channel + the full `Api` interface; the preload
  is generated from it once. Main handlers live one-file-per-area in `src/main/ipc/*.ts`, created as
  stubs in Task 2 and *replaced* by later tasks → parallel tasks never share a file.
- Renderer: Task 13 creates `App.tsx` plus stub components at their final paths; feature tasks replace
  their own stub files only. Store API is fully specified in Task 12; a feature needing more state adds
  its own file under `src/renderer/src/store/`, never edits `store/app.ts`.

## Risks
- **node-pty native build** per platform (electron-rebuild postinstall; `asarUnpack` node-pty). Packaging
  for mac/win can only be *built* on those OSes — Task 23 verifies Linux packaging here, config-only for others.
- **Undocumented usage endpoint** (`api.anthropic.com/api/oauth/usage`, needs `User-Agent: claude-code/<ver>`):
  must fail soft → "Usage unavailable".
- **Hooks installer writes `~/.claude/settings.json`**: idempotent merge + atomic write, only on explicit user click.
- **Account secrets**: Electron `safeStorage` only; never written to account dirs → Task 8 gets an `opus-reviewer` pass.
- **Pane DOM must never be reparented** (xterm over node-pty): panes render as id-keyed absolutely
  positioned siblings; all workspaces stay mounted (`display:none`), maximized siblings `visibility:hidden`.
- WSL path translation touches every fs/pty/transcript path; all go through `platform.ts`.
- Dev runs from WSL/Linux: launch scripts must `env -u ELECTRON_RUN_AS_NODE`.

## Execution order
Every subagent brief = the **Preamble** below + the task section, verbatim. Max 3 concurrent implementers.
1. T1 → T2 (strictly sequential: scaffold, then contract).
2. Wave A (parallel): T3, T9, T11.
3. Wave B: T4, T5, T6 (need T3) — then T7, T8, T10 (T7/T8 need T3; T10 needs T2).
4. T12 (needs T9, T10) → T13 (needs T11, T12).
5. Wave C (need T13; disjoint files): T14, T16, T17 → T15 (needs T14), T18 (needs T14), T19 → T20, T21, T22.
6. T23 last (packaging, e2e smoke, docs).
No commits are made by agents (user reviews the tree). After approval the orchestrator copies this plan to
`/home/suessalex/redsky/ai-detachment-alpha/.claude/plans/ai-detachment-alpha.md` and tracks status there.

## Rollback
Greenfield repo; every task owns a disjoint file set listed in its brief, so a bad task is backed out by
deleting/restoring exactly those files (stubs from T2/T13 are the restore point) and re-running the task.
Claudler is never modified. Nothing outside the repo is written except by the running app into its own userData.

## Preamble (prepended verbatim to every brief)
> You are implementing one task of **AI Detachment Alpha**, a minimal Electron terminal multiplexer for
> Claude Code, in `/home/suessalex/redsky/ai-detachment-alpha` (work ONLY there). Reference source to port
> from (READ-ONLY, never edit): `/home/suessalex/redsky/claudler/claudler` ("Claudler"). Design spec:
> `docs/design/README.md` and `docs/design/mockups.html` in the new repo (high-fidelity: colors, sizes,
> copy are final). Shared contracts: `src/shared/types.ts`, `src/shared/ipc.ts` — do not change them; if
> one is wrong, stop and report. Rules: TypeScript strict, no `any` unless unavoidable; keep Claudler's
> explanatory "why" comments when porting but rewrite vocabulary (estate→workspace, butler→pane,
> floor→grid, claudler→ada) and delete all butler theming and role tags like `[Porter]`; do not port
> features not named in your brief; one `.css` file beside each component using the CSS variables in
> `src/renderer/src/styles/tokens.css` (never hard-code a color that has a token); icons from
> `lucide-react` at 12–14px muted gray, except the ✻ glyph for Claude Code and the inline logo SVG; touch
> only the files listed under "Files in scope"; do not run `git commit`; package manager is pnpm. Finish
> by running the Verification command and reporting its output plus the list of files you touched.

## Tasks

### Task 1 — Scaffold a building, launching Electron + React + TS app with design tokens
- **Files in scope (create):** `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.npmrc`, `tsconfig.json`,
  `electron.vite.config.ts`, `vitest.config.ts`, `README.md`, `docs/design/README.md` + `docs/design/mockups.html`
  (copies of the two handoff files at `/mnt/c/Users/Suess/Downloads/Claude Code Terminal Multiplexer/design_handoff_ai_detachment_alpha/`),
  `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`,
  `src/renderer/src/App.tsx`, `src/renderer/src/env.d.ts`, `src/renderer/src/styles/tokens.css`,
  `src/renderer/src/styles/base.css`, `src/renderer/src/components/Logo.tsx`.
- **Out of scope:** any feature code; ESLint/Prettier; CI.
- **Context:** Mirror Claudler's `package.json`/`electron.vite.config.ts`/`tsconfig.json`/`pnpm-workspace.yaml`
  (single tsconfig, `moduleResolution: bundler`, `externalizeDepsPlugin()` for main+preload, `react()` for renderer,
  `__APP_VERSION__` define). Scripts: `dev` = `env -u ELECTRON_RUN_AS_NODE electron-vite dev` (load-bearing: VS Code
  injects that var and Electron boots as Node), `build`, `start`, `typecheck` = `tsc --noEmit`, `test` = `vitest run`,
  `postinstall` = `electron-rebuild -f -w node-pty`. `pnpm-workspace.yaml` is only
  `allowBuilds: [electron, esbuild, node-pty]`. Deps/versions per "Key decisions" (match Claudler's versions where shared).
  Window: 1480×920, min 960×640, bg `#1c1c1f`, `frame:false` (non-mac) / `titleBarStyle:'hidden'`,
  `trafficLightPosition:{x:13,y:12}` (mac), `backgroundThrottling:false`, `Menu.setApplicationMenu(null)` on
  non-darwin, single-instance lock (second-instance focuses), `setWindowOpenHandler` denies all and sends
  http(s) to `shell.openExternal`, `will-navigate` same-origin only. `tokens.css`: every color/size in the
  design README "Design Tokens" section as `--ada-*` variables (accent `#f05219`, accent-text `#f8cdbb`, warn
  `#e0784a`, done `#7ec27a`, bg-window `#1c1c1f`, bg-sidebar `#161619`, bg-pane-header `#141417`, bg-term
  `#0b0b0d`, bg-popover `#202025`, the 8 text grays, hairlines, radii 8/10/7/5, titlebar 40, pane header 32,
  sidebar 244/46, popover shadow `0 18px 50px rgba(0,0,0,.55)`), use the turn-2 accent opacities (.12/.32 tab,
  .11/.3 row, .5 focused pane). `base.css`: reset, `font-family: "Segoe UI", system-ui, sans-serif`, import
  `@fontsource/jetbrains-mono/400.css` + `500.css`, themed scrollbars. `Logo.tsx`: props `{width,height,strokeWidth=3}`,
  exact SVG: `viewBox="0 0 30 18"`, three paths `M2 2 L9 9 L2 16`, `M11 2 L18 9 L11 16` (opacity .65),
  `M20 2 L27 9 L20 16` (opacity .35), stroke `#f05219`, round caps/joins, fill none. Placeholder `App.tsx`
  renders the first-run logo + "AI DETACHMENT ALPHA".
- **Acceptance:** `pnpm install` succeeds incl. node-pty rebuild; `pnpm typecheck`, `pnpm build`, `pnpm test`
  (zero tests OK via `passWithNoTests`) pass; `.gitignore` covers `node_modules out release dist`.
- **Verification:** `cd /home/suessalex/redsky/ai-detachment-alpha && pnpm install && pnpm typecheck && pnpm build && pnpm test`
- **Depends on:** none · **Status:** pending

### Task 2 — Define shared types + the full IPC contract, generate the preload, stub every main handler
- **Files in scope:** create `src/shared/types.ts`, `src/shared/ipc.ts`, `src/main/ipc/index.ts`,
  `src/main/ipc/{window,store,pty,sessions,hooks,fs,ssh,git,usage,accounts,misc}.ts`, `src/main/accounts.ts` (stub),
  `src/main/protocol.ts` (stub), `src/renderer/src/api.d.ts`; modify `src/preload/index.ts`, `src/main/index.ts`.
- **Out of scope:** real handler logic (except `window.ts` and `misc.ts`), renderer UI.
- **Context — `types.ts` (authoritative):**
  ```ts
  export type PaneKind = 'claude' | 'terminal' | 'ssh' | 'viewer'
  export type PaneStatus = 'working' | 'attention' | 'idle' | 'done' | 'exited'
  export interface Pane { id: string; name: string; kind: PaneKind; cwd: string; createdAt: number
    sshHost?: string; filePath?: string; sessionId?: string; accountId?: string
    planMode?: boolean; color?: string }
  export interface Zone { id: string; x: number; y: number; w: number; h: number }   // % of canvas 0–100
  export interface ZoneSnap { cols: number; rows: number }
  export interface ZoneLayout { v: 2; snap: ZoneSnap; zones: Zone[]; assign: Record<string, string> } // paneId→zoneId
  export interface ExplorerState { open: boolean; width: number; expanded: string[] }
  export interface Workspace { id: string; name: string; rootDir: string; layout: ZoneLayout; panes: Pane[]
    explorer: ExplorerState; focusedPaneId?: string; maximizedPaneId?: string; collapsed?: boolean }
  export interface PersistedState { v: 1; workspaces: Workspace[]; activeWorkspaceId: string | null
    sidebarCollapsed: boolean }
  export interface ArchiveEntry { key: string; rootDir: string; name: string; archivedAt: number
    layout: ZoneLayout; panes: Pane[]; explorer: ExplorerState }
  export interface RecentWorkspace { rootDir: string; name: string; lastOpenedAt: number }
  export interface SavedLayout { id: string; name: string; zones: Zone[] }
  export interface Settings { termFontSize: number; termFontFamily: string; defaultPaneKind: 'claude'|'terminal'
    shellPath?: string; wsl: { enabled: boolean; distro?: string }; cliPaths: { claude?: string }
    fullscreenTui: boolean; restoreArchivesAutomatically: boolean; warnAtPct: number; warnEnabled: boolean
    notifications: { muted: boolean; attention: {banner:boolean;sound:boolean}; done: {banner:boolean;sound:boolean} } }
  ```
  plus `SessionInfo`, `PaneReg`, `HookEvent`, `FileTreeEntry`, `FileReadResult`, `FileOpResult`, `SpawnOpts`
  (`{id,cwd?,command?,kind,accountId?,mint?:{configDir},cols?,rows?}`), `ClaudeAccount`, `GitStatus {branch:string|null; dirty:boolean}`,
  and `UsageSnapshot { available: boolean; plan: string|null; updatedAt: number;
  windows: {key:string;label:string;pct:number;resetsAt:number|null;projectedCapAt?:number|null}[];
  bySessionId: Record<string, number> /* tokens in current session window */; windowTokens: number }` —
  copy field shapes for the first group from Claudler `src/main/sessionWatcher.ts` L22-60, `hooks.ts` L60, `fileTree.ts`
  L20/103/209, `src/shared/claudeAccounts.ts`.
  **`ipc.ts`:** `export const CH = {...} as const` channel names and `export interface Api` with (all `on*` return an
  unsubscribe fn): `platform`; window `winMinimize/winToggleMaximize/winClose/onWinMaximized`; store
  `loadState/saveState/loadArchive/saveArchive/loadRecents/saveRecents/loadLayouts/saveLayouts/getSettings/saveSettings(partial)/onSettingsChanged`;
  pty `spawnPty(opts):Promise<boolean>/writePty/resizePty/killPty/pausePty/resumePty/ptyCwd/onPtyData/onPtyExit`;
  sessions `registerSession/unregisterSession/transcriptExists(cwd,sessionId,accountId?)/onSessionUpdate`;
  hooks `hooksInstalled/installHooks/onHookEvent`; fs `pickDir/readDir/readFile/watchDir/unwatchDir/renamePath/createFile/createDir/movePath/trashPath/onFsChanged/getDroppedFilePath(file)`;
  `sshHosts`; `gitStatus(cwd)`; usage `getUsage(force?)/onUsage`; accounts
  `listAccounts/addAccount/removeAccount/beginMint/completeMint/cancelMint/onAccountsChanged/onMintDone`;
  misc `copyText/revealPath/openExternal/wslDistros/cliProbe/showNotification({title,body,paneId?})/onNotificationClick`.
  Preload implements `Api` with `ipcRenderer.invoke/send/on` (+ `webUtils.getPathForFile`) and
  `contextBridge.exposeInMainWorld('api', api)`; `api.d.ts` declares `window.api: Api`. Each `src/main/ipc/<area>.ts`
  exports `register<Area>Ipc(ctx: IpcCtx)` where `IpcCtx = { win: () => BrowserWindow | null; send(channel, ...args) }`;
  stubs register handlers that return safe empties (`[]`, `null`, `false`, `{available:false,...}`) so the UI runs.
  `window.ts` and `misc.ts` are fully implemented (notification via Electron `Notification`, click → focus window +
  send `CH.notificationClick` with paneId). `src/main/accounts.ts` stub exports
  `resolveAccountEnv(accountId?: string): {configDir?:string;apiKey?:string;oauthToken?:string}|undefined` (returns undefined),
  `applyAccountEnv(env, account)`, `mintForSpawn(ptyId, configDir): boolean` (false). `protocol.ts` stub exports
  `registerSchemes()` (call before app ready) and `installProtocolHandlers()`. `index.ts` calls them + `registerAllIpc(ctx)`.
- **Acceptance:** typecheck/build pass; app launches and `window.api` has every `Api` key (add a vitest that
  asserts the preload's key list equals a `API_KEYS` const exported from `ipc.ts`).
- **Verification:** `pnpm typecheck && pnpm build && pnpm test`
- **Depends on:** 1 · **Status:** pending

### Task 3 — Port platform (WSL) helpers, logging, and atomic JSON persistence
- **Files:** create `src/main/platform.ts`, `src/main/log.ts`, `src/main/store.ts`; replace `src/main/ipc/store.ts`.
- **Out of scope:** accounts store/secrets (Task 8), other ipc files.
- **Context:** Port Claudler `src/main/wsl.ts` → `platform.ts` keeping every export name (`configureWsl,isWsl,wslDistro,
  linuxToWin,winToLinux,toHost,toStored,claudeDir(configDir?),projectsRoot(configDir?),homeDir,listDistros` — note
  `wsl -l -q` output is UTF-16LE). Port `log.ts` (file `ada.log`, 5MB rotate, crash reports). Port `store.ts`
  `readJson`/`writeJsonAtomic` — temp name MUST be `${f}.${process.pid}.tmp` (two instances would race a shared tmp) —
  and expose load/save for the six `ada-*.json` files in "Key decisions" (not accounts). `saveSettings(partial)` merges
  over existing; `loadSettings()` fills defaults: `termFontSize 12, termFontFamily 'JetBrains Mono', defaultPaneKind
  'claude', fullscreenTui true, restoreArchivesAutomatically false, warnAtPct 80, warnEnabled true`, notifications
  all true/unmuted. `ipc/store.ts`: handlers for all store channels; `saveSettings` re-runs `configureWsl` and
  broadcasts `onSettingsChanged`. Call `configureWsl(loadSettings().wsl)` from the register function.
- **Acceptance:** vitest for `joinWinShare/stripWinShare/linuxToWin/winToLinux` and a temp-dir atomic write round trip
  (make the store dir injectable for tests).
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 2 · **Status:** pending

### Task 4 — Port the PTY manager with the prompt-ready gate, flow control and window-owned IPC
- **Files:** create `src/main/ptyManager.ts`, `src/main/cliPath.ts`; replace `src/main/ipc/pty.ts`; create `src/main/ptyManager.test.ts`.
- **Out of scope:** MCP/cellarer/dbtool/providers plumbing (delete it), Codex, retained-PTY handoff (`retain`, `replay`).
- **Context:** Source: Claudler `src/main/ptyManager.ts` (623 lines; ~40% is MCP plumbing to remove) and `cliPath.ts`.
  Keep verbatim, with comments: `PROMPT_READY_SIGNAL='\x1b[?2004h'` + `scanPromptSignal` + 5000ms timeout +
  win32-non-WSL starts ready + `writeCommandWhenReady` proc-identity guard (L139-178, 349-432); env block L285-334
  (`TERM`, `DISABLE_AUTO_UPDATE='true'`, delete `CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION,
  CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_NO_FLICKER='1'` only for kind `claude` when `settings.fullscreenTui`);
  shell selection L271-283 (WSL → `wsl.exe [-d distro] --cd <linuxCwd>`; else `settings.shellPath || $SHELL ||
  powershell.exe|/bin/zsh`, args `['-l']` non-win); `pause/resume`; `cwd(id)`; every callback checks
  `this.procs.get(id) === proc`. Constructor callbacks reduce to `{ fullscreenTui: () => boolean; accountEnv:
  (accountId?) => AccountEnv|undefined }`, applying `applyAccountEnv` from `src/main/accounts.ts` (stub today).
  `cliPath.ts`: port `resolveCli('claude')`, `probeCli`, `cleanChildEnv` (login-interactive `-lic` probe, cache successes only).
  `ipc/pty.ts`: port Claudler `index.ts` L268-269, 1650-1753 minus reattach: `ptyOwners` map, `ownedByOr` guard on
  write/resize/kill/pause/resume, `mint` spawn honored only if `mintForSpawn(id, configDir)`; kill all on window close/quit.
  Launch command is built by the renderer and passed as `opts.command`.
- **Acceptance:** vitest covers `scanPromptSignal` split-across-chunks cases; typecheck passes; manual: a spawned
  shell echoes input (checked in Task 14).
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 3 · **Status:** pending

### Task 5 — Port the transcript session watcher and the Claude Code hooks installer/watcher
- **Files:** create `src/main/sessionWatcher.ts`, `src/main/hooks.ts`, tests `src/main/sessionWatcher.test.ts`,
  `src/main/hooks.test.ts`; replace `src/main/ipc/sessions.ts`, `src/main/ipc/hooks.ts`.
- **Out of scope:** Codex watcher, `searchPrompts`, `listSessionsForCwd`, `SubagentStop` bell kind (keep parsing, no UI).
- **Context:** Port Claudler `sessionWatcher.ts` keeping: `encodeCwd` (`/[^a-zA-Z0-9]/g→'-'`), `transcriptPath`,
  birthtime-oldest-first claiming with `CLAIM_SLACK_MS=8000` and `sessionOwner/paneSession` locking (L609-739),
  `parseTail` (256KB tail, skip `isSidechain|isMeta|isCompactSummary|isVisibleInTranscriptOnly`, slash-command
  noise regexes L156-160, `PENDING_SETTLE_MS=2500`), title from `type:'ai-title'`, model, `permissionMode`, context
  tokens + window (1M for opus/sonnet/`[1m]`, else 200k), 1500ms poll. `accountId` resolves the projects root via
  `src/main/accounts.ts` → add/consume an `accountProjectsRoot(id)` export there only if already present; otherwise use
  `projectsRoot(resolveAccountEnv(id)?.configDir)`. Port `hooks.ts` whole (signal file `ada-hooks.jsonl`;
  `HOOK_EVENTS` vs `BELL_HOOK_EVENTS` separation; idempotent per-event merge into `<claudeDir>/settings.json`, atomic
  tmp+rename; POSIX + PowerShell command forms; watcher = `fs.watch` + 1s poll, start at EOF, leftover partial line,
  truncation handling, self-truncate at 1MB; `turnContextFromTail`, `parentSessionOf`, drop plain `Stop` from `subagents/` paths).
  IPC: `registerSession/unregisterSession/transcriptExists`, push `onSessionUpdate`; `hooksInstalled/installHooks`, push `onHookEvent`.
- **Acceptance:** vitest with fixture JSONL strings: pending-tool vs ended vs interrupted; ai-title extraction;
  `parseHookLine` for Stop/Notification; installer idempotence against a temp settings.json (path injectable).
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 3 · **Status:** pending

### Task 6 — Port file tree + watcher, ssh host discovery, git status, and the `ada-file://` protocol
- **Files:** create `src/main/fileTree.ts`, `src/main/ssh.ts`, `src/main/git.ts`; replace `src/main/protocol.ts`,
  `src/main/ipc/fs.ts`, `src/main/ipc/ssh.ts`, `src/main/ipc/git.ts`; tests `src/main/ssh.test.ts`.
- **Out of scope:** worktrees, PR links, PDF result kind (return `binary`), media protocol.
- **Context:** Port Claudler `fileTree.ts` whole (refcounted non-recursive `fs.watch` per dir; debounce 150ms **plus**
  500ms max-wait cap — pure trailing debounce starves under agent write bursts; TEXT_CAP 1MB, IMAGE_CAP 10MB, NUL
  sniff; images returned as `ada-file://local/<per-segment-encoded path>` URLs). Port `ssh.ts` whole (`Include`
  depth 10 + realpath cycle guard, reject wildcard hosts, read fresh each call). `git.ts`: only the private
  `git(args,cwd)` runner (WSL-aware) + `gitStatus(cwd)` = `branch --show-current` and `status --porcelain` non-empty → dirty;
  null branch outside a repo. `protocol.ts`: `registerSchemesAsPrivileged` for `ada-file` `{stream,supportFetchAPI,bypassCSP}`;
  handler serves only existing regular files via `net.fetch(pathToFileURL(toHost(p)))`. `ipc/fs.ts` also owns
  `pickDir` (`dialog.showOpenDialog` openDirectory) and `trashPath` (`shell.trashItem`).
- **Acceptance:** vitest for ssh config parsing (Include, `Host a b`, wildcards rejected) with a temp HOME; typecheck.
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 3 · **Status:** pending

### Task 7 — Implement the usage service: live limit windows + per-session token attribution + 80% warning
- **Files:** create `src/main/planUsage.ts`, `src/main/usage.ts`, `src/main/usage.test.ts`; replace `src/main/ipc/usage.ts`.
- **Out of scope:** cost/price tables, water tally, Codex, per-account ledgers, history screen.
- **Context:** Port Claudler `planUsage.ts`: GET `https://api.anthropic.com/api/oauth/usage` via Electron `net.fetch`,
  headers `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<version>`
  (version from `<claudeDir>/.last-update-result.json`, fallback `2.1.203` — it rate-limits hard without this UA),
  creds from `<claudeDir>/.credentials.json` `claudeAiOauth.{accessToken,subscriptionType}` with macOS Keychain
  fallback (`security find-generic-password -s 'Claude Code-credentials' -w`, cached 60s); parse `limits[]` first,
  legacy keys as fallback (L194-256); map to `UsageSnapshot.windows` keys `session`, `weekly_all`, `weekly_scoped:<model>`.
  `projectedCapAt`: linear projection from pct and elapsed fraction of the window, only when it lands before `resetsAt`.
  `usage.ts`: slim port of the incremental reader (per-file byte offset cache, dedup key `${message.id}:${requestId}`
  **largest usage wins**, walk depth 4 so `<session>/subagents/agent-*.jsonl` count toward the parent session id =
  dir segment above `subagents`) producing `bySessionId` token totals (input+output+cache creation) within the current
  session window `[resetsAt-5h, resetsAt]` and `windowTokens`. `ipc/usage.ts`: poll every 30s, cache, broadcast
  `onUsage`; `getUsage(force)`; on any failure emit `{available:false}`; when `settings.warnEnabled` and a window
  crosses `warnAtPct`, fire one Electron `Notification` per window key per `resetsAt`.
- **Acceptance:** vitest: response parsing (modern + legacy fixture), dedup largest-wins, subagent file attribution,
  projection math, warn-once latch.
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 3 · **Status:** pending

### Task 8 — Port multi-account Claude (isolated config dirs, encrypted secrets, setup-token mint flow)
- **Files:** replace `src/main/accounts.ts`, `src/main/ipc/accounts.ts`; create `src/main/accountMint.ts`, `src/main/accounts.test.ts`.
- **Out of scope:** per-account ledgers, Codex/Gemini keys, UI.
- **Context:** Port Claudler `src/main/claudeAccounts.ts`, `claudeAccountMint.ts`, the account parts of `store.ts`
  (L143-190: validated `ada-accounts.json` with `secrets[id]`, `safeStorage.encryptString(...).toString('base64')`,
  throw if encryption unavailable). Keep the stub's export names (`resolveAccountEnv`, `applyAccountEnv` — deletes
  `ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR` then sets per account —,
  `mintForSpawn`) and add `accountProjectsRoot`, `listAccounts`, `addAccount`, `removeAccount`,
  `ensureSharedUserPieces` (symlink `skills commands agents plugins settings.json CLAUDE.md` from `~/.claude`;
  'heal' un-forks a replaced `settings.json`; junction/copy fallbacks on Windows), `reconcileShares()` at startup,
  config dirs `mode 0o700`, removed accounts' dirs stay and their names stay taken. Mint: `beginMint` →
  `ptyId 'mint:<hex>'`, staging dir, fixed command `claude setup-token`; `createOauthTokenScanner` must only accept a
  COMPLETE `sk-ant-oat01-` token followed by a delimiter (never a chunk-boundary prefix); `completeMint` renames the
  staging dir into place; `sweepOrphanedMintDirs()` on startup. Secrets never reach the renderer (`hasSecret` only).
- **Acceptance:** vitest: `applyAccountEnv` matrix, token scanner across chunk splits/ANSI/line wraps. Then an
  `opus-reviewer` pass on secret handling.
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 3, 4 · **Status:** pending

### Task 9 — Port the zone layout model with tests
- **Files:** create `src/renderer/src/lib/zones.ts`, `src/renderer/src/lib/zones.test.ts`.
- **Out of scope:** `layout.ts` grid/tree migration (`gridToZones`, `toZoneLayout` v1 branches, `LayoutNode`), React.
- **Context:** Source Claudler `src/renderer/src/zones.ts` (1118 lines, pure). Import `Zone/ZoneSnap/ZoneLayout` from
  `src/shared/types.ts`; define `Rect {x,y,w,h}` and `Dir` locally. Keep all of: reading (`computeZoneRects`,
  `emptyZones`, `orderedZones`, `zoneOfPane`…), `makeGridZones`, `zonesFromRects`, `reconcileZones(layout, paneIds,
  defaultGrid)` (drop only the v1 migration branch), mutation (`swapPaneZones, movePaneToZone, splitZone, splitZoneAt,
  splitForPane, promoteSplit, canMerge, mergeZones, deleteZone, addZone, setZoneRect, resizeZoneEdge`), shared edges
  (`sharedEdges, moveSharedEdge, neighborZoneInDirection`), drag (`zoneDragPreview, dropPaneOnZone`), snapping
  (`zoneGuides, snapAxis, evenOutZones`), presets. Constants `MIN_ZONE=8, DEFAULT_SNAP={12,12}, EPS=.05, MAGNET=1.5`, `r4`.
  Replace `NAMED_ZONE_PRESETS` with the design's ten: Single, 2 columns, 2 rows, 2 × 2, 3 columns, 2 × 3 (group
  `grid`) and Main + side (2:1), Main + 2, Main + 3, Top + 2 below (group `arrangement`), each `{id,label,group,rects}`;
  export `matchPreset(layout)` returning the preset id whose rects equal the layout (within EPS). Keep the header
  comment's contract about never reparenting pane DOM.
- **Acceptance:** tests: reconcile add/remove pane is idempotent; split then merge round-trips; `moveSharedEdge`
  respects MIN_ZONE; `dropPaneOnZone` center=swap / edge=split; every preset has no overlap (`hasOverlap`) and covers 100%;
  `matchPreset` detects each preset.
- **Verification:** `pnpm typecheck && pnpm vitest run src/renderer/src/lib/zones.test.ts`
- **Depends on:** 2 · **Status:** pending

### Task 10 — Port pure renderer logic: links, status blend, completion gate, archive, recents, launch command
- **Files:** create in `src/renderer/src/lib/`: `termLinks.ts`, `status.ts`, `completionGate.ts`, `archive.ts`,
  `recents.ts`, `launch.ts`, `shellQuote.ts`, and a `.test.ts` for each except termLinks (port its logic untouched; test `scanLinks`).
- **Out of scope:** React, IPC calls, notifications UI.
- **Context:** `termLinks.ts` ← Claudler `src/renderer/src/termLinks.ts` whole (soft-wrap URI reassembly; `https?://`
  and `figma://`). `completionGate.ts` ← whole. `status.ts`: extract Claudler `App.tsx` L282-290 thresholds
  (`ATTENDING_WINDOW_MS=4000, AWAITING_QUIET_MS=8000, ENDED_SETTLE_MS=2500, COMPLETE_GRACE_MS=6000`) and the blend at
  L2262-2292 into a pure `resolveStatus({kind, exited, now, lastActivityMs, session?: SessionInfo, promptOnScreen,
  unseenDone}): PaneStatus`: exited→`exited`; PTY bytes <4s and not settled-ended→`working` (keep the comment: PTY
  bytes prove painting, not working); `promptOnScreen || (pending-tool && quiet>8s)`→`attention`; else `unseenDone?'done':'idle'`.
  Non-claude kinds: `working` if bytes <1.5s else `idle`. Also `isRealOutput` + `CURSOR_QUERY_RE=/\x1b\[\??6n/g`
  from Claudler `termPane.ts` L33-35 (Claude polls cursor position 5×/s; must not count as activity) and
  `BLOCKING_PROMPT_MARKERS=/Do you want|Esc to cancel|Enter to confirm/i`. `archive.ts` ← `boardArchive.ts`
  reduced: `archiveKey(rootDir, platform)` (= `boardKey`: normalize, case-fold on darwin/win32), `entryMatchesRoot`,
  `snapshotWorkspace(ws): ArchiveEntry` (keeps pane names, kinds, sessionIds, layout, explorer),
  `rehydrateWorkspace(entry, newId): Workspace`, `summarizeArchive(entry)` → `{archivedAt, paneCount, panes:[{name,kind}]}`.
  `recents.ts` ← whole (`MAX_RECENTS=20`). `launch.ts`: `buildLaunchCommand(pane, {hasTranscript, cliPath?})` →
  `claude` | `claude --resume <sessionId>` (only when `hasTranscript && sessionId`) + ` --permission-mode plan` when
  `planMode`; `ssh <host>` for ssh; `undefined` for terminal. `shellQuote` ← Claudler `termPane.ts` L515.
- **Acceptance:** tests for each module incl. a status truth table and archive round-trip.
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 2 · **Status:** pending

### Task 11 — Build the UI primitive kit in the new visual language
- **Files:** create `src/renderer/src/components/ui/{Button,Popover,ContextMenu,Modal,Toggle,Select,Meter,Toasts}.tsx`
  each with a sibling `.css`, plus `src/renderer/src/components/ui/index.ts`.
- **Out of scope:** feature components, store.
- **Context:** Design surfaces (docs/design/README.md): popover/menu = bg `#202025`, border `rgba(255,255,255,.12)`,
  radius 10, shadow token, ~120ms fade; menu items 7px 10px, radius 6, 12px; highlighted row `rgba(240,82,25,.1)`;
  section caps labels 9.5–10px/600 tracking .12em; buttons: primary (accent bg, text `#1a1a1a`, 12.5px/700, radius
  7–8), outlined (`rgba(255,255,255,.14)`), ghost, disabled `#59595f`. `ContextMenu` ← port Claudler
  `src/renderer/src/components/PaneMenu.tsx` behavior exactly (viewport clamp after measure, capture-phase
  outside-click so it beats xterm, `SEARCH_THRESHOLD=12` filter box, flyouts with 4px overlap, items
  `{label,icon?,hint?,onClick?,divider?,danger?,disabled?,title?,submenu?,sectionLabel?}`; rule: unavailable actions are
  disabled with a `title` reason, never hidden). `Modal`: focus trap, Esc, backdrop click. `Select`: simple custom
  listbox (keyboard nav, filter box past 12 options). `Meter({pct, tone:'accent'|'neutral'|'warn', height})`:
  tone auto-switches to warn at ≥80 (no red anywhere). `Toasts`: `{id,msg,kind:'info'|'error',action?}`, TTL 4200ms
  or 10000ms with an action, driven by props.
- **Acceptance:** typecheck; a `ui.test.tsx` is NOT required (no DOM test env); components export from `index.ts`.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 1 · **Status:** pending

### Task 12 — Implement the zustand app store: workspaces, panes, layout ops, persistence, archive/restore
- **Files:** create `src/renderer/src/store/app.ts`, `src/renderer/src/store/persist.ts`,
  `src/renderer/src/store/runtime.ts`, `src/renderer/src/store/app.test.ts`, `src/renderer/src/lib/ids.ts`.
- **Out of scope:** components; status tick (Task 18).
- **Context:** `app.ts` state: `PersistedState` fields + `view:'grid'|'settings'|'firstRun'`, `zoneEditorOpen`,
  `settings`, `toasts`, `pendingRestore: ArchiveEntry|null`. Actions (exact names): `openWorkspace(rootDir)` — if an
  open workspace has that root, select it; else if the archive has an entry (`entryMatchesRoot`) and
  `!settings.restoreArchivesAutomatically` set `pendingRestore` + create nothing yet; `confirmRestore(restore:boolean)`
  (restore → `rehydrateWorkspace` and remove the archive entry; decline → fresh workspace, archive entry kept);
  `closeWorkspace(id)` (snapshot → archive, kill its PTYs via `window.api.killPty`, remove), `renameWorkspace`,
  `reorderWorkspaces(from,to)`, `selectWorkspace`, `toggleWorkspaceCollapsed`, `addPane(wsId, partial:{kind,name?,
  sshHost?,filePath?,planMode?,accountId?}, zoneId?)` (default names `Agent N` / `Terminal N` / host / file basename;
  layout via `reconcileZones` or `movePaneToZone`), `closePane`, `renamePane`, `setPaneColor`, `focusPane(wsId,paneId)`
  (also selects the workspace, clears that pane's unseen-done), `toggleMaximize`, `duplicatePane`, `startFresh(paneId)`
  (clear `sessionId`, bump `runtime.remountKey[paneId]`), `setPaneSessionId`, `setPaneAccount` (then startFresh),
  `applyLayout(wsId, layout)`, `applyPreset(wsId, presetId)`, `splitPane(paneId, dir)`, `dropPane(paneId, zoneId, side)`,
  `setExplorer(wsId, partial)`, `toggleSidebar`, `pushToast/dismissToast`, `setView`. New workspace default: layout
  Single, zero panes, explorer `{open:false,width:240,expanded:[]}`, name = folder basename. Recents updated on open.
  `runtime.ts` (non-persisted zustand store): `sessions: Record<paneId, SessionInfo>`, `status: Record<paneId, PaneStatus>`,
  `lastActivity`, `exited`, `unseenDone`, `remountKey`, `promptProbes`, `focusFns`, `usage: UsageSnapshot|null`, `accounts`.
  `persist.ts`: `hydrate()` loads state/archive/recents/settings (empty → `view:'firstRun'`); subscribe + 400ms
  debounced `window.api.saveState`; flush on `beforeunload`. On hydrate every persisted pane remounts and resumes
  (that is the relaunch-restore feature) — store must not drop `sessionId`s.
- **Acceptance:** vitest with a mocked `window.api`: open→close→reopen sets `pendingRestore`; confirm restores panes
  with sessionIds + layout; decline keeps archive; reorder; addPane assigns a zone; startFresh clears sessionId.
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 9, 10 · **Status:** pending

### Task 13 — Build the app shell: titlebar with workspace tabs + window controls, first-run, view switch, stubs
- **Files:** replace `src/renderer/src/App.tsx`, `src/renderer/src/main.tsx`; create `components/Titlebar.{tsx,css}`,
  `components/FirstRun.{tsx,css}`, `App.css`, and **stub** components (each a minimal placeholder with its final props):
  `components/Sidebar.tsx`, `components/Grid.tsx`, `components/ExplorerPanel.tsx`, `components/ZoneEditor.tsx`,
  `components/LayoutPicker.tsx`, `components/UsagePill.tsx`, `components/SidebarUsage.tsx`,
  `components/SettingsView.tsx`, `components/RestorePreview.tsx`, `hooks/useStatusEngine.ts`.
- **Out of scope:** the stubs' real implementations.
- **Context:** Design 2a/1e/1f titlebar specs. Titlebar 40px, `-webkit-app-region: drag` (controls `no-drag`): logo
  24×16 · sidebar toggle (`PanelLeft`, 26×26, active bg `rgba(255,255,255,.06)` when expanded) · explorer toggle
  (`FolderTree`) · tabs (active: accent .12 bg/.32 border, `#f8cdbb` 12px/600, radius 7, pane count 10px `#8b8b93`;
  drag-reorder via HTML5 DnD; double-click inline rename; middle-click or context menu "Close workspace" → archive;
  trailing `+` → `pickDir` → `openWorkspace`) · right: `<UsagePill/>`, layout-picker icon (`LayoutGrid`, toggles
  `<LayoutPicker/>` popover, active bg .08), settings icon, 16px spacer, window controls 34×26 `#8b8b93`
  (hidden on `platform==='darwin'`, where the bar gets 78px left padding). Stripped titlebar (logo + controls only)
  in firstRun/zone-editor; centered "Settings" label in settings view. `App.tsx`: `hydrate()` then render by `view`;
  grid view = `<Sidebar/>` `<ExplorerPanel/>` and **every workspace's `<Grid workspaceId/>` mounted at once, inactive
  ones `display:none`** (scrollback must survive switches); `<RestorePreview/>` when `pendingRestore`; `<Toasts/>`;
  call `useStatusEngine()`. FirstRun per 1e: logo 66×40 stroke 2.6, headline, explainer copy verbatim, **Open folder…**
  / **Quick terminal** (opens home dir workspace with one terminal pane), RECENT list from recents (▸, name, mono path).
- **Acceptance:** app launches to first-run; opening a folder shows the shell with a tab; tabs reorder/rename; window
  controls work; typecheck/build pass.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 11, 12 · **Status:** pending

### Task 14 — Port the xterm terminal pane (refit, scroll preservation, links, file drop, resume)
- **Files:** create `src/renderer/src/hooks/useTerminalPane.ts`, `components/TerminalPane.{tsx,css}`,
  `components/PaneHeader.{tsx,css}`.
- **Out of scope:** Grid placement, context-menu contents (accept `onContextMenu` prop), usage share (accept `sharePct?` prop).
- **Context:** `useTerminalPane` ← Claudler `src/renderer/src/termPane.ts` (L93-501) minus streamer/redact/themes/fonts
  modules: keep with comments — `scrollback:8000`; OSC 8 linkHandler → `window.api.openExternal`; link provider from
  `lib/termLinks`; pin-to-bottom window (resume replay flood + hidden-mount `pendingFirstFit`) L155-200; `safeFit`
  (follow bottom or hold distance-from-bottom, applied now AND next frame) L201-248; webfont refit
  (`document.fonts.ready` + explicit `document.fonts.load`) L249-280; **`term.onResize → window.api.resizePty`**
  (FitAddon only resizes the renderer); mouse-motion report suppression when unfocused L284-300; flow control
  pause/resume water marks L301-320; ResizeObserver; live font-size/family restyle without remount. xterm theme:
  bg `#0b0b0d`, fg `#c6c6cc`, cursor accent when focused else `#75757d`, JetBrains Mono 12px lineHeight 1.6,
  padding 10px 14px. `TerminalPane` ← Claudler `ButlerPane.tsx` spawn L330-393, Shift+Enter handler L306-320,
  prompt probe L285, drop handlers L658-706 (write `shellQuote(path)+' '`, never submit; use
  `window.api.getDroppedFilePath`; also accept `text/plain` paths from the explorer): on mount → for `claude`,
  `transcriptExists` gates `--resume` via `lib/launch.buildLaunchCommand`; `spawnPty`; `registerSession` (claude only);
  report activity via `isRealOutput` into `runtime.lastActivity`; on exit mark `runtime.exited` + show an in-terminal
  notice; unmount kills the PTY; keyed by `runtime.remountKey`. `PaneHeader` (32px, design 2a/4a): status dot, name
  (double-click rename), kind/model mono 10px (`model` from session when known, else `claude`/shell name/`ssh`),
  account badge when >1 account, spacer, `NN% of window`, status word (Working `#e0784a` / Needs input `#e0784a` pulsing
  / Idle `#75757d` / Done `#7ec27a` / Exited), hover actions ⋯ (opens context menu) ⤢ (maximize) ✕ (close, confirm
  via Modal only if status is working). Header is the drag handle (`application/x-ada-pane`).
- **Acceptance:** typecheck/build; mounted in a temporary harness or the Grid stub, a terminal pane runs a shell,
  resizes correctly (`stty size` matches), keeps scroll position on resize, links open externally, dropped file pastes quoted path.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 13 (and 4, 5 for runtime behavior) · **Status:** pending

### Task 15 — Build the grid: zone rendering, dividers, empty zones, drag swap/split, maximize, menus, layout picker
- **Files:** replace `components/Grid.tsx`, `components/LayoutPicker.tsx`; create `components/Grid.css`,
  `components/LayoutPicker.css`, `components/EmptyZone.{tsx,css}`, `components/paneMenu.ts`, `components/ViewerPane.tsx` (stub only if Task 19 not done — otherwise leave).
- **Out of scope:** ZoneEditor internals, terminal internals.
- **Context:** Port Claudler `App.tsx` render closure L7356-8018 + ops L6535-6840 onto the store: `rects =
  computeZoneRects(layout, paneIds)`; each pane an **absolutely positioned, id-keyed sibling** inside `.grid`
  (8px gap/padding via inset math), never reparented; maximized pane `inset:0; z-index:5`, others
  `visibility:hidden`; focused pane border `rgba(240,82,25,.5)`. Dividers: one per `sharedEdges(layout)`;
  `startDivider` semantics — listeners on **window** not the handle (the keyed divider remounts on first frame and
  pointer capture dies), deltas against the layout captured at drag start, call `runtime.holdNotifications()` each
  beat. Drag pane header onto another zone: `zoneDragPreview` overlay drawn outside panes; center = swap, edge =
  split (`dropPaneOnZone`). `EmptyZone` per design (dashed `.16`, `+`, "New agent here", "Right-click for a quick
  spawn"; click = spawn `settings.defaultPaneKind`; right-click highlights border accent .5 and opens quick-spawn
  ContextMenu per 1c: section "SPAWN HERE", **Claude Code** (✻, ↵ hint), Terminal, Claude Code · plan mode, divider,
  Connect to server ▸ (hosts from `window.api.sshHosts()` re-read per open; "No hosts in ~/.ssh/config" disabled row),
  Claude Code as ▸ (accounts, only when >1), Duplicate pane (disabled unless a pane is focused), New agent… (name prompt)).
  `paneMenu.ts` builds pane context items: Copy (if selection), Rename…, Colour ▸ (8 swatches + default), Copy path
  (live `ptyCwd`), Copy last output, Reveal in file manager (platform label), Split ▸ right/down, Move ▸ 4 dirs
  (`neighborZoneInDirection`), Maximize/Restore, Run as account ▸ (claude, >1 account), Start fresh session (danger,
  claude only), Close pane. `LayoutPicker` per 1b: 392px popover, GRIDS / ARRANGEMENTS, 3-col tiles with flex/grid
  wireframes exactly as in mockups.html, selected = `matchPreset`, click applies immediately (`applyPreset`; if panes
  exceed zones, extra panes get split zones via `reconcileZones`), footer "Custom zones…" / "Edit layout →" open the zone editor.
  Keyboard (capture phase, before xterm): Ctrl/Cmd+1–9 focus pane N, Ctrl/Cmd+Shift+M maximize, Ctrl/Cmd+B sidebar,
  Ctrl/Cmd+Shift+L zone editor, Ctrl/Cmd+Shift+[ / ] prev/next workspace.
- **Acceptance:** panes tile per layout, dividers resize both neighbors, swap/split by drag works, maximize keeps
  other terminals alive, quick-spawn creates each kind, layout picker re-arranges live panes without respawning them.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 14 · **Status:** pending

### Task 16 — Port the zone editor with saved layouts, re-skinned to design 1d
- **Files:** replace `components/ZoneEditor.tsx`; create `components/ZoneEditor.css`, `components/SavedLayouts.{tsx,css}`.
- **Out of scope:** Grid, zones.ts changes.
- **Context:** Source Claudler `src/renderer/src/components/ZoneEditor.tsx` (1390 lines). Keep all gesture logic and
  its comments: draw on empty canvas, cut by dragging inside a zone (≥2% travel, dominant axis), edge drag
  (**clamp, don't refuse**), corner drag (clamp each axis independently, sequentially), Shift-click two zones → Merge
  (guard: refuse when it would evict a pane, `canMerge` pre-check), Backspace delete, Alt bypasses snapping (carried
  inside the gesture state), `MIN_ZONE_PX=100` (`minPct` capped 45%), snap choices `6|8|10|12|16|20|24`, Esc/Backspace
  bound in capture phase, `onGesture` each pointer beat → `runtime.holdNotifications()`. Saved layouts move from
  localStorage to `window.api.loadLayouts/saveLayouts` (`SavedLayout[]`): name on save, thumbnail, rename, reorder,
  delete-with-confirm, in a side panel that doesn't cover the canvas. Skin per 1d: 44px toolbar (APPLY / ARRANGE /
  GRID caps groups, "Apply a layout…" select incl. saved layouts, Even out, Merge, Delete, "12 × 12" select, Save
  layout…, accent **Done**), accent gridlines via repeating-linear-gradient sized to the snap grid, zone chips
  (name + `58% × 100%` mono), drawing zone 2px accent + handle dot, 30px status bar with the README's copy.
  Props: `{workspaceId, onClose}`; commits through `applyLayout`.
- **Acceptance:** all gestures work on a live workspace without respawning panes; saved layout persists across relaunch.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 13 · **Status:** pending

### Task 17 — Build the sidebar: workspace tree with nested named panes, status dots, rail mode, footer
- **Files:** replace `components/Sidebar.tsx`; create `components/Sidebar.css`, `hooks/useGitStatus.ts`.
- **Out of scope:** usage meters (renders `<SidebarUsage/>` stub above the footer), explorer.
- **Context:** Matches the user's reference: header "WORKSPACES" (10px/600 caps `#67676f`) + `+` (open folder); each
  workspace a row with disclosure ▾/▸, name (12px/600), pane-count chip; **its panes nested beneath** with the design's
  tree indent (`margin-left:13px; padding-left:12px; border-left:1px solid rgba(255,255,255,.1)`), each row: 6px
  status dot (working accent, attention `#e0784a` pulsing, idle `#59595f`, done `#7ec27a`, exited hollow), name,
  subtitle 10px (`Claude Code · working`, `Terminal · idle`, `ssh · host`, `File`), right-aligned share % mono 10px
  (em-dash for non-claude); trailing `+ New agent` row per workspace. Click pane row → `focusPane` (switches workspace,
  focuses terminal via `runtime.focusFns`, un-maximizes a different maximized pane); active row accent .11/.3.
  Double-click renames (workspace or pane; Enter/Esc; keyboard handler scoped to the input so the terminal never
  steals focus — see Claudler `Sidebar.tsx` L419-460). Drag workspaces to reorder (port `dragIndex`/`isNoop` logic
  L154-188, 384-427); drag a pane row within its workspace is NOT required. Right-click: workspace → Rename, Reveal,
  Close workspace (archives); pane → same items as `paneMenu.ts` if present, else Rename/Close. Collapsed = 46px rail:
  8px status dots for the active workspace's panes, `+`, spacer, settings icon. Footer: active workspace path (mono
  10px, `~`-shortened) and git line `branch · clean|dirty` with 5px dot (green clean / warn dirty), polled every 10s
  via `useGitStatus(cwd)`; hidden outside a repo.
- **Acceptance:** tree reflects store live; rename/reorder/select work; rail toggles with Ctrl/Cmd+B and the titlebar button.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 13 · **Status:** pending

### Task 18 — Implement the status engine: status tick, session persistence, stale-resume toast, notifications
- **Files:** replace `hooks/useStatusEngine.ts`; create `lib/notify.ts`, `lib/sound.ts`, `lib/notify.test.ts`.
- **Out of scope:** Settings UI for prefs (reads `settings.notifications`), usage warnings (main does those).
- **Context:** Port Claudler `App.tsx` L1464-1491 (on `onSessionUpdate`: merge into `runtime.sessions`; when
  `sessionId` changes call `setPaneSessionId` so resume survives relaunch), L1783-1960 activity/exit plumbing,
  L2249-2418 tick (every 1200ms compute `resolveStatus` per pane → `runtime.status`), L6840-6884 stale resume (once
  per `${paneId}:${sessionId}`: if `!transcriptExists` → error toast "Session … can't be resumed" with action
  **Start fresh**). Notification state machine per pane `{armed, idleSince, attentionNotified}`: arm on
  `session.lastWriteMs` advancing (NOT PTY output); `done` fires after `COMPLETE_GRACE_MS` sustained idle →
  set `unseenDone` unless the pane is focused in a focused window; attention latches per question and clears only
  when the prompt left the screen AND the transcript was written since (else divider drags re-ring);
  `holdNotifications()` suppresses for ~1.5s after layout gestures; ignore first 5s after launch. Hooks precedence:
  when `hooksInstalled`, `onHookEvent` Stop → `completionGate.onStop` (`ring|hold|drop`) and Notification → attention
  drive the bells and the heuristic bells stand down (status pill logic unchanged). Delivery via `lib/notify.ts`:
  respects `settings.notifications` (muted, per-kind banner/sound), banner through `window.api.showNotification`
  (title = event, body = workspace · pane name · last prompt/question), sound via WebAudio two short tones in
  `lib/sound.ts`; `onNotificationClick(paneId)` → `focusPane`.
- **Acceptance:** vitest for the pure notification state machine (extract it as a reducer in `notify.ts`): one ring
  per question, one completion per turn, nothing during hold/launch grace.
- **Verification:** `pnpm typecheck && pnpm test`
- **Depends on:** 14 · **Status:** pending

### Task 19 — Build the explorer panel and the file viewer pane
- **Files:** replace `components/ExplorerPanel.tsx`; create `components/ExplorerPanel.css`, `components/ViewerPane.{tsx,css}`,
  `components/MarkdownPreview.tsx`, `lib/explorerTreeCache.ts`, `lib/explorerIcons.ts`, `lib/treeIndentGuides.ts`.
- **Out of scope:** PDF, dot-env masking, trash confirm beyond a simple Modal.
- **Context:** Port Claudler `explorerTreeCache.ts`, `explorerIcons.ts`, `treeIndentGuides.ts` whole, and
  `components/ExplorerPanel.tsx` (uses `@headless-tree/react`): widths 160–480 default 240, indent 14, lazy dir load,
  `watchDir/unwatchDir` + `onFsChanged` refresh + 15s reconcile, never auto-expand `node_modules`, inline new
  file/folder input that survives focus steal, rename, move by drag, trash, whitespace click deselects, rows export
  their path as `text/plain` (drop on a terminal pastes it), expanded/width/open persisted via `setExplorer`. Opening
  a file → `addPane(wsId,{kind:'viewer', filePath})` (reuse an existing viewer pane for the same path). `ViewerPane`
  ← Claudler `FileViewerPane.tsx` reduced: text (mono, line numbers), image (`ada-file://` URL), markdown
  (lazy-loaded `MarkdownPreview` ← port, relative images resolved against file dir), binary/too-large notices, reload
  on `onFsChanged`; wears the same `PaneHeader`. If Task 15 created a `ViewerPane.tsx` stub, replace it.
- **Acceptance:** tree shows workspace root, reflects files created by a terminal within ~0.5s, opens text/md/image viewers as panes.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 13 (6 for runtime) · **Status:** pending

### Task 20 — Build the usage UI: titlebar pill, popover, sidebar meters, per-pane share
- **Files:** replace `components/UsagePill.tsx`, `components/SidebarUsage.tsx`; create `components/UsagePill.css`,
  `components/UsagePopover.{tsx,css}`, `components/SidebarUsage.css`, `hooks/useUsage.ts`, `lib/usageMath.ts` + test.
- **Out of scope:** full history screen ("Full history →" is rendered disabled with title "Coming later").
- **Context:** Design 4a, exact. `useUsage` subscribes `onUsage` + initial `getUsage()` into `runtime.usage`.
  `usageMath.ts`: `sharePct(sessionTokens, windowTokens, sessionWindowPct)`, `barWidth` = share of the **largest**
  consumer, `timeLeft(resetsAt)` (`2h 14m`, `4d 9h`), `tone(pct, isSessionWindow)` (<80 accent/neutral, ≥80 warn, 100
  → copy switches to reset time), "updated Ns ago". Pill: `62%` mono, 46×4 track, time left; hidden when
  `!available`. Popover 352px anchored under pill: header "Usage" + `plan · updated 30s ago`; blocks Current session
  ("5-hour window · resets 4:42 PM" / "2h 14m left", `NN% used`), Weekly · all models, any `weekly_scoped:<model>`
  windows (projection line in warn: "at this rate you'll cap Friday"); "THIS WINDOW, BY SESSION" rows (dot, name 92px
  col, bar, % 30px col) joining `bySessionId` to panes via `pane.sessionId`/`runtime.sessions`; footer "Warn me at
  80%" `Toggle` bound to `settings.warnEnabled`. `SidebarUsage`: two stacked meters SESSION WINDOW / WEEKLY · ALL with
  reset lines, or "Usage unavailable". Export `usePaneShare(paneId)` for PaneHeader/Sidebar rows.
- **Acceptance:** usageMath tests pass; with a mocked snapshot the three surfaces match the mockup values (62/38/81).
- **Verification:** `pnpm typecheck && pnpm test && pnpm build`
- **Depends on:** 13 (7 for live data) · **Status:** pending

### Task 21 — Build Settings (Appearance, Terminal, Agents, Accounts, Workspaces, About) incl. account onboarding
- **Files:** replace `components/SettingsView.tsx`; create `components/SettingsView.css`,
  `components/settings/{Appearance,Terminal,Agents,Accounts,Workspaces,About}.tsx`, `components/settings/AccountMint.tsx`.
- **Out of scope:** themes, keybinding editor.
- **Context:** Shell per 1f: 212px nav (`#161619`), active item accent .1/.22, **Done** pinned bottom, content padding
  34px 44px, cards max-width 760. Only Accounts is designed; the others follow the same card language, minimal:
  **Appearance** terminal font family (JetBrains Mono / system mono) + size 10–18 (live). **Terminal** shell path
  override, Fullscreen TUI toggle, Windows-only WSL mode toggle + distro select (`wslDistros`), Claude CLI path +
  Check button (`cliProbe` shows resolved path/version). **Agents** default pane kind; Hooks status + "Install hooks"
  button (explains it edits `~/.claude/settings.json`); notifications: master mute, and banner/sound toggles for
  "Needs input" and "Done"; warn-at % field. **Accounts** per 1f copy verbatim: Claude Code card (✻, Sign in, API
  key; rows: dot, name, description, "used by N panes"/"idle", remove), Codex (◍) and Gemini CLI (✦) cards dimmed
  with hint "No keys stored. Panes inherit whatever is in your environment." and disabled API key buttons
  (title "Coming later"). Sign in → `AccountMint` modal ← port Claudler `ClaudeAccountOnboarding.tsx`: label field,
  embedded xterm running the `mint:` PTY (`beginMint` → `spawnPty({id, mint:{configDir}, kind:'terminal'})`), auto-complete on
  `onMintDone`, paste-token fallback, cancel → `cancelMint`. **Workspaces** "Restore archived workspaces
  automatically" toggle, archived list (name, path, archived date, Delete), recents clear. **About** logo, version
  (`__APP_VERSION__`), Reveal logs.
- **Acceptance:** each setting persists and applies live; adding an API-key account makes "Claude Code as ▸" appear.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 13 (8 for accounts runtime) · **Status:** pending

### Task 22 — Build the archive restore preview and finish workspace lifecycle edges
- **Files:** replace `components/RestorePreview.tsx`; create `components/RestorePreview.css`.
- **Out of scope:** store logic (exists in Task 12) — if a store bug is found, report it, don't patch.
- **Context:** Modal shown when `pendingRestore`: title "Restore <name>?", mono path, "Closed <relative time> ·
  N panes", a mini layout thumbnail (zones as outlined rects, same wireframe style as LayoutPicker tiles) with pane
  name chips + kind, note "Claude panes resume their previous sessions." Buttons: **Restore** (primary) →
  `confirmRestore(true)`, **Start empty** → `confirmRestore(false)` (archive kept for later), Cancel (creates nothing,
  consumes nothing). Also verify end-to-end and report (do not fix outside scope): quit + relaunch restores all
  workspaces, layouts, names, and claude sessions resume; closing last workspace returns to first-run with it in RECENT.
- **Acceptance:** the three paths behave as specified; relaunch restore confirmed manually via `pnpm dev`.
- **Verification:** `pnpm typecheck && pnpm build`
- **Depends on:** 15, 17 · **Status:** pending

### Task 23 — Package for Windows/macOS/Linux, add a CDP smoke test, write docs
- **Files:** modify `package.json` (electron-builder `build` key + scripts), `README.md`; create `build/entitlements.mac.plist`,
  `build/icon.png` (1024², triple chevron on `#1c1c1f`, generated by a script) + `scripts/make-icon.mjs`,
  `scripts/e2e-smoke.mjs`, `CLAUDE.md`.
- **Out of scope:** code signing/notarization secrets, auto-update, publishing.
- **Context:** Mirror Claudler's builder config minus sidecars: `files: ["out/**/*","package.json"]`,
  **`asarUnpack: ["**/node_modules/node-pty/**"]`** (node-pty can't load from asar), mac dmg+zip hardened runtime +
  entitlements, win nsis x64 (non-oneClick, per-user), linux AppImage + dir (`executableName: ai-detachment-alpha`).
  Scripts `package:linux|win|mac`. `e2e-smoke.mjs` ← pattern from Claudler `.claude/skills/verify/SKILL.md`: launch
  `env -u ELECTRON_RUN_AS_NODE -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION ADA_PROFILE=sandbox
  npx electron-vite dev -- --remote-debugging-port=9234` with a temp userData (honor `ADA_PROFILE` → separate userData
  dir; add that 3-line switch in `src/main/index.ts` — the only source edit allowed here), connect via Node's global
  `WebSocket`, seed a workspace through `window.api`/store, assert: a terminal pane renders `.xterm-rows`, typing
  `echo ada-ok` echoes, layout preset switch keeps the same PTY (marker text still present), reload restores the
  workspace. Kill by captured PID only. `CLAUDE.md`: architecture map, the no-reparent rule, how to run/verify.
- **Acceptance:** `pnpm package:linux` produces an AppImage/dir that launches; smoke test passes; mac/win configs documented as untested-here.
- **Verification:** `pnpm typecheck && pnpm test && pnpm build && node scripts/e2e-smoke.mjs && pnpm package:linux`
- **Depends on:** all · **Status:** pending

## End-to-end verification (orchestrator, after T23)
`pnpm typecheck && pnpm test && pnpm build`, `node scripts/e2e-smoke.mjs`, then a manual `pnpm dev` pass against the
design (2a, 1b, 1c, 1d, 1e, 1f, 4a): open folder → spawn claude/terminal/ssh/viewer → rename → drag-swap → dividers →
zone editor → maximize → switch workspaces (scrollback intact) → quit/relaunch (sessions resume) → close/reopen
(preview + opt-in restore) → start fresh → usage pill/popover → notification on "needs input".
