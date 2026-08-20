import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { repoLabel } from '../model/repo.ts'
import type { Agent, AgentStatus } from '../types.ts'

const execFileAsync = promisify(execFile)

export interface RawProcess {
  pid: number
  ppid: number
  tty: string
  comm: string
  args: string
}

export interface ExternalProcessMatch {
  proc: RawProcess
  agentKind: 'pi' | 'claude'
  session: string
}

export interface DiscoveryOptions {
  sessionsBaseDir?: string
  claudeBaseDir?: string
  execCommand?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
}

export type WarpDiscoveryOptions = DiscoveryOptions

export function defaultPiSessionsDir(): string {
  return join(homedir(), '.pi', 'agent', 'sessions')
}

export function defaultClaudeDir(): string {
  return join(homedir(), '.claude')
}

export function sessionSafePath(cwd: string): string {
  return `--${cwd.replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-')}--`
}

export function parsePsOutput(stdout: string): RawProcess[] {
  const lines = stdout.trim().split('\n').slice(1)
  const procs: RawProcess[] = []
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/)
    if (!match) continue
    procs.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3],
      comm: match[4],
      args: match[5] ?? '',
    })
  }
  return procs
}

export function findExternalAgentProcesses(procs: readonly RawProcess[]): ExternalProcessMatch[] {
  const procMap = new Map<number, RawProcess>()
  const candidates: Array<{ proc: RawProcess; agentKind: 'pi' | 'claude' }> = []

  for (const proc of procs) {
    procMap.set(proc.pid, proc)

    const isPi =
      proc.comm === 'pi' ||
      proc.comm.endsWith('/pi') ||
      proc.args === 'pi' ||
      proc.args.startsWith('pi ') ||
      /(?:^|\/)pi(?:\s|$)/.test(proc.args)

    const isClaude =
      proc.comm === 'claude' ||
      proc.comm.endsWith('/claude') ||
      proc.args === 'claude' ||
      proc.args.startsWith('claude ') ||
      /(?:^|\/)claude(?:\s|$)/.test(proc.args)

    const isWrapper =
      proc.args.startsWith('node -e') ||
      proc.comm === 'grep' ||
      proc.comm === 'bash' ||
      proc.comm === 'zsh' ||
      proc.comm === 'sh'

    if ((isPi || isClaude) && !isWrapper) {
      candidates.push({ proc, agentKind: isClaude ? 'claude' : 'pi' })
    }
  }

  const matches: ExternalProcessMatch[] = []
  for (const { proc, agentKind } of candidates) {
    let curr: RawProcess | undefined = proc
    let isWarp = false
    let isHerdr = false
    const visited = new Set<number>()

    while (curr && curr.ppid > 1 && !visited.has(curr.pid)) {
      visited.add(curr.pid)
      curr = procMap.get(curr.ppid)
      if (!curr) break

      if (curr.args.includes('herdr') || curr.comm.includes('herdr')) {
        isHerdr = true
        break
      }

      if (
        curr.args.includes('Warp.app') ||
        curr.args.includes('terminal-server') ||
        curr.comm.toLowerCase().includes('warp') ||
        curr.args.toLowerCase().includes('warp') ||
        curr.comm === 'stable' ||
        curr.args.includes('/stable')
      ) {
        isWarp = true
      }
    }

    if (!isHerdr) {
      matches.push({
        proc,
        agentKind,
        session: isWarp ? 'warp' : agentKind,
      })
    }
  }

  return matches
}

export function findWarpPiProcesses(procs: readonly RawProcess[]): RawProcess[] {
  return findExternalAgentProcesses(procs)
    .filter((m) => m.session === 'warp' && m.agentKind === 'pi')
    .map((m) => m.proc)
}

export function parseLsofCwdOutput(stdout: string): Map<number, string> {
  const result = new Map<number, string>()
  const lines = stdout.split('\n')
  let currentPid: number | null = null

  for (const line of lines) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1))
      currentPid = Number.isNaN(pid) ? null : pid
    } else if (line.startsWith('n') && currentPid !== null) {
      result.set(currentPid, line.slice(1))
      currentPid = null
    }
  }

  return result
}

export function getClaudeSessionCwd(pid: number, claudeBaseDir = defaultClaudeDir()): string | null {
  const sessionPath = join(claudeBaseDir, 'sessions', `${pid}.json`)
  if (!existsSync(sessionPath)) return null
  try {
    const raw = readFileSync(sessionPath, 'utf8')
    const data = JSON.parse(raw) as { cwd?: string }
    return data.cwd ?? null
  } catch {
    return null
  }
}

