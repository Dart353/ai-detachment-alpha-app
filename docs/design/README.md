# Handoff: AI Detachment Alpha — Claude Code Terminal Multiplexer

## Overview
AI Detachment Alpha is an Electron desktop app that runs multiple Claude Code CLI sessions side by side. The main process spawns one node-pty per session; the renderer draws each as an xterm.js terminal in a resizable grid. Sessions are grouped into named **workspaces** (tabs), each bound to a directory root, persisted as JSON. Switching tabs keeps every session mounted so scrollback survives.

This handoff covers the full UI: main grid, workspace tabs, sidebar session tree (with nested sub-agents), layout picker, quick-spawn menu, zone editor, first-run screen, settings, and usage/limit-window reporting.

## About the Design Files
The bundled `Terminal Multiplexer Mockups.dc.html` is a **design reference created in HTML** — a static mockup board showing intended look and behavior, not production code. Recreate these designs in the app's real stack (Electron + React + xterm.js). Open the file in a browser; screens are laid out on a pan/zoom canvas, newest work at the top. Screen IDs (`2a`, `1a`–`1f`, `3a`–`3e`) are badges next to each mockup.

## Fidelity
**High-fidelity.** Colors, spacing, typography, and copy are final intent. Recreate pixel-perfectly, substituting real xterm.js output for the mocked terminal text. Turn 3 (logo lab, `3a`–`3e`) is exploration only — **`3e` (triple chevron) is the chosen logo**; ignore the others.

## Screens / Views

### 2a — Main grid with nested sub-agents (the canonical screen)
- Window: frameless Electron window, custom titlebar, bg `#1c1c1f`, 1px border `rgba(255,255,255,.09)`, 10px radius.
- **Titlebar (40px):** left = logo (triple chevron SVG, 24×16) ; center = workspace tabs; right = layout-picker icon, settings icon, then Windows window controls (─ ▢ ✕), each 34×26px, color `#8b8b93`.
  - Active workspace tab: bg `rgba(240,82,25,.12)`, border `rgba(240,82,25,.32)`, text `#f8cdbb`, 12px/600, 7px radius, with a session-count number in `#8b8b93` 10px. Inactive tabs: text `#8b8b93`, no bg. Trailing `+` tab creates a workspace.
- **Sidebar (244px, collapsible):** bg `#161619`, right border `rgba(255,255,255,.06)`.
  - Header row: "SESSIONS" 10px/600, letter-spacing .12em, `#67676f`; `+` on the right.
  - Session rows: 7px 10px padding, 7px radius. Status dot 6px circle (accent `#f05219` = working, `#59595f` = idle, `#7ec27a` = done). Title 12px/600 `#f0f0f3` (active) or 12px `#c6c6cc`. Subtitle 10px `#8b8b93` — e.g. "Claude Code · working · 2 sub-agents".
  - Active session row: bg `rgba(240,82,25,.11)`, border `rgba(240,82,25,.3)`; parent rows get a `▾` disclosure.
  - **Nested sub-agents:** children indent under the parent with `margin-left:13px; padding-left:12px; border-left:1px solid rgba(255,255,255,.1)`. Sub-agent rows are slightly smaller (11.5px title) with subtitle "sub-agent · working/done".
  - Footer (pinned bottom, top border): workspace path in JetBrains Mono 10px `#67676f`, and git line "main · clean" with a 5px green dot.
- **Grid area:** CSS grid, 8px gap, 8px padding. This screen uses `grid-template-columns: 3fr 2fr`, main pane spanning both rows.
- **Terminal pane:** bg `#0b0b0d`, border `rgba(255,255,255,.08)` (focused pane: `rgba(240,82,25,.5)`), 8px radius, overflow hidden.
  - Pane header (32px): bg `#141417`, bottom border `rgba(255,255,255,.05)`. Contents left→right: status dot (6px), session name 11.5px/600, agent type in JetBrains Mono 10px `#75757d` ("claude" / "pwsh"), optional badges, spacer, status word 10px ("Working" `#e0784a`, "Idle" `#75757d`, "Done" `#7ec27a`), then hover actions ⋯ ⤢ ✕ in `#75757d`.
  - Parent pane shows a "2 sub-agents" chip: 9.5px `#f8cdbb` on `rgba(240,82,25,.12)` with `rgba(240,82,25,.3)` border, 5px radius.
  - Sub-agent panes prefix the header with `↳` (10px `#75757d`) and show the parent name as a neutral chip (bg `rgba(255,255,255,.06)`).
  - Terminal body: JetBrains Mono 12px, line-height 1.6, text `#c6c6cc`, padding 10px 14px. Dim/meta lines `#59595f`, tool lines `#8b8b93`, assistant text `#e7e7ea`, active spinner line `#f05219` (✳ prefix).
