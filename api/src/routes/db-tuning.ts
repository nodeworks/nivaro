import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  applyProposal,
  dismissProposal,
  readLiveState,
  revalidate,
  rollbackProposal,
  TuningRefusal
} from '../services/db-tuning/apply.js'
import { getProposal, listProposals, updateProposal } from '../services/db-tuning/ledger.js'
import { isObserveRunning, OBSERVE_JOB_ID, runObserve } from '../services/db-tuning/observe-run.js'
import { listTuningObservers } from '../services/db-tuning/observers/registry.js'
import { prove } from '../services/db-tuning/proof.js'
import {
  bustTuningSettings,
  readTuningSettings,
  validateTuningSettings
} from '../services/db-tuning/settings.js'
import {
  isErrorRefusal,
  TUNING_KINDS,
  TUNING_STATUSES,
  type TuningKind,
  type TuningStatus
} from '../services/db-tuning/types.js'

/**
 * Database tuning (#996). Propose-only: apply / rollback / dismiss / reprove / observe each take
 * an id (or nothing) and never a statement — the ledger row carries what runs. Admin only.
 * apply, rollback and dismiss write their own activity rows; the routes do not log them again.
 */

const T = 'nivaro_tuning_proposals'
const REPROVE_FROM: readonly TuningStatus[] = ['stale', 'rejected_by_proof', 'proposed']

/** A refusal answers its own status with its code and detail; anything else is the global handler's. */
function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof TuningRefusal)
    return reply.code(err.status).send({ error: err.message, code: err.code, ...err.detail })
  throw err
}

