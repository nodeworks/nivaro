/**
 * Ready-to-send board (idea 37) — Integrations console → Ready to send.
 *
 *   GET  /ready-to-send          the newest nightly result, only the records the caller may read
 *                                (judged now, as the caller), grouped by partner and by problem
 *   POST /ready-to-send/run      admin: run the check now (the `ready-to-send` job; 202)
 *   POST /ready-to-send/check    {collection, item} — "Check again": one record's live preflight
 *                                as the caller; the stored board takes the fresh answer
 *
 * The job (services/ready-to-send/run.ts) stores its result in its own nivaro_job_runs row.
 */
import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { JobBusyError } from '../plugins/cron.js'
import { logActivity } from '../services/activity.js'
import { recordRefusal } from '../services/erp-record-gate.js'
import { registerOpsSection } from '../services/ops-report/sections.js'
import {
  applyCheck,
  boardGroups,
  READY_JOB_ID,
  type ReadyResult,
  visibleEntries
} from '../services/ready-to-send/board.js'
import { checkOneRecord, latestReadyResult, storeResult } from '../services/ready-to-send/run.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CLAIM_WAIT_MS = 3_000
const BOARD_HREF = '/integration-health?tab=ready'

/** Pure: the daily report rows for one stored board (+ where the last run stopped, if short). */
export function readySectionRows(
  r: ReadyResult | null,
  stopped: { checked: number; total: number | null } | null = null
) {
  if (!r) return []
  const t = boardGroups(r.entries).totals
  return [
    {
      key: 'refused',
      label: 'Records a partner would refuse at their next send',
      value: t.refused,
      unit: 'count' as const,
      better: 'down' as const,
      href: BOARD_HREF
    },
    {
      key: 'incomplete',
      label: 'Records that would send without something',
      value: t.warnings,
      unit: 'count' as const,
      better: 'down' as const,
      href: BOARD_HREF
    },
    {
      key: 'checked',
      label: 'Records checked',
      value: r.checked,
      unit: 'count' as const,
      note: stopped
        ? `The latest run stopped at ${stopped.checked}${stopped.total != null ? ` of ${stopped.total}` : ''}; these figures are from the run before`
        : undefined
    }
  ]
}

export async function readyToSendRoutes(app: FastifyInstance) {
  app.get('/ready-to-send', { preHandler: requireAuth }, async (req) => {
    const { run, running, progress, stopped } = await latestReadyResult()
    const isAdmin = !!req.isAdmin
    // How far a run got reads across every record: the counts are for administrators.
    const runState = {
      running,
      progress: isAdmin ? progress : null,
      stopped_short: !!stopped,
      stopped: isAdmin ? stopped : null,
      can_run: isAdmin
    }
    if (!run) return { data: { run: null, ...runState } }
    const r = run.result
    const entries = await visibleEntries(r.entries, req.user!, isAdmin)
    const groups = boardGroups(entries)
    return {
      data: {
        run: {
          id: run.id,
          status: run.status,
          started_at: run.started_at,
          finished_at: run.finished_at,
          generated_at: r.generated_at,
          trigger: r.trigger,
          duration_ms: r.duration_ms
        },
        ...runState,
        // How much was checked reads across every record: administrators only.
        coverage: isAdmin
          ? {
              candidates: r.candidates,
              checked: r.checked,
              ready: r.ready,
              errors: r.errors
            }
          : null,
        collections: Object.fromEntries(
          [...new Set(entries.map((e) => e.collection))].map((c) => [c, r.collections[c] ?? c])
        ),
        totals: groups.totals,
        partners: groups.partners,
        problems: groups.problems,
        entries
      }
    }
  })

  app.post('/ready-to-send/run', { preHandler: requireAdmin }, async (req, reply) => {
    const userId = req.user?.id ?? null
    // The CronManager owns the run: its job row, the heavy slot and the background pool.
    const run = app.cron.runNow(READY_JOB_ID, userId)
    const early = await Promise.race([
      run.then(
        () => ({ settled: true as const, err: null as unknown }),
        (err: unknown) => ({ settled: true as const, err })
      ),
      new Promise<{ settled: false; err: null }>((resolve) => {
        setTimeout(() => resolve({ settled: false, err: null }), CLAIM_WAIT_MS).unref?.()
      })
    ])
    if (early.err instanceof JobBusyError)
      return reply.code(409).send({ error: 'The check is already running', code: 'READY_RUNNING' })
    if (early.err) req.log.error({ err: early.err }, 'ready-to-send run failed')
    if (!early.settled)
      run.catch((err) => {
        if (!(err instanceof JobBusyError)) req.log.error({ err }, 'ready-to-send run failed')
      })
    await logActivity({
      action: 'ready-to-send-run',
      user: userId ?? undefined,
      collection: 'nivaro_job_runs',
      comment: 'Ready-to-send check started',
      req
    })
    return reply.code(202).send({ data: { started: true, finished: early.settled } })
  })

  app.post<{ Body: { collection?: string; item?: string } }>(
    '/ready-to-send/check',
    { preHandler: requireAuth },
    async (req, reply) => {
      const collection = String(req.body?.collection ?? '')
      const item = String(req.body?.item ?? '')
      if (!IDENT.test(collection) || !item || item.length > 64)
        return reply.code(400).send({ error: 'collection and item are required' })
      const refusal = await recordRefusal(req, collection, item, 'read')
      if (refusal) return reply.code(refusal.code).send(refusal.body)
      const u = req.user
      const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || 'Someone'
      const fresh = await checkOneRecord(collection, item, u?.id ?? null, name)
      // The stored board takes the fresh answer (unless a run is replacing it right now).
      try {
        const { run, running } = await latestReadyResult()
        if (run && !running)
          await storeResult(
            run.id,
            applyCheck(run.result, collection, item, fresh?.entries ?? [], { gone: !fresh })
          )
      } catch (err) {
        req.log.warn({ err }, 'ready-to-send: stored board not updated')
      }
      return {
        data: {
          // No send move next any more (moved on, or its pushes no longer apply here).
          sending: !!fresh,
          ready: !fresh || fresh.entries.length === 0,
          entries: fresh?.entries ?? [],
          collection_label: fresh?.collection_label ?? collection
        }
      }
    }
  )

  // Health → Daily report: what the nightly check found (counts; the rows link the board).
  registerOpsSection('ready_to_send', 'Ready to send', async () => {
    const { run, stopped } = await latestReadyResult()
    return readySectionRows(run?.result ?? null, stopped)
  })
}
