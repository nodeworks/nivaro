import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'
import { runConformance, summarizeAllCollections } from '../services/config-conformance.js'
import { updateOne } from '../services/items.js'

/** Config conformance runs — admin-only, access-audit execution model:
 *  fire-and-forget run, pollable status, findings paged per run. */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Record-scoped integrity lookup — authenticated (not admin): the banner on
 *  a record form is for whoever can read the record. Separate plugin because
 *  the main router is requireAdmin-hooked. */
export async function configConformanceRecordRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { collection: string; id: string } }>(
    '/record/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!IDENT.test(collection) || /^nivaro_|^directus_/i.test(collection)) {
        return reply.code(400).send({ error: 'Invalid collection' })
      }
      const meta = (await db('nivaro_collections')
        .where({ collection })
        .first('integrity_badge')) as { integrity_badge?: unknown } | undefined
      // Toggle off = the banner has nothing to say, deliberately.
      if (meta && meta.integrity_badge === false) return { data: { enabled: false, findings: [] } }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const run = (await db('nivaro_conformance_runs')
        .where({ collection, status: 'completed' })
        .orderBy('id', 'desc')
        .first('id', 'finished_at')) as { id: number; finished_at: Date | null } | undefined
      if (!run) return { data: { enabled: true, findings: [] } }
      const findings = (await db('nivaro_conformance_findings')
        .where({ run: run.id, item_id: String(id) })
        .select('field', 'rule', 'message')) as Array<{
        field: string | null
        rule: string
        message: string
      }>
      // Annotate which findings the Fix button can actually repair: a stale
      // cascade value can be cleared, and an empty display-template part
      // backed by an auto_id config can be regenerated. required/validation
      // need a human value — never auto-fixable.
      const { autoIdFieldsFor } = await import('../services/auto-ids.js')
      const autoIds = new Set((await autoIdFieldsFor(db, collection)).map((f) => f.field))
      // Cascade clears only work on PHYSICAL columns — an M2M alias PATCHed
      // to null is silently stripped by updateOne, so offering Fix there
      // would be a lie.
      const physical = new Set(
        (
          (await db('information_schema.columns')
            .where({ table_name: collection })
            .pluck('column_name')
            .catch(() => [])) as string[]
        ).map((c) => c.toLowerCase())
      )
      return {
        data: {
          enabled: true,
          run_id: run.id,
          checked_at: run.finished_at,
          findings: findings.map((f) => ({
            ...f,
            fixable:
              (f.rule === 'cascade' && !!f.field && physical.has(f.field.toLowerCase())) ||
              (f.rule === 'display' && !!f.field && autoIds.has(f.field))
          }))
        }
      }
    }
  )

  /** Auto-fix one finding (#record-integrity ask): cascade → clear the stale
   *  value; display+auto_id → regenerate the id (fresh sequence when empty,
   *  prefix recompute otherwise). Both write THROUGH updateOne so RBAC,
   *  validation, hooks, and revisions all apply. */
  app.post<{
    Params: { collection: string; id: string }
    Body: { field?: string; rule?: string }
  }>('/record/:collection/:id/fix', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, id } = req.params
    const field = String(req.body?.field ?? '')
    const rule = String(req.body?.rule ?? '')
    if (!IDENT.test(collection) || /^nivaro_|^directus_/i.test(collection) || !IDENT.test(field)) {
      return reply.code(400).send({ error: 'Invalid collection or field' })
    }
    if (!(await can(req.user!, 'update', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (rule === 'cascade') {
      const isPhysical = (
        (await db('information_schema.columns')
          .where({ table_name: collection, column_name: field })
          .pluck('column_name')
          .catch(() => [])) as string[]
      ).length > 0
      if (!isPhysical) {
        return reply
          .code(400)
          .send({ error: 'Linked-list fields must be corrected on the record itself.' })
      }
      await updateOne(req.user!, collection, id, { [field]: null })
      await logActivity({
        action: 'integrity-fix',
        user: req.user?.id,
        collection,
        item: String(id),
        comment: `cleared stale cascade value on ${field}`,
        req
      })
      return { data: { fixed: true, action: 'cleared' } }
    }
    if (rule === 'display') {
      const { autoIdFieldsFor, applyAutoIdsExt, recomputeAutoIdPrefix } = await import(
        '../services/auto-ids.js'
      )
      const cfg = (await autoIdFieldsFor(db, collection)).find((f) => f.field === field)
      if (!cfg) {
        return reply
          .code(400)
          .send({ error: 'This field has no ID pattern — set the value by hand instead.' })
      }
      const row = ((await db(collection).where({ id }).first()) ?? {}) as Record<string, unknown>
      const current = row[field]
      let value: string | null = null
      if (current == null || String(current).trim() === '') {
        // Empty — generate fresh, exactly like create-time would have.
        const payload: Record<string, unknown> = { ...row }
        delete payload[field]
        await applyAutoIdsExt(db, collection, payload)
        value = payload[field] != null ? String(payload[field]) : null
      } else {
        value = await recomputeAutoIdPrefix(db, collection, field, cfg.config, id, row)
      }
      if (!value || value === String(current ?? '')) {
        return reply
          .code(400)
          .send({ error: 'Could not regenerate — the pattern did not resolve for this record.' })
      }
      await updateOne(req.user!, collection, id, { [field]: value })
      await logActivity({
        action: 'integrity-fix',
        user: req.user?.id,
        collection,
        item: String(id),
        comment: `regenerated ${field} → ${value}`,
        req
      })
      return { data: { fixed: true, action: 'regenerated', value } }
    }
    return reply.code(400).send({ error: 'This finding cannot be auto-fixed.' })
  })
}

