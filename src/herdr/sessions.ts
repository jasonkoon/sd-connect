/**
 * Session discovery.
 *
 * herdr keeps one directory per session under ~/.config/herdr/sessions/, each
 * with a herdr.sock. A socket file existing does not mean a server is listening
 * (stopped sessions leave theirs behind), so liveness is proved by an actual
 * ping rather than by stat.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request } from './protocol.ts'

export interface Session {
  name: string
  socketPath: string
}

export function defaultSessionsDir(): string {
  return join(homedir(), '.config', 'herdr', 'sessions')
}

/** Sessions that have a socket file, live or not. */
export async function discoverSessions(sessionsDir = defaultSessionsDir()): Promise<Session[]> {
  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    // No herdr config at all is a normal state, not an error.
    return []
  }

  const sessions: Session[] = []
  for (const name of entries.sort()) {
    const socketPath = join(sessionsDir, name, 'herdr.sock')
    try {
      const info = await stat(socketPath)
      if (info.isSocket()) sessions.push({ name, socketPath })
    } catch {
      // Directory without a socket: a session that was deleted, skip it.
    }
  }
  return sessions
}

/** True if something is actually listening and answering. */
export async function isLive(session: Session, timeoutMs = 1000): Promise<boolean> {
  try {
    await request(session.socketPath, 'ping', {}, { timeoutMs })
    return true
  } catch {
    return false
  }
}

/** Sessions with a server currently answering on the socket. */
export async function discoverLiveSessions(sessionsDir = defaultSessionsDir()): Promise<Session[]> {
  const found = await discoverSessions(sessionsDir)
  const checks = await Promise.all(found.map(async (s) => ((await isLive(s)) ? s : null)))
  return checks.filter((s): s is Session => s !== null)
}
