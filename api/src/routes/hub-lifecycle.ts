import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from '../services/activity.js'
import { hubRequireAdmin, hubRequireAuth } from '../services/hub/api/gate.js'
import { idParam } from '../services/hub/apps.js'
import { CloneError, captureClone, listClones } from '../services/hub/lifecycle/clone.js'
import { planLines, RetireError, retirePlan } from '../services/hub/lifecycle/retire-plan.js'
import {
  cancelRetirement,
  logRetireAction,
  openRetirement,
  resumeRetirement,
  retireTick,
  startStep,
  undoLastStep
} from '../services/hub/lifecycle/retire-run.js'
import {
  healStale,
  listRetirements,
  nextStep,
  type Retirement,
  readRetirement,
  undoableStep
} from '../services/hub/lifecycle/retire-store.js'
import { hubModeEnabled } from '../services/hub/mode.js'

/**
 * Hub app lifecycle (mounted under /api/hub, hub mode only): app cloning (enhancement 46) and
 * the retirement wizard (enhancement 47).
 *
 *   GET  /lifecycle/clones                    admin: recent structure copies (→ library templates)
 *   POST /environments/:envId/clone           admin: copy an environment's app structure into the
 *                                             template library (then Create app installs it)
 *   GET  /retirements                         retirements the caller may see (owners: their apps)
 *   GET  /retirements/:id                     one retirement, step by step (heals a stopped run)
 *   POST /apps/:id/retire/plan                admin: what retiring the app would do, what blocks it
 *   POST /apps/:id/retire                     admin: open a retirement on that plan {plan_hash, notice?}
 *   POST /retirements/:id/steps/:step         admin: sign off and start the next step
 *   POST /retirements/:id/undo                admin: undo the last reversible step
 *   POST /retirements/:id/cancel              admin: undo every reversible step and close it
 *   POST /retirements/:id/resume              admin: continue a step whose process stopped
 *
 * Reads: administrators every app, an app's owners their own (anything else answers 404). Every
 * write is admin-only and logged; the steps' own gates are in services/hub/lifecycle/retire-run.ts.
 */

type Body = Record<string, unknown>

const body = (req: FastifyRequest): Body => {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function fail(reply: FastifyReply, status: number, code: string, error: string, extra = {}) {
  return reply.code(status).send({ error, code, ...extra })
}

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')
const userId = (req: FastifyRequest) => (req.user?.id ? String(req.user.id) : null)

function refusal(reply: FastifyReply, err: unknown) {
  if (err instanceof RetireError) return fail(reply, err.status, err.code, err.message, err.extra)
  if (err instanceof CloneError) return fail(reply, err.status, err.code, err.message)
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null
  const status = Number(e?.status)
  if (e && typeof e.code === 'string' && Number.isInteger(status) && status >= 400 && status < 600)
    return fail(reply, status, e.code, String(e.message ?? e.code))
  throw err
}

/** The apps the caller may read: null = every app (admin). */
async function readableAppIds(req: FastifyRequest): Promise<number[] | null> {
  if (req.isAdmin) return null
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: String(req.user?.id ?? '') })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

/** A retirement with what a person may do next (the wizard reads only this). */
function view(r: Retirement) {
  const next = r.status === 'open' ? nextStep(r) : null
  const undo = r.status === 'open' || r.status === 'interrupted' ? undoableStep(r) : null
  const { runner: _runner, ...rest } = r
  return {
    ...rest,
    lines: r.plan ? planLines(r.plan) : null,
    next_step: next?.key ?? null,
    undo_step: undo?.key ?? null,
    cancellable:
      (r.status === 'open' || r.status === 'interrupted') &&
      r.steps.every((s) =>
        s.key === 'remove' || s.key === 'archive' ? s.state === 'pending' && !s.signed_off_at : true
      )
  }
}

