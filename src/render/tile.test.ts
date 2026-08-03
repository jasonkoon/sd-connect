import { describe, expect, test } from 'bun:test'
import { createCanvas } from '@napi-rs/canvas'
import { TILE_BYTES, ICON_SIZE } from '../deck.ts'
import type { Agent, AgentStatus, Slot } from '../types.ts'
import { TileRenderer } from './tile.ts'
import { fitText } from './text.ts'
import { DEFAULT_THEME } from './theme.ts'

function agent(repo: string, session = 'zephyr', status: AgentStatus = 'idle'): Agent {
  return {
    session,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    status,
    cwd: `/dev/${repo}`,
    repo,
    agent: 'pi',
    focused: false,
  }
}

const slot = (a: Agent): Slot => ({ kind: 'agent', agent: a })

describe('fitText', () => {
  const ctx = createCanvas(ICON_SIZE, ICON_SIZE).getContext('2d')
  const opts = {
    maxWidth: 68,
    singleLineSizes: [15, 14, 13, 12, 11, 10, 9] as const,
    twoLineSizes: [13, 12, 11, 10, 9] as const,
    weight: 'bold',
    family: DEFAULT_THEME.fontFamily,
    comfortableSize: 12,
  }

  test('short names stay on one line at the largest size', () => {
    const r = fitText(ctx, 'db', opts)
    expect(r.lines).toEqual(['db'])
    expect(r.fontSize).toBe(15)
  })

  test('every produced line actually fits the width', () => {
    const names = [
      'db', 'api', 'portal', 'canaries', 'sd-connect', 'bcc_supabase',
      'zephyr_cloudflow', 'winning-edge-coaching', 'supercalifragilistic',
    ]
    for (const name of names) {
      const r = fitText(ctx, name, opts)
      ctx.font = `bold ${r.fontSize}px ${opts.family}`
      for (const line of r.lines) {
        expect(ctx.measureText(line).width).toBeLessThanOrEqual(opts.maxWidth)
      }
    }
  })

  test('wraps on a separator rather than shrinking to unreadable', () => {
    const r = fitText(ctx, 'bcc_supabase', opts)
    expect(r.lines).toEqual(['bcc', 'supabase'])
    expect(r.fontSize).toBeGreaterThanOrEqual(opts.comfortableSize)
  })

  test('splits nearest the midpoint, not the first separator', () => {
    const r = fitText(ctx, 'winning-edge-coaching', opts)
    expect(r.lines).toEqual(['winning-edge', 'coaching'])
  })

  test('truncates with an ellipsis when there is nothing to split on', () => {
    const r = fitText(ctx, 'supercalifragilistic', opts)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toEndWith('\u2026')
  })

  test('never returns an empty line', () => {
    for (const name of ['_leading', 'trailing_', 'a_b', '-', 'x']) {
      const r = fitText(ctx, name, opts)
      for (const line of r.lines) expect(line.length).toBeGreaterThan(0)
    }
  })
})

describe('TileRenderer', () => {
  test('produces buffers the deck will accept', () => {
    const r = new TileRenderer()
    for (const s of [
      slot(agent('portal')),
      { kind: 'empty' } as Slot,
      { kind: 'overflow', count: 3 } as Slot,
    ]) {
      expect(r.render(s).length).toBe(TILE_BYTES)
    }
  })

  test('status is visible as a coloured top bar', () => {
    const r = new TileRenderer()
    const tile = r.render(slot(agent('portal', 'zephyr', 'blocked')))
    // Top-left pixel sits inside the bar; #ef4444 -> r=239 g=68 b=68.
    expect(tile[0]).toBe(0xef)
    expect(tile[1]).toBe(0x44)
    expect(tile[2]).toBe(0x44)
  })

  test('different statuses produce different pixels', () => {
    const r = new TileRenderer()
    const idle = r.render(slot(agent('portal', 'zephyr', 'idle')))
    const blocked = r.render(slot(agent('portal', 'zephyr', 'blocked')))
    expect(idle.equals(blocked)).toBe(false)
  })

  test('caches identical slots and returns stable bytes', () => {
    const r = new TileRenderer()
    const a = r.render(slot(agent('portal')))
    const b = r.render(slot(agent('portal')))
    expect(r.stats.hits).toBe(1)
    expect(a.equals(b)).toBe(true)
  })

  test('cache key covers repo, session and status', () => {
    const r = new TileRenderer()
    r.render(slot(agent('portal', 'zephyr', 'idle')))
    r.render(slot(agent('portal', 'canaries', 'idle'))) // session differs
    r.render(slot(agent('other', 'zephyr', 'idle'))) // repo differs
    r.render(slot(agent('portal', 'zephyr', 'done'))) // status differs
    expect(r.stats.misses).toBe(4)
    expect(r.stats.hits).toBe(0)
  })

  test('evicts without exceeding the cache bound', () => {
    const r = new TileRenderer(DEFAULT_THEME, 4)
    for (let i = 0; i < 20; i++) r.render(slot(agent(`repo${i}`)))
    expect(r.stats.size).toBeLessThanOrEqual(4)
  })

  test('pinned-empty is distinguishable from plain empty', () => {
    const r = new TileRenderer()
    const plain = r.render({ kind: 'empty' })
    const pinned = r.render({ kind: 'empty' }, { pinnedEmpty: true })
    expect(plain.equals(pinned)).toBe(false)
  })

  test('renders a full 15-key frame well under a display frame budget', () => {
    const r = new TileRenderer()
    const start = performance.now()
    for (let i = 0; i < 15; i++) r.render(slot(agent(`repo${i}`, 'zephyr', 'working')))
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(100)
  })
})
