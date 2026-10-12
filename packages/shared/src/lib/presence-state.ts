/**
 * Idle or stuck (#1394). /presence/online, the people page and the team view
 * answer `stuck: { minutes, label }` for someone at the keyboard, on the same
 * route, with nothing saved for ten minutes — shown to admins and the
 * person's manager only. One wording everywhere.
 */
export interface StuckState {
  minutes: number
  /** The record's friendly id ("CM26-80332") or the page path. */
  label: string | null
}

/** "stuck on CM26-80332 for 12m" (or "stuck for 12m" with no page). */
export function stuckText(s: StuckState): string {
  const m = Math.max(0, Math.floor(s.minutes))
  const span = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
  return s.label ? `stuck on ${s.label} for ${span}` : `stuck for ${span}`
}

/** "/records/workflows/312100" → "Workflows › 312100" — a route read as a place, not a URL. */
export function prettyPagePath(path: string | null | undefined): string | null {
  if (!path) return null
  const parts = path.split('?')[0].split('/').filter(Boolean)
  if (parts.length === 0) return 'Home'
  const skip = new Set(['records', 'collections', 'p'])
  const kept = parts.filter((p) => !skip.has(p))
  if (kept.length === 0) return 'Home'
  return kept
    .map((p, i) => (i === 0 ? p.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : p))
    .join(' › ')
}

/** The one word for a person's presence: what the avatar dot and the status line say. */
export type PresenceWord = 'online' | 'idle' | 'away' | 'offline'

export function presenceWord(p: {
  online: boolean
  away?: boolean
  idle_minutes?: number | null
}): PresenceWord {
  if (!p.online) return 'offline'
  if (p.away) return 'away'
  return (p.idle_minutes ?? 0) >= 5 ? 'idle' : 'online'
}
