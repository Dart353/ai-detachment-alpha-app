import { describe, expect, it } from 'vitest'
import {
  htmlTitle,
  mergePublishes,
  nameFromPath,
  publishesFromTranscript,
  type Publish
} from './artifacts'

const URL_A = 'https://claude.ai/artifact/QtNkEj6k2UwH5TqBz9QpDn'

/** One transcript line, shaped the way Claude Code writes them. */
function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry)
}

function call(id: string, input: Record<string, unknown>, timestamp: string, cwd = '/home/u/cake'): string {
  return line({
    type: 'assistant',
    timestamp,
    cwd,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Artifact', input }] }
  })
}

function result(id: string, content: unknown, isError = false): string {
  return line({
    type: 'user',
    timestamp: '2026-09-26T00:09:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]
    }
  })
}

const published = (file: string, version: number): string =>
  `Published ${file} at ${URL_A} (Version ${version}, version id 1790381333-8fa6) Icon: "cake".\n\nLive subscription: …`

describe('publishesFromTranscript', () => {
  it('pairs a publish call with its result', () => {
    const text = [
      call('t1', { file_path: '/home/u/cake/index.html', icon: 'cake', description: 'A cake shop.' }, '2026-09-26T00:08:53.364Z'),
      result('t1', published('/home/u/cake/index.html', 1))
    ].join('\n')
    expect(publishesFromTranscript(text)).toEqual([
      {
        url: URL_A,
        at: Date.parse('2026-09-26T00:08:53.364Z'),
        filePath: '/home/u/cake/index.html',
        description: 'A cake shop.',
        title: null,
        version: 1,
        cwd: '/home/u/cake'
      }
    ])
  })

  it('reads a result delivered as text blocks', () => {
    const text = [
      call('t1', { file_path: '/home/u/cake/index.html' }, '2026-09-26T00:08:53.364Z'),
      result('t1', [{ type: 'text', text: published('/home/u/cake/index.html', 2) }])
    ].join('\n')
    expect(publishesFromTranscript(text).map((p) => p.version)).toEqual([2])
  })

  it('skips errors, other actions, asset uploads and unrelated tools', () => {
    const text = [
      call('t1', { file_path: '/a.html' }, '2026-09-26T00:00:00.000Z'),
      result('t1', published('/a.html', 1), true),
      call('t2', { action: 'list' }, '2026-09-26T00:00:00.000Z'),
      result('t2', published('/a.html', 1)),
      call('t3', { url: URL_A, file_path: '/logo.png', asset: true }, '2026-09-26T00:00:00.000Z'),
      result('t3', published('/logo.png', 1)),
      result('other', published('/a.html', 1))
    ].join('\n')
    expect(publishesFromTranscript(text)).toEqual([])
  })

  it('ignores a transcript that never called the tool', () => {
    expect(publishesFromTranscript(result('t1', published('/a.html', 1)))).toEqual([])
  })

  it('survives garbage lines', () => {
    const text = ['not json', call('t1', { file_path: '/a.html' }, 'bad date'), '{', result('t1', published('/a.html', 1))].join('\n')
    expect(publishesFromTranscript(text)).toHaveLength(1)
    expect(publishesFromTranscript(text)[0].at).toBe(0)
  })
})

describe('mergePublishes', () => {
  const publish = (over: Partial<Publish>): Publish => ({
    url: URL_A,
    at: 0,
    filePath: '/home/u/cake/index.html',
    description: null,
    title: null,
    version: null,
    cwd: '/home/u/cake',
    ...over
  })

  it('folds every version of a page into one record', () => {
    const [record] = mergePublishes(
      [
        publish({ at: 100, version: 1, description: 'first' }),
        publish({ at: 300, version: 3 }),
        publish({ at: 200, version: 2, description: 'second' })
      ],
      () => 'Awesome Wedding Cakes',
      () => true
    )
    expect(record).toEqual({
      url: URL_A,
      title: 'Awesome Wedding Cakes',
      description: 'second',
      filePath: '/home/u/cake/index.html',
      fileExists: true,
      cwd: '/home/u/cake',
      version: 3,
      firstPublishedAt: 100,
      lastPublishedAt: 300,
      publishCount: 3
    })
  })

  it('orders artifacts by their latest publish, newest first', () => {
    const records = mergePublishes(
      [publish({ url: 'https://claude.ai/artifact/old', at: 50 }), publish({ at: 900 })],
      () => null,
      () => true
    )
    expect(records.map((record) => record.url)).toEqual([URL_A, 'https://claude.ai/artifact/old'])
  })

  it('names a page from its path when the file is gone', () => {
    const [record] = mergePublishes([publish({})], () => 'never read', () => false)
    expect(record.title).toBe('cake')
    expect(record.fileExists).toBe(false)
  })
})

describe('nameFromPath', () => {
  it('uses the folder for an index page and the stem otherwise', () => {
    expect(nameFromPath('/home/u/cake/index.html', URL_A)).toBe('cake')
    expect(nameFromPath('C:\\work\\report.html', URL_A)).toBe('report')
    expect(nameFromPath(null, URL_A)).toBe('QtNkEj6k2UwH5TqBz9QpDn')
  })
})

describe('htmlTitle', () => {
  it('reads and tidies the title', () => {
    expect(htmlTitle('<html><head><title>\n  Cake   Builder </title>')).toBe('Cake Builder')
    expect(htmlTitle('<title></title>')).toBeNull()
    expect(htmlTitle('<p>no head</p>')).toBeNull()
  })
})
