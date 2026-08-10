/**
 * Fifine Ampligame D6 device lifecycle.
 *
 * Same shape as deck.ts (open, diffed writes, error/press listeners, clean
 * shutdown) but a completely different transport: this is a Mirabox/Ajazz
 * reference-design device (the "mirajazz" protocol), not an Elgato one. No
 * library exists for it in this ecosystem, so this talks raw HID.
 *
 * Confirmed live against a real D6, 2026-08-09 (see tools/mirajazz-probe.cjs
 * and tools/mirajazz-grid-probe.cjs for the throwaway scripts that did it):
 *
 *   - VID 0x3142 / PID 0x0060. The two published references for this model
 *     (Phoenix557/FifineOpenSource, 3dRikal/opendeck-ampgd6) target PID
 *     0x0007 and assumed 0x0060 was unactivated "demo" firmware needing
 *     Fifine's official app to unlock. That was wrong. opendeck-ampgd6#1
 *     (open, unmerged at the time of writing) has the real answer: 0x0060 is
 *     protocol v2, not v1 — 1024-byte packets, not 512. Every earlier probe
 *     silently failed only because of that packet size, not because the
 *     device was locked.
 *   - Command framing ("CRT" + 3-letter ASCII tag, padded to packet size) is
 *     unchanged from v1, and matches 4ndv/mirajazz.
 *   - Images: 95x95 JPEG, rotated 180 degrees. Confirmed with an asymmetric
 *     test tile — a symmetric one would not have caught this.
 *   - Image writes use a different key index than the visual left-to-right,
 *     top-to-bottom order: visual index N maps to device index
 *     IMAGE_KEY_MAP[N]. Confirmed by painting all 15 keys with their raw
 *     device index and reading back the physical grid.
 *   - Button *presses* are NOT remapped: the device reports raw 1-based
 *     indexes in raster order (top-left = 1, top-right = 5, bottom-right =
 *     15). Confirmed by pressing all 15 keys in a known order and reading the
 *     indexes back. This is a real asymmetry between the read and write
 *     paths, not a mistake — the AKP153 family works the same way.
 *   - The device acks every command with a 512-byte "ACK..OK" report, and
 *     that response protocol is unrelated to whether the command packets
 *     going out are 512 or 1024 bytes.
 */

import { HIDAsync, devicesAsync } from 'node-hid'
import { createCanvas } from '@napi-rs/canvas'

export const AMPGD6_VID = 0x3142
export const AMPGD6_PID = 0x0060
const USAGE_PAGE = 0xffa0

export const AMPGD6_KEY_COUNT = 15
export const AMPGD6_KEY_COLUMNS = 5
export const AMPGD6_KEY_ROWS = 3
export const AMPGD6_ICON_SIZE = 95

const PACKET_SIZE = 1024

/**
 * Visual (row-major, left-to-right top-to-bottom) key index -> device image
 * index. The device's own numbering starts at the bottom row; this undoes
 * that so callers only ever think in visual order, same as deck.ts.
 */
export const IMAGE_KEY_MAP = [10, 11, 12, 13, 14, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4] as const

export class AmpGd6UnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmpGd6UnavailableError'
  }
}

export class AmpGd6BusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmpGd6BusyError'
  }
}

export interface AmpGd6Options {
  /** 0-100. Applied once at open. */
  brightness?: number
}

/** "CRT" command header, padded to a full packet. */
function cmd(...tail: number[]): Buffer {
  const buf = Buffer.alloc(PACKET_SIZE + 1, 0)
  Buffer.from([0x00, 0x43, 0x52, 0x54, 0x00, 0x00, ...tail]).copy(buf)
  return buf
}

const CMD = {
  wake: () => cmd(0x44, 0x49, 0x53),
  brightness: (pct: number) => cmd(0x4c, 0x49, 0x47, 0x00, 0x00, pct),
  flush: () => cmd(0x53, 0x54, 0x50),
  clearAll: () => cmd(0x43, 0x4c, 0x45, 0x00, 0x00, 0x00, 0xff),
  imageHeader: (deviceKey: number, len: number) =>
    cmd(0x42, 0x41, 0x54, 0x00, 0x00, (len >> 8) & 0xff, len & 0xff, deviceKey + 1),
}

