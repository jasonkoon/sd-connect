/**
 * Run macro actions.
 *
 * Actions are fire-and-forget, matching how agent focus works: a press must not
 * block the poll loop or the next press. `command` actions spawn `/bin/zsh -c`
 * detached so a long-running or GUI-spawning command does not hold a pipe open.
 *
 * A per-action concurrency guard stops a slow command from stacking duplicate
 * runs of the same key: while one is in flight, further presses of that same
 * macro are ignored rather than piling up.
 */

import { spawn } from 'node:child_process'
import type { MacroAction } from './types.ts'

/** Whether a command is currently in flight, keyed by the macro's key. */
const inFlight = new Set<number>()

export type MacroRunner = (action: MacroAction, key: number) => void

/**
 * Run a macro action. Returns true if it started, false if another run of this
 * key is already in flight (so the press should be reported as ignored).
 */
export function runMacroAction(action: MacroAction, key: number): boolean {
  if (inFlight.has(key)) {
    console.warn(`[sd-connect] macro key ${key}: still running, ignoring press`)
    return false
  }

  switch (action.type) {
    case 'command': {
      inFlight.add(key)
      // Detached so the child is not tied to our process group / pipes; the
      // daemon does not wait on it. stdio ignored so it cannot block on us.
      const child = spawn('/bin/zsh', ['-c', action.run], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      child.once('error', (error) => {
        inFlight.delete(key)
        console.error(`[sd-connect] macro key ${key} failed to start: ${error.message}`)
      })
      child.once('exit', (code, signal) => {
        inFlight.delete(key)
        console.log(
          `[sd-connect] macro key ${key} finished (${signal ? `signal ${signal}` : `exit ${code ?? '?'}`})`,
        )
      })
      return true
    }
    case 'url':
      void openAction('url', action.url, key)
      return true
    case 'app':
      void openAction('app', action.app, key)
      return true
  }
}

async function openAction(kind: 'url' | 'app', target: string, key: number): Promise<void> {
  console.warn(`[sd-connect] macro key ${key}: '${kind}' actions are not implemented yet`)
}
