/**
 * Raw RGB tile -> PNG.
 *
 * Extracted from render/dump.ts once the web viewer needed the same conversion.
 * Both callers want nearest-neighbour scaling: the deck is a 72px display, and
 * smoothing an upscale would show a blurrier image than the hardware does.
 */

import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { ICON_SIZE } from '../deck.ts'

/** RGB buffer -> a 1:1 canvas holding those pixels. */
export function toCanvas(rgb: Buffer): Canvas {
  const canvas = createCanvas(ICON_SIZE, ICON_SIZE)
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(ICON_SIZE, ICON_SIZE)
  for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 4) {
    image.data[dst] = rgb[src] as number
    image.data[dst + 1] = rgb[src + 1] as number
    image.data[dst + 2] = rgb[src + 2] as number
    image.data[dst + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

/**
 * RGB buffer -> PNG, upscaled nearest-neighbour so pixels stay crisp.
 *
 * Scale 1 is the honest size and what the web viewer serves: the browser
 * upscales with `image-rendering: pixelated`, which is the same transform for
 * a ninth of the bytes.
 */
export function toPng(rgb: Buffer, scale = 1): Buffer {
  if (scale === 1) return toCanvas(rgb).toBuffer('image/png')
  const size = ICON_SIZE * scale
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(toCanvas(rgb), 0, 0, size, size)
  return canvas.toBuffer('image/png')
}
