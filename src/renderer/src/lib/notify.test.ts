import { describe, expect, it } from 'vitest'
import type { PaneStatus, Settings } from '../../../shared/types'
import { COMPLETE_GRACE_MS } from './status'
import {
  DETAIL_MAX_CHARS,
  formatNotification,
  initialNotifyState,
  shouldDeliver,
  stepNotify,
  type NotifyEffect,
  type NotifyInput,
  type NotifyPaneState
} from './notify'

const NOW = 1_000_000

function input(over: Partial<NotifyInput> = {}): NotifyInput {
  return {
    now: NOW,
    status: 'idle',
    lastWriteMs: undefined,
    promptOnScreen: false,
    focusedAndVisible: false,
    held: false,
    hooksOwnBells: false,
    ...over
  }
}

/** Drive a sequence of ticks, collecting every effect they produced. */
function run(
  start: NotifyPaneState,
  inputs: Partial<NotifyInput>[]
): { state: NotifyPaneState; effects: NotifyEffect[] } {
  let state = start
  const effects: NotifyEffect[] = []
  for (const over of inputs) {
    const step = stepNotify(state, input(over))
    state = step.next
    effects.push(...step.effects)
  }
  return { state, effects }
}

/**
 * A pane whose transcript has been seen once and has since been written to, so
 * a completion is armed. It is left mid-turn ('working'), the way a real pane
 * arrives at the moment its last turn is written.
 */
function armedPane(writeMs: number): NotifyPaneState {
  const seen = stepNotify(initialNotifyState(), input({ status: 'working', lastWriteMs: writeMs }))
  const wrote = stepNotify(
    seen.next,
    input({ now: NOW + 1, status: 'working', lastWriteMs: writeMs + 1 })
  )
  expect(wrote.next.armed).toBe(true)
  return wrote.next
}

describe('stepNotify — the attention latch', () => {
  it('rings once per question however much the status flaps', () => {
    const flaps: PaneStatus[] = ['attention', 'working', 'attention', 'working', 'attention']
    const { effects } = run(
      initialNotifyState(),
      flaps.map((status, index) => ({ status, now: NOW + index * 1200, promptOnScreen: true }))
    )
    expect(effects).toEqual(['attention'])
  })

  it('re-arms once the prompt has gone and the transcript has been written', () => {
    const first = run(initialNotifyState(), [
      { status: 'attention', lastWriteMs: 100, promptOnScreen: true }
    ])
    expect(first.effects).toEqual(['attention'])

    // prompt gone but nothing written yet → still latched
    const quiet = stepNotify(
      first.state,
      input({ now: NOW + 1200, status: 'working', lastWriteMs: 100, promptOnScreen: false })
    )
    expect(quiet.next.attentionNotified).toBe(true)

    // the agent spoke → the latch drops and the next question rings again
    const spoke = stepNotify(
      quiet.next,
      input({ now: NOW + 2400, status: 'working', lastWriteMs: 200, promptOnScreen: false })
    )
    expect(spoke.next.attentionNotified).toBe(false)

    const second = stepNotify(
      spoke.next,
      input({ now: NOW + 3600, status: 'attention', lastWriteMs: 200, promptOnScreen: true })
    )
    expect(second.effects).toEqual(['attention'])
  })

  it('stays latched while a prompt is still on screen even after a write', () => {
    const first = run(initialNotifyState(), [
      { status: 'attention', lastWriteMs: 100, promptOnScreen: true }
    ])
    const still = stepNotify(
      first.state,
      input({ now: NOW + 1200, status: 'working', lastWriteMs: 900, promptOnScreen: true })
    )
    expect(still.next.attentionNotified).toBe(true)
  })
})

