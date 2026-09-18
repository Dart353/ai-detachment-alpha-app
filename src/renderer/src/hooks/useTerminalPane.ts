/**
 * The terminal body every PTY pane shares.
 *
 * Everything here used to live inside the pane component's mount effect: xterm
 * creation, the fit/pin dance, flow control, clickable links, and the PTY
 * wiring. It is a hook rather than a component so a pane can wrap it in whatever
 * chrome it likes — a fix to the scroll pinning or the backpressure window lands
 * in every terminal at once.
 *
 * What stays with the caller is everything pane-specific: how the PTY is
 * launched (`spawn`), what extra behaviour the terminal needs (`onTerminal` —
 * Claude Code's prompt probe, Shift+Enter), and what the header draws.
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createUrlLinkProvider } from '../lib/termLinks'
import { isRealOutput } from '../lib/status'
import { ROW_RATIO, measureNaturalHeight, xtermLineHeight } from '../lib/termLineHeight'
import '@xterm/xterm/css/xterm.css'

export interface TerminalPaneConfig {
  /** the pane id, which is also its PTY id */
  id: string
  fontSize: number
  fontFamily: string
  /** this pane is the focused one — drives the cursor colour */
  focused: boolean
  /** this pane's terminal took DOM focus */
  onFocus: () => void
  /** real PTY output arrived (cursor-position polling doesn't count) */
  onActivity: (at: number) => void
  /** the PTY exited */
  onExit: (code: number) => void
  /**
   * Wire pane-specific behaviour onto the freshly opened terminal, before the
   * PTY is spawned. Anything returned runs on unmount, alongside the shared
   * teardown.
   */
  onTerminal?: (term: Terminal) => (() => void) | void
  /**
   * Launch the PTY for this pane. Resolves false when it could not start — the
   * caller has already written its own explanation into the terminal.
   */
  spawn: (term: Terminal) => Promise<boolean>
  /**
   * Default true. False leaves the process running past unmount, for a terminal
   * that is being handed to another mount rather than closed.
   */
  killOnUnmount?: boolean
}

export interface TerminalPaneHandle {
  /** attach to the element the terminal renders into */
  containerRef: RefObject<HTMLDivElement>
  /** the live terminal (null before mount / after unmount) */
  termRef: MutableRefObject<Terminal | null>
  /** re-fit the renderer to its container, preserving the reading position */
  fit: () => void
  /** put the cursor in this terminal */
  focus: () => void
}

/** A CSS custom property's value, or `fallback` where there is no document. */
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * The xterm palette, read from the design tokens at runtime so the terminal and
 * the chrome around it can never drift apart. The literals are the same values
 * tokens.css holds, kept as a fallback for a document that has not applied it.
 */
function termTheme(focused: boolean): ITheme {
  const accent = cssVar('--ada-accent', '#f05219')
  const accentRgb = cssVar('--ada-accent-rgb', '240, 82, 25')
  return {
    background: cssVar('--ada-bg-term', '#0b0b0d'),
    foreground: cssVar('--ada-text-secondary', '#c6c6cc'),
    // The focused pane owns the caret; every other one shows it dimmed, which is
    // how the grid says "typing lands here" without a second highlight.
    cursor: focused ? accent : cssVar('--ada-text-dim', '#75757d'),
    cursorAccent: cssVar('--ada-bg-term', '#0b0b0d'),
    selectionBackground: `rgba(${accentRgb}, 0.28)`
  }
}

/** The first family in a CSS font stack, unquoted — what `document.fonts` wants. */
/**
 * xterm's lineHeight for the spec's 12px/1.6 rows — see termLineHeight.ts. Falls
 * back to the bare ratio when nothing can be measured (a fallback face that is
 * exactly its size tall is the neutral guess).
 */
function rowLineHeight(fontSize: number, fontFamily: string): number {
  const natural = measureNaturalHeight(fontStack(fontFamily), fontSize)
  return natural === null ? ROW_RATIO : xtermLineHeight(fontSize, natural)
}

function primaryFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0]?.trim() ?? ''
  return first.replace(/^['"]|['"]$/g, '')
}

/** The stack xterm renders with: the chosen face, then the house fallbacks. */
function fontStack(fontFamily: string): string {
  return `${fontFamily}, ui-monospace, monospace`
}

export function useTerminalPane(config: TerminalPaneConfig): TerminalPaneHandle {
  const { id, fontSize, fontFamily, focused } = config
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // refs so the typography effects can re-fit the live terminal
  const safeFitRef = useRef<() => void>(() => {})
  // the mount effect's "re-fit once the face has really loaded" hook, so the
  // typography effect can reuse it when the family changes mid-session.
  const refitWhenFontReadyRef = useRef<() => void>(() => {})
  // The mount effect runs once per pane id, so every callback is read through a
  // ref — a re-render with new handlers must never tear a terminal down.
  const cfgRef = useRef(config)
  cfgRef.current = config

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const cfg = cfgRef.current

    const term = new Terminal({
      fontSize: cfg.fontSize,
      fontFamily: fontStack(cfg.fontFamily),
      lineHeight: rowLineHeight(cfg.fontSize, cfg.fontFamily),
      cursorBlink: false,
      theme: termTheme(cfg.focused),
      scrollback: 8000,
      // OSC 8 hyperlinks (Claude Code's TUI emits them) never reach the link
      // provider below — xterm resolves them itself, and its default action is
      // window.open, which Electron answers with a bare child BrowserWindow: a
      // browser with no address bar, not the OS default. Route them through the
      // same external-open path so both kinds of link behave identically.
      linkHandler: {
        activate: (_event, uri) => {
          window.api.openExternal(uri)
        }
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term

    // Make printed URIs clickable: http(s):// opens the browser and figma://
    // deep-links the Figma app, both through the same external-open path. Every
    // pane gets this: plain shells print URLs too, not just Claude panes.
    const linkDisposable = term.registerLinkProvider(
      createUrlLinkProvider(term, (url) => {
        window.api.openExternal(url)
      })
    )

    // Pane-specific terminal wiring (prompt probes, key handlers…).
    const paneCleanup = cfgRef.current.onTerminal?.(term)

    // Pin-to-bottom window. Two situations leave a freshly mounted pane parked
    // above the bottom of its scrollback, and neither is a reading position worth
    // preserving:
    //
    //   1. The `--resume` replay burst. spawnPty replays the whole prior transcript
    //      in one flood; wherever that leaves the viewport is where it stays, since
    //      nothing re-pins once it drains.
    //   2. Mounting hidden. On a cold start every workspace mounts at once and only
    //      the active one is visible (App renders the others with display:none), so
    //      safeFit below bails on a zero-size container and the pane takes the whole
    //      replay at a grid size that was never fitted.
    //
    // `pinning` covers (1): it stays true from mount until output has been idle for
    // PIN_IDLE_MS (with PIN_MAX_MS as a ceiling for a pane that never speaks), and
    // while it is true a fit pins to the bottom instead of restoring. `pendingFirst-
    // Fit` covers (2): it is raised when safeFit bails, and makes the first real fit
    // (fired by the ResizeObserver on the display:none → visible transition) take
    // the pin branch too. Once both are down, steady-state refits go back to
    // preserving the reading position — a user who scrolled up is never yanked to
    // the bottom by a window resize or an explorer toggle.
    const PIN_IDLE_MS = 300
    const PIN_MAX_MS = 10_000
    let pinning = true
    let pendingFirstFit = false
    let pinIdle: ReturnType<typeof setTimeout> | null = null
    let pinCeiling: ReturnType<typeof setTimeout> | null = null
    /** Snap to the bottom AND force a repaint: after a replay the buffer can already
     *  say "at bottom" while the rendered rows are stale. Applied twice for the same
     *  reason as the fit restore below (xterm re-syncs a frame later).
     *
     *  A pane sitting on the ALTERNATE buffer (Claude Code's TUI does, once its UI is
     *  up) has no scrollback, so the scroll is a no-op there and the repaint plus the
     *  correctly-sized fit are what make the redraw land. Plain shells and any pane
     *  still on the normal buffer are the ones the scroll actually rescues. */
    const pinViewportToBottom = (): void => {
      const apply = (): void => {
        if (termRef.current !== term) return
        term.scrollToBottom()
        term.refresh(0, term.rows - 1)
      }
      apply()
      requestAnimationFrame(apply)
    }

    // Refit the renderer to the container, preserving the reading position across
    // the reflow. Any width change (most notably toggling the file explorer, which
    // resizes every pane on the grid) fires the ResizeObserver below, so FitAddon
    // recomputes the grid and xterm rewraps the scrollback at the new width. Without
    // restoring the position afterwards the viewport is thrown up into the backlog;
    // it bites hardest while an agent is streaming and the pane is pinned to the
    // bottom, which reads as "the terminal jumped to the top of its chat". Record
    // where we were, fit, then put it back: follow the bottom if we were following
    // it, else hold the same distance from the bottom (more stable across a rewrap
    // than an absolute line index).
    const safeFit = (): void => {
      if (el.clientWidth === 0 || el.clientHeight === 0) {
        // Hidden (or mid-layout): this pane has never been fitted, so remember to
        // pin rather than preserve when it finally gets real dimensions.
        pendingFirstFit = true
        return
      }
      const buffer = term.buffer.active
      const wasAtBottom = buffer.viewportY >= buffer.baseY
      const linesFromBottom = buffer.baseY - buffer.viewportY
      // First fit after mounting hidden, or still draining the resume replay:
      // there is no meaningful prior position, so pin to the bottom instead.
      const pin = pendingFirstFit || pinning
      pendingFirstFit = false
      try {
        fit.fit()
      } catch {
        /* container mid-layout */
      }
      const restore = (): void => {
        if (pin) {
          term.scrollToBottom()
          term.refresh(0, term.rows - 1)
        } else if (wasAtBottom) {
          term.scrollToBottom()
        } else {
          const current = term.buffer.active
          term.scrollToLine(Math.max(0, current.baseY - linesFromBottom))
        }
      }
      // Apply now and again next frame: xterm re-syncs its viewport from the DOM
      // scroll offset a frame later, and that stray sync can otherwise land after
      // our restore and re-introduce the jump.
      restore()
      requestAnimationFrame(restore)
    }
    safeFitRef.current = safeFit

    // Reopening bug (chat box cut off): xterm measures the character cell ONCE at
    // open() and only re-measures on font changes, resize, or a devicePixelRatio
    // change — never when a webfont finishes loading. The terminal face is a
    // webfont, so on a cold open it may not be ready yet and xterm measures the
    // shorter fallback. Fit then over-counts rows for that shorter cell. When the
    // real font later loads, nothing re-fits; but the next DPR re-measure (which
    // Chromium runs when the window is minimized and reopened) swaps in the taller
    // cell WITHOUT re-fitting, so those rows overflow the pane body (overflow:
    // hidden) and clip the agent's input box. Re-fit once the terminal font is
    // actually loaded so cols/rows match the real metrics from the start and the
    // later re-measure is a no-op. The face is bundled rather than fetched, which
    // shortens that window but does not close it — a woff2 still decodes
    // asynchronously. `document.fonts` may resolve after unmount, so guard on the
    // flag.
    let fontDisposed = false
    const refitWhenFontReady = (): void => {
      if (fontDisposed || termRef.current !== term) return
      // The real face may sit on a different natural line box than the fallback
      // that was measured at open(); bring the row height back to spec before
      // the grid is re-fitted against it.
      const current = cfgRef.current
      term.options.lineHeight = rowLineHeight(current.fontSize, current.fontFamily)
      // xterm re-measures its cell ONLY when fontFamily or fontSize changes; a
      // fit on its own would read the fallback face's cell and over-count rows
      // (the chat box then hangs below the pane until a window resize forces
      // the re-measure). Nudge the family so the loaded face is what gets
      // measured, then fit against that.
      const stack = fontStack(current.fontFamily)
      term.options.fontFamily = `${stack}, serif`
      term.options.fontFamily = stack
      safeFit()
    }
    refitWhenFontReadyRef.current = refitWhenFontReady
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(refitWhenFontReady)
      // ready() resolves for whatever fonts were pending at that instant; also load
      // the chosen family explicitly so a font that starts loading later still
      // triggers a refit once its metrics are available.
      void document.fonts
        .load(`${cfg.fontSize}px "${primaryFamily(cfg.fontFamily)}"`)
        .then(refitWhenFontReady)
        .catch(() => {})
    }

    // THE #1 GOTCHA: FitAddon resizes the renderer only. Propagate the new grid to
    // the PTY or Claude Code renders at a stale size.
    term.onResize(({ cols, rows }) => window.api.resizePty(id, cols, rows))

    // Claude Code's TUI turns on mouse-motion tracking, so xterm reports every
    // pointer move over the terminal even when the pane has no focus. Merely
    // hovering an idle pane then writes motion reports to its PTY, the TUI repaints
    // in response, and the activity heuristic lights the pane up as "working" — as
    // if it had been clicked into. Hovering must never disturb an unfocused pane:
    // strip pure-motion reports (SGR button 35 / legacy X10 'C') unless the terminal
    // owns focus. Clicks, drags and wheel scrolls still pass through.
    term.onData((data) => {
      let out = data
      if (!el.contains(document.activeElement)) {
        out = out.replace(/\x1b\[<35;\d+;\d+[Mm]/g, '').replace(/\x1b\[MC[\s\S]{2}/g, '')
        if (out.length === 0) return
      }
      window.api.writePty(id, out)
    })

    // Flow control (backpressure). xterm parses writes on the renderer's single
    // thread with an unbounded buffer, so when many panes stream their full-screen
    // TUI at once the flood can block the whole UI — keyboard and scroll included.
    // We track bytes that xterm has accepted but not yet parsed (the write callback
    // fires once parsed) and, above a high-water mark, pause this PTY so the child
    // stops producing; we resume once it drains below the low-water mark. This
    // bounds each terminal's backlog and keeps input responsive no matter how many
    // are busy.
    const HIGH_WATER = 200_000
    const LOW_WATER = 50_000
    let pending = 0
    let paused = false
    /** Give back the bytes one write borrowed, and lift the pause once drained. */
    const settle = (bytes: number): void => {
      pending -= bytes
      if (paused && pending < LOW_WATER) {
        paused = false
        window.api.resumePty(id)
      }
    }
    // Close the pin window once the reload burst has settled: no PTY output for
    // PIN_IDLE_MS *and* nothing left for xterm to parse (`pending` counts bytes
    // accepted but not yet parsed — pinning before it drains would scroll to a
    // bottom that is about to move). Re-armed by every chunk while `pinning`.
    const clearPinTimers = (): void => {
      if (pinIdle) {
        clearTimeout(pinIdle)
        pinIdle = null
      }
      if (pinCeiling) {
        clearTimeout(pinCeiling)
        pinCeiling = null
      }
    }
    const armPinIdle = (): void => {
      if (pinIdle) clearTimeout(pinIdle)
      pinIdle = setTimeout(() => {
        pinIdle = null
        if (pending > 0) {
          armPinIdle() // xterm is still chewing through the burst
          return
        }
        clearPinTimers()
        pinning = false
        pinViewportToBottom()
      }, PIN_IDLE_MS)
    }

    const offData = window.api.onPtyData(({ id: paneId, data }) => {
      if (paneId !== id) return
      pending += data.length
      if (pinning) armPinIdle() // still in the reload-replay window
      if (!paused && pending > HIGH_WATER) {
        paused = true
        window.api.pausePty(id)
      }
      term.write(data, () => settle(data.length))
      if (isRealOutput(data)) cfgRef.current.onActivity(Date.now())
    })
    const offExit = window.api.onPtyExit(({ id: paneId, code }) => {
      if (paneId !== id) return
      cfgRef.current.onExit(code)
    })

    // Nothing after the teardown may spawn: the rAF below can fire on the far side
    // of a StrictMode double-mount, and a PTY started then would have no terminal
    // left to write to.
    let disposed = false
    requestAnimationFrame(() => {
      if (disposed) return
      safeFit()
      void cfgRef.current.spawn(term).then((started) => {
        if (!started || disposed) return
        // Backstop for a pane that never produces output (so the idle timer above
        // never arms): drop out of the pin window without touching the viewport, so
        // later refits go back to preserving the reading position.
        pinCeiling = setTimeout(() => {
          pinCeiling = null
          pinning = false
        }, PIN_MAX_MS)
      })
    })

    const observer = new ResizeObserver(() => safeFit())
    observer.observe(el)

    // mark this pane as the focused one when its terminal gains focus (fires for
    // both click and keyboard tab-in, since xterm focuses a textarea inside el)
    const onFocusIn = (): void => cfgRef.current.onFocus()
    el.addEventListener('focusin', onFocusIn)

    return () => {
      disposed = true
      fontDisposed = true
      clearPinTimers()
      observer.disconnect()
      el.removeEventListener('focusin', onFocusIn)
      offData()
      offExit()
      paneCleanup?.()
      // A hand-off leaves the process alive for the mount adopting it; every other
      // unmount is a close and ends the shell.
      if (cfgRef.current.killOnUnmount !== false) window.api.killPty(id)
      linkDisposable.dispose()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Restyle the live terminal when focus moves, so the caret says which pane the
  // keyboard is pointed at without a remount.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = termTheme(focused)
  }, [focused])

  // Resize the live terminal text when the setting changes. Re-fit so cols/rows are
  // recomputed; term.onResize then forwards the new grid to the PTY so Claude Code
  // re-renders at the correct size (no remount, scrollback intact).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.lineHeight = rowLineHeight(fontSize, cfgRef.current.fontFamily)
    safeFitRef.current()
  }, [fontSize])

  // A newly-chosen family may not be decoded yet: fit once now on whatever metrics
  // exist, then again through the same document.fonts.load path the mount effect
  // uses, so the final grid is measured against the real face.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontStack(fontFamily)
    term.options.lineHeight = rowLineHeight(fontSize, fontFamily)
    safeFitRef.current()
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts
        .load(`${fontSize}px "${primaryFamily(fontFamily)}"`)
        .then(() => refitWhenFontReadyRef.current())
        .catch(() => {})
    }
    // fontSize is only read for the font-loading probe; its own effect owns resizing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontFamily])

  return {
    containerRef,
    termRef,
    fit: () => safeFitRef.current(),
    focus: () => termRef.current?.focus()
  }
}
