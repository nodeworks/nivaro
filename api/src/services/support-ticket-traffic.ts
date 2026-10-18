// api/src/services/support-ticket-traffic.ts
/**
 * #2276 — traffic on a support ticket: what the requester's browser did around the time they
 * raised it. Requests and errors come from `nivaro_api_logs` (their user id), pages from
 * `nivaro_rum_events` when the table has rows. Only paths (ids folded to `:id`), statuses,
 * counts and times leave this module — no query strings, bodies, addresses or user agents —
 * and the route that serves it is for people who work the desk, never the requester.
 */
import { db } from '../db/index.js'
import { pathTemplate } from './traffic-entities.js'

/** Minutes either side of the moment the ticket was raised. */
export const AROUND_MIN = 30
const ROW_CAP = 3000
const AREA_CAP = 8
const ERROR_CAP = 15
const PAGE_CAP = 8

export interface LogRow {
  method: string
  path: string
  status: number
  latency_ms: number | null
  created_at: Date | string
}
export interface RumRow {
  route: string
  kind: string
  duration_ms: number | null
  created_at: Date | string
}
export interface TicketTraffic {
  /** Epoch ms the ticket was raised. */
  moment: number
  from: number
  to: number
  requests: number
  errors: number
  /** Requests / errors per minute across the whole window, oldest first (2 x AROUND_MIN + 1). */
  timeline: Array<{ n: number; e: number }>
  areas: Array<{ path: string; n: number; errors: number }>
  error_list: Array<{ at: number; method: string; path: string; status: number }>
  pages: Array<{ route: string; n: number; avg_ms: number | null; worst_ms: number | null }>
  /** True when the log read hit its row cap. */
  truncated: boolean
  /** The page-load table had nothing to say (missing or empty). */
  rum: boolean
}

/**
 * `/api/items/orders/3F2504E0-...` becomes `/api/items/orders/:id`; the query string goes. The
 * desk is not all administrators, so ids, token-like segments (share and public-link tokens are
 * working credentials) and emails are all folded, by the map's own route template rule.
 */
export function foldPath(raw: string): string {
  return pathTemplate(String(raw ?? '').split('?')[0]).slice(0, 160)
}

/** Pure: summarise the rows of one window. */
export function summariseTicketTraffic(
  logs: LogRow[],
  rum: RumRow[],
  moment: number,
  truncated = false
): TicketTraffic {
  const span = AROUND_MIN * 60_000
  const from = moment - span
  const to = moment + span
  const timeline = Array.from({ length: 2 * AROUND_MIN + 1 }, () => ({ n: 0, e: 0 }))
  const areas = new Map<string, { n: number; errors: number }>()
  const errs: TicketTraffic['error_list'] = []
  let errors = 0
  for (const r of logs) {
    const at = new Date(r.created_at).getTime()
    if (!Number.isFinite(at) || at < from || at > to) continue
    const bad = Number(r.status) >= 400
    const slot = timeline[Math.min(timeline.length - 1, Math.floor((at - from) / 60_000))]
    slot.n++
    const path = foldPath(r.path)
    const a = areas.get(path) ?? { n: 0, errors: 0 }
    a.n++
    if (bad) {
      a.errors++
      slot.e++
      errors++
      errs.push({ at, method: r.method, path, status: Number(r.status) })
    }
    areas.set(path, a)
  }
  errs.sort((x, y) => Math.abs(x.at - moment) - Math.abs(y.at - moment))
  const pages = new Map<string, { n: number; sum: number; k: number; worst: number }>()
  for (const r of rum) {
    const at = new Date(r.created_at).getTime()
    if (!Number.isFinite(at) || at < from || at > to) continue
    const route = foldPath(r.route)
    const p = pages.get(route) ?? { n: 0, sum: 0, k: 0, worst: 0 }
    p.n++
    if (r.duration_ms != null && Number.isFinite(Number(r.duration_ms))) {
      p.sum += Number(r.duration_ms)
      p.k++
      p.worst = Math.max(p.worst, Number(r.duration_ms))
    }
    pages.set(route, p)
  }
  return {
    moment,
    from,
    to,
    requests: timeline.reduce((s, t) => s + t.n, 0),
    errors,
    timeline,
    areas: [...areas]
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => b.errors - a.errors || b.n - a.n)
      .slice(0, AREA_CAP),
    error_list: errs.slice(0, ERROR_CAP),
    pages: [...pages]
      .map(([route, v]) => ({
        route,
        n: v.n,
        avg_ms: v.k ? Math.round(v.sum / v.k) : null,
        worst_ms: v.k ? v.worst : null
      }))
      .sort((a, b) => b.n - a.n)
      .slice(0, PAGE_CAP),
    truncated,
    rum: pages.size > 0
  }
}

/** Read the requester's window from the logs. */
export async function ticketTraffic(
  userId: string,
  raisedAt: Date | string,
  now = Date.now()
): Promise<TicketTraffic> {
  const moment = new Date(raisedAt).getTime()
  const span = AROUND_MIN * 60_000
  const from = new Date(moment - span)
  const to = new Date(Math.min(moment + span, now))
  const logs = (await db('nivaro_api_logs')
    .where('user', userId)
    .whereBetween('created_at', [from, to])
    .orderBy('created_at', 'desc')
    .limit(ROW_CAP)
    .select('method', 'path', 'status', 'latency_ms', 'created_at')) as LogRow[]
  let rum: RumRow[] = []
  try {
    if (await db.schema.hasTable('nivaro_rum_events')) {
      rum = (await db('nivaro_rum_events')
        .where('user', userId)
        .whereBetween('created_at', [from, to])
        .orderBy('created_at', 'desc')
        .limit(1000)
        .select('route', 'kind', 'duration_ms', 'created_at')) as RumRow[]
    }
  } catch {
    rum = []
  }
  return summariseTicketTraffic(logs, rum, moment, logs.length >= ROW_CAP)
}
