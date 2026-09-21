import { describe, expect, it } from 'vitest'
import { PaneTap } from './paneTap'

describe('PaneTap', () => {
  it('keeps the tail of the output and the last size', () => {
    const tap = new PaneTap(10)
    tap.resize('p', 120, 40)
    tap.push('p', '0123456789')
    tap.push('p', 'abcdef')
    expect(tap.screen('p')).toEqual({ data: '6789abcdef', cols: 120, rows: 40 })
  })

  it('trims in slabs but never hands back more than the cap', () => {
    const tap = new PaneTap(4)
    tap.push('p', 'abcde') // 5 chars: over the cap, under the 1.5× trim point
    expect(tap.screen('p')?.data).toBe('bcde')
    tap.push('p', 'fg') // 7 chars: past 1.5×, the buffer itself is trimmed
    expect(tap.screen('p')?.data).toBe('defg')
  })

  it('defaults an unseen size to 80×24 and knows nothing of unseen panes', () => {
    const tap = new PaneTap()
    expect(tap.screen('nope')).toBeNull()
    expect(tap.has('nope')).toBe(false)
    tap.push('p', 'x')
    expect(tap.screen('p')).toEqual({ data: 'x', cols: 80, rows: 24 })
  })

  it('streams live output to listeners until they leave', () => {
    const tap = new PaneTap()
    const heard: string[] = []
    const off = tap.listen('p', (id, data) => heard.push(`${id}:${data}`))
    tap.push('p', 'one')
    tap.push('q', 'other pane')
    off()
    tap.push('p', 'two')
    expect(heard).toEqual(['p:one'])
  })

  it('writes only into panes it has seen, through the registered writer', () => {
    const tap = new PaneTap()
    const written: string[] = []
    expect(tap.write('p', 'x')).toBe(false) // no writer yet
    tap.setWriter((id, data) => written.push(`${id}:${data}`))
    expect(tap.write('p', 'x')).toBe(false) // never seen
    tap.push('p', 'prompt$ ')
    expect(tap.write('p', 'ls\r')).toBe(true)
    tap.drop('p')
    expect(tap.write('p', 'again')).toBe(false)
    expect(written).toEqual(['p:ls\r'])
  })

  it('forgets a dropped pane and its listeners', () => {
    const tap = new PaneTap()
    const heard: string[] = []
    tap.listen('p', (_id, data) => heard.push(data))
    tap.push('p', 'before')
    tap.drop('p')
    expect(tap.screen('p')).toBeNull()
    tap.push('p', 'after')
    expect(heard).toEqual(['before'])
  })
})
