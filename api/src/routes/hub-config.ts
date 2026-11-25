import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam } from '../services/hub/apps.js'
import {
  OutsideWindowError,
  outsideWindowOf,
  ownSession
} from '../services/hub/changes/emergency.js'
import {
  applyPromotion,
  applyUndo,
  getPromotion,
  listPromotions,
  planPromotion,
  previewUndo,
  promotionGroups,
  reconcilePromotion
} from '../services/hub/config/promotions.js'
import { ConfigPromotionError, PROMOTIONS } from '../services/hub/config/types.js'

/**
 * Nivaro Hub config promotion (idea 30), mounted under /api/hub by hub.ts (HUB=on only). Every
 * route is a Hub administrator's (the Hub credential gate swaps requireAdmin for its own: API keys
 * need hub:read / hub:write, connected apps and View-as only read and plan). Every write is logged
 * (collection nivaro_hub_config_promotions, the promotion id).
 *
 *   GET  /config/groups                               what can be promoted, as groups of tables
 *   GET  /apps/:id/config-promotions                  newest 50 for the app (heals stuck rows)
 *   POST /apps/:id/config-promotions/plan             {source_env_id, target_env_id, groups[],
 *                                                     deletes?, allow_cascade?} → the plan
 *   GET  /config-promotions/:id                       one promotion with its plan
 *   POST /config-promotions/:id/apply                 {plan_hash, confirm?, overwrite_prod_changes?,
 *                                                     checklist_run_id?, outside_window_reason?}
 *   POST /config-promotions/:id/check                 ask the target what it did (a lost answer)
 *   POST /config-promotions/:id/undo/plan             the undo's preview (its own hash)
 *   POST /config-promotions/:id/undo                  {plan_hash, confirm, overwrite_prod_changes?}
 *                                                     — an administrator on their own session only
 *
 * Refusals are {statusCode, error, message, code} (+ items/lines/preview/freeze when the code
 * has them).
 */

function refuse(reply: FastifyReply, status: number, code: string, message: string, extra = {}) {
  return reply.code(status).send({ statusCode: status, error: message, message, code, ...extra })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '') || null

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

function actorOf(req: FastifyRequest): string | null {
  const u = req.user as { email?: unknown; first_name?: unknown; last_name?: unknown } | undefined
  const name = [u?.first_name, u?.last_name].filter((s) => typeof s === 'string' && s).join(' ')
  const email = typeof u?.email === 'string' ? u.email : ''
  return (name || email || '').slice(0, 120) || null
}

async function guarded(
  reply: FastifyReply,
  fn: () => Promise<unknown>,
  failed?: (e: ConfigPromotionError) => Promise<void>
) {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ConfigPromotionError) {
      if (failed) await failed(e).catch(() => {})
      return refuse(reply, e.status, e.code, e.message, e.extra ?? {})
    }
    throw e
  }
}

async function log(req: FastifyRequest, action: string, id: number, comment: string) {
  await logActivity({
    action,
    user: userId(req),
    collection: PROMOTIONS,
    item: String(id),
    comment,
    req
  })
}

