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

/** Presence `app` values the admin console writes: its heartbeat stamps 'API', page:at 'admin'. */
const ADMIN_APPS = new Set(['API', 'admin'])

/**
 * Where a person's current page opens for this viewer. The path is a route in the PERSON's app,
 * which may not be the viewer's: a record page goes through the host's own record route (the
 * same record reads in admin and in a portal); an admin-console page opens on the admin SPA;
 * any other page only when the viewer is in that same app. Null = shown as text only.
 * `current_path` only reaches administrators, so nobody else gets a link.
 */
export function presencePlaceHref(
  path: string | null | undefined,
  app: string | null | undefined,
  adminUrl: string | null | undefined,
  recordUrl: ((collection: string, id: string) => string | null) | undefined,
  viewerOrigin: string | null
): string | null {
  if (!path) return null
  const clean = path.split('#')[0]
  const rec = /^\/(?:records|collections)\/([A-Za-z0-9_]+)\/([^/?#]+)/.exec(clean)
  if (rec && rec[2] !== 'new' && recordUrl) {
    const url = recordUrl(rec[1], rec[2])
    if (url) return url
  }
  const base = adminUrl?.replace(/\/$/, '') ?? ''
  let onAdminHost = false
  try {
    onAdminHost = !!base && !!viewerOrigin && new URL(base, viewerOrigin).origin === viewerOrigin
  } catch {
    onAdminHost = false
  }
  if (app && ADMIN_APPS.has(app)) return onAdminHost ? clean : base ? `${base}${clean}` : null
  return onAdminHost ? null : clean
}

/** The full address a link goes to, for its tooltip. */
export function fullHref(href: string, origin?: string | null): string {
  if (/^https?:\/\//i.test(href)) return href
  const o = origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  return `${o}${href}`
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
