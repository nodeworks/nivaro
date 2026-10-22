import type { FastifyInstance } from 'fastify'
import { logActivity } from '../services/activity.js'
import { dockerConfigured } from '../services/docker-source.js'
import {
  cloudMode,
  DriftInputError,
  driftStatus,
  driftTablesReady,
  recordBaseline,
  runDriftCheck
} from '../services/infra-drift/store.js'

/**
 * #2798 stack drift detector, under /api/infrastructure (whose requireAdmin hook covers every
 * route here). The deploy script posts a baseline after every converged deploy; the nightly
 * check (and Check now) compares the live specs read through docker-source with it. Not in
 * cloud mode: a tenant never stores or sees the operator's service specs.
 */

/** A stack of ~30 services is ~600 KB of inspect JSON; leave room, refuse anything silly. */
const BASELINE_BODY_LIMIT = 8 * 1024 * 1024

export async function infrastructureDriftRoutes(app: FastifyInstance): Promise<void> {
  // Hooks here are local to this plugin, so this covers exactly the drift routes.
  app.addHook('onRequest', async (_req, reply) => {
    if (cloudMode()) return reply.code(404).send({ error: 'Not found' })
  })

  app.get('/drift', async () => ({ data: await driftStatus() }))

  app.post<{ Body: Record<string, unknown> }>(
    '/drift/baseline',
    { bodyLimit: BASELINE_BODY_LIMIT },
    async (req, reply) => {
      if (!(await driftTablesReady()))
        return reply
          .code(503)
          .send({ error: 'The drift tables are not on this database yet (migration 500).' })
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      try {
        const r = await recordBaseline(body, req.user?.id ?? null)
        await logActivity({
          action: 'infra-drift-baseline',
          user: req.user?.id ?? null,
          collection: 'infrastructure',
          item: `${r.stack}:${r.environment}`,
          comment: `${r.source} baseline · ${r.services} services${
            typeof body.version === 'string' ? ` · version ${body.version.slice(0, 60)}` : ''
          }${typeof body.release === 'string' ? ` · release ${body.release.slice(0, 120)}` : ''}`,
          req
        })
        return { data: r }
      } catch (err) {
        if (err instanceof DriftInputError) return reply.code(400).send({ error: err.message })
        throw err
      }
    }
  )

  app.post<{ Body: { stack?: unknown; environment?: unknown } }>(
    '/drift/check',
    async (req, reply) => {
      if (!(await driftTablesReady()))
        return reply
          .code(503)
          .send({ error: 'The drift tables are not on this database yet (migration 500).' })
      const b = req.body ?? {}
      const stack = typeof b.stack === 'string' && b.stack ? b.stack : undefined
      const environment =
        typeof b.environment === 'string' && b.environment ? b.environment : undefined
      const outcomes = await runDriftCheck({ stack, environment })
      return {
        data: {
          checked: outcomes.length,
          outcomes: outcomes.map(({ new_findings, ...o }) => ({ ...o, new: new_findings.length }))
        }
      }
    }
  )

  // Nightly 03:15 — only where a Docker host is configured (like infra-health-sample); the
  // scheduler fires it only where cronTicksEnabled(), and every cron runs on the background pool.
  if (dockerConfigured() && app.cron && !cloudMode()) {
    app.cron.schedule(
      'infra-drift-check',
      '15 3 * * *',
      async () => {
        const outcomes = await runDriftCheck()
        const drift = outcomes.reduce((n, o) => n + o.drift, 0)
        const fresh = outcomes.reduce((n, o) => n + o.new_findings.length, 0)
        app.log.info(
          `infra-drift-check: ${outcomes.length} stacks, ${drift} drifted fields (${fresh} new)`
        )
      },
      {
        idempotent: 'safe',
        description:
          "Nightly 03:15 — reads each stack's live service specs through the read-only Docker proxy (image digest, env, mounts, secrets, replicas, limits, placement, healthcheck, update config, labels) and compares them with the baseline the last deploy stored. Differences are listed on Environments → Stack drift and admins are told once per new difference. Reads Docker only; writes its own findings."
      }
    )
  }
}
