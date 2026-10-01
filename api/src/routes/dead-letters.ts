import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { executeFlow } from '../services/flow-executor.js'

/**
 * Dead Letter Queue: failed flow runs (`nivaro_flow_runs` rows with
 * status='error'). Flows execute in-process (executeFlow) and persist their
 * failures there, so this is the one source. Retry re-executes the flow
 * in-process with the original stored input plus `$retry_of` /
 * `$retry_count` markers.
 */

interface DeadLetter {
  id: string
  function: string
  event: string
  error: string
  payload: Record<string, unknown> | null
  failed_at: string | null
  retry_count: number
  source: 'flow-run'
}

interface FlowRunRow {
  id: string
  flow: string
  trigger: string
  status: string
  started_at: Date
  completed_at: Date | null
  input: string | null
  error_message: string | null
  flow_name: string | null
}

function parseJson(val: string | null | undefined): Record<string, unknown> | null {
  if (!val) return null
  try {
    return JSON.parse(val) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function deadLettersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // ─── GET / — list failed jobs ─────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    // Failed flow runs
    let flowFailures: DeadLetter[] = []
    try {
      const rows = await db<FlowRunRow>('nivaro_flow_runs as r')
        .leftJoin('nivaro_flows as f', 'f.id', 'r.flow')
        .where('r.status', 'error')
        .orderBy('r.started_at', 'desc')
        .limit(200)
        .select(
          'r.id',
          'r.flow',
          'r.trigger',
          'r.status',
          'r.started_at',
          'r.completed_at',
          'r.input',
          'r.error_message',
          'f.name as flow_name'
        )
      flowFailures = rows.map((r) => {
        const input = parseJson(r.input)
        return {
          id: r.id,
          function: r.flow_name ?? r.flow,
          event: `flow/${r.trigger}`,
          error: r.error_message ?? 'Flow execution failed',
          payload: input,
          failed_at:
            (r.completed_at ?? r.started_at)?.toISOString?.() ??
            String(r.completed_at ?? r.started_at),
          retry_count: Number((input?.$retry_count as number) ?? 0),
          source: 'flow-run' as const
        }
      })
    } catch (err) {
      app.log.warn({ err }, 'Failed to read flow run failures')
    }

    return reply.send({ data: flowFailures })
  })

  // ─── POST /:runId/retry — re-run a failed job ─────────────────────────────
  app.post('/:runId/retry', async (req, reply) => {
    const { runId } = req.params as { runId: string }

    const run = await db<FlowRunRow>('nivaro_flow_runs').where({ id: runId }).first()
    if (run) {
      if (run.status !== 'error') {
        return reply.code(400).send({ error: 'Run did not fail — nothing to retry' })
      }
      const flow = await db<{ id: string; name: string; status: string }>('nivaro_flows')
        .where({ id: run.flow })
        .first()
      if (!flow) return reply.code(404).send({ error: 'Flow no longer exists' })

      const input = parseJson(run.input) ?? {}
      const payload: Record<string, unknown> = {
        ...input,
        $retry_of: runId,
        $retry_count: Number((input.$retry_count as number) ?? 0) + 1
      }

      // Re-execute the flow in-process with the original input.
      executeFlow({
        flowId: flow.id,
        flowName: flow.name,
        trigger: run.trigger,
        payload,
        log: app.log,
        userId: req.user?.id
      }).catch((err) => app.log.error({ err, flowId: flow.id }, 'Dead-letter retry failed'))

      await logActivity({
        action: 'run',
        collection: 'nivaro_flows',
        item: flow.id,
        user: req.user?.id,
        req,
        comment: `dead-letter retry of run ${runId}`
      })
      return reply.send({ data: { ok: true, retried: runId } })
    }

    return reply.code(404).send({ error: 'Failed run not found' })
  })
}
