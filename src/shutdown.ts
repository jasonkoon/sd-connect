/**
 * Process shutdown.
 *
 * Deliberately ends with an explicit `process.exit()`. See deck.ts `shutdown()`
 * for why we never call the native `close()`: without it the HID handle stays
 * open, so we must exit rather than waiting for the event loop to drain.
 */

export type Cleanup = () => void | Promise<void>

/**
 * Hard ceiling on cleanup. Blanking the panel is a USB write, and a write that
 * is queued behind an in-flight transfer (or issued to a deck that was just
 * unplugged) can stall. A daemon that refuses to die on SIGTERM is worse than
 * one that leaves a stale image on the keys, so we always exit.
 */
const CLEANUP_TIMEOUT_MS = 2000

const cleanups: Cleanup[] = []
let running = false

export function onShutdown(fn: Cleanup): void {
  cleanups.push(fn)
}

async function runCleanups(): Promise<void> {
  for (const fn of cleanups.reverse()) {
    try {
      await fn()
    } catch (err) {
      console.error('[shutdown] cleanup failed:', err)
    }
  }
}

/** Run cleanups (most recent first) then exit. Safe to call more than once. */
export async function shutdown(code = 0): Promise<never> {
  if (running) {
    // A second signal while we're already tearing down: stop waiting, just go.
    process.exit(code)
  }
  running = true

  // Belt and braces: if cleanup wedges in native code, this timer still fires
  // and takes the process down. unref() so it can never hold the loop open.
  const watchdog = setTimeout(() => {
    console.error(`[shutdown] cleanup exceeded ${CLEANUP_TIMEOUT_MS}ms, forcing exit`)
    process.exit(code)
  }, CLEANUP_TIMEOUT_MS)
  watchdog.unref?.()

  await runCleanups()
  clearTimeout(watchdog)

  process.exit(code)
}

/** Install SIGINT/SIGTERM handlers and crash guards. Call once at startup. */
export function installShutdownHandlers(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(0)
    })
  }

  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception:', err)
    void shutdown(1)
  })

  process.on('unhandledRejection', (err) => {
    console.error('[fatal] unhandled rejection:', err)
    void shutdown(1)
  })
}
