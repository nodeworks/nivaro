import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  applyChangeSet,
  describeOp,
  parseOperations,
  planChangeSet
} from '../services/change-sets.js'

/**
 * Schema change sets (#653) — batch schema edits reviewed before applying.
 *
 *   POST /plan  → validate ops against the live schema, per-op impact report;
 *                 nothing persisted.
 *   POST /apply → re-validate, then execute sequentially through the same
 *                 code paths the data-model routes use; stops at the first
 *                 failure and reports honestly what applied (no rollback —
 *                 schema statements aren't transactional across ops).
 */
export async function changeSetsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.post('/plan', async (req, reply) => {
    const body = req.body as { operations?: unknown }
    let ops: ReturnType<typeof parseOperations>
    try {
      ops = parseOperations(body?.operations)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid body' })
    }
    const plan = await planChangeSet(ops)
    const blocked = plan.filter((p) => p.status === 'blocked').length
    const warnings = plan.filter((p) => p.status === 'warning').length
    return reply.send({
      data: { operations: plan, blocked, warnings, can_apply: blocked === 0 }
    })
  })

  app.post('/apply', async (req, reply) => {
    const body = req.body as { operations?: unknown }
    let ops: ReturnType<typeof parseOperations>
    try {
      ops = parseOperations(body?.operations)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid body' })
    }

    // Re-validate — the plan the admin reviewed may be stale against the
    // live schema by the time they confirm. Impact scans are skipped here
    // (advisory only; the blockers are what gate execution).
    const plan = await planChangeSet(ops, { withImpact: false })
    const blockedOps = plan.filter((p) => p.status === 'blocked')
    if (blockedOps.length > 0) {
      return reply.code(400).send({
        error: 'Change set has blocked operations — re-run plan',
        data: { operations: plan }
      })
    }

    const report = await applyChangeSet(ops)
    await logActivity({
      action: 'schema-change-set',
      collection: 'schema',
      user: req.user?.id,
      req,
      comment: `${report.applied}/${ops.length} applied: ${ops
        .map((o) => describeOp(o))
        .join('; ')}`.slice(0, 400)
    })
    return reply.send({ data: report })
  })
}
