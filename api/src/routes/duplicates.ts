import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import {
  type DuplicateConfig,
  defaultDuplicateDeps,
  duplicateConfig,
  fieldsFor,
  findDuplicates,
  groupsFor,
  watchFor
} from '../services/duplicate-check.js'
import { liveRules, parseDuplicateCheck } from '../services/duplicate-rules.js'
import { getAllowedFields } from '../services/permissions.js'
import type { ItemsQuery } from '../types.js'

/**
 * Likely duplicates while a record is being created (services/duplicate-check.ts).
 *
 *   GET /api/duplicates/:collection
 *     → { enabled, fields, watch, sets, block_exact, close, source, label } — what the form
 *       watches, narrowed to what the caller may read.
 *   GET /api/duplicates/:collection/check?values={"name":"MX480"}&exclude=<id>
 *     → { enabled, fields, watch, sets, matches: {anchor: [{id, label, value, match,
 *       score}]}, partial? } — judged AS THE CALLER.
 *   GET /api/duplicates/:collection/plan?config=<duplicate_check JSON>      (admin)
 *     → the plan for the saved setting, or for an unsaved draft: every set with each
 *       rule's status (ok / limited / residual / skipped) and why.
 *   GET /api/duplicates/:collection/test?record=<id>&config=<JSON>          (admin)
 *     → what would match if `record` were being created now, under the draft setting
 *       (the record itself excluded), as the admin.
 *
 * Signed in; a person who may not read the collection gets enabled:false / no matches.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** `?config=` → a setting (the JSON is the `duplicate_check` object). */
function draftSetting(raw: string | undefined) {
  if (!raw) return undefined
  if (raw.length > 8000) throw Object.assign(new Error('config is too long'), { statusCode: 400 })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('config must be JSON'), { statusCode: 400 })
  }
  return parseDuplicateCheck({ duplicate_check: parsed })
}

/** The plan as the settings card shows it (plain words, no SQL). */
function planView(cfg: DuplicateConfig) {
  return {
    enabled: cfg.enabled,
    source: cfg.source,
    reason: cfg.reason ?? null,
    rows: cfg.rows,
    big: cfg.big,
    close: cfg.close,
    block_exact: cfg.block_exact,
    within_days: cfg.within_days,
    created_field: cfg.created_field,
    within_note: cfg.within_note ?? null,
    ignore_states: cfg.ignore_states,
    invalid: cfg.invalid,
    groups: cfg.groups.map((g) => ({
      anchor: g.anchor,
      runs: g.runs,
      trimmed: g.trimmed,
      note: g.note ?? null,
      rules: g.rules.map((r) => ({
        field: r.field,
        match: r.match,
        ...(r.amount != null ? { amount: r.amount } : {}),
        ...(r.line_field ? { line_field: r.line_field, child: r.child ?? null } : {}),
        kind: r.kind,
        status: r.status,
        indexed: r.indexed,
        note: r.note ?? null
      }))
    }))
  }
}

export async function duplicateRoutes(app: FastifyInstance) {
  app.get('/:collection', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const user = req.user
    if (!user) return reply.code(401).send({ error: 'Sign in first' })
    const cfg = await duplicateConfig(collection)
    if (!cfg)
      return reply.send({
        data: { enabled: false, fields: [], watch: [], sets: [], block_exact: false }
      })
    const allowed = await getAllowedFields(user, 'read', collection).catch(() => [] as string[])
    const groups = groupsFor(cfg, allowed)
    return reply.send({
      data: {
        enabled: groups.length > 0,
        fields: fieldsFor(cfg, allowed),
        watch: watchFor(groups),
        sets: groups.map((g) => ({ anchor: g.anchor, fields: liveRules(g).map((r) => r.field) })),
        block_exact: cfg.block_exact,
        close: cfg.close,
        source: cfg.source,
        // The settings card explains why it is off; only administrators see it.
        ...(req.isAdmin ? { reason: cfg.reason ?? null, rows: cfg.rows } : {}),
        label: cfg.label
      }
    })
  })

  app.get('/:collection/check', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const user = req.user
    if (!user) return reply.code(401).send({ error: 'Sign in first' })
    const q = req.query as { values?: string; exclude?: string; limit?: string }
    let values: Record<string, unknown> = {}
    if (q.values) {
      if (q.values.length > 6000) return reply.code(400).send({ error: 'values is too long' })
      try {
        const parsed = JSON.parse(q.values) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          values = parsed as Record<string, unknown>
      } catch {
        return reply.code(400).send({ error: 'values must be a JSON object' })
      }
    }
    const answer = await findDuplicates(user, collection, values, {
      excludeId: q.exclude || null,
      limit: q.limit ? Number(q.limit) : undefined,
      req
    })
    return reply.send({ data: answer })
  })

  app.get('/:collection/plan', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const q = req.query as { config?: string }
    const cfg = await duplicateConfig(collection, draftSetting(q.config))
    if (!cfg) return reply.code(404).send({ error: 'Collection not found' })
    return reply.send({ data: planView(cfg) })
  })

  app.get('/:collection/test', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const user = req.user
    if (!user) return reply.code(401).send({ error: 'Sign in first' })
    const q = req.query as { record?: string; config?: string }
    const record = String(q.record ?? '').trim()
    if (!record || record.length > 64) return reply.code(400).send({ error: 'Pick a record' })
    const cfg = await duplicateConfig(collection, draftSetting(q.config))
    if (!cfg) return reply.code(404).send({ error: 'Collection not found' })
    const groups = cfg.groups.filter((g) => g.runs)
    const plain = [
      ...new Set(
        groups.flatMap((g) =>
          liveRules(g)
            .filter((r) => r.kind !== 'lines')
            .map((r) => r.field)
        )
      )
    ]
    const { readOne, readItems } = await import('../services/items.js')
    // The sample is read as the admin: a record they may not read is "not found".
    const row = (await readOne(user, collection, record, undefined, ['id', ...plain]).catch(
      () => null
    )) as Record<string, unknown> | null
    if (!row) return reply.code(404).send({ error: 'Record not found' })
    const values: Record<string, unknown> = {}
    for (const f of plain) values[f] = row[f]
    for (const g of groups)
      for (const r of liveRules(g)) {
        if (r.kind !== 'lines' || !r.child || !r.fk || !r.line_field || r.field in values) continue
        const lines = await readItems(user, r.child, {
          filter: { [r.fk]: { _eq: record } },
          fields: [r.line_field],
          limit: 50,
          count: false
        } as ItemsQuery).catch(() => null)
        values[r.field] = (lines?.data ?? []) as unknown[]
      }
    const answer = await findDuplicates(
      user,
      collection,
      values,
      { excludeId: record, req },
      {
        ...defaultDuplicateDeps,
        config: async () => cfg
      }
    )
    return reply.send({ data: { values, answer, plan: planView(cfg) } })
  })
}