- **Empty zone:** 1px dashed border `rgba(255,255,255,.16)`, 8px radius, centered stack: `+` (18px/300), "New agent here" 12px/600 `#8b8b93`, "Right-click for a quick spawn" 10.5px `#67676f`.

### 4a — Usage & limit windows
Usage is surfaced in three places, all reading the same store.

**1. Titlebar pill (always visible).** Sits left of the layout/settings icons: 4px 10px padding, 7px radius, bg `rgba(255,255,255,.07)`, border `rgba(255,255,255,.1)`. Contents: percent in JetBrains Mono 10.5px `#c6c6cc`, a 46×4px track (bg `rgba(255,255,255,.12)`, 2px radius) with accent `#f05219` fill, then time-remaining 10px `#75757d`. Click opens the usage popover. Fill color follows the threshold rule below.

**2. Sidebar footer.** Above the existing path/git footer, two stacked meters separated by 12px:
- Label row: caps label 10px/600 .1em `#67676f` ("SESSION WINDOW", "WEEKLY · ALL") + percent in JetBrains Mono 10px `#8b8b93`.
- Track 4px, 2px radius, bg `rgba(255,255,255,.1)`; session-window fill accent `#f05219`, weekly fill neutral `#8b8b93`.
- Reset line 10px `#67676f`: "resets in 2h 14m" / "resets Mon 00:00".
Session rows also gain a right-aligned per-session share (JetBrains Mono 10px; `#8b8b93` active, `#75757d` idle, `#59595f` em-dash for non-Claude panes).

**3. Usage popover** (352px, anchored under the titlebar pill; same surface as the layout picker: bg `#202025`, border `rgba(255,255,255,.12)`, 10px radius, shadow `0 18px 50px rgba(0,0,0,.55)`, 18px padding):
- Header: "Usage" 13px/700 `#f0f0f3`; right meta 10.5px `#75757d` — plan + freshness, e.g. "Max 20× · updated 30s ago".
- Three meter blocks, each = title row (11.5px/600 `#e7e7ea` + percent in JetBrains Mono 11.5px), 6px track (3px radius), then a footer row of two 10.5px `#75757d` items (left: window description/reset; right: time left, monospace):
  1. **Current session** — "5-hour window · resets 4:42 PM" / "2h 14m left"; percent `#f8cdbb`, fill `#f05219`.
  2. **Weekly · all models** — "resets Mon 00:00" / "4d 9h left"; percent `#c6c6cc`, fill `#8b8b93`.
  3. **Weekly · Opus** — projection copy in warn color when over threshold ("at this rate you'll cap Friday"); percent + fill `#e0784a` at 81%.
  Blocks 1 and 2 are separated by a 1px `rgba(255,255,255,.08)` divider; 2 and 3 by 14px margin.
- **"THIS WINDOW, BY SESSION"** (10px/600 caps): one row per Claude session, 9px gap — status dot, name (11.5px, fixed 92px column), flexible 4px bar whose width is that session's share of the *largest* consumer (not of the window), and right-aligned percent-of-window in JetBrains Mono 10.5px (30px column). Active session uses the accent fill; others neutral.
- Footer (top border): "Warn me at 80%" toggle left (11px `#8b8b93`), "Full history →" link right (11px accent `#f05219`).

**Pane headers** gain two usage fields: the model in JetBrains Mono 10px `#75757d` ("opus 4.6", "sonnet 4.6") next to the session name, and a right-aligned "41% of window" in the same style before the status word.

**Threshold colors (apply to every meter):** < 80% = accent `#f05219` for the active/session window, neutral `#8b8b93` for background windows; ≥ 80% = warn `#e0784a` (fill, percent, and the projection line); at 100% = same warn treatment with copy switched to the reset time. Do not introduce red — the palette tops out at `#e0784a`.

**Data & behavior:** poll the Claude Code usage source (CLI/API) on an interval (~30s) in the main process, cache it, and broadcast to the renderer; show "updated Ns ago" from the cache timestamp so the UI never looks stale-but-silent. Per-session shares come from attributing token spend to the pane that produced it. If usage is unavailable, hide the titlebar pill and show "Usage unavailable" in the sidebar footer rather than zeros. "Warn me at 80%" fires an OS notification once per window per threshold.

Additional state: `usage: { plan, updatedAt, sessionWindow: { pct, resetsAt }, weeklyAll: { pct, resetsAt }, weeklyOpus: { pct, resetsAt, projectedCapAt }, bySession: [{ sessionId, pct }] }`, plus `warnAtPct` (default 80) in settings.

### 1a — Main grid, expanded sidebar (pre-nesting variant)
Same shell as 2a with a 232px sidebar, flat session list, and a 2×2 grid (two live panes, one shell pane, one empty zone). Superseded by 2a's sidebar tree but shows the 2×2 layout and a terminal cursor block (7×14px filled rect, accent for focused pane, `#75757d` otherwise).

