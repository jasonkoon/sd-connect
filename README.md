# sd-connect

Drive an Elgato Stream Deck MK.2 directly — no Elgato software — to show the live
status of every agent across all [herdr](https://github.com/) sessions.

Each key shows one agent as a status colour bar plus its repo and session name.
Pressing a key jumps to that agent: it raises the terminal window for that herdr
session and focuses the right workspace, tab and pane.

The same display is also served at <http://127.0.0.1:8787> (configurable) for
when the deck is not plugged in — same keys, same pixels, and clicking one jumps
just like pressing it does.

See [PLAN.md](./PLAN.md) for the full design and build order.

## Requirements

- macOS with a Stream Deck MK.2
- [Node](https://nodejs.org) **23.6+**, installed via Homebrew (see step 1)
- The Elgato Stream Deck app **not** running — it claims the USB device exclusively

Node 23.6 is a hard floor: the scripts run `.ts` files directly and rely on
unflagged type stripping. Node 22.x fails with
`ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`.

## Setup

Run these once per machine. Takes a couple of minutes.

### 1. Install Node via Homebrew

```sh
brew install node
```

Use Homebrew even if you already have node from nvm, fnm or similar. launchd
needs an absolute path to the binary, and version managers upgrade and prune
their installs — which breaks startup at login later, with no obvious cause.
The installer looks for `/opt/homebrew/bin/node`, then `/usr/local/bin/node`.

### 2. Install dependencies

```sh
cd sd-connect
npm install
```

### 3. Check it works before installing the daemon

```sh
npm run watch -- --once   # prints your agents as text, no deck needed
npm run smoke             # lights up the deck, then blanks it
```

`watch` failing means herdr cannot be reached. `smoke` exit codes: `2` means no
deck was found, `3` means something else already has it open — usually the
launch agent from a previous install, or the Elgato app.

Only one process can hold the deck at a time, so stop the agent before running
`smoke`, `preview` or `npm start` by hand:

```sh
./scripts/uninstall-launchd.sh
```

### 4. Install the launch agent

```sh
./scripts/install-launchd.sh
```

This starts it now and at every login. It preflights node and the native
modules, so a broken setup fails here with an explanation rather than silently
at next login.

### 5. Approve the Accessibility prompt

Press any key on the deck. macOS will ask for Accessibility permission, because
jumping to an agent raises the terminal window via AppleScript. Approve it.

Until you do, presses still focus the pane inside herdr but the window will not
come forward, and the log shows:

```
osascript is not allowed assistive access. (-1719)
```

If you miss the prompt, grant it under
**System Settings → Privacy & Security → Accessibility**.

### 6. Optional: pin agents to fixed keys

See [Configuration](#configuration). Without config, agents flow into keys
automatically and everything still works.

### Check it is running

```sh
launchctl print gui/$(id -u)/com.jasonkoon.sd-connect | awk '/^\t(state|pid) =/'
tail -f ~/Library/Logs/sd-connect/sd-connect.log
```

Expect `state = running` and a pid. The log should end with `running; Ctrl-C to
stop`, or `no Stream Deck found; waiting for one to be plugged in` if the deck
is not connected — both are healthy.

### Updating

After changing code, re-run the installer. It is idempotent.

```sh
./scripts/install-launchd.sh
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

# The localhost viewer, for when the deck is not plugged in.
# Loopback only, no auth — do not expose this to the network.
# port: 1024-65535, overridden by --port. Default 8787.
[web]
enabled = true
port    = 8787

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

Exit codes: `2` no deck found, `3` the deck is open in another process (stop the
launch agent), `1` an assertion failed.

## Running it

```sh
npm start                # daemon: poll herdr, paint the deck, Ctrl-C to stop
npm start -- --once      # paint one frame and exit
npm start -- --verbose   # also log every repaint
npm start -- --no-web    # deck only, no web viewer
npm start -- --port 9000 # serve the viewer somewhere else
```

## The web viewer

Open <http://127.0.0.1:8787>. It shows the same 5x3 grid the deck shows and
updates as herdr changes. Clicking a key jumps to that agent exactly as pressing
it would.

### Which port

8787 is only the default. The port is chosen from, highest priority first:

| Source | Example | Notes |
| --- | --- | --- |
| `--port` | `npm start -- --port 9000` | Wins over everything. Handy for a one-off. |
| `web.port` in config | `port = 9000` under `[web]` | The persistent choice. |
| Built-in default | `8787` | Used when neither is set. |

Must be an integer from 1024 to 65535 — below 1024 needs root, which this never
runs as. An invalid value in either place is warned about and ignored rather
than being fatal, so a typo cannot stop the deck working.

The startup log always names the source, so you never have to guess:

```
[sd-connect] web viewer on http://127.0.0.1:9000 (port from --port)
```

Under launchd, `--port` is not in play, so it is whatever config says:

```sh
grep -A2 '\[web\]' ~/.config/sd-connect/config.toml
grep 'web viewer' ~/Library/Logs/sd-connect/sd-connect.log | tail -1
```

This is the answer to "the deck is not plugged in right now". The daemon builds
one frame and fans it out, so the viewer is showing the actual frame — including
overflow and pinned-but-dark keys — rather than a second opinion about what the
deck might look like. With no deck attached, layout falls back to the MK.2's 15
keys so there is still something to look at.

It is served on loopback only. There is no authentication, a click focuses
windows, and repo and session names are visible, so it must not be exposed to
the network. Do not port-forward it.

Turn it off with `--no-web`, or permanently:

```toml
[web]
enabled = false
port    = 8787
```

If the port is already taken the viewer logs that and disables itself; the deck
carries on working. That is the usual sign the launch agent is already running.

Because it needs no hardware, it is also the easiest way to check the herdr side
is healthy: `npm start -- --no-web` plus `npm run watch` covers the text case,
and the viewer covers the visual one.

## The launch agent

```sh
./scripts/install-launchd.sh     # install, or reinstall after a code change
./scripts/uninstall-launchd.sh   # remove it
tail -f ~/Library/Logs/sd-connect/sd-connect.log
```

The agent is `com.jasonkoon.sd-connect`: RunAtLoad plus KeepAlive, so it starts
at login and comes back if it dies. Pass `--node /path/to/node` to override the
interpreter.

Logs are never rotated, so per-frame repaints are only logged under
`--verbose`. Key presses and failures are always logged.

### Using this on more than one machine

The daemon opens whichever Stream Deck is attached when it looks — no serial
number or USB path is baked in anywhere — so the same checkout works on several
machines with different physical decks, as long as they are the same model.
Run the [Setup](#setup) steps once on each.

Nothing machine-specific is committed. The plist is generated at install time
from `launchd/*.plist.template` with that machine's project and node paths, and
`~/.config/sd-connect/config.toml` lives outside the repo, so pins can differ
per machine (home and work rarely have the same repos checked out).

**No deck attached is fine.** The daemon starts, logs `no Stream Deck found;
waiting for one to be plugged in`, and keeps polling herdr. When a deck appears
it connects within about two seconds and paints the current state. Verified by
starting with the deck unplugged and then plugging it in. So a laptop that moves
between a deck at home and a deck at work needs no intervention: log in without
one, plug in whichever is there, and it picks it up.

Meanwhile the [web viewer](#the-web-viewer) still shows everything and presses
still work, so an unplugged deck costs you the hardware, not the tool.

**Different models would need work.** Key count already adapts, but tile
rendering hardcodes 72x72. An XL (8x4 at 96px) or Mini (3x2 at 80px) would throw
a RangeError on every write. Making `ICON_SIZE` come from the opened device is
the fix if that ever matters.

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
  main.ts           the daemon: poller -> layout -> renderer -> sinks
  frame.ts          a rendered frame, and the Sink interface
  config.ts         ~/.config/sd-connect/config.toml, validated
  config.test.ts    config validation, notably [web]
  layout.ts         pins, auto-flow, overflow eviction
  focus.ts          key press -> raise window + herdr agent.focus
  focus.test.ts     focus behaviour and its failure modes
  layout.test.ts    layout and config
  sinks/
    deck-sink.ts    the deck: USB handle, hotplug, key presses
    web/
      server.ts     localhost viewer: PNG tiles, SSE push, click to jump
      page.ts       the viewer page, inlined so launchd needs no asset path
      server.test.ts HTTP surface, press routing, port conflicts
  expect.ts         tiny expect() shim over node:assert
  render/
    theme.ts        colours, fonts, bar height
    text.ts         measured fitting: shrink, wrap, then truncate
    tile.ts         Slot -> 72x72x3 RGB, with an LRU cache
    png.ts          RGB -> PNG, nearest-neighbour (shared by dump and web)
    dump.ts         sample tiles as PNGs + contact sheet
    preview.ts      sample tiles on real hardware
    tile.test.ts    fit and cache behaviour
```

## Tests

```sh
npm test
```
