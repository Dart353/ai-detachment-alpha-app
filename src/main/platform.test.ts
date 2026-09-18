import { describe, expect, it } from 'vitest'
import {
  claudeDir,
  configureWsl,
  isWsl,
  joinWinShare,
  linuxToWin,
  stripWinShare,
  toHost,
  toStored,
  winToLinux,
  wslDistro
} from './platform'

/**
 * The pure share-path transforms are the part of WSL mode that has to be right
 * on every platform: they are exercised here directly, because the discovery
 * around them only ever runs on a Windows host.
 */
const ROOT = '\\\\wsl.localhost\\Ubuntu-24.04'

describe('joinWinShare', () => {
  it('joins an absolute Linux path onto the share root', () => {
    expect(joinWinShare(ROOT, '/home/dev/.claude')).toBe(`${ROOT}\\home\\dev\\.claude`)
  })

  it('converts every separator, not just the first', () => {
    expect(joinWinShare(ROOT, '/a/b/c/d')).toBe(`${ROOT}\\a\\b\\c\\d`)
  })

  it('works with the legacy \\\\wsl$ root', () => {
    expect(joinWinShare('\\\\wsl$\\Ubuntu', '/home/dev')).toBe('\\\\wsl$\\Ubuntu\\home\\dev')
  })
})

describe('stripWinShare', () => {
  it('is the inverse of joinWinShare', () => {
    expect(stripWinShare(ROOT, joinWinShare(ROOT, '/home/dev/.claude'))).toBe('/home/dev/.claude')
  })

  it('matches the root case-insensitively (UNC paths are not case sensitive)', () => {
    expect(stripWinShare(ROOT, '\\\\WSL.LOCALHOST\\UBUNTU-24.04\\home\\dev')).toBe('/home/dev')
  })

  it('answers the share root itself with /', () => {
    expect(stripWinShare(ROOT, ROOT)).toBe('/')
  })

  it('leaves a path outside the share alone', () => {
    expect(stripWinShare(ROOT, 'C:\\Users\\dev\\project')).toBe('C:\\Users\\dev\\project')
  })

  it('leaves everything alone when there is no root yet', () => {
    expect(stripWinShare('', '\\\\wsl.localhost\\Ubuntu\\home')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home'
    )
  })
})

describe('off Windows', () => {
  it('is a pass-through no matter what the settings say', () => {
    configureWsl({ enabled: true, distro: 'Ubuntu-24.04' })
    // The setting is remembered, but never acted on outside a win32 process.
    expect(wslDistro()).toBe('Ubuntu-24.04')
    expect(isWsl()).toBe(process.platform === 'win32')
    if (process.platform === 'win32') return
    expect(toHost('/home/dev/project')).toBe('/home/dev/project')
    expect(toStored('/home/dev/project')).toBe('/home/dev/project')
    expect(linuxToWin('/home/dev')).toBe('/home/dev')
    expect(winToLinux('/home/dev')).toBe('/home/dev')
    expect(claudeDir()).toMatch(/\.claude$/)
    expect(claudeDir('/custom/config')).toBe('/custom/config')
    configureWsl({ enabled: false })
  })
})
