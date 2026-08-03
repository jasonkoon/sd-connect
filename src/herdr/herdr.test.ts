import { afterEach, describe, test } from 'node:test'
import { expect } from '../expect.ts'
import { createServer, type Server } from 'node:net'
import { mkdtemp, mkdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HerdrError, listAgents, parseAgentList, request } from './protocol.ts'
import { discoverSessions, discoverLiveSessions } from './sessions.ts'
import { AgentPoller } from './poller.ts'
import type { Agent } from '../types.ts'

const servers: Server[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

/**
 * Fake herdr server. Mimics the real one's single-shot behaviour: reply to one
 * request, then close the connection.
 */
async function fakeServer(
  handler: (method: string) => unknown,
  socketPath: string,
): Promise<Server> {
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const { method, id } = JSON.parse(chunk.toString().trim())
      const result = handler(method)
      const body =
        result instanceof Error
          ? { id, error: { code: 'boom', message: result.message } }
          : { id, result }
      socket.end(`${JSON.stringify(body)}\n`)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return server
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sd-connect-test-'))
}

/**
 * Create a socket file with nothing listening on it, as a stopped herdr session
 * leaves behind.
 *
 * Node's net.Server unlinks its socket path on close(), so simply closing a
 * server does not reproduce this. Listening on a temporary path and renaming it
 * while still live does: close() then unlinks the original (now absent) name and
 * leaves the renamed file orphaned on disk.
 */
async function staleSocket(socketPath: string): Promise<void> {
  const server = createServer(() => {})
  const tempPath = `${socketPath}.live`
  await new Promise<void>((resolve) => server.listen(tempPath, resolve))
  await rename(tempPath, socketPath)
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function rawAgent(overrides: Record<string, unknown> = {}) {
  return {
    pane_id: 'w1:p1',
    workspace_id: 'w1',
    agent_status: 'idle',
    cwd: '/tmp/example',
    agent: 'pi',
    focused: false,
    ...overrides,
  }
}

describe('parseAgentList', () => {
  test('maps the fields we render', () => {
    const [a] = parseAgentList({ agents: [rawAgent({ agent_status: 'working' })] })
    expect(a).toEqual({
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent_status: 'working',
      cwd: '/tmp/example',
      agent: 'pi',
      focused: false,
    })
  })

  test('degrades an unrecognised status to unknown instead of throwing', () => {
    // A future herdr adding a status must not take the daemon down.
    const [a] = parseAgentList({ agents: [rawAgent({ agent_status: 'reticulating' })] })
    expect(a?.agent_status).toBe('unknown')
  })

  test('tolerates null cwd and missing agent', () => {
    const [a] = parseAgentList({ agents: [rawAgent({ cwd: null, agent: null })] })
    expect(a?.cwd).toBeNull()
    expect(a?.agent).toBeNull()
  })

  test('skips entries without the identifying fields', () => {
    const list = parseAgentList({ agents: [rawAgent(), { nonsense: true }, null, 'x'] })
    expect(list).toHaveLength(1)
  })

  test('throws when the reply is not shaped like a list', () => {
    expect(() => parseAgentList({})).toThrow(/no agents array/)
  })
})

describe('request', () => {
  test('resolves the result of a single request', async () => {
    const dir = await tempDir()
    const sock = join(dir, 'herdr.sock')
    await fakeServer(() => ({ type: 'pong' }), sock)
    expect(await request(sock, 'ping')).toEqual({ type: 'pong' })
  })

  test('surfaces an error reply as HerdrError', async () => {
    const dir = await tempDir()
    const sock = join(dir, 'herdr.sock')
    await fakeServer(() => new Error('invalid request'), sock)
    await expect(request(sock, 'agent.list')).rejects.toThrow(HerdrError)
  })

  test('rejects when nothing is listening', async () => {
    const dir = await tempDir()
    await expect(request(join(dir, 'absent.sock'), 'ping')).rejects.toThrow()
  })

  test('times out rather than hanging on a silent server', async () => {
    const dir = await tempDir()
    const sock = join(dir, 'herdr.sock')
    const server = createServer(() => {
      /* accept and say nothing */
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(sock, r))
    await expect(request(sock, 'ping', {}, { timeoutMs: 150 })).rejects.toThrow(/timed out/)
  })

  test('rejects on malformed JSON', async () => {
    const dir = await tempDir()
    const sock = join(dir, 'herdr.sock')
    const server = createServer((socket) => {
      socket.once('data', () => socket.end('not json\n'))
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(sock, r))
    await expect(request(sock, 'ping')).rejects.toThrow(/malformed JSON/)
  })
})

describe('discoverSessions', () => {
  test('returns an empty list when the directory is absent', async () => {
    expect(await discoverSessions('/nonexistent/sd-connect')).toEqual([])
  })

  test('finds socket files and ignores plain files', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'alpha'), { recursive: true })
    await mkdir(join(dir, 'beta'), { recursive: true })
    await mkdir(join(dir, 'nosock'), { recursive: true })
    await fakeServer(() => ({}), join(dir, 'alpha', 'herdr.sock'))
    await fakeServer(() => ({}), join(dir, 'beta', 'herdr.sock'))
    await writeFile(join(dir, 'nosock', 'herdr.sock'), 'regular file')

    const found = await discoverSessions(dir)
    expect(found.map((s) => s.name)).toEqual(['alpha', 'beta'])
  })

  test('liveness excludes sockets with no server behind them', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'live'), { recursive: true })
    await mkdir(join(dir, 'stale'), { recursive: true })
    const server = await fakeServer(() => ({ type: 'pong' }), join(dir, 'live', 'herdr.sock'))
    expect(server.listening).toBe(true)

    // A stopped herdr leaves its socket file behind, which is the case this
    // covers. Node's net.Server unlinks the path on close, so the stale file has
    // to be recreated by hand rather than by closing a server.
    await staleSocket(join(dir, 'stale', 'herdr.sock'))

    expect((await discoverSessions(dir)).map((s) => s.name)).toEqual(['live', 'stale'])
    expect((await discoverLiveSessions(dir)).map((s) => s.name)).toEqual(['live'])
  })
})

