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

## Previewing the key design

```sh
bun run dump          # writes tmp-tiles/*.png, including a 5x3 contact sheet
bun run dump --scale 8
bun run preview       # pushes the same samples to the real deck, Ctrl-C to exit
```

`dump` is for iterating on layout without hardware; `preview` is the check that
matters, because a 6x PNG flatters a 72px LCD.

## Watching herdr (no hardware needed)

```sh
bun run watch          # stream agent status as it changes
bun run watch --once   # one snapshot, then exit
```

Example:

```
[watch] sessions dir: /Users/you/.config/herdr/sessions
[watch]   canaries: live
[watch]   zephyr: live

[12:28:01 PM] 6 agent(s)
   0 * canaries          working canaries/w1:p2
   1 o zephyr_cloudflow  idle    zephyr/w1:p1
   2 v portal            done    zephyr/w2:p1
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
with `{ format: 'rgb' }`, so the renderer drops the alpha channel that canvas
gives it. Passing RGBA throws a `RangeError` about buffer length.

**sharp cannot render text, so we do not use it.** sharp 0.35 rasterises SVG
with resvg, which ships with no font backend: `<text>` elements silently
disappear, and a test tile came back with 0 light pixels where the label should
have been. `sharp.text()` is also unavailable (`VipsOperation: class "text" not
found`). We use `@napi-rs/canvas` instead, which sees all 311 system font
families and hands back raw pixels directly, so sharp is not a dependency at
all. If you are tempted to "simplify" this back to SVG, you will get blank keys.

Also note `device.NUM_KEYS` and `device.ICON_SIZE` read back as `undefined` under
Bun, so `openDeck()` counts buttons from `device.CONTROLS` instead.

## herdr API notes

**We poll; we do not subscribe.** herdr has an `events.subscribe` method, and
subscribing to it for agent status looks obvious. It does not work. Measured:
prompting an idle agent drove a real `idle -> working -> done` transition, a
poller saw every step, and a subscription to all 23 no-argument event types
emitted nothing for that pane. `pane.updated` fires only on layout-ish changes,
and its payload was observed reporting `idle` for a pane that `agent.list`
reported as `working`. `pane.agent_status_changed` requires a concrete
`pane_id`, so it is useless for discovery, and it did not fire either.

The stream is also noisy: about 14 events/sec while idle, nearly all
`pane_focused` / `workspace_focused` / `tab_focused` / `layout_updated`.

`agent.list` costs about 0.84ms including connection setup, so a ~400ms poll is
cheap and, unlike the event stream, correct.

**Request connections are single-shot.** The server answers one request then
closes; a second write on the same socket gets EPIPE. Only subscription
connections stay open.

## Layout

```
src/
  types.ts          domain types, status priority, agent keys
  deck.ts           device lifecycle, diffed key writes
  shutdown.ts       signal handling, cleanup with a watchdog
  smoke.ts          step 1 hardware verification
  herdr/
    protocol.ts     NDJSON request/response over the Unix socket
    sessions.ts     discover sessions, prove liveness with a ping
    poller.ts       poll agent.list, emit only real changes
    watch.ts        headless view of the merged model
    herdr.test.ts   protocol, discovery and polling, vs a fake server
  render/
    theme.ts        colours, fonts, bar height
    text.ts         measured fitting: shrink, wrap, then truncate
    tile.ts         Slot -> 72x72x3 RGB, with an LRU cache
    dump.ts         sample tiles as PNGs + contact sheet
    preview.ts      sample tiles on real hardware
    tile.test.ts    fit and cache behaviour
```

## Tests

```sh
bun test
```
