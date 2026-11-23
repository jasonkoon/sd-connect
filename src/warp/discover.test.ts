import { describe, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from '../expect.ts'
import {
  defaultPiSessionsDir,
  findExternalAgentProcesses,
  findWarpPiProcesses,
  getClaudeSessionCwd,
  matchWarpPanesToPids,
  parseClaudeSessionStatus,
  parseLsofCwdOutput,
  parsePiSessionStatus,
  parsePsOutput,
  parsePsStartTimes,
  parseWarpFocusUrls,
  parseWarpSqlitePanes,
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

describe('findExternalAgentProcesses', () => {
  test('matches pi and claude processes under Warp', () => {
    const procs: RawProcess[] = [
      { pid: 100, ppid: 1, tty: '??', comm: 'stable', args: '/Applications/Warp.app/Contents/MacOS/stable' },
      { pid: 101, ppid: 100, tty: '??', comm: 'stable', args: '/Applications/Warp.app/Contents/MacOS/stable terminal-server' },
      { pid: 102, ppid: 101, tty: 'ttys001', comm: 'zsh', args: '-zsh' },
      { pid: 103, ppid: 102, tty: 'ttys001', comm: 'pi', args: 'pi' },
      { pid: 104, ppid: 101, tty: 'ttys002', comm: 'zsh', args: '-zsh' },
      { pid: 105, ppid: 104, tty: 'ttys002', comm: 'claude', args: 'claude' },
    ]
    const found = findExternalAgentProcesses(procs)
    expect(found).toHaveLength(2)
    expect(found[0]?.proc.pid).toBe(103)
    expect(found[0]?.agentKind).toBe('pi')
    expect(found[0]?.session).toBe('warp')
    expect(found[1]?.proc.pid).toBe(105)
    expect(found[1]?.agentKind).toBe('claude')
    expect(found[1]?.session).toBe('warp')
  })

  test('matches standalone claude and pi processes', () => {
    const procs: RawProcess[] = [
      { pid: 300, ppid: 1, tty: 'ttys003', comm: 'login', args: '/usr/bin/login' },
      { pid: 301, ppid: 300, tty: 'ttys003', comm: 'zsh', args: '-/bin/zsh' },
      { pid: 302, ppid: 301, tty: 'ttys003', comm: 'claude', args: 'claude' },
      { pid: 303, ppid: 301, tty: 'ttys003', comm: 'pi', args: 'pi' },
    ]
    const found = findExternalAgentProcesses(procs)
    expect(found).toHaveLength(2)
    expect(found[0]?.agentKind).toBe('claude')
    expect(found[0]?.session).toBe('claude')
    expect(found[1]?.agentKind).toBe('pi')
    expect(found[1]?.session).toBe('pi')
  })

  test('excludes processes running under herdr', () => {
    const procs: RawProcess[] = [
      { pid: 200, ppid: 1, tty: '??', comm: 'herdr', args: '/Users/test/.local/bin/herdr server' },
      { pid: 201, ppid: 200, tty: 'ttys002', comm: 'zsh', args: '-zsh' },
      { pid: 202, ppid: 201, tty: 'ttys002', comm: 'pi', args: 'pi' },
      { pid: 203, ppid: 201, tty: 'ttys002', comm: 'claude', args: 'claude' },
    ]
    const found = findExternalAgentProcesses(procs)
    expect(found).toHaveLength(0)
  })

  test('excludes grep or bash wrappers mentioning claude or pi', () => {
    const procs: RawProcess[] = [
      { pid: 100, ppid: 1, tty: '??', comm: 'stable', args: '/Applications/Warp.app/Contents/MacOS/stable' },
      { pid: 101, ppid: 100, tty: '??', comm: 'stable', args: 'terminal-server' },
      { pid: 102, ppid: 101, tty: 'ttys001', comm: 'zsh', args: '-zsh' },
      { pid: 104, ppid: 102, tty: 'ttys001', comm: 'grep', args: 'grep claude' },
      { pid: 105, ppid: 102, tty: 'ttys001', comm: 'node', args: 'node -e const x = "pi"' },
    ]
    const found = findExternalAgentProcesses(procs)
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

describe('parseClaudeSessionStatus & getClaudeSessionCwd', () => {
  test('reads cwd and status from claude session json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-claude-test-'))
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    writeFileSync(
      join(dir, 'sessions', '1234.json'),
      JSON.stringify({
        cwd: '/Users/test/dev/my-project',
        status: 'working',
        sessionId: 'abc-123',
      }),
    )

    const cwd = getClaudeSessionCwd(1234, dir)
    expect(cwd).toBe('/Users/test/dev/my-project')

    const status = parseClaudeSessionStatus(1234, '/Users/test/dev/my-project', dir)
    expect(status).toBe('working')
  })

  test('falls back to project jsonl when session json is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-claude-test-'))
    const projectDir = join(dir, 'projects', '-Users-test-dev-my-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, 'session-1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { stop_reason: 'tool_use' },
      }) + '\n',
    )

    const status = parseClaudeSessionStatus(9999, '/Users/test/dev/my-project', dir)
    expect(status).toBe('working')
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
  test('scans and returns discovered Warp and Claude agents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-test-'))
    const claudeDir = await mkdtemp(join(tmpdir(), 'sd-claude-test-'))

    const safePath = sessionSafePath('/Users/test/dev/git-agent')
    mkdirSync(join(dir, safePath), { recursive: true })
    writeFileSync(
      join(dir, safePath, '2026-08-20T10-00-00-000Z_1111.jsonl'),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Ready' }] },
      }) + '\n',
    )

    mkdirSync(join(claudeDir, 'sessions'), { recursive: true })
    writeFileSync(
      join(claudeDir, 'sessions', '6666.json'),
      JSON.stringify({
        cwd: '/Users/test/dev/claude-repo',
        status: 'idle',
      }),
    )

    const psOutput = `  PID  PPID TTY      COMM             ARGS
  100     1 ??       stable           /Applications/Warp.app/Contents/MacOS/stable
  101   100 ??       stable           /Applications/Warp.app/Contents/MacOS/stable terminal-server
  102   101 ttys020  zsh              -zsh
 5555   102 ttys020  pi               pi
 6666   102 ttys020  claude           claude
`
    const lsofOutput = `p5555
fcwd
n/Users/test/dev/git-agent
`
    const psEnvOutput = ` 5555 pi PWD=/Users/test/dev/git-agent WARP_FOCUS_URL=warp://session/aaaa1111 TERM=xterm-256color
 6666 claude WARP_FOCUS_URL=warp://session/bbbb2222 TERM=xterm-256color
`
    const mockExec = async (file: string, args: string[]) => {
      if (file === 'ps' && args[0] === '-Eww') return { stdout: psEnvOutput, stderr: '' }
      if (file === 'ps') return { stdout: psOutput, stderr: '' }
      if (file === 'lsof') return { stdout: lsofOutput, stderr: '' }
      if (file === 'lsappinfo') return { stdout: '"CFBundleIdentifier"="dev.warp.Warp-Stable"', stderr: '' }
      return { stdout: '', stderr: '' }
    }

    const scanner = new WarpAgentScanner({
      sessionsBaseDir: dir,
      claudeBaseDir: claudeDir,
      execCommand: mockExec,
    })

    const agents = await scanner.scan()
    expect(agents).toHaveLength(2)
    expect(agents[0]).toEqual({
      session: 'warp',
      paneId: '5555',
      workspaceId: 'warp',
      status: 'idle',
      cwd: '/Users/test/dev/git-agent',
      repo: 'git-agent',
      agent: 'pi',
      focused: true,
      focusUrl: 'warp://session/aaaa1111',
    })
    expect(agents[1]).toEqual({
      session: 'warp',
      paneId: '6666',
      workspaceId: 'warp',
      status: 'idle',
      cwd: '/Users/test/dev/claude-repo',
      repo: 'claude-repo',
      agent: 'claude',
      focused: true,
      focusUrl: 'warp://session/bbbb2222',
    })
  })
})