### 1b — Layout picker (collapsed icon rail)
- Sidebar collapsed to a 46px icon rail: status dots per session (8px), `+`, spacer, settings icon.
- Layout-picker titlebar icon gets active treatment: bg `rgba(255,255,255,.08)`, 6px radius.
- Popover anchored below the icon, top-right: 392px wide, bg `#202025`, border `rgba(255,255,255,.12)`, 10px radius, shadow `0 18px 50px rgba(0,0,0,.55)`, 16px padding.
  - Two sections labeled "GRIDS" / "ARRANGEMENTS" (10px/600, .12em, `#8b8b93`).
  - 3-column grid of layout tiles, 10px gap. Each tile: mini wireframe (54×32 box outlines, 1.5px `#8b8b93` strokes, 3px gaps/radius) + 10.5px label `#a3a3aa`, wrapped in a 1px `rgba(255,255,255,.09)` border, 8px radius, 10px 6px padding.
  - Grids: Single, 2 columns, 2 rows, 2×2, 3 columns, 2×3. Arrangements: Main + side, Main + 2, Main + 3, Top + 2 below.
  - Selected tile: border `rgba(240,82,25,.6)`, bg `rgba(240,82,25,.06)`, label `#f8cdbb`, wireframe strokes `#e7e7ea` with main region filled `rgba(255,255,255,.14)`, and a 15px accent check badge at top-right corner.
  - Footer row (top border): "Custom zones…" `#8b8b93` left, "Edit layout →" in accent `#f05219` right.

### 1c — Quick spawn menu
Right-clicking an empty zone highlights its dashed border in `rgba(240,82,25,.5)` and opens a 230px context menu (same popover surface styles as 1b, 8px padding):
- Section label "SPAWN HERE" (9.5px caps).
- Items (7px 10px padding, 6px radius, 12px labels): **Claude Code** (accent ✻ icon, highlighted row bg `rgba(240,82,25,.1)`, ↵ hint), Terminal, Claude Code · plan mode, divider (`rgba(255,255,255,.08)`), Duplicate pane, New agent….

### 1d — Zone editor
- Toolbar (44px) under the titlebar, bg `#161619`, 1px borders: "Edit zones" 12.5px/700; grouped controls with 10px caps section labels (APPLY / ARRANGE / GRID): "Apply a layout…" select, Even out (enabled, bordered), Merge + Delete (disabled `#59595f`), "12 × 12" grid select, spacer, "Save layout…", and a **Done** button (accent bg `#f05219`, dark text `#1a1a1a`, 12px/700, 7px radius).
- Canvas: 8px margin, faint accent gridlines via repeating-linear-gradients (`rgba(240,82,25,.07)` every ~118px × 65px for 12×12).
- Existing zones: 1px border `rgba(240,82,25,.55)`, bg `rgba(240,82,25,.05)`, 8px radius, centered chip (bg `#202025`, session name 12px/600 + size "58% × 100%" in JetBrains Mono 10.5px `#8b8b93`).
- Zone being drawn: 2px solid `#f05219`, bg `rgba(240,82,25,.12)`, chip "New zone · 41% × 50%", 10px accent handle dot at bottom-right corner.
- Status bar (30px, bottom center, 11px `#67676f`): "**Drawing** · releases into a 41% × 50% zone · drag inside a zone to cut · Shift-click two to merge · Alt bypasses snapping".

### 1e — First run
Centered column: logo (66×40 triple chevron), "AI DETACHMENT ALPHA" 11px/700 .14em `#8b8b93`, "Open a folder to start" 19px/700 `#f0f0f3`, explainer 13px `#8b8b93` max-width 380px ("A workspace is a folder. Sessions you spawn inside it share its directory and survive tab switches."), then two buttons: **Open folder…** (accent, 9px 20px, 8px radius, 12.5px/700) and **Quick terminal** (outlined `rgba(255,255,255,.14)`). Below, a 400px "RECENT" list: rows with ▸, workspace name 12px, path right-aligned in JetBrains Mono 10.5px `#67676f`; first row bg `rgba(255,255,255,.04)`.

### 1f — Settings · Accounts
- Left nav (212px, bg `#161619`): Appearance, Terminal, Agents, **Accounts** (active: accent-tinted row like the workspace tab), Workspaces, About; **Done** button pinned bottom.
- Content (34px 44px padding): "Accounts" 16px/700; sub-copy 12px `#8b8b93`: "Run different panes as different accounts. Claude accounts get their own config folder; other CLIs get a key injected at launch."
- Cards (max-width 760px, 12px gap): 1px border, 10px radius, 16px 18px padding.
  - **Claude Code** card (border `.1`, bg `rgba(255,255,255,.02)`): header row with ✻, name 13px/700, Sign in + API key outlined buttons. Account rows: green/gray dot, name + description, right meta ("used by 3 panes" / "idle"). Accounts: Default (Your own login), work-account (Separate config folder).
  - **Codex** and **Gemini CLI** cards: dimmer (name `#c6c6cc`), API key button, hint 11.5px `#75757d`: "No keys stored. Panes inherit whatever is in your environment."

