import { afterEach, describe, test } from 'node:test'
import { createServer, type Server } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from './expect.ts'
import { focusAgent } from './focus.ts'
import { parseConfig } from './config.ts'
import type { Agent } from './types.ts'

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    session: 'zephyr',
    paneId: 'w2:p1',
    workspaceId: 'w2',
    status: 'idle',
    cwd: '/dev/portal',
    repo: 'portal',
    agent: 'pi',
    focused: false,
    ...overrides,
  }
}

/** Fake herdr that records the focus requests it receives. */
async function focusServer(opts: { fail?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sd-focus-'))
  const socketPath = join(dir, 'herdr.sock')
  const received: Array<{ method: string; params: unknown }> = []

  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const { method, params, id } = JSON.parse(chunk.toString().trim())
      received.push({ method, params })
      const body = opts.fail
        ? { id, error: { code: 'not_found', message: 'no such pane' } }
        : { id, result: { type: 'agent_focus' } }
      socket.end(`${JSON.stringify(body)}\n`)
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(socketPath, r))
  return { socketPath, received }
}

describe('focusAgent', () => {
  test('sends agent.focus targeting the pane', async () => {
    const { socketPath, received } = await focusServer()
    const result = await focusAgent(agent(), socketPath, { raiseWindow: false })

    expect(result.focused).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]?.method).toBe('agent.focus')
    // agent.focus moves workspace, tab and pane together, so the pane id is
    // the only target needed.
    expect(received[0]?.params).toEqual({ target: 'w2:p1' })
  })

  test('reports failure instead of throwing when herdr rejects', async () => {
    const { socketPath } = await focusServer({ fail: true })
    const result = await focusAgent(agent(), socketPath, { raiseWindow: false })
    expect(result.focused).toBe(false)
    expect(result.note).toMatch(/no such pane/)
  })

  test('a dead socket is reported, not thrown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sd-focus-'))
    const result = await focusAgent(agent(), join(dir, 'absent.sock'), { raiseWindow: false })
    expect(result.focused).toBe(false)
    expect(result.raised).toBe(false)
  })

  test('still focuses when the window cannot be raised', async () => {
    const { socketPath, received } = await focusServer()
    // A process name that does not exist stands in for a renamed window,
    // a different terminal, or Accessibility being switched off.
    const result = await focusAgent(agent(), socketPath, {
      terminalProcess: 'definitely-not-a-real-process',
    })
    expect(result.raised).toBe(false)
    expect(result.focused).toBe(true)
    expect(received).toHaveLength(1)
  })
})

describe('config: raise_window', () => {
  test('defaults to on', () => {
    expect(parseConfig('').config.raiseWindow).toBe(true)
  })

  test('can be turned off', () => {
    const { config, warnings } = parseConfig('raise_window = false')
    expect(config.raiseWindow).toBe(false)
    expect(warnings).toEqual([])
  })

  test('a non-boolean is warned about and ignored', () => {
    const { config, warnings } = parseConfig('raise_window = "yes"')
    expect(config.raiseWindow).toBe(true)
    expect(warnings[0]).toMatch(/raise_window/)
  })
})
