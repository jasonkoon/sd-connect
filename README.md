# sd-connect

Drive an Elgato Stream Deck MK.2 directly — no Elgato software — to show the live
status of every agent across all [herdr](https://github.com/) sessions.

Each key shows one agent as a status colour bar plus its repo and session name.
Pressing a key jumps to that agent: it raises the terminal window for that herdr
session and focuses the right workspace, tab and pane.

See [PLAN.md](./PLAN.md) for the full design and build order.

## Requirements

- macOS with a Stream Deck MK.2 attached
- [Node](https://nodejs.org) 22.6+ (runs the TypeScript directly, no build step)
- The Elgato Stream Deck app **not** running (it claims the USB HID device)

## Setup

```sh
npm install
```

## Previewing the key design

```sh
npm run dump          # writes tmp-tiles/*.png, including a 5x3 contact sheet
npm run dump --scale 8
npm run preview       # pushes the same samples to the real deck, Ctrl-C to exit
```

`dump` is for iterating on layout without hardware; `preview` is the check that
matters, because a 6x PNG flatters a 72px LCD.

## Configuration

Optional, at `~/.config/sd-connect/config.toml`. A missing file means defaults;
a bad value is reported by name and ignored rather than being fatal.

```toml
brightness = 70
poll_interval_ms = 400

# Raise the terminal window when a key is pressed. Requires Accessibility
# permission. Set to false to keep presses purely inside herdr.
raise_window = true

[colors]
idle    = "#22c55e"
working = "#3b82f6"
blocked = "#ef4444"
done    = "#eab308"
unknown = "#6b7280"

# Pin an agent to a fixed key, identified by session + cwd.
# Keys are numbered left to right, top to bottom: 0-4, 5-9, 10-14.
# A pinned key stays dark when that agent is not running.
[[pins]]
key     = 0
session = "zephyr"
cwd     = "/Users/you/dev/sd-connect"
```

Unpinned agents flow into whatever keys are left, in a stable order (session,
then workspace) so they do not shuffle when a status changes. If there are more
agents than keys, the least interesting are dropped first (unknown, then idle,
then working) so `blocked` and `done` always survive, and the last key becomes a
`+N more` tile.

## Pressing keys

A press jumps to that agent, in two steps:

1. Raise the terminal window whose title mentions that herdr session.
2. Call herdr's `agent.focus`, which moves workspace, tab and pane focus at once.

Both steps are needed. `agent.focus` alone moves focus *inside* a session but
does not touch the window server, so focusing a `canaries` agent while the
`zephyr` window is frontmost changes nothing you can see. This was verified by
doing exactly that.

Step 1 is AppleScript UI scripting against Ghostty, matching the session name
against window titles (herdr names its client windows
`herdr session attach <name>`). That means it depends on:

- Accessibility permission for whatever runs the daemon
- a terminal whose window titles contain the session name

If the window cannot be found, the press still focuses inside herdr and logs a
warning, so it degrades rather than failing outright. Set `raise_window = false`
to skip step 1 entirely.

Presses act on key *release*, so holding a key does one thing rather than
repeating, and overlapping presses are ignored while a jump is in flight.
Pressing an empty or `+N more` key does nothing.

## Watching herdr (no hardware needed)

```sh
npm run watch          # stream agent status as it changes
npm run watch -- --once   # one snapshot, then exit
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
npm run smoke
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

## Running it

```sh
npm start                # daemon: poll herdr, paint the deck, Ctrl-C to stop
npm start -- --once      # paint one frame and exit
npm start -- --verbose   # also log every repaint
```

## Start at login

```sh
./scripts/install-launchd.sh     # install and start the launch agent
./scripts/uninstall-launchd.sh   # remove it
tail -f ~/Library/Logs/sd-connect/sd-connect.log
```

The installer is safe to re-run; use it to pick up code changes. It preflights
the node binary and the native modules, so a broken setup fails there with an
explanation rather than silently at next login.

**Node comes from Homebrew on purpose.** launchd needs an absolute path, and a
version-manager node (nvm, vite-plus, fnm) can be upgraded or pruned out from
under the agent — which breaks startup at login with no obvious cause. Override
with `--node /path/to/node` if you want something else.

**Accessibility permission is required for window raising.** The first time the
agent tries to raise a window, macOS prompts; approve it. A launch agent does not
inherit the permission your terminal has, so before approving you will see this
in the log and presses will focus the pane without bringing the window forward:

```
osascript is not allowed assistive access. (-1719)
```

**If you reinstall the Elgato Stream Deck software**, disable its launch agent
(`~/Library/LaunchAgents/com.elgato.StreamDeck.plist`). It claims the USB device
exclusively at login and sd-connect will not be able to open the deck.

## Platform notes

Several things about this stack are non-obvious and cost real debugging time.

**Why Node and not Bun.** This started on Bun. Bun segfaults
(`Segmentation fault at address 0x20`, inside node-hid's native teardown) both
when calling `streamDeck.close()` and, fatally, when the deck is unplugged while
the daemon is running — the process dies outright, so no reconnect logic can
ever run. Node 24 turns the same unplug into an ordinary catchable error
(`Cannot write to hid device: Device is disconnected`) and closes cleanly. Both
behaviours were verified on real hardware by physically unplugging the device.
Do not move this back to Bun without re-testing an unplug.

**Always attach a device error listener.** node-hid emits `error` from its read
loop when the deck goes away (`could not read from HID device`). An unhandled
`error` event on an EventEmitter is a fatal exception, so `Deck.onError()` exists
and the daemon always registers it. Without it, an unplug kills the process even
on Node.

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

Also note `device.NUM_KEYS` and `device.ICON_SIZE` read back as `undefined`, so
`openDeck()` counts buttons from `device.CONTROLS` instead.

**Node unlinks Unix socket files on `server.close()`.** Bun does not. This matters
for tests that need to simulate a stopped herdr session, which leaves its socket
file behind; see `staleSocket()` in the herdr tests for the rename trick that
reproduces it.

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
launchd/            plist template for the login agent
scripts/            install / uninstall the launch agent
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
  main.ts           the daemon: poller -> layout -> renderer -> deck
  config.ts         ~/.config/sd-connect/config.toml, validated
  layout.ts         pins, auto-flow, overflow eviction
  focus.ts          key press -> raise window + herdr agent.focus
  focus.test.ts     focus behaviour and its failure modes
  layout.test.ts    layout and config
  expect.ts         tiny expect() shim over node:assert
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
npm test
```
