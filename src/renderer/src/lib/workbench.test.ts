import { describe, expect, it } from 'vitest'
import type { WorkbenchSection, WorkbenchSnapshot } from '../../../shared/types'
import {
  bellText,
  isWorkbenchPane,
  newlyWanting,
  pageStatus,
  wantingSections,
  workbenchBellTarget,
  workbenchPathOf,
  workspaceOfBellTarget
} from './workbench'

function task(agent: string, status: WorkbenchSection['status'], question: string | null = null): WorkbenchSection {
  return { agent, title: agent.toUpperCase(), status, now: null, counts: null, question, captures: 0 }
}

function page(...sections: WorkbenchSection[]): WorkbenchSnapshot {
  return { rootDir: '/p', exists: true, sections, readAt: 0 }
}

describe('workbenchPathOf', () => {
  it('joins with the root’s own separator', () => {
    expect(workbenchPathOf('/Users/me/app')).toBe('/Users/me/app/workbench.html')
    expect(workbenchPathOf('/Users/me/app/')).toBe('/Users/me/app/workbench.html')
    expect(workbenchPathOf('C:\\dev\\app')).toBe('C:\\dev\\app\\workbench.html')
  })

  it('recognises the workbench pane and nothing else', () => {
    expect(isWorkbenchPane({ kind: 'viewer', filePath: '/p/workbench.html' }, '/p')).toBe(true)
    expect(isWorkbenchPane({ kind: 'viewer', filePath: '/p/other.html' }, '/p')).toBe(false)
    expect(isWorkbenchPane({ kind: 'terminal' }, '/p')).toBe(false)
  })
})

describe('newlyWanting', () => {
  it('rings for nothing on the first look at a page', () => {
    expect(newlyWanting(undefined, page(task('a', 'needs-input', 'Which?')))).toEqual([])
  })

  it('rings when a task starts waiting', () => {
    const next = page(task('a', 'needs-input', 'Which?'), task('b', 'working'))
    expect(newlyWanting(page(task('a', 'working')), next).map((s) => s.agent)).toEqual(['a'])
  })

  it('rings when a task becomes blocked', () => {
    expect(newlyWanting(page(task('a', 'working')), page(task('a', 'blocked'))).length).toBe(1)
  })

  it('does not ring again for the same wait on a re-read', () => {
    const waiting = page(task('a', 'needs-input', 'Which?'))
    expect(newlyWanting(waiting, page(task('a', 'needs-input', 'Which?')))).toEqual([])
  })

  it('rings again when the waiting task asks something new', () => {
    const before = page(task('a', 'needs-input', 'Which?'))
    expect(newlyWanting(before, page(task('a', 'needs-input', 'And now?'))).length).toBe(1)
  })

  it('never rings for a task finishing', () => {
    expect(newlyWanting(page(task('a', 'working')), page(task('a', 'done')))).toEqual([])
  })
})

describe('wantingSections and pageStatus', () => {
  it('counts the waiting tasks', () => {
    const p = page(task('a', 'needs-input'), task('b', 'blocked'), task('c', 'done'))
    expect(wantingSections(p).map((s) => s.agent)).toEqual(['a', 'b'])
    expect(wantingSections(undefined)).toEqual([])
  })

  it('reports the worst status on the page', () => {
    expect(pageStatus(undefined)).toBeNull()
    expect(pageStatus(page())).toBeNull()
    expect(pageStatus(page(task('a', 'done'), task('b', 'working')))).toBe('working')
    expect(pageStatus(page(task('a', 'blocked'), task('b', 'needs-input')))).toBe('needs-input')
    expect(pageStatus(page(task('a', 'done')))).toBe('done')
  })
})

describe('bells', () => {
  it('says which workspace, which task and what it asks', () => {
    expect(bellText('my-app', task('a', 'needs-input', 'English or Spanish?'))).toEqual({
      title: 'my-app needs you',
      body: 'A\nEnglish or Spanish?'
    })
    expect(bellText('my-app', task('a', 'blocked')).body).toBe('A\nBlocked')
  })

  it('round-trips a click target and leaves real pane ids alone', () => {
    expect(workspaceOfBellTarget(workbenchBellTarget('w1'))).toBe('w1')
    expect(workspaceOfBellTarget('p123')).toBeNull()
  })
})
