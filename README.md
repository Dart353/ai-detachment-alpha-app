# AI Detachment Alpha

A minimal Electron terminal multiplexer for Claude Code. A **workspace** is a
folder; inside it you tile **panes**, each one a real PTY, and each pane's status
is read from Claude Code's own transcript rather than guessed at.

## What it does

- **Tiled panes** — xterm.js over node-pty, arranged by a FancyZones-style zone
  layout: presets, a zone editor, draggable dividers, drag a pane onto another to
  swap or split, maximize one over the canvas.
- **Pane kinds** — `claude` (with plan mode and `--resume`), `terminal`, `ssh`
  (hosts read from `~/.ssh/config`), and a file `viewer` with markdown preview.
- **Workspaces** — bound to a folder, persisted, reorderable, renameable, shown
  both as titlebar tabs and as a sidebar tree. Every workspace stays mounted, so
  switching never costs a terminal its scrollback.
- **Named panes in the sidebar**, nested under their workspace; clicking one
  focuses that pane.
- **Close → archive, reopen → preview + opt-in restore.** Claude panes come back
  with their session ids and resume the conversation they were having.
- **Full restore on relaunch**, including layouts, names, colours and sessions.
- **Status per pane** — `working · attention · idle · done · exited` — from the
  transcript, from a blocking-prompt probe on the visible buffer, and from Claude
  Code hooks once you install them.
- **Usage and limit meters** — session and week windows, each pane's share of the
  current window, OS notifications when a pane finishes or needs input.
- **Multiple Claude accounts**, each with its own config directory.
- **Explorer panel**, clickable links, file drop → shell-quoted path, and a pane
  context menu for everything above.
- **Windows (with WSL mode), macOS and Linux**, all packaged.

## Development

```sh
pnpm install     # also rebuilds node-pty against Electron's ABI
pnpm dev
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | electron-vite dev server |
| `pnpm build` | build main, preload and renderer into `out/` |
| `pnpm start` | preview a build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest over the pure logic in `src/main`, `src/shared` and `src/renderer/src/lib` |
| `pnpm test:e2e` | build, then drive the real app over CDP (see below) |
| `pnpm package:dir` | fast unpacked Linux build into `release/linux/version_<x_y_z>/linux-unpacked` |
| `pnpm package:linux` / `:win` / `:mac` | full electron-builder packaging into `release/<platform>/version_<x_y_z>/` |

### Packaging for Windows

Build on a Windows machine (node-pty is a native module compiled against the
host, and electron-builder does not cross-compile it):

```powershell
# prerequisites, once: Node 22+, pnpm, and the Visual Studio 2022 Build Tools
# with the "Desktop development with C++" workload (node-gyp needs it)
pnpm install
pnpm package:win
```

The NSIS installer lands in `release\win\version_0_1_0\AI Detachment Alpha Setup 0.1.0.exe`
(per-user, custom install dir). It is unsigned, so SmartScreen will warn on
first launch; code signing is a later step. `pnpm package:mac` works the same
way on a Mac (ad-hoc signed, unnotarized until certificates are added).

### Installing on a Mac

Every release carries two DMGs: `-arm64` for Apple Silicon and `-x64` for Intel.
They are ad-hoc signed and not notarized, so the first open is blocked: macOS
says it "could not verify" the app (or, on older versions, that the developer
cannot be verified). Clear it once with either of:

- open it, dismiss the dialog, then **System Settings → Privacy & Security**,
  scroll to the message about the app and click **Open Anyway**; or
- in Terminal, after dragging the app to Applications:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/AI Detachment Alpha.app"
  ```

After that it opens normally. If macOS instead says the app "is damaged", the
build was not signed at all — that was the case for v1.7.0's DMG; use a later
release. Auto-update is off on macOS until the app is
signed with an Apple Developer identity; install new releases from the DMG.
| `pnpm make:icon` | regenerate `build/icon.png` (already committed) |

### The end-to-end smoke test

`pnpm test:e2e` launches the built app under a throwaway userData profile and
drives it over the Chrome DevTools Protocol: it opens a folder, spawns a
terminal, runs a command in the PTY, applies layout presets, maximizes, renames,
switches workspaces, reloads, archives and restores, opens the explorer and
visits Settings — asserting throughout that no pane is ever respawned or
reparented and that the renderer logs no errors. A failing step prints the page
state it saw and writes `scripts/.smoke-failure.png`.

It needs a display (or `xvfb-run`) and passes `--no-sandbox` itself; the app
never sets that flag.

### Why the scripts unset `ELECTRON_RUN_AS_NODE`

