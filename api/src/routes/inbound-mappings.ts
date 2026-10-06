import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  type ImportHeaderRule,
  normalizeImportTemplateConfig
} from '../services/import-templates-config.js'
import {
  FIXTURE_CAP,
  fixturePayloadProblem,
  type InboundChildConfig,
  type InboundFixture,
  judgeFixture,
  parseChildren,
  parseFixtures,
  parseResponseStatus,
  responseStatusProblem,
  shapeResponse,
  templateProblem
} from '../services/inbound-mapping-bench.js'
import {
  deleteMappingVersions,
  diffMappingVersion,
  listMappingVersions,
  restoreMappingVersion,
  snapshotMappingVersion
} from '../services/inbound-mapping-versions.js'
import {
  applyInboundMapping,
  type InboundMappingRow,
  type InboundRunOutput,
  loadMappingByKey,
  parseRules,
  parseUpsertKeys,
  publicRun
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
    children: parseChildren(row.children ?? null),
    fixtures: parseFixtures(row.fixtures ?? null),
    response_template: row.response_template ?? null,
    response_status: parseResponseStatus(row.response_status ?? null),
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

/** The columns migration 383 added — a tenant behind it keeps the old shape. */
const BENCH_COLUMNS = ['children', 'fixtures', 'response_template', 'response_status'] as const
async function stripMissingBenchColumns(patch: Record<string, unknown>) {
  for (const c of BENCH_COLUMNS) {
    if (c in patch && !(await hasColumn('nivaro_inbound_mappings', c))) delete patch[c]
  }
}

/**
 * Child rules (#824): each names a one-to-many alias of the mapping's
 * collection, the payload path holding its rows and the columns that map a
 * row — validated with the import-template line_map normalizer.
 */
async function validateChildren(
  raw: unknown,
  collection: string
): Promise<{ ok: true; children: InboundChildConfig[] } | { ok: false; error: string }> {
  if (!Array.isArray(raw)) return { ok: false, error: 'children must be an array' }
  if (raw.length > 10) return { ok: false, error: 'at most 10 child sets per mapping' }
  const rels = (await db('nivaro_relations')
    .where({ one_collection: collection })
    .whereNull('junction_field')
    .whereNotNull('one_field')
    .select('one_field', 'many_collection')) as Array<{
    one_field: string
    many_collection: string
  }>
  const out: InboundChildConfig[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const c = (raw[i] ?? {}) as Record<string, unknown>
    const field = typeof c.target_field === 'string' ? c.target_field : ''
    const rel = field && field !== 'id' ? rels.find((r) => r.one_field === field) : undefined
    if (!rel || /^nivaro_|^directus_/i.test(rel.many_collection))
      return {
        ok: false,
        error: `children[${i}]: "${field}" is not a one-to-many field of ${collection}`
      }
    if (seen.has(field)) return { ok: false, error: `children[${i}]: "${field}" is listed twice` }
    seen.add(field)
    const source = typeof c.source === 'string' ? c.source.trim() : ''
    if (!source || !/^[A-Za-z0-9_$.-]+$/.test(source))
      return { ok: false, error: `children[${i}]: source must be a payload path like "lines"` }
    const res = normalizeImportTemplateConfig({
      mode: 'direct',
      file_types: ['csv'],
      header_row: 1,
      header_map: [],
      line_map: {
        target_field: field,
        row_filter: c.row_filter ?? null,
        columns: Array.isArray(c.columns) ? c.columns : [],
        apply_field_rules: false
      }
    }) as {
      errors?: Array<{ path?: string; message: string }>
      config?: {
        line_map?: { row_filter: InboundChildConfig['row_filter']; columns: ImportHeaderRule[] }
      }
    }
    const errs = res.errors ?? []
    if (errs.length)
      return {
        ok: false,
        error: errs
          .map(
            (e) =>
              `children[${i}]${e.path ? `.${e.path.replace(/^line_map\.?/, '')}` : ''}: ${e.message}`
          )
          .join('; ')
      }
    out.push({
      target_field: field,
      source,
      row_filter: res.config?.line_map?.row_filter ?? null,
      columns: res.config?.line_map?.columns ?? [],
      on_update: c.on_update === 'replace' ? 'replace' : 'append'
    })
  }
  return { ok: true, children: out }
}

/** The default body the endpoint has always answered with. */
function defaultBody(out: InboundRunOutput) {
  return { data: publicRun(out) }
}

/** An unsaved draft of the rules / children / response laid over a mapping. */
async function withDraft(
  existing: InboundMappingRow,
  body: {
    rules?: unknown[]
    children?: unknown[]
    response_template?: string | null
    response_status?: unknown
  }
): Promise<{ mapping: InboundMappingRow } | { error: string }> {
  const mapping = { ...existing }
  if (body.rules !== undefined) {
    const v = validateRules(body.rules)
    if (!v.ok) return { error: v.errors.join('; ') }
    mapping.rules = JSON.stringify(v.rules)
  }
  if (body.children !== undefined) {
    const v = await validateChildren(body.children, existing.collection)
    if (!v.ok) return { error: v.error }
    mapping.children = JSON.stringify(v.children)
  }
  if (body.response_template !== undefined) {
    const problem = templateProblem(body.response_template)
    if (problem) return { error: problem }
    mapping.response_template = body.response_template || null
  }
  if (body.response_status !== undefined) {
    const problem = responseStatusProblem(body.response_status)
    if (problem) return { error: problem }
    mapping.response_status = JSON.stringify(parseResponseStatus(body.response_status))
  }
  return { mapping }
}

/** Dry-run a payload and shape the response it would get. */
async function benchRun(mapping: InboundMappingRow, payload: unknown, req: FastifyRequest) {
  const out = await applyInboundMapping(mapping, payload, req, { dryRun: true, rehearse: true })
  const response = await shapeResponse(
    { mapping, ...out },
    mapping.response_template,
    parseResponseStatus(mapping.response_status ?? null),
    defaultBody(out)
  )
  return { out, response }
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
    children: unknown[]
    response_template: string | null
    response_status: Record<string, unknown> | null
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
    if (b.children !== undefined) {
      const collection = (patch.collection ?? existing?.collection) as string | undefined
      if (!collection) return { error: 'pick a collection before child rules', patch }
      const v = await validateChildren(b.children, collection)
      if (!v.ok) return { error: v.error, patch }
      patch.children = v.children.length ? JSON.stringify(v.children) : null
    }
    if (b.response_template !== undefined) {
      const problem = templateProblem(b.response_template)
      if (problem) return { error: problem, patch }
      patch.response_template = b.response_template?.trim() ? b.response_template : null
    }
    if (b.response_status !== undefined) {
      const problem = responseStatusProblem(b.response_status)
      if (problem) return { error: problem, patch }
      const map = parseResponseStatus(b.response_status)
      patch.response_status = Object.keys(map).length ? JSON.stringify(map) : null
    }
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    await stripMissingBenchColumns(patch)
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
    await snapshotMappingVersion(row.id, 'created', req.user?.id)
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
    await snapshotMappingVersion(id, 'before edit', req.user?.id)
    await db('nivaro_inbound_mappings')
      .where({ id })
      .update({ ...patch, updated_at: new Date() })
    await snapshotMappingVersion(id, `edited ${Object.keys(patch).join(', ')}`, req.user?.id)
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
    // Versions FK the mapping NO ACTION — clear them first.
    await deleteMappingVersions(Number(req.params.id))
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

  // ── #1266 — versions: every save snapshots the mapping (deduped, newest 30) ──
  app.get<{ Params: { id: string } }>('/:id/versions', async (req, reply) => {
    const existing = await loadById(req.params.id)
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    return { data: await listMappingVersions(existing.id) }
  })

  app.get<{ Params: { id: string; vid: string }; Querystring: { against?: string } }>(
    '/:id/versions/:vid/diff',
    async (req, reply) => {
      const against =
        !req.query.against || req.query.against === 'current'
          ? ('current' as const)
          : Number(req.query.against)
      if (against !== 'current' && !Number.isInteger(against))
        return reply.code(400).send({ error: 'against must be "current" or a version id' })
      const diff = await diffMappingVersion(Number(req.params.id), Number(req.params.vid), against)
      if (!diff) return reply.code(404).send({ error: 'Version not found' })
      return { data: diff }
    }
  )

  app.post<{ Params: { id: string; vid: string } }>(
    '/:id/versions/:vid/restore',
    async (req, reply) => {
      const id = Number(req.params.id)
      const res = await restoreMappingVersion(id, Number(req.params.vid), req.user?.id)
      if (!res.ok) return reply.code(res.status).send({ error: res.error })
      const row = (await db('nivaro_inbound_mappings').where({ id }).first()) as InboundMappingRow
      await logActivity({
        action: 'inbound-mapping-restore',
        collection: 'nivaro_inbound_mappings',
        item: String(id),
        user: req.user?.id,
        req,
        comment: `${row.key}: restored v${res.version}`
      })
      return { data: serialize(row) }
    }
  )

  type DraftBody = {
    rules?: unknown[]
    children?: unknown[]
    response_template?: string | null
    response_status?: unknown
  }

  async function loadById(id: string) {
    return (await db('nivaro_inbound_mappings')
      .where({ id: Number(id) })
      .first()) as InboundMappingRow | undefined
  }

  // Dry run: map a sample payload with the SAVED config or an unsaved draft of
  // it (rules, children, response). Nothing is written; a would-be create runs
  // the create pipeline without storing anything, and the response carries
  // the body the partner would get.
  app.post<{ Params: { id: string }; Body: DraftBody & { sample?: unknown } }>(
    '/:id/test',
    async (req, reply) => {
      const existing = await loadById(req.params.id)
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      const sample = req.body?.sample
      if (sample == null || typeof sample !== 'object')
        return reply.code(400).send({ error: 'sample must be an object or array' })
      const draft = await withDraft(existing, req.body ?? {})
      if ('error' in draft) return reply.code(400).send({ error: draft.error })
      const { out, response } = await benchRun(draft.mapping, sample, req)
      return { data: { ...publicRun(out), response } }
    }
  )

  // ── #624 — fixtures: named partner payloads saved with the mapping ──────

  async function saveFixtures(
    id: number,
    fixtures: InboundFixture[],
    note: string,
    userId?: string | null
  ) {
    if (!(await hasColumn('nivaro_inbound_mappings', 'fixtures')))
      throw Object.assign(new Error('Fixtures need migration 383'), { statusCode: 409 })
    await snapshotMappingVersion(id, 'before edit', userId)
    await db('nivaro_inbound_mappings')
      .where({ id })
      .update({
        fixtures: fixtures.length ? JSON.stringify(fixtures) : null,
        updated_at: new Date()
      })
    await snapshotMappingVersion(id, note, userId)
  }

  /** The payloads recent calls posted to this mapping's endpoint. */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/:id/fixtures/candidates',
    async (req, reply) => {
      const existing = await loadById(req.params.id)
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100)
      const rows = (await db('nivaro_api_logs as l')
        .leftJoin('nivaro_users as u', 'u.id', 'l.user')
        .leftJoin('nivaro_api_keys as k', 'k.id', 'l.api_key_id')
        .where('l.method', 'POST')
        .whereIn('l.path', [`/api/inbound/${existing.key}`, `/inbound/${existing.key}`])
        .whereNotNull('l.request_body')
        .orderBy('l.id', 'desc')
        .limit(limit)
        .select(
          'l.id',
          'l.created_at',
          'l.status',
          'l.auth',
          'l.error',
          'l.request_body',
          'u.first_name',
          'u.last_name',
          'k.name as api_key_name'
        )) as Array<Record<string, unknown>>
      return {
        data: rows.map((r) => {
          let payload: unknown = null
          let usable = true
          try {
            payload = JSON.parse(String(r.request_body))
          } catch {
            usable = false
          }
          const who = [r.first_name, r.last_name].filter(Boolean).join(' ')
          return {
            id: Number(r.id),
            at: r.created_at,
            status: r.status,
            caller: (r.api_key_name as string) || who || null,
            auth: r.auth ?? null,
            error: r.error ?? null,
            usable,
            reason: usable ? null : 'The stored body was cut at 64 KB and is not valid JSON',
            payload: usable ? payload : null,
            preview: String(r.request_body).slice(0, 300)
          }
        })
      }
    }
  )

  app.post<{
    Params: { id: string }
    Body: { name?: string; payload?: unknown; log_id?: number; expect?: string }
  }>('/:id/fixtures', async (req, reply) => {
    const existing = await loadById(req.params.id)
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const fixtures = parseFixtures(existing.fixtures ?? null)
    if (fixtures.length >= FIXTURE_CAP)
      return reply.code(400).send({ error: `At most ${FIXTURE_CAP} fixtures per mapping` })
    let payload = req.body?.payload
    let sourceLogId: number | null = null
    if (req.body?.log_id != null) {
      const log = (await db('nivaro_api_logs')
        .where({ id: Number(req.body.log_id) })
        .first('id', 'path', 'request_body')) as
        | { id: number; path: string; request_body: string | null }
        | undefined
      if (!log?.request_body || !log.path.endsWith(`/inbound/${existing.key}`))
        return reply.code(404).send({ error: 'That call is not a request to this mapping' })
      try {
        payload = JSON.parse(log.request_body)
      } catch {
        return reply
          .code(400)
          .send({ error: 'The stored body was cut at 64 KB and is not valid JSON' })
      }
      sourceLogId = Number(log.id)
    }
    const problem = fixturePayloadProblem(payload)
    if (problem) return reply.code(400).send({ error: problem })
    const name = (req.body?.name ?? '').trim().slice(0, 120) || `Fixture ${fixtures.length + 1}`
    const fixture: InboundFixture = {
      id: randomUUID(),
      name,
      payload,
      expect: req.body?.expect === 'reject' ? 'reject' : 'write',
      source_log_id: sourceLogId,
      saved_at: new Date().toISOString()
    }
    await saveFixtures(
      existing.id,
      [...fixtures, fixture],
      `fixture added: ${name}`.slice(0, 255),
      req.user?.id
    )
    await logActivity({
      action: 'inbound-fixture-add',
      collection: 'nivaro_inbound_mappings',
      item: String(existing.id),
      user: req.user?.id,
      req,
      comment: `${existing.key}: ${name}`
    })
    return reply.code(201).send({ data: fixture })
  })

  app.patch<{
    Params: { id: string; fid: string }
    Body: { name?: string; payload?: unknown; expect?: string }
  }>('/:id/fixtures/:fid', async (req, reply) => {
    const existing = await loadById(req.params.id)
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const fixtures = parseFixtures(existing.fixtures ?? null)
    const hit = fixtures.find((f) => f.id === req.params.fid)
    if (!hit) return reply.code(404).send({ error: 'Fixture not found' })
    if (req.body?.payload !== undefined) {
      const problem = fixturePayloadProblem(req.body.payload)
      if (problem) return reply.code(400).send({ error: problem })
      hit.payload = req.body.payload
    }
    if (typeof req.body?.name === 'string' && req.body.name.trim())
      hit.name = req.body.name.trim().slice(0, 120)
    if (req.body?.expect === 'write' || req.body?.expect === 'reject') hit.expect = req.body.expect
    await saveFixtures(existing.id, fixtures, `fixture edited: ${hit.name}`, req.user?.id)
    await logActivity({
      action: 'inbound-fixture-update',
      collection: 'nivaro_inbound_mappings',
      item: String(existing.id),
      user: req.user?.id,
      req,
      comment: `${existing.key}: ${hit.name}`
    })
    return { data: hit }
  })

  app.delete<{ Params: { id: string; fid: string } }>('/:id/fixtures/:fid', async (req, reply) => {
    const existing = await loadById(req.params.id)
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const fixtures = parseFixtures(existing.fixtures ?? null)
    const hit = fixtures.find((f) => f.id === req.params.fid)
    if (!hit) return reply.code(404).send({ error: 'Fixture not found' })
    await saveFixtures(
      existing.id,
      fixtures.filter((f) => f.id !== hit.id),
      `fixture removed: ${hit.name}`,
      req.user?.id
    )
    await logActivity({
      action: 'inbound-fixture-delete',
      collection: 'nivaro_inbound_mappings',
      item: String(existing.id),
      user: req.user?.id,
      req,
      comment: `${existing.key}: ${hit.name}`
    })
    return reply.code(204).send()
  })

  /**
   * Re-run every fixture against the saved config or an unsaved draft of it —
   * the editor calls this on each rule edit. Nothing is written.
   */
  app.post<{ Params: { id: string }; Body: DraftBody }>('/:id/fixtures/run', async (req, reply) => {
    const existing = await loadById(req.params.id)
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const draft = await withDraft(existing, req.body ?? {})
    if ('error' in draft) return reply.code(400).send({ error: draft.error })
    const fixtures = parseFixtures(existing.fixtures ?? null)
    const runs = []
    for (const f of fixtures) {
      try {
        const { out, response } = await benchRun(draft.mapping, f.payload, req)
        const verdict = judgeFixture(f.expect, out)
        runs.push({
          id: f.id,
          name: f.name,
          expect: f.expect,
          ...verdict,
          run: publicRun(out),
          response
        })
      } catch (err) {
        runs.push({
          id: f.id,
          name: f.name,
          expect: f.expect,
          pass: false,
          reason: err instanceof Error ? err.message : String(err),
          run: null,
          response: null
        })
      }
    }
    return {
      data: {
        fixtures: runs,
        passed: runs.filter((r) => r.pass).length,
        failed: runs.filter((r) => !r.pass).length
      }
    }
  })
}

/** The integration-facing endpoint: any authenticated caller, writes as them. */
export async function inboundRoutes(app: FastifyInstance) {
  app.post<{ Params: { key: string } }>(
    '/:key',
    { preHandler: requireAuth },
    async (req, reply) => {
      const mapping = await loadMappingByKey(req.params.key)
      if (!mapping?.is_active) return reply.code(404).send({ error: 'Unknown inbound mapping' })
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
      const shaped = await shapeResponse(
        { mapping, ...out },
        mapping.response_template,
        parseResponseStatus(mapping.response_status ?? null),
        defaultBody(out)
      )
      if (shaped.template_error)
        req.log.warn(
          { mapping: mapping.key, error: shaped.template_error },
          'inbound response template failed; default body sent'
        )
      reply.code(shaped.status)
      if (shaped.shaped) reply.header('content-type', shaped.content_type)
      return reply.send(shaped.body)
    }
  )
}
