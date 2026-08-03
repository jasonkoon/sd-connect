/**
 * Headless view of what the deck would show. No hardware involved.
 *
 *   bun run watch          # stream changes as they happen
 *   bun run watch --once   # print one snapshot and exit
 *
 * This is the debugging surface for the herdr side, so problems there can be
 * diagnosed in a terminal rather than by squinting at 72px keys.
 */

import { AgentPoller } from './poller.ts'
import { discoverSessions, isLive, defaultSessionsDir } from './sessions.ts'
import { installShutdownHandlers, onShutdown } from '../shutdown.ts'
import type { Agent } from '../types.ts'

const STATUS_GLYPH: Record<string, string> = {
  idle: '\u25cb', // ○
  working: '\u25cf', // ●
  blocked: '\u25b2', // ▲
  done: '\u2713', // ✓
  unknown: '?',
}

function format(agents: Agent[]): string {
  if (agents.length === 0) return '  (no agents)'
  const width = Math.max(...agents.map((a) => a.repo.length))
  return agents
    .map((a, i) => {
      const glyph = STATUS_GLYPH[a.status] ?? '?'
      const key = String(i).padStart(2)
      return `  ${key} ${glyph} ${a.repo.padEnd(width)}  ${a.status.padEnd(7)} ${a.session}/${a.paneId}`
    })
    .join('\n')
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once')
  installShutdownHandlers()

  const dir = defaultSessionsDir()
  const found = await discoverSessions(dir)
  console.log(`[watch] sessions dir: ${dir}`)
  for (const s of found) {
    console.log(`[watch]   ${s.name}: ${(await isLive(s)) ? 'live' : 'no server listening'}`)
  }
  if (found.length === 0) console.log('[watch]   (none found)')

  const poller = new AgentPoller({
    onChange: (agents) => {
      const stamp = new Date().toLocaleTimeString()
      console.log(`\n[${stamp}] ${agents.length} agent(s)`)
      console.log(format(agents))
    },
    onSessionError: (session, error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[watch] session '${session}' unavailable: ${message}`)
    },
  })
  onShutdown(() => poller.stop())

  if (once) {
    await poller.start()
    poller.stop()
    return
  }

  await poller.start()
  console.log('\n[watch] polling; Ctrl-C to stop')
  await new Promise(() => {})
}

await main()
