import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner, listEnvironments, readApp } from '../services/hub/apps.js'
import { gatherPlanInput, PromotionError } from '../services/hub/promote-gather.js'
import { buildPromotionPlan } from '../services/hub/promote-plan.js'
import {
  deleteRule,
  listWatches,
  RULES,
  readRule,
  ruleFromRow,
  saveRule,
  validateRule
} from '../services/hub/releases/auto-rollback.js'
import {
  activeWindow,
  FREEZES,
  freezeRefusal,
  listFreezes,
  nextWindow,
  validateFreeze
} from '../services/hub/releases/freeze.js'
import {
  previewReleaseNotes,
  readReleaseNotes,
  recordReleaseNotes
} from '../services/hub/releases/notes.js'
import { personNames } from '../services/hub/releases/person.js'
import {
  cancelSchedule,
  createSchedule,
  listSchedules,
  readSchedule,
  SCHEDULES,
  validateWhen
} from '../services/hub/releases/schedules.js'
import { releaseOpsTick, rollbackTick } from '../services/hub/releases/tick.js'
import {
  abortTrain,
  advanceTrain,
  createTrain,
  listTrains,
  readTrain,
  skipStep,
  TRAINS,
  TrainActionError,
  validateTrain
} from '../services/hub/releases/trains.js'

/**
 * Hub release operations (mounted under /api/hub by hubRoutes, hub mode only): release trains,
 * scheduled promotions, freeze windows, automatic rollback rules and release notes.
 *
 * Reads: admins see everything, an app's owners see their apps (an app or environment they do
 * not own answers 404). Every write is admin-only and logged (logActivity). A train step, a
 * scheduled start and an automatic rollback are normal promotion runs: the move-open guard,
 * the environment lock and freeze windows apply to them as to a person's own promotion.
 */

type Body = Record<string, unknown>

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function fail(reply: FastifyReply, status: number, code: string, error: string, extra = {}) {
  return reply.code(status).send({ error, code, ...extra })
}

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')
const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function personName(req: FastifyRequest): string {
  const u = req.user as
    | { first_name?: string | null; last_name?: string | null; email?: string }
    | undefined
  const full = [u?.first_name, u?.last_name]
    .filter((x) => x?.trim())
    .join(' ')
    .trim()
  return full || u?.email || 'an administrator'
}

/** The apps the caller may read: null = every app (admin). */
async function readableAppIds(req: FastifyRequest): Promise<number[] | null> {
  if (req.isAdmin) return null
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: userId(req) })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

async function canReadApp(req: FastifyRequest, appId: number): Promise<boolean> {
  return !!req.isAdmin || (await isAppOwner(appId, userId(req)))
}

async function readableEnv(req: FastifyRequest) {
  const id = idParam((req.params as { envId?: string }).envId)
  if (id === null) return null
  const row = (await db('nivaro_hub_environments').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!row || !(await canReadApp(req, Number(row.app_id)))) return null
  return row
}

const isoWindow = (w: { start: number; end: number } | null) =>
  w ? { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() } : null

function kindOf(v: unknown): 'promote' | 'rollback' | null {
  return v === 'promote' || v === 'rollback' ? v : null
}

function refusal(reply: FastifyReply, err: unknown) {
  if (err instanceof TrainActionError) return fail(reply, err.status, err.code, err.message)
  if (err instanceof PromotionError) return fail(reply, err.status, err.code, err.message)
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null
  if (e && typeof e.code === 'string' && typeof e.status === 'number')
    return fail(reply, e.status, e.code, String(e.message ?? e.code))
  throw err
}

