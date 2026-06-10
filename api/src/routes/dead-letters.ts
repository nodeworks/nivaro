import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { inngest } from '../plugins/inngest.js'
import { logActivity } from '../services/activity.js'
import { executeFlow } from '../services/flow-executor.js'

/**
 * Dead Letter Queue.
 *
 * Failed background jobs come from two sources:
 *
 * 1. `nivaro_flow_runs` rows with status='error' — the primary, always-available
 *    source. Flows execute in-process (executeFlow) and persist failures here.
 * 2. The self-hosted Inngest REST API (`/v1/runs?status=Failed`, `/v1/events`).
 *    The dev server runs on localhost:8288; override with INNGEST_BASE_URL.
 *    LIMITATION: the Inngest event/run query API surface varies between the dev
 *    server and self-hosted builds — when it is unreachable or returns 404 we
 *    degrade gracefully and serve only the flow-run failures, adding
 *    `error: 'inngest unreachable'` to the response so the UI can surface it.
 *
 * Retry semantics: for flow-run failures we re-execute the flow in-process with
 * the original stored input (plus `$retry_of` / `$retry_count` markers) AND
 * re-send the original `cms/flow.triggered` event through the Inngest client.
 */

const INNGEST_BASE = process.env.INNGEST_BASE_URL ?? 'http://localhost:8288'

interface DeadLetter {
  id: string
  function: string
  event: string
  error: string
  payload: Record<string, unknown> | null
  failed_at: string | null
  retry_count: number
  source: 'flow-run' | 'inngest'
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

async function fetchWithTimeout(url: string, ms = 3000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Best-effort fetch of failed runs from the Inngest REST API. Null = unreachable. */
async function fetchInngestFailures(): Promise<DeadLetter[] | null> {
  for (const path of ['/v1/runs?status=Failed', '/v1/events']) {
    try {
      const res = await fetchWithTimeout(`${INNGEST_BASE}${path}`)
      if (res.status === 404) continue // endpoint not available on this build
      if (!res.ok) continue
      const json = (await res.json()) as { data?: unknown[] }
      const rows = Array.isArray(json.data) ? json.data : []
      if (path.startsWith('/v1/runs')) {
        return rows.map((raw) => {
          const r = raw as Record<string, unknown>
          return {
            id: String(r.run_id ?? r.id ?? ''),
            function: String(r.function_id ?? r.function ?? 'unknown'),
            event: String(r.event_id ?? r.event ?? 'unknown'),
            error: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? 'failed'),
            payload: (r.event_data as Record<string, unknown>) ?? null,
            failed_at: (r.ended_at as string) ?? null,
            retry_count: Number(r.attempt ?? 0),
            source: 'inngest' as const
          }
        })
      }
      // /v1/events — no run status attached; nothing reliable to surface as failures.
      return []
    } catch {
      // try next path / fall through to unreachable
    }
  }
  return null
}

export async function deadLettersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // ─── GET / — list failed jobs ─────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    // 1. Failed flow runs from the DB (always available)
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

    // 2. Inngest REST API (best-effort)
    const inngestFailures = await fetchInngestFailures()

    const data = [...flowFailures, ...(inngestFailures ?? [])].sort((a, b) =>
      String(b.failed_at ?? '').localeCompare(String(a.failed_at ?? ''))
    )
    return reply.send({
      data,
      ...(inngestFailures === null ? { error: 'inngest unreachable' } : {})
    })
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

      // Re-send the original event through the Inngest client (best-effort)…
      try {
        await inngest.send({
          name: 'cms/flow.triggered',
          data: { flowId: flow.id, flowName: flow.name, trigger: run.trigger, payload }
        })
      } catch (err) {
        app.log.warn({ err, flowId: flow.id }, 'Retry event not delivered to Inngest')
      }

      // …and re-execute the flow in-process, since that is what actually runs flows.
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

    // Not a flow run — try to resolve through the Inngest API and re-send the event
    try {
      const res = await fetchWithTimeout(`${INNGEST_BASE}/v1/runs/${encodeURIComponent(runId)}`)
      if (res.ok) {
        const json = (await res.json()) as { data?: Record<string, unknown> }
        const eventName = json.data?.event_name ?? json.data?.event
        const eventData = json.data?.event_data ?? {}
        if (typeof eventName === 'string' && eventName) {
          await inngest.send({ name: eventName, data: eventData as Record<string, unknown> })
          return reply.send({ data: { ok: true, retried: runId } })
        }
      }
    } catch {
      // fall through
    }
    return reply.code(404).send({ error: 'Failed run not found' })
  })
}
