/**
 * Tests for the pure, hardware-independent parts of ampgd6.ts: the key remap
 * and the resize used before rotation/JPEG encoding. Everything else in this
 * module (open, write, read) was verified against real hardware instead, the
 * same convention deck.ts follows — see PLAN.md phase 5.
 */

import { describe, test } from 'node:test'
import { expect } from './expect.ts'
import { AMPGD6_KEY_COUNT, IMAGE_KEY_MAP, resizeRgb } from './ampgd6.ts'

describe('IMAGE_KEY_MAP', () => {
  test('has one entry per key', () => {
    expect(IMAGE_KEY_MAP).toHaveLength(AMPGD6_KEY_COUNT)
  })

  test('is a permutation of every device index, no duplicates or gaps', () => {
    const sorted = [...IMAGE_KEY_MAP].sort((a, b) => a - b)
    expect(sorted).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })

  test('matches the physical layout confirmed on real hardware', () => {
    // Painting all 15 keys with their raw device index and reading the
    // physical grid back gave: top row 10-14, middle row 5-9, bottom row 0-4.
    // Visual index 0 is top-left, so visual 0..4 (top row) must map to
    // device 10..14.
    expect(IMAGE_KEY_MAP.slice(0, 5)).toEqual([10, 11, 12, 13, 14])
    expect(IMAGE_KEY_MAP.slice(5, 10)).toEqual([5, 6, 7, 8, 9])
    expect(IMAGE_KEY_MAP.slice(10, 15)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('resizeRgb', () => {
  test('returns the same buffer when sizes already match', () => {
    const src = Buffer.from([1, 2, 3, 4, 5, 6])
    expect(resizeRgb(src, 1, 2, 1, 2)).toBe(src)
  })

  test('upscales a 1x1 tile to fill every pixel with the same colour', () => {
    const src = Buffer.from([10, 20, 30])
    const out = resizeRgb(src, 1, 1, 3, 3)
    expect(out).toHaveLength(3 * 3 * 3)
    for (let i = 0; i < out.length; i += 3) {
      expect(out[i]).toBe(10)
      expect(out[i + 1]).toBe(20)
      expect(out[i + 2]).toBe(30)
    }
  })

  test('preserves corner pixels when upscaling a 2x2 tile', () => {
    // top-left red, top-right green, bottom-left blue, bottom-right white
    const src = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
    const out = resizeRgb(src, 2, 2, 4, 4)
    const pixelAt = (x: number, y: number) => {
      const i = (y * 4 + x) * 3
      return [out[i], out[i + 1], out[i + 2]]
    }
    expect(pixelAt(0, 0)).toEqual([255, 0, 0])
    expect(pixelAt(3, 0)).toEqual([0, 255, 0])
    expect(pixelAt(0, 3)).toEqual([0, 0, 255])
    expect(pixelAt(3, 3)).toEqual([255, 255, 255])
  })

  test('produces exactly width*height*3 bytes for the real deck->device sizes', () => {
    const src = Buffer.alloc(72 * 72 * 3, 128)
    const out = resizeRgb(src, 72, 72, 95, 95)
    expect(out).toHaveLength(95 * 95 * 3)
  })
})
