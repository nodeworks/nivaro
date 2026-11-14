import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { deleteOne, updateOne } from '../services/items.js'
import {
  CHECK_TIMEOUT_MS,
  describeScanError,
  findCheck,
  inspectCheck,
  loadOrphanChecks,
  type SweepState,
  startSweep,
  stillOrphaned,
  sweepStore
} from '../services/orphan-finder.js'
import {
  actionRefusal,
  KIND_LABEL,
  type OrphanAction,
  type OrphanCheck,
  planHash
} from '../services/orphan-finder-logic.js'
import { clientGoneSignal, withReadGate } from '../services/read-gate.js'

/** Rows one preview / apply may name. */
const MAX_IDS = 200
/** A sweep still "running" this long after it began died with its process. */
const STALE_SWEEP_MS = 2 * 3600_000

const publicCheck = (c: OrphanCheck) => ({
  key: c.key,
  kind: c.kind,
  kind_label: KIND_LABEL[c.kind],
  child: c.child,
  field: c.field,
  fk: c.fk,
  parent: c.parent,
  enforced: c.enforced,
  can_clear: actionRefusal(c, 'clear') === null,
  can_delete: actionRefusal(c, 'delete') === null,
  clear_refusal: actionRefusal(c, 'clear'),
  delete_refusal: c.kind === 'junction' ? actionRefusal(c, 'delete') : null
})

function liveState(s: SweepState | null): SweepState | null {
  if (s?.status === 'running' && Date.now() - s.started_at > STALE_SWEEP_MS)
    return { ...s, status: 'error', error: 'The sweep stopped with its server', current: null }
  return s
}

const isAction = (v: unknown): v is OrphanAction => v === 'clear' || v === 'delete'