export function parseClaudeSessionStatus(
  pid: number,
  cwd: string,
  claudeBaseDir = defaultClaudeDir(),
): AgentStatus {
  const sessionPath = join(claudeBaseDir, 'sessions', `${pid}.json`)
  try {
    const raw = readFileSync(sessionPath, 'utf8')
    const data = JSON.parse(raw) as { status?: string }
    if (data.status === 'working' || data.status === 'running' || data.status === 'busy') return 'working'
    if (data.status === 'blocked' || data.status === 'waiting' || data.status === 'prompt') return 'blocked'
    if (data.status === 'done') return 'done'
    if (data.status === 'idle') return 'idle'
  } catch {
  }

  if (!cwd) return 'idle'
  const safeProject = cwd.replace(/[/\\:._]/g, '-')
  const projectDir = join(claudeBaseDir, 'projects', safeProject)
  try {
    const files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
    if (files.length === 0) return 'idle'
    files.sort((a, b) => a.localeCompare(b))
    const latestFile = join(projectDir, files[files.length - 1]!)
    const stat = statSync(latestFile)
    if (stat.size === 0) return 'idle'

    const fd = openSync(latestFile, 'r')
    const readLength = Math.min(stat.size, 8192)
    const buf = Buffer.alloc(readLength)
    readSync(fd, buf, 0, readLength, stat.size - readLength)
    closeSync(fd)

    const content = buf.toString('utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    if (lines.length === 0) return 'idle'

    const lastLine = lines[lines.length - 1]!
    const parsed = JSON.parse(lastLine) as {
      type?: string
      subtype?: string
      message?: { stop_reason?: string; role?: string }
    }

    if (parsed.type === 'user') return 'working'
    if (parsed.type === 'assistant') {
      if (parsed.message?.stop_reason === 'tool_use') return 'working'
      if (parsed.message?.stop_reason === 'end_turn') return 'idle'
    }
    if (parsed.type === 'system' && parsed.subtype === 'turn_duration') return 'idle'

    return 'idle'
  } catch {
    return 'idle'
  }
}

export function parsePiSessionStatus(cwd: string, sessionsBaseDir = defaultPiSessionsDir()): AgentStatus {
  if (!cwd) return 'idle'
  const dir = join(sessionsBaseDir, sessionSafePath(cwd))

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return 'idle'
  }

  if (files.length === 0) return 'idle'
  files.sort((a, b) => a.localeCompare(b))
  const latestFile = join(dir, files[files.length - 1]!)

  try {
    const stat = statSync(latestFile)
    if (stat.size === 0) return 'idle'

    const fd = openSync(latestFile, 'r')
    const readLength = Math.min(stat.size, 8192)
    const buf = Buffer.alloc(readLength)
    readSync(fd, buf, 0, readLength, stat.size - readLength)
    closeSync(fd)

    const content = buf.toString('utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    if (lines.length === 0) return 'idle'

    const lastLine = lines[lines.length - 1]!
    const parsed = JSON.parse(lastLine) as {
      type?: string
      message?: {
        role?: string
        content?: Array<{ type?: string; name?: string }>
      }
    }

    if (parsed.type === 'message' && parsed.message) {
      const msg = parsed.message
      if (msg.role === 'user' || msg.role === 'toolResult') return 'working'
      if (msg.role === 'assistant') {
        const toolCalls = Array.isArray(msg.content)
          ? msg.content.filter((c) => c?.type === 'toolCall')
          : []
        if (toolCalls.length > 0) {
          if (toolCalls.some((tc) => tc?.name === 'ask_user')) return 'blocked'
          return 'working'
        }
        return 'idle'
      }
    }

    return 'idle'
  } catch {
    return 'idle'
  }
}

export class WarpAgentScanner {
  #cwdCache = new Map<number, string>()
  #sessionsBaseDir: string
  #claudeBaseDir: string
  #exec: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

  constructor(options: DiscoveryOptions = {}) {
    this.#sessionsBaseDir = options.sessionsBaseDir ?? defaultPiSessionsDir()
    this.#claudeBaseDir = options.claudeBaseDir ?? defaultClaudeDir()
    this.#exec = options.execCommand ?? execFileAsync
  }

  async scan(): Promise<Agent[]> {
    let psOutput = ''
    try {
      const { stdout } = await this.#exec('ps', ['-A', '-o', 'pid,ppid,tty,comm,args'])
      psOutput = stdout
    } catch {
      return []
    }

    const procs = parsePsOutput(psOutput)
    const matches = findExternalAgentProcesses(procs)
    if (matches.length === 0) {
      this.#cwdCache.clear()
      return []
    }

    const activePids = new Set(matches.map((m) => m.proc.pid))
    for (const pid of this.#cwdCache.keys()) {
      if (!activePids.has(pid)) this.#cwdCache.delete(pid)
    }

    for (const match of matches) {
      if (!this.#cwdCache.has(match.proc.pid) && match.agentKind === 'claude') {
        const claudeCwd = getClaudeSessionCwd(match.proc.pid, this.#claudeBaseDir)
        if (claudeCwd) this.#cwdCache.set(match.proc.pid, claudeCwd)
      }
    }

    const missingPids = matches.filter((m) => !this.#cwdCache.has(m.proc.pid)).map((m) => m.proc.pid)
    if (missingPids.length > 0) {
      try {
        const { stdout } = await this.#exec('lsof', [
          '-b',
          '-l',
          '-n',
          '-P',
          '-a',
          '-d',
          'cwd',
          '-p',
          missingPids.join(','),
          '-Fn',
        ])
        const foundCwds = parseLsofCwdOutput(stdout)
        for (const [pid, cwd] of foundCwds) {
          this.#cwdCache.set(pid, cwd)
        }
      } catch {
      }
    }

    let isWarpFocused = false
    try {
      const { stdout } = await this.#exec('lsappinfo', ['info', '-only', 'bundleid', 'front'])
      isWarpFocused = stdout.includes('dev.warp.Warp-Stable') || stdout.includes('dev.warp.Warp')
    } catch {
    }

    const agents: Agent[] = []
    for (const match of matches) {
      const proc = match.proc
      const cwd = this.#cwdCache.get(proc.pid) ?? ''
      const status =
        match.agentKind === 'claude'
          ? parseClaudeSessionStatus(proc.pid, cwd, this.#claudeBaseDir)
          : parsePiSessionStatus(cwd, this.#sessionsBaseDir)

      agents.push({
        session: match.session,
        paneId: String(proc.pid),
        workspaceId: match.session,
        status,
        cwd,
        repo: repoLabel(cwd),
        agent: match.agentKind,
        focused: match.session === 'warp' ? isWarpFocused : false,
      })
    }

    return agents
  }
}
