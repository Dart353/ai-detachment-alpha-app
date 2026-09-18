import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type PersistedState } from '../shared/types'
import {
  loadArchive,
  loadLayouts,
  loadRecents,
  loadSettings,
  loadState,
  saveLayouts,
  saveSettings,
  saveState,
  setStoreDir
} from './store'

let dir = ''

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-store-'))
  setStoreDir(dir)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const STATE: PersistedState = {
  v: 1,
  workspaces: [],
  activeWorkspaceId: null,
  sidebarCollapsed: false
}

describe('json persistence', () => {
  it('reads back what it wrote, leaving no temp file behind', () => {
    saveState(STATE)
    expect(loadState()).toEqual(STATE)
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('answers empty for files that do not exist', () => {
    expect(loadArchive()).toEqual([])
    expect(loadRecents()).toEqual([])
    expect(loadLayouts()).toEqual([])
  })

  it('answers the default for a corrupt file rather than throwing', () => {
    fs.writeFileSync(path.join(dir, 'ada-layouts.json'), '{ not json')
    expect(loadLayouts()).toEqual([])
    saveLayouts([{ id: 'l1', name: 'Split', zones: [] }])
    expect(loadLayouts()).toEqual([{ id: 'l1', name: 'Split', zones: [] }])
  })
})

describe('settings', () => {
  it('starts at the defaults', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps earlier saves when a later one touches a single field', () => {
    saveSettings({ wsl: { enabled: true, distro: 'Ubuntu-24.04' } })
    const merged = saveSettings({ termFontSize: 16 })
    expect(merged.termFontSize).toBe(16)
    expect(merged.wsl).toEqual({ enabled: true, distro: 'Ubuntu-24.04' })
    expect(loadSettings()).toEqual(merged)
  })

  it('fills in every field a hand-edited or older file omits, nested ones included', () => {
    fs.writeFileSync(
      path.join(dir, 'ada-settings.json'),
      JSON.stringify({
        termFontSize: 20,
        cliPaths: { claude: '/opt/bin/claude' },
        wsl: { enabled: true },
        notifications: { muted: true, done: { sound: false } }
      })
    )
    expect(loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      termFontSize: 20,
      cliPaths: { claude: '/opt/bin/claude' },
      wsl: { enabled: true },
      notifications: {
        muted: true,
        attention: DEFAULT_SETTINGS.notifications.attention,
        done: { banner: true, sound: false }
      }
    })
  })

  it('a save on top of a partial file keeps the filled-in defaults', () => {
    const merged = saveSettings({ termFontSize: 14 })
    expect(merged.notifications.attention).toEqual(DEFAULT_SETTINGS.notifications.attention)
    expect(merged.notifications.done).toEqual({ banner: true, sound: false })
    expect(merged.cliPaths).toEqual({ claude: '/opt/bin/claude' })
  })
})
