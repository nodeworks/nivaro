// api/src/routes/traffic-map-extras/people-lenses.ts
/**
 * Traffic Map round 4 — callers and people (#1172 #1178 #1179 #1181 #1182 #1183). Importing the
 * tap modules here registers them at boot. Routes land under /api/traffic-map, admin only, 404 in
 * cloud mode (the parent plugin's hooks).
 *
 * GET  /credentials                 API keys expiring within 7 days or near their per-minute
 *                                   limit, partner token exchanges that keep failing (#1172)
 * GET  /follow?caller=u<ID>&since=  one person's newest requests and the screens they came from
 * POST /follow/trace {caller}       keep full traces of their next 50 requests (#1178)
 * GET  /egress?window=&hours=       rows pulled out per caller: list reads + exports (#1179)
 * GET  /roles                       role id → name (#1182)
 * GET  /payloads?caller=&entity=    the caller's last request bodies + error text, secrets
 *                                   masked (#1183)
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { logActivity } from '../../services/activity.js'
import { maskBodySecrets } from '../../services/secret-mask.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import '../../services/traffic-taps/client-crashes.js'
import { egressReaders } from '../../services/traffic-taps/egress.js'
import { personTrail, visitsOf } from '../../services/traffic-taps/person-trail.js'
import '../../services/traffic-taps/roles.js'

const DAY_MS = 86_400_000
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i
const WINDOWS = new Set([60, 300, 900])
/** A key is "near its limit" at this share of the per-minute limit. */
export const NEAR_LIMIT_PCT = 85
/** A key expiring within this many days is flagged. */
export const EXPIRY_DAYS = 7
/** Failed token exchanges in a row (no success between) that count as "keeps failing". */
export const TOKEN_STREAK = 2

// ── #1172 credentials ────────────────────────────────────────────────────────
export interface KeyRow {
  id: number
  name: string | null
  expires_at: Date | string | null
  rate_limit_per_minute: number | null
  is_active: boolean | number | null
}
export interface KeyVerdict {
  name: string | null
  /** Days until expiry (negative = already expired); null when it does not expire soon. */
  expires_in_days: number | null
  expires_at: string | null
  limit: number | null
  /** Requests counted in the current (or the last full) minute. */
  used: number | null
  pct: number | null
}

/**
 * The keys worth a badge: active keys expiring within EXPIRY_DAYS (or expired in the last day),
 * and keys at NEAR_LIMIT_PCT or more of their per-minute limit. `usage` = key id → the highest
 * of this minute's and the last minute's counts.
 */
export function keyVerdicts(
  keys: KeyRow[],
  usage: Map<number, number>,
  now = Date.now()
): Record<string, KeyVerdict> {
  const out: Record<string, KeyVerdict> = {}
  for (const k of keys) {
    if (!(k.is_active === true || k.is_active === 1)) continue
    const exp = k.expires_at ? new Date(k.expires_at).getTime() : Number.NaN
    const daysLeft = Number.isFinite(exp) ? (exp - now) / DAY_MS : null
    const expiring = daysLeft != null && daysLeft <= EXPIRY_DAYS && daysLeft > -1
    const limit = Number(k.rate_limit_per_minute) > 0 ? Number(k.rate_limit_per_minute) : null
    const used = limit ? (usage.get(Number(k.id)) ?? 0) : null
    const pct = limit && used != null ? Math.round((100 * used) / limit) : null
    const hot = pct != null && pct >= NEAR_LIMIT_PCT
    if (!expiring && !hot) continue
    out[`k${k.id}`] = {
      name: k.name ?? null,
      expires_in_days: expiring ? Math.round((daysLeft as number) * 10) / 10 : null,
      expires_at: expiring ? new Date(exp).toISOString() : null,
      limit,
      used,
      pct
    }
  }
  return out
}

export interface TokenRow {
  api_id: number | null
  ok: boolean | number | null
  status: number | null
  error: string | null
  created_at: Date | string
}
export interface TokenVerdict {
  /** Failed exchanges since the last success (newest first). */
  streak: number
  last_error: string | null
  last_status: number | null
  last_at: string
  last_ok_at: string | null
}

