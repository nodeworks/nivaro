// api/src/routes/traffic-map-extras/request-lenses.ts
/**
 * Traffic Map group B1 — request taps & lenses. Importing the tap modules here registers them
 * at boot (this plugin is loaded by trafficMapRoutes). Routes land under /api/traffic-map, admin
 * only, 404 in cloud mode (the parent plugin's hooks).
 *
 * GET /caller-auth?caller=k12|u<ID>  the caller's API key config + 24 h of 401/403/429 codes
 * GET /people?ids=u<ID>,…            display names for user caller keys (masquerade admins)
 * GET /workspaces                    workspace id → name
 * GET /lens/:tap?window=60|300|900   one B1 tap's snapshot figures, for panels that refresh on
 *                                    their own (memory only — no database read)
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import { AUTH_MIX_TAP } from '../../services/traffic-taps/auth-mix.js'
import { AUTH_REJECTIONS_TAP } from '../../services/traffic-taps/auth-rejections.js'
import { CONFLICTS_TAP } from '../../services/traffic-taps/conflicts.js'
import { MASQUERADE_TAP } from '../../services/traffic-taps/masquerade.js'
import { PUBLIC_CLIENTS_TAP } from '../../services/traffic-taps/public-clients.js'
import { REHEARSAL_TAP } from '../../services/traffic-taps/rehearsal.js'
import { RETRY_STORMS_TAP } from '../../services/traffic-taps/retry-storms.js'
import { WORKSPACES_TAP } from '../../services/traffic-taps/workspaces.js'
import { trafficTaps } from '../../services/traffic-taps.js'
import { parseRefusal } from '../api-analytics.js'
import '../../services/traffic-taps/cache-ratio.js'
import '../../services/traffic-taps/duplicates.js'
import '../../services/traffic-taps/entity-callers.js'
import '../../services/traffic-taps/response-bytes.js'

/** Taps whose snapshot a panel may poll through /lens/:tap. */
const LENS_TAPS = new Set([
  AUTH_MIX_TAP,
  AUTH_REJECTIONS_TAP,
  CONFLICTS_TAP,
  MASQUERADE_TAP,
  PUBLIC_CLIENTS_TAP,
  REHEARSAL_TAP,
  RETRY_STORMS_TAP,
  WORKSPACES_TAP
])
const WINDOWS = new Set([60, 300, 900])
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i
const SCAN = 2000

function parseList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 401/403/429 rows grouped by status + reason code, busiest first. */
export function groupRefusals(
  rows: Array<{ status: number; error: string | null }>
): Array<{ status: number; code: string; n: number }> {
  const m = new Map<string, { status: number; code: string; n: number }>()
  for (const r of rows) {
    const { code } = parseRefusal(r.error, Number(r.status))
    const k = `${r.status}|${code}`
    const row = m.get(k) ?? { status: Number(r.status), code, n: 0 }
    row.n++
    m.set(k, row)
  }
  return [...m.values()].sort((a, b) => b.n - a.n)
}

export async function requestLensesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { caller?: string } }>('/caller-auth', async (req, reply) => {
    const caller = String(req.query.caller ?? '')
    const keyId = /^k\d{1,12}$/.test(caller) ? Number(caller.slice(1)) : null
    const userId = /^u/.test(caller) && UUID_RE.test(caller.slice(1)) ? caller.slice(1) : null
    if (keyId == null && !userId) {
      return reply.code(400).send({ error: 'caller is not valid', code: 'CALLER_INVALID' })
    }
    let key: Record<string, unknown> | null = null
    if (keyId != null) {
      const row = (await db('nivaro_api_keys')
        .where({ id: keyId })
        .first()
        .catch(() => null)) as Record<string, unknown> | null
      if (row) {
        key = {
          id: Number(row.id),
          name: row.name,
          prefix: row.prefix ?? null,
          is_active: row.is_active === true || row.is_active === 1,
          sandbox: row.sandbox === true || row.sandbox === 1,
          expires_at: row.expires_at ?? null,
          last_used_at: row.last_used_at ?? null,
          rate_limit_per_minute:
            row.rate_limit_per_minute == null ? null : Number(row.rate_limit_per_minute),
          scopes: parseList(row.scopes),
          scope_restrictions: parseList(row.scope_restrictions),
          ip_allowlist: parseList(row.ip_allowlist)
        }
      }
    }
    const since = new Date(Date.now() - 24 * 3600_000)
    let refusals: Array<{ status: number; code: string; n: number }> = []
    try {
      const q = db('nivaro_api_logs')
        .where('created_at', '>=', since)
        .whereIn('status', [401, 403, 429])
        .orderBy('created_at', 'desc')
        .limit(SCAN)
        .select('status', 'error')
      if (keyId != null) q.where('api_key_id', keyId)
      else q.where('user', userId as string)
      refusals = groupRefusals((await q) as Array<{ status: number; error: string | null }>)
    } catch (err) {
      req.log.warn({ err }, 'traffic-map caller-auth history read failed')
    }
    return { data: { caller, key, refusals_24h: refusals } }
  })

  app.get<{ Querystring: { ids?: string } }>('/people', async (req) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^u/, ''))
      .filter((s) => UUID_RE.test(s))
      .slice(0, 50)
    if (!ids.length) return { data: {} }
    const rows = (await db('nivaro_users')
      .whereIn('id', ids)
      .select('id', 'first_name', 'last_name', 'email')
      .catch(() => [])) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string
    }>
    const out: Record<string, string> = {}
    for (const u of rows) {
      out[`u${String(u.id).toUpperCase()}`] =
        `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email.split('@')[0]
    }
    return { data: out }
  })

  app.get<{ Params: { tap: string }; Querystring: { window?: string } }>(
    '/lens/:tap',
    async (req, reply) => {
      const windowS = Number(req.query.window ?? 60)
      const tap = trafficTaps().find((t) => t.id === req.params.tap)
      if (!LENS_TAPS.has(req.params.tap) || !tap?.snapshot || !WINDOWS.has(windowS)) {
        return reply.code(400).send({ error: 'tap or window is not valid', code: 'LENS_INVALID' })
      }
      return { data: tap.snapshot(windowS, currentTrafficSec()) ?? null }
    }
  )

  app.get('/workspaces', async () => {
    const rows = (await db('nivaro_workspaces')
      .select('id', 'name')
      .catch(() => [])) as Array<{ id: string; name: string | null }>
    const out: Record<string, string> = {}
    for (const w of rows) out[String(w.id).toUpperCase()] = w.name || String(w.id).slice(0, 8)
    return { data: out }
  })
}
