// api/src/services/traffic-window.ts
/**
 * Traffic over any past window, from the request log (nivaro_api_logs) — the live map only holds
 * 15 minutes. Classified exactly like the live map (traffic-entities.ts), so an entity here is
 * the entity the map draws. Used by: compare two windows (#1160), the daily traffic digest
 * (#1128) and the Ask AI `traffic_snapshot` tool (#1168).
 *
 * Reads are capped (newest rows first); `truncated` says when the cap was hit, never silently.
 */
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { callerKeyFor, classifyRequest, entityKey, type TrafficLane } from './traffic-entities.js'
import type { HistoryRow } from './traffic-history.js'

export const WINDOW_ROW_CAP = 20_000
const TOP = 5

export interface WindowEntity {
  key: string
  lane: TrafficLane
  entity: string
  req: number
  read: number
  write: number
  error: number
  p95: number
  callers: Array<{ key: string; n: number }>
}
export interface WindowCaller {
  key: string
  req: number
  error: number
  /** Entity keys this caller touched most (top 3). */
  top: Array<{ key: string; n: number }>
}
export interface WindowSummary {
  from: string
  to: string
  rows: number
  truncated: boolean
  totals: { req: number; read: number; write: number; error: number; p95: number }
  entities: WindowEntity[]
  callers: WindowCaller[]
}

function p95(a: number[]): number {
  if (!a.length) return 0
  const s = a.slice().sort((x, y) => x - y)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))])
}

/** Fold request-log rows into per-entity and per-caller figures (pure). */
export function summarizeWindow(
  rows: HistoryRow[],
  from: Date,
  to: Date,
  truncated = false
): WindowSummary {
  const ents = new Map<
    string,
    {
      lane: TrafficLane
      entity: string
      req: number
      read: number
      write: number
      error: number
      lat: number[]
      callers: Map<string, number>
    }
  >()
  const callers = new Map<string, { req: number; error: number; ents: Map<string, number> }>()
  const allLat: number[] = []
  const totals = { req: 0, read: 0, write: 0, error: 0, p95: 0 }
  for (const r of rows) {
    const c = classifyRequest({
      method: r.method,
      path: r.path,
      graphqlOperation: r.graphql_operation,
      graphqlKind: r.graphql_kind
    })
    if (!c) continue
    const key = entityKey(c.lane, c.entity)
    const caller = callerKeyFor({ authMethod: r.auth, apiKeyId: r.api_key_id, userId: r.user })
    const isErr = Number(r.status) >= 400
    // A grouped row (readWindowGrouped) stands for `n` requests; a plain log row for one.
    const w = Math.max(1, Number((r as { n?: number }).n ?? 1) || 1)
    let e = ents.get(key)
    if (!e) {
      e = {
        lane: c.lane,
        entity: c.entity,
        req: 0,
        read: 0,
        write: 0,
        error: 0,
        lat: [],
        callers: new Map()
      }
      ents.set(key, e)
    }
    e.req += w
    totals.req += w
    if (isErr) {
      e.error += w
      totals.error += w
    } else if (c.kind === 'read') {
      e.read += w
      totals.read += w
    } else {
      e.write += w
      totals.write += w
    }
    const ms = r.latency_ms == null ? Number.NaN : Number(r.latency_ms)
    if (w === 1 && Number.isFinite(ms)) {
      e.lat.push(ms)
      allLat.push(ms)
    }
    e.callers.set(caller, (e.callers.get(caller) ?? 0) + w)
    let cl = callers.get(caller)
    if (!cl) {
      cl = { req: 0, error: 0, ents: new Map() }
      callers.set(caller, cl)
    }
    cl.req += w
    if (isErr) cl.error += w
    cl.ents.set(key, (cl.ents.get(key) ?? 0) + w)
  }
  totals.p95 = p95(allLat)
  const top = (m: Map<string, number>, n: number) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, v]) => ({ key, n: v }))
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    rows: rows.length,
    truncated,
    totals,
    entities: [...ents]
      .map(([key, e]) => ({
        key,
        lane: e.lane,
        entity: e.entity,
        req: e.req,
        read: e.read,
        write: e.write,
        error: e.error,
        p95: p95(e.lat),
        callers: top(e.callers, TOP)
      }))
      .sort((a, b) => b.req - a.req),
    callers: [...callers]
      .map(([key, c]) => ({ key, req: c.req, error: c.error, top: top(c.ents, 3) }))
      .sort((a, b) => b.req - a.req)
  }
}

/** The request log between two instants, newest first, capped. */
export async function readWindowRows(
  from: Date,
  to: Date,
  cap = WINDOW_ROW_CAP
): Promise<{ rows: HistoryRow[]; truncated: boolean }> {
  const rows = (await db('nivaro_api_logs')
    .where('created_at', '>=', from)
    .where('created_at', '<', to)
    .orderBy('created_at', 'desc')
    .limit(cap)
    .select(
      'method',
      'path',
      'status',
      'latency_ms',
      'auth',
      'api_key_id',
      'user',
      'graphql_operation',
      'graphql_kind',
      'created_at'
    )) as HistoryRow[]
  return { rows, truncated: rows.length >= cap }
}

/**
 * The request log between two instants, GROUPED by route, caller and error/ok (one row per group
 * with its count `n`) — a whole day in a few thousand rows. No latency (use readWindowRows).
 */
