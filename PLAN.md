# sd-connect — Phase 1 Plan

Drive an Elgato Stream Deck MK.2 directly (no Elgato software) to display the
live status of every agent across all herdr sessions.

## Verified facts (tested on this machine, not assumed)

**Hardware**
- Stream Deck MK.2 present on USB, `model: original-mk2`, serial `DL47L2A33731`.
- 15 buttons, 5x3 grid, each 72x72px, `feedbackType: lcd`.
- No Elgato software installed or running, so the HID device is free to claim.

**Bun + node-hid**
- `@elgato-stream-deck/node@7.6.3` installs under Bun 1.3.2 and a prebuilt
  `HID-darwin-arm64` binary exists, so no compile step is needed.
- `bun pm trust --all` reports a failure for the jpeg-turbo postinstall, but this
  is harmless: the deck opens, renders, and sets brightness fine.
- **`streamDeck.close()` segfaults Bun** (`panic: Segmentation fault at address 0x20`).
  Everything else works. Workaround: `clearPanel()` then `process.exit(0)`.
  This is the main platform risk and it has a clean workaround.
- `fillKeyBuffer` requires exactly `72*72*3` bytes with `{format:'rgb'}`;
  sharp needs `.removeAlpha().raw()`. Verified rendering 4 tiles to real hardware.

**herdr API**
- Unix socket per session: `~/.config/herdr/sessions/<name>/herdr.sock`.
  Sessions and their sockets are listed by `herdr session list`.
- Newline-delimited JSON. Request: `{id, method, params}`.
- `agent.list` returns per agent: `agent_status` (`idle|working|blocked|done|unknown`),
  `cwd`, `terminal_title`, `pane_id`, `tab_id`, `workspace_id`, `focused`, `agent`.
- `events.subscribe` takes `{subscriptions:[{type}]}` and replies
  `{"result":{"type":"subscription_started"}}`, then streams `{event, data}` lines.
- **Each request connection is single-shot.** After one request/response the
  server closes it; a second write gets EPIPE. Subscription connections are the
  exception and stay open. So polling means one short-lived connection per poll.
- **Status changes are NOT pushed. Phase 1 polls.** This overturns the original
  design. Measured directly: prompting an idle agent drove
  `idle -> working -> done`, a poller saw every transition, and a subscription to
  all 23 no-arg event types emitted nothing for that pane. `pane.updated` fires
  only on layout-ish changes and its payload can be stale (observed reporting
  `idle` for a pane that `agent.list` reported as `working`).
  `pane.agent_status_changed` additionally requires a concrete `pane_id`, so it
  cannot be used for discovery, and it did not fire either.
- The event stream is also noisy and useless to us: 14 events/sec at idle,
  almost entirely `pane_focused` / `workspace_focused` / `tab_focused` /
  `layout_updated`.
- `agent.list` costs about 0.84ms including connection setup, so polling every
  ~400ms across a couple of sessions is negligible.

- Future phases already have what they need: `agent.focus`, `workspace.focus`,
  `agent.prompt`, `agent.send_keys`.

**Git root labels** — resolving `git rev-parse --show-toplevel` gives the useful
name in every live case, notably `/dev/zephyr_cloudflow/src` -> `zephyr_cloudflow`
where the basename `src` would have been useless.

## Decisions

| Area | Decision |
| --- | --- |
| Interaction | Phase 1 display only. Phase 2 (done): press = jump to that agent. |
| Layout | Pinned slots first, remaining agents auto-flow into free keys. |
| Key face | Status color bar + repo name + session name. |
| Ordering | Stable (session, then workspace). Overflow evicts lowest priority. |
| Animation | None. Static, fully event-driven. |
| Lifecycle | launchd agent at login (done), plus a foreground CLI for debugging. |
| Pin identity | `session + cwd`. |
| Label | Git repo root basename. |
| Stack | TypeScript on Node 24 (started on Bun; moved after Bun segfaulted on unplug). |

## Architecture