describe('parseWarpFocusUrls', () => {
  test('maps pids to their WARP_FOCUS_URL', () => {
    const out = ` 5555 pi PWD=/x WARP_FOCUS_URL=warp://session/abc123 TERM=xterm
 6666 claude TERM=xterm
not a ps line
`
    const urls = parseWarpFocusUrls(out)
    expect(urls.get(5555)).toBe('warp://session/abc123')
    expect(urls.has(6666)).toBe(false)
  })
})

describe('parseWarpSqlitePanes', () => {
  test('parses tab-separated sqlite output with UTC timestamps', () => {
    const out = [
      'd3a0f1c5ae234e21b3f3528cc72ad5aa\t/Users/test/dev/sd-connect/\t2026-11-23 18:34:13.210186',
      'c466e99b33ac49ab80709930684a0697\t/Users/test/dev/repo\t',
      'not-a-uuid\t/Users/test/dev/ignored\t2026-11-23 18:34:13.000000',
    ].join('\n')

    const panes = parseWarpSqlitePanes(out)
    expect(panes).toHaveLength(2)
    expect(panes[0]).toEqual({
      uuid: 'd3a0f1c5ae234e21b3f3528cc72ad5aa',
      cwd: '/Users/test/dev/sd-connect',
      lastBlockMs: Date.parse('2026-11-23T18:34:13.210186Z'),
    })
    expect(panes[1]).toEqual({
      uuid: 'c466e99b33ac49ab80709930684a0697',
      cwd: '/Users/test/dev/repo',
      lastBlockMs: null,
    })
  })
})