export async function dbTuningRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const settings = await readTuningSettings()
    const rows = (await db(T)
      .select('status', 'kind')
      .sum({ est: 'estimate_ms_per_day' })
      .count({ n: '*' })
      .groupBy('status', 'kind')) as Array<{
      status: string
      kind: string
      est: number | string | null
      n: number | string
    }>
    const by_status: Record<string, number> = {}
    const by_kind: Record<string, number> = {}
    let open_estimate = 0
    for (const r of rows) {
      by_status[r.status] = (by_status[r.status] ?? 0) + Number(r.n)
      if (r.status === 'proposed') {
        by_kind[r.kind] = (by_kind[r.kind] ?? 0) + Number(r.n)
        open_estimate += Number(r.est ?? 0)
      }
    }
    const last = (await db('nivaro_job_runs')
      .where('job_id', OBSERVE_JOB_ID)
      .orderBy('started_at', 'desc')
      .first('id', 'started_at', 'status', 'outcome', 'error')
      .catch(() => undefined)) as Record<string, unknown> | undefined
    const applied = (await db(T)
      .whereIn('status', ['watching', 'applied'])
      .where('applied_at', '>', new Date(Date.now() - 30 * 86_400_000))
      .count({ n: '*' })
      .first()) as { n?: number | string } | undefined
    return {
      data: {
        settings,
        by_status,
        by_kind,
        open_estimate_ms_per_day: open_estimate,
        applied_30d: Number(applied?.n ?? 0),
        last_run: last ?? null,
        is_running: isObserveRunning(),
        observers: listTuningObservers()
      }
    }
  })

  app.get<{ Querystring: { status?: string; kind?: string } }>('/proposals', async (req) => {
    const status = (req.query.status ?? 'proposed')
      .split(',')
      .filter((s): s is TuningStatus => (TUNING_STATUSES as readonly string[]).includes(s))
    const kind = (TUNING_KINDS as readonly string[]).includes(req.query.kind ?? '')
      ? (req.query.kind as TuningKind)
      : undefined
    return { data: await listProposals({ status, kind }) }
  })

  app.get<{ Params: { id: string } }>('/proposals/:id', async (req, reply) => {
    const row = await getProposal(req.params.id)
    return row ? { data: row } : reply.code(404).send({ error: 'Not found' })
  })

  app.post<{ Params: { id: string }; Body: { dba_ok?: boolean } | null }>(
    '/proposals/:id/apply',
    async (req, reply) => {
      try {
        if (!(await getProposal(req.params.id))) return reply.code(404).send({ error: 'Not found' })
        return {
          data: await applyProposal(req.params.id, {
            userId: req.user?.id ?? null,
            dbaOk: req.body?.dba_ok === true,
            app
          })
        }
      } catch (err) {
        return refuse(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { reason?: string } | null }>(
    '/proposals/:id/rollback',
    async (req, reply) => {
      try {
        if (!(await getProposal(req.params.id))) return reply.code(404).send({ error: 'Not found' })
        const reason =
          String(req.body?.reason ?? '').trim() || `by ${req.user?.email ?? 'an administrator'}`
        return {
          data: await rollbackProposal(req.params.id, {
            userId: req.user?.id ?? null,
            reason,
            app
          })
        }
      } catch (err) {
        return refuse(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { note?: string } | null }>(
    '/proposals/:id/dismiss',
    async (req, reply) => {
      try {
        if (!(await getProposal(req.params.id))) return reply.code(404).send({ error: 'Not found' })
        const note = String(req.body?.note ?? '').trim()
        if (!note)
          return reply.code(400).send({ error: 'A note is required', code: 'TUNING_INVALID' })
        await dismissProposal(req.params.id, { userId: req.user?.id ?? null, note })
        return { data: { ok: true } }
      } catch (err) {
        return refuse(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>('/proposals/:id/reprove', async (req, reply) => {
    const row = await getProposal(req.params.id)
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!REPROVE_FROM.includes(row.status))
      return reply
        .code(409)
        .send({ error: `proposal is ${row.status}`, code: 'TUNING_NOT_APPLICABLE' })
    // The proof compares against the live object (a proc's twin EXECs the live procedure), so a
    // changed object would be judged against the wrong side: it stays stale until the nightly
    // observe proposes against what is live now.
    const changed = revalidate(row, await readLiveState(row))
    if (changed) {
      if (row.status !== 'stale') await updateProposal(row.id, { status: 'stale' })
      return reply.code(409).send({
        error: 'the object changed since this was proposed; it will be re-observed tonight',
        code: 'TUNING_STALE',
        reason: changed
      })
    }
    const settings = await readTuningSettings()
    // the row does not keep its change_key, so the candidate carries none: the proof never reads it
    const proof = await prove(
      {
        kind: row.kind,
        target: row.target,
        change_key: '',
        title: row.title,
        evidence: row.evidence,
        estimate_ms_per_day: row.estimate_ms_per_day,
        risk: row.risk,
        apply: row.apply,
        undo: row.undo,
        replicated: row.replicated
      },
      { procTimeoutMs: settings.proc_timeout_minutes * 60_000 }
    )
    // a proof that errored judged nothing: a standing proposal stays as it was
    if (!(row.status === 'proposed' && isErrorRefusal(proof)))
      await updateProposal(row.id, {
        proof,
        status: proof.passed ? 'proposed' : 'rejected_by_proof',
        last_seen: new Date()
      })
    await logActivity({
      action: 'tuning-reprove',
      user: req.user?.id,
      collection: T,
      item: row.id,
      comment:
        `Reproved: ${row.title} — ${proof.method} ${proof.passed ? 'passed' : 'failed'}`.slice(
          0,
          1000
        ),
      req
    })
    return { data: await getProposal(row.id) }
  })

  app.post<{ Body: { dry_run?: boolean } | null }>('/observe', async (req, reply) => {
    const userId = req.user?.id ?? null
    if (req.body?.dry_run === true)
      return { data: await runObserve({ dryRun: true, trigger: 'run-now', userId }) }
    if (!(await readTuningSettings()).enabled)
      return reply
        .code(409)
        .send({ error: 'Database tuning is turned off', code: 'TUNING_DISABLED' })
    if (isObserveRunning())
      return reply
        .code(409)
        .send({ error: 'An observe run is already in progress', code: 'TUNING_RUNNING' })
    // a real run can take up to an hour: answer now, the run records itself in the job runs
    void runObserve({ trigger: 'run-now', userId }).catch((err) =>
      app.log.error({ err }, 'db-tuning observe failed')
    )
    return reply.code(202).send({ data: { started: true } })
  })

  app.get('/settings', async () => ({ data: await readTuningSettings() }))

  app.patch<{ Body: Record<string, unknown> | null }>('/settings', async (req, reply) => {
    const merged = { ...(await readTuningSettings()), ...(req.body ?? {}) }
    // the validator stops at the first bad key; ask it one key at a time to name them all
    const problems: string[] = []
    for (const [k, v] of Object.entries(merged)) {
      try {
        validateTuningSettings({ [k]: v })
      } catch (err) {
        problems.push(err instanceof Error ? err.message : `${k} is invalid`)
      }
    }
    if (problems.length) return reply.code(400).send({ error: problems.join('; '), problems })
    const next = validateTuningSettings(merged)
    await db('nivaro_settings')
      .where('id', 1)
      .update({ db_tuning: JSON.stringify(next) })
    bustTuningSettings()
    await logActivity({
      action: 'tuning-settings',
      user: req.user?.id,
      collection: 'nivaro_settings',
      item: '1',
      comment: `db_tuning: ${JSON.stringify(next)}`.slice(0, 500),
      req
    })
    return { data: next }
  })
}
