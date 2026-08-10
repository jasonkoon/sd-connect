/**
 * sd-connect daemon: herdr agent status on a Stream Deck.
 *
 *   npm start
 *   npm start -- --once     paint one frame and exit
 *   npm start -- --verbose  log every frame
 *   npm start -- --no-web   disable the web viewer
 *   npm start -- --port N   serve the web viewer on N
 *
 * Data flows one way: poller -> layout -> renderer -> sinks. Nothing here talks
 * back to herdr except key presses, which only focus a window.
 *
 * A frame is built once and fanned out, so the web viewer is guaranteed to be
 * showing exactly what the deck is showing, including overflow and pinned keys.
 */

import { isValidPort, loadConfig, MAX_PORT, MIN_PORT } from './config.ts'
import { KEY_COUNT } from './deck.ts'
import { focusAgent } from './focus.ts'
import type { Frame, Sink } from './frame.ts'
import { AgentPoller } from './herdr/poller.ts'
import { layout } from './layout.ts'
import { TileRenderer } from './render/tile.ts'
import { installShutdownHandlers, onShutdown, shutdown } from './shutdown.ts'
import { AmpGd6Sink } from './sinks/ampgd6-sink.ts'
import { DeckSink } from './sinks/deck-sink.ts'
import { WebSink } from './sinks/web/server.ts'
import type { Agent } from './types.ts'

interface Flags {
  once: boolean
  verbose: boolean
  web: boolean
  /** Overrides config when set. Null means "use config". */
  port: number | null
  /** Problems with the arguments. Reported, then ignored. */
  warnings: string[]
}