export async function configConformanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  // ── Nightly schedules ─────────────────────────────────────────────────────
  /** Validation-rule change impact: how many existing records would NEWLY
   *  fail if this field's rules became the proposed set. Same evaluator the
   *  save path uses (a preview that disagrees with enforcement is worse than
   *  none). Date-offset rules are judged against the record's creation date,
   *  exactly like the conformance sweep. */
  app.post('/impact', async (req, reply) => {
    const b = req.body as {
      collection?: string
      field?: string
      proposed_rules?: unknown
      required?: boolean
      limit?: number
    }
    const collection = String(b.collection ?? '')
    const field = String(b.field ?? '')
    if (!/^[A-Za-z0-9_]+$/.test(collection) || !/^[A-Za-z0-9_]+$/.test(field)) {
      return reply.code(400).send({ error: 'collection and field are required' })
    }
    const { previewValidationImpact } = await import('../services/config-conformance.js')
    try {
      const result = await previewValidationImpact(collection, field, {
        proposedRules: Array.isArray(b.proposed_rules) ? (b.proposed_rules as never) : [],
        proposedRequired: b.required === true,
        limit: Math.min(20_000, Math.max(100, Number(b.limit) || 5000))
      })
      return { data: result }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/schedules', async () => {
    return { data: await db('nivaro_conformance_schedules').orderBy('collection') }
  })

  app.put<{ Params: { collection: string } }>('/schedules/:collection', async (req, reply) => {
    const { collection } = req.params
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const b = req.body as { is_active?: boolean; row_cap?: number }
    const existing = await db('nivaro_conformance_schedules').where({ collection }).first('id')
    if (existing) {
      await db('nivaro_conformance_schedules')
        .where({ collection })
        .update({
          is_active: b.is_active !== false,
          row_cap: Math.max(0, Number(b.row_cap ?? 0) || 0)
        })
    } else {
      await db('nivaro_conformance_schedules').insert({
        collection,
        is_active: b.is_active !== false,
        row_cap: Math.max(0, Number(b.row_cap ?? 0) || 0),
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
    }
    await logActivity({
      action: 'conformance-schedule',
      user: req.user?.id,
      collection: 'nivaro_conformance_schedules',
      item: collection,
      comment: b.is_active !== false ? 'nightly on' : 'nightly off',
      req
    })
    return { data: await db('nivaro_conformance_schedules').where({ collection }).first() }
  })

  /** Bulk remediation: clear the offending values behind a run's findings for
   *  one field+rule, through the items service (RBAC/hooks/revisions apply —
   *  every clear is an audited write attributed to the admin). */
  app.post<{ Params: { id: string } }>('/runs/:id/remediate', async (req, reply) => {
    const run = await db('nivaro_conformance_runs').where('id', req.params.id).first()
    if (!run) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as { field?: string; rule?: string; action?: string }
    if (b.action !== 'clear' || !b.field || !IDENT.test(b.field)) {
      return reply.code(400).send({ error: 'action=clear and a valid field are required' })
    }
    // Only value-holding rules are clearable; a required-empty finding has
    // nothing to clear.
    if (b.rule && !['cascade', 'validation', 'display'].includes(b.rule)) {
      return reply.code(400).send({ error: `Rule "${b.rule}" is not clearable` })
    }
    const findings = (await db('nivaro_conformance_findings')
      .where({ run: run.id, field: b.field })
      .modify((qb) => {
        if (b.rule) qb.where('rule', b.rule)
      })
      .select('item_id')) as Array<{ item_id: string }>
    const ids = [...new Set(findings.map((f) => f.item_id))].slice(0, 1000)
    let cleared = 0
    let failed = 0
    for (const id of ids) {
      try {
        await updateOne(req.user!, String(run.collection), id, { [b.field]: null })
        cleared++
      } catch {
        failed++
      }
    }
    await logActivity({
      action: 'conformance-remediate',
      user: req.user?.id,
      collection: String(run.collection),
      comment: `cleared ${b.field} on ${cleared} record(s) from run #${run.id}${failed ? ` (${failed} failed)` : ''}`,
      req
    })
    return { data: { cleared, failed, total: ids.length } }
  })

  /** Which collections have anything to check, with per-kind counts — the
   *  picker only offers collections where a run can find something. */
  app.get('/collections', async () => {
    const [rows, summaries] = await Promise.all([
      db('nivaro_collections')
        .whereRaw("collection NOT LIKE 'nivaro\\_%' ESCAPE '\\'")
        .whereRaw("collection NOT LIKE 'directus\\_%' ESCAPE '\\'")
        .select('collection', 'display_name') as Promise<
        Array<{ collection: string; display_name: string | null }>
      >,
      summarizeAllCollections()
    ])
    const out = rows
      .filter((r) => IDENT.test(r.collection))
      .map((r) => {
        const s = summaries.get(r.collection)
        if (!s || s.required + s.validation + s.cascade === 0) return null
        return { display_name: r.display_name, ...s }
      })
      .filter(Boolean)
      .sort((a, b) => String(a?.collection).localeCompare(String(b?.collection)))
    return { data: out }
  })

  app.get('/runs', async (req) => {
    const q = req.query as { collection?: string; limit?: string }
    const rows = await db('nivaro_conformance_runs as r')
      .leftJoin('nivaro_users as u', 'u.id', 'r.triggered_by')
      .modify((qb) => {
        if (q.collection) qb.where('r.collection', q.collection)
      })
      .orderBy('r.id', 'desc')
      .limit(Math.min(Number(q.limit ?? 20) || 20, 100))
      .select('r.*', 'u.first_name as triggered_by_first', 'u.last_name as triggered_by_last')
    return {
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        triggered_by_name:
          [r.triggered_by_first, r.triggered_by_last].filter(Boolean).join(' ') || null
      }))
    }
  })

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = await db('nivaro_conformance_runs').where('id', req.params.id).first()
    if (!run) return reply.code(404).send({ error: 'Not found' })
    const q = req.query as {
      page?: string
      limit?: string
      rule?: string
      field?: string
      group?: string
    }
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200)
    const page = Math.max(1, Number(q.page ?? 1) || 1)
    const base = () =>
      db('nivaro_conformance_findings')
        .where('run', run.id)
        .modify((qb) => {
          if (q.rule) qb.where('rule', q.rule)
          if (q.field) qb.where('field', q.field)
        })
    let findings: unknown[]
    let counted: { c?: unknown } | undefined
    if (q.group === 'record') {
      // Grouped mode: page over RECORDS (worst first), then fetch each page
      // record's full finding set — a record's issues must never split
      // across pages.
      const items = (await base()
        .groupBy('item_id')
        .count({ c: '*' })
        .select('item_id')
        .orderByRaw('count(*) desc, item_id asc')
        .offset((page - 1) * limit)
        .limit(limit)) as Array<{ item_id: string; c: number }>
      const itemIds = items.map((i) => i.item_id)
      const rows =
        itemIds.length === 0
          ? []
          : await base().whereIn('item_id', itemIds).orderBy('id', 'asc')
      findings = itemIds.map((id) => ({
        item_id: id,
        item_label: rows.find((r: { item_id: string }) => r.item_id === id)?.item_label ?? null,
        count: Number(items.find((i) => i.item_id === id)?.c ?? 0),
        findings: rows.filter((r: { item_id: string }) => r.item_id === id)
      }))
      const groupCount = (await base()
        .countDistinct({ c: 'item_id' })
        .first()) as { c?: unknown } | undefined
      counted = groupCount
    } else {
      findings = await base()
        .orderBy('id', 'asc')
        .offset((page - 1) * limit)
        .limit(limit)
      counted = (await base().count({ c: '*' }).first()) as { c?: unknown } | undefined
    }
    const stored = await db('nivaro_conformance_findings')
      .where('run', run.id)
      .count({ c: '*' })
      .first()
    // Facet chips come from the run's FULL totals (counted in memory over
    // every violation) — the stored findings rows are only a browsable
    // sample once the cap hits, and chips built from them under-reported.
    const parse = (raw: unknown): Record<string, number> => {
      try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw
        return v && typeof v === 'object' ? (v as Record<string, number>) : {}
      } catch {
        return {}
      }
    }
    const ruleTotals = parse(run.rule_counts)
    const fieldTotals = parse(run.field_counts)
    const byRule = Object.keys(ruleTotals).length
      ? Object.entries(ruleTotals).map(([rule, c]) => ({ rule, c }))
      : await db('nivaro_conformance_findings')
          .where('run', run.id)
          .groupBy('rule')
          .count({ c: '*' })
          .select('rule')
    const byField = Object.keys(fieldTotals).length
      ? Object.entries(fieldTotals)
          .map(([field, c]) => ({ field, c }))
          .sort((a, b) => Number(b.c) - Number(a.c))
      : await db('nivaro_conformance_findings')
          .where('run', run.id)
          .groupBy('field')
          .count({ c: '*' })
          .select('field')
    return {
      data: {
        run,
        findings,
        total: Number(counted?.c ?? 0),
        stored_total: Number(stored?.c ?? 0),
        page,
        limit,
        by_rule: byRule,
        by_field: byField
      }
    }
  })

  app.post<{ Params: { collection: string } }>('/:collection/run', async (req, reply) => {
    const { collection } = req.params
    if (!IDENT.test(collection) || /^nivaro_|^directus_/i.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const registered = await db('nivaro_collections').where({ collection }).first('id')
    if (!registered) return reply.code(404).send({ error: 'Collection not registered' })
    const running = await db('nivaro_conformance_runs')
      .where({ collection, status: 'running' })
      .first('id')
    if (running) {
      return reply.code(409).send({ error: 'A run is already in progress for this collection' })
    }
    // limit 0 = the whole collection (long run — fire-and-forget + progress
    // polling make that fine); otherwise clamp to 50k.
    const rawLimit = Number((req.body as { limit?: number })?.limit ?? 5000)
    const limit = rawLimit === 0 ? Number.MAX_SAFE_INTEGER : Math.min(rawLimit || 5000, 50000)
    const [inserted] = await db('nivaro_conformance_runs')
      .insert({
        collection,
        status: 'running',
        triggered_by: req.user?.id ?? null,
        // Explicit JS UTC — the access-audit lesson: a GETDATE() default is
        // LOCAL time and makes every duration read hours long.
        started_at: new Date()
      })
      .returning('id')
    const runId = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({
      action: 'conformance-run',
      user: req.user?.id,
      collection: 'nivaro_conformance_runs',
      item: String(runId),
      comment: collection,
      req
    })
    // Fire and forget — the UI polls the run row.
    void runConformance(Number(runId), collection, limit)
    return reply.code(202).send({ data: { id: runId, status: 'running' } })
  })
}