export function hubReleaseRoutes(app: FastifyInstance): void {
  if (app.cron) {
    // Rollback watches first and on their own: never judged late behind GitLab-bound starts.
    app.cron.schedule(
      'hub-release-rollback',
      '* * * * *',
      async () => {
        const r = await rollbackTick()
        if (r.errors.length) throw new Error(`hub-release-rollback: ${r.errors.join('; ')}`)
      },
      {
        quiet: true,
        idempotent: 'unsafe',
        description:
          'Every minute (Hub only) — opens and judges automatic rollback watches after promotions (nivaro_hub_rollback_watches); a breach rolls the environment back through the normal rollback path and tells its owners. A missed tick is picked up by the next.'
      }
    )
    app.cron.schedule(
      'hub-release-ops',
      '* * * * *',
      async () => {
        const r = await releaseOpsTick()
        if (r.errors.length) throw new Error(`hub-release-ops: ${r.errors.join('; ')}`)
      },
      {
        quiet: true,
        idempotent: 'unsafe',
        description:
          'Every minute (Hub only) — starts due scheduled promotions and release trains and moves running trains through their holds. Every step is a normal Hub promotion run; state lives in nivaro_hub_trains / _schedules, so a missed tick is picked up by the next.'
      }
    )
  }

  // ─── Overview (the Releases tab) ───────────────────────────────────────────

  app.get('/releases/overview', { preHandler: requireAuth }, async (req) => {
    const ids = await readableAppIds(req)
    const appsQ = db('nivaro_hub_apps').orderBy('key', 'asc').select('id', 'key', 'name')
    if (ids) appsQ.whereIn('id', ids.length ? ids : [-1])
    const apps = (await appsQ) as Array<{ id: number; key: string; name: string }>
    const envs = (
      await Promise.all(
        apps.map(async (a) =>
          (
            await listEnvironments(Number(a.id))
          ).map((e) => ({
            id: e.id,
            app_id: e.app_id,
            key: e.key,
            position: e.position,
            on_shared: e.on_shared === true,
            linked: e.hub_token != null,
            placed: e.placement_id != null
          }))
        )
      )
    ).flat()
    const appIds = apps.map((a) => Number(a.id))
    const now = Date.now()
    const freezes = (await listFreezes())
      .filter((f) => f.app_id == null || appIds.includes(f.app_id))
      .map((f) => ({
        ...f,
        active: isoWindow(activeWindow(f, now)),
        next: isoWindow(nextWindow(f, now))
      }))
    const rules = (
      (await db(RULES).whereIn(
        'environment_id',
        envs.length ? envs.map((e) => e.id) : [-1]
      )) as Array<Record<string, unknown>>
    ).map(ruleFromRow)
    const [trains, schedules] = await Promise.all([
      listTrains({ appIds }),
      listSchedules({ appIds })
    ])
    // Who set each one up (an unattended run acts for them; the page names them).
    const names = await personNames([
      ...trains.map((t) => t.started_by),
      ...schedules.map((s) => s.created_by)
    ])
    const nameOf = (id: string | null) => (id ? (names.get(id.toLowerCase()) ?? null) : null)
    return {
      data: {
        apps: apps.map((a) => ({ id: Number(a.id), key: String(a.key), name: String(a.name) })),
        environments: envs,
        trains: trains.map((t) => ({ ...t, started_by_name: nameOf(t.started_by) })),
        schedules: schedules.map((s) => ({ ...s, created_by_name: nameOf(s.created_by) })),
        freezes,
        rules,
        watches: await listWatches({ appIds, limit: 50 }),
        now: new Date(now).toISOString()
      }
    }
  })

  // ─── Release trains ────────────────────────────────────────────────────────

  async function trainInput(appId: number, b: Body) {
    const envs = await listEnvironments(appId)
    return validateTrain(
      b,
      envs.map((e) => ({ id: e.id, key: e.key, position: e.position, on_shared: e.on_shared }))
    )
  }

  // A read: what the train would do, the first step's plan and a freeze on now.
  app.post('/apps/:id/trains/check', { preHandler: requireAuth }, async (req, reply) => {
    const appId = idParam((req.params as { id: string }).id)
    if (appId === null || !(await readApp(appId)) || !(await canReadApp(req, appId)))
      return notFound(reply)
    const input = await trainInput(appId, body(req))
    if ('error' in input) return fail(reply, 400, 'BAD_TRAIN', input.error)
    const freeze = await freezeRefusal({ appIds: [appId], action: 'promote' })
    let first: { ok: boolean; blockers: Array<{ code: string; text: string }> } | null = null
    try {
      const plan = buildPromotionPlan(
        await gatherPlanInput(input.steps[0].environment_id, {
          kind: 'promote',
          version: input.version
        })
      )
      first = { ok: plan.ok, blockers: plan.blockers }
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown }
      first = {
        ok: false,
        blockers: [
          { code: String(e?.code ?? 'FAILED'), text: String(e?.message ?? 'Could not plan') }
        ]
      }
    }
    return {
      data: {
        version: input.version,
        steps: input.steps.map((s, i) => ({ ...s, key: input.keys[i] })),
        freeze,
        first
      }
    }
  })

  app.post('/apps/:id/trains', { preHandler: requireAdmin }, async (req, reply) => {
    const appId = idParam((req.params as { id: string }).id)
    const found = appId === null ? null : await readApp(appId)
    if (!found || appId === null) return notFound(reply)
    const b = body(req)
    if (typeof b.confirm !== 'string' || b.confirm.trim() !== found.key)
      return fail(reply, 400, 'CONFIRM_REQUIRED', `Type ${found.key} to confirm`)
    const input = await trainInput(appId, b)
    if ('error' in input) return fail(reply, 400, 'BAD_TRAIN', input.error)
    try {
      const t = await createTrain(appId, input, { userId: userId(req) })
      await logActivity({
        action: 'hub-train-start',
        user: userId(req),
        collection: TRAINS,
        item: String(t.id),
        comment: `${found.key} ${input.version}: ${input.keys.join(' → ')}`,
        req
      })
      // The first step starts now (the tick moves it on from there).
      const moved = (await advanceTrain(t.id).catch(() => null)) ?? t
      return reply.code(201).send({ data: moved })
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.get('/trains/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const t = id === null ? null : await readTrain(id)
    if (!t || !(await canReadApp(req, t.app_id))) return notFound(reply)
    return { data: t }
  })

  app.post('/trains/:id/skip', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    const step = Number(body(req).step)
    if (!Number.isInteger(step) || step < 0)
      return fail(reply, 400, 'BAD_STEP', 'step is the step index')
    try {
      await skipStep(id, step, personName(req))
      await logActivity({
        action: 'hub-train-skip',
        user: userId(req),
        collection: TRAINS,
        item: String(id),
        comment: `step ${step + 1}`,
        req
      })
      return { data: (await advanceTrain(id).catch(() => null)) ?? (await readTrain(id)) }
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.post('/trains/:id/abort', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    try {
      const t = await abortTrain(id, personName(req))
      await logActivity({
        action: 'hub-train-abort',
        user: userId(req),
        collection: TRAINS,
        item: String(id),
        req
      })
      return { data: t }
    } catch (err) {
      return refusal(reply, err)
    }
  })

  // ─── Scheduled promotions ──────────────────────────────────────────────────

  app.post('/schedules', { preHandler: requireAdmin }, async (req, reply) => {
    const b = body(req)
    const kind = b.kind === 'train' ? 'train' : b.kind === 'promote' ? 'promote' : null
    if (!kind) return fail(reply, 400, 'BAD_KIND', 'kind is promote or train')
    const when = validateWhen(b)
    if ('error' in when) return fail(reply, 400, 'BAD_SCHEDULE', when.error)
    const appId = idParam(b.app_id)
    const found = appId === null ? null : await readApp(appId)
    if (!found || appId === null) return fail(reply, 400, 'BAD_SCHEDULE', 'app_id names no app')
    let envId: number | null = null
    let train: Awaited<ReturnType<typeof trainInput>> | null = null
    let version = typeof b.version === 'string' ? b.version.trim() : ''
    if (kind === 'promote') {
      envId = idParam(b.environment_id)
      const env =
        envId === null ? undefined : (await listEnvironments(appId)).find((e) => e.id === envId)
      if (!env)
        return fail(
          reply,
          400,
          'BAD_SCHEDULE',
          'environment_id names none of the app’s environments'
        )
      if (env.on_shared)
        return fail(
          reply,
          400,
          'BAD_SCHEDULE',
          `${env.key} runs on a shared deployment: upgrade the deployment instead`
        )
      if (!/^\d+\.\d+\.\d+$/.test(version))
        return fail(reply, 400, 'BAD_SCHEDULE', 'version is x.y.z')
      if (typeof b.confirm !== 'string' || b.confirm.trim() !== env.key)
        return fail(reply, 400, 'CONFIRM_REQUIRED', `Type ${env.key} to confirm`)
    } else {
      train = await trainInput(appId, b)
      if ('error' in train) return fail(reply, 400, 'BAD_TRAIN', train.error)
      version = train.version
      if (typeof b.confirm !== 'string' || b.confirm.trim() !== found.key)
        return fail(reply, 400, 'CONFIRM_REQUIRED', `Type ${found.key} to confirm`)
    }
    const s = await createSchedule({
      app_id: appId,
      environment_id: envId,
      kind,
      version,
      run_at: when.run_at,
      on_freeze: when.on_freeze,
      train: train && !('error' in train) ? train : null,
      created_by: userId(req)
    })
    await logActivity({
      action: 'hub-schedule-create',
      user: userId(req),
      collection: SCHEDULES,
      item: String(s.id),
      comment: `${found.key} ${kind} ${version} at ${s.run_at}`,
      req
    })
    return reply.code(201).send({ data: s })
  })

  app.post('/schedules/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await readSchedule(id))) return notFound(reply)
    if (!(await cancelSchedule(id)))
      return fail(reply, 409, 'NOT_CANCELLABLE', 'It already started, failed or was cancelled')
    await logActivity({
      action: 'hub-schedule-cancel',
      user: userId(req),
      collection: SCHEDULES,
      item: String(id),
      req
    })
    return { data: await readSchedule(id) }
  })

  // ─── Freeze windows ────────────────────────────────────────────────────────

  app.post('/freezes', { preHandler: requireAdmin }, async (req, reply) => {
    const v = validateFreeze(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_FREEZE', v.error)
    if (v.app_id != null && !(await readApp(v.app_id)))
      return fail(reply, 400, 'BAD_FREEZE', 'app_id names no app')
    const { insertReturningId } = await import('../db/dialect/ef.js')
    const id = Number(
      await insertReturningId(db, FREEZES, {
        ...v,
        created_by: userId(req),
        created_at: new Date(),
        updated_at: new Date()
      })
    )
    await logActivity({
      action: 'hub-freeze-create',
      user: userId(req),
      collection: FREEZES,
      item: String(id),
      comment: v.name,
      req
    })
    return reply.code(201).send({ data: (await listFreezes()).find((f) => f.id === id) })
  })

  app.patch('/freezes/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await db(FREEZES).where({ id }).first('id'))) return notFound(reply)
    const v = validateFreeze(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_FREEZE', v.error)
    if (v.app_id != null && !(await readApp(v.app_id)))
      return fail(reply, 400, 'BAD_FREEZE', 'app_id names no app')
    await db(FREEZES)
      .where({ id })
      .update({ ...v, updated_at: new Date() })
    await logActivity({
      action: 'hub-freeze-update',
      user: userId(req),
      collection: FREEZES,
      item: String(id),
      comment: v.name,
      req
    })
    return { data: (await listFreezes()).find((f) => f.id === id) }
  })

  app.delete('/freezes/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    if (!(await db(FREEZES).where({ id }).delete())) return notFound(reply)
    await logActivity({
      action: 'hub-freeze-delete',
      user: userId(req),
      collection: FREEZES,
      item: String(id),
      req
    })
    return { data: { id } }
  })

  // The freeze on now for one environment's app (the Promote panel's banner).
  app.get('/environments/:envId/freeze', { preHandler: requireAuth }, async (req, reply) => {
    const env = await readableEnv(req)
    if (!env) return notFound(reply)
    return { data: await freezeRefusal({ appIds: [Number(env.app_id)], action: 'promote' }) }
  })

  // ─── Automatic rollback rules ──────────────────────────────────────────────

  app.get('/environments/:envId/rollback-rule', { preHandler: requireAuth }, async (req, reply) => {
    const env = await readableEnv(req)
    if (!env) return notFound(reply)
    return {
      data: {
        rule: await readRule(Number(env.id)),
        watches: await listWatches({ envId: Number(env.id), limit: 20 })
      }
    }
  })

  app.put(
    '/environments/:envId/rollback-rule',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const env = await readableEnv(req)
      if (!env) return notFound(reply)
      const v = validateRule(body(req))
      if ('error' in v) return fail(reply, 400, 'BAD_RULE', v.error)
      const rule = await saveRule(Number(env.id), v, userId(req))
      await logActivity({
        action: 'hub-rollback-rule-save',
        user: userId(req),
        collection: RULES,
        item: String(env.id),
        req
      })
      return { data: rule }
    }
  )

  app.delete(
    '/environments/:envId/rollback-rule',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const env = await readableEnv(req)
      if (!env) return notFound(reply)
      if (!(await deleteRule(Number(env.id)))) return notFound(reply)
      await logActivity({
        action: 'hub-rollback-rule-delete',
        user: userId(req),
        collection: RULES,
        item: String(env.id),
        req
      })
      return { data: { environment_id: Number(env.id) } }
    }
  )

  // ─── Release notes ─────────────────────────────────────────────────────────

  // A read: what a promotion or rollback of this version would change (GitLab read-only).
  app.post(
    '/environments/:envId/release-notes',
    { preHandler: requireAuth },
    async (req, reply) => {
      const env = await readableEnv(req)
      if (!env) return notFound(reply)
      const b = body(req)
      const kind = kindOf(b.kind)
      const version = typeof b.version === 'string' ? b.version.trim() : ''
      if (!kind || !/^\d+\.\d+\.\d+$/.test(version))
        return fail(reply, 400, 'BAD_INPUT', 'kind is promote or rollback, version is x.y.z')
      try {
        return { data: await previewReleaseNotes(Number(env.id), kind, version) }
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  async function readableDeploy(req: FastifyRequest) {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return null
    const row = (await db('nivaro_hub_deploys').where({ id }).first('id', 'app_id', 'kind')) as
      | { id: number; app_id: number; kind: string }
      | undefined
    if (!row || !(await canReadApp(req, Number(row.app_id)))) return null
    return row
  }

  app.get('/deploys/:id/release-notes', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableDeploy(req)
    if (!row) return notFound(reply)
    return { data: await readReleaseNotes(Number(row.id)) }
  })

  // Works out and stores the notes of a run that has none (an older run, or GitLab was down).
  app.post('/deploys/:id/release-notes', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableDeploy(req)
    if (!row) return notFound(reply)
    if (row.kind !== 'promote' && row.kind !== 'rollback')
      return fail(reply, 409, 'NOT_A_PROMOTION', 'Only promotions and rollbacks have release notes')
    const stored =
      (await readReleaseNotes(Number(row.id))) ?? (await recordReleaseNotes(Number(row.id)))
    return { data: stored }
  })
}