```
herdr sockets (N)          sd-connect daemon              Stream Deck MK.2
─────────────────         ────────────────────           ──────────────────
zephyr/herdr.sock  ──┐    ┌──────────────┐
canaries/herdr.sock ─┼──> │ SessionWatch │  discovery: rescan sessions dir
(future sessions)  ──┘    ├──────────────┤
                          │ HerdrClient  │  per session: agent.list + subscribe
                          ├──────────────┤
                          │  AgentStore  │  merged map, keyed session+pane_id
                          ├──────────────┤
                          │   Layout     │  pins -> slots, rest auto-flow
                          ├──────────────┤
                          │  Renderer    │  SVG -> sharp -> raw RGB, cached
                          ├──────────────┤
                          │  DeckDriver  │  diff vs on-screen, write changed keys
                          └──────────────┘ ──────────────> 15 keys
```

Data flow is one-way: herdr events mutate the store, the store recomputes a
desired 15-slot array, and the driver writes only the slots whose rendered bytes
changed. Adding key presses later means adding one reverse edge from DeckDriver
back to HerdrClient, nothing else changes.

### Modules

- `src/herdr/sessions.ts` — enumerate sessions from `~/.config/herdr/sessions/`,
  verify each socket is live, rescan on an interval and on socket errors.
- `src/herdr/client.ts` — request/response over the socket. One short-lived
  connection per request, because the server closes it after replying.
- `src/herdr/poller.ts` — polls `agent.list` per session on an interval and emits
  only real changes. Polling rather than subscribing is a measured decision, not
  a shortcut: see the API findings above.
- `src/model/store.ts` — merged agent map keyed `${session}:${pane_id}`. Holds only
  render-relevant fields so diffing is cheap and `pane.updated` noise is absorbed.
- `src/model/repo.ts` — cwd -> git root basename, cached per cwd (bounded).
- `src/layout.ts` — pins then auto-flow then overflow eviction (see below).
- `src/render/tile.ts` — Slot -> 72*72*3 raw RGB via @napi-rs/canvas, LRU cached
  by `(status, repo, session)`. Steady state does zero rendering.
  NOT SVG-via-sharp: sharp 0.35 rasterises SVG with resvg, which has no font
  backend, so `<text>` renders as nothing. Verified with a 0-light-pixel tile.
  Canvas also returns raw pixels, so sharp is not needed anywhere.
- `src/render/text.ts` — measured fitting. Repo names range from "db" to
  "zephyr_cloudflow" (108px against ~68px usable), so sizes are measured, never
  assumed: shrink to 12px, then wrap on a separator, then truncate.
- `src/deck.ts` — open device, set brightness, write changed keys, clean shutdown.
- `src/config.ts` — load and validate `~/.config/sd-connect/config.toml`.
- `src/main.ts` — wire it up, handle SIGINT/SIGTERM.

### Layout algorithm

1. Place pinned agents on their configured key if that agent is present.
2. Sort the rest by `(session name, workspace_id, pane_id)` — stable, so keys do
   not shuffle when a status changes.
3. Fill free keys in order.
4. If more agents than free keys: drop by ascending priority
   (`unknown` < `idle` < `working` < `done` < `blocked`), so blocked and done always
   survive. If anything was dropped, the last key becomes a `+N more` tile.
5. Unused keys render black.

A pinned key stays black when its agent is absent — that is the point of pinning.

### Config

`~/.config/sd-connect/config.toml`

```toml
brightness = 70

[colors]
idle    = "#22c55e"
working = "#3b82f6"
blocked = "#ef4444"
done    = "#eab308"
unknown = "#6b7280"

[[pins]]
key     = 0
session = "zephyr"
cwd     = "/Users/jason.koon/dev/portal"

[[pins]]
key     = 1
session = "canaries"
cwd     = "/Users/jason.koon/dev/canaries"
```

Missing config is fine — defaults, no pins, pure auto-flow.

## Build order

1. **Scaffold** — DONE. Deps are `@elgato-stream-deck/node`, `@napi-rs/canvas`
   and `smol-toml`. Runs on Node 24 with native TypeScript, no build step.
