/**
 * The Fifine Ampligame D6 as a frame sink.
 *
 * Mirrors DeckSink's shape (own the handle, hotplug loop, retain the last
 * frame for instant repaint on reconnect) but talks to ampgd6.ts instead of
 * deck.ts, because this is different hardware with a different protocol, not
 * a variant of the Elgato one. See ampgd6.ts for what was confirmed on real
 * hardware and how.
 */

import { AmpGd6, AmpGd6UnavailableError, ampGd6Present } from '../ampgd6.ts'
import type { Frame, Sink } from '../frame.ts'
import type { Agent, MacroAction } from '../types.ts'

const RECONNECT_DELAY_MS = 2000

export interface AmpGd6SinkOptions {
  brightness: number
  verbose: boolean
  onPress?: (agent: Agent) => void
  onMacro?: (key: number, action: MacroAction) => void
  /** Invoked when a page-navigation tile is released. */
  onPage?: (direction: 'forward' | 'back') => void
}

export class AmpGd6Sink implements Sink {
  readonly name = 'ampgd6'

  #device: AmpGd6 | null = null
  #brightness: number
  #verbose: boolean
  #onPress: ((agent: Agent) => void) | null
  #onMacro: ((key: number, action: MacroAction) => void) | null
  #onPage: (() => void) | null
  #lastFrame: Frame | null = null
  #reconnecting = false
  #stopped = false

  constructor(options: AmpGd6SinkOptions) {
    this.#brightness = options.brightness
    this.#verbose = options.verbose
    this.#onPress = options.onPress ?? null
    this.#onMacro = options.onMacro ?? null
    this.#onPage = options.onPage ?? null
  }

  get connected(): boolean {
    return this.#device !== null
  }

  get keyCount(): number | null {
    return this.#device?.keyCount ?? null
  }

  agentAt(index: number): Agent | null {
    const slot = this.#lastFrame?.slots[index]
    return slot?.kind === 'agent' ? slot.agent : null
  }

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
      const device = await AmpGd6.open({ brightness: this.#brightness })
      device.onError((error) => {
        console.error(`[sd-connect] ampgd6 error: ${error.message}`)
        this.#handleDisconnect()
      })
      device.onKeyUp((index) => {
        const agent = this.agentAt(index)
        const macro = this.macroAt(index)
        if (agent) this.#onPress?.(agent)
        else if (macro) this.#onMacro?.(macro.key, macro.action)
        else if (this.isOverflowAt(index)) this.#onPage?.('forward')
        else if (this.isBackAt(index)) this.#onPage?.('back')
      })
      this.#device = device
      console.log(`[sd-connect] ampgd6 connected: ${device.keyCount} keys`)
      return true
    } catch (error) {
      if (error instanceof AmpGd6UnavailableError) return false
      throw error
    }
  }

  waitForDevice(): void {
    if (this.#device === null) void this.#reconnectLoop()
  }

  async present(frame: Frame): Promise<void> {
    this.#lastFrame = frame
    const device = this.#device
    if (!device) return

    try {
      const written = await device.setKeys(frame.tiles.slice(0, device.keyCount))
      if (this.#verbose && written > 0) {
        console.log(`[sd-connect] ampgd6: ${written} key(s) updated`)
      }
    } catch (error) {
      console.error(
        `[sd-connect] ampgd6 write failed: ${error instanceof Error ? error.message : error}`,
      )
      this.#handleDisconnect()
    }
  }

  #handleDisconnect(): void {
    if (this.#device === null) return
    this.#device = null
    void this.#reconnectLoop()
  }

  async #reconnectLoop(): Promise<void> {
    if (this.#reconnecting || this.#stopped) return
    this.#reconnecting = true
    console.log('[sd-connect] waiting for the ampgd6 to come back...')

    while (!this.#stopped && this.#device === null) {
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS))
      if (this.#stopped) break
      if (!(await ampGd6Present())) continue
      try {
        if (await this.connect()) {
          if (this.#lastFrame) await this.present(this.#lastFrame)
        }
      } catch (error) {
        console.error(
          `[sd-connect] ampgd6 reconnect failed: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    this.#reconnecting = false
  }

  async stop(): Promise<void> {
    this.#stopped = true
    await this.#device?.shutdown()
    this.#device = null
  }
}
