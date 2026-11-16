import { describe, expect, it } from 'vitest'
import {
  autostartBlocker,
  autostartDesktopEntry,
  linuxLaunchPath,
  quoteExecArg
} from './autostart'

describe('whether a build can open at login', () => {
  it('refuses a run from source, which would register bare Electron', () => {
    expect(autostartBlocker({ packaged: false, platform: 'win32' })).toMatch(/installed build/)
  })

  it('allows a packaged build on Windows, macOS and Linux', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(autostartBlocker({ packaged: true, platform })).toBeNull()
    }
  })

  it('says so on anything else', () => {
    expect(autostartBlocker({ packaged: true, platform: 'freebsd' })).toMatch(/not supported/)
  })
})

describe('what Linux launches at login', () => {
  it('prefers the AppImage over its temporary mount', () => {
    expect(linuxLaunchPath('/tmp/.mount_ada/ai-detachment-alpha', '/home/me/Apps/ada.AppImage')).toBe(
      '/home/me/Apps/ada.AppImage'
    )
  })

  it('uses the executable for an unpacked build', () => {
    expect(linuxLaunchPath('/opt/ada/ai-detachment-alpha')).toBe('/opt/ada/ai-detachment-alpha')
  })
})

describe('the autostart desktop entry', () => {
  it('quotes paths with spaces and escapes the reserved characters', () => {
    expect(quoteExecArg('/home/me/My Apps/ada')).toBe('"/home/me/My Apps/ada"')
    expect(quoteExecArg('/a"b`c$d\\e')).toBe('"/a\\"b\\`c\\$d\\\\e"')
    expect(quoteExecArg('/odd/100%/ada')).toBe('"/odd/100%%/ada"')
  })

  it('is a launchable application entry', () => {
    const entry = autostartDesktopEntry('/opt/ada/ai-detachment-alpha')
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
    expect(entry).toContain('Type=Application\n')
    expect(entry).toContain('Exec="/opt/ada/ai-detachment-alpha"\n')
  })
})