describe('stepNotify — the completion bell', () => {
  it('fires once per turn after the sustained quiet', () => {
    const start = armedPane(100)
    const ticks: Partial<NotifyInput>[] = []
    for (let index = 0; index < 12; index += 1) {
      ticks.push({ now: NOW + 1000 + index * 1200, status: 'idle', lastWriteMs: 101 })
    }
    const { effects, state } = run(start, ticks)
    expect(effects.filter((effect) => effect === 'done')).toEqual(['done'])
    expect(effects).toContain('mark-unseen-done')
    expect(state.armed).toBe(false)
  })

  it('does not fire before the grace has elapsed', () => {
    const start = armedPane(100)
    const { effects } = run(start, [
      { now: NOW + 1000, status: 'idle', lastWriteMs: 101 },
      { now: NOW + 1000 + COMPLETE_GRACE_MS - 1, status: 'idle', lastWriteMs: 101 }
    ])
    expect(effects).toEqual([])
  })

  it('never fires for a pane that was only clicked into and repainted', () => {
    // no transcript write ever advances: the pane was merely painted
    const ticks: Partial<NotifyInput>[] = []
    for (let index = 0; index < 20; index += 1) {
      ticks.push({ now: NOW + index * 1200, status: 'idle', lastWriteMs: 100 })
    }
    const { effects } = run(initialNotifyState(), ticks)
    expect(effects).toEqual([])
  })

  it('keeps a completion that lands during a hold and fires it once afterwards', () => {
    const start = armedPane(100)
    const held: Partial<NotifyInput>[] = []
    for (let index = 0; index < 10; index += 1) {
      held.push({ now: NOW + 1000 + index * 1200, status: 'idle', lastWriteMs: 101, held: true })
    }
    const during = run(start, held)
    expect(during.effects).toEqual([])
    expect(during.state.armed).toBe(true)

    const after = stepNotify(
      during.state,
      input({ now: NOW + 20_000, status: 'idle', lastWriteMs: 101 })
    )
    expect(after.effects).toEqual(['done', 'mark-unseen-done'])

    const later = stepNotify(
      after.next,
      input({ now: NOW + 40_000, status: 'idle', lastWriteMs: 101 })
    )
    expect(later.effects).toEqual([])
  })

  it('skips mark-unseen-done for the pane the user is watching', () => {
    const start = armedPane(100)
    const { effects } = run(start, [
      { now: NOW + 1000, status: 'idle', lastWriteMs: 101, focusedAndVisible: true },
      {
        now: NOW + 1000 + COMPLETE_GRACE_MS,
        status: 'idle',
        lastWriteMs: 101,
        focusedAndVisible: true
      }
    ])
    expect(effects).toEqual(['done'])
  })

  it('restarts the grace when the pane goes back to work', () => {
    const start = armedPane(100)
    const { effects } = run(start, [
      { now: NOW + 1000, status: 'idle', lastWriteMs: 101 },
      { now: NOW + 2000, status: 'working', lastWriteMs: 101 },
      { now: NOW + 1000 + COMPLETE_GRACE_MS, status: 'idle', lastWriteMs: 101 }
    ])
    expect(effects).toEqual([])
  })
})

describe('stepNotify — hooks own the bells', () => {
  it('suppresses both bells but still marks the pane unseen-done', () => {
    const start = armedPane(100)
    const { effects } = run(start, [
      { now: NOW + 1000, status: 'idle', lastWriteMs: 101, hooksOwnBells: true },
      {
        now: NOW + 1000 + COMPLETE_GRACE_MS,
        status: 'idle',
        lastWriteMs: 101,
        hooksOwnBells: true
      }
    ])
    expect(effects).toEqual(['mark-unseen-done'])
  })

  it('still tracks the attention latch so the heuristic stays in step', () => {
    const step = stepNotify(
      initialNotifyState(),
      input({ status: 'attention', promptOnScreen: true, hooksOwnBells: true })
    )
    expect(step.effects).toEqual([])
    expect(step.next.attentionNotified).toBe(true)
  })
})

describe('shouldDeliver', () => {
  const prefs: Settings['notifications'] = {
    muted: false,
    attention: { banner: true, sound: false },
    done: { banner: false, sound: true }
  }

  it('silences everything while muted', () => {
    expect(
      shouldDeliver({ ...prefs, muted: true }, 'attention', { focusedAndVisible: false })
    ).toEqual({ banner: false, sound: false })
    expect(shouldDeliver({ ...prefs, muted: true }, 'done', { focusedAndVisible: false })).toEqual({
      banner: false,
      sound: false
    })
  })

  it('never notifies about the pane being watched', () => {
    expect(shouldDeliver(prefs, 'attention', { focusedAndVisible: true })).toEqual({
      banner: false,
      sound: false
    })
  })

  it('follows the per-kind switches otherwise', () => {
    expect(shouldDeliver(prefs, 'attention', { focusedAndVisible: false })).toEqual({
      banner: true,
      sound: false
    })
    expect(shouldDeliver(prefs, 'done', { focusedAndVisible: false })).toEqual({
      banner: false,
      sound: true
    })
  })
})

describe('formatNotification', () => {
  it('titles each kind and names the workspace and pane', () => {
    expect(formatNotification('attention', { workspaceName: 'ada', paneName: 'Agent 1' })).toEqual({
      title: 'Needs input',
      body: 'ada · Agent 1'
    })
    expect(formatNotification('done', { workspaceName: 'ada', paneName: 'Agent 2' }).title).toBe(
      'Done'
    )
  })

  it('puts the detail on a second line', () => {
    const { body } = formatNotification('attention', {
      workspaceName: 'ada',
      paneName: 'Agent 1',
      detail: 'May I edit src/index.ts?'
    })
    expect(body).toBe('ada · Agent 1\nMay I edit src/index.ts?')
  })

  it('truncates a long detail at a word boundary', () => {
    const detail = 'lorem ipsum dolor '.repeat(20)
    const { body } = formatNotification('done', {
      workspaceName: 'ada',
      paneName: 'Agent 1',
      detail
    })
    const second = body.split('\n')[1]
    expect(second.length).toBeLessThanOrEqual(DETAIL_MAX_CHARS + 1)
    expect(second.endsWith('…')).toBe(true)
    expect(second).not.toContain('  ')
  })

  it('omits the second line when there is no detail', () => {
    expect(
      formatNotification('done', { workspaceName: 'ada', paneName: 'Agent 1', detail: '   ' }).body
    ).toBe('ada · Agent 1')
  })
})
