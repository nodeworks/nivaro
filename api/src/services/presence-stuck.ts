import { db } from '../db/index.js'

/**
 * Idle or stuck (#1394) — presence has three states, not two:
 *
 *   active  — input recently, and things are moving
 *   idle    — no input (the existing rule: the client's is_idle flag weighed
 *             against last_active, /presence/online's classifier)
 *   stuck   — input in the last five minutes, but the same route and nothing
 *             that changed anything (a save, a transition, any write request)
 *             for ten minutes: the person is at the keyboard and not getting
 *             anywhere — the moment someone could help.
 *
 * Computed from what the server already has, no new state:
 *   route since   — the newest nivaro_admin_journeys row (page:at, admin AND
 *                   portal since #1391): the last time they changed route
 *   last change   — the newest non-GET, non-failed request of theirs in
 *                   nivaro_api_logs, minus the writes a page makes on its own
 *                   (presence beats, recording uploads, telemetry)
 * Two grouped reads, and only for people who are active right now.
 */

/** Matches the client's own threshold (packages/shared/src/lib/idle.ts). */
const IDLE_AFTER_MS = 5 * 60_000

/**
 * The idle half of the classifier (/presence/online's rule). The flag is a
 * client's claim; last_active is when it last saw real input. Trusting the
 * flag alone left people idle forever whenever a client wrote presence
 * without reporting it. Idle when the client says so OR its last real input
 * is stale — recent activity wins in both directions. "Appear away" beats
 * activity.
 */
export function presenceRowIdle(
  r: Record<string, unknown>,
  away: boolean,
  now = Date.now()
): boolean {
  if (away) return true
  const flag = r.is_idle === true || r.is_idle === 1
  const active = r.last_active ? new Date(r.last_active as string).getTime() : 0
  if (active && now - active > IDLE_AFTER_MS) return true
  if (!flag) return false
  if (!active) return true
  return now - active > IDLE_AFTER_MS
}

/** "Appear away" (preferences.presence_override) — the same rule /online applies. */
export function presenceOverrideAway(prefs: Record<string, unknown>): boolean {
  const po = prefs.presence_override as { mode?: string; until?: string | null } | null | undefined
  if (!po || po.mode !== 'away') return false
  return !(po.until && new Date(po.until).getTime() < Date.now())
}

/** Do not disturb (preferences.dnd, #2114): on until `until`, or until switched off. */
export function dndActive(prefs: Record<string, unknown>, now = Date.now()): boolean {
  const d = prefs.dnd as { until?: string | null } | null | undefined
  if (!d || typeof d !== 'object') return false
  return !(d.until && new Date(d.until).getTime() <= now)
}

export const STUCK_INPUT_MS = 5 * 60_000
export const STUCK_AFTER_MS = 10 * 60_000

export type PresenceState = 'active' | 'idle' | 'stuck'

export interface StuckInput {
  now: number
  /** The existing idle verdict (flag + last_active + "appear away"). */
  idle: boolean
  /** Last real input, epoch ms. */
  lastActive: number | null
  /** Last route change, epoch ms. */
  routeSince: number | null
  /** Last request that changed something, epoch ms. */
  lastChangeAt: number | null
}

export function classifyPresence(i: StuckInput): {
  state: PresenceState
  stuck_minutes: number | null
} {
  if (i.idle) return { state: 'idle', stuck_minutes: null }
  if (i.lastActive == null || i.now - i.lastActive > STUCK_INPUT_MS) {
    return { state: 'active', stuck_minutes: null }
  }
  if (i.routeSince == null) return { state: 'active', stuck_minutes: null }
  const since = Math.max(i.routeSince, i.lastChangeAt ?? 0)
  if (i.now - since < STUCK_AFTER_MS) return { state: 'active', stuck_minutes: null }
  return { state: 'stuck', stuck_minutes: Math.floor((i.now - since) / 60_000) }
}

/** Writes a page makes on its own — none of them is the person getting anywhere. */
export const BACKGROUND_WRITE_PATHS = [
  '/api/items/user_presence',
  '/api/presence/',
  '/api/session-recordings/',
  '/api/rum',
  '/api/issues/client',
  '/api/auth/',
  '/api/notifications/',
  '/api/chat/typing',
  '/api/users/me/preferences'
]

