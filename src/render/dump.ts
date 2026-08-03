/**
 * Render sample tiles to PNG so the key design can be judged without squinting
 * at 72px hardware.
 *
 *   bun run dump            # writes tmp-tiles/
 *   bun run dump --scale 8
 *
 * Produces one PNG per sample plus a contact sheet laid out as the real 5x3
 * deck, which is the only way to tell whether it reads at a glance.
 */

import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { mkdir, writeFile } from 'node:fs/promises'
import { ICON_SIZE, KEY_COLUMNS, KEY_ROWS } from '../deck.ts'
import type { Agent, AgentStatus, Slot } from '../types.ts'
import { TileRenderer } from './tile.ts'

const OUT_DIR = 'tmp-tiles'

function agent(
  repo: string,
  session: string,
  status: AgentStatus,
  paneId = 'w1:p1',
): Agent {
  return {
    session,
    paneId,
    workspaceId: paneId.split(':')[0] ?? 'w1',
    status,
    cwd: `/Users/jason.koon/dev/${repo}`,
    repo,
    agent: 'pi',
    focused: false,
  }
}

/** Real repo names from the live herdr sessions, plus deliberate stress cases. */
const SAMPLES: Array<{ name: string; slot: Slot }> = [
  { name: '01-portal-idle', slot: { kind: 'agent', agent: agent('portal', 'zephyr', 'idle') } },
  { name: '02-sd-connect-working', slot: { kind: 'agent', agent: agent('sd-connect', 'zephyr', 'working') } },
  { name: '03-zephyr_cloudflow-blocked', slot: { kind: 'agent', agent: agent('zephyr_cloudflow', 'zephyr', 'blocked') } },
  { name: '04-canaries-done', slot: { kind: 'agent', agent: agent('canaries', 'canaries', 'done') } },
  { name: '05-unknown', slot: { kind: 'agent', agent: agent('bcc_supabase', 'zephyr', 'unknown') } },
  // Stress: no separator to wrap on, must truncate.
  { name: '06-longnoseparator', slot: { kind: 'agent', agent: agent('supercalifragilistic', 'zephyr', 'idle') } },
  // Stress: very long session name.
  { name: '07-long-session', slot: { kind: 'agent', agent: agent('api', 'a-very-long-session-name', 'working') } },
  // Stress: short name should render large.
  { name: '08-short', slot: { kind: 'agent', agent: agent('db', 'zephyr', 'idle') } },
  { name: '09-hyphen-wrap', slot: { kind: 'agent', agent: agent('winning-edge-coaching', 'koon', 'done') } },
  { name: '10-overflow', slot: { kind: 'overflow', count: 4 } },
  { name: '11-empty', slot: { kind: 'empty' } },
]

function parseScale(): number {
  const i = process.argv.indexOf('--scale')
  if (i === -1) return 6
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 6
}

/** RGB buffer -> a 1:1 canvas holding those pixels. */
function toCanvas(rgb: Buffer): Canvas {
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

/** RGB buffer -> PNG, upscaled nearest-neighbour so pixels stay crisp. */
function toPng(rgb: Buffer, scale: number): Buffer {
  const size = ICON_SIZE * scale
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(toCanvas(rgb), 0, 0, size, size)
  return canvas.toBuffer('image/png')
}

async function main(): Promise<void> {
  const scale = parseScale()
  const renderer = new TileRenderer()
  await mkdir(OUT_DIR, { recursive: true })

  for (const sample of SAMPLES) {
    const rgb = renderer.render(sample.slot, { pinnedEmpty: sample.name.includes('empty') })
    await writeFile(`${OUT_DIR}/${sample.name}.png`, toPng(rgb, scale))
  }

  // Contact sheet: the 5x3 grid with a gap, mimicking the physical bezel.
  const gap = 6
  const cell = ICON_SIZE * scale
  const sheet = createCanvas(
    KEY_COLUMNS * cell + (KEY_COLUMNS + 1) * gap,
    KEY_ROWS * cell + (KEY_ROWS + 1) * gap,
  )
  const sctx = sheet.getContext('2d')
  sctx.fillStyle = '#2a2a2e'
  sctx.fillRect(0, 0, sheet.width, sheet.height)
  sctx.imageSmoothingEnabled = false

  for (let i = 0; i < KEY_COLUMNS * KEY_ROWS; i++) {
    const sample = SAMPLES[i]
    const slot: Slot = sample?.slot ?? { kind: 'empty' }
    const rgb = renderer.render(slot)
    // Composite the canvas directly. Going via PNG and `Image.src = buffer`
    // silently produced a blank sheet: the decode is not synchronous, so every
    // drawImage ran against an empty image.
    const col = i % KEY_COLUMNS
    const row = Math.floor(i / KEY_COLUMNS)
    sctx.drawImage(toCanvas(rgb), gap + col * (cell + gap), gap + row * (cell + gap), cell, cell)
  }

  await writeFile(`${OUT_DIR}/00-contact-sheet.png`, sheet.toBuffer('image/png'))

  const { hits, misses, size } = renderer.stats
  console.log(`[dump] wrote ${SAMPLES.length + 1} files to ${OUT_DIR}/ at ${scale}x`)
  console.log(`[dump] cache: ${hits} hits, ${misses} misses, ${size} entries`)
}

await main()
