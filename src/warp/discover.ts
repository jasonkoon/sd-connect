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
  warpDbPath?: string
  execCommand?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
}

export type WarpDiscoveryOptions = DiscoveryOptions

export function defaultPiSessionsDir(): string {
  return join(homedir(), '.pi', 'agent', 'sessions')
}

export function defaultClaudeDir(): string {
  return join(homedir(), '.claude')
}

export function defaultWarpDbPath(): string {
  return join(
    homedir(),
    'Library',
    'Group Containers',
    '2BBY89MBSN.dev.warp',
    'Library',
    'Application Support',
    'dev.warp.Warp-Stable',
    'warp.sqlite',
  )
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

/**
 * Parse `ps -Eww -o pid=,command=` output into pid -> warp://session/... URL.
 *
 * -E appends each process's exec-time environment to its command line, and
 * Warp exports WARP_FOCUS_URL into every tab shell, so any agent launched from
 * a Warp tab carries the deep link that focuses that exact tab.
 */
export function parseWarpFocusUrls(stdout: string): Map<number, string> {
  const result = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const pidMatch = line.match(/^\s*(\d+)\s/)
    if (!pidMatch) continue
    const urlMatch = line.match(/\bWARP_FOCUS_URL=(warp:\/\/\S+)/)
    if (urlMatch) result.set(Number(pidMatch[1]), urlMatch[1]!)
  }
  return result
}

export interface WarpPaneRecord {
  uuid: string
  cwd: string
  lastBlockMs: number | null
}

const WARP_PANES_SQL =
  "SELECT lower(hex(tp.uuid)), COALESCE(tp.cwd, ''), COALESCE(MAX(COALESCE(b.completed_ts, b.start_ts)), '') " +
  'FROM terminal_panes tp ' +
  'LEFT JOIN blocks b ON b.pane_leaf_uuid = tp.uuid ' +
  'GROUP BY tp.id;'

function normalizePath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/**
 * Parse `sqlite3 -separator $'\t'` output from `WARP_PANES_SQL`.
 * Timestamps in Warp's sqlite DB are UTC strings (`YYYY-MM-DD HH:MM:SS.ffffff`).
 */
export function parseWarpSqlitePanes(stdout: string): WarpPaneRecord[] {
  const panes: WarpPaneRecord[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [rawUuid, rawCwd = '', rawTs = ''] = line.split('\t')
    const uuid = rawUuid?.trim().toLowerCase() ?? ''
    if (!/^[0-9a-f]{32}$/.test(uuid)) continue
    let lastBlockMs: number | null = null
    const ts = rawTs.trim()
    if (ts) {
      const parsed = Date.parse(`${ts.replace(' ', 'T')}Z`)
      if (!Number.isNaN(parsed)) lastBlockMs = parsed
    }
    panes.push({
      uuid,
      cwd: normalizePath(rawCwd.trim()),
      lastBlockMs,
    })
  }
  return panes
}

/** Parse `ps -o pid=,lstart=` output into pid -> epoch ms. */
export function parsePsStartTimes(stdout: string): Map<number, number> {
  const result = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    const ms = Date.parse(match[2]!.trim())
    if (!Number.isNaN(ms)) result.set(Number(match[1]), ms)
  }
  return result
}

/**
 * Match Warp agent processes whose `WARP_FOCUS_URL` was not readable via
 * `ps -Eww` (for example, `pi` sets `process.title = 'pi'`, which on macOS
 * zeroes the KERN_PROCARGS2 argv/envp buffer) against open panes in Warp's
 * sqlite database.
 *
 * Matches by `cwd`, breaking ties when multiple panes share a `cwd` by picking
 * the pane whose most recent completed block precedes the process's start time
 * by the smallest margin.
 */
