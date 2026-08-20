import { describe, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from '../expect.ts'
import {
  defaultPiSessionsDir,
  findWarpPiProcesses,
  parseLsofCwdOutput,
  parsePiSessionStatus,
  parsePsOutput,
  sessionSafePath,
  WarpAgentScanner,
  type RawProcess,
} from './discover.ts'

describe('parsePsOutput', () => {
  test('parses process lines and ignores header', () => {
    const raw = `  PID  PPID TTY      COMM             ARGS
1234     1 ??       stable           /Applications/Warp.app/Contents/MacOS/stable
5678  1234 ??       stable           /Applications/Warp.app/Contents/MacOS/stable terminal-server --parent-pid=1234
9101  5678 ttys020  zsh              -zsh -g --no_rcs
9999  9101 ttys020  pi               pi
`
    const procs = parsePsOutput(raw)
    expect(procs).toHaveLength(4)
    expect(procs[0]).toEqual({
      pid: 1234,
      ppid: 1,
      tty: '??',
      comm: 'stable',
      args: '/Applications/Warp.app/Contents/MacOS/stable',
    })
    expect(procs[3]).toEqual({
      pid: 9999,
      ppid: 9101,
      tty: 'ttys020',
      comm: 'pi',
      args: 'pi',
    })
  })
})

describe('findWarpPiProcesses', () => {
  test('matches pi process whose ancestor is Warp', () => {
    const procs: RawProcess[] = [
      { pid: 100, ppid: 1, tty: '??', comm: 'stable', args: '/Applications/Warp.app/Contents/MacOS/stable' },
      { pid: 101, ppid: 100, tty: '??', comm: 'stable', args: '/Applications/Warp.app/Contents/MacOS/stable terminal-server' },
      { pid: 102, ppid: 101, tty: 'ttys001', comm: 'zsh', args: '-zsh' },
      { pid: 103, ppid: 102, tty: 'ttys001', comm: 'pi', args: 'pi' },
    ]
    const found = findWarpPiProcesses(procs)
    expect(found).toHaveLength(1)
    expect(found[0]?.pid).toBe(103)
  })

  test('excludes pi process running under herdr', () => {
    const procs: RawProcess[] = [
      { pid: 200, ppid: 1, tty: '??', comm: 'herdr', args: '/Users/test/.local/bin/herdr server' },
      { pid: 201, ppid: 200, tty: 'ttys002', comm: 'zsh', args: '-zsh' },
      { pid: 202, ppid: 201, tty: 'ttys002', comm: 'pi', args: 'pi' },
    ]
    const found = findWarpPiProcesses(procs)
    expect(found).toHaveLength(0)
  })

  test('excludes pi process running in standard terminal without Warp', () => {
    const procs: RawProcess[] = [
      { pid: 300, ppid: 1, tty: 'ttys003', comm: 'login', args: '/usr/bin/login' },
      { pid: 301, ppid: 300, tty: 'ttys003', comm: 'zsh', args: '-/bin/zsh' },
      { pid: 302, ppid: 301, tty: 'ttys003', comm: 'pi', args: 'pi' },
    ]
    const found = findWarpPiProcesses(procs)
    expect(found).toHaveLength(0)
  })

  test('excludes grep or bash commands mentioning pi', () => {
    const procs: RawProcess[] = [
      { pid: 100, ppid: 1, tty: '??', comm: 'stable', args: '/Applications/Warp.app/Contents/MacOS/stable' },
      { pid: 101, ppid: 100, tty: '??', comm: 'stable', args: 'terminal-server' },
      { pid: 102, ppid: 101, tty: 'ttys001', comm: 'zsh', args: '-zsh' },
      { pid: 104, ppid: 102, tty: 'ttys001', comm: 'grep', args: 'grep pi' },
      { pid: 105, ppid: 102, tty: 'ttys001', comm: 'node', args: 'node -e const x = "pi"' },
    ]
    const found = findWarpPiProcesses(procs)
    expect(found).toHaveLength(0)
  })
})

describe('parseLsofCwdOutput', () => {
  test('extracts pid to cwd mappings', () => {
    const raw = `p100
fcwd
n/Users/test/dev/project1
p200
fcwd
n/Users/test/dev/project2
`
    const map = parseLsofCwdOutput(raw)
    expect(map.size).toBe(2)
    expect(map.get(100)).toBe('/Users/test/dev/project1')
    expect(map.get(200)).toBe('/Users/test/dev/project2')
  })
})

describe('sessionSafePath', () => {
  test('encodes directory path', () => {
    expect(sessionSafePath('/Users/jason.koon/dev/git-agent')).toBe('--Users-jason.koon-dev-git-agent--')
  })
})

describe('parsePiSessionStatus', () => {
  test('defaults to idle when directory is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const status = parsePiSessionStatus('/non/existent/path', dir)
    expect(status).toBe('idle')
  })

  test('defaults to idle when session file is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const safePath = sessionSafePath('/test/repo')
    mkdirSync(join(dir, safePath), { recursive: true })
    writeFileSync(join(dir, safePath, '2026-08-20T10-00-00-000Z_1111.jsonl'), '')
    const status = parsePiSessionStatus('/test/repo', dir)
    expect(status).toBe('idle')
  })

  test('reports working when last message is from user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const safePath = sessionSafePath('/test/repo')
    mkdirSync(join(dir, safePath), { recursive: true })
    const line = JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'do something' },
    })
    writeFileSync(join(dir, safePath, '2026-08-20T10-00-00-000Z_1111.jsonl'), `${line}\n`)
    const status = parsePiSessionStatus('/test/repo', dir)
    expect(status).toBe('working')
  })

  test('reports working when last message is a toolResult', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const safePath = sessionSafePath('/test/repo')
    mkdirSync(join(dir, safePath), { recursive: true })
    const line = JSON.stringify({
      type: 'message',
      message: { role: 'toolResult', toolName: 'bash', content: 'ok' },
    })
    writeFileSync(join(dir, safePath, '2026-08-20T10-00-00-000Z_1111.jsonl'), `${line}\n`)
    const status = parsePiSessionStatus('/test/repo', dir)
    expect(status).toBe('working')
  })

  test('reports working when assistant has pending toolCalls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const safePath = sessionSafePath('/test/repo')
    mkdirSync(join(dir, safePath), { recursive: true })
    const line = JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', id: 'call_1' }],
      },
    })
    writeFileSync(join(dir, safePath, '2026-08-20T10-00-00-000Z_1111.jsonl'), `${line}\n`)
    const status = parsePiSessionStatus('/test/repo', dir)
    expect(status).toBe('working')
  })

  test('reports blocked when assistant has ask_user toolCall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const safePath = sessionSafePath('/test/repo')
    mkdirSync(join(dir, safePath), { recursive: true })
    const line = JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'ask_user', id: 'call_ask' }],
      },
    })
    writeFileSync(join(dir, safePath, '2026-08-20T10-00-00-000Z_1111.jsonl'), `${line}\n`)
    const status = parsePiSessionStatus('/test/repo', dir)
    expect(status).toBe('blocked')
  })

  test('reports idle when assistant turn is finished without tool calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const safePath = sessionSafePath('/test/repo')
    mkdirSync(join(dir, safePath), { recursive: true })
    const line = JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'All done!' }],
      },
    })
    writeFileSync(join(dir, safePath, '2026-08-20T10-00-00-000Z_1111.jsonl'), `${line}\n`)
    const status = parsePiSessionStatus('/test/repo', dir)
    expect(status).toBe('idle')
  })
})

