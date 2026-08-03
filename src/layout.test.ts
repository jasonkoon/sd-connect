import { describe, test } from 'node:test'
import { expect } from './expect.ts'
import { layout, type Pin } from './layout.ts'
import { parseConfig } from './config.ts'
import type { Agent, AgentStatus, Slot } from './types.ts'

function agent(
  repo: string,
  opts: { session?: string; status?: AgentStatus; pane?: string; cwd?: string } = {},
): Agent {
  const session = opts.session ?? 'zephyr'
  const pane = opts.pane ?? `w1:p1`
  return {
    session,
    paneId: pane,
    workspaceId: pane.split(':')[0] ?? 'w1',
    status: opts.status ?? 'idle',
    cwd: opts.cwd ?? `/dev/${repo}`,
    repo,
    agent: 'pi',
    focused: false,
  }
}

/** Compact view of a frame: repo name per key, '.' for empty. */
function shape(slots: readonly Slot[]): string[] {
  return slots.map((s) =>
    s.kind === 'agent' ? s.agent.repo : s.kind === 'overflow' ? `+${s.count}` : '.',
  )
}

describe('layout: auto-flow', () => {
  test('fills keys in the order given', () => {
    const agents = [agent('a'), agent('b', { pane: 'w2:p1' }), agent('c', { pane: 'w3:p1' })]
    const { slots, dropped } = layout(agents, { keyCount: 5 })
    expect(shape(slots)).toEqual(['a', 'b', 'c', '.', '.'])
    expect(dropped).toEqual([])
  })

  test('no agents leaves every key blank', () => {
    const { slots } = layout([], { keyCount: 3 })
    expect(shape(slots)).toEqual(['.', '.', '.'])
  })

  test('exactly filling the deck does not create an overflow tile', () => {
    const agents = Array.from({ length: 5 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const { slots, dropped } = layout(agents, { keyCount: 5 })
    expect(shape(slots)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
    expect(dropped).toEqual([])
  })
})

describe('layout: overflow', () => {
  test('reserves the last key and reports the right count', () => {
    // 7 agents, 5 keys: 4 shown + 1 overflow tile covering the other 3.
    const agents = Array.from({ length: 7 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const { slots, dropped } = layout(agents, { keyCount: 5 })
    expect(slots[4]).toEqual({ kind: 'overflow', count: 3 })
    expect(dropped).toHaveLength(3)
    // The count on the tile must match what was actually dropped.
    const overflow = slots[4] as { kind: 'overflow'; count: number }
    expect(overflow.count).toBe(dropped.length)
  })

  test('keeps blocked and done, drops idle and unknown first', () => {
    const agents = [
      agent('idle1', { status: 'idle', pane: 'w1:p1' }),
      agent('unknown1', { status: 'unknown', pane: 'w2:p1' }),
      agent('blocked1', { status: 'blocked', pane: 'w3:p1' }),
      agent('working1', { status: 'working', pane: 'w4:p1' }),
      agent('done1', { status: 'done', pane: 'w5:p1' }),
    ]
    // 3 keys: 2 agents + overflow tile.
    const { slots, dropped } = layout(agents, { keyCount: 3 })
    const shown = shape(slots).filter((s) => s !== '.' && !s.startsWith('+'))
    expect(shown).toEqual(['blocked1', 'done1'])
    expect(dropped.map((d) => d.repo).sort()).toEqual(['idle1', 'unknown1', 'working1'])
  })

  test('survivors stay in display order, not priority order', () => {
    // blocked appears last but must not jump to the front.
    const agents = [
      agent('aaa', { status: 'done', pane: 'w1:p1' }),
      agent('bbb', { status: 'idle', pane: 'w2:p1' }),
      agent('zzz', { status: 'blocked', pane: 'w3:p1' }),
    ]
    const { slots } = layout(agents, { keyCount: 3 })
    expect(shape(slots)).toEqual(['aaa', 'bbb', 'zzz'])
  })

  test('among equal statuses the later agent is dropped', () => {
    const agents = [
      agent('first', { status: 'idle', pane: 'w1:p1' }),
      agent('second', { status: 'idle', pane: 'w2:p1' }),
      agent('third', { status: 'idle', pane: 'w3:p1' }),
    ]
    const { slots, dropped } = layout(agents, { keyCount: 2 })
    expect(shape(slots)).toEqual(['first', '+2'])
    expect(dropped.map((d) => d.repo)).toEqual(['second', 'third'])
  })

  test('a single key with several agents still shows a sane frame', () => {
    const agents = [agent('a'), agent('b', { pane: 'w2:p1' })]
    const { slots, dropped } = layout(agents, { keyCount: 1 })
    expect(slots[0]).toEqual({ kind: 'overflow', count: 2 })
    expect(dropped).toHaveLength(2)
  })
})

describe('layout: pins', () => {
  const pin = (key: number, session: string, cwd: string): Pin => ({ key, session, cwd })

  test('places a pinned agent on its key', () => {
    const agents = [agent('a', { cwd: '/dev/a' }), agent('b', { pane: 'w2:p1', cwd: '/dev/b' })]
    const { slots } = layout(agents, { keyCount: 5, pins: [pin(3, 'zephyr', '/dev/b')] })
    expect(shape(slots)).toEqual(['a', '.', '.', 'b', '.'])
  })

  test('holds the key dark when the pinned agent is absent', () => {
    const { slots } = layout([agent('a')], { keyCount: 3, pins: [pin(1, 'zephyr', '/dev/gone')] })
    expect(slots[1]).toEqual({ kind: 'empty', pinned: true })
    // and the unpinned agent must not be placed there
    expect(shape(slots)).toEqual(['a', '.', '.'])
  })

  test('matches on session as well as cwd', () => {
    const agents = [
      agent('same', { session: 'alpha', cwd: '/dev/same' }),
      agent('same', { session: 'beta', cwd: '/dev/same', pane: 'w2:p1' }),
    ]
    const { slots } = layout(agents, { keyCount: 3, pins: [pin(0, 'beta', '/dev/same')] })
    const first = slots[0] as { kind: 'agent'; agent: Agent }
    expect(first.agent.session).toBe('beta')
  })

  test('ignores a trailing slash difference', () => {
    const agents = [agent('a', { cwd: '/dev/a' })]
    const { slots } = layout(agents, { keyCount: 2, pins: [pin(1, 'zephyr', '/dev/a/')] })
    expect(shape(slots)).toEqual(['.', 'a'])
  })

  test('a pinned agent is not also shown in the auto region', () => {
    const agents = [agent('a', { cwd: '/dev/a' })]
    const { slots } = layout(agents, { keyCount: 3, pins: [pin(2, 'zephyr', '/dev/a')] })
    expect(shape(slots)).toEqual(['.', '.', 'a'])
  })

  test('two panes sharing session and cwd: one pins, the other flows', () => {
    const agents = [
      agent('dup', { cwd: '/dev/dup', pane: 'w1:p1' }),
      agent('dup', { cwd: '/dev/dup', pane: 'w1:p2' }),
    ]
    const { slots, dropped } = layout(agents, { keyCount: 3, pins: [pin(2, 'zephyr', '/dev/dup')] })
    expect(shape(slots)).toEqual(['dup', '.', 'dup'])
    expect(dropped).toEqual([])
  })

  test('out-of-range pins are ignored rather than fatal', () => {
    const agents = [agent('a', { cwd: '/dev/a' })]
    const { slots } = layout(agents, {
      keyCount: 2,
      pins: [pin(99, 'zephyr', '/dev/a'), pin(-1, 'zephyr', '/dev/a')],
    })
    expect(shape(slots)).toEqual(['a', '.'])
  })

  test('duplicate pins for one key: the first wins', () => {
    const agents = [agent('a', { cwd: '/dev/a' }), agent('b', { cwd: '/dev/b', pane: 'w2:p1' })]
    const { slots } = layout(agents, {
      keyCount: 3,
      pins: [pin(0, 'zephyr', '/dev/b'), pin(0, 'zephyr', '/dev/a')],
    })
    expect(shape(slots)[0]).toBe('b')
  })

  test('pins reduce the space available before overflow kicks in', () => {
    const agents = [
      agent('pinned', { cwd: '/dev/pinned', pane: 'w1:p1' }),
      agent('x', { pane: 'w2:p1', status: 'idle' }),
      agent('y', { pane: 'w3:p1', status: 'idle' }),
      agent('z', { pane: 'w4:p1', status: 'idle' }),
    ]
    // 3 keys, one reserved by a pin -> 2 free -> 1 agent + overflow.
    const { slots, dropped } = layout(agents, {
      keyCount: 3,
      pins: [pin(1, 'zephyr', '/dev/pinned')],
    })
    expect(shape(slots)).toEqual(['x', 'pinned', '+2'])
    expect(dropped.map((d) => d.repo)).toEqual(['y', 'z'])
  })

  test('every key pinned leaves nowhere for others to flow', () => {
    const agents = [agent('a', { cwd: '/dev/a' }), agent('b', { cwd: '/dev/b', pane: 'w2:p1' })]
    const { slots, dropped } = layout(agents, { keyCount: 1, pins: [pin(0, 'zephyr', '/dev/a')] })
    expect(shape(slots)).toEqual(['a'])
    // 'b' has nowhere to go and there is no free key for an overflow tile.
    expect(dropped.map((d) => d.repo)).toEqual(['b'])
  })
})

describe('config', () => {
  test('empty config yields defaults with no complaints', () => {
    const { config, warnings } = parseConfig('')
    expect(warnings).toEqual([])
    expect(config.brightness).toBe(70)
    expect(config.pins).toEqual([])
  })

  test('reads brightness, interval, colours and pins', () => {
    const { config, warnings } = parseConfig(`
brightness = 45
poll_interval_ms = 250

[colors]
blocked = "#ff0000"

[[pins]]
key = 0
session = "zephyr"
cwd = "/dev/portal"
`)
    expect(warnings).toEqual([])
    expect(config.brightness).toBe(45)
    expect(config.pollIntervalMs).toBe(250)
    expect(config.theme.statusColors.blocked).toBe('#ff0000')
    expect(config.pins).toEqual([{ key: 0, session: 'zephyr', cwd: '/dev/portal' }])
  })

  test('a bad value is warned about and ignored, not fatal', () => {
    const { config, warnings } = parseConfig('brightness = 500')
    expect(config.brightness).toBe(70)
    expect(warnings[0]).toMatch(/brightness/)
  })

  test('malformed TOML falls back to defaults', () => {
    const { config, warnings } = parseConfig('this is not = = toml')
    expect(config.brightness).toBe(70)
    expect(warnings[0]).toMatch(/could not parse/)
  })

  test('rejects a non-hex colour and an unknown status name', () => {
    const { warnings } = parseConfig(`
[colors]
idle = "green"
sideways = "#001122"
`)
    expect(warnings).toHaveLength(2)
    expect(warnings.join(' ')).toMatch(/#rrggbb/)
    expect(warnings.join(' ')).toMatch(/unknown status/)
  })

  test('skips an incomplete pin but keeps the valid ones', () => {
    const { config, warnings } = parseConfig(`
[[pins]]
key = 0
session = "zephyr"

[[pins]]
key = 1
session = "zephyr"
cwd = "/dev/ok"
`)
    expect(config.pins).toEqual([{ key: 1, session: 'zephyr', cwd: '/dev/ok' }])
    expect(warnings[0]).toMatch(/cwd/)
  })

  test('does not mutate the shared default theme', () => {
    parseConfig('[colors]\nidle = "#123456"')
    const { config } = parseConfig('')
    expect(config.theme.statusColors.idle).toBe('#22c55e')
  })
})
