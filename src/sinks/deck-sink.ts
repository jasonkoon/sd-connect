/**
 * The Stream Deck as a frame sink.
 *
 * This is the original Display class with layout and rendering lifted out. It
 * owns the USB handle and the hotplug loop, and nothing else.
 *
 * Hotplug lives here rather than in Deck: if a write fails, the device is
 * assumed gone, and we poll for its return. The last frame is retained so the
 * deck can be repainted immediately on reconnect without waiting for the next
 * herdr change.
 */

import { Deck, DeckUnavailableError, deckPresent, openDeck } from '../deck.ts'
import type { Frame, Sink } from '../frame.ts'
import type { Agent, MacroAction } from '../types.ts'

const RECONNECT_DELAY_MS = 2000

export interface DeckSinkOptions {
  brightness: number
  verbose: boolean
  /** Invoked when a key showing an agent is released. */
  onPress?: (agent: Agent) => void
  /** Invoked when a macro key is released. */
  onMacro?: (key: number, action: MacroAction) => void
  /** Invoked when a page-navigation tile is released. */
  onPage?: (direction: 'forward' | 'back') => void
}

export class DeckSink implements Sink {
  readonly name = 'deck'

  #deck: Deck | null = null
  #brightness: number
  #verbose: boolean
  #onPress: ((agent: Agent) => void) | null
  #onMacro: ((key: number, action: MacroAction) => void) | null
  #onPage: (() => void) | null
  #lastFrame: Frame | null = null
  #reconnecting = false
  #stopped = false

  constructor(options: DeckSinkOptions) {
    this.#brightness = options.brightness
    this.#verbose = options.verbose
    this.#onPress = options.onPress ?? null
    this.#onMacro = options.onMacro ?? null
    this.#onPage = options.onPage ?? null
  }

  get connected(): boolean {
    return this.#deck !== null
  }

  /**
   * Keys on the attached deck, or null when nothing is attached.
   *
   * Null is meaningful: the caller uses it to fall back to the MK.2 default so
   * that layout still runs, and other sinks still get a frame, with no hardware.
   */
  get keyCount(): number | null {
    return this.#deck?.keyCount ?? null
  }

  /** The agent displayed on a key, or null for empty, overflow and macro keys. */
  agentAt(index: number): Agent | null {
    const slot = this.#lastFrame?.slots[index]
    return slot?.kind === 'agent' ? slot.agent : null
  }

  /** The macro on a key, or null for any non-macro key. */
  macroAt(index: number): { key: number; action: MacroAction } | null {
    const slot = this.#lastFrame?.slots[index]
    return slot?.kind === 'macro' ? { key: index, action: slot.action } : null
  }

  isOverflowAt(index: number): boolean {
    return this.#lastFrame?.slots[index]?.kind === 'overflow'
  }

  isBackAt(index: number): boolean {
    return this.#lastFrame?.slots[index]?.kind === 'page'
  }

  async connect(): Promise<boolean> {
    try {
      const deck = await openDeck({ brightness: this.#brightness })
      // node-hid emits 'error' from its read loop when the deck is unplugged.
      // An unhandled 'error' on an EventEmitter is a fatal exception, so this
      // listener is what keeps an unplug survivable rather than terminal.
      deck.onError((error) => {
        console.error(`[sd-connect] deck error: ${error.message}`)
        this.#handleDisconnect()
      })
      // Act on release rather than press: 'up' is what people expect from a
      // button, and it avoids firing twice if a key is held.
      deck.onKeyUp((index) => {
        const agent = this.agentAt(index)
        const macro = this.macroAt(index)
        if (agent) this.#onPress?.(agent)
        else if (macro) this.#onMacro?.(macro.key, macro.action)
        else if (this.isOverflowAt(index)) this.#onPage?.('forward')
        else if (this.isBackAt(index)) this.#onPage?.('back')
      })
      this.#deck = deck
      console.log(`[sd-connect] deck connected: ${deck.device.MODEL}, ${deck.keyCount} keys`)
      return true
    } catch (error) {
      if (error instanceof DeckUnavailableError) return false
      throw error
    }
  }

  /**
   * Start watching for a deck that is not currently attached. Safe to call when
   * one is already connected (it does nothing) or repeatedly (it is idempotent).
   */
  waitForDeck(): void {
    if (this.#deck === null) void this.#reconnectLoop()
  }

  async present(frame: Frame): Promise<void> {
    this.#lastFrame = frame
    const deck = this.#deck
    if (!deck) return

    // A frame laid out for a different key count means the deck changed under
    // us. Painting the prefix is better than throwing; the next poll re-lays
    // out against the real count.
    try {
      const written = await deck.setKeys(frame.tiles.slice(0, deck.keyCount))
      // Per-frame logging is verbose-only. Under launchd this log is never
      // rotated, and an agent flipping between working and idle all day would
      // otherwise grow it forever. Presses and failures are always logged.
      if (this.#verbose && written > 0) {
        const extra = frame.dropped.length > 0 ? ` (+${frame.dropped.length} on other pages)` : ''
        console.log(`[sd-connect] ${written} key(s) updated: ${describe(frame)}${extra}`)
      }
    } catch (error) {
      // A write failing almost always means the deck was unplugged.
      console.error(
        `[sd-connect] deck write failed: ${error instanceof Error ? error.message : error}`,
      )
      this.#handleDisconnect()
    }
  }

  /** Drop the handle and start watching for the device to return. */
  #handleDisconnect(): void {
    if (this.#deck === null) return
    this.#deck = null
    void this.#reconnectLoop()
  }

  /** Poll for the deck coming back, then repaint the frame we already have. */
  async #reconnectLoop(): Promise<void> {
    if (this.#reconnecting || this.#stopped) return
    this.#reconnecting = true
    console.log('[sd-connect] waiting for the deck to come back...')

    while (!this.#stopped && this.#deck === null) {
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS))
      if (this.#stopped) break
      if (!(await deckPresent())) continue
      try {
        if (await this.connect()) {
          // A freshly opened Deck starts with no shadow state, so presenting
          // the retained frame already repaints every key.
          if (this.#lastFrame) await this.present(this.#lastFrame)
        }
      } catch (error) {
        console.error(
          `[sd-connect] reconnect failed: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    this.#reconnecting = false
  }

  async stop(): Promise<void> {
    this.#stopped = true
    await this.#deck?.shutdown()
    this.#deck = null
  }
}

function describe(frame: Frame): string {
  return frame.slots
    .map((slot, i) => {
      if (slot.kind === 'empty') return null
      if (slot.kind === 'overflow') return `${i}:+${slot.count}`
      if (slot.kind === 'page') return `${i}:back`
      if (slot.kind === 'macro') return `${i}:macro[${slot.label}]`
      return `${i}:${slot.agent.repo}(${slot.agent.status})`
    })
    .filter((s): s is string => s !== null)
    .join(' ')
}