/** Renders a solid-colour RGB buffer as a 95x95 JPEG, pre-rotated 180 degrees. */
function toDeviceJpeg(rgb: Buffer): Buffer {
  const canvas = createCanvas(AMPGD6_ICON_SIZE, AMPGD6_ICON_SIZE)
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(AMPGD6_ICON_SIZE, AMPGD6_ICON_SIZE)
  const n = AMPGD6_ICON_SIZE * AMPGD6_ICON_SIZE
  for (let i = 0; i < n; i++) {
    // Rot180 == reverse pixel order.
    const src = (n - 1 - i) * 3
    const dst = i * 4
    image.data[dst] = rgb[src] as number
    image.data[dst + 1] = rgb[src + 1] as number
    image.data[dst + 2] = rgb[src + 2] as number
    image.data[dst + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toBuffer('image/jpeg', 90)
}

/**
 * A connected Fifine Ampligame D6, with a shadow copy of what is on screen so
 * unchanged keys are not re-sent.
 */
export class AmpGd6 {
  readonly keyCount = AMPGD6_KEY_COUNT

  #device: HIDAsync
  #onScreen: (Buffer | null)[]
  #closed = false

  private constructor(device: HIDAsync) {
    this.#device = device
    this.#onScreen = new Array<Buffer | null>(AMPGD6_KEY_COUNT).fill(null)
  }

  static async open(options: AmpGd6Options = {}): Promise<AmpGd6> {
    const found = await devicesAsync()
    const info = found.find(
      (d) => d.vendorId === AMPGD6_VID && d.productId === AMPGD6_PID && d.usagePage === USAGE_PAGE,
    )
    if (!info?.path) {
      throw new AmpGd6UnavailableError('no Fifine Ampligame D6 found on USB')
    }

    let device: HIDAsync
    try {
      device = await HIDAsync.open(info.path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('exclusive access') || message.includes('already open')) {
        throw new AmpGd6BusyError(
          'the Ampligame D6 is already open in another process (another sd-connect instance?)',
        )
      }
      throw error
    }

    const deck = new AmpGd6(device)
    await device.write(CMD.wake())
    if (options.brightness !== undefined) {
      await deck.setBrightness(options.brightness)
    }
    return deck
  }

  /**
   * Write one tile (visual index, 72x72x3 RGB — same shape every other
   * renderer produces), skipping the round trip if unchanged. Converts to the
   * device's 95x95 JPEG + Rot180 + key remap internally so callers never need
   * to know this is different hardware.
   */
  async setKey(visualIndex: number, tile: Buffer): Promise<boolean> {
    this.#assertOpen()
    if (visualIndex < 0 || visualIndex >= this.keyCount) {
      throw new RangeError(`key index ${visualIndex} out of range 0..${this.keyCount - 1}`)
    }

    const current = this.#onScreen[visualIndex]
    if (current && current.equals(tile)) return false

    const resized = resizeRgb(tile, 72, 72, AMPGD6_ICON_SIZE, AMPGD6_ICON_SIZE)
    const jpeg = toDeviceJpeg(resized)
    const deviceKey = IMAGE_KEY_MAP[visualIndex] as number

    await this.#device.write(CMD.imageHeader(deviceKey, jpeg.length))
    let sent = 0
    while (sent < jpeg.length) {
      const take = Math.min(PACKET_SIZE, jpeg.length - sent)
      const buf = Buffer.alloc(PACKET_SIZE + 1, 0)
      jpeg.copy(buf, 1, sent, sent + take)
      await this.#device.write(buf)
      sent += take
    }

    this.#onScreen[visualIndex] = tile
    return true
  }

  /**
   * Paint a full frame. Callers pass 72x72x3 RGB tiles (this device's tiles
   * are 95x95, but resizing is this class's job, not the renderer's — every
   * other sink already speaks 72x72). Returns how many keys actually changed.
   * A single flush commits everything queued by setKey.
   */
  async setKeys(tiles: readonly Buffer[]): Promise<number> {
    let written = 0
    for (let i = 0; i < this.keyCount; i++) {
      const tile = tiles[i]
      if (!tile) continue
      if (await this.setKey(i, tile)) written++
    }
    if (written > 0) await this.#device.write(CMD.flush())
    return written
  }

  invalidate(): void {
    this.#onScreen.fill(null)
  }

  async setBrightness(percent: number): Promise<void> {
    this.#assertOpen()
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    await this.#device.write(CMD.brightness(clamped))
    await this.#device.write(CMD.flush())
  }

  async clear(): Promise<void> {
    if (this.#closed) return
    await this.#device.write(CMD.clearAll())
    await this.#device.write(CMD.flush())
    this.#onScreen.fill(null)
  }

  /** Same contract as Deck.onError: must always be attached, see deck.ts. */
  onError(handler: (error: Error) => void): void {
    this.#device.on('error', (err: unknown) => {
      handler(err instanceof Error ? err : new Error(String(err)))
    })
  }

  /**
   * Handle key releases. Every input report from this device, including real
   * button reports, starts with the same "ACK\0\0OK" header (confirmed live:
   * button presses during a read probe came back as
   * `41 43 4b 00 00 4f 4b 00 00 <key> <state>`) — it is not a marker that
   * distinguishes a command acknowledgement from a button event, it is just
   * how this device frames all of its input. An earlier version of this
   * filtered it out on the wrong assumption that it meant "this is an ack,
   * not a press", which silently ate every button press. Byte 9 is the
   * 1-based key index in raster order (not remapped the way image writes
   * are, see module doc), byte 10 is 1 for down / 0 for up.
   */
  onKeyUp(handler: (visualIndex: number) => void): void {
    this.#device.on('data', (buf: Buffer) => {
      if (buf.length < 11) return
      const deviceKeyOneBased = buf[9] ?? 0
      const state = buf[10] ?? 0
      if (deviceKeyOneBased < 1 || deviceKeyOneBased > this.keyCount) return
      if (state !== 0) return // only fire on release, like deck.ts
      handler(deviceKeyOneBased - 1)
    })
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.clear()
    } catch {
      // Already unplugged; nothing to blank.
    }
    try {
      await this.#device.close()
    } catch {
      // Ditto.
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  #assertOpen(): void {
    if (this.#closed) throw new AmpGd6UnavailableError('device has been shut down')
  }
}

/** True if an Ampligame D6 is currently attached. */
export async function ampGd6Present(): Promise<boolean> {
  const found = await devicesAsync()
  return found.some(
    (d) => d.vendorId === AMPGD6_VID && d.productId === AMPGD6_PID && d.usagePage === USAGE_PAGE,
  )
}

/** Nearest-neighbour resize of a WxH RGB buffer to a different WxH. */
export function resizeRgb(
  src: Buffer,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Buffer {
  if (srcW === dstW && srcH === dstH) return src
  const out = Buffer.allocUnsafe(dstW * dstH * 3)
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH))
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW))
      const sIdx = (sy * srcW + sx) * 3
      const dIdx = (y * dstW + x) * 3
      out[dIdx] = src[sIdx] as number
      out[dIdx + 1] = src[sIdx + 1] as number
      out[dIdx + 2] = src[sIdx + 2] as number
    }
  }
  return out
}
