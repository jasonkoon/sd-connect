/**
 * Jumping to an agent when a key is pressed.
 *
 * Two steps, because herdr and the window server know different things:
 *
 *   1. Raise the terminal window belonging to that herdr session. herdr has no
 *      idea the OS window exists, so this is AppleScript against Ghostty.
 *   2. Ask herdr to focus the workspace/tab/pane. `agent.focus` handles all
 *      three levels in one call.
 *
 * Verified: focusing a canaries agent while the zephyr window is frontmost
 * moves focus inside canaries but leaves zephyr on screen. Without step 1, a
 * cross-session press appears to do nothing.
 *
 * Step 1 is best-effort. If the window cannot be found (renamed title, a
 * different terminal, Accessibility permission revoked) the focus still
 * happens, so the press is never a no-op inside herdr.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { request } from './herdr/protocol.ts'
import type { Agent } from './types.ts'

const execFileAsync = promisify(execFile)

/**
 * Terminal application hosting herdr, as it appears to System Events.
 * Ghostty's process name is lowercase even though the app bundle is not.
 */
const TERMINAL_PROCESS = 'ghostty'

/** AppleScript is slow (~140ms) but this is a keypress, not a hot loop. */
const APPLESCRIPT_TIMEOUT_MS = 3000
const FOCUS_TIMEOUT_MS = 2000

/**
 * Raise the window whose title mentions the session.
 *
 * Relies on herdr client windows being titled "herdr session attach <name>",
 * which is what `herdr session attach` sets. Matching on the session name is
 * narrow enough to be unambiguous and loose enough to survive title decoration.
 *
 * Returns the raised window title, or null when nothing matched.
 */
const RAISE_SCRIPT = `
on run argv
  set targetSession to item 1 of argv
  set procName to item 2 of argv
  tell application "System Events"
    if not (exists process procName) then return "NOPROC"
    tell process procName
      repeat with w in windows
        set t to value of attribute "AXTitle" of w
        if t contains targetSession then
          perform action "AXRaise" of w
          set frontmost to true
          return "OK:" & t
        end if
      end repeat
    end tell
  end tell
  return "NOWINDOW"
end run
`

export interface FocusResult {
  /** herdr accepted the focus request. */
  focused: boolean
  /** A terminal window was raised. False when we could not find one. */
  raised: boolean
  /** Why the window was not raised, for logging. */
  note?: string
}

export interface FocusOptions {
  /** Skip the AppleScript step. Used by tests and by --no-raise. */
  raiseWindow?: boolean
  terminalProcess?: string
}

/** Bring the terminal window for `session` to the front. */
export async function raiseSessionWindow(
  session: string,
  terminalProcess = TERMINAL_PROCESS,
): Promise<{ raised: boolean; note?: string }> {
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', RAISE_SCRIPT, session, terminalProcess],
      { timeout: APPLESCRIPT_TIMEOUT_MS },
    )
    const output = stdout.trim()
    if (output.startsWith('OK:')) return { raised: true }
    if (output === 'NOPROC') return { raised: false, note: `no ${terminalProcess} process` }
    if (output === 'NOWINDOW') return { raised: false, note: `no window titled like '${session}'` }
    return { raised: false, note: `unexpected osascript output: ${output}` }
  } catch (error) {
    // Most likely Accessibility permission, or osascript missing entirely.
    const message = error instanceof Error ? error.message : String(error)
    return { raised: false, note: message.split('\n')[0] ?? message }
  }
}

/**
 * Jump to an agent: raise its session's window, then focus its pane.
 *
 * Never throws. A key press should not be able to take the daemon down.
 */
export async function focusAgent(
  agent: Agent,
  socketPath: string,
  options: FocusOptions = {},
): Promise<FocusResult> {
  const shouldRaise = options.raiseWindow ?? true

  const windowResult = shouldRaise
    ? await raiseSessionWindow(agent.session, options.terminalProcess)
    : { raised: false, note: 'window raising disabled' }

  try {
    // agent.focus takes a pane id as its target and moves workspace, tab and
    // pane focus together.
    await request(socketPath, 'agent.focus', { target: agent.paneId }, { timeoutMs: FOCUS_TIMEOUT_MS })
    return { focused: true, raised: windowResult.raised, note: windowResult.note }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { focused: false, raised: windowResult.raised, note: message }
  }
}
