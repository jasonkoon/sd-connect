/**
 * Shared domain types.
 *
 * These mirror the subset of herdr's socket API that we actually render.
 * Keeping this deliberately narrow is what makes diffing cheap: `pane.updated`
 * fires on scroll and output, so we only want to compare fields that can
 * change what a key looks like.
 */

/** Agent lifecycle states, exactly as herdr's schema enumerates them. */
export const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value)
}

/**
 * Attention priority, ascending. Used only for overflow eviction: when there are
 * more agents than free keys, the lowest-priority ones get dropped first so that
 * `blocked` and `done` always survive.
 *
 * This is NOT the display sort order. Display order is stable (session, then
 * workspace) so keys don't shuffle under your fingers when a status changes.
 */
export const STATUS_PRIORITY: Record<AgentStatus, number> = {
  unknown: 0,
  idle: 1,
  working: 2,
  done: 3,
  blocked: 4,
}

/** One agent in one herdr session, normalized from `agent.list` / `pane.updated`. */
export interface Agent {
  /** Herdr session name, e.g. "zephyr". */
  session: string
  /** Pane id within that session, e.g. "w5:p1". Unique per session, not globally. */
  paneId: string
  /** Workspace id, e.g. "w5". Part of the stable sort key. */
  workspaceId: string
  status: AgentStatus
  /** Working directory of the agent pane. */
  cwd: string
  /** Git repo root basename, resolved from cwd. Falls back to cwd basename. */
  repo: string
  /** Agent program name, e.g. "pi". Not rendered in phase 1, kept for later. */
  agent: string | null
  focused: boolean
  /**
   * Deep link that focuses the agent's exact Warp tab/pane, e.g.
   * "warp://session/<uuid>". Warp exports it as WARP_FOCUS_URL into every
   * shell, so agents started inside a Warp tab carry it in their process
   * environment. Only set for Warp-hosted agents.
   */
  focusUrl?: string
}

/**
 * Globally unique agent key. Pane ids are only unique within a session, so every
 * cross-session map must be keyed by this.
 */
export function agentKey(session: string, paneId: string): string {
  return `${session}:${paneId}`
}

/** Fields that affect the rendered tile. Used to skip no-op repaints. */
export function renderIdentity(agent: Agent): string {
  return `${agent.status}\u0000${agent.repo}\u0000${agent.session}`
}

/**
 * What occupies a single Stream Deck key.
 *
 * `empty.pinned` distinguishes a key held open by a pin whose agent is not
 * currently running from a key that is simply unused. A reserved-but-dark key
 * is the whole point of pinning, so it is drawn slightly differently.
 */
export type Slot =
  | { kind: 'empty'; pinned: boolean }
  | { kind: 'agent'; agent: Agent }
  | { kind: 'overflow'; count: number }

export const EMPTY_SLOT: Slot = { kind: 'empty', pinned: false }
export const PINNED_EMPTY_SLOT: Slot = { kind: 'empty', pinned: true }
