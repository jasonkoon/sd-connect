/**
 * Step 1 smoke test: prove the device opens, renders, diffs, and shuts down
 * cleanly on this machine. No herdr involvement.
 *
 *   bun run smoke
 */

import { Deck, TILE_BYTES, openDeck, ICON_SIZE, DeckUnavailableError } from './deck.ts'
import { installShutdownHandlers, onShutdown, shutdown } from './shutdown.ts'

/** Flat colour tile, built by hand so this test has no dependency on sharp. */
function solidTile(r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(TILE_BYTES)
  for (let i = 0; i < TILE_BYTES; i += 3) {
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
  }
  return buf
}

/** Dark tile with a coloured bar across the top, mimicking the real key face. */
function barTile(r: number, g: number, b: number, barRows = 10): Buffer {
  const buf = Buffer.alloc(TILE_BYTES)
  for (let y = 0; y < ICON_SIZE; y++) {
    const inBar = y < barRows
    for (let x = 0; x < ICON_SIZE; x++) {
      const i = (y * ICON_SIZE + x) * 3
      buf[i] = inBar ? r : 0x14
      buf[i + 1] = inBar ? g : 0x16
      buf[i + 2] = inBar ? b : 0x1a
    }
  }
  return buf
}

const STATUS_COLORS = {
  idle: [0x22, 0xc5, 0x5e],
  working: [0x3b, 0x82, 0xf6],
  blocked: [0xef, 0x44, 0x44],
  done: [0xea, 0xb3, 0x08],
  unknown: [0x6b, 0x72, 0x80],
} as const

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  installShutdownHandlers()

  let deck: Deck
  try {
    deck = await openDeck({ brightness: 70 })
  } catch (err) {
    if (err instanceof DeckUnavailableError) {
      console.error(`[smoke] ${err.message} — plug in the Stream Deck and retry.`)
      process.exit(2)
    }
    throw err
  }

  onShutdown(() => deck.shutdown())

  console.log(`[smoke] opened ${deck.device.MODEL}, ${deck.keyCount} keys`)

  // 1. One tile per status, so we can eyeball the palette on real hardware.
  const statuses = Object.entries(STATUS_COLORS)
  const frame: Buffer[] = []
  for (const [, [r, g, b]] of statuses) frame.push(barTile(r, g, b))
  while (frame.length < deck.keyCount) frame.push(solidTile(0, 0, 0))

  let written = await deck.setKeys(frame)
  console.log(`[smoke] first paint wrote ${written} keys (expected ${deck.keyCount})`)

  // 2. Repaint the identical frame. The diff should suppress every write.
  written = await deck.setKeys(frame)
  console.log(`[smoke] identical repaint wrote ${written} keys (expected 0)`)
  if (written !== 0) {
    console.error('[smoke] FAIL: diffing is not suppressing redundant writes')
    await shutdown(1)
  }

  // 3. Change exactly one key. Only that key should move.
  frame[0] = barTile(...STATUS_COLORS.blocked)
  written = await deck.setKeys(frame)
  console.log(`[smoke] one-key change wrote ${written} keys (expected 1)`)
  if (written !== 1) {
    console.error('[smoke] FAIL: expected exactly one key write')
    await shutdown(1)
  }

  await sleep(2500)

  console.log('[smoke] PASS — shutting down (blank panel, no native close())')
  await shutdown(0)
}

await main()