## Interactions & Behavior
- **Workspace tabs:** click switches workspace; all sessions stay mounted (keep xterm instances alive, just hide inactive workspace containers — scrollback must survive). `+` opens a folder picker; workspace binds to that directory root.
- **Pane focus:** click focuses; focused pane gets the accent border. Header action icons appear on hover.
- **Empty zone:** click = open new-agent flow; right-click = quick spawn menu (1c). Selecting Claude Code spawns `claude` in the workspace directory via node-pty.
- **Layout picker (1b):** clicking a tile re-arranges live panes into that layout immediately; "Edit layout →" enters the zone editor (1d).
- **Zone editor (1d):** drag empty space to draw a zone (snaps to the selected grid; Alt bypasses snapping); drag inside a zone to cut it; drag edges/corners to resize; Shift-click two zones enables Merge; Done exits and applies.
- **Sub-agents (2a):** when Claude Code spawns a Task/sub-agent, it appears nested under its parent in the sidebar and optionally as a linked pane with the `↳ parent` chip. Parent disclosure `▾` collapses the children. Sub-agent completion flips its dot/status to green "Done".
- **Status model:** working (accent), idle (gray), done (green). Same colors in sidebar dots, pane header dots, and status words.
- Popovers/menus: no animation needed beyond a fast fade (~120ms); shadow `0 18px 50px rgba(0,0,0,.55)`.

## State Management
- `workspaces: [{ id, name, rootDir, layout, sessions: [...] }]` persisted as JSON (as specified by the product owner).
- `session: { id, name, kind: 'claude' | 'terminal', status: 'working' | 'idle' | 'done', color?, parentId? }` — `parentId` drives sidebar nesting and pane `↳` chips.
- `layout`: zone list `{ x, y, w, h }` in grid fractions + which sessionId occupies each zone; empty zones have no sessionId.
- UI state: activeWorkspaceId, focusedSessionId, sidebarCollapsed (rail vs 244px panel), zoneEditor mode.
- Main process owns node-pty lifecycles; renderer subscribes per session id.

## Design Tokens
Colors:
- Primary/accent: `#f05219` = `hsl(16 88% 52%)` (rgb 240 82 25)
- Accent tinted text: `#f8cdbb` · working-status text: `#e0784a`
- Accent surfaces: `rgba(240,82,25,.05–.12)` bg, `.22–.6` borders
- Window bg `#1c1c1f` · sidebar/toolbar `#161619` · pane header `#141417` · terminal bg `#0b0b0d` · popover `#202025` · page/app dark `#111114`
- Text: `#f0f0f3` (strong) · `#e7e7ea` (primary) · `#c6c6cc` (secondary) · `#a3a3aa` · `#8b8b93` (muted) · `#75757d` · `#67676f` (faint) · `#59595f` (disabled/idle)
- Success/done: `#7ec27a` · hairlines: `rgba(255,255,255,.05–.16)`

Typography:
- UI: Segoe UI / system-ui. Terminal + paths + sizes: **JetBrains Mono** (400/500).
- Scale: 9.5–10px chips/labels (caps labels: 600 weight, .10–.14em tracking), 10.5–11.5px meta, 12px body/rows, 12.5–13px buttons/card titles, 16px section titles, 19px first-run headline. Terminal text 12px / 1.6.

Spacing & shape:
- Grid gap/padding 8px · pane radius 8px · popover/card radius 10px · row/button radius 7px · chip radius 5px
- Titlebar 40px · pane header 32px · toolbar 44px · sidebar 244px (rail 46px) · settings nav 212px

## Assets
- Logo: triple chevron SVG (three `❯` paths, stroke `#f05219`, 3px width, round caps, opacities 1 / .65 / .35), drawn inline — no external asset. Source in the mockup file.
- ✻ glyph is used only to represent Claude Code itself (spawn menu, settings, session icons).
- No images; all icons are inline glyphs/SVG. Substitute a proper icon set (e.g. Lucide) at implementation time, keeping the 12px muted-gray treatment.

## Files
- `Terminal Multiplexer Mockups.dc.html` — the full mockup board. Turn 4 = 4a (usage & limit windows, newest); Turn 2 = 2a (nested sub-agents); Turn 1 = 1a–1f (all core screens, same palette); Turn 3 = logo exploration (3e chosen).
