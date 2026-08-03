/**
 * Push the sample tiles to the real deck, so the design can be judged at actual
 * size instead of on an upscaled PNG.
 *
 *   bun run preview
 *
 * Holds the image until Ctrl-C, then blanks the panel.
 */

import { DeckUnavailableError, openDeck, type Deck } from '../deck.ts'
import { installShutdownHandlers, onShutdown } from '../shutdown.ts'
import { EMPTY_SLOT, type Agent, type AgentStatus, type Slot } from '../types.ts'
import { TileRenderer } from './tile.ts'

function agent(repo: string, session: string, status: AgentStatus): Agent {
  return {
    session,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    status,
    cwd: `/Users/jason.koon/dev/${repo}`,
    repo,
    agent: 'pi',
    focused: false,
  }
}

const SLOTS: Slot[] = [
  { kind: 'agent', agent: agent('portal', 'zephyr', 'idle') },
  { kind: 'agent', agent: agent('sd-connect', 'zephyr', 'working') },
  { kind: 'agent', agent: agent('zephyr_cloudflow', 'zephyr', 'blocked') },
  { kind: 'agent', agent: agent('canaries', 'canaries', 'done') },
  { kind: 'agent', agent: agent('bcc_supabase', 'zephyr', 'unknown') },
  { kind: 'agent', agent: agent('supercalifragilistic', 'zephyr', 'idle') },
  { kind: 'agent', agent: agent('api', 'a-very-long-session-name', 'working') },
  { kind: 'agent', agent: agent('db', 'zephyr', 'idle') },
  { kind: 'agent', agent: agent('winning-edge-coaching', 'koon', 'done') },
  { kind: 'overflow', count: 4 },
]

async function main(): Promise<void> {
  installShutdownHandlers()

  let deck: Deck
  try {
    deck = await openDeck({ brightness: 70 })
  } catch (err) {
    if (err instanceof DeckUnavailableError) {
      console.error(`[preview] ${err.message}`)
      process.exit(2)
    }
    throw err
  }
  onShutdown(() => deck.shutdown())

  const renderer = new TileRenderer()
  const tiles = Array.from({ length: deck.keyCount }, (_, i) =>
    renderer.render(SLOTS[i] ?? EMPTY_SLOT),
  )

  const written = await deck.setKeys(tiles)
  const { hits, misses } = renderer.stats
  console.log(`[preview] painted ${written} keys (render cache: ${hits} hits, ${misses} misses)`)
  console.log('[preview] Ctrl-C to blank and exit')

  // Keep the process alive without spinning.
  await new Promise(() => {})
}

await main()