/** True when a request (method + path) counts as changing something. */
export function isChangeRequest(method: string, path: string, status: number): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return false
  if (status >= 400) return false
  return !BACKGROUND_WRITE_PATHS.some((p) => path.startsWith(p))
}

const ms = (v: unknown): number | null => {
  if (v == null) return null
  const t = new Date(v as string).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * The stuck verdict for people already classified active/idle. Returns
 * upper-cased id → minutes stuck, for the stuck ones only. Never throws: a
 * missing table or a failed read just means nobody reads as stuck.
 */
export async function stuckMinutes(
  people: ReadonlyArray<{ id: string; idle: boolean; lastActive: number | null }>,
  now = Date.now()
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const active = people.filter(
    (p) => !p.idle && p.lastActive != null && now - p.lastActive <= STUCK_INPUT_MS
  )
  if (active.length === 0) return out
  try {
    const ids = active.map((p) => p.id).slice(0, 500)
    const routeRows = (await db('nivaro_admin_journeys')
      .whereIn('user', ids)
      .where('entered_at', '>', new Date(now - 8 * 3_600_000))
      .groupBy('user')
      .select('user')
      .max({ since: 'entered_at' })) as Array<{ user: string; since: unknown }>
    const routeSince = new Map(routeRows.map((r) => [String(r.user).toUpperCase(), ms(r.since)]))
    // Only people on one route for ten minutes need the request read.
    const candidates = ids.filter((id) => {
      const t = routeSince.get(id.toUpperCase())
      return t != null && now - t >= STUCK_AFTER_MS
    })
    if (candidates.length === 0) return out
    const changeRows = (await db('nivaro_api_logs')
      .whereIn('user', candidates)
      .where('created_at', '>', new Date(now - STUCK_AFTER_MS - 60_000))
      .whereIn('method', ['POST', 'PUT', 'PATCH', 'DELETE'])
      .where('status', '<', 400)
      .where((q) => {
        for (const p of BACKGROUND_WRITE_PATHS) q.whereNot('path', 'like', `${p}%`)
      })
      .groupBy('user')
      .select('user')
      .max({ at: 'created_at' })) as Array<{ user: string; at: unknown }>
    const lastChange = new Map(changeRows.map((r) => [String(r.user).toUpperCase(), ms(r.at)]))
    for (const p of active) {
      const key = p.id.toUpperCase()
      if (!candidates.some((c) => c.toUpperCase() === key)) continue
      const v = classifyPresence({
        now,
        idle: false,
        lastActive: p.lastActive,
        routeSince: routeSince.get(key) ?? null,
        lastChangeAt: lastChange.get(key) ?? null
      })
      if (v.state === 'stuck' && v.stuck_minutes != null) out.set(key, v.stuck_minutes)
    }
  } catch {
    /* presence decoration — never fail the caller over it */
  }
  return out
}

/** collection name → a heading a person would recognise. */
function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * The page text for a presence row. A record page reads "Requests › REQ-1234" when the viewer
 * could read that record, and just "Requests" when not — never the raw id. A new-record form
 * reads "Requests › New". Other routes read as their first segment ("Sla Rules"), with the rest
 * of the path dropped.
 */
export function presencePageLabel(
  path: string | null | undefined,
  labels: Map<string, string>
): string | null {
  if (!path) return null
  const m = /^\/(?:records|collections)\/([A-Za-z0-9_]+)(?:\/([^/?#]+))?/.exec(path)
  if (m) {
    if (m[2] === 'new') return `${titleCase(m[1])} › New`
    const label = m[2] ? labels.get(`${m[1]}:${m[2]}`) : undefined
    return label ? `${titleCase(m[1])} › ${label}` : titleCase(m[1])
  }
  const first = path.split('?')[0].split('/').filter(Boolean)[0]
  return first ? titleCase(first.replace(/[-_]/g, ' ')) : 'Home'
}

/**
 * "CM26-80332" for a record page whose label resolved, else the same page text the presence
 * line shows ("Workflows", "Workflows › New") — never the raw route, which read as a different
 * place from the page line under the person's name.
 */
export function stuckLabel(
  path: string | null | undefined,
  recordLabels: Map<string, string>
): string | null {
  if (!path) return null
  const m = /^\/(?:records|collections)\/([A-Za-z0-9_]+)\/([^/?#]+)/.exec(path)
  if (m) {
    const label = recordLabels.get(`${m[1]}:${m[2]}`)
    if (label) return label
  }
  return presencePageLabel(path, recordLabels)
}

/**
 * One person's stuck state for a viewer (the people page, the team view):
 * null unless the viewer may know it — an admin, or the person's manager —
 * and the person is online and stuck. The label resolves a record page to
 * its friendly id as the viewer may read it.
 */
export async function stuckForViewer(
  person: { id: string; manager_id?: string | null },
  presenceRow: Record<string, unknown> | undefined,
  viewer: { id: string; isAdmin: boolean },
  opts: { away?: boolean; online: boolean }
): Promise<{ minutes: number; label: string | null } | null> {
  if (!opts.online || !presenceRow) return null
  const isManager =
    !!person.manager_id && String(person.manager_id).toUpperCase() === viewer.id.toUpperCase()
  if (!viewer.isAdmin && !isManager) return null
  const idle = presenceRowIdle(presenceRow, !!opts.away)
  const lastActive = presenceRow.last_active
    ? new Date(presenceRow.last_active as string).getTime()
    : null
  const minutes = (await stuckMinutes([{ id: person.id, idle, lastActive }])).get(
    person.id.toUpperCase()
  )
  if (minutes == null) return null
  const path = (presenceRow.current_path as string | null) ?? null
  let labels = new Map<string, string>()
  try {
    const viewerUser = await db('nivaro_users').where({ id: viewer.id }).first()
    if (viewerUser && path) {
      const { resolveRecordLabels } = await import('../routes/presence.js')
      labels = await resolveRecordLabels([path], viewerUser)
    }
  } catch {
    /* the raw path still says where */
  }
  return { minutes, label: stuckLabel(path, labels) }
}

/**
 * The team view (#1394): who among these people is stuck right now. Online
 * means the /online window (last beat within 70s, not flagged offline).
 * The caller decides who may see it (the manager of these people, or an admin).
 */
export async function stuckForPeople(
  ids: string[],
  viewerId: string
): Promise<Map<string, { minutes: number; label: string | null }>> {
  const out = new Map<string, { minutes: number; label: string | null }>()
  if (ids.length === 0) return out
  try {
    const [rows, prefRows] = await Promise.all([
      db('user_presence')
        .whereIn('user_id', ids.slice(0, 500))
        .where('last_seen', '>=', new Date(Date.now() - 70_000))
        .where((q) => void q.where('is_online', true).orWhereNull('is_online')) as Promise<
        Array<Record<string, unknown>>
      >,
      db('nivaro_users').whereIn('id', ids.slice(0, 500)).select('id', 'preferences') as Promise<
        Array<{ id: string; preferences: unknown }>
      >
    ])
    const away = new Set<string>()
    for (const p of prefRows) {
      let prefs: Record<string, unknown> = {}
      try {
        prefs =
          typeof p.preferences === 'string'
            ? (JSON.parse(p.preferences) as Record<string, unknown>)
            : ((p.preferences as Record<string, unknown> | null) ?? {})
      } catch {
        prefs = {}
      }
      if (presenceOverrideAway(prefs)) away.add(String(p.id).toUpperCase())
    }
    const stuck = await stuckMinutes(
      rows.map((r) => ({
        id: String(r.user_id),
        idle: presenceRowIdle(r, away.has(String(r.user_id).toUpperCase())),
        lastActive: r.last_active ? new Date(r.last_active as string).getTime() : null
      }))
    )
    if (stuck.size === 0) return out
    const stuckRows = rows.filter((r) => stuck.has(String(r.user_id).toUpperCase()))
    let labels = new Map<string, string>()
    try {
      const viewerUser = await db('nivaro_users').where({ id: viewerId }).first()
      if (viewerUser) {
        const { resolveRecordLabels } = await import('../routes/presence.js')
        labels = await resolveRecordLabels(
          stuckRows.map((r) => (r.current_path as string | null) ?? null),
          viewerUser
        )
      }
    } catch {
      /* raw paths still say where */
    }
    for (const r of stuckRows) {
      const key = String(r.user_id).toUpperCase()
      out.set(key, {
        minutes: stuck.get(key) as number,
        label: stuckLabel(r.current_path as string | null, labels)
      })
    }
  } catch {
    /* decoration only */
  }
  return out
}
