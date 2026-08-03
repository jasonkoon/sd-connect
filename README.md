# sd-connect

Drive an Elgato Stream Deck MK.2 directly — no Elgato software — to show the live
status of every agent across all [herdr](https://github.com/) sessions.

Phase 1 is a read-only status wall: each key shows one agent as a status colour
bar plus its repo and session name. Keys are inert for now; press actions come
later.

See [PLAN.md](./PLAN.md) for the full design and build order.

## Requirements

- macOS with a Stream Deck MK.2 attached
- [Bun](https://bun.sh) 1.3+
- The Elgato Stream Deck app **not** running (it claims the USB HID device)

## Setup

```sh
bun install
```

## Smoke test

Verifies the device opens, renders, diffs redundant writes, and shuts down
cleanly. Paints one key per status colour, then blanks the panel.

```sh
bun run smoke
```

Expected output:

```
[smoke] opened original-mk2, 15 keys
[smoke] first paint wrote 15 keys (expected 15)
[smoke] identical repaint wrote 0 keys (expected 0)
[smoke] one-key change wrote 1 keys (expected 1)
[smoke] PASS — shutting down (blank panel, no native close())
```

Exit code `2` means no deck was found. Exit `1` means an assertion failed.

## Platform notes

Two things about this stack are non-obvious and cost real debugging time.

**`streamDeck.close()` segfaults Bun.** On Bun 1.3.2 / macOS 26.6 with
`@elgato-stream-deck/node` 7.6.3, calling `close()` panics the process with
`Segmentation fault at address 0x20` inside the native addon teardown. Open,
render, `setBrightness` and `clearPanel` are all fine. `Deck.shutdown()`
therefore blanks the panel and lets process exit reclaim the descriptor. There is
a large comment in `src/deck.ts` explaining this — please do not "tidy it up" by
adding `close()`, or shutdown will start crashing.

**Tiles must be RGB, not RGBA.** `fillKeyBuffer` wants exactly `72*72*3` bytes
with `{ format: 'rgb' }`. If you render with sharp, you need `.removeAlpha()`
before `.raw()`, otherwise you get a `RangeError` about buffer length.

Also note `device.NUM_KEYS` and `device.ICON_SIZE` read back as `undefined` under
Bun, so `openDeck()` counts buttons from `device.CONTROLS` instead.

## Layout

```
src/
  types.ts     domain types, status priority, agent keys
  deck.ts      device lifecycle, diffed key writes
  shutdown.ts  signal handling, cleanup with a watchdog
  smoke.ts     step 1 hardware verification
```
