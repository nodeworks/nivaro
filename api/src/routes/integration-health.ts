import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Integration health — one answer to "is MDSi ok?".
 *
 * The pieces already existed but lived four pages apart: erp-submissions has
 * the push outcomes, dead-letters the failed deliveries, flow runs the
 * event-driven pushes, cron list the scheduled jobs. During an incident (and
 * during cutover, permanently) someone has to stitch those together in their
 * head. This aggregates them per external API + the cron roster into one
 * payload the Integrations page renders as a war-room screen.
 *
 * Read-only aggregation over existing tables — no new state, no new writes.
 */

interface ErpAgg {
  external_api: number | null
  status: string
  c: number | string
  last_at: Date | string | null
}

export async function integrationHealthRoutes(app: FastifyInstance) {
  app.get('/integration-health', { preHandler: requireAdmin }, async (_req, reply) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000)

    const [apis, aggAll, agg24, lastFailures, deadLetterCount, flowRuns] = await Promise.all([
      db('nivaro_external_apis').select('id', 'name', 'base_url', 'auth_type') as Promise<
        Array<{ id: number; name: string; base_url: string | null; auth_type: string | null }>
      >,
      // Last activity per api+status, all time — "when did this last work"
      // must not be blank just because the last success predates the window.
      db('nivaro_erp_submissions')
        .groupBy('external_api', 'status')
        .select('external_api', 'status')
        .count('* as c')
        .max('updated_at as last_at') as Promise<ErpAgg[]>,
      db('nivaro_erp_submissions')
        .where('updated_at', '>=', since)
        .groupBy('external_api', 'status')
        .select('external_api', 'status')
        .count('* as c') as Promise<ErpAgg[]>,
      // Latest failure message per api — the thing an operator reads first.
      db('nivaro_erp_submissions as e')
        .whereIn('e.id', (qb) => {
          void qb
            .from('nivaro_erp_submissions as f')
            .where('f.status', 'failed')
            .groupBy('f.external_api')
            .max('f.id')
        })
        .select(
          'e.external_api',
          'e.last_error',
          'e.updated_at',
          'e.collection',
          'e.item'
        ) as Promise<
        Array<{
          external_api: number | null
          last_error: string | null
          updated_at: Date
          collection: string
          item: string
        }>
      >,
      // Dead letters ARE flow_runs with status='error' (there is no separate
      // table — the /dead-letters page reads flow runs), so the flow-run
      // aggregation below covers them.
      Promise.resolve(undefined) as Promise<{ c: number | string } | undefined>,
      // Flow runs 24h — event-driven integration pushes (MWF link etc.) run
      // as flows, not erp submissions.
      db('nivaro_flow_runs')
        .where('started_at', '>=', since)
        .groupBy('status')
        .select('status')
        .count('* as c')
        .catch(() => []) as Promise<Array<{ status: string; c: number | string }>>
    ])

    const byApi = new Map<
      number,
      {
        id: number
        name: string
        base_url: string | null
        auth_type: string | null
        totals: Record<string, number>
        last_success_at: string | null
        last_activity_at: string | null
        window_24h: Record<string, number>
        last_failure: {
          error: string | null
          at: string
          collection: string
          item: string
        } | null
      }
    >()
    for (const api of apis) {
      byApi.set(api.id, {
        ...api,
        totals: {},
        last_success_at: null,
        last_activity_at: null,
        window_24h: {},
        last_failure: null
      })
    }
    for (const row of aggAll) {
      const entry = row.external_api != null ? byApi.get(Number(row.external_api)) : undefined
      if (!entry) continue
      entry.totals[row.status] = Number(row.c)
      const at = row.last_at ? new Date(row.last_at).toISOString() : null
      if (at && (!entry.last_activity_at || at > entry.last_activity_at)) {
        entry.last_activity_at = at
      }
      if ((row.status === 'accepted' || row.status === 'pending') && at) {
        if (!entry.last_success_at || at > entry.last_success_at) entry.last_success_at = at
      }
    }
    for (const row of agg24) {
      const entry = row.external_api != null ? byApi.get(Number(row.external_api)) : undefined
      if (entry) entry.window_24h[row.status] = Number(row.c)
    }
    for (const row of lastFailures) {
      const entry = row.external_api != null ? byApi.get(Number(row.external_api)) : undefined
      if (entry) {
        entry.last_failure = {
          error: row.last_error,
          at: new Date(row.updated_at).toISOString(),
          collection: row.collection,
          item: String(row.item)
        }
      }
    }

    const flowsByStatus: Record<string, number> = {}
    for (const r of flowRuns) flowsByStatus[r.status] = Number(r.c)

    return reply.send({
      data: {
        apis: [...byApi.values()],
        crons: app.cron.list(),
        dead_letters_24h: Number(flowsByStatus.error ?? 0),
        flow_runs_24h: flowsByStatus
      }
    })
  })
}
