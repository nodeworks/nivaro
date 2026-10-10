import { db } from '../db/index.js'

/**
 * Event rail for the session replay scrubber (#1356).
 *
 * A recording knows its person and its time span; the rest of the system knows
 * what that person's tab did in that span. This joins the two: the API log
 * (requests with their status), client error reports (nivaro_issues), admin
 * route changes (nivaro_admin_journeys) and workflow transitions they made.
 * The player draws each as a marker under the timeline.
 *
 * Every source is read on its own and in its own try/catch — an install
 * behind a migration (no journeys table, no recording_id on issues) loses
 * that one kind, never the rail. Each kind is capped, oldest first, so a
 * day-long recording can't answer megabytes; `truncated_kinds` says which
 * kinds were cut.
 *
 * Nothing request-shaped beyond method, path, status and latency leaves here:
 * no bodies, no query strings (the logger stores those apart; any `?` that
 * reached `path` is cut again), no error text.
 */

export type RailKind = 'request' | 'error' | 'route' | 'transition'

export interface RailItem {
  kind: RailKind
  /** ISO timestamp — the player turns it into an offset from the first event. */
  at: string
  label: string
  /** HTTP status (requests only). */
  status?: number
  /** Admin route that opens the thing (an issue, a record). */
  href?: string
  id?: string | number
}

export interface RailRecording {
  id: string
  user: string | null
  app?: string | null
  started_at: Date | string | null
  ended_at: Date | string | null
  last_event_at: Date | string | null
}

export const RAIL_CAPS: Record<RailKind, number> = {
  request: 500,
  error: 100,
  route: 300,
  transition: 200
}

/** Clock slack either side of the recording — server and browser clocks differ a little. */
export const RAIL_SLACK_MS = 5_000
/**
 * An error clip is minted AFTER the error, from a buffer of the 30–60 s
 * before it, so its started_at is later than its first event. Reach back
 * over the buffer.
 */
export const CLIP_LEAD_MS = 65_000

/** The recorder's own uploads and the RUM beacon are noise on a person's rail. */
const NOISE_PATHS = ['/api/session-recordings/%', '/api/rum%']

function toMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null
  const n = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(n) ? n : null
}

export function railWindow(rec: RailRecording, now = Date.now()): { from: Date; to: Date } {
  const start = toMs(rec.started_at) ?? now
  const end = toMs(rec.ended_at) ?? toMs(rec.last_event_at) ?? now
  const lead = rec.app === 'error-clip' ? CLIP_LEAD_MS : RAIL_SLACK_MS
  return { from: new Date(start - lead), to: new Date(Math.max(end, start) + RAIL_SLACK_MS) }
}

