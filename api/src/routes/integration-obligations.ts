/**
 * Integration obligations — read routes.
 *
 * The BOARD (summary + list) is an operational view across every record on
 * the instance and is admin, same posture as /integration-health. The
 * per-RECORD read is gated on the caller's own read permission for that
 * collection instead — exactly like /config-conformance/record/:c/:id —
 * because the record banner and Ask AI have to work for whoever owns the
 * record, not just admins.
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { selectInChunks } from '../services/db-batch.js'
import { registerIntegrationNoteSources } from '../services/integration-notes.js'
import {
  allObligationKinds,
  listObligationKinds,
  summariseObligations
} from '../services/integration-obligations.js'
import { can } from '../services/permissions.js'
import { registerReadinessCheck } from '../services/readiness.js'

const MAX_LIMIT = 200
const RECORD_CAP = 50
const SUMMARY_ID_CAP = 500

// The core integration-obligations readiness check. WARN once any
// overdue/missing row exists; FAIL only once a `missing` row — one whose
// trigger never fired at all — has sat unmet for more than a day, since
// `overdue` has already been through the reconcile sweep's own grace
// window and being old is not itself worse.
//
// Registered from the route plugin (same pattern as
// registerIntegrationReadiness() in routes/external-apis.ts), NOT from
// server.ts's onReady — that hook only exists in self-hosted mode
// (`if (!process.env.CLOUD_META_DB_URL)`), so a check registered there
// never shows up on a cloud deployment. Route plugins register regardless
// of mode.
let readinessRegistered = false
function registerIntegrationObligationsReadiness(): void {
  if (readinessRegistered) return
  readinessRegistered = true
  registerReadinessCheck({
    id: 'integration-obligations-health',
    label: 'Integration obligations',
    group: 'Integrations',
    description:
      'Messages a partner should have received and has not. Overdue or missing in the last 24 hours is a warning; a "missing" message — one whose trigger never fired at all — unmet for over a day is a failure.',
    run: async () => {
      if (listObligationKinds().length === 0) {
        return { status: 'pass', detail: 'no obligation kinds registered' }
      }
      const day = new Date(Date.now() - 86_400_000)
      const rows = (await db('nivaro_integration_obligations')
        .whereIn('outcome', ['overdue', 'missing'])
        .select('api', 'kind', 'outcome')
        .count({ c: '*' })
        .min({ oldest: 'due_at' })
        .groupBy('api', 'kind', 'outcome')) as Array<{
        api: string
        kind: string
        outcome: string
        c: number
        oldest: Date | null
      }>
      if (rows.length === 0) {
        return { status: 'pass', detail: 'Every obligation is met or in flight.' }
      }
      const total = rows.reduce((a, r) => a + Number(r.c), 0)
      const staleMissing = rows.filter(
        (r) => r.outcome === 'missing' && r.oldest && new Date(r.oldest) < day
      )
      const blockers = rows.map(
        (r) =>
          `${r.api}/${r.kind}: ${r.c} ${r.outcome}${
            r.oldest ? ` (oldest ${new Date(r.oldest).toISOString().slice(0, 16)})` : ''
          }`
      )
      return staleMissing.length > 0
        ? {
            status: 'fail',
            detail: `${total} unmet obligation(s); ${staleMissing.length} "missing" group(s) older than 24 hours.`,
            blockers
          }
        : {
            status: 'warn',
            detail: `${total} unmet obligation(s) in the last 24 hours.`,
            blockers
          }
    }
  })
}

// The Notes-thread note source, one relatedNoteRegistry provider per
// collection that has an obligation kind. Registered from THIS plugin (same
// "never server.ts's self-hosted-only onReady" reasoning as the readiness
// check above), but unlike the readiness check it can't just register a
// static definition and defer the DB read to a later "run" callback — it
// needs allObligationKinds() to already be POPULATED at the moment it
// builds the provider list, and this plugin registers before
// loadExtensions()/loadCloudExtensions() run (routes/index.ts registers at
// line ~294, both extension loaders run afterward in server.ts). So the
// registration itself is deferred with `app.addHook('onReady', ...)` — the
// same pattern routes/sync-jobs.ts already uses — which fires once, after
// the WHOLE app's plugin tree (every extension loader included) has
// finished registering, regardless of which plugin scope added the hook and
// regardless of cloud vs self-hosted mode, since this plugin itself
// registers unconditionally.
let noteSourcesRegistered = false
function registerIntegrationObligationsNoteSources(app: FastifyInstance): void {
  if (noteSourcesRegistered) return
  noteSourcesRegistered = true
  app.addHook('onReady', async () => {
    registerIntegrationNoteSources(allObligationKinds().map((k) => k.collection))
  })
}

export async function integrationObligationsRoutes(app: FastifyInstance): Promise<void> {
  registerIntegrationObligationsReadiness()
  registerIntegrationObligationsNoteSources(app)

  // The board: admin-only, matching /integration-health.
  app.get('/integration-obligations/summary', { preHandler: requireAdmin }, async () => {
    const rows = (await db('nivaro_integration_obligations')
      .select('api', 'outcome')
      .count({ c: '*' })
      .min({ oldest: 'due_at' })
      .groupBy('api', 'outcome')) as Array<{
      api: string
      outcome: string
      c: number
      oldest: Date | null
    }>
    const apiRows = (await db('nivaro_external_apis').select('name', 'owner_user')) as Array<{
      name: string
      owner_user: string | null
    }>
    const owners: Record<string, string | null> = {}
    for (const a of apiRows) owners[a.name] = a.owner_user
    // Task 19 — a read the board already makes once, never a second probe
    // per row: the Send-now button shows/hides on this, and reports "off"
    // rather than looking broken while the deployment switch is off.
    const { remediationEnabled } = await import('../services/integration-remediation.js')
    return {
      data: {
        apis: summariseObligations(rows, owners),
        kinds: listObligationKinds(),
        remediation_enabled: await remediationEnabled()
      }
    }
  })

  // Which collections have ANY registered obligation kind — a cheap,
  // long-cacheable probe so the collection browser and queue columns know
  // whether to even ask for a given collection, the same "probe once, don't
  // ask per row" shape as the at-risk rules query on a collection. The
  // registry is in-process, so this is not a database read.
  app.get('/integration-obligations/collections', { preHandler: requireAuth }, async () => {
    return { data: [...new Set(allObligationKinds().map((k) => k.collection))] }
  })

  // Per-record summary for a PAGE of rows (collection browser / queue
  // columns): every non-superseded ledger row across the page's ids, one
  // query. Gated on the caller's own read permission for the collection —
  // same posture as the record-ledger read below, not the admin board.
  app.post<{ Body: { collection?: string; ids?: string[] } }>(
    '/integration-obligations/summary',
    { preHandler: requireAuth },
    async (req, reply) => {
      const collection = String(req.body?.collection ?? '')
      const ids = (req.body?.ids ?? []).map(String).filter(Boolean).slice(0, SUMMARY_ID_CAP)
      if (!collection || ids.length === 0) return { data: {} }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const rows = (await selectInChunks(ids, 2000, (chunk) =>
        db('nivaro_integration_obligations')
          .where({ collection })
          .whereIn('item', chunk)
          .whereNot({ outcome: 'superseded' })
          .select('item', 'api', 'outcome')
      )) as Array<{ item: string; api: string; outcome: string }>
      const out: Record<string, Array<{ api: string; outcome: string }>> = {}
      for (const r of rows) (out[r.item] ??= []).push({ api: r.api, outcome: r.outcome })
      return { data: out }
    }
  )

  app.get<{
    Querystring: {
      api?: string
      kind?: string
      collection?: string
      outcome?: string
      age_hours?: string
      page?: string
      limit?: string
    }
  }>('/integration-obligations', { preHandler: requireAdmin }, async (req) => {
    const q = req.query
    const page = Math.max(1, Number(q.page) || 1)
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || 50))
    const base = db('nivaro_integration_obligations')
    // `api` is filtered by name — the ledger stores the resolved name, never
    // the numeric id an action may have been configured with.
    if (q.api) base.where({ api: q.api })
    if (q.kind) base.where({ kind: q.kind })
    if (q.collection) base.where({ collection: q.collection })
    if (q.outcome) {
      const list = q.outcome
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (list.length > 0) base.whereIn('outcome', list)
    }
    if (q.age_hours) {
      const hours = Number(q.age_hours)
      if (Number.isFinite(hours) && hours > 0) {
        base.where('due_at', '<', new Date(Date.now() - hours * 3_600_000))
      }
    }
    const [{ total }] = (await base.clone().count({ total: '*' })) as Array<{ total: number }>
    const rows = await base
      .clone()
      .orderBy('due_at', 'desc')
      .offset((page - 1) * limit)
      .limit(limit)
      .select(
        'id',
        'api',
        'kind',
        'collection',
        'item',
        'trigger',
        'trigger_ref',
        'due_at',
        'outcome',
        'reason',
        'submission_id',
        'resolved_at'
      )
    return { data: rows, total: Number(total) || 0, page, limit }
  })

  // One record's ledger, newest first. NOT admin-only — gated on the
  // caller's read permission for the record's own collection, so it works
  // for whoever the record belongs to.
  app.get<{ Params: { collection: string; item: string } }>(
    '/integration-obligations/record/:collection/:item',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      // Rides ix_integration_obligations_record (collection, item, kind, id
      // DESC) — order by id, not due_at, so the index actually serves it.
      const rows = await db('nivaro_integration_obligations')
        .where({ collection, item: String(item) })
        .orderBy('id', 'desc')
        .limit(RECORD_CAP)
        .select(
          'id',
          'api',
          'kind',
          'trigger',
          'due_at',
          'outcome',
          'reason',
          'submission_id',
          'resolved_at'
        )
      // Task 19 — a read this banner already makes once per record, never a
      // second probe per row: same reasoning as /summary above.
      const { remediationEnabled } = await import('../services/integration-remediation.js')
      return { data: rows, remediation_enabled: await remediationEnabled() }
    }
  )

  // Send now (Task 19, admin-only, gated on integration_remediation_enabled
  // — read via remediationEnabled() so this route can never disagree with
  // /summary and /record about whether the feature is on): re-sends the
  // obligation's own submission, or — for a `missing` row, which by
  // definition has none of its own — the most recent request ever made for
  // this record on this API. Always a two-click confirm in the UI; this
  // route itself is a single POST, the confirm lives client-side.
  app.post<{ Params: { id: string } }>(
    '/integration-obligations/:id/send',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const { sendNow, remediationEnabled, isClosedOutcome } = await import(
        '../services/integration-remediation.js'
      )
      // Checked here FIRST, before even reading the row — the whole point
      // is that the button says so rather than looking broken, regardless
      // of whether the id it was clicked on happens to exist.
      if (!(await remediationEnabled())) {
        return { data: { detail: 'remediation is off for this deployment' } }
      }
      if (!Number.isFinite(id)) {
        return reply.code(404).send({ error: 'No such obligation' })
      }
      const row = (await db('nivaro_integration_obligations')
        .where({ id })
        .first('id', 'outcome')) as { id: number; outcome: string } | undefined
      if (!row) return reply.code(404).send({ error: 'No such obligation' })
      // A genuine conflict — the ledger already considers this one done, so
      // "send it again" is not a question with a sensible answer. Anything
      // still OPEN (incl. `missing`, which sendNow handles by re-firing the
      // most recent request for the record) reaches sendNow below.
      if (isClosedOutcome(row.outcome)) {
        return reply
          .code(409)
          .send({ error: `already ${row.outcome} — there is nothing to send` })
      }
      const r = await sendNow(id, req.user?.id ?? null)
      await logActivity({
        action: 'integration-send-now',
        collection: 'nivaro_integration_obligations',
        item: req.params.id,
        user: req.user?.id ?? null,
        comment: r.detail
      })
      return { data: r }
    }
  )
}
