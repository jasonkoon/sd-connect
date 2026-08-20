import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { request } from './herdr/protocol.ts'
import type { Agent } from './types.ts'

const execFileAsync = promisify(execFile)

const TERMINAL_PROCESS = 'ghostty'
const APPLESCRIPT_TIMEOUT_MS = 3000
const FOCUS_TIMEOUT_MS = 2000

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

const RAISE_WARP_SCRIPT = `
on run argv
  set targetRepo to item 1 of argv
  set procName to item 2 of argv
  tell application "System Events"
    if procName is not "" then
      if not (exists process procName) then return "NOPROC"
      set warpProc to process procName
    else
      set warpProcs to (every process whose bundle identifier is "dev.warp.Warp-Stable" or name is "Warp" or name is "stable")
      if (count of warpProcs) = 0 then return "NOPROC"
      set warpProc to item 1 of warpProcs
    end if
    tell warpProc
      repeat with w in windows
        set t to value of attribute "AXTitle" of w
        if t contains targetRepo then
          perform action "AXRaise" of w
          set frontmost to true
          return "OK:" & t
        end if
      end repeat
      if (count of windows) > 0 then
        set w to item 1 of windows
        perform action "AXRaise" of w
        set frontmost to true
        return "OK:" & (value of attribute "AXTitle" of w)
      end if
    end tell
  end tell
  return "NOWINDOW"
end run
`

export interface FocusResult {
  focused: boolean
  raised: boolean
  note?: string
}

export interface FocusOptions {
  raiseWindow?: boolean
  terminalProcess?: string
}

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
    const message = error instanceof Error ? error.message : String(error)
    return { raised: false, note: message.split('\n')[0] ?? message }
  }
}

export async function raiseWarpWindow(
  repo: string,
  terminalProcess?: string,
): Promise<{ raised: boolean; note?: string }> {
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', RAISE_WARP_SCRIPT, repo, terminalProcess ?? ''],
      { timeout: APPLESCRIPT_TIMEOUT_MS },
    )
    const output = stdout.trim()
    if (output.startsWith('OK:')) return { raised: true }
    if (output === 'NOPROC') return { raised: false, note: `no ${terminalProcess || 'Warp'} process` }
    if (output === 'NOWINDOW') return { raised: false, note: 'no Warp window found' }
    return { raised: false, note: `unexpected osascript output: ${output}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { raised: false, note: message.split('\n')[0] ?? message }
  }
}

export async function focusAgent(
  agent: Agent,
  socketPath: string | null,
  options: FocusOptions = {},
): Promise<FocusResult> {
  const shouldRaise = options.raiseWindow ?? true

  if (agent.session === 'warp' || !socketPath) {
    const windowResult = shouldRaise
      ? await raiseWarpWindow(agent.repo, options.terminalProcess)
      : { raised: false, note: 'window raising disabled' }
    return { focused: true, raised: windowResult.raised, note: windowResult.note }
  }

  const windowResult = shouldRaise
    ? await raiseSessionWindow(agent.session, options.terminalProcess)
    : { raised: false, note: 'window raising disabled' }

  try {
    await request(socketPath, 'agent.focus', { target: agent.paneId }, { timeoutMs: FOCUS_TIMEOUT_MS })
    return { focused: true, raised: windowResult.raised, note: windowResult.note }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { focused: false, raised: windowResult.raised, note: message }
  }
}
