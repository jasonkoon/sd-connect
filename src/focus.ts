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
    set matchingProcs to (every process whose name is procName)
    if (count of matchingProcs) = 0 then return "NOPROC"
    tell (item 1 of matchingProcs)
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
      set warpProcs to (every process whose name is procName)
    else
      set warpProcs to (every process whose bundle identifier is "dev.warp.Warp-Stable" or name is "Warp" or name is "stable")
    end if
    if (count of warpProcs) = 0 then return "NOPROC"
    tell (item 1 of warpProcs)
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

const RAISE_TERMINAL_SCRIPT = `
on run argv
  set targetRepo to item 1 of argv
  set procName to item 2 of argv
  tell application "System Events"
    if procName is not "" then
      set targetProcs to (every process whose name is procName)
      if (count of targetProcs) = 0 then return "NOPROC"
    else
      set targetProcs to {}
      set termNames to {"ghostty", "stable", "Terminal", "iTerm2", "Alacritty", "kitty", "Warp"}
      repeat with appName in termNames
        set found to (every process whose name is appName)
        if (count of found) > 0 then
          set targetProcs to targetProcs & found
        end if
      end repeat
      if (count of targetProcs) = 0 then return "NOPROC"
    end if
    repeat with procItem in targetProcs
      tell procItem
        repeat with w in windows
          set t to value of attribute "AXTitle" of w
          if t contains targetRepo then
            perform action "AXRaise" of w
            set frontmost to true
            return "OK:" & t
          end if
        end repeat
      end tell
    end repeat
    tell (item 1 of targetProcs)
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

export async function raiseTerminalWindow(
  repo: string,
  terminalProcess?: string,
): Promise<{ raised: boolean; note?: string }> {
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', RAISE_TERMINAL_SCRIPT, repo, terminalProcess ?? ''],
      { timeout: APPLESCRIPT_TIMEOUT_MS },
    )
    const output = stdout.trim()
    if (output.startsWith('OK:')) return { raised: true }
    if (output === 'NOPROC') return { raised: false, note: `no ${terminalProcess || 'terminal'} process` }
    if (output === 'NOWINDOW') return { raised: false, note: 'no terminal window found' }
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

  if (!socketPath) {
    let windowResult = { raised: false, note: 'window raising disabled' }
    if (shouldRaise) {
      if (agent.session === 'warp') {
        windowResult = await raiseWarpWindow(agent.repo, options.terminalProcess)
      } else {
        windowResult = await raiseTerminalWindow(agent.repo, options.terminalProcess)
      }
    }
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