describe('WarpAgentScanner', () => {
  test('scans and returns discovered Warp agents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const safePath = sessionSafePath('/Users/test/dev/git-agent')
    mkdirSync(join(dir, safePath), { recursive: true })
    writeFileSync(
      join(dir, safePath, '2026-08-20T10-00-00-000Z_1111.jsonl'),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Ready' }] },
      }) + '\n',
    )

    const psOutput = `  PID  PPID TTY      COMM             ARGS
  100     1 ??       stable           /Applications/Warp.app/Contents/MacOS/stable
  101   100 ??       stable           /Applications/Warp.app/Contents/MacOS/stable terminal-server
  102   101 ttys020  zsh              -zsh
 5555   102 ttys020  pi               pi
`
    const lsofOutput = `p5555
fcwd
n/Users/test/dev/git-agent
`
    const mockExec = async (file: string, args: string[]) => {
      if (file === 'ps') return { stdout: psOutput, stderr: '' }
      if (file === 'lsof') return { stdout: lsofOutput, stderr: '' }
      if (file === 'lsappinfo') return { stdout: '"CFBundleIdentifier"="dev.warp.Warp-Stable"', stderr: '' }
      return { stdout: '', stderr: '' }
    }

    const scanner = new WarpAgentScanner({
      sessionsBaseDir: dir,
      execCommand: mockExec,
    })

    const agents = await scanner.scan()
    expect(agents).toHaveLength(1)
    expect(agents[0]).toEqual({
      session: 'warp',
      paneId: '5555',
      workspaceId: 'warp',
      status: 'idle',
      cwd: '/Users/test/dev/git-agent',
      repo: 'git-agent',
      agent: 'pi',
      focused: true,
    })
  })
})
