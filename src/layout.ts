/**
 * Assign agents to the 15 physical keys.
 *
 * Pure functions over a snapshot: no I/O, no device, no clock. That is what
 * makes the interesting behaviour (pins, overflow, eviction) testable without
 * hardware or a running herdr.
 *
 * The rules, in order:
 *   1. Pinned agents take their configured key.
 *   2. Everyone else flows into the free keys in stable order.
 *   3. If they do not all fit, drop the least interesting ones and show a
 *      "+N more" tile on the last key.
 *
 * Ordering is stable (session, workspace, pane) rather than status-sorted, so a
 * key does not move just because an agent changed state. Status only decides
 * who gets dropped when space runs out.
 */

import {
  agentKey,
  EMPTY_SLOT,
  PINNED_EMPTY_SLOT,
  STATUS_PRIORITY,
  type Agent,
  type MacroConfig,
  type Slot,
} from './types.ts'

/** A pin ties one agent, identified by session + cwd, to one key. */
export interface Pin {
  key: number
  session: string
  cwd: string
}

export interface LayoutOptions {
  keyCount: number
  pins?: readonly Pin[]
  macros?: readonly MacroConfig[]
}

export interface LayoutResult {
  slots: Slot[]
  /** Agents that did not fit. Empty when everything is shown. */
  dropped: Agent[]
}

/** Normalise a cwd for comparison: trailing slashes should not matter. */
function normalizeCwd(cwd: string): string {
  if (cwd.length > 1 && cwd.endsWith('/')) return cwd.replace(/\/+$/, '')
  return cwd
}

function pinMatches(pin: Pin, agent: Agent): boolean {
  return pin.session === agent.session && normalizeCwd(pin.cwd) === normalizeCwd(agent.cwd)
}

/**
 * Drop the least interesting agents until `count` remain.
 *
 * Eviction is by ascending status priority (unknown < idle < working < done <
 * blocked), so agents that want your attention survive. Ties break by reverse
 * stable order, meaning the last agent in display order goes first — that keeps
 * the earlier keys steady as the tail churns.
 */
function evictTo(agents: Agent[], count: number): { kept: Agent[]; dropped: Agent[] } {
  if (agents.length <= count) return { kept: agents, dropped: [] }
  if (count <= 0) return { kept: [], dropped: [...agents] }

  const ranked = agents.map((agent, index) => ({ agent, index }))
  ranked.sort((a, b) => {
    const priority = STATUS_PRIORITY[a.agent.status] - STATUS_PRIORITY[b.agent.status]
    if (priority !== 0) return priority
    return b.index - a.index
  })

  const dropCount = agents.length - count
  const droppedIndices = new Set(ranked.slice(0, dropCount).map((r) => r.index))

  const kept: Agent[] = []
  const dropped: Agent[] = []
  agents.forEach((agent, index) => {
    if (droppedIndices.has(index)) dropped.push(agent)
    else kept.push(agent)
  })
  return { kept, dropped }
}

/**
 * Build the key frame.
 *
 * `agents` is expected in stable display order (the poller sorts it).
 */
export function layout(agents: readonly Agent[], options: LayoutOptions): LayoutResult {
  const { keyCount } = options
  const slots: Slot[] = new Array<Slot>(keyCount).fill(EMPTY_SLOT)
  if (keyCount <= 0) return { slots: [], dropped: [...agents] }

  // 1. Pins and macros. Only in-range keys count; a pin pointing off the end
  // of the deck is ignored rather than throwing, since the config is
  // hand-edited.
  const pins = (options.pins ?? []).filter((p) => Number.isInteger(p.key) && p.key >= 0 && p.key < keyCount)
  const macros = (options.macros ?? []).filter(
    (m) => Number.isInteger(m.key) && m.key >= 0 && m.key < keyCount,
  )

  const reservedKeys = new Set<number>()
  const claimed = new Set<string>()

  // Macros first: a macro key is a hard reservation (like a pin) and its
  // action, not the agent list, decides what the key shows. First listed for a
  // key wins, so a duplicate or a pin/macro clash is predictable rather than
  // order-dependent.
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

  // 3. Fit, reserving the last free key for the overflow tile if needed.
  let { kept, dropped } = evictTo(rest, freeKeys.length)
  let overflowKey: number | null = null

  if (dropped.length > 0 && freeKeys.length > 0) {
    // The overflow tile costs a key, so one more agent has to go.
    overflowKey = freeKeys[freeKeys.length - 1] as number
    ;({ kept, dropped } = evictTo(rest, freeKeys.length - 1))
  }

  const targets = overflowKey === null ? freeKeys : freeKeys.slice(0, -1)
  kept.forEach((agent, i) => {
    const key = targets[i]
    if (key !== undefined) slots[key] = { kind: 'agent', agent }
  })

  if (overflowKey !== null) {
    slots[overflowKey] = { kind: 'overflow', count: dropped.length }
  }

  return { slots, dropped }
}
