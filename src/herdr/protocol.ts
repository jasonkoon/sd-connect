/**
 * herdr socket protocol: newline-delimited JSON over a Unix socket.
 *
 * Important: a request connection is single-shot. The server writes one
 * response and closes; writing a second request to the same socket gets EPIPE.
 * So `request()` opens a connection, asks one thing, and lets it close.
 * Measured cost including connect: ~0.84ms.
 */

import { connect } from 'node:net'
import { isAgentStatus, type AgentStatus } from '../types.ts'

/** Shape of an agent entry in an `agent.list` reply, as far as we rely on it. */
export interface RawAgent {
  pane_id: string
  workspace_id: string
  agent_status: AgentStatus
  cwd: string | null
  agent: string | null
  focused: boolean
}

export class HerdrError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'HerdrError'
    this.code = code
  }
}

export interface RequestOptions {
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 3000

/**
 * Send one request and resolve its `result`.
 *
 * Rejects on socket error, timeout, malformed JSON, or an `error` reply.
 */
export function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`herdr request '${method}' timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 'sd-connect', method, params })}\n`)
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return

      const line = buffer.slice(0, newline)
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        finish(() => reject(new Error(`herdr sent malformed JSON for '${method}'`)))
        return
      }

      const envelope = parsed as { result?: unknown; error?: { code?: string; message?: string } }
      if (envelope.error) {
        const { code = 'unknown', message = 'no message' } = envelope.error
        finish(() => reject(new HerdrError(code, message)))
        return
      }
      finish(() => resolve(envelope.result))
    })

    socket.on('error', (err) => {
      finish(() => reject(err))
    })

    socket.on('close', () => {
      finish(() => reject(new Error(`herdr closed the connection during '${method}'`)))
    })
  })
}

/** Extract the agents array from an `agent.list` result, ignoring junk entries. */
export function parseAgentList(result: unknown): RawAgent[] {
  const agents = (result as { agents?: unknown })?.agents
  if (!Array.isArray(agents)) {
    throw new Error('agent.list reply had no agents array')
  }

  const out: RawAgent[] = []
  for (const entry of agents) {
    if (typeof entry !== 'object' || entry === null) continue
    const a = entry as Record<string, unknown>
    if (typeof a.pane_id !== 'string' || typeof a.workspace_id !== 'string') continue

    out.push({
      pane_id: a.pane_id,
      workspace_id: a.workspace_id,
      // Anything unrecognised becomes 'unknown' rather than throwing: a new
      // status in a future herdr should degrade, not take the daemon down.
      agent_status: isAgentStatus(a.agent_status) ? a.agent_status : 'unknown',
      cwd: typeof a.cwd === 'string' ? a.cwd : null,
      agent: typeof a.agent === 'string' ? a.agent : null,
      focused: a.focused === true,
    })
  }
  return out
}

/** `agent.list` for one session. */
export async function listAgents(socketPath: string, options?: RequestOptions): Promise<RawAgent[]> {
  return parseAgentList(await request(socketPath, 'agent.list', {}, options))
}
