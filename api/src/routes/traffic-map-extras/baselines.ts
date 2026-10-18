// api/src/routes/traffic-map-extras/baselines.ts
/**
 * Traffic Map — baselines and everything judged against them:
 *   GET  /baselines        normal-for-this-hour bands per node, caller, edge and partner (#2145)
 *   GET  /heatmap          hour × weekday heatmap of one node or caller, last four weeks (#2137)
 *   GET  /what-changed     what explains a node's rise: 15 minutes before vs since (#2148)
 *   GET  /deploy-check     deploy now or wait, with the reason (#2221)
 *   GET  /summary          the plain executive view's five tiles (#2244)
 *   POST /alert-preview    when an alert would have fired over the last two weeks (#2222, #2247)
 * Mounted under /api/traffic-map by traffic-map-extras/index.ts (admin only). The hourly roll-up
 * cron (`traffic-baselines-rollup`) is registered here, self-hosted only.
 */
import type { FastifyInstance } from 'fastify'
import { clientGoneSignal, sharedGatedRead } from '../../services/read-gate.js'
import { previewTrafficAlert } from '../../services/traffic-alert-preview.js'
import {
  baselinesAt,
  type HeatMetric,
  heatmapFor,
  rollupBackfill,
  rollupKeyFor,
  validTimeZone
} from '../../services/traffic-baselines.js'
import { deployCheck, executiveSummary } from '../../services/traffic-judgements.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import { normalizeTrafficConfig } from '../../services/traffic-monitor.js'
import { changeMarkers } from '../../services/traffic-taps/change-markers.js'
import {
  entityMinutes,
  explainRise,
  HALF_MIN,
  type RiseMetric
} from '../../services/traffic-taps/what-changed.js'

const LANE_ENTITY = /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/
const HEAT_METRICS = new Set<HeatMetric>(['req', 'errors', 'p95'])

export async function baselineRoutes(app: FastifyInstance): Promise<void> {
  const tenantAware = { config: { trafficTenantAware: true } }
  const cron = (app as unknown as { cron?: { schedule: (...a: unknown[]) => void } }).cron
  if (!process.env.CLOUD_META_DB_URL && cron) {
    cron.schedule(
      'traffic-baselines-rollup',
      '7 * * * *',
      async () => {
        const r = await rollupBackfill()
        return r
      },
      {
        idempotent: 'safe',
        description:
          'Rolls the request log up per hour (requests, errors and latency per Traffic Map node) so the map can learn what is normal for each hour of the week. Keeps four weeks in Redis.'
      }
    )
  }

  app.get('/baselines', tenantAware, async () => ({ data: await baselinesAt() }))

  app.get<{ Querystring: { kind?: string; id?: string; metric?: string; tz?: string } }>(
    '/heatmap',
    tenantAware,
    async (req, reply) => {
      const key = rollupKeyFor(String(req.query.kind ?? ''), String(req.query.id ?? ''))
      const metric = String(req.query.metric ?? 'req') as HeatMetric
      if (!key || !HEAT_METRICS.has(metric))
        return reply
          .code(400)
          .send({ error: 'kind, id or metric is not valid', code: 'HEATMAP_PARAMS_INVALID' })
      return { data: await heatmapFor(key, metric, validTimeZone(req.query.tz)) }
    }
  )

  app.get<{ Querystring: { key?: string; metric?: string; since?: string } }>(
    '/what-changed',
    async (req, reply) => {
      const key = String(req.query.key ?? '')
      const metric = req.query.metric === 'latency' ? 'latency' : 'errors'
      if (!LANE_ENTITY.test(key))
        return reply.code(400).send({ error: 'key is not a node key', code: 'NODE_KEY_INVALID' })
      const sec = currentTrafficSec()
      const nowMin = Math.floor(sec / 60)
      const since = Number(req.query.since)
      const pivot =
        Number.isFinite(since) && since > 0
          ? Math.min(nowMin, Math.max(nowMin - HALF_MIN + 1, Math.floor(since / 60_000)))
          : null
      const ex = explainRise(entityMinutes(key, nowMin), nowMin, metric as RiseMetric, pivot)
      const from = ex.before.from_min * 60_000
      const to = ex.after.to_min * 60_000
      const pivotMs = (ex.pivot_min ?? ex.after.from_min) * 60_000
      const markers = (await changeMarkers(from, to).catch(() => [])).map((m) => ({
        ...m,
        // within five minutes before / two after the rise: a likely cause
        near: m.at >= pivotMs - 5 * 60_000 && m.at <= pivotMs + 2 * 60_000
      }))
      return { data: { key, ...ex, pivot_at: ex.pivot_min == null ? null : pivotMs, markers } }
    }
  )

  app.get<{ Querystring: { tz?: string } }>('/deploy-check', async (req) => ({
    data: await deployCheck(
      app as unknown as Parameters<typeof deployCheck>[0],
      validTimeZone(req.query.tz)
    )
  }))

  app.get<{ Querystring: { tz?: string } }>('/summary', tenantAware, async (req) => ({
    data: await executiveSummary(validTimeZone(req.query.tz))
  }))

  app.post<{ Body: Record<string, unknown> }>('/alert-preview', tenantAware, async (req, reply) => {
    const cfg = normalizeTrafficConfig(
      (req.body ?? {}) as Parameters<typeof normalizeTrafficConfig>[0]
    )
    if (!cfg)
      return reply.code(400).send({
        error: 'Needs an entity (or edge), a metric and a threshold',
        code: 'ALERT_PREVIEW_INVALID'
      })
    // Two weeks of the request log: one gated run per identical question (single-flight),
    // never more than the read gate allows at once.
    try {
      const { value } = await sharedGatedRead(
        `tm:alert-preview|${JSON.stringify(cfg)}|${JSON.stringify(req.query ?? {})}`,
        req.user?.id,
        () => previewTrafficAlert(cfg, req.query),
        { signal: clientGoneSignal(reply.raw), label: 'tm:alert-preview' }
      )
      return { data: value }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map alert preview failed')
      return reply.code(503).send({
        error: 'The preview could not finish — try again in a moment',
        code: 'ALERT_PREVIEW_FAILED'
      })
    }
  })
}