// Data Integrity → Orphans: rows whose links point at records that no longer exist.
export async function orphanRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  const redis = () => (app as unknown as { redis?: Parameters<typeof sweepStore>[0] }).redis

  /** Every link checked (built from the metadata, judged against the schema) + the last sweep. */
  app.get('/', async (req) => {
    const q = req.query as { fresh?: string }
    const list = await loadOrphanChecks({ fresh: q.fresh === '1' })
    const sweep = liveState(await sweepStore(redis()).load())
    return {
      data: {
        checks: list.checks.map(publicCheck),
        skipped: list.skipped,
        sweep
      }
    }
  })

  /** Count + newest rows for ONE link, now (a request-sized scan, time-boxed). */
  app.get('/check', async (req, reply) => {
    const { key } = req.query as { key?: string }
    const check = key ? await findCheck(key) : null
    if (!check) return reply.code(404).send({ error: 'No such link' })
    const signal = clientGoneSignal(reply.raw)
    try {
      const result = await withReadGate(
        req.user?.id,
        () => inspectCheck(check, { timeoutMs: CHECK_TIMEOUT_MS, signal, sample: 25 }),
        { signal, label: 'orphans:check' }
      )
      return { data: result }
    } catch (err) {
      return reply.code(503).send({ error: describeScanError(err), code: 'ORPHAN_SCAN_FAILED' })
    }
  })

  app.post('/sweep', async (req, reply) => {
    const { started, state } = await startSweep(redis(), req.user!.id)
    if (!started)
      return reply.code(409).send({ error: 'A sweep is already running', data: liveState(state) })
    return reply.code(202).send({ data: state })
  })

  app.post('/sweep/cancel', async (req, reply) => {
    const store = sweepStore(redis())
    const s = await store.load()
    if (s?.status !== 'running') return reply.code(409).send({ error: 'No sweep is running' })
    await store.cancel(s.id)
    await logActivity({
      action: 'orphan-sweep-stop',
      user: req.user?.id,
      comment: `Stopped the orphan sweep after ${s.done} of ${s.total} links`,
      req
    })
    return { data: { id: s.id } }
  })

  /**
   * What an action would do: the rows that still dangle now (of the ids given, or the
   * newest ones), why it may not run, and the plan hash apply must quote.
   */
  app.post('/preview', async (req, reply) => {
    const b = (req.body ?? {}) as { key?: string; action?: unknown; ids?: unknown }
    if (!isAction(b.action)) return reply.code(400).send({ error: "action is 'clear' or 'delete'" })
    const check = b.key ? await findCheck(b.key) : null
    if (!check) return reply.code(404).send({ error: 'No such link' })
    const refusal = actionRefusal(check, b.action)
    if (refusal) return reply.code(422).send({ error: refusal, code: 'ORPHAN_ACTION_REFUSED' })
    let ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, MAX_IDS) : null
    if (!ids) {
      const signal = clientGoneSignal(reply.raw)
      const r = await withReadGate(
        req.user?.id,
        () => inspectCheck(check, { timeoutMs: CHECK_TIMEOUT_MS, signal, sample: MAX_IDS }),
        { signal, label: 'orphans:preview' }
      ).catch(() => null)
      if (!r) return reply.code(503).send({ error: 'Could not read the rows in time' })
      ids = r.samples.map((s) => s.id)
    }
    const rows = await stillOrphaned(check, ids)
    return {
      data: {
        key: check.key,
        action: b.action,
        ids: rows,
        gone: ids.length - rows.length,
        plan_hash: planHash(check.key, b.action, rows),
        sentence:
          b.action === 'clear'
            ? `Empty ${check.field} on ${rows.length} ${check.child} row(s); each change is saved as you, with history.`
            : `Delete ${rows.length} ${check.child} link row(s) whose ${check.fk} points at a missing ${check.parent} record; deleted rows go to the trash where the table has one.`
      }
    }
  })

  /** Run a previewed action, row by row through the items service, as the admin. */
  app.post('/apply', async (req, reply) => {
    const b = (req.body ?? {}) as {
      key?: string
      action?: unknown
      ids?: unknown
      plan_hash?: unknown
    }
    if (!isAction(b.action)) return reply.code(400).send({ error: "action is 'clear' or 'delete'" })
    const check = b.key ? await findCheck(b.key) : null
    if (!check) return reply.code(404).send({ error: 'No such link' })
    const refusal = actionRefusal(check, b.action)
    if (refusal) return reply.code(422).send({ error: refusal, code: 'ORPHAN_ACTION_REFUSED' })
    const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, MAX_IDS) : []
    if (ids.length === 0) return reply.code(400).send({ error: 'ids are required' })
    if (planHash(check.key, b.action, ids) !== b.plan_hash)
      return reply
        .code(409)
        .send({ error: 'The rows changed since the preview; preview again', code: 'STALE_PLAN' })
    // Re-derived now: a row someone fixed since the preview is left alone.
    const live = await stillOrphaned(check, ids)
    const user = req.user!
    const done: string[] = []
    const failed: Array<{ id: string; reason: string }> = []
    for (const id of live) {
      try {
        if (b.action === 'clear')
          await updateOne(user, check.child, id, { [check.field]: null }, req)
        else await deleteOne(user, check.child, id, req)
        done.push(id)
      } catch (err) {
        failed.push({ id, reason: String((err as Error)?.message ?? 'Refused').slice(0, 200) })
      }
    }
    await logActivity({
      action: b.action === 'clear' ? 'orphan-clear' : 'orphan-delete',
      user: user.id,
      collection: check.child,
      comment: `${b.action === 'clear' ? `Emptied ${check.field} on` : 'Deleted'} ${done.length} row(s) of ${check.child} pointing at missing ${check.parent} records${failed.length ? ` (${failed.length} refused)` : ''}${live.length < ids.length ? `; ${ids.length - live.length} already fixed` : ''}. Ids: ${done.slice(0, 50).join(', ')}${done.length > 50 ? ', …' : ''}`,
      req
    })
    return {
      data: { done: done.length, failed, already_fixed: ids.length - live.length, ids: done }
    }
  })
}