2. **Deck driver** — DONE. Open, brightness, diffed writes, clean teardown,
   smoke test asserting the diff suppresses redundant writes.
3. **Tile renderer** — DONE. Canvas drawing, measured fit, LRU cache, PNG dump +
   contact sheet, on-hardware preview, 14 unit tests.
4. **herdr client** — DONE. Session discovery with liveness checks, single-shot
   request client, polling loop that emits only real changes, `watch` mode.
   19 tests against a fake herdr server. Verified live: prompting an agent
   produced `done -> working -> done` on the watch output.
5. **Store + layout** — DONE. Pins, stable auto-flow, overflow eviction, config
   loading and validation. 25 pure-function tests.
6. **Wire up** — DONE. `npm start`. Verified live: agent state changes repaint
   exactly one key; a dead session is logged once and isolated; the deck can be
   unplugged and replugged and the daemon recovers and repaints.
7. **Polish** — config loading, `--once` render-and-exit for debugging, README.

## Risks

| Risk | Mitigation |
| --- | --- |
| Bun segfault on `close()` AND on unplug | RESOLVED by moving to Node 24. Bun died outright when the deck was unplugged, so no reconnect was possible; Node raises a catchable error. Verified by physically unplugging. |
| No font rendering in sharp | Hit and resolved in step 2: switched to `@napi-rs/canvas`, which sees system fonts and removes the sharp dependency entirely. |
| Event stream is noisy (14/s) and does not carry status changes | Do not subscribe at all in phase 1. Poll `agent.list` (0.84ms) and diff. |
| Polling adds latency to status changes | ~400ms interval, well under human glance latency. Revisit if herdr gains a real status event. |
| Session starts/stops while running | Periodic rescan of the sessions dir plus reconnect-with-backoff. |
| Deck unplugged mid-run | Catch write errors, poll for the device, re-open and full-repaint on return. |
| Two panes, same session, same cwd | Pin matches the first by stable sort; the rest auto-flow. Documented, not an error. |

## Phase 2: key presses (done)

Pressing a key jumps to that agent. Two steps are required, because herdr and
the window server know different things:

1. AppleScript raises the Ghostty window whose title mentions the session.
   herdr does not know its OS window exists.
2. `agent.focus` with the pane id moves workspace, tab and pane focus together.

Measured: `agent.focus` is 8ms, the AppleScript raise is ~140ms. Verified that
step 2 alone is insufficient: focusing a canaries agent while the zephyr window
was frontmost moved focus inside canaries but left zephyr on screen.

Window raising is best-effort and configurable (`raise_window`), since it
depends on Accessibility permission and on window titles carrying the session
name.

## Phase 3: launchd autostart (done)

`scripts/install-launchd.sh` renders `launchd/*.plist.template` into
`~/Library/LaunchAgents` and bootstraps it. RunAtLoad plus KeepAlive with a
10s ThrottleInterval, logging to `~/Library/Logs/sd-connect/`.

Three things this surfaced, none of them predictable from the code:

- **Accessibility does not inherit into launchd.** The grant follows process
  ancestry back to the terminal app, so the same osascript that works from a
  Ghostty shell fails under launchd with `-1719`. It needs a one-time approval
  of its own. A signed .app wrapper also works, but proved unnecessary once the
  prompt was approved.
- **`launchctl bootout` returns before teardown finishes.** Bootstrapping
  immediately after fails with `Bootstrap failed: 5`, while bootout reports
  success — so reinstall silently left nothing loaded, about two times in three.
  The installer now waits for the old job to disappear and retries.
- **Homebrew node, not the version-manager node.** launchd needs an absolute
  path, and vite-plus/nvm builds get upgraded and pruned. Homebrew's node 26
  was verified against the native modules and the full test suite.

Per-frame logging became verbose-only here: launchd never rotates these logs.

## Out of scope

Multi-page navigation, non-herdr data sources, Stream Deck models other than
MK.2, and any press action other than focus (prompting, sending keys) — the API
supports them, but they are not wired up.
