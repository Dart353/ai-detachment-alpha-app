/**
 * The status engine: the one place that decides what every pane is doing and
 * whether the user should be told about it. Mounted once from the app shell.
 *
 * It owns five jobs, all of them driven from outside React's render cycle:
 *
 *   • transcript updates from main → runtime state, plus persisting each Claude
 *     pane's session id so `claude --resume` survives a relaunch;
 *   • a 1.2 s tick that resolves every pane's status pill and runs each Claude
 *     pane through the notification state machine;
 *   • Claude Code's Stop/Notification hooks, which are exact where the tick can
 *     only guess — while they are installed they own the bells and the
 *     heuristic's stand down (the pills are unchanged);
 *   • the stale-resume check, which catches a pane pointing at a transcript
 *     that no longer exists before the resume silently opens a blank session;
 *   • the account list and notification clicks.
 *
 * Everything reads the stores through `getState()` inside the callbacks rather
 * than through subscriptions: the tick runs on a timer, and re-binding it on
 * every keystroke of terminal output would be a render storm for no gain.
 */
import { useEffect, useRef } from 'react'
import type { HookEvent, PaneStatus, SessionInfo } from '../../../shared/types'
import { findPane, selectActiveWorkspace, useApp } from '../store/app'
import { getLastActivity, getPromptProbe, useRuntime } from '../store/runtime'
import { resolveStatus } from '../lib/status'
import { newGate, onSettle, onStop, type CompletionGate, type StopSignals } from '../lib/completionGate'
import {
  LAUNCH_GRACE_MS,
  formatNotification,
  initialNotifyState,
  shouldDeliver,
  stepNotify,
  type NotifyKind,
  type NotifyPaneState
} from '../lib/notify'
import { playChime } from '../lib/sound'

/** How often the pills and the notification machine are re-evaluated. */
const TICK_MS = 1200

/** How often the hook installation is re-checked (Settings can install them). */
const HOOKS_RECHECK_MS = 60_000

/**
 * Is the user looking straight at this pane? Only then is a bell about it
 * noise rather than news.
 */
function isWatching(paneId: string): boolean {
  if (typeof document === 'undefined') return false
  if (!document.hasFocus() || document.hidden) return false
  const state = useApp.getState()
  if (state.view !== 'grid') return false
  return selectActiveWorkspace(state)?.focusedPaneId === paneId
}

/** Ring a bell for a pane, through the Settings matrix and the watching gate. */
function deliver(kind: NotifyKind, paneId: string, detail?: string | null): void {
  const state = useApp.getState()
  const found = findPane(state, paneId)
  if (!found) return // the pane was closed while its bell was held
  const gates = shouldDeliver(state.settings.notifications, kind, {
    focusedAndVisible: isWatching(paneId)
  })
  if (!gates.banner && !gates.sound) return
  const { title, body } = formatNotification(kind, {
    workspaceName: found.ws.name,
    paneName: found.pane.name,
    detail
  })
  // Silent: the sound is ours to play (or not), per the same matrix.
  if (gates.banner) window.api?.showNotification({ title, body, paneId, silent: true })
  if (gates.sound) playChime(kind)
}

/** What a completion banner says beyond the pane's name. */
function completionDetail(session: SessionInfo | undefined): string | null {
  return session?.title ?? session?.lastPrompt ?? null
}

/** The pane a hook event belongs to, by session id; null when it cannot be told. */
function paneIdForHookEvent(event: HookEvent): string | null {
  const keys = [event.sessionId, event.parentSessionId].filter(
    (key): key is string => typeof key === 'string' && key.length > 0
  )
  if (keys.length === 0) return null
  const sessions = useRuntime.getState().sessions
  for (const workspace of useApp.getState().workspaces) {
    for (const pane of workspace.panes) {
      if (pane.kind !== 'claude') continue
      const sessionId = pane.sessionId ?? sessions[pane.id]?.sessionId ?? null
      if (sessionId && keys.includes(sessionId)) return pane.id
    }
  }
  return null
}

/** The three "this pane is working with a fleet" tells, off one hook event. */
function stopSignals(event: HookEvent): StopSignals {
  return {
    promptId: event.promptId,
    agentsRunning: event.agentsRunning,
    fromTaskNotification: event.fromTaskNotification,
    agentsLaunched: event.agentsLaunched
  }
}

