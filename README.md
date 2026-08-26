# sd-connect

Drive an Elgato Stream Deck MK.2, or a Fifine Ampligame D6, directly — no
vendor software — to show the live status of every Pi and Claude Code agent
across all [herdr](https://github.com/) sessions, Warp terminal windows, and
standalone terminal sessions.

Each key shows one agent as a status colour bar plus its repo and session name.
Pressing a key jumps to that agent: it raises the terminal window for that
session and focuses the right workspace, tab and pane.

The same display is also served at <http://127.0.0.1:8787> (configurable) for
when the deck is not plugged in — same keys, same pixels, and clicking one jumps
just like pressing it does.

See [PLAN.md](./PLAN.md) for the full design and build order.

## Requirements

- macOS with a Stream Deck MK.2, a Fifine Ampligame D6, or both
- [Node](https://nodejs.org) **23.6+**, installed via Homebrew (see step 1)
- The Elgato Stream Deck app **not** running — it claims the USB device exclusively
  (the D6 has no equivalent official Mac app to worry about)

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
# session can be a herdr session name ("zephyr"), "warp", "claude", or "pi".
# Keys are numbered left to right, top to bottom: 0-4, 5-9, 10-14.
# A pinned key stays dark when that agent is not running.
[[pins]]
key     = 0
session = "zephyr"
cwd     = "/Users/you/dev/sd-connect"

[[pins]]
key     = 1
session = "warp"
cwd     = "/Users/you/dev/git-agent"

[[pins]]
key     = 2
session = "claude"
cwd     = "/Users/you/dev/my-project"
```

Unpinned agents flow into whatever keys are left, in a stable order (session,
then workspace) so they do not shuffle when a status changes. If there are more
agents than keys, the least interesting are dropped first (unknown, then idle,
then working) so `blocked` and `done` always survive, and the last key becomes a
`+N more` tile.

### Macro keys

Any key can instead be a **macro**: a fixed key that runs an action when
pressed, rather than focusing an agent. Macros live on the same grid as pins
and auto-flow agents, and, like pins, they are reserved — an agent never flows
into a macro key and it is never evicted by overflow. `[[pins]]` and
`[[macros]]` cannot share a key.

```toml
# A macro key: label is drawn on the tile, color is the accent bar (optional,
# defaults to the theme's macro color).
[[macros]]
key   = 14
label = "Deploy"
color = "#8b5cf6"

[macros.action]
type = "command"        # command is the only implemented type
run  = "/Users/you/bin/deploy"   # any shell line, run via /bin/zsh -c
```

`command` actions run fire-and-forget detached: a press never blocks the poll
loop or the next press. A repeated press while a macro is still running is
ignored (per macro, so two different macros run independently). The exit code
is logged. `url` and `app` action types are recognised and validated but not yet
implemented — a macro configured with one logs a warning on press.

## Pressing keys

A press jumps to that agent:

- **For herdr sessions:**
  1. Raise the terminal window whose title mentions that herdr session (Ghostty).
  2. Call herdr's `agent.focus`, which moves workspace, tab and pane focus at once.

- **For Warp or standalone agents (Claude Code / Pi):**
  1. Raise the terminal window matching that agent's repository.

Both herdr steps are needed because `agent.focus` alone moves focus *inside* a
session but does not touch the window server, so focusing a `canaries` agent
while the `zephyr` window is frontmost changes nothing you can see.

Window raising uses AppleScript UI scripting against Ghostty or Warp. That means
it depends on:

- Accessibility permission for whatever runs the daemon
- a terminal window matching the session name (herdr) or repo name (Warp)

If the window cannot be found, herdr presses still focus inside herdr and log a
warning, so it degrades rather than failing outright. Set `raise_window = false`
to skip window raising entirely.

Presses act on key *release*, so holding a key does one thing rather than
repeating, and overlapping presses are ignored while a jump is in flight.
Pressing an empty or `+N more` key does nothing.

## Watching agents (no hardware needed)

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
   1 o git-agent         idle    warp/75139
   2 o zephyr_cloudflow  idle    zephyr/w1:p1
   3 v portal            done    zephyr/w2:p1
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

### Hotkey

`scripts/viewer.sh` opens the viewer as a standalone Chrome window — no tabs, no
address bar — and toggles it: press once to summon, again to dismiss. Bound to a
key, checking on your agents costs one keystroke each way.

```sh
./scripts/viewer.sh          # toggle
./scripts/viewer.sh show     # always raise, never hide
./scripts/viewer.sh --port N # override the port
```

It finds the port the same way the daemon does, reuses an existing window rather
than piling up duplicates, and if nothing is listening it says so (exit 3) plus
a notification, instead of opening a browser on a connection error.

To bind it with macOS Shortcuts, which needs nothing installed:

```sh
./scripts/make-shortcut.sh                        # writes shortcuts/SD-Connect-Viewer.shortcut
open shortcuts/SD-Connect-Viewer.shortcut         # click "Add Shortcut" to import
```

Then in Shortcuts select **SD-Connect-Viewer**, open the details pane (the `i`,
top right) and set a **Keyboard Shortcut**. Something like `⌃⌥⌘D` is unlikely to
clash. The first run asks permission to run a shell script; approve it once.

Two things worth knowing. The shortcut stores an absolute path to `viewer.sh`,
so rerun `make-shortcut.sh` if you move the checkout. And Shortcuts hotkeys have
a noticeable lag — if that grates, Hammerspoon binds the same script instantly:

```lua
hs.hotkey.bind({"ctrl", "alt", "cmd"}, "D", function()
  hs.task.new(os.getenv("HOME") .. "/dev/koon/sd-connect/scripts/viewer.sh", nil):start()
end)
```

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

**No deck attached is fine.** The daemon starts, logs `no deck found; waiting
for one to be plugged in`, and keeps polling herdr. When a deck appears it
connects within about two seconds and paints the current state. Verified by
starting with nothing attached and then plugging one in. So a laptop that moves
between a deck at home and a deck at work needs no intervention: log in without
one, plug in whichever is there, and it picks it up.

Meanwhile the [web viewer](#the-web-viewer) still shows everything and presses
still work, so an unplugged deck costs you the hardware, not the tool.

**A Stream Deck MK.2 and a D6 can both be plugged in at once.** Both are
always watched; whichever is present writes real pixels, and the daemon paints
both if both are there. There is no config to choose one — see
[Fifine Ampligame D6 support](#fifine-ampligame-d6-support) for why that is
safe.

**Different Stream Deck models would need work.** Key count already adapts,
but tile rendering hardcodes 72x72. An XL (8x4 at 96px) or Mini (3x2 at 80px)
would throw a RangeError on every write. Making `ICON_SIZE` come from the
opened device is the fix if that ever matters.

**If you reinstall the Elgato Stream Deck software**, disable its launch agent
(`~/Library/LaunchAgents/com.elgato.StreamDeck.plist`). It claims the USB device
exclusively at login and sd-connect will not be able to open the deck. The D6
has no equivalent official Mac software to worry about.

## Fifine Ampligame D6 support

The D6 looks like a Stream Deck MK.2 clone — same 5x3 grid of LCD keys — but it
is not one at Elgato's protocol level. It is Mirabox/Ajazz reference-design
hardware (the informally-named "mirajazz" protocol), talked to directly over
raw HID in `src/ampgd6.ts`, entirely independent of `@elgato-stream-deck/node`.

Everything below was confirmed against real hardware, not assumed from
documentation — see `src/ampgd6.ts`'s header for the full account, and
`tools/mirajazz-probe.cjs` / `tools/mirajazz-grid-probe.cjs` for the throwaway
scripts that did it.

**The USB ID that actually matters: `3142:0060`.** The two prior open-source
implementations of this device — Phoenix557/FifineOpenSource and
3dRikal/opendeck-ampgd6 — both target PID `0x0007` and, on seeing `0x0060` go
completely silent under their protocol, concluded it must be unactivated "demo"
firmware that needs Fifine's official Windows/Mac app run once to unlock. That
theory is wrong for this hardware. The real cause: `0x0060` is protocol
**v2** (1024-byte HID packets), not v1 (512 bytes), and every command sent at
the wrong packet size is silently ignored by the firmware rather than
rejected. The fix came from an open, unmerged PR — opendeck-ampgd6#1 — which we
found and confirmed live. No official software install, activation step, or
waiting is required; it works from a cold boot.

**Images are 95x95 JPEG, rotated 180 degrees, on a different key index than
they report presses on.** sd-connect's renderer produces 72x72 RGB for every
other sink, so `ampgd6.ts` resizes and rotates internally — callers never need
to know this is different hardware. Two independent asymmetries, both
confirmed with an asymmetric test tile (a symmetric one would have hidden
them):

| | Image writes | Button presses |
| --- | --- | --- |
| Indexing | Remapped: visual key N → device index `[10,11,12,13,14,5,6,7,8,9,0,1,2,3,4][N]` | Not remapped: raw index in raster order, 1-based |
| Orientation | Rot180 | n/a |

**The daemon does not need to know which hardware you have.** Both the
Stream Deck sink and the D6 sink are always started; each is a no-op until its
own device shows up on USB, and each watches independently for its own
hotplug/unplug. This was a deliberate choice over an explicit `[device] kind =`
config setting — see `main.ts` for the reasoning.

**Verified live, end to end:** brightness, button press/release events, image
writes (batched, single flush), clear-all, disconnect detection on unplug
(`hid_read_timeout`, caught rather than crashing), and reconnect-with-repaint
on replug — all against real hardware, not simulated.

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
  viewer.sh         toggle the web viewer; bind this to a hotkey
  make-shortcut.sh  build a signed macOS Shortcut wrapping viewer.sh
shortcuts/          the generated .shortcut, ready to import
src/
  types.ts          domain types, status priority, agent keys
  deck.ts           Stream Deck device lifecycle, diffed key writes
  ampgd6.ts         Fifine Ampligame D6 device lifecycle, raw HID protocol
  shutdown.ts       signal handling, cleanup with a watchdog
  smoke.ts          step 1 hardware verification
  herdr/
    protocol.ts     NDJSON request/response over the Unix socket
    sessions.ts     discover sessions, prove liveness with a ping
    poller.ts       poll agent.list + Warp scanner, emit only real changes
    watch.ts        headless view of the merged model
    herdr.test.ts   protocol, discovery and polling, vs a fake server
  warp/
    discover.ts     discover pi agents in Warp, parse session state, CWD caching
    discover.test.ts process matching, session state parsing, CWD resolution
  main.ts           the daemon: poller -> layout -> renderer -> sinks
  frame.ts          a rendered frame, and the Sink interface
  config.ts         ~/.config/sd-connect/config.toml, validated
  config.test.ts    config validation, notably [web]
  layout.ts         pins, macros, auto-flow, overflow eviction
  macros.ts         run macro actions (command; url/app reserved)
  focus.ts          key press -> raise window + herdr agent.focus
  focus.test.ts     focus behaviour and its failure modes
  layout.test.ts    layout and config
  sinks/
    deck-sink.ts    the Stream Deck: USB handle, hotplug, key presses
    ampgd6-sink.ts  the D6: USB handle, hotplug, key presses
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
