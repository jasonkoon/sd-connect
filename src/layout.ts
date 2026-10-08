/**
 * Assign agents to physical keys.
 *
 * Pure functions over a snapshot: no I/O, no device, no clock. That is what
 * makes the interesting behaviour (pins, pages, macros) testable without
 * hardware or a running herdr.
 *
 * Page 1 is the home page: pinned agents take their configured keys, macros
 * theirs, and everyone else flows into the free keys in stable order. When
 * agents remain, the last free key becomes a "+N" tile that opens the next
 * page; later pages fill their keys from the remaining agents in the same
 * stable order and carry a back tile in the first free key.
 *
 * Ordering is stable (session, workspace, pane) rather than status-sorted, so a
 * key does not move just because an agent changed state. Eviction is gone: with
 * pages, no agent is ever dropped from view.
 */

import {
  agentKey,
  EMPTY_SLOT,
  PINNED_EMPTY_SLOT,
  type Agent,
  type MacroConfig,
  type Slot,
} from './types.ts'
import { repoLabel } from './model/repo.ts'

/** A pin ties one agent, identified by session + cwd, to one key. */
export interface Pin {
  key: number
  session: string
  cwd: string
}

/** A pin whose session is "*" matches any session: repo is the identity. */
const SESSION_WILDCARD = '*'

export interface LayoutOptions {
  keyCount: number
  pins?: readonly Pin[]
  macros?: readonly MacroConfig[]
  /** Which page to lay out. Zero-based; page 0 is the home page. */
  page?: number
}

export interface LayoutResult {
  slots: Slot[]
  /** Total pages the current agents need, including this one. */
  pageCount: number
}

/** Normalise a cwd for comparison: trailing slashes should not matter. */
function normalizeCwd(cwd: string): string {
  if (cwd.length > 1 && cwd.endsWith('/')) return cwd.replace(/\/+$/, '')
  return cwd
}

function pinMatches(pin: Pin, agent: Agent): boolean {
  if (pin.session !== SESSION_WILDCARD && pin.session !== agent.session) return false
  if (normalizeCwd(pin.cwd) === normalizeCwd(agent.cwd)) return true
  // An agent's cwd drifts when it restarts inside a subdirectory, but the
  // repo it works on — what a pin actually names — is stable. The repo label
  // of the configured cwd is computed once and cached.
  return repoLabel(pin.cwd) === agent.repo
}

/**
 * The keys not owned by a pin or macro.
 *
 * A hand-edited config can list two pins for one key or a key off the end of
 * the deck; out-of-range entries are dropped and duplicates collapse, because
 * layout resolves the same way and the two must agree on what "free" means.
 */
function freeKeyIndices(keyCount: number, pins: readonly Pin[], macros: readonly MacroConfig[]): number[] {
  const reserved = new Set<number>()
  for (const macro of macros) {
    if (Number.isInteger(macro.key) && macro.key >= 0 && macro.key < keyCount) reserved.add(macro.key)
  }
  for (const pin of pins) {
    if (Number.isInteger(pin.key) && pin.key >= 0 && pin.key < keyCount) reserved.add(pin.key)
  }
  const free: number[] = []
  for (let i = 0; i < keyCount; i++) {
    if (!reserved.has(i)) free.push(i)
  }
  return free
}

/** Agents not placed on a pinned key, in display order. */
function autoAgents(agents: readonly Agent[], pins: readonly Pin[], keyCount: number): Agent[] {
  const inRange = pins.filter((p) => Number.isInteger(p.key) && p.key >= 0 && p.key < keyCount)
  const claimed = new Set<string>()
  for (const pin of inRange) {
    const match = agents.find((a) => !claimed.has(agentKey(a.session, a.paneId)) && pinMatches(pin, a))
    if (match) claimed.add(agentKey(match.session, match.paneId))
  }
  return agents.filter((a) => !claimed.has(agentKey(a.session, a.paneId)))
}

/**
 * How many pages `auto` agents need across `free` keys.
 *
 * Every page that has a successor spends its last free key on the "+N" tile,
 * and every page after the first spends its first free key on the back tile, so
 * both cost capacity: page 0 holds free-1, middle pages free-2, the last page
 * free-1 again. A deck with fewer than 3 free keys cannot host back + forward
 * + an agent, so it does not paginate: it shows what fits and the "+N" tile
 * reports the rest as genuinely not shown.
 */
function pagesFor(auto: readonly Agent[], free: readonly number[]): number {
  const n = free.length
  if (auto.length === 0 || n < 3) return 1
  if (auto.length <= n) return 1
  const remaining = auto.length - (n - 1)
  const midCap = n - 2
  const lastCap = n - 1
  if (remaining <= lastCap) return 2
  return 2 + Math.ceil((remaining - lastCap) / midCap)
}

export function pageCount(agents: readonly Agent[], options: LayoutOptions): number {
  const { keyCount } = options
  if (keyCount <= 0) return 1
  const free = freeKeyIndices(keyCount, options.pins ?? [], options.macros ?? [])
  return pagesFor(autoAgents(agents, options.pins ?? [], keyCount), free)
}

