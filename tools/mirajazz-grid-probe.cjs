/**
 * Paints all 15 keys at once with their raw device index, to map physical
 * layout without guessing. Used once, live, against a Fifine Ampligame D6
 * (3142:0060) on 2026-08-09 to derive the IMAGE_KEY_MAP now baked into
 * src/ampgd6.ts. Kept for the next device in this family whose key order
 * turns out to differ.
 *
 *   node tools/mirajazz-grid-probe.cjs
 */

const hid = require('node-hid')
const { createCanvas } = require('@napi-rs/canvas')

const VID = 0x3142
const PID = 0x0060
const PACKET_SIZE = 1024
const TILE_SIZE = 95
const KEY_COUNT = 15

function findDevice() {
  const all = hid.devices().filter((d) => d.vendorId === VID && d.productId === PID)
  const vendor = all.find((d) => d.usagePage === 0xffa0)
  if (!vendor) {
    console.error('no device found:', JSON.stringify(all, null, 1))
    process.exit(2)
  }
  return vendor
}

function cmd(...tail) {
  const buf = Buffer.alloc(PACKET_SIZE + 1, 0)
  Buffer.from([0x00, 0x43, 0x52, 0x54, 0x00, 0x00, ...tail]).copy(buf)
  return buf
}

const CMD = {
  wake: () => cmd(0x44, 0x49, 0x53),
  brightness: (pct) => cmd(0x4c, 0x49, 0x47, 0x00, 0x00, pct),
  flush: () => cmd(0x53, 0x54, 0x50),
  image: (key, len) => cmd(0x42, 0x41, 0x54, 0x00, 0x00, (len >> 8) & 0xff, len & 0xff, key + 1),
}

function write(device, buf) {
  device.write([...buf])
}

function writeImageData(device, data) {
  let sent = 0
  while (sent < data.length) {
    const take = Math.min(PACKET_SIZE, data.length - sent)
    const buf = Buffer.alloc(PACKET_SIZE + 1, 0)
    data.copy(buf, 1, sent, sent + take)
    device.write([...buf])
    sent += take
  }
}

function tileFor(index) {
  const c = createCanvas(TILE_SIZE, TILE_SIZE)
  const ctx = c.getContext('2d')
  const hue = (index * 360) / KEY_COUNT
  ctx.fillStyle = `hsl(${hue}, 70%, 45%)`
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 44px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(index), TILE_SIZE / 2, TILE_SIZE / 2)
  return c.toBuffer('image/jpeg', 90)
}

const info = findDevice()
console.log(`opening ${info.product} at ${info.path}`)
const device = new hid.HID(info.path)

write(device, CMD.wake())
write(device, CMD.brightness(70))

for (let i = 0; i < KEY_COUNT; i++) {
  const jpeg = tileFor(i)
  write(device, CMD.image(i, jpeg.length))
  writeImageData(device, jpeg)
  console.log(`queued key index ${i} (${jpeg.length} bytes)`)
}

write(device, CMD.flush())
console.log('flushed — read the grid, top-left to bottom-right, and report the numbers you see')
device.close()