export function matchWarpPanesToPids(
  candidates: ReadonlyArray<{ pid: number; cwd: string; startMs: number | null }>,
  panes: readonly WarpPaneRecord[],
  claimedUuids: ReadonlySet<string> = new Set(),
): Map<number, string> {
  const result = new Map<number, string>()
  const usedUuids = new Set<string>(claimedUuids)

  const candidatesByCwd = new Map<string, Array<{ pid: number; cwd: string; startMs: number | null }>>()
  for (const c of candidates) {
    const cwd = normalizePath(c.cwd)
    if (!cwd) continue
    const list = candidatesByCwd.get(cwd) ?? []
    list.push({ ...c, cwd })
    candidatesByCwd.set(cwd, list)
  }

  const panesByCwd = new Map<string, WarpPaneRecord[]>()
  for (const p of panes) {
    if (!p.cwd || usedUuids.has(p.uuid)) continue
    const list = panesByCwd.get(p.cwd) ?? []
    list.push(p)
    panesByCwd.set(p.cwd, list)
  }

  // `ps -o lstart=` has 1-second resolution; allow a small tolerance for clock
  // and rounding skew between Warp's block timestamp and process start.
  const SKEW_TOLERANCE_MS = 2000

  for (const [cwd, groupCandidates] of candidatesByCwd) {
    const groupPanes = (panesByCwd.get(cwd) ?? []).filter((p) => !usedUuids.has(p.uuid))
    if (groupPanes.length === 0) continue

    if (groupCandidates.length === 1 && groupPanes.length === 1) {
      const pane = groupPanes[0]!
      usedUuids.add(pane.uuid)
      result.set(groupCandidates[0]!.pid, `warp://session/${pane.uuid}`)
      continue
    }

    const pairs: Array<{ pid: number; uuid: string; delta: number }> = []
    for (const c of groupCandidates) {
      if (c.startMs === null) continue
      for (const p of groupPanes) {
        if (p.lastBlockMs === null) continue
        if (p.lastBlockMs <= c.startMs + SKEW_TOLERANCE_MS) {
          pairs.push({
            pid: c.pid,
            uuid: p.uuid,
            delta: Math.abs(c.startMs - p.lastBlockMs),
          })
        }
      }
    }
    pairs.sort((a, b) => a.delta - b.delta)

    const matchedPids = new Set<number>()
    for (const pair of pairs) {
      if (matchedPids.has(pair.pid) || usedUuids.has(pair.uuid)) continue
      matchedPids.add(pair.pid)
      usedUuids.add(pair.uuid)
      result.set(pair.pid, `warp://session/${pair.uuid}`)
    }

    // If exactly one candidate and one pane remain unmatched for this cwd
    // (e.g. a brand-new tab with no prior blocks), pair them directly.
    const remainingCandidates = groupCandidates.filter((c) => !matchedPids.has(c.pid))
    const remainingPanes = groupPanes.filter((p) => !usedUuids.has(p.uuid))
    if (remainingCandidates.length === 1 && remainingPanes.length === 1) {
      const pane = remainingPanes[0]!
      usedUuids.add(pane.uuid)
      result.set(remainingCandidates[0]!.pid, `warp://session/${pane.uuid}`)
    }
  }

  return result
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
  // null = looked up and absent (agent not launched from a Warp tab), so we
  // don't re-run ps for it every scan.
  #focusUrlCache = new Map<number, string | null>()
  #sessionsBaseDir: string
  #claudeBaseDir: string
  #warpDbPath: string
  #exec: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

  constructor(options: DiscoveryOptions = {}) {
    this.#sessionsBaseDir = options.sessionsBaseDir ?? defaultPiSessionsDir()
    this.#claudeBaseDir = options.claudeBaseDir ?? defaultClaudeDir()
    this.#warpDbPath = options.warpDbPath ?? defaultWarpDbPath()
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
    for (const pid of this.#focusUrlCache.keys()) {
      if (!activePids.has(pid)) this.#focusUrlCache.delete(pid)
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

    const focusUrlPids = matches
      .filter((m) => m.session === 'warp' && !this.#focusUrlCache.has(m.proc.pid))
      .map((m) => m.proc.pid)
    if (focusUrlPids.length > 0) {
      let found = new Map<number, string>()
      try {
        const { stdout } = await this.#exec('ps', [
          '-Eww',
          '-o',
          'pid=,command=',
          '-p',
          focusUrlPids.join(','),
        ])
        found = parseWarpFocusUrls(stdout)
      } catch {
      }

      const unresolvedPids = focusUrlPids.filter((pid) => !found.has(pid))
      if (unresolvedPids.length > 0) {
        try {
          const [sqliteRes, lstartRes] = await Promise.all([
            this.#exec('sqlite3', [
              '-readonly',
              '-cmd',
              '.timeout 500',
              '-separator',
              '\t',
              this.#warpDbPath,
              WARP_PANES_SQL,
            ]),
            this.#exec('ps', ['-o', 'pid=,lstart=', '-p', unresolvedPids.join(',')]),
          ])
          const panes = parseWarpSqlitePanes(sqliteRes.stdout)
          const startTimes = parsePsStartTimes(lstartRes.stdout)
          const claimedUuids = new Set<string>()
          for (const url of [...this.#focusUrlCache.values(), ...found.values()]) {
            const m = url?.match(/^warp:\/\/session\/([0-9a-f]{32})$/i)
            if (m) claimedUuids.add(m[1]!.toLowerCase())
          }
          const matched = matchWarpPanesToPids(
            unresolvedPids.map((pid) => ({
              pid,
              cwd: this.#cwdCache.get(pid) ?? '',
              startMs: startTimes.get(pid) ?? null,
            })),
            panes,
            claimedUuids,
          )
          for (const [pid, url] of matched) {
            found.set(pid, url)
          }
        } catch {
        }
      }

      for (const pid of focusUrlPids) {
        this.#focusUrlCache.set(pid, found.get(pid) ?? null)
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
        focusUrl: this.#focusUrlCache.get(proc.pid) ?? undefined,
      })
    }

    return agents
  }
}