describe('parsePsStartTimes', () => {
  test('parses pid and lstart columns', () => {
    const out = ` 3974 Mon Nov 23 11:34:27 2026
93532 Mon Nov 23 11:21:12 2026
`
    const times = parsePsStartTimes(out)
    expect(times.get(3974)).toBe(Date.parse('Mon Nov 23 11:34:27 2026'))
    expect(times.get(93532)).toBe(Date.parse('Mon Nov 23 11:21:12 2026'))
  })
})

describe('matchWarpPanesToPids', () => {
  test('matches single pane per cwd even without block timestamps', () => {
    const matched = matchWarpPanesToPids(
      [{ pid: 3974, cwd: '/Users/test/dev/sd-connect', startMs: 1_000_000 }],
      [{ uuid: 'd3a0f1c5ae234e21b3f3528cc72ad5aa', cwd: '/Users/test/dev/sd-connect', lastBlockMs: null }],
    )
    expect(matched.get(3974)).toBe('warp://session/d3a0f1c5ae234e21b3f3528cc72ad5aa')
  })

  test('disambiguates multiple panes sharing a cwd by closest preceding block timestamp', () => {
    const matched = matchWarpPanesToPids(
      [
        { pid: 10, cwd: '/repo', startMs: Date.parse('2026-11-23T18:21:12Z') },
        { pid: 20, cwd: '/repo', startMs: Date.parse('2026-11-23T18:17:30Z') },
        { pid: 30, cwd: '/repo', startMs: Date.parse('2026-11-23T15:40:48Z') },
      ],
      [
        { uuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cwd: '/repo', lastBlockMs: Date.parse('2026-11-23T18:21:11Z') },
        { uuid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', cwd: '/repo', lastBlockMs: Date.parse('2026-11-23T18:17:29Z') },
        { uuid: 'cccccccccccccccccccccccccccccccc', cwd: '/repo', lastBlockMs: Date.parse('2026-11-23T15:40:44Z') },
      ],
    )
    expect(matched.get(10)).toBe('warp://session/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(matched.get(20)).toBe('warp://session/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(matched.get(30)).toBe('warp://session/cccccccccccccccccccccccccccccccc')
  })

  test('skips pane uuids already claimed via ps -Eww', () => {
    const matched = matchWarpPanesToPids(
      [{ pid: 10, cwd: '/repo', startMs: Date.parse('2026-11-23T18:21:12Z') }],
      [
        { uuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cwd: '/repo', lastBlockMs: Date.parse('2026-11-23T18:21:11Z') },
        { uuid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', cwd: '/repo', lastBlockMs: Date.parse('2026-11-23T18:00:00Z') },
      ],
      new Set(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']),
    )
    expect(matched.get(10)).toBe('warp://session/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  })
})

describe('WarpAgentScanner sqlite fallback', () => {
  test('falls back to warp.sqlite when ps -Eww omits WARP_FOCUS_URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-warp-sqlite-test-'))
    const claudeDir = await mkdtemp(join(tmpdir(), 'sd-claude-sqlite-test-'))

    const psOutput = `  PID  PPID TTY      COMM             ARGS
  100     1 ??       stable           /Applications/Warp.app/Contents/MacOS/stable
  101   100 ??       stable           /Applications/Warp.app/Contents/MacOS/stable terminal-server
  102   101 ttys001  zsh              -zsh
 5555   102 ttys001  pi               pi
`
    const lsofOutput = `p5555
fcwd
n/Users/test/dev/sd-connect
`
    // Simulates macOS KERN_PROCARGS2 after `pi` sets process.title = 'pi'
    const psEnvOutput = ` 5555 pi\n`
    const lstartOutput = ` 5555 Mon Nov 23 11:34:27 2026\n`
    const sqliteOutput = `d3a0f1c5ae234e21b3f3528cc72ad5aa\t/Users/test/dev/sd-connect\t2026-11-23 18:34:13.210186\n`

    const mockExec = async (file: string, args: string[]) => {
      if (file === 'ps' && args[0] === '-Eww') return { stdout: psEnvOutput, stderr: '' }
      if (file === 'ps' && args[1] === 'pid=,lstart=') return { stdout: lstartOutput, stderr: '' }
      if (file === 'ps') return { stdout: psOutput, stderr: '' }
      if (file === 'lsof') return { stdout: lsofOutput, stderr: '' }
      if (file === 'sqlite3') return { stdout: sqliteOutput, stderr: '' }
      if (file === 'lsappinfo') return { stdout: '', stderr: '' }
      return { stdout: '', stderr: '' }
    }

    const scanner = new WarpAgentScanner({
      sessionsBaseDir: dir,
      claudeBaseDir: claudeDir,
      warpDbPath: '/tmp/fake-warp.sqlite',
      execCommand: mockExec,
    })

    const agents = await scanner.scan()
    expect(agents).toHaveLength(1)
    expect(agents[0]?.focusUrl).toBe('warp://session/d3a0f1c5ae234e21b3f3528cc72ad5aa')
  })
})
