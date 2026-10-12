import type { FastifyInstance, FastifyReply } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { type FlowRecords, planToFlow } from '../services/ai-plan-flow.js'
import '../services/ai-plan-integrity.js'
import { changeReportXlsx, planChangeReport } from '../services/ai-plan-report.js'
import { schedulePlan, unschedulePlan } from '../services/ai-plan-schedule.js'
import { listPlanStepKinds } from '../services/ai-plan-steps.js'
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  proposeFromTemplate,
  type TemplateInput,
  updateTemplate
} from '../services/ai-plan-templates.js'
import { undoCheck, undoPlan } from '../services/ai-plan-undo.js'
import { cancelPlan, getPlan, listPlans, recheckPlan, runPlan } from '../services/ai-plans.js'

/**
 * Ask AI multi-step plans (#1807) — the plan card's routes, mounted under
 * /api/ai. Plans are PROPOSED only by the chat (the propose_plan tool); these
 * read, run, retry and stop them. Only the person who asked runs, retries or
 * stops a plan; an administrator may read one. Every step runs as that
 * person through the normal services.
 *
 *   GET  /ai/plans/step-kinds      the step kinds the model may use
 *   GET  /ai/plans/:id             the plan with each step's state
 *   POST /ai/plans/:id/run         {mode?: 'all' | 'next'} → 202, runs in the background
 *   POST /ai/plans/:id/retry       re-check the failed + remaining steps → paused
 *   POST /ai/plans/:id/cancel      discard (not started) or stop before the next step
 *
 * Wave 2 (owner or administrator unless noted):
 *   GET  /ai/plans                     history (#1954); ?scope=all = every plan (admin)
 *   GET  /ai/plans/:id/changes         change report (#2002), built for the viewer
 *   GET  /ai/plans/:id/changes.xlsx    the same as Excel
 *   POST /ai/plans/:id/schedule        {run_at} — owner; approve to run later (#1903)
 *   POST /ai/plans/:id/unschedule      owner; back to waiting for approval
 *   GET  /ai/plans/:id/undo            admin; what can still be reverted
 *   POST /ai/plans/:id/undo            admin; {step_id?} revert (#1954)
 *   POST /ai/plans/:id/flow            admin; {records} draft flow (#1849)
 *   GET  /ai/plan-templates            templates (#1952)
 *   POST /ai/plan-templates/propose    {key, values} → a proposed plan, as the person
 *   POST /ai/plan-templates            admin; create  ·  PATCH/DELETE /ai/plan-templates/:key
 */
export async function aiPlanRoutes(app: FastifyInstance) {
  const fail = (reply: FastifyReply, err: unknown) => {
    const status = (err as { statusCode?: number }).statusCode ?? 400
    return reply.code(status).send({ error: err instanceof Error ? err.message : 'Failed' })
  }

  app.get('/plans/step-kinds', { preHandler: authenticate }, async () => ({
    data: listPlanStepKinds().map((k) => ({ kind: k.kind, label: k.label, describe: k.describe }))
  }))

  app.get<{ Querystring: { scope?: string; status?: string; limit?: string; offset?: string } }>(
    '/plans',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return await listPlans(req.user!, {
          scope: req.query.scope,
          status: req.query.status,
          limit: Number(req.query.limit) || undefined,
          offset: Number(req.query.offset) || undefined
        })
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.get<{ Params: { id: string } }>(
    '/plans/:id',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await getPlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { mode?: string } | undefined }>(
    '/plans/:id/run',
    { preHandler: authenticate },
    async (req, reply) => {
      const mode = req.body?.mode === 'next' ? 'next' : 'all'
      try {
        return reply.code(202).send({ data: await runPlan(req.user!, req.params.id, { mode }) })
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/plans/:id/retry',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await recheckPlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/plans/:id/cancel',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await cancelPlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )
  app.get<{ Params: { id: string } }>(
    '/plans/:id/changes',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await planChangeReport(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.get<{ Params: { id: string } }>(
    '/plans/:id/changes.xlsx',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        const report = await planChangeReport(req.user!, req.params.id)
        const safe =
          report.title
            .replace(/[^A-Za-z0-9 _-]+/g, '')
            .trim()
            .slice(0, 60) || 'plan'
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
          .header('Content-Disposition', `attachment; filename="${safe} - changes.xlsx"`)
          .send(changeReportXlsx(report))
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { run_at?: string } | undefined }>(
    '/plans/:id/schedule',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await schedulePlan(req.user!, req.params.id, req.body?.run_at) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/plans/:id/unschedule',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await unschedulePlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.get<{ Params: { id: string } }>(
    '/plans/:id/undo',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return { data: await undoCheck(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { step_id?: string } | undefined }>(
    '/plans/:id/undo',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return { data: await undoPlan(req.user!, req.params.id, req.body?.step_id ?? null) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { records?: string } | undefined }>(
    '/plans/:id/flow',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const records = (req.body?.records ?? 'same') as FlowRecords
        return reply.code(201).send({ data: await planToFlow(req.user!, req.params.id, records) })
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.get('/plan-templates', { preHandler: authenticate }, async () => ({
    data: await listTemplates()
  }))

  app.post<{ Body: { key?: string; values?: Record<string, unknown> } | undefined }>(
    '/plan-templates/propose',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        const data = await proposeFromTemplate(
          req.user!,
          String(req.body?.key ?? ''),
          req.body?.values ?? {}
        )
        return { data }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Body: TemplateInput | undefined }>(
    '/plan-templates',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return reply.code(201).send({ data: await createTemplate(req.user!, req.body ?? {}) })
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.patch<{ Params: { key: string }; Body: TemplateInput | undefined }>(
    '/plan-templates/:key',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return { data: await updateTemplate(req.user!, req.params.key, req.body ?? {}) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.delete<{ Params: { key: string } }>(
    '/plan-templates/:key',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        await deleteTemplate(req.user!, req.params.key)
        return reply.code(204).send()
      } catch (err) {
        return fail(reply, err)
      }
    }
  )
}
