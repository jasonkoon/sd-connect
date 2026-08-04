/**
 * Web sink tests.
 *
 * These bind a real server on an ephemeral port and talk to it over HTTP. The
 * transport is the whole point of this module, so mocking it out would leave
 * nothing worth testing.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { KEY_COUNT } from '../../deck.ts'
import type { Frame } from '../../frame.ts'
import { TileRenderer } from '../../render/tile.ts'
import { EMPTY_SLOT, PINNED_EMPTY_SLOT, type Agent, type AgentStatus, type Slot } from '../../types.ts'
import { WebSink } from './server.ts'

const renderer = new TileRenderer()

function agent(repo: string, status: AgentStatus = 'idle', session = 'zephyr'): Agent {
  return {
    session,
    paneId: 'w1:p1',
    workspaceId: 'w1',
    status,
    cwd: `/Users/x/dev/${repo}`,
    repo,
    agent: 'pi',
    focused: false,
  }
}

function frameOf(slots: Slot[]): Frame {
  const padded = Array.from({ length: KEY_COUNT }, (_, i) => slots[i] ?? EMPTY_SLOT)
  return {
    slots: padded,
    tiles: padded.map((s) => renderer.render(s)),
    dropped: [],
    keyCount: KEY_COUNT,
  }
}

/** Start a sink on a free port. Port 0 lets the OS pick, avoiding collisions. */
async function startSink(options: Partial<ConstructorParameters<typeof WebSink>[0]> = {}) {
  // Probe for a free port by binding 0 and reading it back.
  const net = await import('node:net')
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const p = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(p))
    })
  })
  const sink = new WebSink({ port, ...options })
  const ok = await sink.start()
  assert.equal(ok, true, 'sink should bind')
  return sink
}

const open: WebSink[] = []
after(async () => {
  for (const sink of open) await sink.stop()
})

async function sink(options?: Partial<ConstructorParameters<typeof WebSink>[0]>) {
  const s = await startSink(options)
  open.push(s)
  return s
}

