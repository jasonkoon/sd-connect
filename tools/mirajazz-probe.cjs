/**
 * Protocol probe for the Fifine Ampligame D6 (3142:0060) and the wider
 * Mirabox/Ajazz family it rebadges. Confirmed working against real hardware,
 * 2026-08-09; the finding lives in src/ampgd6.ts now, this stays as the tool
 * you reach for on the next rebadge with an unconfirmed PID.
 *
 *   node tools/mirajazz-probe.cjs read      listen for button reports (safe)
 *   node tools/mirajazz-probe.cjs init      send DIS+LIG init, then listen
 *   node tools/mirajazz-probe.cjs bright 60 set brightness
 *   node tools/mirajazz-probe.cjs image 0   paint one key with a solid colour
 *   node tools/mirajazz-probe.cjs clear     blank every key
 *
 * Separate from src/ on purpose: for an unconfirmed PID this is talking to
 * hardware on a protocol that is only inferred, so it must never be reachable
 * from the daemon.
 *
 * Protocol, from 4ndv/mirajazz (MIT), which reverse-engineered it:
 *   Every command is an output report starting 00 "CRT" 00 00, then a
 *   three-letter ASCII tag, padded to packet_size + 1 bytes.
 *     DIS          wake the display
 *     LIG 00 00 nn brightness, 0-100
 *     BAT hi lo k  announce an image of hi<<8|lo bytes for key k (1-based)
 *     STP          commit / flush
 *     CLE ... k    clear key k, 0xFF for all
 *     HAN          sleep
 *   Image bytes follow BAT as raw chunks of packet_size bytes, each prefixed
 *   with 00.
 *
 * PID 0x0060 was wrongly assumed to be unactivated "demo" firmware needing
 * Fifine's official app, because every command sent to it was silently
 * ignored. The real cause: it needs 1024-byte packets (protocol v2), not the
 * 512-byte v1 packets both published references for this model
 * (Phoenix557/FifineOpenSource, 3dRikal/opendeck-ampgd6) assumed. The fix came
 * from opendeck-ampgd6#1 (open, unmerged at the time). Default below matches
 * that; override with PACKET_SIZE for the next unconfirmed rebadge.
 */

const hid = require('node-hid')

const VID = 0x3142
const PID = 0x0060
const PACKET_SIZE = Number(process.env.PACKET_SIZE ?? 1024)

function findDevice() {
  const all = hid.devices().filter((d) => d.vendorId === VID && d.productId === PID)
  // The vendor collection (0xFFA0) is the one that takes commands. The keyboard
  // collection on the same device cannot be opened without Input Monitoring.
  const vendor = all.find((d) => d.usagePage === 0xffa0)
  if (!vendor) {
    console.error(`no device ${VID.toString(16)}:${PID.toString(16)} with usage page 0xFFA0`)
    console.error('found:', JSON.stringify(all, null, 1))
    process.exit(2)
  }
  return vendor
}

/** "CRT" command, padded to a full report. */
function cmd(...tail) {
  const buf = Buffer.alloc(PACKET_SIZE + 1, 0)
  // Leading 0x00 is the HID report id, which this device does not use.
  Buffer.from([0x00, 0x43, 0x52, 0x54, 0x00, 0x00, ...tail]).copy(buf)
  return buf
}

const CMD = {
  wake: () => cmd(0x44, 0x49, 0x53), // DIS
  brightness: (pct) => cmd(0x4c, 0x49, 0x47, 0x00, 0x00, Math.max(0, Math.min(100, pct))), // LIG
  flush: () => cmd(0x53, 0x54, 0x50), // STP
  clear: (key) => cmd(0x43, 0x4c, 0x45, 0x00, 0x00, 0x00, key === 0xff ? 0xff : key + 1), // CLE
  // BAT announces length and target key; the payload follows as chunks.
  image: (key, len) => cmd(0x42, 0x41, 0x54, 0x00, 0x00, (len >> 8) & 0xff, len & 0xff, key + 1),
}

