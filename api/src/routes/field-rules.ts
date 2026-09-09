import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  evaluateRowRules,
  evaluateRulesForTrigger,
  type RowRule,
  VALID_OPS,
  VALID_TARGET_TYPES,
  validateDynamicConfig,
  RowRuleLookupCache,
  type RowRuleTraceEntry
} from '../services/field-rules.js'
import { applyFieldRules, updateOne } from '../services/items.js'
import { recordRuleEvalSample, ruleEvalStats } from '../services/field-rules-stats.js'
import { can } from '../services/permissions.js'

interface FieldRuleBody {
  collection?: string
  trigger_field?: string
  trigger_op?: string
  trigger_value?: string | null
  target_field?: string
  target_type?: string
  target_value?: string | null
  only_when_empty?: boolean
  dynamic_config?: string | Record<string, unknown> | null
  sort?: number
  is_active?: boolean
}

// dynamic_config may arrive as an object (admin UI) or a JSON string — always
// stored as text.
function normalizeDynamicConfig(v: FieldRuleBody['dynamic_config']): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

export async function fieldRulesRoutes(app: FastifyInstance) {
  // GET /field-rules?collection=xxx — list rules for a collection
  app.get<{ Querystring: { collection?: string } }>(
    '/',
    { preHandler: authenticate },
    async (req, reply) => {
      const collection = req.query.collection
      const q = db('nivaro_field_rules').orderBy('sort', 'asc').orderBy('id', 'asc')
      if (collection) q.where({ collection })
      const rows = await q.select('*')
      return reply.send({ data: rows })
    }
  )

  // POST /field-rules — create rule (admin only)
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as FieldRuleBody

    if (!body.collection || body.trigger_field == null || body.target_field == null) {
      return reply
        .code(400)
        .send({ error: 'collection, trigger_field and target_field are required' })
    }

    const trigger_op = body.trigger_op ?? 'eq'
    if (!VALID_OPS.has(trigger_op)) {
      return reply.code(400).send({ error: `Invalid trigger_op "${trigger_op}"` })
    }

    const target_type = body.target_type ?? 'set'
    if (!VALID_TARGET_TYPES.has(target_type)) {
      return reply.code(400).send({ error: `Invalid target_type "${target_type}"` })
    }

    const dynamicConfigError = validateDynamicConfig(target_type, body.dynamic_config)
    if (dynamicConfigError) {
      return reply.code(400).send({ error: dynamicConfigError })
    }

    const insert = {
      collection: body.collection,
      trigger_field: body.trigger_field,
      trigger_op,
      trigger_value: body.trigger_value ?? null,
      target_field: body.target_field,
      target_type,
      target_value: target_type === 'clear' ? null : (body.target_value ?? null),
      only_when_empty: body.only_when_empty ?? false,
      dynamic_config: normalizeDynamicConfig(body.dynamic_config),
      sort: body.sort ?? 0,
      is_active: body.is_active ?? true,
      created_by: req.user?.id ?? null,
      created_at: new Date()
    }

    const rows = (await db('nivaro_field_rules').insert(insert).returning('id')) as unknown[]
    const idRow = rows[0] as { id: number } | number
    const id = typeof idRow === 'object' && idRow !== null ? (idRow as { id: number }).id : idRow

    const created = await db('nivaro_field_rules').where({ id }).first()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_field_rules',
      item: String(id),
      req
    })
    return reply.code(201).send({ data: created })
  })

  // PATCH /field-rules/:id — update rule (admin only)
  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_field_rules').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body as FieldRuleBody
      const patch: Record<string, unknown> = {}

      if (body.trigger_field != null) patch.trigger_field = body.trigger_field
      if (body.trigger_op != null) {
        if (!VALID_OPS.has(body.trigger_op)) {
          return reply.code(400).send({ error: `Invalid trigger_op "${body.trigger_op}"` })
        }
        patch.trigger_op = body.trigger_op
      }
      if ('trigger_value' in body) patch.trigger_value = body.trigger_value ?? null
      if (body.target_field != null) patch.target_field = body.target_field
      if (body.target_type != null) {
        if (!VALID_TARGET_TYPES.has(body.target_type)) {
          return reply.code(400).send({ error: `Invalid target_type "${body.target_type}"` })
        }
        patch.target_type = body.target_type
      }
      if ('target_value' in body) patch.target_value = body.target_value ?? null
      if (body.only_when_empty != null) patch.only_when_empty = body.only_when_empty
      if (body.sort != null) patch.sort = body.sort
      if (body.is_active != null) patch.is_active = body.is_active

      // Clearing target type means no literal value is stored
      const effectiveType = (patch.target_type ?? existing.target_type) as string
      if (effectiveType === 'clear') patch.target_value = null

      // Validate dynamic_config against the effective (patched or existing) target_type.
      // Required+shape-checked for set_lookup/set_from_trigger; forbidden (and cleared) otherwise.
      if (effectiveType === 'set_lookup' || effectiveType === 'set_from_trigger') {
        const effectiveDynamicConfig =
          'dynamic_config' in body ? body.dynamic_config : existing.dynamic_config
        const dynamicConfigError = validateDynamicConfig(effectiveType, effectiveDynamicConfig)
        if (dynamicConfigError) {
          return reply.code(400).send({ error: dynamicConfigError })
        }
        if ('dynamic_config' in body)
          patch.dynamic_config = normalizeDynamicConfig(body.dynamic_config)
      } else {
        patch.dynamic_config = null
      }

      if (Object.keys(patch).length > 0) {
        await db('nivaro_field_rules').where({ id }).update(patch)
      }

      const updated = await db('nivaro_field_rules').where({ id }).first()
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_field_rules',
        item: String(id),
        req
      })
      return reply.send({ data: updated })
    }
  )

  // DELETE /field-rules/:id — delete rule (admin only)
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_field_rules').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_field_rules').where({ id }).delete()
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_field_rules',
        item: String(id),
        req
      })
      return reply.code(204).send()
    }
  )

  // POST /field-rules/evaluate — evaluate rules for a payload without saving.
  //
  // Two request shapes share this path: the legacy row_rules/data shape (below)
  // used by ItemEditForm's O2M/repeater row cascades, and the newer
  // trigger_field/trigger_value/draft shape used for dynamic (set_lookup /
  // set_from_trigger) cascading auto-fill against stored nivaro_field_rules.
  // The two never overlap on required keys, so dispatch is unambiguous.
  app.post('/evaluate', { preHandler: authenticate }, async (req, reply) => {
    const rawBody = req.body as Record<string, unknown>

    if ('trigger_field' in rawBody || 'draft' in rawBody) {
      const evalBody = rawBody as {
        collection?: string
        trigger_field?: string
        trigger_value?: unknown
        draft?: Record<string, unknown>
      }
      const { collection, trigger_field } = evalBody
      if (!collection || !trigger_field) {
        return reply.code(400).send({ error: 'collection and trigger_field are required' })
      }

      // Registry gate: collection must be a REGISTERED nivaro_collections entry —
      // never db(<caller-string>) against an unregistered table. Mirrors
      // collection-layouts.ts's /active gate (never getCollection's synthetic-
      // collection allowance, which leaves a real-table-without-registry-row hole).
      const registered = await db('nivaro_collections').where({ collection }).first()
      if (!registered) {
        return reply.code(400).send({ error: `Unknown collection "${collection}"` })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const draft = evalBody.draft ?? {}
      const data = await evaluateRulesForTrigger(
        db,
        collection,
        trigger_field,
        evalBody.trigger_value,
        draft,
        req.log
      )
      return reply.send({ data })
    }

    const body = req.body as {
      collection?: string
      data?: Record<string, unknown>
      changed_field?: string
      /** Evaluate only 'lock' rules (row editor open) — no value changes. */
      locks_only?: boolean
      /** Also compute what every rule target WOULD be if it were empty
       *  (`expected`), so the client can label auto vs overridden values and
       *  offer reset-to-auto. Never applied server-side. */
      probe?: boolean
      /** Run only the rules targeting these fields (reset-to-auto). Those
       *  targets are treated as empty so only_if_empty rules fire. */
      target_fields?: string[]
      parent_context?: Record<string, unknown>
      row_rules?: Array<{
        trigger_field?: string | null
        trigger_fields?: string[] | null
        trigger_related_field?: string | null
        trigger_op?: string
        trigger_value?: string | null
        target_field: string
        target_type: 'set' | 'clear' | 'relation_field' | 'precedence' | 'pick' | 'lock'
        target_value?: string | null
        sources?: Array<{
          source_type: string
          source_field: string
          source_related_field: string
          source_hop?: string
          o2m_collection?: string
          filter_field?: string
          filter_value?: string
          source_one_collection?: string
        }>
        only_if_empty?: boolean
        sort?: number
      }>
    }

    if (!body.collection || !body.data || typeof body.data !== 'object') {
      return reply.code(400).send({ error: 'collection and data are required' })
    }

    const before = { ...body.data }
    const working = { ...body.data }
    const parentContext = body.parent_context ?? {}
    const locks = new Set<string>()

    let expected: Record<string, unknown> | undefined
    if (Array.isArray(body.row_rules) && body.row_rules.length > 0) {
      // The full evaluator lives in services/field-rules.ts now — createOne
      // runs the same rules for direct API child-row creates, so the logic
      // must not fork between the live-edit path and the write path.
      const rules = body.row_rules as RowRule[]
      const cache = new RowRuleLookupCache(db)
      const startedAt = Date.now()
      const targetFields = Array.isArray(body.target_fields)
        ? body.target_fields.filter((f): f is string => typeof f === 'string')
        : undefined
      if (targetFields?.length) for (const f of targetFields) working[f] = null
      await evaluateRowRules(
        db,
        body.collection,
        working,
        parentContext,
        rules,
        targetFields?.length ? undefined : body.changed_field,
        { locks, locksOnly: body.locks_only === true, cache, targetFields }
      )
      if (body.probe === true) {
        // Second pass over a copy with EVERY rule target cleared: what the
        // rules would produce from scratch for this draft. Shares the cache,
        // so it costs only the queries the first pass didn't already make.
        const probeWorking: Record<string, unknown> = { ...working }
        const targets = [
          ...new Set(rules.filter((r) => r.target_type !== 'lock').map((r) => r.target_field))
        ]
        for (const t of targets) probeWorking[t] = null
        await evaluateRowRules(db, body.collection, probeWorking, parentContext, rules, undefined, {
          cache
        })
        expected = {}
        for (const t of targets) expected[t] = probeWorking[t] ?? null
      }
      recordRuleEvalSample(body.collection, {
        at: Date.now(),
        ms: Date.now() - startedAt,
        queries: cache.queries,
        rules: rules.length,
        mode: body.locks_only ? 'open' : body.probe ? 'probe' : 'live'
      })
    } else {
      await applyFieldRules(body.collection, working, body.changed_field)
    }

    // Return only the fields that the rules actually changed.
    const updates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(working)) {
      if (value !== before[key]) updates[key] = value
    }

    return reply.send({ updates, locks: [...locks], ...(expected ? { expected } : {}) })
  })

  /** Rule health: recent evaluate timings per child collection (this replica). */
  // POST /field-rules/apply — re-run a grid's row rules over every SAVED row
  // of one parent ("Re-run rules on all lines"). A rule edited after the
  // rows were created never touched them; this is the catch-up. mode
  // 'empty-only' fills blanks (only-if-empty semantics for every rule),
  // 'all' treats every rule target as blank first so set rules win over
  // hand-entered values. dry_run (default) previews per-field counts and
  // per-row changes; a real run writes through updateOne so revisions and
  // attribution land like any edit.
  app.post('/apply', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      collection?: string
      fk_field?: string
      parent_id?: string | number
      parent_context?: Record<string, unknown>
      row_rules?: RowRule[]
      mode?: 'empty-only' | 'all'
      dry_run?: boolean
      row_ids?: Array<string | number>
    }
    const { collection, fk_field } = body
    if (!collection || !fk_field || body.parent_id == null || !Array.isArray(body.row_rules)) {
      return reply
        .code(400)
        .send({ error: 'collection, fk_field, parent_id and row_rules are required' })
    }
    if (
      !/^[A-Za-z0-9_]+$/.test(collection) ||
      !/^[A-Za-z0-9_]+$/.test(fk_field) ||
      collection.startsWith('nivaro_')
    ) {
      return reply.code(400).send({ error: 'Invalid collection or fk_field' })
    }
    const registered = await db('nivaro_collections').where({ collection }).first()
    if (!registered) return reply.code(400).send({ error: `Unknown collection "${collection}"` })
    const dryRun = body.dry_run !== false
    if (!(await can(req.user!, dryRun ? 'read' : 'update', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const mode = body.mode === 'all' ? 'all' : 'empty-only'
    const rules = body.row_rules.filter((r) => r && typeof r.target_field === 'string')
    const targets = new Set(
      rules.filter((r) => r.target_type !== 'lock').map((r) => r.target_field)
    )
    if (targets.size === 0)
      return reply.send({ data: { rows: 0, fields: {}, changes: [], applied: 0, failed: [] } })

    let q = db(collection)
      .where({ [fk_field]: String(body.parent_id) })
      .orderBy('id')
    if (Array.isArray(body.row_ids) && body.row_ids.length)
      q = q.whereIn('id', body.row_ids.map(String))
    const rows = (await q.limit(500)) as Array<Record<string, unknown>>
    const parentContext = body.parent_context ?? {}
    const cache = new RowRuleLookupCache(db)
    const isEmpty = (v: unknown) => v === null || v === undefined || v === ''
    const changes: Array<{
      id: string
      patch: Record<string, unknown>
      before: Record<string, unknown>
    }> = []
    const fields: Record<string, number> = {}
    const startedAt = Date.now()
    const hasLocks = rules.some((r) => r.target_type === 'lock')
    for (const row of rows) {
      // Fields a rule LOCKS on this row belong to the rules — nobody could
      // have typed them — so even fill-blanks mode re-derives those.
      const locked = new Set<string>()
      if (hasLocks) {
        await evaluateRowRules(db, collection, { ...row }, parentContext, rules, undefined, {
          cache,
          locks: locked,
          locksOnly: true
        })
      }
      const working: Record<string, unknown> = { ...row }
      if (mode === 'all') for (const t of targets) working[t] = null
      else for (const t of locked) if (targets.has(t)) working[t] = null
      await evaluateRowRules(db, collection, working, parentContext, rules, undefined, { cache })
      const patch: Record<string, unknown> = {}
      const before: Record<string, unknown> = {}
      for (const t of targets) {
        const was = row[t]
        const now = working[t]
        if (String(now ?? '') === String(was ?? '')) continue
        if (mode === 'empty-only' && !isEmpty(was) && !locked.has(t)) continue
        // 'all' mode blanked the target — a rule that derives nothing must
        // not erase a value the row already had.
        if (mode === 'all' && isEmpty(now) && !isEmpty(was)) continue
        patch[t] = now ?? null
        before[t] = was ?? null
        fields[t] = (fields[t] ?? 0) + 1
      }
      if (Object.keys(patch).length) changes.push({ id: String(row.id), patch, before })
    }
    recordRuleEvalSample(collection, {
      at: Date.now(),
      ms: Date.now() - startedAt,
      queries: cache.queries,
      rules: rules.length,
      mode: 'apply'
    })
    if (dryRun) {
      return reply.send({
        data: {
          rows: rows.length,
          fields,
          changes: changes.slice(0, 200),
          applied: 0,
          failed: [],
          truncated: changes.length > 200
        }
      })
    }
    let applied = 0
    const failed: Array<{ id: string; error: string }> = []
    for (const c of changes) {
      try {
        // updateOne mutates its payload (computed columns ride along) — hand
        // it a copy so the response still reports the planned patch.
        await updateOne(req.user!, collection, c.id, { ...c.patch }, req)
        applied += 1
      } catch (err) {
        const e = err as { message?: string; code?: string }
        failed.push({
          id: c.id,
          error: e.code ? `${e.code}: ${e.message ?? ''}` : (e.message ?? 'failed')
        })
      }
    }
    await logActivity({
      action: 'row-rules-apply',
      user: req.user!.id,
      collection,
      item: String(body.parent_id),
      comment: JSON.stringify({
        fk_field,
        mode,
        rows: rows.length,
        applied,
        failed: failed.length,
        fields
      })
    })
    return reply.send({
      data: { rows: rows.length, fields, changes: changes.slice(0, 200), applied, failed }
    })
  })

  app.get('/stats', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ data: ruleEvalStats() })
  })

  /**
   * Dry-run a grid's row rules against ONE real child record and explain what
   * every rule did — resolved trigger value, fired/skipped and why, the value
   * written, per-rule ms, total queries. Admin-only (Table Editor tester).
   * The rules come from the request (the editor's UNSAVED draft), the record
   * and its parent from the database. Nothing is written.
   */
  app.post('/explain', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      collection?: string
      record_id?: string | number
      parent_collection?: string
      fk_field?: string
      parent_context_fields?: string[]
      row_rules?: RowRule[]
      changed_field?: string
    }
    if (!body.collection || body.record_id == null || !Array.isArray(body.row_rules)) {
      return reply.code(400).send({ error: 'collection, record_id and row_rules are required' })
    }
    if (!/^[A-Za-z0-9_]+$/.test(body.collection) || body.collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const record = (await db(body.collection)
      .where({ id: String(body.record_id) })
      .first()) as Record<string, unknown> | undefined
    if (!record) return reply.code(404).send({ error: 'Record not found' })
    const parentContext: Record<string, unknown> = {}
    const wanted = new Set(body.parent_context_fields ?? [])
    for (const rule of body.row_rules) {
      const tf = rule.trigger_field
      if (typeof tf === 'string' && tf.startsWith('$parent.')) wanted.add(tf.slice(8))
    }
    let parentId: unknown = null
    if (
      wanted.size > 0 &&
      body.parent_collection &&
      body.fk_field &&
      /^[A-Za-z0-9_]+$/.test(body.parent_collection) &&
      /^[A-Za-z0-9_]+$/.test(body.fk_field)
    ) {
      parentId = record[body.fk_field]
      if (parentId != null) {
        const parent = (await db(body.parent_collection)
          .where({ id: String(parentId) })
          .first()) as Record<string, unknown> | undefined
        if (parent) for (const f of wanted) parentContext[f] = parent[f] ?? null
      }
    }
    const cache = new RowRuleLookupCache(db)
    const explain: RowRuleTraceEntry[] = []
    const locks = new Set<string>()
    const working = { ...record }
    const startedAt = Date.now()
    await evaluateRowRules(
      db,
      body.collection,
      working,
      parentContext,
      body.row_rules,
      body.changed_field,
      {
        cache,
        explain,
        locks
      }
    )
    const ms = Date.now() - startedAt
    recordRuleEvalSample(body.collection, {
      at: Date.now(),
      ms,
      queries: cache.queries,
      rules: body.row_rules.length,
      mode: 'explain'
    })
    const changes: Record<string, { before: unknown; after: unknown }> = {}
    for (const [k, v] of Object.entries(working)) {
      // String-compare: rule values arrive as strings ('2') against numeric
      // columns (2) and that is not a change the save would make.
      if (String(v ?? '') !== String(record[k] ?? ''))
        changes[k] = { before: record[k] ?? null, after: v ?? null }
    }
    return reply.send({
      data: {
        record_id: String(body.record_id),
        parent_id: parentId == null ? null : String(parentId),
        parent_context: parentContext,
        trace: explain,
        locks: [...locks],
        changes,
        queries: cache.queries,
        ms
      }
    })
  })
}
