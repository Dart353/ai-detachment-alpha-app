import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sshHosts } from './ssh'

/**
 * The parser runs against a temp home rather than the developer's real
 * ~/.ssh/config, which is why `sshHosts` takes the home as a parameter.
 */
let home = ''

function writeConfig(contents: string): void {
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ssh', 'config'), contents)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-ssh-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('sshHosts', () => {
  it('is empty when there is no config', () => {
    expect(sshHosts(home)).toEqual([])
  })

  it('reads plain hosts in file order', () => {
    writeConfig('Host alpha\n  User dev\n\nHost beta\n  Port 2222\n')
    expect(sshHosts(home)).toEqual(['alpha', 'beta'])
  })

  it('accepts several aliases on one Host line', () => {
    writeConfig('Host web1 web2 web3\n')
    expect(sshHosts(home)).toEqual(['web1', 'web2', 'web3'])
  })

  it('accepts the `Host=name` spelling', () => {
    writeConfig('Host=gamma\n')
    expect(sshHosts(home)).toEqual(['gamma'])
  })

  it('strips comments and dedupes', () => {
    writeConfig('# leading comment\nHost delta # trailing\nHost delta\n')
    expect(sshHosts(home)).toEqual(['delta'])
  })

  it('rejects wildcard and negated patterns', () => {
    writeConfig('Host *\nHost !bad\nHost prod?\nHost good\n')
    expect(sshHosts(home)).toEqual(['good'])
  })

  it('follows a relative Include, resolved against ~/.ssh', () => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.ssh', 'extra'), 'Host included\n')
    writeConfig('Host main\nInclude extra\n')
    expect(sshHosts(home)).toEqual(['main', 'included'])
  })

  it('expands a glob on the final Include segment, sorted', () => {
    const dir = path.join(home, '.ssh', 'config.d')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'b.conf'), 'Host bravo\n')
    fs.writeFileSync(path.join(dir, 'a.conf'), 'Host alpha\n')
    fs.writeFileSync(path.join(dir, 'skip.txt'), 'Host skipped\n')
    writeConfig('Include ~/.ssh/config.d/*.conf\n')
    expect(sshHosts(home)).toEqual(['alpha', 'bravo'])
  })

  it('terminates on an Include cycle', () => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.ssh', 'loop'), 'Host looped\nInclude config\n')
    writeConfig('Host root\nInclude loop\n')
    expect(sshHosts(home)).toEqual(['root', 'looped'])
  })
})