function open() {
  const info = findDevice()
  console.log(`opening ${info.product} (${info.manufacturer}) at ${info.path}`)
  return new hid.HID(info.path)
}

function write(device, buf, label) {
  try {
    const n = device.write([...buf])
    console.log(`  ${label}: wrote ${n} bytes`)
    return true
  } catch (error) {
    console.log(`  ${label}: FAILED ${error.message.slice(0, 70)}`)
    return false
  }
}

/** Send image bytes as 512-byte chunks, each prefixed with a 0x00 report id. */
function writeImageData(device, data) {
  let sent = 0
  let chunks = 0
  while (sent < data.length) {
    const take = Math.min(PACKET_SIZE, data.length - sent)
    const buf = Buffer.alloc(PACKET_SIZE + 1, 0)
    data.copy(buf, 1, sent, sent + take)
    device.write([...buf])
    sent += take
    chunks++
  }
  console.log(`  image payload: ${data.length} bytes in ${chunks} chunk(s)`)
}

function listen(device, seconds) {
  console.log(`\nlistening ${seconds}s — PRESS BUTTONS NOW\n`)
  let count = 0
  device.on('data', (buf) => {
    count++
    // Reports are mostly zeros; show only the interesting head plus any
    // non-zero index, which is what identifies the key.
    const nonZero = []
    for (let i = 0; i < Math.min(buf.length, 32); i++) {
      if (buf[i] !== 0) nonZero.push(`${i}=0x${buf[i].toString(16).padStart(2, '0')}`)
    }
    console.log(`IN #${count} ${buf.length}b  [${nonZero.join(' ') || 'all zero'}]`)
    console.log(`   head: ${buf.subarray(0, 20).toString('hex')}`)
    const ascii = buf.subarray(0, 12).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
    console.log(`   ascii: ${ascii}`)
  })
  device.on('error', (err) => console.log('ERR', err.message))
  setTimeout(() => {
    console.log(`\n${count} report(s) received`)
    try {
      device.close()
    } catch {}
    process.exit(0)
  }, seconds * 1000)
}

const action = process.argv[2] ?? 'read'
const arg = process.argv[3]
const device = open()

switch (action) {
  case 'read':
    listen(device, Number(arg ?? 10))
    break

  case 'init':
    console.log('sending init (DIS then LIG):')
    write(device, CMD.wake(), 'DIS wake')
    write(device, CMD.brightness(0), 'LIG zero')
    write(device, CMD.brightness(70), 'LIG 70')
    listen(device, Number(arg ?? 10))
    break

  case 'bright': {
    const pct = Number(arg ?? 70)
    console.log(`setting brightness to ${pct}:`)
    write(device, CMD.wake(), 'DIS wake')
    write(device, CMD.brightness(pct), `LIG ${pct}`)
    write(device, CMD.flush(), 'STP flush')
    device.close()
    break
  }

  case 'clear':
    console.log('clearing all keys:')
    write(device, CMD.wake(), 'DIS wake')
    write(device, CMD.clear(0xff), 'CLE all')
    write(device, CMD.flush(), 'STP flush')
    device.close()
    break

  case 'image': {
    const key = Number(arg ?? 0)
    // A tiny solid-colour JPEG, so a wrong guess about size or orientation
    // still shows up unambiguously as "that key changed colour".
    const jpeg = require('node:fs').readFileSync(process.argv[4] ?? '/tmp/probe-tile.jpg')
    console.log(`painting key ${key} with ${jpeg.length} bytes of JPEG:`)
    write(device, CMD.wake(), 'DIS wake')
    write(device, CMD.brightness(70), 'LIG 70')
    write(device, CMD.image(key, jpeg.length), 'BAT header')
    writeImageData(device, jpeg)
    write(device, CMD.flush(), 'STP flush')
    device.close()
    break
  }

  default:
    console.error(`unknown action '${action}'`)
    process.exit(64)
}
