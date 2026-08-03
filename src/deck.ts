/**
 * Stream Deck device lifecycle.
 *
 * Phase 1 is display-only, so this module is write-only: it opens the device,
 * sets brightness, and pushes raw RGB tiles. Key press handling is deliberately
 * absent, but `openDeck` returns the underlying handle so a later phase can
 * attach a listener without restructuring anything.
 */

import { listStreamDecks, openStreamDeck, type StreamDeck } from '@elgato-stream-deck/node'

/** MK.2 geometry. Asserted at open time rather than assumed. */
export const KEY_COUNT = 15
export const KEY_COLUMNS = 5
export const KEY_ROWS = 3
export const ICON_SIZE = 72
/** Bytes in one tile: 72 * 72 * 3 (RGB, no alpha). */
export const TILE_BYTES = ICON_SIZE * ICON_SIZE * 3

const BLACK_TILE: Buffer = Buffer.alloc(TILE_BYTES, 0)

export class DeckUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeckUnavailableError'
  }
}

export interface DeckOptions {
  /** 0-100. Applied once at open. */
  brightness?: number
}

/**
 * A connected Stream Deck, with a shadow copy of what is currently on screen so
 * we only pay USB writes for keys that actually changed.
 */
export class Deck {
  readonly device: StreamDeck
  readonly keyCount: number

  /** Last bytes written per key. `null` means "unknown, must repaint". */
  #onScreen: (Buffer | null)[]
  #closed = false

  constructor(device: StreamDeck, keyCount: number) {
    this.device = device
    this.keyCount = keyCount
    this.#onScreen = new Array<Buffer | null>(keyCount).fill(null)
  }

  /**
   * Write one tile, skipping the USB round trip if those exact bytes are already
   * on that key. `tile` must be exactly TILE_BYTES long.
   */
  async setKey(index: number, tile: Buffer): Promise<boolean> {
    this.#assertOpen()
    if (index < 0 || index >= this.keyCount) {
      throw new RangeError(`key index ${index} out of range 0..${this.keyCount - 1}`)
    }
    if (tile.length !== TILE_BYTES) {
      throw new RangeError(`tile must be ${TILE_BYTES} bytes (72x72 RGB), got ${tile.length}`)
    }

    const current = this.#onScreen[index]
    if (current && current.equals(tile)) return false

    // node-hid wants 72*72*3 with format 'rgb'. Passing RGBA here throws a
    // RangeError from @elgato-stream-deck/core, so renderers must removeAlpha().
    await this.device.fillKeyBuffer(index, tile, { format: 'rgb' })
    this.#onScreen[index] = tile
    return true
  }

  /** Paint a full 15-key frame. Returns how many keys actually changed. */
  async setKeys(tiles: readonly Buffer[]): Promise<number> {
    let written = 0
    for (let i = 0; i < this.keyCount; i++) {
      const tile = tiles[i] ?? BLACK_TILE
      if (await this.setKey(i, tile)) written++
    }
    return written
  }

  /** Forget the shadow state so the next frame repaints every key. */
  invalidate(): void {
    this.#onScreen.fill(null)
  }

  async setBrightness(percent: number): Promise<void> {
    this.#assertOpen()
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    await this.device.setBrightness(clamped)
  }

  async clear(): Promise<void> {
    if (this.#closed) return
    await this.device.clearPanel()
    this.#onScreen.fill(BLACK_TILE)
  }

  /**
   * Attach a handler for device-level errors.
   *
   * node-hid emits these on its read loop, notably when the deck is unplugged
   * ('could not read from HID device'). Without a listener attached, an 'error'
   * event on an EventEmitter becomes an unhandled exception and takes the
   * process down, so the daemon must always register one.
   */
  onError(handler: (error: Error) => void): void {
    this.device.on('error', (err: unknown) => {
      handler(err instanceof Error ? err : new Error(String(err)))
    })
  }

  /**
   * Blank the panel and release the HID handle.
   *
   * Historical note: under Bun, `close()` segfaulted the process, so an earlier
   * version of this deliberately skipped it. That was one of the reasons this
   * project runs on Node, where close() is clean. Both steps are best-effort,
   * because the usual reason for shutting down mid-flight is that the deck was
   * unplugged, and failing to tidy up a device that is already gone must not
   * turn into a crash on exit.
   */
  async shutdown(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.device.clearPanel()
    } catch {
      // Already unplugged; nothing to blank.
    }
    try {
      await this.device.close()
    } catch {
      // Ditto: the OS reclaims the descriptor on exit regardless.
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  #assertOpen(): void {
    if (this.#closed) throw new DeckUnavailableError('deck has been shut down')
  }
}

/** True if a Stream Deck is currently attached. Used for hotplug polling later. */
export async function deckPresent(): Promise<boolean> {
  return (await listStreamDecks()).length > 0
}

/**
 * Open the first attached Stream Deck.
 *
 * Throws DeckUnavailableError when nothing is plugged in, so callers can
 * distinguish "no hardware" from a real fault.
 */
export async function openDeck(options: DeckOptions = {}): Promise<Deck> {
  const found = await listStreamDecks()
  const first = found[0]
  if (!first?.path) {
    throw new DeckUnavailableError('no Stream Deck found on USB')
  }

  const device = await openStreamDeck(first.path)

  // Count buttons from CONTROLS rather than trusting a NUM_KEYS constant:
  // on 7.6.3 under Bun, NUM_KEYS/ICON_SIZE read back as undefined, while
  // CONTROLS is correct (15 entries of type 'button' for the MK.2).
  const buttons = (device.CONTROLS ?? []).filter((c) => c.type === 'button')
  const keyCount = buttons.length || KEY_COUNT

  const deck = new Deck(device, keyCount)
  if (options.brightness !== undefined) {
    await deck.setBrightness(options.brightness)
  }
  return deck
}
