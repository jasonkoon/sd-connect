import { describe, test } from 'node:test'
import { expect } from './expect.ts'
import { runMacroAction } from './macros.ts'
import type { MacroAction } from './types.ts'

describe('runMacroAction', () => {
  test('command returns true and runs to completion', async () => {
    const action: MacroAction = { type: 'command', run: 'exit 0' }
    const started = runMacroAction(action, 1)
    expect(started).toBe(true)
    // Give the detached child a moment to settle; no assertion on output since
    // it is fire-and-forget and detached.
    await new Promise((r) => setTimeout(r, 50))
  })

  test('guards against stacking duplicate runs of the same key', async () => {
    const action: MacroAction = { type: 'command', run: 'sleep 0.2' }
    const first = runMacroAction(action, 7)
    expect(first).toBe(true)
    // Immediately pressing the same key again is ignored while in flight.
    const second = runMacroAction(action, 7)
    expect(second).toBe(false)
    await new Promise((r) => setTimeout(r, 300))
    // After the command finishes, the key is free again.
    const third = runMacroAction({ type: 'command', run: 'true' }, 7)
    expect(third).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
  })

  test('different keys run concurrently', async () => {
    const action: MacroAction = { type: 'command', run: 'sleep 0.1' }
    expect(runMacroAction(action, 1)).toBe(true)
    expect(runMacroAction(action, 2)).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
  })

  test('url and app actions are accepted but only warn', async () => {
    // Reserved action kinds are reported as started; the runner just warns.
    const url: MacroAction = { type: 'url', url: 'https://example.com' }
    expect(runMacroAction(url, 3)).toBe(true)
    const app: MacroAction = { type: 'app', app: 'Finder' }
    expect(runMacroAction(app, 4)).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
  })
})
