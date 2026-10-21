import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  checklistsReady,
  dismissFirstWeek,
  draftChecklist,
  firstWeekFor,
  getChecklist,
  listChecklists,
  markOpened,
  normalizeSteps,
  publishChecklist,
  roleContext,
  saveDraft,
  unpublishChecklist
} from '../services/role-checklist.js'

// #2472 — first-week checklists per role. Admins draft (AI), edit and publish
// under /role-checklists; a new person reads the published one for their role
// under /my-work/first-week. Nothing reaches people unreviewed.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function notReady(reply: FastifyReply) {
  return reply
    .code(409)
    .send({ error: 'The checklist tables do not exist yet — run migration 472.' })
}

function statusOf(err: unknown): number {
  const s = (err as { statusCode?: number }).statusCode
  return typeof s === 'number' && s >= 400 && s < 600 ? s : 500
}

export async function roleChecklistRoutes(app: FastifyInstance) {
  // Every non-admin role with its checklist state, for the admin tab.
  app.get('/role-checklists', { preHandler: requireAdmin }, async () => {
    const roles = (await db('nivaro_roles')
      .where(function () {
        this.where('admin_access', false).orWhereNull('admin_access')
      })
      .orderBy('name')
      .select('id', 'name')) as Array<{ id: string; name: string }>
    const rows = new Map((await listChecklists()).map((r) => [r.role_id.toLowerCase(), r]))
    return {
      data: {
        ready: await checklistsReady(),
        roles: roles.map((r) => {
          const c = rows.get(String(r.id).toLowerCase())
          return {
            role_id: String(r.id),
            name: r.name,
            status: c?.published
              ? c.unpublished_changes
                ? 'changed'
                : 'published'
              : c?.draft
                ? 'draft'
                : 'none',
            steps: (c?.published ?? c?.draft ?? []).length,
            published_at: c?.published_at ?? null
          }
        })
      }
    }
  })

  app.get<{ Params: { roleId: string } }>(
    '/role-checklists/:roleId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { roleId } = req.params
      if (!UUID.test(roleId)) return reply.code(400).send({ error: 'Not a role id' })
      const basis = await roleContext(roleId)
      if (!basis) return reply.code(404).send({ error: 'No such role' })
      return { data: { checklist: await getChecklist(roleId), basis } }
    }
  )

  // Draft with AI. Replaces the working draft only; the published version stays.
  app.post<{ Params: { roleId: string } }>(
    '/role-checklists/:roleId/draft',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await checklistsReady())) return notReady(reply)
      const { roleId } = req.params
      if (!UUID.test(roleId)) return reply.code(400).send({ error: 'Not a role id' })
      try {
        const { steps } = await draftChecklist(roleId)
        if (!steps.length)
          return reply.code(422).send({
            error:
              'The draft came back with no usable steps. This role may not have queues, videos or collections to point at yet.'
          })
        await saveDraft(roleId, steps, req.user!.id, true)
        await logActivity({
          action: 'role-checklist-draft',
          user: req.user!.id,
          collection: 'nivaro_role_checklists',
          item: roleId,
          comment: `${steps.length} steps drafted`,
          req
        })
        return { data: { checklist: await getChecklist(roleId) } }
      } catch (err) {
        const code = statusOf(err)
        if (code >= 500) req.log.warn({ err }, 'Checklist draft failed')
        return reply
          .code(code)
          .send({ error: code >= 500 ? 'Drafting failed' : (err as Error).message })
      }
    }
  )

  // Save the admin's edits to the working draft.
  app.put<{ Params: { roleId: string } }>(
    '/role-checklists/:roleId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await checklistsReady())) return notReady(reply)
      const { roleId } = req.params
      if (!UUID.test(roleId)) return reply.code(400).send({ error: 'Not a role id' })
      if (!(await db('nivaro_roles').where({ id: roleId }).first('id')))
        return reply.code(404).send({ error: 'No such role' })
      const raw = (req.body as { steps?: unknown } | null)?.steps
      const steps = normalizeSteps(raw)
      if (Array.isArray(raw) && raw.length > steps.length && raw.length <= 10)
        return reply.code(400).send({
          error: 'Some steps are incomplete: every step needs a title and somewhere to go.'
        })
      await saveDraft(roleId, steps, req.user!.id)
      return { data: { checklist: await getChecklist(roleId) } }
    }
  )

  app.post<{ Params: { roleId: string } }>(
    '/role-checklists/:roleId/publish',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await checklistsReady())) return notReady(reply)
      const { roleId } = req.params
      if (!UUID.test(roleId)) return reply.code(400).send({ error: 'Not a role id' })
      try {
        const steps = await publishChecklist(roleId, req.user!.id)
        await logActivity({
          action: 'role-checklist-publish',
          user: req.user!.id,
          collection: 'nivaro_role_checklists',
          item: roleId,
          comment: `${steps.length} steps published`,
          req
        })
        return { data: { checklist: await getChecklist(roleId) } }
      } catch (err) {
        return reply.code(statusOf(err)).send({ error: (err as Error).message })
      }
    }
  )

  app.post<{ Params: { roleId: string } }>(
    '/role-checklists/:roleId/unpublish',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await checklistsReady())) return notReady(reply)
      const { roleId } = req.params
      if (!UUID.test(roleId)) return reply.code(400).send({ error: 'Not a role id' })
      await unpublishChecklist(roleId, req.user!.id)
      await logActivity({
        action: 'role-checklist-unpublish',
        user: req.user!.id,
        collection: 'nivaro_role_checklists',
        item: roleId,
        req
      })
      return { data: { checklist: await getChecklist(roleId) } }
    }
  )

  // ─── The person's side ────────────────────────────────────────────────────
  app.get('/my-work/first-week', { preHandler: requireAuth }, async (req) => {
    const u = req.user as { id: string; role?: string | null }
    return { data: await firstWeekFor({ id: String(u.id), role: u.role ? String(u.role) : null }) }
  })

  app.post('/my-work/first-week/opened', { preHandler: requireAuth }, async (req, reply) => {
    const step = (req.body as { step_id?: unknown } | null)?.step_id
    if (typeof step !== 'string') return reply.code(400).send({ error: 'step_id is required' })
    await markOpened(String(req.user!.id), step)
    return reply.code(204).send()
  })

  app.post('/my-work/first-week/dismiss', { preHandler: requireAuth }, async (req, reply) => {
    await dismissFirstWeek(String(req.user!.id))
    return reply.code(204).send()
  })
}
