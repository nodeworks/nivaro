import { db } from '../db/index.js'
import type { ReplaySearchHit } from './session-replay-index.js'

/**
 * Replay search by outcome (#1315) — "recordings where something went wrong":
 * a 4xx or 5xx API response, or a client error report. Each is resolved by
 * joining the failing event (nivaro_api_logs / nivaro_issues) to the person's
 * recording that was running at that moment, so a hit opens seeked to the
 * first failure. Admin-only like every read of a recording; the hit carries
 * the method, path and status, never a request body.
 */

export type Outcome = '4xx' | '5xx' | 'client_error'
export const OUTCOMES: Outcome[] = ['4xx', '5xx', 'client_error']

export interface OutcomeQuery {
  outcome: Outcome
  /** Route pattern the recording must have visited ('/collections/orders/:id'). */
  route?: string
  user?: string
  /** Look-back window in days (1–30, default 7). */
  days?: number
  limit?: number
}

export interface OutcomeRow {
  recording: string
  user: string | null
  user_name: string | null
  app: string | null
  origin: string | null
  started_at: string | Date
  ended_at: string | Date | null
  last_event_at: string | Date | null
  event_count: number | null
  byte_size: number | null
  truncated: boolean | number | null
  at: string | Date
  label: string
}

/** A recording is still running this long after its last uploaded chunk. */
const SLACK_SECONDS = 60
const MAX_MATCHES = 5

export function clampDays(v: unknown): number {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(30, n) : 7
}

/** Group failing events by recording; the hit spans the first to last failure. */
export function groupOutcomeRows(rows: OutcomeRow[], limit = 100): ReplaySearchHit[] {
  const hits = new Map<string, ReplaySearchHit>()
  for (const r of rows) {
    const at = new Date(r.at).getTime()
    if (!Number.isFinite(at)) continue
    let hit = hits.get(r.recording)
    if (!hit) {
      if (hits.size >= limit) continue
      hit = {
        id: r.recording,
        user: r.user ?? null,
        user_name: r.user_name || null,
        app: r.app ?? null,
        origin: r.origin ?? null,
        started_at: r.started_at,
        ended_at: r.ended_at ?? null,
        last_event_at: r.last_event_at ?? null,
        event_count: Number(r.event_count ?? 0),
        byte_size: Number(r.byte_size ?? 0),
        truncated: !!r.truncated,
        first_ms: at,
        last_ms: at,
        matches: []
      }
      hits.set(r.recording, hit)
    }
    hit.first_ms = Math.min(hit.first_ms, at)
    hit.last_ms = Math.max(hit.last_ms, at)
    if (hit.matches.length < MAX_MATCHES) {
      hit.matches.push({ kind: 'outcome', key: r.label, first_ms: at, last_ms: at })
    }
  }
  return [...hits.values()].sort((a, z) => z.first_ms - a.first_ms)
}

const RECORDING_COLS = [
  'r.id as recording',
  'r.user',
  'r.app',
  'r.origin',
  'r.started_at',
  'r.ended_at',
  'r.last_event_at',
  'r.event_count',
  'r.byte_size',
  'r.truncated'
]

export async function searchReplayByOutcome(q: OutcomeQuery): Promise<ReplaySearchHit[]> {
  const days = clampDays(q.days)
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 100), 1), 200)
  const since = new Date(Date.now() - days * 86_400_000)
  const userName = db.raw(
    "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
  )
  const routeFilter = (qb: ReturnType<typeof db>) => {
    if (q.route?.trim()) {
      const route = q.route.trim().slice(0, 255)
      qb.whereExists(function () {
        this.select(db.raw('1'))
          .from('nivaro_replay_index as ri')
          .where('ri.recording', db.ref('r.id'))
          .where('ri.kind', 'route')
          .where('ri.key', route)
      })
    }
    if (q.user) qb.where('r.user', q.user)
  }

  let rows: OutcomeRow[]
  if (q.outcome === 'client_error') {
    const raw = (await db('nivaro_issues as i')
      .join('nivaro_session_recordings as r', 'r.user', 'i.raised_by')
      .leftJoin('nivaro_users as u', 'u.id', 'r.user')
      .where('i.source', 'client')
      .whereNotNull('i.raised_by')
      .whereRaw('COALESCE(i.last_seen_at, i.created_at) >= ?', [since])
      .whereRaw('COALESCE(i.last_seen_at, i.created_at) >= r.started_at')
      .whereRaw(
        `COALESCE(i.last_seen_at, i.created_at) <= DATEADD(second, ${SLACK_SECONDS}, COALESCE(r.last_event_at, r.ended_at, GETUTCDATE()))`
      )
      .modify(routeFilter)
      .orderByRaw('COALESCE(i.last_seen_at, i.created_at) DESC')
      .limit(limit * 6)
      .select(
        ...RECORDING_COLS,
        userName,
        db.raw('COALESCE(i.last_seen_at, i.created_at) as at'),
        'i.title as title'
      )) as Array<OutcomeRow & { title: string | null }>
    rows = raw.map((r) => ({ ...r, label: `Client error: ${String(r.title ?? '').slice(0, 120)}` }))
  } else {
    const [lo, hi] = q.outcome === '5xx' ? [500, 599] : [400, 499]
    const raw = (await db('nivaro_api_logs as l')
      .join('nivaro_session_recordings as r', function () {
        this.on(db.raw('CAST(r.[user] AS NVARCHAR(100)) = l.[user]'))
      })
      .leftJoin('nivaro_users as u', 'u.id', 'r.user')
      .whereBetween('l.status', [lo, hi])
      .where('l.created_at', '>=', since)
      .whereRaw('l.created_at >= r.started_at')
      .whereRaw(
        `l.created_at <= DATEADD(second, ${SLACK_SECONDS}, COALESCE(r.last_event_at, r.ended_at, GETUTCDATE()))`
      )
      .modify(routeFilter)
      .orderBy('l.created_at', 'desc')
      .limit(limit * 6)
      .select(
        ...RECORDING_COLS,
        userName,
        'l.created_at as at',
        'l.method as method',
        'l.path as path',
        'l.status as status'
      )) as Array<OutcomeRow & { method: string; path: string; status: number }>
    rows = raw.map((r) => ({
      ...r,
      label: `${r.method} ${String(r.path).split('?')[0].slice(0, 120)} → ${r.status}`
    }))
  }
  return groupOutcomeRows(rows, limit)
}
