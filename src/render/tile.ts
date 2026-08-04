/**
 * Tile rendering: a Slot becomes 72x72x3 raw RGB bytes ready for fillKeyBuffer.
 *
 * Uses @napi-rs/canvas rather than SVG-via-sharp. This is not a style
 * preference — sharp 0.35 rasterises SVG with resvg, which ships without any
 * font backend, so `<text>` elements silently render as nothing. Verified: a
 * test tile came back with 0 light pixels where the label should have been.
 * Canvas also hands us raw pixels directly, so sharp isn't needed at all.
 */

import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import { ICON_SIZE, TILE_BYTES } from '../deck.ts'
import type { Slot } from '../types.ts'
import { DEFAULT_THEME, type Theme } from './theme.ts'
import { fitText } from './text.ts'

/**
 * Identity of a slot's pixels: two slots with the same key always render the
 * same tile. Used as the render cache key, and by the web viewer as a
 * content-addressed URL so the browser can cache each tile immutably.
 */
export function slotKey(slot: Slot): string {
  switch (slot.kind) {
    case 'empty':
      return slot.pinned ? 'pinned-empty' : 'empty'
    case 'overflow':
      return `overflow:${slot.count}`
    case 'agent': {
      const a = slot.agent
      return `agent:${a.status}:${a.repo}:${a.session}`
    }
  }
}

/** Horizontal padding, so glyphs never touch the bezel. */
const PADDING = 2
const MAX_TEXT_WIDTH = ICON_SIZE - PADDING * 2

const REPO_SINGLE_SIZES = [15, 14, 13, 12, 11, 10, 9] as const
const REPO_TWO_LINE_SIZES = [13, 12, 11, 10, 9] as const
/** Below 12px a single line stops being glanceable, so wrap instead. */
const REPO_COMFORTABLE_SIZE = 12
const SESSION_SIZE = 9

/** Bottom margin for the session label baseline. */
const SESSION_BASELINE = ICON_SIZE - 6

export interface RenderOptions {
  theme?: Theme
}

/**
 * Renders tiles and caches the result.
 *
 * The cache matters: `pane.updated` is chatty, so the same handful of tiles get
 * requested over and over. In steady state this should do zero drawing.
 */
export class TileRenderer {
  readonly theme: Theme
  #canvas: Canvas
  #ctx: SKRSContext2D
  #cache = new Map<string, Buffer>()
  #maxEntries: number
  #hits = 0
  #misses = 0

  constructor(theme: Theme = DEFAULT_THEME, maxEntries = 128) {
    this.theme = theme
    this.#maxEntries = maxEntries
    this.#canvas = createCanvas(ICON_SIZE, ICON_SIZE)
    this.#ctx = this.#canvas.getContext('2d')
  }

  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.#hits, misses: this.#misses, size: this.#cache.size }
  }

  render(slot: Slot): Buffer {
    const cacheKey = slotKey(slot)

    const cached = this.#cache.get(cacheKey)
    if (cached) {
      this.#hits++
      // Refresh recency for the LRU eviction below.
      this.#cache.delete(cacheKey)
      this.#cache.set(cacheKey, cached)
      return cached
    }

    this.#misses++
    const tile = this.#draw(slot)

    if (this.#cache.size >= this.#maxEntries) {
      const oldest = this.#cache.keys().next()
      if (!oldest.done) this.#cache.delete(oldest.value)
    }
    this.#cache.set(cacheKey, tile)
    return tile
  }

  clearCache(): void {
    this.#cache.clear()
  }

  #draw(slot: Slot): Buffer {
    const ctx = this.#ctx
    const t = this.theme

    ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE)

    if (slot.kind === 'empty') {
      ctx.fillStyle = slot.pinned ? t.pinnedEmptyBackground : '#000000'
      ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE)
      return this.#toRgb()
    }

    ctx.fillStyle = t.background
    ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE)

    if (slot.kind === 'overflow') {
      ctx.fillStyle = t.overflowColor
      ctx.font = `bold 20px ${t.fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(`+${slot.count}`, ICON_SIZE / 2, 40)
      ctx.fillStyle = t.sessionColor
      ctx.font = `${SESSION_SIZE}px ${t.fontFamily}`
      ctx.fillText('more', ICON_SIZE / 2, 56)
      return this.#toRgb()
    }

    const agent = slot.agent

    // Status bar across the top.
    ctx.fillStyle = t.statusColors[agent.status]
    ctx.fillRect(0, 0, ICON_SIZE, t.barHeight)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'

    // Repo name, fitted. Sits between the bar and the session label.
    const fitted = fitText(ctx, agent.repo, {
      maxWidth: MAX_TEXT_WIDTH,
      singleLineSizes: REPO_SINGLE_SIZES,
      twoLineSizes: REPO_TWO_LINE_SIZES,
      weight: 'bold',
      family: t.fontFamily,
      comfortableSize: REPO_COMFORTABLE_SIZE,
    })

    ctx.fillStyle = t.repoColor
    // fitText leaves ctx.font set to the chosen size.
    const lineHeight = fitted.fontSize + 2
    const blockHeight = lineHeight * fitted.lines.length
    // Vertically centre the block in the space between bar and session label.
    const regionTop = t.barHeight
    const regionBottom = SESSION_BASELINE - SESSION_SIZE - 2
    const firstBaseline =
      regionTop + (regionBottom - regionTop - blockHeight) / 2 + fitted.fontSize

    fitted.lines.forEach((line, i) => {
      ctx.fillText(line, ICON_SIZE / 2, firstBaseline + i * lineHeight)
    })

    // Session name along the bottom, truncated rather than shrunk.
    ctx.fillStyle = t.sessionColor
    ctx.font = `${SESSION_SIZE}px ${t.fontFamily}`
    const session = fitText(ctx, agent.session, {
      maxWidth: MAX_TEXT_WIDTH,
      singleLineSizes: [SESSION_SIZE],
      twoLineSizes: [],
      weight: '',
      family: t.fontFamily,
    })
    ctx.font = `${SESSION_SIZE}px ${t.fontFamily}`
    ctx.fillText(session.lines[0] ?? '', ICON_SIZE / 2, SESSION_BASELINE)

    return this.#toRgb()
  }

  /**
   * Canvas gives RGBA; fillKeyBuffer demands exactly 72*72*3 RGB and throws a
   * RangeError otherwise. Drop the alpha channel.
   */
  #toRgb(): Buffer {
    const { data } = this.#ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE)
    const out = Buffer.allocUnsafe(TILE_BYTES)
    for (let src = 0, dst = 0; dst < TILE_BYTES; src += 4, dst += 3) {
      out[dst] = data[src] as number
      out[dst + 1] = data[src + 1] as number
      out[dst + 2] = data[src + 2] as number
    }
    return out
  }
}
