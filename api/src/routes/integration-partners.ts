/**
 * Integrations console — partner health cards, partner detail and staged
 * import health (spec 2026-09-23, Task 7).
 *
 * Distinct from `integration-signals.ts`, which surfaces PROBLEMS across the
 * whole registry: this is the per-partner OVERVIEW — success rate, latency,
 * an hourly grid, and what the record already says about it (owner, contract
 * status, obligation counts) — read straight from `nivaro_outbound_log`
 * (Task 3's always-on counter row per call) rather than any signal snapshot.
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { endpointEnvironment } from '../services/endpoint-environment.js'
import { mockConfigFor, resolveInstanceRow } from '../services/external-apis.js'
import { isAuthFailure } from '../services/integration-signals-core.js'

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export function healthWord(i: {
  calls24: number
  failures24: number
  lastOkAt: Date | null
  lastFailAt: Date | null
  authFailing: boolean
}): 'healthy' | 'degraded' | 'failing' | 'idle' {
  if (i.authFailing) return 'failing'
  if (i.calls24 === 0) return 'idle'
  if (i.lastFailAt && (!i.lastOkAt || i.lastFailAt > i.lastOkAt)) return 'failing'
  if (i.failures24 / i.calls24 >= 0.2) return 'degraded'
  return 'healthy'
}

export function hourBuckets(
  calls: Array<{ created_at: Date; ok: boolean }>,
  now: Date,
  hours: number
): Array<{ hour: string; ok: number; failed: number }> {
  const out: Array<{ hour: string; ok: number; failed: number }> = []
  const idx = new Map<string, number>()
  for (let h = hours - 1; h >= 0; h--) {
    const key = new Date(now.getTime() - h * 3600_000).toISOString().slice(0, 13)
    idx.set(key, out.length)
    out.push({ hour: key, ok: 0, failed: 0 })
  }
  for (const c of calls) {
    const i = idx.get(new Date(c.created_at).toISOString().slice(0, 13))
    if (i == null) continue
    if (c.ok) out[i].ok++
    else out[i].failed++
  }
  return out
}

// Mirrors the private `AuthType` union in services/external-apis.ts — needed
// only so `resolveInstanceRow`'s generic bound is satisfied structurally;
// the column itself is unconstrained free text.
type AuthType = 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2_cc' | 'hmac' | 'aws_sigv4'

type ApiRow = {
  id: number
  name: string
  base_url: string
  auth_type: AuthType
  auth_config: string | null
  headers: string | null
  enabled: boolean | number
  mock_config: string | null
  instance_overrides: string | null
  owner_user: string | null
}

async function buildCards(onlyId?: number) {
  const now = new Date()
  const since7 = new Date(now.getTime() - 7 * 86_400_000)
  const since24 = new Date(now.getTime() - 86_400_000)
  let q = db('nivaro_external_apis').select(
    'id',
    'name',
    'base_url',
    'auth_type',
    'auth_config',
    'headers',
    'enabled',
    'mock_config',
    'instance_overrides',
    'owner_user'
  )
  if (onlyId) q = q.where({ id: onlyId })
  const apis = (await q) as ApiRow[]
  const calls = (await db('nivaro_outbound_log')
    .where('created_at', '>=', since7)
    .modify((x) => (onlyId ? x.where({ api_id: onlyId }) : x))
    .select('api_id', 'ok', 'status', 'error', 'duration_ms', 'created_at')) as Array<{
    api_id: number
    ok: boolean | number
    status: number | null
    error: string | null
    duration_ms: number
    created_at: Date
  }>
  const obl = (await db('nivaro_integration_obligations')
    .whereNull('resolved_at')
    .orWhere('created_at', '>=', since7)
    .groupBy('api', 'outcome')
    .select('api', 'outcome')
    .count('* as n')) as Array<{ api: string; outcome: string; n: number | string }>
  const owners = (await db('nivaro_users')
    .whereIn('id', apis.map((a) => a.owner_user).filter(Boolean) as string[])
    .select('id', 'first_name', 'last_name')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
  }>
  return apis.map((a) => {
    const mine = calls
      .filter((c) => c.api_id === a.id)
      .sort((x, y) => +new Date(y.created_at) - +new Date(x.created_at))
    const d24 = mine.filter((c) => new Date(c.created_at) >= since24)
    const ok24 = d24.filter((c) => !!c.ok).length
    const ok7 = mine.filter((c) => !!c.ok).length
    const lastOk = mine.find((c) => !!c.ok)
    const lastFail = mine.find((c) => !c.ok)
    const authFailing = !!mine[0] && !mine[0].ok && isAuthFailure(mine[0].status, mine[0].error)
    const durations = d24.map((c) => c.duration_ms).sort((x, y) => x - y)
    const row = resolveInstanceRow({ ...a, enabled: !!a.enabled })
    const counts = { sent: 0, pending: 0, failed: 0, missing: 0, overdue: 0 }
    for (const o of obl)
      if (o.api === a.name && o.outcome in counts)
        counts[o.outcome as keyof typeof counts] = Number(o.n)
    const owner = owners.find((u) => u.id === a.owner_user)
    return {
      id: a.id,
      name: a.name,
      enabled: !!a.enabled,
      health: healthWord({
        calls24: d24.length,
        failures24: d24.length - ok24,
        lastOkAt: lastOk ? new Date(lastOk.created_at) : null,
        lastFailAt: lastFail ? new Date(lastFail.created_at) : null,
        authFailing
      }),
      calls24: d24.length,
      success_pct24: d24.length ? Math.round((ok24 / d24.length) * 1000) / 10 : null,
      success_pct7d: mine.length ? Math.round((ok7 / mine.length) * 1000) / 10 : null,
      p50_ms: percentile(durations, 50),
      p95_ms: percentile(durations, 95),
      last_ok_at: lastOk ? new Date(lastOk.created_at).toISOString() : null,
      last_fail_at: lastFail ? new Date(lastFail.created_at).toISOString() : null,
      last_fail_reason: lastFail
        ? (lastFail.error ?? (lastFail.status != null ? `HTTP ${lastFail.status}` : 'No response'))
        : null,
      hourly: hourBuckets(
        mine.map((c) => ({ created_at: c.created_at, ok: !!c.ok })),
        now,
        48
      ),
      flags: {
        test_endpoint: endpointEnvironment(row.base_url).environment === 'test',
        mock: !!mockConfigFor(a),
        auth_failing: authFailing
      },
      owner: owner
        ? { id: owner.id, name: `${owner.first_name ?? ''} ${owner.last_name ?? ''}`.trim() }
        : null,
      obligations: counts
    }
  })
}

export type PartnerCard = Awaited<ReturnType<typeof buildCards>>[number]

export async function integrationPartnersRoutes(app: FastifyInstance) {
  app.get('/integration-partners', { preHandler: requireAdmin }, async () => {
    const partners = await buildCards()
    const calls24 = partners.reduce((s, p) => s + p.calls24, 0)
    const ok24 = partners.reduce(
      (s, p) => s + (p.success_pct24 != null ? (p.success_pct24 / 100) * p.calls24 : 0),
      0
    )
    return {
      data: {
        summary: {
          calls24,
          success_pct24: calls24 ? Math.round((ok24 / calls24) * 1000) / 10 : null,
          not_healthy: partners.filter((p) => p.health === 'degraded' || p.health === 'failing')
            .length
        },
        partners
      }
    }
  })

  // Registered ahead of `/:id` so this static segment wins the route match.
  app.get('/integration-partners/imports', { preHandler: requireAdmin }, async () => {
    const { resolveThresholds } = await import('../services/integration-signal-settings.js')
    const { getIntegrationSignal } = await import('../services/integration-signals.js')
    const stale = getIntegrationSignal('core:import-stale')
    const th = stale ? (await resolveThresholds(stale)).thresholds : { default_hours: 48 }
    const rows = (await db.raw(
      `SELECT d.[key], d.label,
              (SELECT TOP 1 status FROM nivaro_import_queue q WHERE q.definition = d.id ORDER BY q.id DESC) AS last_status,
              (SELECT MAX(COALESCE(finished_at, started_at)) FROM nivaro_import_queue q WHERE q.definition = d.id) AS last_run_at,
              (SELECT MAX(finished_at) FROM nivaro_import_queue q WHERE q.definition = d.id AND q.status = 'completed') AS last_ok_at,
              (SELECT COUNT(*) FROM nivaro_import_queue q WHERE q.definition = d.id AND q.status = 'error' AND q.created_at >= DATEADD(day, -7, GETUTCDATE())) AS failures7d
         FROM nivaro_import_definitions d WHERE d.is_active = 1 ORDER BY d.sort, d.label`
    )) as Array<{
      key: string
      label: string
      last_status: string | null
      last_run_at: Date | null
      last_ok_at: Date | null
      failures7d: number
    }>
    return {
      data: rows.map((r) => {
        const cadence = th[`cadence_hours:${r.key}`] ?? th.default_hours
        return {
          ...r,
          failures7d: Number(r.failures7d),
          cadence_hours: cadence,
          stale:
            !!r.last_ok_at && Date.now() - new Date(r.last_ok_at).getTime() > cadence * 3600_000
        }
      })
    }
  })

  app.get('/integration-partners/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const [card] = await buildCards(id)
    if (!card) return reply.code(404).send({ error: 'Not found' })
    const calls = await db('nivaro_outbound_log')
      .where({ api_id: id })
      .orderBy('id', 'desc')
      .limit(200)
      .select('id', 'created_at', 'method', 'path', 'status', 'ok', 'duration_ms', 'error')
    const contracts = await db('nivaro_external_api_endpoints')
      .where({ api_id: id })
      .whereNotNull('contract')
      .select(
        'id as endpoint_id',
        'name',
        'contract_last_run as last_run',
        'contract_last_ok as ok',
        'contract_last_detail as detail'
      )
      .catch(() => [])
    return { data: { card, calls, contracts } }
  })
}
