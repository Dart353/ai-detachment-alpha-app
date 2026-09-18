import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { PtyManager, scanPromptSignal, type PtySpawn } from './ptyManager'
import type { SpawnOpts } from '../shared/types'

// node-pty is a native module built for Electron's ABI; the manager only ever
// touches it through the injectable spawn seam, so the import is stubbed out.
vi.mock('node-pty', () => ({
  spawn: () => {
    throw new Error('node-pty must not be spawned from tests')
  }
}))

const PROMPT_READY_SIGNAL = '\x1b[?2004h'

interface FakePty {
  proc: IPty
  writes: string[]
  killed: boolean
  emitData(data: string): void
  emitExit(exitCode: number): void
}

/** A stand-in for one node-pty process, with its callbacks driven by hand. */
function fakePty(pid: number): FakePty {
  let dataHandler: ((data: string) => void) | null = null
  let exitHandler: ((event: { exitCode: number }) => void) | null = null
  const fake = {
    proc: {
      pid,
      write: (data: string) => fake.writes.push(data),
      kill: () => {
        fake.killed = true
      },
      pause: () => undefined,
      resume: () => undefined,
      resize: () => undefined,
      onData: (handler: (data: string) => void) => {
        dataHandler = handler
      },
      onExit: (handler: (event: { exitCode: number }) => void) => {
        exitHandler = handler
      }
    } as unknown as IPty,
    writes: [] as string[],
    killed: false,
    emitData: (data: string) => dataHandler?.(data),
    emitExit: (exitCode: number) => exitHandler?.({ exitCode })
  }
  return fake
}

/** A manager whose spawns are fakes, plus the fakes in spawn order. */
function managerWithFakes(): { manager: PtyManager; spawned: FakePty[] } {
  const spawned: FakePty[] = []
  const spawnPty: PtySpawn = () => {
    const fake = fakePty(1000 + spawned.length)
    spawned.push(fake)
    return fake.proc
  }
  const manager = new PtyManager({
    fullscreenTui: () => true,
    shellPath: () => undefined,
    accountEnv: () => undefined,
    spawnPty
  })
  return { manager, spawned }
}

const claudePane: SpawnOpts = { id: 'pane-1', kind: 'claude', command: 'claude' }

afterEach(() => {
  vi.useRealTimers()
})

describe('scanPromptSignal', () => {
  it('finds the signal inside one chunk', () => {
    const scan = scanPromptSignal('', `noise${PROMPT_READY_SIGNAL}more`)
    expect(scan.found).toBe(true)
    expect(scan.tail).toBe('')
  })

  it('finds the signal split across two chunks at every byte boundary', () => {
    for (let cut = 1; cut < PROMPT_READY_SIGNAL.length; cut++) {
      const first = scanPromptSignal('', `prefix${PROMPT_READY_SIGNAL.slice(0, cut)}`)
      expect(first.found).toBe(false)
      const second = scanPromptSignal(first.tail, `${PROMPT_READY_SIGNAL.slice(cut)}suffix`)
      expect(second.found, `boundary ${cut}`).toBe(true)
    }
  })

  it('reports nothing for output without the signal', () => {
    expect(scanPromptSignal('', 'plain output\r\n').found).toBe(false)
    // A lone bracketed-paste DISABLE is not the enable sequence.
    expect(scanPromptSignal('', '\x1b[?2004l').found).toBe(false)
  })

  it('keeps the tail bounded to one byte short of the signal', () => {
    let tail = ''
    for (let chunk = 0; chunk < 50; chunk++) {
      tail = scanPromptSignal(tail, 'x'.repeat(4096)).tail
      expect(tail.length).toBeLessThanOrEqual(PROMPT_READY_SIGNAL.length - 1)
    }
  })
})

describe('PtyManager command injection', () => {
  it('holds the launch command until the shell signals it is reading', () => {
    const { manager, spawned } = managerWithFakes()
    manager.spawn(claudePane, () => undefined, () => undefined)
    const shell = spawned[0]

    shell.emitData('Last login: today\r\n')
    expect(shell.writes).toEqual([])

    shell.emitData(PROMPT_READY_SIGNAL)
    expect(shell.writes).toEqual(['claude\r'])
  })

  it('writes the command once even when the signal arrives twice', () => {
    const { manager, spawned } = managerWithFakes()
    manager.spawn(claudePane, () => undefined, () => undefined)
    const shell = spawned[0]

    shell.emitData(PROMPT_READY_SIGNAL)
    shell.emitData(PROMPT_READY_SIGNAL)
    expect(shell.writes).toEqual(['claude\r'])
  })

  it('writes the command after the fallback timeout for a shell that never signals', () => {
    vi.useFakeTimers()
    const { manager, spawned } = managerWithFakes()
    manager.spawn(claudePane, () => undefined, () => undefined)
    const shell = spawned[0]

    vi.advanceTimersByTime(4999)
    expect(shell.writes).toEqual([])

    vi.advanceTimersByTime(1)
    expect(shell.writes).toEqual(['claude\r'])
  })

  it('does not type into a pane that was killed before it became ready', () => {
    vi.useFakeTimers()
    const { manager, spawned } = managerWithFakes()
    manager.spawn(claudePane, () => undefined, () => undefined)
    const shell = spawned[0]

    manager.kill(claudePane.id)
    vi.advanceTimersByTime(10_000)
    expect(shell.writes).toEqual([])
    expect(shell.killed).toBe(true)
  })
})

describe('PtyManager proc identity', () => {
  it("ignores a stale exit so it cannot evict a respawn under the same id", () => {
    const { manager, spawned } = managerWithFakes()
    const exits: string[] = []
    const onExit = (id: string): void => {
      exits.push(id)
    }
    manager.spawn(claudePane, () => undefined, onExit)
    manager.spawn(claudePane, () => undefined, onExit)
    const [first, second] = spawned

    // The killed shell's exit lands after the replacement has registered.
    first.emitExit(0)
    expect(exits).toEqual([])

    manager.write(claudePane.id, 'echo hi\r')
    expect(second.writes).toContain('echo hi\r')

    second.emitExit(0)
    expect(exits).toEqual([claudePane.id])
  })

  it('drops output-driven readiness from a stale proc', () => {
    const { manager, spawned } = managerWithFakes()
    manager.spawn(claudePane, () => undefined, () => undefined)
    manager.spawn(claudePane, () => undefined, () => undefined)
    const [first, second] = spawned

    first.emitData(PROMPT_READY_SIGNAL)
    expect(first.writes).toEqual([])

    second.emitData(PROMPT_READY_SIGNAL)
    expect(second.writes).toEqual(['claude\r'])
  })
})