/**
 * Build the key frame for one page.
 *
 * `agents` is expected in stable display order (the poller sorts it).
 */
export function layout(agents: readonly Agent[], options: LayoutOptions): LayoutResult {
  const { keyCount } = options
  const slots: Slot[] = new Array<Slot>(keyCount).fill(EMPTY_SLOT)
  if (keyCount <= 0) return { slots: [], pageCount: 1 }

  // 1. Macros, then pins. A macro key is a hard reservation (like a pin) and
  // its action, not the agent list, decides what the key shows. First listed
  // for a key wins, so a duplicate or a pin/macro clash is predictable rather
  // than order-dependent.
  const macros = (options.macros ?? []).filter(
    (m) => Number.isInteger(m.key) && m.key >= 0 && m.key < keyCount,
  )
  const pins = (options.pins ?? []).filter((p) => Number.isInteger(p.key) && p.key >= 0 && p.key < keyCount)

  const reservedKeys = new Set<number>()
  const claimed = new Set<string>()

  for (const macro of macros) {
    if (reservedKeys.has(macro.key)) continue
    reservedKeys.add(macro.key)
    slots[macro.key] = {
      kind: 'macro',
      label: macro.label,
      color: macro.color ?? null,
      action: macro.action,
    }
  }

  for (const pin of pins) {
    // First pin listed for a key wins, and a pin never displaces a macro.
    if (reservedKeys.has(pin.key)) continue
    reservedKeys.add(pin.key)

    // First unclaimed matching agent. Two panes in the same session and cwd is
    // legal; the extras simply flow into the auto region.
    const match = agents.find((a) => !claimed.has(agentKey(a.session, a.paneId)) && pinMatches(pin, a))

    if (match) {
      claimed.add(agentKey(match.session, match.paneId))
      slots[pin.key] = { kind: 'agent', agent: match }
    } else {
      // Reserved but dark: the key is held for that agent.
      slots[pin.key] = PINNED_EMPTY_SLOT
    }
  }

  // 2. Everything not consumed by a pin, in the order given.
  const rest = agents.filter((a) => !claimed.has(agentKey(a.session, a.paneId)))

  const freeKeys: number[] = []
  for (let i = 0; i < keyCount; i++) {
    if (!reservedKeys.has(i)) freeKeys.push(i)
  }

  // 3. Pages. The requested page is clamped rather than erroring: the poll
  // that arrives just after the agents shrink can name a page that no longer
  // exists, and rendering the last page beats going dark.
  const pages = pagesFor(rest, freeKeys)
  const page = Math.min(Math.max(options.page ?? 0, 0), pages - 1)

  if (rest.length === 0 || freeKeys.length < 3) {
    // Without pagination the overflow tile, if any, is the last free key and
    // everything beyond it is simply not shown.
    if (rest.length > freeKeys.length && freeKeys.length > 0) {
      const navKey = freeKeys[freeKeys.length - 1]
      const targets = freeKeys.slice(0, -1)
      rest.slice(0, targets.length).forEach((agent, i) => {
        const key = targets[i]
        if (key !== undefined) slots[key] = { kind: 'agent', agent }
      })
      if (navKey !== undefined) slots[navKey] = { kind: 'overflow', count: rest.length - targets.length }
    } else {
      rest.forEach((agent, i) => {
        const key = freeKeys[i]
        if (key !== undefined) slots[key] = { kind: 'agent', agent }
      })
    }
    return { slots, pageCount: 1 }
  }

  const n = freeKeys.length
  const morePages = page < pages - 1
  // Page 0 is also the last page when there is only one, so it takes the
  // last page's full capacity unless something spills over.
  const capacity = page === 0 ? (morePages ? n - 1 : n) : morePages ? n - 2 : n - 1
  const start = page === 0 ? 0 : n - 1 + (page - 1) * (n - 2)
  const agentTargets = page === 0
    ? morePages
      ? freeKeys.slice(0, n - 1)
      : freeKeys
    : morePages
      ? freeKeys.slice(1, n - 1)
      : freeKeys.slice(1)

  rest.slice(start, start + capacity).forEach((agent, i) => {
    const key = agentTargets[i]
    if (key !== undefined) slots[key] = { kind: 'agent', agent }
  })

  if (morePages && page === 0) {
    const navKey = freeKeys[n - 1]
    if (navKey !== undefined) slots[navKey] = { kind: 'overflow', count: rest.length - capacity }
  } else if (page > 0) {
    const navKey = freeKeys[0]
    if (navKey !== undefined) slots[navKey] = { kind: 'page', direction: 'back' }
    if (morePages) {
      const fwdKey = freeKeys[n - 1]
      if (fwdKey !== undefined) {
        slots[fwdKey] = { kind: 'overflow', count: rest.length - start - capacity }
      }
    }
  }

  return { slots, pageCount: pages }
}
