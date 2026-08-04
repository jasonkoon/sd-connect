/**
 * Config loading from ~/.config/sd-connect/config.toml.
 *
 * A missing file is normal and yields defaults. A malformed file is reported
 * with the specific problem and then ignored, because a typo in a colour should
 * not stop the deck from working.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { AGENT_STATUSES, type AgentStatus } from './types.ts'
import type { Pin } from './layout.ts'
import { DEFAULT_THEME, type Theme } from './render/theme.ts'

/** The localhost viewer, for when the deck is not plugged in. */
export interface WebConfig {
  enabled: boolean
  /** Loopback only; never bound to a routable address. */
  port: number
}

export interface Config {
  brightness: number
  pollIntervalMs: number
  web: WebConfig
  /**
   * Raise the terminal window on a key press. Needs Accessibility permission
   * and a terminal whose window titles mention the herdr session name. Turn it
   * off to keep presses purely inside herdr.
   */
  raiseWindow: boolean
  pins: Pin[]
  theme: Theme
}

/**
 * Lowest port not needing root, and the highest legal one. Ports below 1024
 * are unusable here because this never runs privileged.
 */
export const MIN_PORT = 1024
export const MAX_PORT = 65535

/** The one definition of the default port. Re-exported by the web sink. */
export const DEFAULT_PORT = 8787

export function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PORT &&
    value <= MAX_PORT
  )
}

export const DEFAULT_WEB_CONFIG: WebConfig = {
  enabled: true,
  port: DEFAULT_PORT,
}

export const DEFAULT_CONFIG: Config = {
  brightness: 70,
  pollIntervalMs: 400,
  raiseWindow: true,
  web: DEFAULT_WEB_CONFIG,
  pins: [],
  theme: DEFAULT_THEME,
}

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'sd-connect', 'config.toml')
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export interface ParseResult {
  config: Config
  /** Human-readable problems. Each one was ignored, not fatal. */
  warnings: string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Parse already-read TOML text. Split out from loading so it is testable. */
export function parseConfig(text: string): ParseResult {
  const warnings: string[] = []

  let raw: Record<string, unknown> | null
  try {
    raw = asRecord(parseToml(text))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { config: DEFAULT_CONFIG, warnings: [`could not parse config: ${message}`] }
  }
  if (!raw) return { config: DEFAULT_CONFIG, warnings: ['config is not a table'] }

  const config: Config = {
    ...DEFAULT_CONFIG,
    web: { ...DEFAULT_WEB_CONFIG },
    pins: [],
    theme: { ...DEFAULT_THEME, statusColors: { ...DEFAULT_THEME.statusColors } },
  }

  if (raw.brightness !== undefined) {
    const value = raw.brightness
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      warnings.push(`brightness must be a number 0-100, got ${JSON.stringify(value)}`)
    } else {
      config.brightness = value
    }
  }

  if (raw.poll_interval_ms !== undefined) {
    const value = raw.poll_interval_ms
    // Below ~50ms we would be hammering the socket for no perceivable gain.
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 50) {
      warnings.push(`poll_interval_ms must be a number >= 50, got ${JSON.stringify(value)}`)
    } else {
      config.pollIntervalMs = value
    }
  }

  if (raw.raise_window !== undefined) {
    if (typeof raw.raise_window !== 'boolean') {
      warnings.push(`raise_window must be true or false, got ${JSON.stringify(raw.raise_window)}`)
    } else {
      config.raiseWindow = raw.raise_window
    }
  }

  const web = asRecord(raw.web)
  if (raw.web !== undefined && !web) {
    warnings.push('[web] must be a table')
  } else if (web) {
    if (web.enabled !== undefined) {
      if (typeof web.enabled !== 'boolean') {
        warnings.push(`web.enabled must be true or false, got ${JSON.stringify(web.enabled)}`)
      } else {
        config.web.enabled = web.enabled
      }
    }
    if (web.port !== undefined) {
      if (!isValidPort(web.port)) {
        warnings.push(
          `web.port must be an integer ${MIN_PORT}-${MAX_PORT}, got ${JSON.stringify(web.port)}`,
        )
      } else {
        config.web.port = web.port
      }
    }
  }

  const colors = asRecord(raw.colors)
  if (raw.colors !== undefined && !colors) {
    warnings.push('[colors] must be a table')
  } else if (colors) {
    for (const [name, value] of Object.entries(colors)) {
      if (!(AGENT_STATUSES as readonly string[]).includes(name)) {
        warnings.push(`unknown status colour '${name}' (expected ${AGENT_STATUSES.join(', ')})`)
        continue
      }
      if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
        warnings.push(`colour '${name}' must be #rrggbb, got ${JSON.stringify(value)}`)
        continue
      }
      config.theme.statusColors[name as AgentStatus] = value
    }
  }

  if (raw.pins !== undefined) {
    if (!Array.isArray(raw.pins)) {
      warnings.push('pins must be an array of [[pins]] tables')
    } else {
      const usedKeys = new Set<number>()
      raw.pins.forEach((entry, index) => {
        const pin = asRecord(entry)
        const label = `pins[${index}]`
        if (!pin) {
          warnings.push(`${label} is not a table`)
          return
        }
        const { key, session, cwd } = pin
        if (typeof key !== 'number' || !Number.isInteger(key) || key < 0) {
          warnings.push(`${label}.key must be a non-negative integer, got ${JSON.stringify(key)}`)
          return
        }
        if (typeof session !== 'string' || session === '') {
          warnings.push(`${label}.session must be a non-empty string`)
          return
        }
        if (typeof cwd !== 'string' || cwd === '') {
          warnings.push(`${label}.cwd must be a non-empty string`)
          return
        }
        if (usedKeys.has(key)) {
          warnings.push(`${label}.key ${key} is already pinned; ignoring the duplicate`)
          return
        }
        usedKeys.add(key)
        config.pins.push({ key, session, cwd })
      })
    }
  }

  return { config, warnings }
}

/** Load config from disk. Missing file yields defaults with no warnings. */
export async function loadConfig(
  path = defaultConfigPath(),
): Promise<ParseResult & { path: string; existed: boolean }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: DEFAULT_CONFIG, warnings: [], path, existed: false }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { config: DEFAULT_CONFIG, warnings: [`could not read config: ${message}`], path, existed: true }
  }
  const parsed = parseConfig(text)
  return { ...parsed, path, existed: true }
}
