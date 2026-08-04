/**
 * A rendered frame, and the sinks that can present one.
 *
 * The deck used to be the only consumer of a frame, so layout and rendering
 * lived inside the class that owned the USB handle. Splitting them apart is
 * what lets the same pixels go somewhere else when no deck is plugged in:
 * everything up to `Frame` is hardware-independent, and always has been.
 */

import type { Agent, Slot } from './types.ts'

/** One painted frame: what goes on each key, and the pixels for it. */
export interface Frame {
  /** Length equals keyCount. */
  readonly slots: readonly Slot[]
  /** Parallel to `slots`. Each is 72*72*3 raw RGB. Shared and cached: never mutate. */
  readonly tiles: readonly Buffer[]
  /** Agents that did not fit on a key. */
  readonly dropped: readonly Agent[]
  readonly keyCount: number
}

/**
 * Somewhere a frame can be shown.
 *
 * `present` must not throw for transient failures — a sink that cannot display
 * right now (deck unplugged, no browser attached) should absorb it, because one
 * broken sink must not stop the others from updating.
 */
export interface Sink {
  readonly name: string
  present(frame: Frame): Promise<void>
  stop(): Promise<void>
}
