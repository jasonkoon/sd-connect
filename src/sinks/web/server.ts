/**
 * The web viewer: the same frame the deck gets, served over HTTP.
 *
 * Exists because the deck is not always plugged in. Everything up to the frame
 * is hardware-independent, so this sink is mostly transport — it converts tiles
 * to PNG and pushes a JSON description of the frame over SSE.
 *
 * Presses are forwarded to the same handler the deck uses, so a key does the
 * same thing whether it is clicked or pushed.
 *
 * Binds to loopback only. There is no authentication, and a press focuses
 * windows and reveals repo and session names, so this must not be reachable
 * from the network.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { DEFAULT_PORT } from '../../config.ts'
import type { Frame, Sink } from '../../frame.ts'
import { KEY_COLUMNS } from '../../deck.ts'
import { toPng } from '../../render/png.ts'
import { slotKey } from '../../render/tile.ts'
import { onMacroStatus } from '../../macros.ts'
import type { Agent, MacroAction, Slot } from '../../types.ts'
import { PAGE } from './page.ts'

// Re-exported for convenience; defined in config.ts so the default lives in
// exactly one place and cannot drift from the config schema.
export { DEFAULT_PORT }

const HOST = '127.0.0.1'
/**
 * Proxies and some browsers drop an idle SSE stream. A comment line every 20s
 * is cheap and keeps it open.
 */
const KEEPALIVE_MS = 20_000

export interface WebSinkOptions {
  port?: number
  /** Where `port` came from, for the startup log. */
  portSource?: string
  /** Grid width, for the page layout. Defaults to the MK.2's 5. */
  columns?: number
  /** Invoked when a key showing an agent is clicked. */
  onPress?: (agent: Agent) => void | Promise<void>
  /** Invoked when a macro key is clicked. */
  onMacro?: (key: number, action: MacroAction) => void | Promise<void>
  verbose?: boolean
}

/** What the browser needs to know about one key. */
interface KeyView {
  /** Content-addressed tile id. Same pixels always yield the same id. */
  tile: string
  label: string
  pressable: boolean
  /** True while a macro on this key is running. */
  running: boolean
}

interface FrameView {
  keys: KeyView[]
  columns: number
  dropped: number
}

function labelFor(slot: Slot): string {
  switch (slot.kind) {
    case 'empty':
      return slot.pinned ? 'reserved' : ''
    case 'macro':
      return `${slot.label} — macro`
    case 'overflow':
      return `${slot.count} more not shown`
    case 'agent':
      return `${slot.agent.repo} — ${slot.agent.status} — ${slot.agent.session}`
  }
}

/**
 * Tile ids must be URL-safe and stable. slotKey() is already the render cache
 * key (same key, same pixels), so reuse it rather than inventing a second
 * identity that could drift out of step with the renderer.
 */
function tileId(slot: Slot): string {
  return encodeURIComponent(slotKey(slot))
}

export class WebSink implements Sink {
  readonly name = 'web'

  #server: Server
  #port: number
  #portSource: string
  #columns: number
  #onPress: WebSinkOptions['onPress']
  #onMacro: WebSinkOptions['onMacro']
  #verbose: boolean
  #clients = new Set<ServerResponse>()
  #frame: Frame | null = null
  #view: FrameView | null = null
  /** Tile id -> PNG bytes, for the current frame plus whatever is still cached. */
  #pngs = new Map<string, Buffer>()
  /** Keys that currently have a macro running. */
  #running = new Set<number>()
  #keepalive: ReturnType<typeof setInterval> | null = null
  #started = false
  #unsubscribeMacroStatus: (() => void) | null = null

