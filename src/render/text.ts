/**
 * Text fitting for 72x72 keys.
 *
 * There is very little room, and repo names vary wildly in length: "portal"
 * needs 35px at 14px bold, but "zephyr_cloudflow" needs 108px against roughly
 * 68px of usable width. So sizes are measured, never assumed.
 *
 * Strategy, in order of preference:
 *   1. one line at a comfortable size
 *   2. two lines split on a natural separator (_ - . space)
 *   3. one line shrunk below comfortable
 *   4. one line truncated with an ellipsis
 *
 * Wrapping is tried before shrinking past `comfortableSize` because a name set
 * on two readable lines beats the same name crushed edge-to-edge at 9px.
 */

import type { SKRSContext2D } from '@napi-rs/canvas'

export interface FittedText {
  lines: string[]
  fontSize: number
}

export interface FitOptions {
  maxWidth: number
  /** Font sizes to try for a single line, largest first. */
  singleLineSizes: readonly number[]
  /** Font sizes to try when wrapping to two lines, largest first. */
  twoLineSizes: readonly number[]
  /** CSS font shorthand minus the size, e.g. "bold" or "" (regular). */
  weight: string
  family: string
  /**
   * Below this size, prefer wrapping to two lines over shrinking further.
   * Set to 0 to always exhaust single-line sizes first.
   */
  comfortableSize?: number
}

const ELLIPSIS = '\u2026'

function setFont(ctx: SKRSContext2D, opts: FitOptions, size: number): void {
  const weight = opts.weight ? `${opts.weight} ` : ''
  ctx.font = `${weight}${size}px ${opts.family}`
}

function width(ctx: SKRSContext2D, text: string): number {
  return ctx.measureText(text).width
}

/**
 * Split a label into two balanced lines at a natural boundary.
 *
 * Prefers the separator closest to the midpoint so "zephyr_cloudflow" becomes
 * "zephyr" / "cloudflow" rather than lopsided fragments. Returns null when
 * there is no separator to split on — we do not split mid-word, because a
 * hard-wrapped repo name is harder to recognise than a truncated one.
 */
function splitTwoLines(label: string): [string, string] | null {
  const separators = /[_\-. ]/g
  const mid = label.length / 2
  let best: number | null = null
  let bestDistance = Infinity

  for (const match of label.matchAll(separators)) {
    const index = match.index
    if (index === undefined || index === 0 || index >= label.length - 1) continue
    const distance = Math.abs(index - mid)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }

  if (best === null) return null
  // Drop the separator itself; the line break already communicates it.
  return [label.slice(0, best), label.slice(best + 1)]
}

function truncate(ctx: SKRSContext2D, label: string, maxWidth: number): string {
  if (width(ctx, label) <= maxWidth) return label
  let cut = label.length
  while (cut > 1) {
    cut--
    const candidate = label.slice(0, cut) + ELLIPSIS
    if (width(ctx, candidate) <= maxWidth) return candidate
  }
  return ELLIPSIS
}

/** Fit a label into the given width, returning the lines and font size to use. */
export function fitText(ctx: SKRSContext2D, label: string, opts: FitOptions): FittedText {
  const comfortable = opts.comfortableSize ?? 0

  const fitsSingle = (size: number): boolean => {
    setFont(ctx, opts, size)
    return width(ctx, label) <= opts.maxWidth
  }

  // 1. Single line at a comfortable size.
  for (const size of opts.singleLineSizes) {
    if (size < comfortable) break
    if (fitsSingle(size)) return { lines: [label], fontSize: size }
  }

  // 2. Two lines on a natural separator.
  const split = splitTwoLines(label)
  if (split) {
    for (const size of opts.twoLineSizes) {
      setFont(ctx, opts, size)
      if (width(ctx, split[0]) <= opts.maxWidth && width(ctx, split[1]) <= opts.maxWidth) {
        return { lines: [split[0], split[1]], fontSize: size }
      }
    }
  }

  // 3. Nothing wrapped, so shrink the single line the rest of the way.
  for (const size of opts.singleLineSizes) {
    if (size >= comfortable) continue
    if (fitsSingle(size)) return { lines: [label], fontSize: size }
  }

  // 3. Give up and truncate at the smallest single-line size.
  const smallest = opts.singleLineSizes[opts.singleLineSizes.length - 1] ?? 9
  setFont(ctx, opts, smallest)
  return { lines: [truncate(ctx, label, opts.maxWidth)], fontSize: smallest }
}