/** `/api/items/x?access_token=…` → `/api/items/x`. */
function bare(path: unknown): string {
  return String(path ?? '').split(/[?#]/)[0]
}

function iso(v: unknown): string | null {
  const ms = toMs(v as Date | string | null)
  return ms == null ? null : new Date(ms).toISOString()
}

type Capped = { items: RailItem[]; truncated: boolean }

async function requests(user: string, from: Date, to: Date): Promise<Capped> {
  const cap = RAIL_CAPS.request
  const rows = (await db('nivaro_api_logs')
    .where('user', user)
    .whereBetween('created_at', [from, to])
    .modify((qb) => {
      for (const p of NOISE_PATHS) qb.whereNot('path', 'like', p)
    })
    .orderBy('created_at', 'asc')
    .limit(cap + 1)
    .select('method', 'path', 'status', 'latency_ms', 'created_at')) as Array<{
    method: string
    path: string
    status: number
    latency_ms: number
    created_at: Date | string
  }>
  const items: RailItem[] = []
  for (const r of rows.slice(0, cap)) {
    const at = iso(r.created_at)
    if (!at) continue
    const status = Number(r.status) || 0
    const ms = Number(r.latency_ms)
    items.push({
      kind: 'request',
      at,
      status,
      label: `${String(r.method).toUpperCase()} ${bare(r.path)} → ${status}${Number.isFinite(ms) ? ` · ${Math.round(ms)} ms` : ''}`
    })
  }
  return { items, truncated: rows.length > cap }
}

/**
 * Client error reports by this person in the window, plus any issue that
 * links THIS recording (its offset is the exact moment). Issues are deduped
 * by fingerprint, so a recurring one is placed by last_seen_at when its
 * first sighting is outside the window.
 */
async function errors(rec: RailRecording, user: string, from: Date, to: Date): Promise<Capped> {
  const cap = RAIL_CAPS.error
  const rows = (await db('nivaro_issues')
    .where('source', 'client')
    .where((qb) => {
      qb.where('recording_id', rec.id).orWhere((own) => {
        own.where('raised_by', user).where((w) => {
          w.whereBetween('created_at', [from, to]).orWhereBetween('last_seen_at', [from, to])
        })
      })
    })
    .orderBy('created_at', 'asc')
    .limit(cap + 1)
    .select(
      'id',
      'title',
      'created_at',
      'last_seen_at',
      'recording_id',
      'recording_offset_ms'
    )) as Array<{
    id: number
    title: string
    created_at: Date | string | null
    last_seen_at: Date | string | null
    recording_id: string | null
    recording_offset_ms: number | null
  }>
  const lo = from.getTime()
  const hi = to.getTime()
  const inside = (ms: number | null) => ms != null && ms >= lo && ms <= hi
  const start = toMs(rec.started_at)
  const items: RailItem[] = []
  for (const r of rows.slice(0, cap)) {
    const linked =
      String(r.recording_id ?? '').toLowerCase() === rec.id.toLowerCase() &&
      r.recording_offset_ms != null &&
      start != null
        ? start + Number(r.recording_offset_ms)
        : null
    const created = toMs(r.created_at)
    const seen = toMs(r.last_seen_at)
    const ms = linked ?? (inside(created) ? created : inside(seen) ? seen : (created ?? seen))
    if (ms == null) continue
    items.push({
      kind: 'error',
      at: new Date(ms).toISOString(),
      // Titles read "[client] /route: message" — the bracket says nothing here.
      label: String(r.title ?? 'Client error')
        .replace(/^\[client\]\s*/, '')
        .slice(0, 160),
      id: r.id,
      href: `/issues/${r.id}`
    })
  }
  return { items, truncated: rows.length > cap }
}

async function routes(user: string, from: Date, to: Date): Promise<Capped> {
  const cap = RAIL_CAPS.route
  const rows = (await db('nivaro_admin_journeys')
    .where('user', user)
    .whereBetween('entered_at', [from, to])
    .orderBy('entered_at', 'asc')
    .limit(cap + 1)
    .select('path', 'entered_at', 'duration_seconds')) as Array<{
    path: string
    entered_at: Date | string
    duration_seconds: number | null
  }>
  const items: RailItem[] = []
  for (const r of rows.slice(0, cap)) {
    const at = iso(r.entered_at)
    if (!at) continue
    const secs = r.duration_seconds == null ? null : Number(r.duration_seconds)
    items.push({
      kind: 'route',
      at,
      label: `${bare(r.path)}${secs != null && Number.isFinite(secs) ? ` · ${secs} s on page` : ''}`
    })
  }
  return { items, truncated: rows.length > cap }
}

async function transitions(user: string, from: Date, to: Date): Promise<Capped> {
  const cap = RAIL_CAPS.transition
  const rows = (await db('nivaro_workflow_history as h')
    .leftJoin('nivaro_workflow_instances as i', 'h.instance', 'i.id')
    .leftJoin('nivaro_workflow_states as fs', 'h.from_state', 'fs.id')
    .leftJoin('nivaro_workflow_states as ts', 'h.to_state', 'ts.id')
    .where('h.user', user)
    .whereBetween('h.timestamp', [from, to])
    .orderBy('h.timestamp', 'asc')
    .limit(cap + 1)
    .select(
      'h.id',
      'h.timestamp',
      'i.collection',
      'i.item',
      'fs.label as from_label',
      'ts.label as to_label'
    )) as Array<{
    id: number
    timestamp: Date | string
    collection: string | null
    item: string | null
    from_label: string | null
    to_label: string | null
  }>
  const items: RailItem[] = []
  for (const r of rows.slice(0, cap)) {
    const at = iso(r.timestamp)
    if (!at) continue
    const where = r.collection ? `${r.collection}${r.item ? ` ${r.item}` : ''}: ` : ''
    const move = r.from_label ? `${r.from_label} → ${r.to_label ?? '?'}` : `→ ${r.to_label ?? '?'}`
    items.push({
      kind: 'transition',
      at,
      label: `${where}${move}`.slice(0, 160),
      id: r.id,
      ...(r.collection && r.item
        ? {
            href: `/collections/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.item)}`
          }
        : {})
    })
  }
  return { items, truncated: rows.length > cap }
}

export async function buildEventRail(
  rec: RailRecording,
  now = Date.now()
): Promise<{
  started_at: string | null
  from: string
  to: string
  items: RailItem[]
  truncated: boolean
  truncated_kinds: RailKind[]
}> {
  const { from, to } = railWindow(rec, now)
  const user = rec.user ? String(rec.user) : null
  const empty: Capped = { items: [], truncated: false }
  // A missing table / column on an older install drops that kind only.
  const safe = (p: () => Promise<Capped>) => p().catch(() => empty)
  const parts: Array<[RailKind, Capped]> = user
    ? await Promise.all([
        safe(() => requests(user, from, to)).then((c) => ['request', c] as [RailKind, Capped]),
        safe(() => errors(rec, user, from, to)).then((c) => ['error', c] as [RailKind, Capped]),
        safe(() => routes(user, from, to)).then((c) => ['route', c] as [RailKind, Capped]),
        safe(() => transitions(user, from, to)).then((c) => ['transition', c] as [RailKind, Capped])
      ])
    : []
  const items = parts.flatMap(([, c]) => c.items).sort((a, b) => a.at.localeCompare(b.at))
  const truncatedKinds = parts.filter(([, c]) => c.truncated).map(([k]) => k)
  return {
    started_at: iso(rec.started_at),
    from: from.toISOString(),
    to: to.toISOString(),
    items,
    truncated: truncatedKinds.length > 0,
    truncated_kinds: truncatedKinds
  }
}
