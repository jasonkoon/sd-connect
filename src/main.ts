/**
 * sd-connect daemon: herdr agent status on a Stream Deck.
 *
 *   bun run start
 *   bun run start --once     paint one frame and exit
 *   bun run start --verbose  log every frame
 *
 * Data flows one way: poller -> layout -> renderer -> deck. Nothing here talks
 * back to herdr, which is what keeps phase 1 honest about being display-only.
 */

import { loadConfig } from './config.ts'
import { Deck, DeckUnavailableError, deckPresent, openDeck } from './deck.ts'
import { AgentPoller } from './herdr/poller.ts'
import { layout } from './layout.ts'
import { TileRenderer } from './render/tile.ts'
import { installShutdownHandlers, onShutdown, shutdown } from './shutdown.ts'
import type { Agent, Slot } from './types.ts'

const RECONNECT_DELAY_MS = 2000

interface Flags {
  once: boolean
  verbose: boolean
}

function parseFlags(argv: string[]): Flags {
  return {
    once: argv.includes('--once'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
  }
}

function describe(slots: readonly Slot[]): string {
  return slots
    .map((slot, i) => {
      if (slot.kind === 'empty') return null
      if (slot.kind === 'overflow') return `${i}:+${slot.count}`
      return `${i}:${slot.agent.repo}(${slot.agent.status})`
    })
    .filter((s): s is string => s !== null)
    .join(' ')
}

/**
 * Owns the deck handle and repaints on demand.
 *
 * Hotplug is handled here rather than in Deck: if a write fails, the device is
 * assumed gone, and we poll for its return. The last frame is retained so the
 * deck can be repainted immediately on reconnect without waiting for the next
 * herdr change.
 */
class Display {
  #deck: Deck | null = null
  #renderer: TileRenderer
  #brightness: number
  #lastAgents: Agent[] = []
  #pins
  #verbose: boolean
  #reconnecting = false
  #stopped = false

  constructor(opts: {
    renderer: TileRenderer
    brightness: number
    pins: Parameters<typeof layout>[1]['pins']
    verbose: boolean
  }) {
    this.#renderer = opts.renderer
    this.#brightness = opts.brightness
    this.#pins = opts.pins
    this.#verbose = opts.verbose
  }

  get connected(): boolean {
    return this.#deck !== null
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
      this.#deck = deck
      console.log(`[sd-connect] deck connected: ${deck.device.MODEL}, ${deck.keyCount} keys`)
      return true
    } catch (error) {
      if (error instanceof DeckUnavailableError) return false
      throw error
    }
  }

  /** Drop the handle and start watching for the device to return. */
  #handleDisconnect(): void {
    if (this.#deck === null) return
    this.#deck = null
    void this.#reconnectLoop()
  }

  /**
   * Start watching for a deck that is not currently attached. Safe to call when
   * one is already connected (it does nothing) or repeatedly (it is idempotent).
   */
  waitForDeck(): void {
    if (this.#deck === null) void this.#reconnectLoop()
  }

  async show(agents: Agent[]): Promise<void> {
    this.#lastAgents = agents
    const deck = this.#deck
    if (!deck) return

    const { slots, dropped } = layout(agents, { keyCount: deck.keyCount, pins: this.#pins })
    const tiles = slots.map((slot) => this.#renderer.render(slot))

    try {
      const written = await deck.setKeys(tiles)
      if (this.#verbose || written > 0) {
        const extra = dropped.length > 0 ? ` (+${dropped.length} not shown)` : ''
        console.log(`[sd-connect] ${written} key(s) updated: ${describe(slots)}${extra}`)
      }
    } catch (error) {
      // A write failing almost always means the deck was unplugged.
      console.error(`[sd-connect] deck write failed: ${error instanceof Error ? error.message : error}`)
      this.#handleDisconnect()
    }
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
          // A freshly opened Deck starts with no shadow state, so the next
          // show() already repaints every key.
          await this.show(this.#lastAgents)
        }
      } catch (error) {
        console.error(`[sd-connect] reconnect failed: ${error instanceof Error ? error.message : error}`)
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

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  installShutdownHandlers()

  const { config, warnings, path, existed } = await loadConfig()
  console.log(`[sd-connect] config: ${existed ? path : `${path} (not found, using defaults)`}`)
  for (const warning of warnings) console.warn(`[sd-connect] config: ${warning}`)
  if (config.pins.length > 0) {
    console.log(`[sd-connect] ${config.pins.length} pin(s): ${config.pins.map((p) => `key ${p.key} -> ${p.session}:${p.cwd}`).join(', ')}`)
  }

  const renderer = new TileRenderer(config.theme)
  const display = new Display({
    renderer,
    brightness: config.brightness,
    pins: config.pins,
    verbose: flags.verbose,
  })
  onShutdown(() => display.stop())

  if (!(await display.connect())) {
    if (flags.once) {
      console.error('[sd-connect] no Stream Deck found')
      await shutdown(2)
    }
    console.log('[sd-connect] no Stream Deck found; waiting for one to be plugged in')
    display.waitForDeck()
  }

  const poller = new AgentPoller({
    intervalMs: config.pollIntervalMs,
    onChange: (agents) => display.show(agents),
    onSessionError: (session, error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[sd-connect] session '${session}' unavailable: ${message}`)
    },
  })
  onShutdown(() => poller.stop())

  await poller.start()
  console.log(`[sd-connect] polling ${poller.sessions.length} session(s) every ${config.pollIntervalMs}ms`)

  if (flags.once) {
    poller.stop()
    await shutdown(0)
  }

  console.log('[sd-connect] running; Ctrl-C to stop')
  await new Promise(() => {})
}

await main()
