import { execFile } from 'node:child_process'
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
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

export interface WarpDiscoveryOptions {
  sessionsBaseDir?: string
  execCommand?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
}

export function defaultPiSessionsDir(): string {
  return join(homedir(), '.pi', 'agent', 'sessions')
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

export function findWarpPiProcesses(procs: readonly RawProcess[]): RawProcess[] {
  const procMap = new Map<number, RawProcess>()
  const candidates: RawProcess[] = []

  for (const proc of procs) {
    procMap.set(proc.pid, proc)

    const isPi =
      proc.comm === 'pi' ||
      proc.comm.endsWith('/pi') ||
      proc.args === 'pi' ||
      proc.args.startsWith('pi ') ||
      /(?:^|\/)pi(?:\s|$)/.test(proc.args)

    const isWrapper =
      proc.args.startsWith('node -e') ||
      proc.comm === 'grep' ||
      proc.comm === 'bash' ||
      proc.comm === 'zsh' ||
      proc.comm === 'sh'

    if (isPi && !isWrapper) {
      candidates.push(proc)
    }
  }

  const warpPi: RawProcess[] = []
  for (const candidate of candidates) {
    let curr: RawProcess | undefined = candidate
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

    if (isWarp && !isHerdr) {
      warpPi.push(candidate)
    }
  }

  return warpPi
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
  #exec: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

  constructor(options: WarpDiscoveryOptions = {}) {
    this.#sessionsBaseDir = options.sessionsBaseDir ?? defaultPiSessionsDir()
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
    const warpPis = findWarpPiProcesses(procs)
    if (warpPis.length === 0) {
      this.#cwdCache.clear()
      return []
    }

    const activePids = new Set(warpPis.map((p) => p.pid))
    for (const pid of this.#cwdCache.keys()) {
      if (!activePids.has(pid)) this.#cwdCache.delete(pid)
    }

    const missingPids = warpPis.filter((p) => !this.#cwdCache.has(p.pid)).map((p) => p.pid)
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
    for (const proc of warpPis) {
      const cwd = this.#cwdCache.get(proc.pid) ?? ''
      const status = parsePiSessionStatus(cwd, this.#sessionsBaseDir)
      agents.push({
        session: 'warp',
        paneId: String(proc.pid),
        workspaceId: 'warp',
        status,
        cwd,
        repo: repoLabel(cwd),
        agent: 'pi',
        focused: isWarpFocused,
      })
    }

    return agents
  }
}
