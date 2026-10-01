import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import { ownershipFigures } from '../../services/traffic-taps/ext-ownership.js'
import '../../services/traffic-taps/graphql-resolvers.js'
import { queueCacheFigures } from '../../services/traffic-taps/queue-cache.js'
import '../../services/traffic-taps/tenant-load.js'

/**
 * Traffic Map round 4, platform group:
 *   #1173 GET /ownership — per node, core vs each extension's share of the window's load;
 *   #1175 GET /queue-cache — materialized queues: resync cost per write, backfills, rebuild age;
 *   #1177 nested GraphQL resolver times ride GET /entity-detail (tap `graphql-resolvers`);
 *   #1184 GET /dead-letters — the dead letter node: failed flow runs and webhook deliveries
 *         (Retry / Discard go through the existing /api/dead-letters and /api/webhooks routes);
 *   #1185 the tenant-load tap (the operator ranking lives at /admin/traffic-tenants).
 * Every route reads only the caller's store / database, so all are tenant-aware.
 */
const WINDOWS = new Set([60, 300, 900])
const DEAD_LETTER_LIMIT = 30
const DELIVERY_HOURS = 24

function windowOf(q: { window?: string }): number | null {
  const w = Number(q.window ?? 60)
  return WINDOWS.has(w) ? w : null
}

export interface DeadLetterFigures {
  flow_runs: {
    count: number
    items: Array<{
      id: string
      flow: string
      flow_name: string | null
      trigger: string | null
      error: string | null
      failed_at: string | null
    }>
    /** `flow:<id>` → failed runs, for the canvas edges. */
    by_flow: Record<string, number>
  }
  deliveries: {
    hours: number
    count: number
    items: Array<{
      id: number
      webhook: number
      webhook_name: string | null
      event: string
      status_code: number | null
      at: string | null
    }>
  }
}

const iso = (v: unknown): string | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export async function deadLetterFigures(): Promise<DeadLetterFigures> {
  const [runs, countRow, byFlow, deliveries] = await Promise.all([
    db('nivaro_flow_runs as r')
      .leftJoin('nivaro_flows as f', 'f.id', 'r.flow')
      .where('r.status', 'error')
      .orderBy('r.started_at', 'desc')
      .limit(DEAD_LETTER_LIMIT)
      .select(
        'r.id',
        'r.flow',
        'r.trigger',
        'r.error_message',
        'r.started_at',
        'r.completed_at',
        'f.name as flow_name'
      )
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_flow_runs')
      .where('status', 'error')
      .count({ n: '*' })
      .first()
      .catch(() => undefined) as Promise<{ n?: number | string } | undefined>,
    db('nivaro_flow_runs')
      .where('status', 'error')
      .groupBy('flow')
      .select('flow')
      .count({ n: '*' })
      .catch(() => []) as Promise<Array<{ flow: string; n: number | string }>>,
    // Failed deliveries of the last day whose webhook has not delivered successfully since.
    db('nivaro_webhook_deliveries as d')
      .leftJoin('nivaro_webhooks as w', 'w.id', 'd.webhook')
      .where('d.success', false)
      .where('d.created_at', '>=', new Date(Date.now() - DELIVERY_HOURS * 3600_000))
      .whereNotExists(
        db('nivaro_webhook_deliveries as s')
          .whereRaw('s.webhook = d.webhook')
          .where('s.success', true)
          .whereRaw('s.id > d.id')
          .select(db.raw('1'))
      )
      .orderBy('d.id', 'desc')
      .limit(200)
      .select(
        'd.id',
        'd.webhook',
        'd.event',
        'd.status_code',
        'd.created_at',
        'w.name as webhook_name'
      )
      .catch(() => []) as Promise<Array<Record<string, unknown>>>
  ])
  const by_flow: Record<string, number> = {}
  for (const r of byFlow) if (r.flow) by_flow[`flow:${r.flow}`] = Number(r.n) || 0
  return {
    flow_runs: {
      count: Number(countRow?.n ?? runs.length) || 0,
      items: runs.map((r) => ({
        id: String(r.id),
        flow: String(r.flow ?? ''),
        flow_name: (r.flow_name as string | null) ?? null,
        trigger: (r.trigger as string | null) ?? null,
        error: r.error_message ? String(r.error_message).slice(0, 300) : null,
        failed_at: iso(r.completed_at ?? r.started_at)
      })),
      by_flow
    },
    deliveries: {
      hours: DELIVERY_HOURS,
      count: deliveries.length,
      items: deliveries.slice(0, DEAD_LETTER_LIMIT).map((d) => ({
        id: Number(d.id),
        webhook: Number(d.webhook),
        webhook_name: (d.webhook_name as string | null) ?? null,
        event: String(d.event ?? ''),
        status_code: d.status_code == null ? null : Number(d.status_code),
        at: iso(d.created_at)
      }))
    }
  }
}

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { window?: string } }>(
    '/ownership',
    { config: { trafficTenantAware: true } },
    async (req, reply) => {
      const w = windowOf(req.query)
      if (!w) return reply.code(400).send({ error: 'window must be 60, 300 or 900' })
      return { data: ownershipFigures(w, currentTrafficSec()) }
    }
  )

  app.get<{ Querystring: { window?: string } }>(
    '/queue-cache',
    { config: { trafficTenantAware: true } },
    async (req, reply) => {
      const w = windowOf(req.query)
      if (!w) return reply.code(400).send({ error: 'window must be 60, 300 or 900' })
      return { data: await queueCacheFigures(w, currentTrafficSec()) }
    }
  )

  app.get('/dead-letters', { config: { trafficTenantAware: true } }, async () => ({
    data: await deadLetterFigures()
  }))
}
