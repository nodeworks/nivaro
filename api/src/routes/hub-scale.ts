import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam } from '../services/hub/apps.js'
import { maxedRoles, scaleTick } from '../services/hub/scale/auto.js'
import { parseRoleChanges, planScale, ScaleError } from '../services/hub/scale/plan.js'
import { checkRule } from '../services/hub/scale/rules.js'
import { cancelScale, startScale } from '../services/hub/scale/run.js'
import { isRoleName } from '../services/hub/scale/shape.js'
import {
  isTargetKind,
  listRuns,
  readRun,
  resumeRule,
  setPinned,
  setRule,
  type TargetKind
} from '../services/hub/scale/store.js'
import { readTarget } from '../services/hub/scale/target.js'
import { scaleDetail, scaleOverview } from '../services/hub/scale/view.js'
import { registerReadinessCheck } from '../services/readiness.js'

/**
 * Nivaro Hub scaling (manual + automatic), mounted under /api/hub by hub.ts (HUB=on only). Every
 * route is for a Hub administrator; every write is logged (logActivity) and every change of a
 * stack is a scale run (services/hub/scale/run.ts) that holds the stack's lock.
 *
 *   GET  /scale                                    → every Docker stack, per role
 *   GET  /scale/targets/:kind/:id                  → one stack in detail (kind environment|shared)
 *   POST /scale/targets/:kind/:id/plan {roles}     → the plan (connection math, blockers, steps)
 *   POST /scale/targets/:kind/:id/runs {roles, plan_hash, confirm} → 202 {run_id}
 *   PUT  /scale/targets/:kind/:id/roles/:role {pinned?, auto?}     → pin / rule
 *   GET  /scale/runs?kind=&id=&limit= | /scale/runs/:id
 *   POST /scale/runs/:id/cancel                    → stops before its next step
 *   GET  /scale/db-servers | PUT /scale/db-servers/:id {max_connections}
 *
 * Job `hub-scale-tick` every minute (cron leader): resumes stopped runs, judges the rules.
 * Readiness `hub-scale-max`: a rule wanted more than its max three times in a day.
 */

const SERVERS = 'nivaro_hub_db_servers'

function refuse(reply: FastifyReply, status: number, code: string, message: string, extra = {}) {
  return reply.code(status).send({ statusCode: status, error: message, message, code, ...extra })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

function targetOf(req: FastifyRequest): { kind: TargetKind; id: number } | null {
  const p = req.params as { kind?: string; id?: string }
  const id = idParam(p.id)
  return isTargetKind(p.kind) && id !== null ? { kind: p.kind, id } : null
}

async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (e) {
    if (e instanceof ScaleError) {
      const plan = (e as ScaleError & { plan?: unknown }).plan
      return refuse(reply, e.statusCode, e.code, e.message, plan ? { plan } : {})
    }
    throw e
  }
}

