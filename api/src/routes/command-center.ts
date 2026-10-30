import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { ccReadAuth } from '../services/command-center/auth.js'
import { EMPTY_PEOPLE, snapshotPeople } from '../services/command-center/people.js'
import { readCcScope } from '../services/command-center/scope.js'
import { excludeStartRows } from '../services/instance-start.js'
import { can } from '../services/permissions.js'
import { geoRoute, peopleGeoRoute } from './command-center-place.js'

/**
 * Command Center (/command): one aggregator over data the platform already
 * computes — nothing here derives new state, it composes existing services
 * into a live ops board. Every sub-block is independently try/caught so one
 * broken source degrades to an empty pane, never a dead board.
 *
 * Reads honor the caller: record-level payloads (map pins) go through the
 * items service (RBAC/RLS/scopes); aggregate counts are gated on collection
 * read permission; the system-health block is admin-only.
 */

export async function commandCenterRoutes(app: FastifyInstance) {
  // Every route here is a read; writes add ccWriteAuth on the route itself.
  app.addHook('preHandler', ccReadAuth)

  // ── Snapshot: everything except map geometry, one round trip ─────────────
  app.get('/snapshot', async (req, reply) => {
    const isAdmin = !!req.isAdmin
    const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn()
      } catch {
        return fallback
      }
    }

    const [flow, risk, people, throughput, health, activity] = await Promise.all([
      // Pipeline flow board: per bound collection, live state counts of OPEN
      // instances. Gated per collection on read permission.
      safe(
        async () => {
          const bindings = (await db('nivaro_workflow_bindings as b')
            .join('nivaro_workflow_templates as t', 't.id', 'b.template')
            .select('b.collection', 'b.template', 't.name as template_name')) as Array<{
            collection: string
            template: string
            template_name: string
          }>
          const out: Array<{
            collection: string
            template_name: string
            states: Array<{ key: string; label: string; color: string | null; count: number }>
          }> = []
          for (const b of bindings) {
            if (!(await can(req.user!, 'read', b.collection))) continue
            const counts = (await db('nivaro_workflow_instances as i')
              .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
              .where('i.collection', b.collection)
              .where('i.template', b.template)
              .whereNull('i.completed_at')
              .groupBy('s.key', 's.label', 's.color', 's.sort')
              .orderBy('s.sort', 'asc')
              .select('s.key', 's.label', 's.color')
              .count('* as count')) as Array<{
              key: string
              label: string
              color: string | null
              count: number
            }>
            if (counts.length > 0) {
              out.push({
                collection: b.collection,
                template_name: b.template_name,
                states: counts.map((c) => ({ ...c, count: Number(c.count) }))
              })
            }
          }
          return out
        },
        [] as Array<{
          collection: string
          template_name: string
          states: Array<{ key: string; label: string; color: string | null; count: number }>
        }>
      ),

      // Risk strip: SLA warning/breached + at-risk + open issues, cheap counts.
      safe(
        async () => {
          const since = new Date(Date.now() - 90 * 86_400_000)
          // Materialized queue rows carry SLA verdicts already — the cheapest
          // instance-wide read that exists. Fall back to zeros when no queue is
          // materialized; the strip labels its source honestly.
          const slaRow = (await db('nivaro_queue_items')
            .select(
              db.raw('SUM(CASE WHEN at_risk = 1 THEN 1 ELSE 0 END) as at_risk'),
              db.raw("COUNT(DISTINCT CONCAT(collection, ':', item_id)) as tracked")
            )
            .first()
            .catch(() => null)) as { at_risk: number; tracked: number } | null
          const openIssues = (await db('nivaro_issues')
            .where('status', 'open')
            .where('last_seen_at', '>', since)
            .count('* as n')
            .first()) as { n: number }
          return {
            at_risk: Number(slaRow?.at_risk ?? 0),
            tracked: Number(slaRow?.tracked ?? 0),
            open_issues: Number(openIssues?.n ?? 0)
          }
        },
        { at_risk: 0, tracked: 0, open_issues: 0 }
      ),

      // People on now (slice 1: services/command-center/people.ts).
      safe(() => snapshotPeople(app, req, readCcScope(req.query)), EMPTY_PEOPLE),

      // Throughput: transitions today vs same window yesterday.
      safe(
        async () => {
          const now = new Date()
          const todayStart = new Date(now)
          todayStart.setUTCHours(0, 0, 0, 0)
          const yStart = new Date(todayStart.getTime() - 86_400_000)
          const yCut = new Date(now.getTime() - 86_400_000)
          const [today, yesterday] = await Promise.all([
            // #1219: a pipeline start is history, not a transition.
            excludeStartRows(db('nivaro_workflow_history').where('timestamp', '>', todayStart))
              .count('* as n')
              .first(),
            excludeStartRows(
              db('nivaro_workflow_history').whereBetween('timestamp', [yStart, yCut])
            )
              .count('* as n')
              .first()
          ])
          return {
            transitions_today: Number((today as { n: number })?.n ?? 0),
            transitions_yesterday_same_time: Number((yesterday as { n: number })?.n ?? 0)
          }
        },
        { transitions_today: 0, transitions_yesterday_same_time: 0 }
      ),

      // System rail — ADMIN ONLY (names internal jobs and error details).
      isAdmin
        ? safe(async () => {
            const hourAgo = new Date(Date.now() - 3600_000)
            const [errRow, reqRow, running, failedJobs] = await Promise.all([
              db('nivaro_api_logs')
                .where('created_at', '>', hourAgo)
                .where('status', '>=', 500)
                .count('* as n')
                .first(),
              db('nivaro_api_logs').where('created_at', '>', hourAgo).count('* as n').first(),
              db('nivaro_job_runs').where('status', 'running').count('* as n').first(),
              db('nivaro_job_runs')
                .where('status', 'error')
                .where('started_at', '>', hourAgo)
                .count('* as n')
                .first()
            ])
            let dbOk = true
            try {
              await db.raw('SELECT 1')
            } catch {
              dbOk = false
            }
            let redisOk = false
            try {
              const redis = (app as unknown as { redis?: { ping: () => Promise<string> } }).redis
              if (redis) {
                await redis.ping()
                redisOk = true
              }
            } catch {
              redisOk = false
            }
            const { runtimeStats } = await import('../services/runtime-monitor.js')
            const { listInstances } = await import('../services/instance-roster.js')
            return {
              db_ok: dbOk,
              redis_ok: redisOk,
              errors_1h: Number((errRow as { n: number })?.n ?? 0),
              requests_1h: Number((reqRow as { n: number })?.n ?? 0),
              jobs_running: Number((running as { n: number })?.n ?? 0),
              jobs_failed_1h: Number((failedJobs as { n: number })?.n ?? 0),
              runtime: runtimeStats(),
              instances: (await listInstances()).length
            }
          }, null)
        : Promise.resolve(null),

      // Ticker seed: the last 25 business-collection writes with friendly text.
      // Live updates ride the pulse socket (admins) or this poll (everyone).
      safe(
        async () => {
          const rows = (await db('nivaro_activity as a')
            .leftJoin('nivaro_users as u', 'u.id', 'a.user')
            .whereNot('a.collection', 'like', 'nivaro\\_%')
            .whereIn('a.action', ['create', 'update', 'delete', 'pipeline-transition'])
            .orderBy('a.id', 'desc')
            .limit(25)
            .select(
              'a.id',
              'a.action',
              'a.collection',
              'a.item',
              'a.comment',
              'a.timestamp',
              db.raw(
                "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
              )
            )) as Array<Record<string, unknown>>
          const readable: Array<Record<string, unknown>> = []
          const checked = new Map<string, boolean>()
          for (const r of rows) {
            const col = String(r.collection ?? '')
            if (!checked.has(col)) checked.set(col, await can(req.user!, 'read', col))
            if (checked.get(col)) readable.push(r)
          }
          return readable
        },
        [] as Array<Record<string, unknown>>
      )
    ])

    return reply.send({ data: { flow, risk, people, throughput, health, activity } })
  })

  // ── Map geometry (slice 1: routes/command-center-place.ts → services/command-center/geo.ts)
  app.get('/geo', geoRoute)
  app.get('/people-geo', peopleGeoRoute)
}
