import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { undoCheck, undoPlan } from '../services/ai-plan-undo.js'
import {
  approveTaskDoPlan,
  draftTaskDo,
  draftTaskDoReply,
  editTaskDoPlan,
  getTaskDoPlan,
  getTaskDoSettings,
  isTaskDoer,
  loadTask,
  noteTaskDoUndo,
  plansForTask,
  saveTaskDoSettings,
  type TaskDoAnswer,
  taskDoAccess,
  taskDoAnalytics
} from '../services/ai-task-do.js'
import { isTaskParty } from '../services/tasks.js'

/**
 * "Let AI do this" for tasks and support tickets (#2862–#2866), mounted
 * under /api/ai/task-do. Drafting, review figures, edit, second approval,
 * the reply draft and the owner's undo live here; approve / run / schedule /
 * retry / stop stay the plan routes (routes/ai-plans.ts). The AI call log
 * names every model call made here `task-do` (featureFromRoute).
 *
 *   GET   /task-do/me                      which kinds this person may use
 *   GET   /task-do/settings                admin — the settings block
 *   PATCH /task-do/settings                admin
 *   GET   /task-do/analytics               admin — plans from tasks / tickets
 *   GET   /task-do/tasks/:id               access verdict + this task's plans
 *   POST  /task-do/tasks/:id/draft         {answers?, note?, previous_plan_id?} → a plan, questions or "can't"
 *   GET   /task-do/plans/:id               the plan with review figures
 *   POST  /task-do/plans/:id/edit          {remove_step?} | {set: {step_id, field, value}}
 *   POST  /task-do/plans/:id/approve       the second approval (creator / admin)
 *   POST  /task-do/plans/:id/draft-reply   ticket: an AI-drafted reply, never sent
 *   GET   /task-do/plans/:id/undo          owner (7 days) or admin — what can be restored
 *   POST  /task-do/plans/:id/undo          {step_id?} — revert; logged on the thread
 */
export async function aiTaskDoRoutes(app: FastifyInstance) {
  const fail = (reply: FastifyReply, err: unknown) => {
    const status = (err as { statusCode?: number }).statusCode ?? 400
    return reply.code(status).send({ error: err instanceof Error ? err.message : 'Failed' })
  }
  const taskOf = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const t = await loadTask(Number(req.params.id))
    // A task's own people, or an administrator — the same gate the task routes use
    // for a ticket; nobody else learns the task exists.
    if (!t) return null
    if (req.isAdmin || isTaskParty(t, String(req.user!.id))) return t
    return (await isTaskDoer(req.user!, t)) ? t : null
  }

  app.get('/task-do/me', { preHandler: authenticate }, async (req) => {
    const s = await getTaskDoSettings()
    const role = String(req.user!.role ?? '')
    const roleOk =
      s.allowed_roles.length === 0 ||
      s.allowed_roles.some((r) => r.toUpperCase() === role.toUpperCase())
    return {
      data: {
        tasks: s.tasks_enabled && roleOk,
        tickets: s.tickets_enabled && roleOk,
        ticket_categories: s.ticket_categories
      }
    }
  })

  app.get('/task-do/settings', { preHandler: requireAdmin }, async () => ({
    data: await getTaskDoSettings()
  }))

  app.patch<{ Body: Record<string, unknown> | undefined }>(
    '/task-do/settings',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return { data: await saveTaskDoSettings(req.body ?? {}) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.get<{ Querystring: { days?: string } }>(
    '/task-do/analytics',
    { preHandler: requireAdmin },
    async (req) => ({
      data: await taskDoAnalytics(Math.min(365, Math.max(1, Number(req.query.days) || 90)))
    })
  )

  app.get<{ Params: { id: string } }>(
    '/task-do/tasks/:id',
    { preHandler: authenticate },
    async (req, reply) => {
      const t = await taskOf(req)
      if (!t) return reply.code(404).send({ error: 'Not found' })
      const access = await taskDoAccess(req.user!, t)
      const { settings: _s, ...verdict } = access
      return { data: { ...verdict, plans: await plansForTask(req.user!, t.id) } }
    }
  )

  app.post<{
    Params: { id: string }
    Body: { answers?: TaskDoAnswer[]; note?: string; previous_plan_id?: string } | undefined
  }>('/task-do/tasks/:id/draft', { preHandler: authenticate }, async (req, reply) => {
    const t = await taskOf(req)
    if (!t) return reply.code(404).send({ error: 'Not found' })
    const answers = Array.isArray(req.body?.answers)
      ? req
          .body!.answers.filter((a) => a && typeof a === 'object')
          .slice(0, 4)
          .map((a) => ({
            id: String(a.id ?? '').slice(0, 20),
            question: String(a.question ?? '').slice(0, 400),
            answer: String(a.answer ?? '').slice(0, 1000)
          }))
      : []
    try {
      const draft = await draftTaskDo(req.user!, t, {
        answers,
        note: req.body?.note ? String(req.body.note).slice(0, 1000) : null,
        previous_plan_id: req.body?.previous_plan_id ? String(req.body.previous_plan_id) : null
      })
      return reply.code(201).send({ data: draft })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get<{ Params: { id: string } }>(
    '/task-do/plans/:id',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await getTaskDoPlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{
    Params: { id: string }
    Body:
      | { remove_step?: string; set?: { step_id: string; field: string; value: unknown } }
      | undefined
  }>('/task-do/plans/:id/edit', { preHandler: authenticate }, async (req, reply) => {
    try {
      return {
        data: await editTaskDoPlan(req.user!, req.params.id, {
          remove_step: req.body?.remove_step ? String(req.body.remove_step) : undefined,
          set:
            req.body?.set && typeof req.body.set === 'object'
              ? {
                  step_id: String(req.body.set.step_id ?? ''),
                  field: String(req.body.set.field ?? ''),
                  value: req.body.set.value
                }
              : undefined
        })
      }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { id: string } }>(
    '/task-do/plans/:id/approve',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await approveTaskDoPlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/task-do/plans/:id/draft-reply',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await draftTaskDoReply(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.get<{ Params: { id: string } }>(
    '/task-do/plans/:id/undo',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await undoCheck(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { step_id?: string } | undefined }>(
    '/task-do/plans/:id/undo',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        const result = await undoPlan(req.user!, req.params.id, req.body?.step_id ?? null)
        await noteTaskDoUndo(req.user!, req.params.id, result).catch(() => undefined)
        return { data: result }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )
}
