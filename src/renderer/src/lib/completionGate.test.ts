import { describe, expect, it } from 'vitest'
import {
  SETTLE_MS,
  WRITE_GRACE_MS,
  isSubagentTurn,
  newGate,
  onSettle,
  onStop,
  type StopSignals
} from './completionGate'

function signals(promptId: string | null, over: Partial<StopSignals> = {}): StopSignals {
  return {
    promptId,
    agentsRunning: false,
    fromTaskNotification: false,
    agentsLaunched: false,
    ...over
  }
}

describe('isSubagentTurn', () => {
  it('is false for a plain turn and true for each fleet tell', () => {
    expect(isSubagentTurn(signals('p1'))).toBe(false)
    expect(isSubagentTurn(signals('p1', { agentsRunning: true }))).toBe(true)
    expect(isSubagentTurn(signals('p1', { fromTaskNotification: true }))).toBe(true)
    expect(isSubagentTurn(signals('p1', { agentsLaunched: true }))).toBe(true)
  })
})

describe('plain runs (no agents in flight)', () => {
  it('rings at once, drops repeats, rings again for the next instruction', () => {
    let gate = newGate()
    let result = onStop(gate, signals('p1'), 1000)
    gate = result.gate
    expect(result.verdict).toBe('ring')

    result = onStop(gate, signals('p1'), 2000)
    gate = result.gate
    expect(result.verdict).toBe('drop')

    result = onStop(gate, signals('p2'), 3000)
    gate = result.gate
    expect(result.verdict).toBe('ring')

    // nothing held → a settle tick is a no-op
    expect(onSettle(gate, 9e9, 0).verdict).toBe('idle')
  })

  it('never latches on a payload with no prompt id', () => {
    const first = onStop(newGate(), signals(null), 1)
    const second = onStop(first.gate, signals(null), 2)
    expect(first.verdict).toBe('ring')
    expect(second.verdict).toBe('ring')
  })
})

describe('orchestrated runs (agents still running)', () => {
  it('holds, restarts the quiet window, then rings exactly once', () => {
    let gate = newGate()
    let result = onStop(gate, signals('p1', { agentsRunning: true }), 1_000)
    gate = result.gate
    expect(result.verdict).toBe('hold')

    let settle = onSettle(gate, 1_000 + SETTLE_MS - 1, 1_000)
    expect(settle).toMatchObject({ verdict: 'wait', waitMs: 1 })

    // an agent reports in: the pane speaks again, so the window restarts
    result = onStop(gate, signals('p1', { agentsRunning: true }), 60_000)
    gate = result.gate
    expect(result.verdict).toBe('hold')
    settle = onSettle(gate, 1_000 + SETTLE_MS, 60_000)
    expect(settle).toMatchObject({ verdict: 'wait', waitMs: 59_000 })

    // a transcript write between stops also restarts it…
    settle = onSettle(gate, 60_000 + SETTLE_MS, 100_000)
    expect(settle).toMatchObject({ verdict: 'wait', waitMs: 40_000 })

    // …unless it is the stopping turn's own write, landing beside the Stop
    settle = onSettle(gate, 60_000 + SETTLE_MS, 60_000 + WRITE_GRACE_MS)
    expect(settle.verdict).toBe('ring')

    gate = settle.gate
    expect(onSettle(gate, 9e9, 0).verdict).toBe('idle')

    result = onStop(gate, signals('p1', { agentsRunning: true }), 300_000)
    gate = result.gate
    expect(result.verdict).toBe('drop')
    expect(gate.heldAt).toBeNull()

    result = onStop(gate, signals('p1'), 400_000)
    expect(result.verdict).toBe('drop')

    result = onStop(result.gate, signals('p2', { agentsRunning: true }), 500_000)
    expect(result.verdict).toBe('hold')
  })

  it('collapses thirteen stops of one instruction into a single notification', () => {
    let gate = newGate()
    let rings = 0
    let now = 0
    for (let stop = 0; stop < 13; stop++) {
      now += 30_000
      const result = onStop(gate, signals('p1', { agentsRunning: true }), now)
      gate = result.gate
      if (result.verdict === 'ring') rings++
    }
    const settle = onSettle(gate, now + SETTLE_MS, now)
    gate = settle.gate
    if (settle.verdict === 'ring') rings++
    expect(rings).toBe(1)
  })
})