export function hubScaleRoutes(app: FastifyInstance): void {
  app.get('/scale', { preHandler: requireAdmin }, async () => ({ data: await scaleOverview() }))

  app.get('/scale/targets/:kind/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const t = targetOf(req)
    const d = t ? await scaleDetail(t.kind, t.id) : null
    if (!d) return refuse(reply, 404, 'NOT_FOUND', 'No such stack.')
    return reply.send({ data: d })
  })

  app.post('/scale/targets/:kind/:id/plan', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const t = targetOf(req)
      const target = t ? await readTarget(t.kind, t.id) : null
      if (!target) return refuse(reply, 404, 'NOT_FOUND', 'No such stack.')
      const roles = parseRoleChanges(body(req).roles)
      if ('error' in roles) return refuse(reply, 400, 'BAD_ROLES', roles.error)
      return reply.send({ data: await planScale(target, roles, 'manual') })
    })
  )

  app.post('/scale/targets/:kind/:id/runs', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const t = targetOf(req)
      if (!t) return refuse(reply, 404, 'NOT_FOUND', 'No such stack.')
      const b = body(req)
      const roles = parseRoleChanges(b.roles)
      if ('error' in roles) return refuse(reply, 400, 'BAD_ROLES', roles.error)
      const started = await startScale(
        t.kind,
        t.id,
        {
          roles,
          plan_hash: typeof b.plan_hash === 'string' ? b.plan_hash : undefined,
          confirm: typeof b.confirm === 'string' ? b.confirm : undefined
        },
        { by: userId(req), source: 'manual' }
      )
      await logActivity({
        action: 'hub-scale-start',
        user: userId(req),
        collection: 'nivaro_hub_scale_runs',
        item: String(started.run_id),
        req,
        comment: JSON.stringify({ target: `${t.kind}:${t.id}`, roles })
      })
      return reply.code(202).send({ data: { run_id: started.run_id } })
    })
  )

  app.put(
    '/scale/targets/:kind/:id/roles/:role',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const t = targetOf(req)
      const role = (req.params as { role?: string }).role
      const target = t ? await readTarget(t.kind, t.id) : null
      if (!t || !target) return refuse(reply, 404, 'NOT_FOUND', 'No such stack.')
      if (!isRoleName(role) || !target.roles.some((r) => r.role === role))
        return refuse(reply, 404, 'NOT_FOUND', 'The stack runs no such role.')
      const b = body(req)
      const changed: string[] = []
      if (b.resume === true) {
        await resumeRule(t.kind, t.id, role, userId(req))
        changed.push('resume')
      }
      if (b.pinned !== undefined) {
        if (typeof b.pinned !== 'boolean')
          return refuse(reply, 400, 'BAD_PINNED', 'pinned is true or false.')
        await setPinned(t.kind, t.id, role, b.pinned, userId(req))
        changed.push('pinned')
      }
      if (b.auto !== undefined) {
        if (b.auto === null) await setRule(t.kind, t.id, role, null, userId(req))
        else {
          if (!['web', 'realtime', 'importer', 'exporter'].includes(role))
            return refuse(
              reply,
              400,
              'NOT_SCALABLE',
              `${role} keeps its replica count: it takes no autoscaling rule.`
            )
          if (target.sqlite)
            return refuse(
              reply,
              409,
              'SQLITE_ONE_PROCESS',
              'A SQLite database allows one writer process: this stack never scales out.'
            )
          const r = checkRule(b.auto, role)
          if (!r.ok) return refuse(reply, 400, 'BAD_RULE', r.error)
          await setRule(t.kind, t.id, role, r.rule, userId(req))
        }
        changed.push('auto')
      }
      if (!changed.length) return refuse(reply, 400, 'NOTHING', 'Send pinned, auto or resume.')
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: 'nivaro_hub_scale_roles',
        item: `${t.kind}:${t.id}:${role}`,
        req,
        changed_fields: changed
      })
      return reply.send({ data: await scaleDetail(t.kind, t.id) })
    }
  )

  app.get('/scale/runs', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { kind?: string; id?: string; limit?: string }
    const id = idParam(q.id)
    const limit = Number(q.limit)
    return {
      data: await listRuns(
        isTargetKind(q.kind) ? q.kind : null,
        id,
        Number.isInteger(limit) ? limit : 50
      )
    }
  })

  app.get('/scale/runs/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id?: string }).id)
    const r = id === null ? null : await readRun(id)
    if (!r) return refuse(reply, 404, 'NOT_FOUND', 'No such run.')
    return reply.send({ data: r })
  })

  app.post('/scale/runs/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id?: string }).id)
    const r = id === null ? null : await readRun(id)
    if (!r) return refuse(reply, 404, 'NOT_FOUND', 'No such run.')
    if (r.status !== 'running')
      return refuse(reply, 409, 'NOT_RUNNING', 'The run is not running any more.')
    const asked = await cancelScale(r.id)
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: 'nivaro_hub_scale_runs',
      item: String(r.id),
      req,
      changed_fields: ['cancel']
    })
    return reply.send({ data: { cancelling: asked } })
  })

  app.get('/scale/db-servers', { preHandler: requireAdmin }, async () => {
    if (!(await db.schema.hasTable(SERVERS))) return { data: [] }
    const rows = (await db(SERVERS).orderBy('name', 'asc').select('*')) as Array<
      Record<string, unknown>
    >
    return {
      data: rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        engine: String(r.engine),
        host: String(r.host),
        max_connections:
          r.max_connections == null || !Number.isFinite(Number(r.max_connections))
            ? null
            : Number(r.max_connections)
      }))
    }
  })

  app.put('/scale/db-servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id?: string }).id)
    const row = id === null ? null : await db(SERVERS).where({ id }).first('id')
    if (!row) return refuse(reply, 404, 'NOT_FOUND', 'No such database server.')
    const v = body(req).max_connections
    if (v !== null && !(typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000))
      return refuse(
        reply,
        400,
        'BAD_MAX_CONNECTIONS',
        'max_connections is a whole number from 1 to 1,000,000, or null.'
      )
    await db(SERVERS).where({ id }).update({ max_connections: v, updated_at: new Date() })
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: SERVERS,
      item: String(id),
      req,
      changed_fields: ['max_connections']
    })
    return reply.send({ data: { id, max_connections: v } })
  })

  registerReadinessCheck({
    id: 'hub-scale-max',
    label: 'Autoscaling has room',
    group: 'Hub',
    description:
      'No autoscaling rule of a Hub stack wanted more replicas than its max three or more times in the last 24 hours.',
    run: async () => {
      const maxed = await maxedRoles()
      if (!maxed.length) return { status: 'pass', detail: 'Every rule has room to scale out.' }
      return {
        status: 'warn',
        detail: `${maxed.length} role${maxed.length === 1 ? '' : 's'} kept hitting the rule's max: ${maxed
          .slice(0, 5)
          .map((m) => `${m.kind} ${m.id} ${m.role} (${m.hits}×)`)
          .join(', ')}.`,
        blockers: maxed.slice(0, 5).map((m) => `Raise the max of ${m.role} on ${m.kind} ${m.id}`)
      }
    }
  })

  if (app.cron) {
    app.cron.schedule(
      'hub-scale-tick',
      '* * * * *',
      async () => {
        const r = await scaleTick()
        // One stack's persistent error is logged; the job fails only when nothing could be judged.
        if (r.errors.length && r.errors.length >= Math.max(1, r.targets))
          throw new Error(`hub-scale-tick: ${r.errors.join('; ')}`)
        if (r.errors.length) app.log.warn(`hub-scale-tick: ${r.errors.join('; ')}`)
      },
      {
        quiet: true,
        idempotent: 'unsafe',
        description:
          'Every minute (Hub only) — resumes scale runs whose process stopped, then judges every autoscaling rule of a Hub Docker stack (figures read live over its link) and starts a change as a scale run when one is due. Paused during moves, upgrades, promotions, freezes and incidents.'
      }
    )
  }
}
