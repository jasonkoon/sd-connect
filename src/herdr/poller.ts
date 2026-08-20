import { agentKey, type Agent } from '../types.ts'
import { repoLabel } from '../model/repo.ts'
import { WarpAgentScanner } from '../warp/discover.ts'
import { listAgents, type RawAgent } from './protocol.ts'
import { defaultSessionsDir, discoverSessions, type Session } from './sessions.ts'

export interface PollerOptions {
  intervalMs?: number
  rescanMs?: number
  sessionsDir?: string
  onChange: (agents: Agent[]) => void | Promise<void>
  onSessionError?: (session: string, error: unknown) => void
  warpScanner?: { scan: () => Promise<Agent[]> }
  includeWarp?: boolean
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

function compareAgents(a: Agent, b: Agent): number {
  return (
    a.session.localeCompare(b.session) ||
    a.workspaceId.localeCompare(b.workspaceId, undefined, { numeric: true }) ||
    a.paneId.localeCompare(b.paneId, undefined, { numeric: true })
  )
}

function signature(agents: Agent[]): string {
  return agents
    .map((a) => `${agentKey(a.session, a.paneId)}|${a.status}|${a.repo}|${a.session}`)
    .join('\n')
}

export class AgentPoller {
  #options: Required<Omit<PollerOptions, 'onChange' | 'onSessionError' | 'warpScanner' | 'includeWarp'>> &
    Pick<PollerOptions, 'onChange' | 'onSessionError'>
  #sessions: Session[] = []
  #lastSignature: string | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #rescanTimer: ReturnType<typeof setTimeout> | null = null
  #running = false
  #failing = new Set<string>()
  #warpScanner: { scan: () => Promise<Agent[]> } | null

  constructor(options: PollerOptions) {
    this.#options = {
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
      rescanMs: options.rescanMs ?? DEFAULT_RESCAN_MS,
      sessionsDir: options.sessionsDir ?? defaultSessionsDir(),
      onChange: options.onChange,
      onSessionError: options.onSessionError,
    }
    this.#warpScanner =
      options.includeWarp === false ? null : (options.warpScanner ?? new WarpAgentScanner())
  }

  get sessions(): readonly Session[] {
    return this.#sessions
  }

  socketFor(session: string): string | null {
    return this.#sessions.find((s) => s.name === session)?.socketPath ?? null
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

  async pollOnce(): Promise<Agent[]> {
    const herdrResults = await Promise.all(
      this.#sessions.map(async (session) => {
        try {
          const raw = await listAgents(session.socketPath)
          if (this.#failing.delete(session.name)) {
          }
          return raw.map((r) => toAgent(session.name, r))
        } catch (error) {
          if (!this.#failing.has(session.name)) {
            this.#failing.add(session.name)
            this.#options.onSessionError?.(session.name, error)
          }
          return []
        }
      }),
    )

    let warpAgents: Agent[] = []
    if (this.#warpScanner) {
      try {
        warpAgents = await this.#warpScanner.scan()
      } catch (error) {
        this.#options.onSessionError?.('warp', error)
      }
    }

    return [...herdrResults.flat(), ...warpAgents].sort(compareAgents)
  }

  async #tick(): Promise<void> {
    if (!this.#running) return

    try {
      const agents = await this.pollOnce()
      if (!this.#running) return
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
