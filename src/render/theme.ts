/** Visual constants for the key face. */

import type { AgentStatus } from '../types.ts'

export interface Theme {
  background: string
  /** Accent colour for a macro key whose label has no explicit colour. */
  macroColor: string
  repoColor: string
  sessionColor: string
  overflowColor: string
  fontFamily: string
  /** Height of the status bar across the top, in pixels. */
  barHeight: number
  statusColors: Record<AgentStatus, string>
}

export const DEFAULT_THEME: Theme = {
  background: '#14161a',
  macroColor: '#8b5cf6',
  repoColor: '#ffffff',
  sessionColor: '#8a90a0',
  overflowColor: '#c8ccd6',
  // Helvetica is always present on macOS. @napi-rs/canvas reports 311 system
  // families here, so this resolves without shipping a font file.
  fontFamily: 'Helvetica, Arial, sans-serif',
  barHeight: 10,
  statusColors: {
    idle: '#22c55e',
    working: '#3b82f6',
    blocked: '#ef4444',
    done: '#eab308',
    unknown: '#6b7280',
  },
}