  constructor(options: WebSinkOptions = {}) {
    this.#port = options.port ?? DEFAULT_PORT
    this.#portSource = options.portSource ?? 'default'
    this.#columns = options.columns ?? KEY_COLUMNS
    this.#onPress = options.onPress
    this.#onMacro = options.onMacro
    this.#verbose = options.verbose ?? false
    this.#unsubscribeMacroStatus = onMacroStatus((key, phase) => {
      if (phase === 'started') this.#running.add(key)
      else this.#running.delete(key)
      this.#refreshRunning()
    })
    this.#server = createServer((req, res) => void this.#handle(req, res))
  }

  get url(): string {
    return `http://${HOST}:${this.#port}`
  }

  get clientCount(): number {
    return this.#clients.size
  }

  /**
   * Bind the port.
   *
   * A port already in use is reported and swallowed: a second daemon, or a
   * leftover viewer, must not stop the deck from working.
   */
  async start(): Promise<boolean> {
    return new Promise((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(
            `[sd-connect] web viewer: port ${this.#port} is already in use; viewer disabled`,
          )
        } else {
          console.error(`[sd-connect] web viewer failed to start: ${error.message}`)
        }
        resolve(false)
      }
      this.#server.once('error', onError)
      this.#server.listen(this.#port, HOST, () => {
        this.#server.removeListener('error', onError)
        // Past bind, an error is a live-server problem, not a startup one.
        this.#server.on('error', (err) => {
          console.error(`[sd-connect] web viewer error: ${err.message}`)
        })
        this.#started = true
        this.#keepalive = setInterval(() => this.#ping(), KEEPALIVE_MS)
        this.#keepalive.unref?.()
        // Name where the port came from: with three possible sources, "why is
        // it not on 8787" is otherwise a hunt through flags and config.
        console.log(`[sd-connect] web viewer on ${this.url} (port from ${this.#portSource})`)
        resolve(true)
      })
    })
  }

  async present(frame: Frame): Promise<void> {
    this.#frame = frame

    // Rebuild the PNG map from scratch each frame so it cannot grow without
    // bound. Tiles are content-addressed and the renderer caches upstream, so
    // a steady state re-encodes the same handful of images and nothing leaks.
    const pngs = new Map<string, Buffer>()
    const keys: KeyView[] = frame.slots.map((slot, i) => {
      const id = tileId(slot)
      if (!pngs.has(id)) {
        const tile = frame.tiles[i]
        if (tile) pngs.set(id, this.#pngs.get(id) ?? toPng(tile))
      }
      return {
        tile: id,
        label: labelFor(slot),
        pressable: slot.kind === 'agent' || slot.kind === 'macro',
        running: slot.kind === 'macro' && this.#running.has(i),
      }
    })
    this.#pngs = pngs
    this.#view = { keys, columns: this.#columns, dropped: frame.dropped.length }

    this.#broadcast(this.#view)
  }

  /** Re-broadcast the current view with refreshed "running" flags. */
  #refreshRunning(): void {
    if (!this.#frame || !this.#view) return
    const keys: KeyView[] = this.#view.keys.map((key, i) => {
      const slot = this.#frame!.slots[i]
      const isMacro = slot?.kind === 'macro'
      return { ...key, running: isMacro && this.#running.has(i) }
    })
    this.#view = { ...this.#view, keys }
    this.#broadcast(this.#view)
  }

  async stop(): Promise<void> {
    this.#unsubscribeMacroStatus?.()
    this.#unsubscribeMacroStatus = null
    if (this.#keepalive) clearInterval(this.#keepalive)
    this.#keepalive = null
    for (const client of this.#clients) client.end()
    this.#clients.clear()
    if (!this.#started) return
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  #broadcast(view: FrameView): void {
    if (this.#clients.size === 0) return
    const payload = `data: ${JSON.stringify(view)}\n\n`
    for (const client of this.#clients) {
      // A slow or dead client must not break the loop for the others.
      try {
        client.write(payload)
      } catch {
        this.#clients.delete(client)
      }
    }
  }

  #ping(): void {
    for (const client of this.#clients) {
      try {
        client.write(': keepalive\n\n')
      } catch {
        this.#clients.delete(client)
      }
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    const path = url.pathname

    if (path === '/' || path === '/index.html') return this.#servePage(res)
    if (path === '/events') return this.#serveEvents(req, res)
    if (path.startsWith('/tile/')) return this.#serveTile(path, res)
    if (path.startsWith('/press/') && req.method === 'POST') return this.#servePress(path, res)

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  #servePage(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(PAGE)
  }

  #serveTile(path: string, res: ServerResponse): void {
    const id = path.slice('/tile/'.length).replace(/\.png$/, '')
    const png = this.#pngs.get(id)
    if (!png) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no such tile')
      return
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      // Content-addressed: the same id is always the same pixels, so the
      // browser never needs to refetch one it has already seen.
      'cache-control': 'public, max-age=31536000, immutable',
    })
    res.end(png)
  }

  #serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Without this an intervening proxy may buffer the stream into silence.
      'x-accel-buffering': 'no',
    })
    // Flush headers so the browser fires onopen before the first frame.
    res.write(': connected\n\n')
    this.#clients.add(res)

    // Send current state immediately: a viewer opened between herdr changes
    // would otherwise sit blank until something happens to move.
    if (this.#view) res.write(`data: ${JSON.stringify(this.#view)}\n\n`)
    if (this.#verbose) console.log(`[sd-connect] web viewer: client connected (${this.#clients.size})`)

    const drop = () => {
      if (this.#clients.delete(res) && this.#verbose) {
        console.log(`[sd-connect] web viewer: client left (${this.#clients.size})`)
      }
    }
    req.on('close', drop)
    req.on('error', drop)
  }

  async #servePress(path: string, res: ServerResponse): Promise<void> {
    const index = Number(path.slice('/press/'.length))
    const slot = this.#frame?.slots[index]

    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }

    if (!Number.isInteger(index) || !slot) return json(400, { error: 'no such key' })

    // Fire and forget, exactly like the deck's onKeyUp: focusing takes ~140ms
    // of AppleScript and the click should not block on it.
    if (slot.kind === 'agent') {
      void this.#onPress?.(slot.agent)
      return json(200, { ok: true, repo: slot.agent.repo })
    }
    if (slot.kind === 'macro') {
      void this.#onMacro?.(index, slot.action)
      return json(200, { ok: true, label: slot.label })
    }
    return json(400, { error: 'key has no pressable action' })
  }
}