export function hubConfigRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAdmin }

  app.get('/config/groups', admin, async () => ({ data: promotionGroups() }))

  app.get<{ Params: { id: string } }>('/apps/:id/config-promotions', admin, async (req, reply) => {
    const id = idParam(req.params.id)
    if (!id) return refuse(reply, 404, 'NOT_FOUND', 'No such app')
    return { data: await listPromotions(id) }
  })

  app.post<{ Params: { id: string } }>(
    '/apps/:id/config-promotions/plan',
    admin,
    async (req, reply) => {
      const id = idParam(req.params.id)
      if (!id) return refuse(reply, 404, 'NOT_FOUND', 'No such app')
      const b = body(req)
      const src = idParam(b.source_env_id)
      const dst = idParam(b.target_env_id)
      if (!src || !dst)
        return refuse(
          reply,
          400,
          'BAD_ENVIRONMENTS',
          'source_env_id and target_env_id are required'
        )
      return guarded(reply, async () => {
        const p = await planPromotion({
          appId: id,
          sourceEnvId: src,
          targetEnvId: dst,
          groups: b.groups,
          deletes: b.deletes === true,
          allowCascade: b.allow_cascade === true,
          userId: userId(req)
        })
        const t = p.plan?.totals
        await log(
          req,
          'hub-config-promote-plan',
          p.id,
          `environment ${src} → ${dst}: ${p.groups.join(', ')} (${t?.inserts ?? 0} add, ${t?.updates ?? 0} change, ${t?.deletes ?? 0} remove)`
        )
        return reply.code(201).send({ data: p })
      })
    }
  )

  app.get<{ Params: { id: string } }>('/config-promotions/:id', admin, async (req, reply) => {
    const id = idParam(req.params.id)
    const p = id ? await getPromotion(id) : null
    if (!p) return refuse(reply, 404, 'NOT_FOUND', 'No such config promotion')
    return { data: p }
  })

  app.post<{ Params: { id: string } }>(
    '/config-promotions/:id/apply',
    admin,
    async (req, reply) => {
      const id = idParam(req.params.id)
      if (!id) return refuse(reply, 404, 'NOT_FOUND', 'No such config promotion')
      const b = body(req)
      let outside: { reason: string } | null
      try {
        outside = outsideWindowOf(req, b)
      } catch (e) {
        if (e instanceof OutsideWindowError) return refuse(reply, e.status, e.code, e.message)
        throw e
      }
      return guarded(
        reply,
        async () => {
          const p = await applyPromotion({
            id,
            planHash: b.plan_hash,
            confirm: b.confirm,
            overwriteProdChanges: b.overwrite_prod_changes === true,
            userId: userId(req),
            actor: actorOf(req),
            checklistRunId: b.checklist_run_id,
            outsideWindow: outside
          })
          const t = (p.result as { totals?: Record<string, number> } | null)?.totals
          await log(
            req,
            'hub-config-promote',
            id,
            `applied to environment ${p.target_environment_id}: ${t?.inserted ?? 0} added, ${t?.updated ?? 0} changed, ${t?.deleted ?? 0} removed${b.overwrite_prod_changes === true ? ' (overwrote changes made there)' : ''}${outside ? ` — outside the deploy window: ${outside.reason}` : ''}`
          )
          return { data: p }
        },
        (e) => log(req, 'hub-config-promote-refused', id, `${e.code}: ${e.message}`.slice(0, 500))
      )
    }
  )

  app.post<{ Params: { id: string } }>(
    '/config-promotions/:id/check',
    admin,
    async (req, reply) => {
      const id = idParam(req.params.id)
      if (!id) return refuse(reply, 404, 'NOT_FOUND', 'No such config promotion')
      return guarded(reply, async () => {
        const p = await reconcilePromotion(id)
        await log(req, 'hub-config-promote-check', id, `the target says: ${p.status}`)
        return { data: p }
      })
    }
  )

  app.post<{ Params: { id: string } }>(
    '/config-promotions/:id/undo/plan',
    admin,
    async (req, reply) => {
      const id = idParam(req.params.id)
      if (!id) return refuse(reply, 404, 'NOT_FOUND', 'No such config promotion')
      return guarded(reply, async () => ({ data: await previewUndo(id) }))
    }
  )

  app.post<{ Params: { id: string } }>('/config-promotions/:id/undo', admin, async (req, reply) => {
    const id = idParam(req.params.id)
    if (!id) return refuse(reply, 404, 'NOT_FOUND', 'No such config promotion')
    const b = body(req)
    // An undo writes to the target even inside a freeze: an administrator on their own session.
    if (req.isAdmin !== true || !ownSession(req))
      return refuse(
        reply,
        403,
        'UNDO_ADMIN_SESSION_ONLY',
        'Only a Hub administrator on their own session may undo a config promotion.'
      )
    return guarded(
      reply,
      async () => {
        const p = await applyUndo({
          id,
          planHash: b.plan_hash,
          confirm: b.confirm,
          overwriteProdChanges: b.overwrite_prod_changes === true,
          userId: userId(req)
        })
        await log(req, 'hub-config-undo', id, `undone on environment ${p.target_environment_id}`)
        return { data: p }
      },
      (e) => log(req, 'hub-config-undo-refused', id, `${e.code}: ${e.message}`.slice(0, 500))
    )
  })
}