describe('WebSink', () => {
  test('serves the viewer page', async () => {
    const s = await sink()
    const res = await fetch(s.url)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    const body = await res.text()
    assert.match(body, /EventSource/, 'page should subscribe to the event stream')
  })

  test('serves a tile as a PNG once a frame has been presented', async () => {
    const s = await sink()
    await s.present(frameOf([{ kind: 'agent', agent: agent('portal', 'working') }]))

    const res = await fetch(`${s.url}/tile/${encodeURIComponent('agent:working:portal:zephyr')}.png`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')

    const bytes = Buffer.from(await res.arrayBuffer())
    // PNG magic number, so we know it is a real image and not an error page.
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  })

  test('tiles are immutably cacheable, because ids are content-addressed', async () => {
    const s = await sink()
    await s.present(frameOf([{ kind: 'agent', agent: agent('portal') }]))
    const res = await fetch(`${s.url}/tile/${encodeURIComponent('agent:idle:portal:zephyr')}.png`)
    assert.match(res.headers.get('cache-control') ?? '', /immutable/)
  })

  test('unknown tile is a 404 rather than a hang', async () => {
    const s = await sink()
    await s.present(frameOf([]))
    const res = await fetch(`${s.url}/tile/nope.png`)
    assert.equal(res.status, 404)
  })

  test('a new client is sent the current frame immediately', async () => {
    const s = await sink()
    await s.present(frameOf([{ kind: 'agent', agent: agent('canaries', 'blocked') }]))

    // Without this a viewer opened between herdr changes would sit blank.
    const view = await firstEvent(s.url)
    assert.equal(view.keys.length, KEY_COUNT)
    assert.equal(view.columns, 5)
    assert.match(view.keys[0].label, /canaries/)
    assert.equal(view.keys[0].pressable, true)
  })

  test('pushes a new frame to a connected client', async () => {
    const s = await sink()
    await s.present(frameOf([{ kind: 'agent', agent: agent('portal', 'idle') }]))

    const events = eventStream(s.url)
    const first = await events.next()
    assert.match(first.keys[0].label, /idle/)

    await s.present(frameOf([{ kind: 'agent', agent: agent('portal', 'blocked') }]))
    const second = await events.next()
    assert.match(second.keys[0].label, /blocked/)
    assert.notEqual(first.keys[0].tile, second.keys[0].tile, 'tile id must change with status')

    await events.close()
  })

  test('only agent keys are pressable', async () => {
    const s = await sink()
    await s.present(
      frameOf([
        { kind: 'agent', agent: agent('portal') },
        PINNED_EMPTY_SLOT,
        { kind: 'overflow', count: 3 },
      ]),
    )
    const view = await firstEvent(s.url)
    assert.equal(view.keys[0].pressable, true)
    assert.equal(view.keys[1].pressable, false, 'pinned-empty is not pressable')
    assert.equal(view.keys[2].pressable, false, 'overflow is not pressable')
    assert.equal(view.keys[3].pressable, false, 'empty is not pressable')
  })

  test('pressing an agent key invokes the handler with that agent', async () => {
    const pressed: Agent[] = []
    const s = await sink({ onPress: (a) => void pressed.push(a) })
    await s.present(
      frameOf([{ kind: 'agent', agent: agent('sd-connect', 'done', 'koon') }]),
    )

    const res = await fetch(`${s.url}/press/0`, { method: 'POST' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, repo: 'sd-connect' })
    assert.equal(pressed.length, 1)
    assert.equal(pressed[0]?.repo, 'sd-connect')
    assert.equal(pressed[0]?.session, 'koon')
  })

  test('pressing an empty key is rejected and never reaches the handler', async () => {
    let calls = 0
    const s = await sink({ onPress: () => void calls++ })
    await s.present(frameOf([{ kind: 'agent', agent: agent('portal') }]))

    const res = await fetch(`${s.url}/press/5`, { method: 'POST' })
    assert.equal(res.status, 400)
    assert.equal(calls, 0)
  })

  test('pressing an out-of-range key is rejected', async () => {
    const s = await sink()
    await s.present(frameOf([]))
    for (const path of ['/press/99', '/press/-1', '/press/abc']) {
      const res = await fetch(`${s.url}${path}`, { method: 'POST' })
      assert.equal(res.status, 400, `${path} should be rejected`)
    }
  })

  test('a press before any frame does not throw', async () => {
    const s = await sink()
    const res = await fetch(`${s.url}/press/0`, { method: 'POST' })
    assert.equal(res.status, 400)
  })

  test('reports a port already in use instead of throwing', async () => {
    const first = await sink()
    const port = Number(new URL(first.url).port)

    const second = new WebSink({ port })
    // A second daemon must not take the deck down with it.
    assert.equal(await second.start(), false)
    await second.stop()
  })

  test('stop() closes the port so a restart can rebind', async () => {
    const s = await startSink()
    const port = Number(new URL(s.url).port)
    await s.stop()

    const again = new WebSink({ port })
    assert.equal(await again.start(), true)
    await again.stop()
  })

  test('client count tracks connections and disconnections', async () => {
    const s = await sink()
    await s.present(frameOf([]))
    assert.equal(s.clientCount, 0)

    const events = eventStream(s.url)
    await events.next()
    assert.equal(s.clientCount, 1)

    await events.close()
    // Give the server's 'close' handler a tick to run.
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(s.clientCount, 0)
  })

  test('unknown paths 404', async () => {
    const s = await sink()
    const res = await fetch(`${s.url}/../etc/passwd`)
    assert.equal(res.status, 404)
  })
})

/** Read SSE frames off the stream, one at a time. */
function eventStream(url: string) {
  const controller = new AbortController()
  const queue: Array<Record<string, any>> = []
  const waiters: Array<(v: Record<string, any>) => void> = []
  let buffer = ''

  const ready = fetch(`${url}/events`, { signal: controller.signal }).then(async (res) => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // SSE frames are separated by a blank line.
          let split: number
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, split)
            buffer = buffer.slice(split + 2)
            const line = chunk.split('\n').find((l) => l.startsWith('data: '))
            if (!line) continue // comment/keepalive
            const parsed = JSON.parse(line.slice(6))
            const waiter = waiters.shift()
            if (waiter) waiter(parsed)
            else queue.push(parsed)
          }
        }
      } catch {
        // Aborted by close(); nothing to clean up.
      }
    })()
  })

  return {
    async next(): Promise<Record<string, any>> {
      await ready
      const queued = queue.shift()
      if (queued) return queued
      return new Promise((resolve) => waiters.push(resolve))
    },
    async close(): Promise<void> {
      controller.abort()
    },
  }
}

async function firstEvent(url: string): Promise<Record<string, any>> {
  const events = eventStream(url)
  const view = await events.next()
  await events.close()
  return view
}