VS Code's integrated terminal exports `ELECTRON_RUN_AS_NODE=1`. Inheriting it
makes Electron boot as plain Node — no window, no renderer, no error that says
why. Every script that starts Electron therefore goes through
`scripts/electron-vite.mjs`, a tiny cross-platform launcher that deletes the
variable before spawning electron-vite (POSIX `env -u` does not exist in
PowerShell or cmd), and the PTY manager strips it (along with the
`CLAUDE_CODE_*` session vars, which would otherwise make a child `claude` adopt
this app's session) from every process it spawns.


## Where the data lives

Everything is in Electron's userData directory:

| Platform | Path |
| --- | --- |
| Linux | `~/.config/AI Detachment Alpha` |
| macOS | `~/Library/Application Support/AI Detachment Alpha` |
| Windows | `%APPDATA%\AI Detachment Alpha` |

`ada-state.json` (workspaces, panes, layouts), `ada-settings.json`,
`ada-archive.json`, `ada-recents.json`, `ada-layouts.json`, `ada-accounts.json`,
per-account Claude config under `claude-accounts/<id>/`, and `logs/ada.log`
alongside `logs/crashes/` — Settings → About reveals the folder.

Two environment variables move it:

- `ADA_PROFILE=<name>` → the sibling folder `AI Detachment Alpha (<name>)`. A run
  from source defaults to `ADA_PROFILE=dev`, so developing never touches the
  installed app's workspaces.
- `ADA_USER_DATA=<absolute path>` → exactly that folder (what the smoke test
  uses, and what also switches the renderer into its test mode).

Account tokens are the exception: they are encrypted with the OS keychain
through Electron's `safeStorage` and never leave the main process. The relay
pairing key (`ada-relay.json`) is stored the same way.

## Remote: watching your panes from a phone

Settings → Remote connects the app to a **relay**
([ai-detachment-alpha-relay](https://github.com/Dart353/ai-detachment-alpha-relay))
you run on a server of your own. The app keeps one outbound socket.io
connection to it and pushes what its panes are doing: every workspace and pane,
the same `working · attention · idle · done · exited` pill the sidebar shows,
the transcript's title or last prompt, and how long ago the pane last spoke.
Nothing on this machine is exposed — no port, no tunnel — and it works from
whichever network the machine is on. Tap a pane on the phone and it opens: the
recent output replays into a terminal at the desktop's size, output streams
live, and a prompt box plus a key bar (Esc, arrows, Enter, Ctrl+C) type into
that pane's PTY. The phone can also add a Claude Code or terminal pane to an
open workspace, and open a recent folder (an archived one is restored with its
panes, without the desktop's prompt). The desktop keeps ownership of the
terminal's size.

Pairing: each machine has a **pairing key** (256 random bits, shown under
Settings → Remote). The relay knows the machine only by the key's SHA-256; the
phone opens the relay's page, adds the key once, and sees that machine — and
every other machine it holds a key for — on one screen. **Rotate** revokes
every phone. Holding a key grants everything on that machine — seeing its panes
and typing into them — so treat it like a password. Settings → Remote lists the
phones connected right now (device, address, how long, what they are watching)
and can disconnect one, which makes that phone forget the key; a phone you no
longer control is shut out by rotating the key. Run this on each machine you
work from.

## WSL mode

On Windows, Settings → Terminal can put panes inside a WSL distro. Every path
that crosses the boundary — spawn cwd, transcripts, `~/.claude`, the file tree,
dropped files — is translated in `src/main/platform.ts`; nothing else in the app
needs to know which side it is on.

## Packaging

`pnpm package:dir` is the quick check, and it is the one verified here: it
produces `release/linux/version_0_1_0/linux-unpacked/ai-detachment-alpha` with node-pty's native
binary under `app.asar.unpacked` (it cannot be loaded from inside an asar).
`pnpm package:linux` additionally builds an AppImage.

**macOS and Windows are configured but unverified**: dmg + zip with a hardened
runtime and `build/entitlements.mac.plist`, and an NSIS x64 installer that lets
the user choose the directory. Both have to be built on their own OS — node-pty
is compiled per platform — so neither has been run.

## Releases

Versions are derived from commit subjects, in the conventional-commits style,
by `.github/workflows/release.yml`:

| Commit subject | Bump |
| --- | --- |
| `fix: usage toast repeated every poll` | patch |
| `feat: add workspace screen` | minor |
| `feat!: …` or a `BREAKING CHANGE:` footer | major |
| `chore:` `docs:` `refactor:` `test:` `build:` `ci:` | none on their own |

On every push to `main`, release-please keeps one pull request open
("chore(main): release x.y.z") that bumps `package.json` and writes
`CHANGELOG.md`, grouped into Features and Bug Fixes. Merging that pull request
is the release: it is tagged `vx.y.z`, a GitHub Release is published with the
changelog as its notes, and the Windows installer and Linux AppImage are built
on GitHub's runners and attached. Nothing is released until that PR is merged,
so several changes can land on `main` and ship together.

Never bump `version` by hand; the release PR owns it. macOS is not built there
until there is a signing identity to add as a repository secret.

## Design

`docs/design/README.md` and `docs/design/mockups.html` are the authoritative
spec: colours, sizes and copy come from there, and the tokens are mirrored in
`src/renderer/src/styles/tokens.css`.