/** Partners whose newest TOKEN_STREAK+ token exchanges all failed. `rows` newest first. */
export function tokenStreaks(rows: TokenRow[]): Record<string, TokenVerdict> {
  const by = new Map<number, TokenRow[]>()
  for (const r of rows) {
    if (r.api_id == null) continue
    const list = by.get(Number(r.api_id)) ?? []
    list.push(r)
    by.set(Number(r.api_id), list)
  }
  const out: Record<string, TokenVerdict> = {}
  for (const [api, list] of by) {
    let streak = 0
    let lastOk: string | null = null
    for (const r of list) {
      if (r.ok === true || r.ok === 1) {
        lastOk = new Date(r.created_at).toISOString()
        break
      }
      streak++
    }
    if (streak < TOKEN_STREAK) continue
    out[`ext:${api}`] = {
      streak,
      last_error: list[0].error ? String(list[0].error).slice(0, 300) : null,
      last_status: list[0].status == null ? null : Number(list[0].status),
      last_at: new Date(list[0].created_at).toISOString(),
      last_ok_at: lastOk
    }
  }
  return out
}

// ── #1179 exports from the activity log ──────────────────────────────────────
export const EXPORT_ACTIONS = [
  'export',
  'export-preset-run',
  'pdf-render',
  'dossier-export',
  'backup-export',
  'blueprint-export',
  'promotion-export',
  'record-promotion-export',
  'import-run-export',
  'session-recording-export',
  'schema-snapshot-export',
  'config-snapshot-export'
]
export const EXPORT_LABEL: Record<string, string> = {
  export: 'Export',
  'export-preset-run': 'Export preset',
  'pdf-render': 'PDF',
  'dossier-export': 'Dossier',
  'backup-export': 'Backup',
  'blueprint-export': 'Blueprint',
  'promotion-export': 'Content bundle',
  'record-promotion-export': 'Record bundle',
  'import-run-export': 'Import run',
  'session-recording-export': 'Session recording',
  'schema-snapshot-export': 'Schema snapshot',
  'config-snapshot-export': 'Config snapshot'
}