describe('AgentPoller', () => {
  async function twoSessions() {
    const dir = await tempDir()
    await mkdir(join(dir, 'alpha'), { recursive: true })
    await mkdir(join(dir, 'beta'), { recursive: true })
    return dir
  }

  test('merges agents from every session in a stable order', async () => {
    const dir = await twoSessions()
    await fakeServer(
      () => ({ agents: [rawAgent({ pane_id: 'w2:p1', workspace_id: 'w2' })] }),
      join(dir, 'beta', 'herdr.sock'),
    )
    await fakeServer(
      () => ({ agents: [rawAgent({ pane_id: 'w1:p1', workspace_id: 'w1' })] }),
      join(dir, 'alpha', 'herdr.sock'),
    )

    const poller = new AgentPoller({ sessionsDir: dir, onChange: () => {} })
    await poller.start()
    poller.stop()

    const agents = await poller.pollOnce()
    expect(agents.map((a) => `${a.session}/${a.paneId}`)).toEqual(['alpha/w1:p1', 'beta/w2:p1'])
  })

  test('sorts workspaces numerically, so w10 follows w2', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'one'), { recursive: true })
    await fakeServer(
      () => ({
        agents: [
          rawAgent({ pane_id: 'w10:p1', workspace_id: 'w10' }),
          rawAgent({ pane_id: 'w2:p1', workspace_id: 'w2' }),
        ],
      }),
      join(dir, 'one', 'herdr.sock'),
    )
    const poller = new AgentPoller({ sessionsDir: dir, onChange: () => {} })
    await poller.start()
    poller.stop()
    const agents = await poller.pollOnce()
    expect(agents.map((a) => a.workspaceId)).toEqual(['w2', 'w10'])
  })

  test('a dead session does not stop the others being reported', async () => {
    const dir = await twoSessions()
    await fakeServer(() => ({ agents: [rawAgent()] }), join(dir, 'alpha', 'herdr.sock'))
    await staleSocket(join(dir, 'beta', 'herdr.sock'))

    const errors: string[] = []
    const poller = new AgentPoller({
      sessionsDir: dir,
      onChange: () => {},
      onSessionError: (s) => errors.push(s),
    })
    await poller.start()
    poller.stop()

    const agents = await poller.pollOnce()
    expect(agents).toHaveLength(1)
    expect(agents[0]?.session).toBe('alpha')
    expect(errors).toContain('beta')
  })

  test('emits only when something rendered actually changed', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'one'), { recursive: true })
    let status = 'idle'
    // `focused` flips constantly in real herdr but is not rendered, so it must
    // not trigger a repaint.
    let focused = false
    await fakeServer(() => {
      focused = !focused
      return { agents: [rawAgent({ agent_status: status, focused })] }
    }, join(dir, 'one', 'herdr.sock'))

    const frames: Agent[][] = []
    const poller = new AgentPoller({
      sessionsDir: dir,
      intervalMs: 20,
      onChange: (agents) => {
        frames.push(agents)
      },
    })

    await poller.start()
    await new Promise((r) => setTimeout(r, 120))
    expect(frames).toHaveLength(1) // only the initial state

    status = 'working'
    await new Promise((r) => setTimeout(r, 120))
    poller.stop()
    await new Promise((r) => setTimeout(r, 40))

    expect(frames).toHaveLength(2)
    expect(frames[1]?.[0]?.status).toBe('working')
  })

  test('stop() halts polling', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'one'), { recursive: true })
    let calls = 0
    await fakeServer(() => {
      calls++
      return { agents: [] }
    }, join(dir, 'one', 'herdr.sock'))

    const poller = new AgentPoller({ sessionsDir: dir, intervalMs: 10, onChange: () => {} })
    await poller.start()
    await new Promise((r) => setTimeout(r, 60))
    poller.stop()

    // A poll already in flight when stop() lands is still allowed to finish, so
    // settle first and only then snapshot the count. Reading `calls` on the
    // same tick as stop() makes this test flaky, not the poller.
    await new Promise((r) => setTimeout(r, 40))
    const after = calls
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toBe(after)
  })

  test('no sessions is a quiet no-op, not a crash', async () => {
    const dir = await tempDir()
    const frames: Agent[][] = []
    const poller = new AgentPoller({
      sessionsDir: dir,
      onChange: (a) => {
        frames.push(a)
      },
    })
    await poller.start()
    poller.stop()
    expect(frames).toEqual([[]])
  })
})
