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

/** Compact view of a frame: repo name per key, '.' for empty, 'mac' for macro. */
function shape(slots: readonly Slot[]): string[] {
  return slots.map((s) =>
    s.kind === 'agent'
      ? s.agent.repo
      : s.kind === 'overflow'
        ? `+${s.count}`
        : s.kind === 'page'
          ? 'back'
          : s.kind === 'macro'
            ? 'mac'
            : '.',
  )
}

describe('layout: auto-flow', () => {
  test('fills keys in the order given', () => {
    const agents = [agent('a'), agent('b', { pane: 'w2:p1' }), agent('c', { pane: 'w3:p1' })]
    const { slots, pageCount } = layout(agents, { keyCount: 5 })
    expect(shape(slots)).toEqual(['a', 'b', 'c', '.', '.'])
    expect(pageCount).toBe(1)
  })

  test('no agents leaves every key blank', () => {
    const { slots } = layout([], { keyCount: 3 })
    expect(shape(slots)).toEqual(['.', '.', '.'])
  })

  test('exactly filling the deck does not create an overflow tile', () => {
    const agents = Array.from({ length: 5 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const { slots, pageCount } = layout(agents, { keyCount: 5 })
    expect(shape(slots)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
    expect(pageCount).toBe(1)
  })
})

describe('layout: pages', () => {
  test('the overflow tile is pressable navigation, and nothing is evicted', () => {
    // 7 agents, 5 keys: 4 shown + a +3 tile that opens page 2.
    const agents = Array.from({ length: 7 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const { slots, pageCount } = layout(agents, { keyCount: 5 })
    expect(shape(slots)).toEqual(['r0', 'r1', 'r2', 'r3', '+3'])
    expect(pageCount).toBe(2)
  })

  test('page 2 shows the rest and a back tile in the first key', () => {
    const agents = Array.from({ length: 7 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const { slots, pageCount } = layout(agents, { keyCount: 5, page: 1 })
    expect(shape(slots)).toEqual(['back', 'r4', 'r5', 'r6', '.'])
    expect(pageCount).toBe(2)
  })

  test('page 2 is laid out from where page 1 stopped, in the same order', () => {
    // 11 agents: page 1 shows r0-r3 + overflow, page 2 r4-r6 + overflow, page 3 r7-r10.
    const agents = Array.from({ length: 11 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    expect(layout(agents, { keyCount: 5 }).pageCount).toBe(3)
    expect(shape(layout(agents, { keyCount: 5, page: 1 }).slots)).toEqual(['back', 'r4', 'r5', 'r6', '+4'])
    expect(shape(layout(agents, { keyCount: 5, page: 2 }).slots)).toEqual(['back', 'r7', 'r8', 'r9', 'r10'])
  })

  test('a page request past the end clamps to the last page', () => {
    const agents = Array.from({ length: 7 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const { slots } = layout(agents, { keyCount: 5, page: 9 })
    expect(shape(slots)).toEqual(['back', 'r4', 'r5', 'r6', '.'])
  })

  test('the overflow count always matches the agents held on later pages', () => {
    const agents = Array.from({ length: 7 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const first = layout(agents, { keyCount: 5 })
    const overflow = first.slots[4] as { kind: 'overflow'; count: number }
    const onOtherPages = agents.length - first.slots.filter((s) => s.kind === 'agent').length
    expect(overflow.count).toBe(onOtherPages)
  })

  test('no eviction: agents that do not fit are paged, never hidden', () => {
    const agents = [
      agent('idle1', { status: 'idle', pane: 'w1:p1' }),
      agent('unknown1', { status: 'unknown', pane: 'w2:p1' }),
      agent('blocked1', { status: 'blocked', pane: 'w3:p1' }),
      agent('working1', { status: 'working', pane: 'w4:p1' }),
      agent('done1', { status: 'done', pane: 'w5:p1' }),
    ]
    // 3 keys: page 1 shows 2 + overflow; later pages show the remaining 3.
    expect(shape(layout(agents, { keyCount: 3 }).slots)).toEqual(['idle1', 'unknown1', '+3'])
    expect(shape(layout(agents, { keyCount: 3, page: 1 }).slots)).toEqual(['back', 'blocked1', '+2'])
    expect(layout(agents, { keyCount: 3 }).pageCount).toBe(3)
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

  test('with fewer than 3 free keys there is no pagination, only an honest overflow tile', () => {
    const agents = [
      agent('first', { status: 'idle', pane: 'w1:p1' }),
      agent('second', { status: 'idle', pane: 'w2:p1' }),
      agent('third', { status: 'idle', pane: 'w3:p1' }),
    ]
    // A back tile plus an agent cannot share 2 keys; clamping keeps it safe.
    expect(shape(layout(agents, { keyCount: 2 }).slots)).toEqual(['first', '+2'])
    expect(shape(layout(agents, { keyCount: 2, page: 1 }).slots)).toEqual(['first', '+2'])
    expect(layout(agents, { keyCount: 2, page: 1 }).pageCount).toBe(1)
  })

  test('a single free key shows what fits and cannot page (a back tile would strand it)', () => {
    const agents = [agent('a'), agent('b', { pane: 'w2:p1' })]
    const { slots, pageCount } = layout(agents, { keyCount: 1 })
    expect(shape(slots)).toEqual(['+2'])
    expect(pageCount).toBe(1)
  })

  test('every agent fits: no overflow tile, one page', () => {
    const agents = Array.from({ length: 14 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const { slots, pageCount } = layout(agents, { keyCount: 15 })
    expect(pageCount).toBe(1)
    expect(shape(slots).filter((s) => s !== '.')).toHaveLength(14)
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

  test('a "*" session pin matches whatever session holds the repo', () => {
    const agents = [agent('a', { session: 'whatever', cwd: '/dev/a' })]
    const { slots } = layout(agents, { keyCount: 2, pins: [pin(0, '*', '/dev/a')] })
    expect(shape(slots)).toEqual(['a', '.'])
  })

  test('a pin follows the agent when its cwd drifts into a subdirectory', () => {
    // Restarted inside a subdir: the repo label is what stays stable.
    const agents = [agent('a', { session: 'drifted', cwd: '/dev/a/sub/dir' })]
    const { slots } = layout(agents, { keyCount: 2, pins: [pin(0, 'drifted', '/dev/a')] })
    expect(shape(slots)).toEqual(['a', '.'])
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
    const { slots, pageCount } = layout(agents, { keyCount: 3, pins: [pin(2, 'zephyr', '/dev/dup')] })
    expect(shape(slots)).toEqual(['dup', '.', 'dup'])
    expect(pageCount).toBe(1)
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
    // Two free keys cannot host back + forward + an agent, so it does not
    // paginate: the +1 tile honestly reports what is not shown.
    const { slots, pageCount } = layout(agents, {
      keyCount: 3,
      pins: [pin(1, 'zephyr', '/dev/pinned')],
    })
    expect(shape(slots)).toEqual(['x', 'pinned', '+2'])
    expect(pageCount).toBe(1)
  })

  test('every key pinned leaves nowhere for others to flow', () => {
    const agents = [agent('a', { cwd: '/dev/a' }), agent('b', { cwd: '/dev/b', pane: 'w2:p1' })]
    const { slots, pageCount } = layout(agents, { keyCount: 1, pins: [pin(0, 'zephyr', '/dev/a')] })
    expect(shape(slots)).toEqual(['a'])
    // 'b' has nowhere to go and there is no free key for an overflow tile.
    expect(pageCount).toBe(1)
  })
})

describe('layout: macros', () => {
  const pin = (key: number, session: string, cwd: string): Pin => ({ key, session, cwd })

  test('places a macro on its key', () => {
    const agents = [agent('a'), agent('b', { pane: 'w2:p1' })]
    const { slots } = layout(agents, {
      keyCount: 5,
      macros: [{ key: 4, label: 'Deploy', action: { type: 'command', run: 'true' } }],
    })
    expect(slots[4]).toEqual({
      kind: 'macro',
      label: 'Deploy',
      color: null,
      action: { type: 'command', run: 'true' },
    })
    // agents still flow into the other free keys
    expect(shape(slots)).toEqual(['a', 'b', '.', '.', 'mac'])
  })

  test('a macro key is reserved: agents never flow into it', () => {
    const agents = [agent('a'), agent('b', { pane: 'w2:p1' }), agent('c', { pane: 'w3:p1' })]
    const { slots } = layout(agents, { keyCount: 4, macros: [{ key: 1, label: 'X', action: { type: 'command', run: 'true' } }] })
    // three agents, 3 free keys -> all fit, but key 1 stays the macro
    expect(slots[1]?.kind).toBe('macro')
    expect(shape(slots)).toEqual(['a', 'mac', 'b', 'c'])
  })

  test('a macro key is never evicted by overflow', () => {
    const agents = Array.from({ length: 6 }, (_, i) => agent(`r${i}`, { pane: `w${i}:p1` }))
    const { slots } = layout(agents, {
      keyCount: 5,
      macros: [{ key: 4, label: 'X', action: { type: 'command', run: 'true' } }],
    })
    // key 4 is the macro, so overflow has to use key 3
    expect(slots[4]).toEqual({
      kind: 'macro',
      label: 'X',
      color: null,
      action: { type: 'command', run: 'true' },
    })
  })

  test('duplicate macros for one key: the first wins', () => {
    const { slots } = layout([], {
      keyCount: 3,
      macros: [
        { key: 0, label: 'first', action: { type: 'command', run: 'true' } },
        { key: 0, label: 'second', action: { type: 'command', run: 'echo hi' } },
      ],
    })
    expect(slots[0]).toEqual({
      kind: 'macro',
      label: 'first',
      color: null,
      action: { type: 'command', run: 'true' },
    })
  })

  test('macros take precedence over pins on the same key', () => {
    const agents = [agent('a', { cwd: '/dev/a' })]
    const { slots } = layout(agents, {
      keyCount: 3,
      pins: [pin(0, 'zephyr', '/dev/a')],
      macros: [{ key: 0, label: 'M', action: { type: 'command', run: 'true' } }],
    })
    expect(slots[0]?.kind).toBe('macro')
    // the pinned agent must flow elsewhere instead
    expect(shape(slots)).toEqual(['mac', 'a', '.'])
  })

  test('out-of-range macros are ignored', () => {
    const { slots } = layout([], {
      keyCount: 2,
      macros: [{ key: 99, label: 'X', action: { type: 'command', run: 'true' } }],
    })
    expect(shape(slots)).toEqual(['.', '.'])
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

  test('reads a command macro with colour', () => {
    const { config, warnings } = parseConfig(`
[[macros]]
key     = 14
label   = "Deploy"
color   = "#8b5cf6"

[macros.action]
type = "command"
run  = "/usr/local/bin/deploy"
`)
    expect(warnings).toEqual([])
    expect(config.macros).toEqual([
      {
        key: 14,
        label: 'Deploy',
        color: '#8b5cf6',
        action: { type: 'command', run: '/usr/local/bin/deploy' },
      },
    ])
  })

  test('macro without colour gets undefined, not an error', () => {
    const { config, warnings } = parseConfig(`
[[macros]]
key   = 1
label = "X"

[macros.action]
type = "command"
run  = "echo hi"
`)
    expect(warnings).toEqual([])
    expect(config.macros[0]?.color).toBe(undefined)
  })

  test('skips an incomplete macro but keeps valid ones', () => {
    const { config, warnings } = parseConfig(`
[[macros]]
key = 0
label = "bad"

[macros.action]
type = "command"

[[macros]]
key = 2
label = "ok"

[macros.action]
type = "app"
app = "Finder"
`)
    expect(config.macros).toEqual([
      { key: 2, label: 'ok', color: undefined, action: { type: 'app', app: 'Finder' } },
    ])
    expect(warnings[0]).toMatch(/run/)
  })

  test('warns on unknown action type and bad colour', () => {
    const { config, warnings } = parseConfig(`
[[macros]]
key   = 3
label = "X"
color = "red"

[macros.action]
type = "teleport"
`)
    expect(config.macros).toEqual([])
    expect(warnings.join(' ')).toMatch(/type must be one of command, url, app/)
    expect(warnings.join(' ')).toMatch(/#rrggbb/)
  })

  test('treats duplicate macro keys as a warning', () => {
    const { config, warnings } = parseConfig(`
[[macros]]
key   = 0
label = "a"
[macros.action]
type = "command"
run  = "true"

[[macros]]
key   = 0
label = "b"
[macros.action]
type = "command"
run  = "false"
`)
    expect(config.macros).toHaveLength(1)
    expect(warnings[0]).toMatch(/duplicate/)
  })
})