function parseFlags(argv: string[]): Flags {
  const warnings: string[] = []
  const portIndex = argv.indexOf('--port')

  let port: number | null = null
  if (portIndex !== -1) {
    const raw = argv[portIndex + 1]
    const parsed = Number(raw)
    // A silently discarded --port is worse than a rejected one: you would be
    // left looking for the viewer on a port it was never told to use.
    if (raw === undefined || raw.startsWith('--')) {
      warnings.push('--port needs a value; using the configured port')
    } else if (!isValidPort(parsed)) {
      warnings.push(
        `--port must be an integer ${MIN_PORT}-${MAX_PORT}, got '${raw}'; using the configured port`,
      )
    } else {
      port = parsed
    }
  }

  return {
    once: argv.includes('--once'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
    web: !argv.includes('--no-web'),
    port,
    warnings,
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  installShutdownHandlers()
  for (const warning of flags.warnings) console.warn(`[sd-connect] ${warning}`)

  const { config, warnings, path, existed } = await loadConfig()
  console.log(`[sd-connect] config: ${existed ? path : `${path} (not found, using defaults)`}`)
  for (const warning of warnings) console.warn(`[sd-connect] config: ${warning}`)
  if (config.pins.length > 0) {
    console.log(
      `[sd-connect] ${config.pins.length} pin(s): ${config.pins.map((p) => `key ${p.key} -> ${p.session}:${p.cwd}`).join(', ')}`,
    )
  }

  const renderer = new TileRenderer(config.theme)

  // Declared before the sinks because both press paths call it, and the poller
  // it needs is created after them. Assigned once everything exists.
  let press: (agent: Agent) => void = () => {}

  const deckSink = new DeckSink({
    brightness: config.brightness,
    verbose: flags.verbose,
    onPress: (agent) => press(agent),
  })

  // Both hardware sinks are always present; each is a no-op until its own
  // device is actually plugged in. That is the whole auto-detect story: there
  // is no branching on "which model do I have", just "try to connect both,
  // whichever succeeds writes real pixels". Safe to run together because only
  // one physical device can claim a given VID/PID pair anyway.
  const ampgd6Sink = new AmpGd6Sink({
    brightness: config.brightness,
    verbose: flags.verbose,
    onPress: (agent) => press(agent),
  })

  const sinks: Sink[] = [deckSink, ampgd6Sink]

  // --once paints a frame and exits, so a viewer would be torn down before it
  // could be opened. Skipping it also keeps --once's "no deck" exit code honest.
  const webEnabled = flags.web && config.web.enabled && !flags.once
  let webSink: WebSink | null = null
  if (webEnabled) {
    webSink = new WebSink({
      // --port beats config, config beats the built-in default.
      port: flags.port ?? config.web.port,
      portSource: flags.port !== null ? '--port' : existed ? 'config' : 'default',
      onPress: (agent) => press(agent),
      verbose: flags.verbose,
    })
    // A viewer that cannot bind is not fatal; the deck still works without it.
    if (await webSink.start()) sinks.push(webSink)
    else webSink = null
  }

  for (const sink of sinks) onShutdown(() => sink.stop())

  // Stream Deck first, Ampligame D6 second: an arbitrary but stable
  // tie-break for the (rare) case both are plugged in at once.
  const deckConnected = await deckSink.connect()
  const ampgd6Connected = await ampgd6Sink.connect()

  if (!deckConnected && !ampgd6Connected) {
    if (flags.once) {
      console.error('[sd-connect] no Stream Deck or Ampligame D6 found')
      await shutdown(2)
    }
    console.log('[sd-connect] no deck found; waiting for one to be plugged in')
    deckSink.waitForDeck()
    ampgd6Sink.waitForDevice()
  } else if (!flags.once) {
    // The one that didn't connect still watches for its own hotplug, so
    // swapping devices later (or plugging in a second one) just works.
    if (!deckConnected) deckSink.waitForDeck()
    if (!ampgd6Connected) ampgd6Sink.waitForDevice()
  }

  /**
   * Lay out and render one frame, then hand it to every sink.
   *
   * Key count comes from the deck when one is attached, and falls back to the
   * MK.2's 15 otherwise — without that fallback there would be nothing to show
   * in the viewer while unplugged, which is the whole point of having it.
   */
  const show = async (agents: Agent[]): Promise<void> => {
    const keyCount = deckSink.keyCount ?? ampgd6Sink.keyCount ?? KEY_COUNT
    const { slots, dropped } = layout(agents, { keyCount, pins: config.pins })
    const frame: Frame = {
      slots,
      tiles: slots.map((slot) => renderer.render(slot)),
      dropped,
      keyCount,
    }
    // A sink that throws must not stop the others. Each already absorbs its own
    // transient failures, so anything reaching here is a bug worth logging.
    await Promise.all(
      sinks.map(async (sink) => {
        try {
          await sink.present(frame)
        } catch (error) {
          console.error(
            `[sd-connect] sink '${sink.name}' failed: ${error instanceof Error ? error.message : error}`,
          )
        }
      }),
    )
  }

  const poller = new AgentPoller({
    intervalMs: config.pollIntervalMs,
    onChange: show,
    onSessionError: (session, error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[sd-connect] session '${session}' unavailable: ${message}`)
    },
  })
  onShutdown(() => poller.stop())

  // A press jumps to that agent. Guarded so a burst of presses cannot pile up
  // overlapping AppleScript calls, which are the slow part (~140ms).
  let jumping = false
  press = (agent: Agent) => {
    if (jumping) return
    jumping = true
    void (async () => {
      try {
        const socketPath = poller.socketFor(agent.session)
        if (!socketPath) {
          console.error(`[sd-connect] cannot focus ${agent.repo}: session '${agent.session}' is gone`)
          return
        }
        const result = await focusAgent(agent, socketPath, { raiseWindow: config.raiseWindow })
        if (!result.focused) {
          console.error(`[sd-connect] focus failed for ${agent.repo}: ${result.note}`)
        } else if (!result.raised && result.note) {
          // Focus worked inside herdr, but the window did not come forward.
          console.warn(`[sd-connect] focused ${agent.repo}, but no window raised: ${result.note}`)
        } else {
          // Always logged, not just under --verbose: under launchd the log is
          // the only way to see that a press did anything.
          console.log(`[sd-connect] jumped to ${agent.repo} (${agent.session}/${agent.paneId})`)
        }
      } finally {
        jumping = false
      }
    })()
  }

  await poller.start()
  console.log(`[sd-connect] polling ${poller.sessions.length} session(s) every ${config.pollIntervalMs}ms`)

  if (flags.once) {
    poller.stop()
    await shutdown(0)
  }

  console.log('[sd-connect] running; Ctrl-C to stop')
  await new Promise(() => {})
}

await main()
