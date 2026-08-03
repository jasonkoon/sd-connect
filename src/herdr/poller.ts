/**
 * Polls every live herdr session and reports the merged set of agents.
 *
 * Polling, not subscribing. This is a measured decision: herdr's event stream
 * does not push agent status changes. Driving a real `idle -> working -> done`
 * transition produced zero pane events while a poller caught every step, and
 * `pane.updated` payloads were observed to be stale. The stream is also noisy
 * (~14 events/sec at idle, nearly all focus churn). `agent.list` costs ~0.84ms,
 * so polling is both simpler and more accurate here.
 *
 * Session discovery is rescanned periodically so sessions can come and go.
 */

import { agentKey, type Agent } from '../types.ts'
import { repoLabel } from '../model/repo.ts'
import { listAgents, type RawAgent } from './protocol.ts'
import { defaultSessionsDir, discoverSessions, type Session } from './sessions.ts'

export interface PollerOptions {
  /** How often to poll each session. */
  intervalMs?: number
  /** How often to rescan for new/removed sessions. */
  rescanMs?: number
  sessionsDir?: string
  /** Called whenever the merged agent set changes. */
  onChange: (agents: Agent[]) => void | Promise<void>
  /** Called when a session poll fails. Useful for logging, optional. */
  onSessionError?: (session: string, error: unknown) => void
}

const DEFAULT_INTERVAL_MS = 400
const DEFAULT_RESCAN_MS = 5000

function toAgent(session: string, raw: RawAgent): Agent {
  return {
    session,
    paneId: raw.pane_id,
    workspaceId: raw.workspace_id,
    status: raw.agent_status,
    cwd: raw.cwd ?? '',
    repo: repoLabel(raw.cwd),
    agent: raw.agent,
    focused: raw.focused,
  }
}

/**
 * Stable ordering: session name, then workspace, then pane.
 *
 * Deliberately not sorted by status. Keys must not shuffle under your fingers
 * just because an agent started working; status priority is only used later,
 * for deciding what to drop when there are more agents than keys.
 */
function compareAgents(a: Agent, b: Agent): number {
  return (
    a.session.localeCompare(b.session) ||
    a.workspaceId.localeCompare(b.workspaceId, undefined, { numeric: true }) ||
    a.paneId.localeCompare(b.paneId, undefined, { numeric: true })
  )
}

/** Signature of everything that affects rendering, for change detection. */
function signature(agents: Agent[]): string {
  return agents
    .map((a) => `${agentKey(a.session, a.paneId)}|${a.status}|${a.repo}|${a.session}`)
    .join('\n')
}

export class AgentPoller {
  #options: Required<Omit<PollerOptions, 'onChange' | 'onSessionError'>> &
    Pick<PollerOptions, 'onChange' | 'onSessionError'>
  #sessions: Session[] = []
  #lastSignature: string | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #rescanTimer: ReturnType<typeof setTimeout> | null = null
  #running = false
  /** Sessions that failed last poll, so we only log a transition once. */
  #failing = new Set<string>()

  constructor(options: PollerOptions) {
    this.#options = {
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
      rescanMs: options.rescanMs ?? DEFAULT_RESCAN_MS,
      sessionsDir: options.sessionsDir ?? defaultSessionsDir(),
      onChange: options.onChange,
      onSessionError: options.onSessionError,
    }
  }

  get sessions(): readonly Session[] {
    return this.#sessions
  }

  async start(): Promise<void> {
    if (this.#running) return
    this.#running = true
    await this.#rescan()
    await this.#tick()
    this.#scheduleRescan()
  }

  stop(): void {
    this.#running = false
    if (this.#timer) clearTimeout(this.#timer)
    if (this.#rescanTimer) clearTimeout(this.#rescanTimer)
    this.#timer = null
    this.#rescanTimer = null
  }

  /** Poll once and emit if anything changed. Exposed for tests and --once. */
  async pollOnce(): Promise<Agent[]> {
    const results = await Promise.all(
      this.#sessions.map(async (session) => {
        try {
          const raw = await listAgents(session.socketPath)
          if (this.#failing.delete(session.name)) {
            // Recovered; nothing to report, the change itself will show up.
          }
          return raw.map((r) => toAgent(session.name, r))
        } catch (error) {
          // A dead session is normal (herdr stopped, socket left behind).
          // Report once per failure streak so logs don't fill up.
          if (!this.#failing.has(session.name)) {
            this.#failing.add(session.name)
            this.#options.onSessionError?.(session.name, error)
          }
          return []
        }
      }),
    )

    return results.flat().sort(compareAgents)
  }

  async #tick(): Promise<void> {
    if (!this.#running) return

    try {
      const agents = await this.pollOnce()
      const sig = signature(agents)
      if (sig !== this.#lastSignature) {
        this.#lastSignature = sig
        await this.#options.onChange?.(agents)
      }
    } catch (error) {
      this.#options.onSessionError?.('(poll)', error)
    }

    if (!this.#running) return
    this.#timer = setTimeout(() => void this.#tick(), this.#options.intervalMs)
  }

  async #rescan(): Promise<void> {
    try {
      const found = await discoverSessions(this.#options.sessionsDir)
      // Drop remembered failures for sessions that no longer exist.
      const names = new Set(found.map((s) => s.name))
      for (const name of this.#failing) if (!names.has(name)) this.#failing.delete(name)
      this.#sessions = found
    } catch (error) {
      this.#options.onSessionError?.('(rescan)', error)
    }
  }

  #scheduleRescan(): void {
    if (!this.#running) return
    this.#rescanTimer = setTimeout(() => {
      void this.#rescan().then(() => this.#scheduleRescan())
    }, this.#options.rescanMs)
  }
}