/** Rows an export activity row says it carried ("csv · 1200 rows", "\"Name\": 40 rows (xlsx)"). */
export function rowsFromComment(comment: string | null | undefined): number | null {
  const m = /(\d[\d,]*)\s+rows?\b/i.exec(String(comment ?? ''))
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export interface ExportRow {
  user: string | null
  action: string
  collection: string | null
  comment: string | null
  timestamp: Date | string
}
export interface ExportCaller {
  caller: string
  exports: number
  rows: number
  by: Array<{ action: string; label: string; n: number; rows: number }>
  last_at: string
  recent: Array<{
    action: string
    label: string
    collection: string | null
    rows: number | null
    at: string
  }>
}

/** Export activity grouped per person (`u<ID>`), busiest (rows, then count) first. */
export function groupExports(rows: ExportRow[]): ExportCaller[] {
  const by = new Map<string, ExportCaller>()
  for (const r of rows) {
    const caller = r.user ? `u${String(r.user).toUpperCase()}` : 'anon'
    const at = new Date(r.timestamp).toISOString()
    const n = rowsFromComment(r.comment)
    const c =
      by.get(caller) ??
      ({ caller, exports: 0, rows: 0, by: [], last_at: at, recent: [] } as ExportCaller)
    c.exports++
    c.rows += n ?? 0
    if (at > c.last_at) c.last_at = at
    let a = c.by.find((x) => x.action === r.action)
    if (!a) {
      a = { action: r.action, label: EXPORT_LABEL[r.action] ?? r.action, n: 0, rows: 0 }
      c.by.push(a)
    }
    a.n++
    a.rows += n ?? 0
    if (c.recent.length < 6)
      c.recent.push({
        action: r.action,
        label: EXPORT_LABEL[r.action] ?? r.action,
        collection: r.collection ?? null,
        rows: n,
        at
      })
    by.set(caller, c)
  }
  return [...by.values()].sort((a, b) => b.rows - a.rows || b.exports - a.exports)
}

// ── #1183 payload peek ───────────────────────────────────────────────────────
/** A caller key the payload / follow routes accept: `k<id>` or `u<UUID>`; null otherwise. */
export function parseCallerKey(raw: unknown): { keyId: number } | { userId: string } | null {
  const s = String(raw ?? '')
  if (/^k\d{1,12}$/.test(s)) return { keyId: Number(s.slice(1)) }
  if (s.startsWith('u') && UUID_RE.test(s.slice(1))) return { userId: s.slice(1).toUpperCase() }
  return null
}

/** `LIKE` pattern matching `/<entity>` in a path, with wildcards escaped. */
export function entityPathPattern(entity: string): string {
  return `%/${entity.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`
}

export async function peopleLensesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/credentials', async (req) => {
    const now = Date.now()
    let keys: KeyRow[] = []
    try {
      keys = (await db('nivaro_api_keys').select(
        'id',
        'name',
        'expires_at',
        'rate_limit_per_minute',
        'is_active'
      )) as KeyRow[]
    } catch (err) {
      req.log.warn({ err }, 'traffic-map credentials: key read failed')
    }
    // Per-minute usage: the same Redis counters the key rate limiter increments, so the figure
    // is the one the limiter judges (every node shares it).
    const usage = new Map<number, number>()
    const limited = keys.filter((k) => Number(k.rate_limit_per_minute) > 0)
    if (limited.length) {
      const nowSec = Math.floor(now / 1000)
      const cur = Math.floor(nowSec / 60) * 60
      const names = limited.flatMap((k) => [
        `nvr:keyrl:${k.id}:${cur}`,
        `nvr:keyrl:${k.id}:${cur - 60}`
      ])
      try {
        const vals = (await app.redis.mget(...names)) as Array<string | null>
        limited.forEach((k, i) => {
          const a = Number(vals[i * 2] ?? 0) || 0
          const b = Number(vals[i * 2 + 1] ?? 0) || 0
          usage.set(Number(k.id), Math.max(a, b))
        })
      } catch {
        /* Redis down: the limiter fails open too, so there is nothing to judge */
      }
    }
    let tokens: TokenRow[] = []
    try {
      tokens = (await db('nivaro_outbound_side_log')
        .where('kind', 'like', 'token%')
        .where('created_at', '>=', new Date(now - DAY_MS))
        .orderBy('id', 'desc')
        .limit(2000)
        .select('api_id', 'ok', 'status', 'error', 'created_at')) as TokenRow[]
    } catch {
      /* the side log may not exist yet */
    }
    return {
      data: {
        at: new Date(now).toISOString(),
        callers: keyVerdicts(keys, usage, now),
        partners: tokenStreaks(tokens),
        near_limit_pct: NEAR_LIMIT_PCT,
        expiry_days: EXPIRY_DAYS
      }
    }
  })

  app.get<{ Querystring: { caller?: string; since?: string } }>('/follow', async (req, reply) => {
    const who = parseCallerKey(req.query.caller)
    if (!who || !('userId' in who))
      return reply
        .code(400)
        .send({ error: 'caller must be a person (u<id>)', code: 'CALLER_INVALID' })
    const caller = `u${who.userId}`
    const since = Number(req.query.since ?? 0)
    const trail = personTrail(caller, Number.isFinite(since) ? since : 0)
    const all = personTrail(caller)
    return {
      data: {
        caller,
        steps: trail.steps,
        visits: visitsOf(all.steps).slice(0, 12),
        current: all.steps.length ? all.steps[all.steps.length - 1] : null,
        last_sec: all.lastSec || null,
        sec: currentTrafficSec()
      }
    }
  })

  app.post<{ Body: { caller?: string; requests?: number } }>(
    '/follow/trace',
    async (req, reply) => {
      const who = parseCallerKey(req.body?.caller)
      if (!who || !('userId' in who))
        return reply
          .code(400)
          .send({ error: 'caller must be a person (u<id>)', code: 'CALLER_INVALID' })
      const requests = Math.min(200, Math.max(1, Number(req.body?.requests) || 50))
      const { followUser } = await import('../../services/request-trace.js')
      followUser(who.userId, requests)
      await logActivity({
        action: 'trace-user',
        user: req.user?.id,
        comment: `${who.userId} (Traffic Map follow, ${requests} requests)`,
        req
      })
      return { data: { following: who.userId, requests } }
    }
  )

  app.get<{ Querystring: { window?: string; hours?: string } }>('/egress', async (req, reply) => {
    const windowS = Number(req.query.window ?? 300)
    if (!WINDOWS.has(windowS))
      return reply
        .code(400)
        .send({ error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' })
    const hours = Number(req.query.hours ?? 0)
    const exportsSpanS = hours === 1 || hours === 6 || hours === 24 ? hours * 3600 : windowS
    const since = new Date(Date.now() - exportsSpanS * 1000)
    let rows: ExportRow[] = []
    try {
      // Two plain reads: the newest id older than the span (a short backward scan of the
      // clustered key), then a range seek above it — nivaro_activity has no timestamp index.
      const bound = (await db('nivaro_activity')
        .where('timestamp', '<', since)
        .orderBy('id', 'desc')
        .first('id')) as { id: number } | undefined
      const q = db('nivaro_activity')
        .whereIn('action', EXPORT_ACTIONS)
        .where('timestamp', '>=', since)
        .orderBy('id', 'desc')
        .limit(3000)
        .select('user', 'action', 'collection', 'comment', 'timestamp')
      if (bound?.id != null) q.where('id', '>', bound.id)
      rows = (await q) as ExportRow[]
    } catch (err) {
      req.log.warn({ err }, 'traffic-map egress: export read failed')
    }
    return {
      data: {
        window_s: windowS,
        exports_span_s: exportsSpanS,
        readers: egressReaders(windowS, currentTrafficSec()),
        exports: groupExports(rows).slice(0, 25)
      }
    }
  })

  app.get('/roles', async () => {
    const rows = (await db('nivaro_roles')
      .select('id', 'name')
      .catch(() => [])) as Array<{ id: string; name: string | null }>
    const out: Record<string, string> = {}
    for (const r of rows) out[String(r.id).toUpperCase()] = r.name || String(r.id).slice(0, 8)
    return { data: out }
  })

  app.get<{ Querystring: { caller?: string; entity?: string } }>(
    '/payloads',
    async (req, reply) => {
      const who = parseCallerKey(req.query.caller)
      if (!who)
        return reply.code(400).send({ error: 'caller is not valid', code: 'CALLER_INVALID' })
      const entity = String(req.query.entity ?? '')
      const entityOk = /^[A-Za-z0-9_.:-]{1,120}$/.test(entity)
      const q = db('nivaro_api_logs')
        .where('created_at', '>=', new Date(Date.now() - 3 * DAY_MS))
        .where((b) => {
          b.whereNotNull('request_body').orWhere('status', '>=', 400)
        })
        .orderBy('created_at', 'desc')
        .limit(5)
        .select('id', 'created_at', 'method', 'path', 'status', 'auth', 'request_body', 'error')
      if ('keyId' in who) q.where('api_key_id', who.keyId)
      else q.where('user', who.userId).whereIn('auth', ['token', 'api_key'])
      if (entityOk) q.whereRaw("path LIKE ? ESCAPE '\\'", [entityPathPattern(entity)])
      let rows: Array<Record<string, unknown>> = []
      try {
        rows = (await q) as Array<Record<string, unknown>>
      } catch (err) {
        req.log.warn({ err }, 'traffic-map payloads read failed')
      }
      return {
        data: rows.map((r) => ({
          id: Number(r.id),
          at: new Date(r.created_at as string).toISOString(),
          method: r.method ?? null,
          path: r.path ?? null,
          status: r.status == null ? null : Number(r.status),
          auth: r.auth ?? null,
          body: maskBodySecrets((r.request_body as string | null) ?? null),
          truncated: typeof r.request_body === 'string' && r.request_body.endsWith('…'),
          error: maskBodySecrets((r.error as string | null) ?? null)
        }))
      }
    }
  )
}