export async function readWindowGrouped(
  from: Date,
  to: Date,
  cap = 50_000
): Promise<{ rows: Array<HistoryRow & { n: number }>; truncated: boolean }> {
  const errExpr = 'CASE WHEN status >= 400 THEN 1 ELSE 0 END'
  const raw = (await db('nivaro_api_logs')
    .where('created_at', '>=', from)
    .where('created_at', '<', to)
    .groupBy(
      'method',
      'path',
      'graphql_operation',
      'graphql_kind',
      'auth',
      'api_key_id',
      'user',
      db.raw(errExpr)
    )
    .select(
      'method',
      'path',
      'graphql_operation',
      'graphql_kind',
      'auth',
      'api_key_id',
      'user',
      db.raw(`${errExpr} as err`),
      db.raw('COUNT(*) as n')
    )
    .limit(cap)) as Array<Record<string, unknown>>
  const rows = raw.map((r) => ({
    method: String(r.method ?? 'GET'),
    path: String(r.path ?? ''),
    status: Number(r.err) ? 500 : 200,
    latency_ms: null as unknown as number,
    auth: (r.auth as string | null) ?? null,
    api_key_id: r.api_key_id == null ? null : Number(r.api_key_id),
    user: (r.user as string | null) ?? null,
    graphql_operation: (r.graphql_operation as string | null) ?? null,
    graphql_kind: (r.graphql_kind as string | null) ?? null,
    created_at: to,
    n: Number(r.n) || 0
  }))
  return { rows, truncated: raw.length >= cap }
}

export async function readWindow(
  from: Date,
  to: Date,
  cap = WINDOW_ROW_CAP
): Promise<WindowSummary> {
  const { rows, truncated } = await readWindowRows(from, to, cap)
  return summarizeWindow(rows, from, to, truncated)
}

export interface WindowDiffRow {
  key: string
  lane: TrafficLane
  entity: string
  a: { req: number; error: number; p95: number }
  b: { req: number; error: number; p95: number }
  /** Requests per minute in each window (windows may differ in length). */
  a_rpm: number
  b_rpm: number
  /** b_rpm − a_rpm */
  delta_rpm: number
  /** Percent change of the rate; null when A had none. */
  delta_pct: number | null
  only: 'a' | 'b' | null
}

/** Entity by entity, A against B, rates normalised per minute (pure). */
export function compareWindows(a: WindowSummary, b: WindowSummary): WindowDiffRow[] {
  const minutes = (s: WindowSummary) =>
    Math.max(1 / 60, (new Date(s.to).getTime() - new Date(s.from).getTime()) / 60_000)
  const ma = minutes(a)
  const mb = minutes(b)
  const keys = new Set([...a.entities.map((e) => e.key), ...b.entities.map((e) => e.key)])
  const byA = new Map(a.entities.map((e) => [e.key, e]))
  const byB = new Map(b.entities.map((e) => [e.key, e]))
  const out: WindowDiffRow[] = []
  for (const key of keys) {
    const ea = byA.get(key)
    const eb = byB.get(key)
    const base = (ea ?? eb) as WindowEntity
    const aRpm = (ea?.req ?? 0) / ma
    const bRpm = (eb?.req ?? 0) / mb
    out.push({
      key,
      lane: base.lane,
      entity: base.entity,
      a: { req: ea?.req ?? 0, error: ea?.error ?? 0, p95: ea?.p95 ?? 0 },
      b: { req: eb?.req ?? 0, error: eb?.error ?? 0, p95: eb?.p95 ?? 0 },
      a_rpm: round2(aRpm),
      b_rpm: round2(bRpm),
      delta_rpm: round2(bRpm - aRpm),
      delta_pct: aRpm > 0 ? Math.round(((bRpm - aRpm) / aRpm) * 100) : null,
      only: ea && !eb ? 'a' : eb && !ea ? 'b' : null
    })
  }
  return out.sort((x, y) => Math.abs(y.delta_rpm) - Math.abs(x.delta_rpm))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Human labels for caller keys (`k<id>` API keys, `u<uuid>` people, cron, anon). */
export async function labelCallers(keys: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = { cron: 'Crons & flows', anon: 'Unauthenticated' }
  const keyIds = keys
    .filter((k) => /^k\d+$/.test(k))
    .map((k) => Number(k.slice(1)))
    .filter(Number.isFinite)
  const userIds = keys.filter((k) => k.startsWith('u')).map((k) => k.slice(1))
  const [apiKeys, users] = await Promise.all([
    keyIds.length
      ? selectInChunks(keyIds, 1000, (chunk) =>
          Promise.resolve(db('nivaro_api_keys').whereIn('id', chunk).select('id', 'name'))
        ).catch(() => [])
      : Promise.resolve([]),
    userIds.length
      ? selectInChunks(userIds, 1000, (chunk) =>
          Promise.resolve(
            db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
          )
        ).catch(() => [])
      : Promise.resolve([])
  ])
  for (const k of apiKeys as Array<{ id: number; name: string }>) out[`k${k.id}`] = k.name
  for (const u of users as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string
  }>) {
    out[`u${String(u.id).toUpperCase()}`] =
      `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email.split('@')[0]
  }
  for (const k of keys) {
    if (!out[k]) out[k] = k.startsWith('k') ? `API key ${k.slice(1)}` : 'Unknown user'
  }
  return out
}

const MAX_WINDOW_MS = 24 * 3600_000
const MAX_AGE_MS = 15 * 24 * 3600_000 // the request log keeps 14 days

/** Why a compare window is not usable, or null (24 h at most, inside the log's 14 days). */
export function validWindow(from: Date | null, to: Date | null, now = Date.now()): string | null {
  if (!from || !to) return 'from and to must be ISO timestamps'
  if (to.getTime() <= from.getTime()) return 'from must be before to'
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) return 'a window can be 24 hours at most'
  if (now - from.getTime() > MAX_AGE_MS) return 'the request log keeps 14 days'
  return null
}