/** `paneId:sessionId` — the identity of one resume attempt. */
function resumeKey(paneId: string, sessionId: string): string {
  return `${paneId}:${sessionId}`
}

/** Every Claude pane carrying a session id it intends to resume. */
function resumeTargets(): { paneId: string; sessionId: string }[] {
  const targets: { paneId: string; sessionId: string }[] = []
  for (const workspace of useApp.getState().workspaces) {
    for (const pane of workspace.panes) {
      if (pane.kind !== 'claude' || !pane.sessionId) continue
      targets.push({ paneId: pane.id, sessionId: pane.sessionId })
    }
  }
  return targets
}

export function useStatusEngine(): void {
  // Per-pane machinery, kept in refs so StrictMode's double mount re-subscribes
  // its listeners without throwing away what the panes have been through.
  const notifyStates = useRef<Record<string, NotifyPaneState>>({})
  const gates = useRef<Record<string, CompletionGate>>({})
  const staleChecked = useRef<Set<string>>(new Set())
  const startedAt = useRef(Date.now())

  /* ---- transcript updates: runtime state + the persisted session id ------- */
  useEffect(() => {
    return window.api?.onSessionUpdate((updates) => {
      const runtime = useRuntime.getState()
      runtime.setSessions(updates)
      const app = useApp.getState()
      for (const update of updates) {
        if (!update.sessionId) continue
        const found = findPane(app, update.paneId)
        if (!found || found.pane.sessionId === update.sessionId) continue
        app.setPaneSessionId(update.paneId, update.sessionId)
      }
    })
  }, [])

  /* ---- the tick: pills, the notification machine, held completions -------- */
  useEffect(() => {
    const tick = (): void => {
      const now = Date.now()
      const app = useApp.getState()
      const runtime = useRuntime.getState()
      const panes = app.workspaces.flatMap((workspace) => workspace.panes)
      if (panes.length === 0) return

      // A gesture (a divider drag, a layout change) repaints every TUI, and the
      // launch of the app resumes a screenful of panes: neither is news.
      const held = now < runtime.notificationsHeldUntil || now < startedAt.current + LAUNCH_GRACE_MS
      const status: Record<string, PaneStatus> = {}
      const live = new Set<string>()

      for (const pane of panes) {
        live.add(pane.id)
        // One read per pane per tick: the pill and the attention latch ask the
        // terminal the same question.
        const promptOnScreen = getPromptProbe(pane.id)?.() ?? false
        const session = runtime.sessions[pane.id]
        const paneStatus = resolveStatus({
          kind: pane.kind,
          exited: runtime.exited[pane.id] ?? false,
          now,
          lastActivityMs: getLastActivity(pane.id),
          session,
          promptOnScreen,
          unseenDone: runtime.unseenDone[pane.id] ?? false
        })
        status[pane.id] = paneStatus
        if (pane.kind !== 'claude') continue

        const previous = (notifyStates.current[pane.id] ??= initialNotifyState())
        const step = stepNotify(previous, {
          now,
          status: paneStatus,
          lastWriteMs: session?.lastWriteMs,
          promptOnScreen,
          focusedAndVisible: isWatching(pane.id),
          held,
          hooksOwnBells: runtime.hooksInstalled
        })
        notifyStates.current[pane.id] = step.next
        for (const effect of step.effects) {
          if (effect === 'mark-unseen-done') runtime.setUnseenDone(pane.id, true)
          else if (effect === 'attention') deliver('attention', pane.id, session?.title)
          else deliver('done', pane.id, completionDetail(session))
        }

        // A completion the gate is holding rings once the pane has been quiet
        // for the settle window — no further Stop, no transcript write.
        const gate = gates.current[pane.id]
        if (gate && gate.heldAt !== null) {
          const settled = onSettle(gate, now, session?.lastWriteMs ?? 0)
          gates.current[pane.id] = settled.gate
          if (settled.verdict === 'ring') deliver('done', pane.id, completionDetail(session))
        }
      }

      // Panes that are gone take their bookkeeping with them, so a held bell can
      // never ring for a pane that no longer exists.
      for (const paneId of Object.keys(notifyStates.current)) {
        if (!live.has(paneId)) delete notifyStates.current[paneId]
      }
      for (const paneId of Object.keys(gates.current)) {
        if (!live.has(paneId)) delete gates.current[paneId]
      }

      runtime.setStatus(status)
    }

    tick()
    // A plain interval on purpose: a hidden or blurred window still has panes
    // finishing turns, and they are exactly the ones worth a banner.
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  /* ---- stale resume detection -------------------------------------------- */
  // A pane carrying a session id intends to resume that chat. If its transcript
  // is gone (deleted, or from another machine) the resume silently opens a blank
  // session — so say so, and put "Start fresh" one click away.
  const resumeSignature = useApp((state) =>
    state.workspaces
      .flatMap((workspace) => workspace.panes)
      .filter((pane) => pane.kind === 'claude' && pane.sessionId)
      .map((pane) => resumeKey(pane.id, pane.sessionId ?? ''))
      .join('|')
  )
  useEffect(() => {
    const targets = resumeTargets()
    // A pane started fresh (or restored under a new session) drops its earlier
    // verdict, so the check actually re-runs for the resume it is about to do.
    const wanted = new Set(targets.map((target) => resumeKey(target.paneId, target.sessionId)))
    for (const key of staleChecked.current) {
      if (!wanted.has(key)) staleChecked.current.delete(key)
    }

    for (const target of targets) {
      const key = resumeKey(target.paneId, target.sessionId)
      if (staleChecked.current.has(key)) continue
      staleChecked.current.add(key)
      const found = findPane(useApp.getState(), target.paneId)
      if (!found) continue
      const { pane } = found
      void window.api
        ?.transcriptExists(pane.cwd, target.sessionId, pane.accountId)
        .then((exists) => {
          if (exists) return
          const app = useApp.getState()
          app.pushToast(
            `${pane.name}: the previous session can't be resumed — its transcript is gone.`,
            {
              kind: 'error',
              action: { label: 'Start fresh', run: () => app.startFresh(pane.id) }
            }
          )
        })
        .catch(() => {
          // the check itself failing is not worth a toast; the resume still runs
        })
    }
  }, [resumeSignature])

  /* ---- Claude Code hooks -------------------------------------------------- */
  useEffect(() => {
    const read = (): void => {
      void window.api?.hooksInstalled().then((installed) => {
        useRuntime.getState().setHooksInstalled(installed)
      })
    }
    read()
    const timer = setInterval(read, HOOKS_RECHECK_MS)

    const off = window.api?.onHookEvent((event: HookEvent) => {
      const paneId = paneIdForHookEvent(event)
      if (!paneId) return
      const notifyState = (notifyStates.current[paneId] ??= initialNotifyState())

      if (event.event === 'Notification') {
        // The hook's `message` IS the question, so it beats the session title.
        deliver('attention', paneId, event.message)
        // Mark where the transcript stood, so the heuristic's latch (which this
        // shares) holds until the pane has genuinely spoken again.
        notifyState.attentionNotified = true
        notifyState.attentionWroteAt = useRuntime.getState().sessions[paneId]?.lastWriteMs ?? 0
        return
      }
      if (event.event !== 'Stop') return

      // Only ONE of an orchestrating pane's stops is the turn ending: the gate
      // rings a plain pane's Stop at once, holds one fired with agents still in
      // flight, and drops the rest of that instruction's stops outright.
      const stop = onStop(gates.current[paneId] ?? newGate(), stopSignals(event), event.ts)
      gates.current[paneId] = stop.gate
      if (stop.verdict === 'ring') {
        deliver('done', paneId, completionDetail(useRuntime.getState().sessions[paneId]))
      }
      // The turn is over either way: the heuristic's arm and latch start again.
      notifyState.armed = false
      notifyState.idleSince = null
      notifyState.attentionNotified = false
      notifyState.attentionWroteAt = null
    })

    return () => {
      clearInterval(timer)
      off?.()
    }
  }, [])

  /* ---- accounts ----------------------------------------------------------- */
  useEffect(() => {
    void window.api?.listAccounts().then((accounts) => {
      useRuntime.getState().setAccounts(accounts)
    })
    return window.api?.onAccountsChanged((accounts) => {
      useRuntime.getState().setAccounts(accounts)
    })
  }, [])

  /* ---- a clicked banner reveals its pane ---------------------------------- */
  useEffect(() => {
    return window.api?.onNotificationClick((paneId) => {
      if (paneId) useApp.getState().focusPane(paneId)
    })
  }, [])
}

export default useStatusEngine