export async function hubLifecycleRoutes(app: FastifyInstance): Promise<void> {
  if (!hubModeEnabled()) return

  if (app.cron) {
    app.cron.schedule(
      'hub-lifecycle-tick',
      '*/2 * * * *',
      async () => {
        const r = await retireTick()
        if (r.healed.length)
          app.log.warn(
            `hub-lifecycle-tick: ${r.healed.length} retirement steps stopped (interrupted)`
          )
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every 2 minutes (Hub only) — marks a retirement step whose Hub process stopped as interrupted (nivaro_hub_retirements) and tells the app’s people, so someone resumes it.'
      }
    )
  }

  // ─── Cloning ──────────────────────────────────────────────────────────────────────────────

  app.get('/lifecycle/clones', { preHandler: hubRequireAdmin }, async () => ({
    data: await listClones()
  }))

  app.post('/environments/:envId/clone', { preHandler: hubRequireAdmin }, async (req, reply) => {
    const envId = idParam((req.params as { envId: string }).envId)
    if (envId === null) return notFound(reply)
    try {
      const out = await captureClone(envId, userId(req))
      await logActivity({
        action: 'hub-clone-capture',
        user: userId(req),
        collection: 'nivaro_hub_clones',
        item: String(out.clone.id),
        comment:
          `Structure of ${out.clone.source?.app_key ?? '?'} · ${out.clone.source?.env_key ?? '?'} → template ${out.template.name} ${out.template.version}; ${out.clone.scrubbed_count} credential values emptied at the source`.slice(
            0,
            400
          ),
        req
      })
      return reply.code(201).send({ data: out })
    } catch (err) {
      return refusal(reply, err)
    }
  })

  // ─── Retirements ──────────────────────────────────────────────────────────────────────────

  app.get('/retirements', { preHandler: hubRequireAuth }, async (req) => {
    await healStale().catch(() => [])
    const ids = await readableAppIds(req)
    const rows = await listRetirements({ appIds: ids })
    return { data: rows.map(view) }
  })

  app.get('/retirements/:id', { preHandler: hubRequireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    await healStale().catch(() => [])
    const r = await readRetirement(id)
    if (!r) return notFound(reply)
    const ids = await readableAppIds(req)
    if (ids && !ids.includes(r.app_id)) return notFound(reply)
    return { data: view(r) }
  })

  app.post('/apps/:id/retire/plan', { preHandler: hubRequireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    try {
      return { data: await retirePlan(id) }
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.post('/apps/:id/retire', { preHandler: hubRequireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    try {
      const r = await openRetirement(id, body(req), userId(req))
      await logRetireAction({ action: 'hub-retire-open', by: userId(req), r, req })
      return reply.code(201).send({ data: view(r) })
    } catch (err) {
      return refusal(reply, err)
    }
  })

  const retirementAction =
    (
      action: string,
      run: (id: number, req: FastifyRequest) => Promise<Retirement>,
      comment: (r: Retirement) => string
    ) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const id = idParam((req.params as { id: string }).id)
      if (id === null) return notFound(reply)
      try {
        const r = await run(id, req)
        await logRetireAction({ action, by: userId(req), r, comment: comment(r), req })
        return reply.code(202).send({ data: view(r) })
      } catch (err) {
        return refusal(reply, err)
      }
    }

  app.post('/retirements/:id/steps/:step', { preHandler: hubRequireAdmin }, async (req, reply) => {
    const p = req.params as { id: string; step: string }
    const id = idParam(p.id)
    if (id === null) return notFound(reply)
    try {
      const r = await startStep(id, p.step, body(req), userId(req))
      await logRetireAction({
        action: 'hub-retire-step',
        by: userId(req),
        r,
        comment: `${r.plan?.app.key ?? r.app_id}: ${p.step} signed off`,
        req
      })
      return reply.code(202).send({ data: view(r) })
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.post(
    '/retirements/:id/undo',
    { preHandler: hubRequireAdmin },
    retirementAction(
      'hub-retire-undo',
      (id, req) => undoLastStep(id, userId(req)),
      (r) => `${r.plan?.app.key ?? r.app_id}: undo ${String(r.step ?? '').replace('undo:', '')}`
    )
  )
  app.post(
    '/retirements/:id/cancel',
    { preHandler: hubRequireAdmin },
    retirementAction(
      'hub-retire-cancel',
      (id, req) =>
        cancelRetirement(
          id,
          userId(req),
          {},
          typeof body(req).reason === 'string' ? (body(req).reason as string) : null
        ),
      (r) => `${r.plan?.app.key ?? r.app_id}: cancelled`
    )
  )
  app.post(
    '/retirements/:id/resume',
    { preHandler: hubRequireAdmin },
    retirementAction(
      'hub-retire-resume',
      (id, req) => resumeRetirement(id, userId(req)),
      (r) => `${r.plan?.app.key ?? r.app_id}: resume ${String(r.step ?? '')}`
    )
  )
}
