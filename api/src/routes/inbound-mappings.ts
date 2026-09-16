import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { normalizeImportTemplateConfig } from '../services/import-templates-config.js'
import {
  applyInboundMapping,
  type InboundMappingRow,
  loadMappingByKey,
  parseRules,
  parseUpsertKeys
} from '../services/inbound-mappings.js'

// ─── #88 — inbound mappings ─────────────────────────────────────────────────
// Admin CRUD at /inbound-mappings (+ a dry-run tester); the integration-facing
// endpoint lives at /inbound/:key (see inboundRoutes below).

const KEY_RE = /^[a-z0-9][a-z0-9_-]{1,99}$/
const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function serialize(row: InboundMappingRow) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    collection: row.collection,
    mode: row.mode,
    upsert_keys: parseUpsertKeys(row.upsert_keys),
    rules: parseRules(row.rules),
    is_active: !!row.is_active,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    endpoint: `/api/inbound/${row.key}`
  }
}

/** Validate rules with the import-template normalizer (same steps, same errors). */
function validateRules(
  rules: unknown
): { ok: true; rules: unknown[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(rules)) return { ok: false, errors: ['rules must be an array'] }
  const res = normalizeImportTemplateConfig({
    mode: 'direct',
    file_types: ['csv'],
    header_row: 1,
    header_map: rules,
    line_map: null
  }) as { errors?: Array<{ path?: string; message: string }>; config?: { header_map?: unknown[] } }
  const errs = (res.errors ?? []).filter((e) => !e.path || e.path.startsWith('header_map'))
  if (errs.length)
    return { ok: false, errors: errs.map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`) }
  return { ok: true, rules: res.config?.header_map ?? rules }
}

export async function inboundMappingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const rows = (await db('nivaro_inbound_mappings').orderBy('label')) as InboundMappingRow[]
    return { data: rows.map(serialize) }
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_inbound_mappings')
      .where({ id: Number(req.params.id) })
      .first()) as InboundMappingRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: serialize(row) }
  })

  type Body = Partial<{
    key: string
    label: string
    collection: string
    mode: 'create' | 'upsert'
    upsert_keys: string[]
    rules: unknown[]
    is_active: boolean
  }>

  async function validate(
    b: Body,
    existing?: InboundMappingRow
  ): Promise<{ error?: string; patch: Record<string, unknown> }> {
    const patch: Record<string, unknown> = {}
    if (b.key !== undefined) {
      if (!KEY_RE.test(b.key)) return { error: 'key must be 2–100 chars of a-z 0-9 _ -', patch }
      patch.key = b.key
    }
    if (b.label !== undefined) {
      if (!b.label.trim()) return { error: 'label is required', patch }
      patch.label = b.label.trim().slice(0, 255)
    }
    if (b.collection !== undefined) {
      if (!COLLECTION_RE.test(b.collection) || /^nivaro_/i.test(b.collection))
        return { error: 'collection must be a business collection', patch }
      const known = await db('nivaro_collections')
        .where({ collection: b.collection })
        .first('collection')
      if (!known) return { error: `collection ${b.collection} is not registered`, patch }
      patch.collection = b.collection
    }
    if (b.mode !== undefined) {
      if (b.mode !== 'create' && b.mode !== 'upsert')
        return { error: 'mode must be create or upsert', patch }
      patch.mode = b.mode
    }
    if (b.upsert_keys !== undefined) {
      if (
        !Array.isArray(b.upsert_keys) ||
        b.upsert_keys.some((k) => typeof k !== 'string' || !COLLECTION_RE.test(k))
      )
        return { error: 'upsert_keys must be an array of field names', patch }
      patch.upsert_keys = b.upsert_keys.length ? JSON.stringify(b.upsert_keys) : null
    }
    if (b.rules !== undefined) {
      const v = validateRules(b.rules)
      if (!v.ok) return { error: v.errors.join('; '), patch }
      patch.rules = JSON.stringify(v.rules)
    }
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    const mode = (patch.mode ?? existing?.mode ?? 'create') as string
    const keys =
      patch.upsert_keys === undefined
        ? (existing?.upsert_keys ?? null)
        : (patch.upsert_keys as string | null)
    if (mode === 'upsert' && !parseUpsertKeys(keys).length)
      return { error: 'upsert mode needs at least one upsert key', patch }
    return { patch }
  }

  app.post<{ Body: Body }>('/', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.key || !b.label || !b.collection)
      return reply.code(400).send({ error: 'key, label and collection are required' })
    const { error, patch } = await validate({ mode: 'create', rules: [], ...b })
    if (error) return reply.code(400).send({ error })
    const dup = await db('nivaro_inbound_mappings')
      .where({ key: patch.key as string })
      .first('id')
    if (dup) return reply.code(409).send({ error: 'A mapping with that key already exists' })
    const now = new Date()
    await db('nivaro_inbound_mappings').insert({
      ...patch,
      created_by: req.user?.id ?? null,
      created_at: now,
      updated_at: now
    })
    const row = (await db('nivaro_inbound_mappings')
      .where({ key: patch.key as string })
      .first()) as InboundMappingRow
    await logActivity({
      action: 'create',
      collection: 'nivaro_inbound_mappings',
      item: String(row.id),
      user: req.user?.id,
      req,
      comment: row.key
    })
    return reply.code(201).send({ data: serialize(row) })
  })

  app.patch<{ Params: { id: string }; Body: Body }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_inbound_mappings').where({ id }).first()) as
      | InboundMappingRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const { error, patch } = await validate(req.body ?? {}, existing)
    if (error) return reply.code(400).send({ error })
    if (patch.key && patch.key !== existing.key) {
      const dup = await db('nivaro_inbound_mappings')
        .where({ key: patch.key as string })
        .whereNot({ id })
        .first('id')
      if (dup) return reply.code(409).send({ error: 'A mapping with that key already exists' })
    }
    await db('nivaro_inbound_mappings')
      .where({ id })
      .update({ ...patch, updated_at: new Date() })
    const row = (await db('nivaro_inbound_mappings').where({ id }).first()) as InboundMappingRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_inbound_mappings',
      item: String(id),
      user: req.user?.id,
      req,
      comment: row.key
    })
    return { data: serialize(row) }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const deleted = await db('nivaro_inbound_mappings')
      .where({ id: Number(req.params.id) })
      .delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_inbound_mappings',
      item: req.params.id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // Dry run: map a sample payload with the SAVED rules or an unsaved rule set.
  app.post<{ Params: { id: string }; Body: { sample?: unknown; rules?: unknown[] } }>(
    '/:id/test',
    async (req, reply) => {
      const existing = (await db('nivaro_inbound_mappings')
        .where({ id: Number(req.params.id) })
        .first()) as InboundMappingRow | undefined
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      const sample = req.body?.sample
      if (sample == null || typeof sample !== 'object')
        return reply.code(400).send({ error: 'sample must be an object or array' })
      let mapping = existing
      if (req.body?.rules !== undefined) {
        const v = validateRules(req.body.rules)
        if (!v.ok) return reply.code(400).send({ error: v.errors.join('; ') })
        mapping = { ...existing, rules: JSON.stringify(v.rules) }
      }
      const out = await applyInboundMapping(mapping, sample, req, { dryRun: true })
      return { data: out }
    }
  )
}

/** The integration-facing endpoint: any authenticated caller, writes as them. */
export async function inboundRoutes(app: FastifyInstance) {
  app.post<{ Params: { key: string } }>(
    '/:key',
    { preHandler: requireAuth },
    async (req, reply) => {
      const mapping = await loadMappingByKey(req.params.key)
      if (!mapping || !mapping.is_active)
        return reply.code(404).send({ error: 'Unknown inbound mapping' })
      const payload = req.body
      if (payload == null || typeof payload !== 'object')
        return reply.code(400).send({ error: 'Body must be a JSON object or array' })
      if (Array.isArray(payload) && payload.length > 500)
        return reply.code(413).send({ error: 'At most 500 entries per call' })
      const out = await applyInboundMapping(mapping, payload, req)
      await logActivity({
        action: 'inbound-mapping',
        collection: mapping.collection,
        user: req.user?.id,
        req,
        comment: `${mapping.key}: ${out.created} created, ${out.updated} updated, ${out.rejected} rejected`
      })
      const status =
        out.rejected > 0 && out.created + out.updated === 0 ? 422 : out.rejected > 0 ? 207 : 200
      return reply.code(status).send({ data: out })
    }
  )
}
