import Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { findDuplicates, getAiCollectionSettings, runAiValidation } from '../hooks/ai-validation.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

/** AI governance (#407): per-feature toggles — settings.ai_disabled_features
 *  JSON list of route keys; a disabled feature answers 403 with the reason. */
async function aiFeatureEnabled(key: string): Promise<boolean> {
  try {
    const row = await db('nivaro_settings').first('ai_disabled_features')
    const list = row?.ai_disabled_features ? (JSON.parse(row.ai_disabled_features) as string[]) : []
    return !list.includes(key)
  } catch {
    return true
  }
}

async function getClient(): Promise<Anthropic | null> {
  const key =
    config.ANTHROPIC_API_KEY ||
    (await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first()
      .then((s: { anthropic_api_key?: string | null }) => s?.anthropic_api_key ?? null))
  if (!key) return null
  return new Anthropic({ apiKey: key })
}

async function getAiSettings() {
  const row = await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('ai_model', 'ai_max_tokens_generate', 'ai_max_tokens_summarize')
    .catch(() => null)
  return {
    model: (row?.ai_model as string | null) ?? 'claude-haiku-4-5-20251001',
    maxTokensGenerate: (row?.ai_max_tokens_generate as number | null) ?? 500,
    maxTokensSummarize: (row?.ai_max_tokens_summarize as number | null) ?? 200
  }
}

type FieldValue = string | number | boolean | Date | null

interface AiFilter {
  field: string
  op: string
  value?: unknown
}

const ALLOWED_OPS = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'null',
  'nnull'
])

const VALUELESS_OPS = new Set(['null', 'nnull'])

// Extract a JSON object from a model response — strips code fences and surrounding prose.
function extractJson(text: string): unknown {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  return JSON.parse(t)
}

function describeQuery(
  collection: string,
  filters: AiFilter[],
  sort: { field: string; dir: 'asc' | 'desc' } | null,
  limit: number
): string {
  const parts = filters.map((f) =>
    VALUELESS_OPS.has(f.op) ? `${f.field} ${f.op}` : `${f.field} ${f.op} ${JSON.stringify(f.value)}`
  )
  let out = `${collection}${parts.length ? ` where ${parts.join(' and ')}` : ''}`
  if (sort) out += `, sorted by ${sort.field} ${sort.dir}`
  out += `, limit ${limit}`
  return out
}

export async function aiRoutes(app: FastifyInstance) {
  // POST /ai/query — natural-language → validated filter DSL → knex query
  app.post('/query', { preHandler: authenticate }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }

    const {
      collection,
      prompt,
      filters: preFilters,
      sort: preSort,
      limit: preLimit,
      offset: preOffset
    } = req.body as {
      collection?: string
      prompt?: string
      filters?: unknown
      sort?: unknown
      limit?: unknown
      offset?: unknown
    }
    if (!collection || (!prompt && !Array.isArray(preFilters))) {
      return reply.code(400).send({ error: 'collection and either prompt or filters are required' })
    }
    if (collection.startsWith('nivaro_')) {
      return reply.code(403).send({ error: 'System collections cannot be queried' })
    }
    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const fields = (await db('nivaro_fields')
      .where({ collection })
      .select('field', 'type', 'note')) as Array<{
      field: string
      type: string
      note: string | null
    }>
    if (fields.length === 0) {
      return reply.code(404).send({ error: 'Collection not registered' })
    }

    // Virtual O2M/M2M "fields" have no real DB column — exclude from direct filters.
    // Covers both named aliases (one_field) and unnamed relations matched by many_collection.
    const o2mRelsMeta = (await db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNull('junction_field')
      .select('one_field', 'many_collection', 'many_field')) as Array<{
      one_field: string | null
      many_collection: string
      many_field: string
    }>
    const m2mRelsMeta = (await db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNotNull('junction_field')
      .select('one_field', 'many_collection', 'many_field', 'junction_field')) as Array<{
      one_field: string | null
      many_collection: string
      many_field: string
      junction_field: string
    }>
    const virtualFieldNames = new Set<string>()
    for (const r of [...o2mRelsMeta, ...m2mRelsMeta]) {
      if (r.one_field) virtualFieldNames.add(r.one_field)
      else virtualFieldNames.add(r.many_collection)
    }
    const directFields = fields.filter((f) => !virtualFieldNames.has(f.field))
    const fieldNames = new Set(directFields.map((f) => f.field))

    // ── Relation context ──────────────────────────────────────────────────────
    // Maps a dotted filter path (e.g. "department_id.name") to enough info to
    // generate the right subquery at execution time.

    type RelInfo =
      | {
          type: 'm2o'
          fkField: string
          relatedCollection: string
          relatedField: string
          fieldType: string
        }
      | {
          type: 'o2m'
          manyCollection: string
          fkField: string
          relatedField: string
          fieldType: string
        }
      | {
          type: 'm2m'
          junctionCollection: string
          junctionFk: string
          junctionRelFk: string
          relatedCollection: string
          relatedField: string
          fieldType: string
        }

    const relationalFieldMap = new Map<string, RelInfo>()
    const relPromptLines: string[] = []

    // Returns real (non-virtual) fields for a collection.
    // Falls back to DB column introspection when nivaro_fields has no registered fields
    // (or only 'id'), so unregistered lookup tables still expose their columns to the AI.
    async function realFields(col: string): Promise<Array<{ field: string; type: string }>> {
      const [all, rels] = await Promise.all([
        db('nivaro_fields').where({ collection: col }).select('field', 'type') as Promise<
          Array<{ field: string; type: string }>
        >,
        db('nivaro_relations')
          .where({ one_collection: col })
          .select('one_field', 'many_collection') as Promise<
          Array<{ one_field: string | null; many_collection: string }>
        >
      ])
      const vSet = new Set<string>()
      for (const r of rels) vSet.add(r.one_field ?? r.many_collection)
      const registered = all.filter((f) => !vSet.has(f.field))

      // If no fields (or only 'id') are registered, introspect actual DB columns.
      const needsFallback =
        registered.length === 0 || (registered.length === 1 && registered[0].field === 'id')
      if (needsFallback) {
        try {
          const colInfo = (await db(col).columnInfo()) as Record<string, { type: string }>
          return Object.entries(colInfo).map(([field, meta]) => ({ field, type: meta.type }))
        } catch {
          return registered
        }
      }
      return registered
    }

    // M2O — FK lives on this collection, points to one_collection
    const m2oRels = (await db('nivaro_relations')
      .where({ many_collection: collection })
      .whereNull('junction_field')
      .whereNotNull('one_collection')
      .select('many_field', 'one_collection')) as Array<{
      many_field: string
      one_collection: string
    }>

    for (const rel of m2oRels) {
      const relFields = await realFields(rel.one_collection)
      if (!relFields.length) continue
      relPromptLines.push(
        `  "${rel.many_field}" → M2O → "${rel.one_collection}" (filter as ${rel.many_field}.<field>):`
      )
      for (const rf of relFields) {
        const path = `${rel.many_field}.${rf.field}`
        relationalFieldMap.set(path, {
          type: 'm2o',
          fkField: rel.many_field,
          relatedCollection: rel.one_collection,
          relatedField: rf.field,
          fieldType: rf.type
        })
        relPromptLines.push(`    - ${path} (${rf.type})`)
      }
    }

    // O2M — FK lives on many_collection, points back here.
    // one_field may be null for unnamed relations; fall back to many_collection as path prefix.
    for (const rel of o2mRelsMeta) {
      const prefix = rel.one_field ?? rel.many_collection
      const relFields = await realFields(rel.many_collection)
      if (!relFields.length) continue
      relPromptLines.push(
        `  "${prefix}" → O2M → "${rel.many_collection}" (filter as ${prefix}.<field>; matches records that have ≥1 related row):`
      )
      for (const rf of relFields) {
        const path = `${prefix}.${rf.field}`
        if (relationalFieldMap.has(path)) continue
        relationalFieldMap.set(path, {
          type: 'o2m',
          manyCollection: rel.many_collection,
          fkField: rel.many_field,
          relatedField: rf.field,
          fieldType: rf.type
        })
        relPromptLines.push(`    - ${path} (${rf.type})`)
      }
    }

    // M2M — via junction table (reuses m2mRelsMeta from above).
    // The counterpart junction relation normally has junction_field set too (it
    // points back at this side's FK), so the lookup must NOT require it null —
    // matching findM2MRelation() in services/items.ts and schema-builder.ts.
    // The relation row itself can never match (its many_field ≠ its junction_field).
    for (const rel of m2mRelsMeta) {
      // one_field may be null for unnamed relations; fall back to many_collection as path prefix.
      const prefix = rel.one_field ?? rel.many_collection
      const otherRel = (await db('nivaro_relations')
        .where({ many_collection: rel.many_collection, many_field: rel.junction_field })
        .whereNotNull('one_collection')
        .first()) as { one_collection: string } | undefined
      if (!otherRel) continue
      const relFields = await realFields(otherRel.one_collection)
      if (!relFields.length) continue
      relPromptLines.push(
        `  "${prefix}" → M2M → "${otherRel.one_collection}" via "${rel.many_collection}" (filter as ${prefix}.<field>):`
      )
      for (const rf of relFields) {
        const path = `${prefix}.${rf.field}`
        if (relationalFieldMap.has(path)) continue
        relationalFieldMap.set(path, {
          type: 'm2m',
          junctionCollection: rel.many_collection,
          junctionFk: rel.many_field,
          junctionRelFk: rel.junction_field,
          relatedCollection: otherRel.one_collection,
          relatedField: rf.field,
          fieldType: rf.type
        })
        relPromptLines.push(`    - ${path} (${rf.type})`)
      }
    }

    // ── AI call (skipped when pre-computed filters are provided) ─────────────
    let parsed: { filters?: unknown; sort?: unknown; limit?: unknown; interpreted?: unknown } = {}
    let interpreted = ''

    if (preFilters) {
      // Pagination re-fetch — reuse filters returned from the first page
      parsed = { filters: preFilters, sort: preSort, limit: preLimit, interpreted: '' }
    } else {
      const today = new Date().toISOString().slice(0, 10)
      const system = [
        'You translate natural-language data questions into a strict JSON filter DSL.',
        `Today's date is ${today} — resolve relative dates ("last week", "this month") into ISO date strings.`,
        `The target collection is "${collection}" with these direct fields:`,
        ...directFields.map((f) => `- ${f.field} (${f.type})${f.note ? ` — ${f.note}` : ''}`),
        ...(relPromptLines.length
          ? [
              '',
              "Relational fields — use these dotted paths when the user's query refers to a related concept:",
              ...relPromptLines
            ]
          : []),
        '',
        'RULES (follow strictly):',
        '1. When the user\'s query refers to a concept that matches a relation name (e.g. "funding year" → use "funding_years.<field>"), ALWAYS use the dotted relational path — never substitute a different direct field as a proxy.',
        "2. If no field or relational path accurately matches the user's intent, omit that filter entirely rather than approximating with an unrelated field.",
        '3. Only use fields and dotted paths from the lists above. "sort" must be a direct field. "limit" is optional.',
        '4. op must be one of: eq, neq, gt, gte, lt, lte, contains, in, null, nnull. "in" takes an array value; "null"/"nnull" take no value.',
        '5. For integer/numeric fields (int, bigint, float, etc.), use numeric values — never wrap them in quotes.',
        '',
        'Return ONLY a JSON object, no prose and no code fences:',
        '{"filters":[{"field":"<field or dotted.path>","op":"<op>","value":<value>}],"sort":{"field":"<direct field>","dir":"asc"|"desc"},"limit":<number>,"interpreted":"<one-line summary>"}'
      ].join('\n')

      const { model } = await getAiSettings()
      const message = await client.messages.create({
        model,
        max_tokens: 800,
        system,
        messages: [{ role: 'user', content: prompt! }]
      })
      const raw = message.content[0]?.type === 'text' ? message.content[0].text : ''

      try {
        parsed = extractJson(raw) as typeof parsed
      } catch {
        return reply.code(422).send({ error: 'AI returned an unparseable filter', raw })
      }
    }

    interpreted =
      typeof parsed.interpreted === 'string' && parsed.interpreted.trim()
        ? parsed.interpreted.trim().slice(0, 300)
        : ''

    // Validate — direct fields OR known relational dotted paths
    const rawFilters = Array.isArray(parsed.filters) ? parsed.filters : []
    const filters: AiFilter[] = []
    for (const f of rawFilters) {
      if (!f || typeof f !== 'object') {
        return reply.code(422).send({ error: 'AI returned a malformed filter entry' })
      }
      const { field, op, value } = f as AiFilter
      const isDirectField = typeof field === 'string' && fieldNames.has(field)
      const isRelationalField = typeof field === 'string' && relationalFieldMap.has(field)
      if (!isDirectField && !isRelationalField) {
        return reply.code(422).send({ error: `Unknown field in AI filter: ${String(field)}` })
      }
      if (typeof op !== 'string' || !ALLOWED_OPS.has(op)) {
        return reply.code(422).send({ error: `Unsupported operator in AI filter: ${String(op)}` })
      }
      if (!VALUELESS_OPS.has(op) && value === undefined) {
        return reply.code(422).send({ error: `Operator ${op} requires a value` })
      }
      // Coerce string numbers to actual numbers for integer/numeric fields.
      const relInfo = relationalFieldMap.get(field as string)
      const fieldType = relInfo
        ? relInfo.fieldType
        : (directFields.find((f) => f.field === field)?.type ?? '')
      const isNumericType =
        /^(int|integer|bigint|smallint|tinyint|numeric|decimal|float|real|double|number)/i.test(
          fieldType
        )
      let coercedValue = value
      if (isNumericType && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
        coercedValue = Number(value)
      } else if (isNumericType && Array.isArray(value)) {
        coercedValue = value.map((v) =>
          typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
        )
      }
      filters.push({ field, op, value: coercedValue })
    }

    let sort: { field: string; dir: 'asc' | 'desc' } | null = null
    if (parsed.sort && typeof parsed.sort === 'object') {
      const s = parsed.sort as { field?: unknown; dir?: unknown }
      if (typeof s.field === 'string' && fieldNames.has(s.field)) {
        sort = { field: s.field, dir: s.dir === 'desc' ? 'desc' : 'asc' }
      }
    }

    const limit = Math.min(Math.max(Number(parsed.limit) || 50, 1), 200)

    // Helper: apply a single op+value to a knex query builder on a given column
    function applyOp(q: ReturnType<typeof db>, col: string, op: string, value: unknown) {
      const v = value as FieldValue
      switch (op) {
        case 'eq':
          v === null ? q.whereNull(col) : q.where(col, v)
          break
        case 'neq':
          v === null ? q.whereNotNull(col) : q.whereNot(col, v)
          break
        case 'gt':
          q.where(col, '>', v)
          break
        case 'gte':
          q.where(col, '>=', v)
          break
        case 'lt':
          q.where(col, '<', v)
          break
        case 'lte':
          q.where(col, '<=', v)
          break
        case 'contains':
          q.where(col, 'like', `%${String(v)}%`)
          break
        case 'in':
          q.whereIn(col, (Array.isArray(value) ? value : [value]) as Array<string | number>)
          break
        case 'null':
          q.whereNull(col)
          break
        case 'nnull':
          q.whereNotNull(col)
          break
      }
    }

    // Build the query — knex bindings only, never raw string interpolation
    const q = db(collection)
    for (const f of filters) {
      const relInfo = relationalFieldMap.get(f.field)

      if (!relInfo) {
        // Direct field
        applyOp(q, f.field, f.op, f.value)
        continue
      }

      if (relInfo.type === 'm2o') {
        // WHERE fk_field IN (SELECT id FROM related WHERE related_field op value)
        const subq = db(relInfo.relatedCollection).select('id')
        applyOp(subq, relInfo.relatedField, f.op, f.value)
        q.whereIn(relInfo.fkField, subq)
      } else if (relInfo.type === 'o2m') {
        // WHERE id IN (SELECT fk_field FROM many_collection WHERE related_field op value)
        const subq = db(relInfo.manyCollection).select(relInfo.fkField)
        applyOp(subq, relInfo.relatedField, f.op, f.value)
        q.whereIn('id', subq)
      } else if (relInfo.type === 'm2m') {
        // WHERE id IN (SELECT junctionFk FROM junction WHERE junctionRelFk IN (SELECT id FROM related WHERE ...))
        const innerSubq = db(relInfo.relatedCollection).select('id')
        applyOp(innerSubq, relInfo.relatedField, f.op, f.value)
        const junctionSubq = db(relInfo.junctionCollection)
          .whereIn(relInfo.junctionRelFk, innerSubq)
          .select(relInfo.junctionFk)
        q.whereIn('id', junctionSubq)
      }
    }
    const offset = Math.max(Number(preOffset) || 0, 0)

    if (sort) q.orderBy(sort.field, sort.dir)
    else if (offset > 0) q.orderBy('id', 'asc') // MSSQL requires ORDER BY for OFFSET/FETCH

    // COUNT uses the same filters without LIMIT/OFFSET
    const countQ = db(collection)
    for (const f of filters) {
      const relInfo = relationalFieldMap.get(f.field)
      if (!relInfo) {
        applyOp(countQ, f.field, f.op, f.value)
        continue
      }
      if (relInfo.type === 'm2o') {
        const subq = db(relInfo.relatedCollection).select('id')
        applyOp(subq, relInfo.relatedField, f.op, f.value)
        countQ.whereIn(relInfo.fkField, subq)
      } else if (relInfo.type === 'o2m') {
        const subq = db(relInfo.manyCollection).select(relInfo.fkField)
        applyOp(subq, relInfo.relatedField, f.op, f.value)
        countQ.whereIn('id', subq)
      } else if (relInfo.type === 'm2m') {
        const innerSubq = db(relInfo.relatedCollection).select('id')
        applyOp(innerSubq, relInfo.relatedField, f.op, f.value)
        const junctionSubq = db(relInfo.junctionCollection)
          .whereIn(relInfo.junctionRelFk, innerSubq)
          .select(relInfo.junctionFk)
        countQ.whereIn('id', junctionSubq)
      }
    }
    const [countRow] = await countQ.count('* as count')
    const total = Number((countRow as { count: number | string }).count)

    const data = await q.limit(limit).offset(offset)

    if (!interpreted) {
      interpreted = describeQuery(collection, filters, sort, limit)
    }

    return reply.send({ data, total, filters, sort, limit, offset, interpreted })
  })

  // POST /ai/map-columns — suggest CSV column → field mappings for the import wizard
  app.post('/map-columns', { preHandler: authenticate }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }

    const { collection, columns, sample_rows } = req.body as {
      collection?: string
      columns?: unknown
      sample_rows?: unknown
    }
    if (!collection || !Array.isArray(columns) || columns.length === 0) {
      return reply
        .code(400)
        .send({ error: 'collection and a non-empty columns array are required' })
    }
    if (!columns.every((c): c is string => typeof c === 'string')) {
      return reply.code(400).send({ error: 'columns must be an array of strings' })
    }
    if (collection.startsWith('nivaro_')) {
      return reply.code(403).send({ error: 'System collections cannot be imported into' })
    }

    const fields = (await db('nivaro_fields')
      .where({ collection })
      .select('field', 'type', 'note')) as Array<{
      field: string
      type: string
      note: string | null
    }>
    if (fields.length === 0) {
      return reply.code(404).send({ error: 'Collection not registered' })
    }
    const fieldNames = new Set(fields.map((f) => f.field))

    const samples = Array.isArray(sample_rows) ? sample_rows.slice(0, 5) : []
    const system = [
      `You map CSV column headers to fields of the "${collection}" collection.`,
      'Available fields:',
      ...fields.map((f) => `- ${f.field} (${f.type})${f.note ? ` — ${f.note}` : ''}`),
      '',
      'Return ONLY a JSON object, no prose and no code fences, with this exact shape:',
      '{"mappings":[{"column":"<input column>","field":"<field name or null>","confidence":"high"|"medium"|"low"}]}',
      'Every input column must appear exactly once. Use null for field when there is no good match.'
    ].join('\n')
    const userContent = `Columns: ${JSON.stringify(columns)}${
      samples.length ? `\nSample rows: ${JSON.stringify(samples)}` : ''
    }`

    const { model } = await getAiSettings()
    const message = await client.messages.create({
      model,
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
    const raw = message.content[0]?.type === 'text' ? message.content[0].text : ''

    let parsed: { mappings?: unknown }
    try {
      parsed = extractJson(raw) as typeof parsed
    } catch {
      return reply.code(422).send({ error: 'AI returned an unparseable mapping', raw })
    }

    const aiMappings = Array.isArray(parsed.mappings) ? parsed.mappings : []
    const byColumn = new Map<string, { field?: unknown; confidence?: unknown }>()
    for (const m of aiMappings) {
      if (m && typeof m === 'object' && typeof (m as { column?: unknown }).column === 'string') {
        byColumn.set(
          (m as { column: string }).column,
          m as { field?: unknown; confidence?: unknown }
        )
      }
    }

    const mappings = columns.map((column) => {
      const m = byColumn.get(column)
      const field = m && typeof m.field === 'string' && fieldNames.has(m.field) ? m.field : null
      const confidence =
        m && (m.confidence === 'high' || m.confidence === 'medium' || m.confidence === 'low')
          ? m.confidence
          : 'low'
      return { column, field, confidence }
    })

    return reply.send({ mappings })
  })

  // POST /ai/generate — generate content for a specific field using Claude
  /**
   * SQL copilot (#54): generate MSSQL for the custom-query editor from a
   * description, explain an existing query, or fix one that errored — with
   * LIVE schema context injected (tables + columns most relevant to the
   * prompt). Admin only; the result is a draft for the editor, never
   * executed here.
   */
  app.post('/sql', { preHandler: requireAdmin }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply.code(503).send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }
    const b = req.body as { prompt?: string; current_sql?: string; error?: string; mode?: string }
    const mode = ['generate', 'explain', 'fix'].includes(String(b.mode)) ? String(b.mode) : 'generate'
    if (mode === 'generate' && !b.prompt?.trim()) {
      return reply.code(400).send({ error: 'prompt is required' })
    }
    if (mode !== 'generate' && !b.current_sql?.trim()) {
      return reply.code(400).send({ error: 'current_sql is required for explain/fix' })
    }

    // Schema context: every business collection's name, plus full column
    // lists for the ones the prompt/current SQL actually mentions (capped).
    const collections = (await db('nivaro_collections')
      .whereNot('collection', 'like', 'nivaro_%')
      .select('collection')) as Array<{ collection: string }>
    const names = collections.map((c) => c.collection)
    const referenced = new Set<string>()
    const haystack = `${b.prompt ?? ''} ${b.current_sql ?? ''}`.toLowerCase()
    for (const n of names) {
      if (haystack.includes(n.toLowerCase()) || haystack.includes(n.toLowerCase().replace(/_/g, ' '))) {
        referenced.add(n)
      }
    }
    // Words in the prompt that fuzzy-match a table name pull it in too.
    for (const word of haystack.split(/[^a-z_]+/)) {
      if (word.length < 4) continue
      for (const n of names) {
        if (n.toLowerCase().includes(word)) referenced.add(n)
      }
    }
    const detail = [...referenced].slice(0, 12)
    const columnBlocks: string[] = []
    for (const t of detail) {
      try {
        const cols = (await db('information_schema.columns')
          .where({ table_name: t })
          .orderBy('ordinal_position')
          .select('column_name', 'data_type')) as Array<{ column_name: string; data_type: string }>
        columnBlocks.push(`${t}(${cols.map((c) => `${c.column_name} ${c.data_type}`).join(', ')})`)
      } catch {
        /* skip */
      }
    }
    const schemaCtx = `Tables available: ${names.join(', ')}\n\nDetailed schemas:\n${columnBlocks.join('\n')}`

    const instructions =
      mode === 'explain'
        ? `Explain what this SQL query does, in plain language a business analyst understands. Note any correctness risks.\n\nSQL:\n${b.current_sql}`
        : mode === 'fix'
          ? `This SQL query failed. Fix it. Return the corrected SQL in a fenced sql code block followed by ONE sentence about what was wrong.\n\nSQL:\n${b.current_sql}\n\nError:\n${b.error ?? '(not provided)'}`
          : `Write a Microsoft SQL Server (T-SQL) query for this request. Params use :name placeholders (e.g. :funding_year). Return the SQL in a fenced sql code block followed by ONE sentence describing it.\n\nRequest: ${b.prompt}${b.current_sql ? `\n\nCurrent query (revise it): ${b.current_sql}` : ''}`

    const { model } = await getAiSettings()
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 1500,
        system: `You are a T-SQL expert working against this Microsoft SQL Server schema. Only reference tables and columns that exist in it.\n\n${schemaCtx}`,
        messages: [{ role: 'user', content: instructions }]
      })
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => ('text' in c ? c.text : ''))
        .join('\n')
      const sqlMatch = text.match(/```sql\n?([\s\S]*?)```/)
      await logActivity({ action: 'ai-sql', user: req.user?.id, comment: mode, req })
      return {
        data: {
          mode,
          sql: sqlMatch ? sqlMatch[1].trim() : null,
          text: text.replace(/```sql[\s\S]*?```/, '').trim()
        }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      return reply.code(502).send({ error: `AI call failed: ${m.slice(0, 300)}` })
    }
  })

  // AI formula assistant (#130): prose -> a {{token}} formula for the shared
  // expression engine (or item.<col> for server write-computed fields).
  app.post('/formula', { preHandler: requireAdmin }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply.code(503).send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }
    const b = req.body as {
      prompt?: string
      collection?: string
      dialect?: string
      current_formula?: string
      fields?: Array<{ field: string; label?: string }>
    }
    if (!b.prompt?.trim()) return reply.code(400).send({ error: 'prompt is required' })
    const dialect = b.dialect === 'server' ? 'server' : 'client'

    // Field context: caller-supplied list wins (the editor knows its exact
    // token set); else the collection's registered fields.
    let fieldLines: string[] = []
    if (Array.isArray(b.fields) && b.fields.length) {
      fieldLines = b.fields
        .slice(0, 120)
        .map((f) => `${f.field}${f.label ? ` — ${f.label}` : ''}`)
    } else if (b.collection && /^[A-Za-z_][A-Za-z0-9_]*$/.test(b.collection)) {
      try {
        const rows = (await db('nivaro_fields')
          .where({ collection: b.collection })
          .select('field', 'label', 'type')) as Array<{ field: string; label: string | null; type: string }>
        fieldLines = rows.slice(0, 120).map((r) => `${r.field} (${r.type})${r.label ? ` — ${r.label}` : ''}`)
      } catch {
        /* no field context */
      }
    }
    const tokenForm = dialect === 'server' ? 'item.<field>' : '{{<field>}}'
    const fnList =
      dialect === 'server'
        ? 'concat, join, upper, lower, trim, len, substr, replace, coalesce, networkdays(a,b), fiscal_year(d), fiscal_quarter(d), abs, round, floor, ceil'
        : 'networkdays(a,b), fiscal_year(d), fiscal_quarter(d), abs, round(n, places), floor, ceil'
    const system = `You write formulas for a CMS expression engine. Field references use the form ${tokenForm}. Supported: + - * / ( ) comparisons && ||, and functions: ${fnList}. ALL_CAPS names (e.g. TAX_RATE) reference instance-wide formula constants. Return ONLY the formula on the first line, then ONE plain-language sentence describing it. Never invent field names — use only the fields listed.`
    const fieldsCtx = fieldLines.length ? `Available fields:\n${fieldLines.join('\n')}` : 'No field list provided.'

    const { model } = await getAiSettings()
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 400,
        system,
        messages: [
          {
            role: 'user',
            content: `${fieldsCtx}\n\nRequest: ${b.prompt}${b.current_formula ? `\n\nCurrent formula (revise it): ${b.current_formula}` : ''}`
          }
        ]
      })
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => ('text' in c ? c.text : ''))
        .join('\n')
        .trim()
      const lines = text.split('\n').filter((l) => l.trim())
      const formula = (lines[0] ?? '').replace(/^`+|`+$/g, '').trim()
      await logActivity({ action: 'ai-formula', user: req.user?.id, comment: b.collection ?? undefined, req })
      return { data: { formula: formula || null, text: lines.slice(1).join(' ').trim() } }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      return reply.code(502).send({ error: `AI call failed: ${m.slice(0, 300)}` })
    }
  })

  app.post('/generate', { preHandler: requireAdmin }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }

    const { collection, item_id, field, context } = req.body as {
      collection?: string
      item_id?: string
      field?: string
      context?: string
    }

    if (!collection || !item_id || !field) {
      return reply.code(400).send({ error: 'collection, item_id, and field are required' })
    }

    const item = await db(collection).where({ id: item_id }).first()
    if (!item) {
      return reply.code(404).send({ error: 'Item not found' })
    }

    const fieldMeta = await db('nivaro_fields').where({ collection, field }).first()

    const prompt = `Generate content for the \`${field}\` field of a \`${collection}\` record.${fieldMeta ? ` Field description: ${fieldMeta.note ?? fieldMeta.field}.` : ''} Existing record data: ${JSON.stringify(item)}. Additional context: ${context ?? 'none'}. Return only the field value, no explanation.`

    const { model, maxTokensGenerate } = await getAiSettings()

    const message = await client.messages.create({
      model,
      max_tokens: maxTokensGenerate,
      messages: [{ role: 'user', content: prompt }]
    })

    const value = message.content[0]?.type === 'text' ? message.content[0].text.trim() : ''

    await logActivity({
      action: 'ai-generate',
      user: req.user?.id,
      collection,
      item: String(item_id),
      comment: field,
      req
    })

    return reply.send({ data: { value } })
  })

  // POST /ai/summarize — summarize a record in 2-3 sentences
  app.post('/summarize', { preHandler: requireAdmin }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }

    const { collection, item_id } = req.body as {
      collection?: string
      item_id?: string
    }

    if (!collection || !item_id) {
      return reply.code(400).send({ error: 'collection and item_id are required' })
    }

    const item = await db(collection).where({ id: item_id }).first()
    if (!item) {
      return reply.code(404).send({ error: 'Item not found' })
    }

    // Prompt templates (#408): a per-collection override replaces the default
    // wording; {{data}} interpolates the record JSON.
    let promptTemplate: string | null = null
    try {
      const aiRow = await db('nivaro_ai_collection_settings')
        .where({ collection })
        .first('prompt_overrides')
      const ov = aiRow?.prompt_overrides ? (JSON.parse(aiRow.prompt_overrides) as { summarize?: string }) : null
      promptTemplate = ov?.summarize?.trim() || null
    } catch {
      promptTemplate = null
    }
    const prompt = promptTemplate
      ? promptTemplate.replace(/\{\{\s*data\s*\}\}/g, JSON.stringify(item))
      : `Summarize this ${collection} record in 2-3 sentences for a business user. Data: ${JSON.stringify(item)}. Be concise and factual.`

    const { model, maxTokensSummarize } = await getAiSettings()

    const message = await client.messages.create({
      model,
      max_tokens: maxTokensSummarize,
      messages: [{ role: 'user', content: prompt }]
    })

    const summary = message.content[0]?.type === 'text' ? message.content[0].text.trim() : ''

    await logActivity({
      action: 'ai-summarize',
      user: req.user?.id,
      collection,
      item: String(item_id),
      req
    })

    return reply.send({ data: { summary } })
  })

  // POST /ai/review — pre-submission record review: findings list over the
  // record + its O2M children, guided by the collection's AI rules when set.
  // Revision summarizer (#160): AI prose over a record's change history in a
  // window — deltas only (small), read-permission gated.
  app.post('/summarize-changes', { preHandler: authenticate }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply.code(503).send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }
    const b = req.body as { collection?: string; item?: string | number; days?: number }
    const collection = String(b.collection ?? '')
    const item = String(b.item ?? '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection) || /^nivaro_/i.test(collection) || !item) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }
    const { can } = await import('../services/permissions.js')
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const days = Math.max(1, Math.min(365, Number(b.days) || 30))
    const revs = (await db('nivaro_revisions')
      .join('nivaro_activity', 'nivaro_revisions.activity', 'nivaro_activity.id')
      .where('nivaro_revisions.collection', collection)
      .where('nivaro_revisions.item', item)
      .where('nivaro_activity.timestamp', '>=', db.raw('DATEADD(day, ?, GETUTCDATE())', [-days]))
      .orderBy('nivaro_activity.timestamp', 'asc')
      .limit(120)
      .select(
        'nivaro_revisions.delta',
        'nivaro_activity.timestamp',
        'nivaro_activity.action',
        'nivaro_activity.user'
      )) as Array<{ delta: string | null; timestamp: Date; action: string; user: string | null }>
    if (revs.length === 0) {
      return { data: { summary: `No recorded changes in the last ${days} days.`, changes: 0 } }
    }
    // Attribute changes by name (batched)
    const userIds = [...new Set(revs.map((r) => r.user).filter(Boolean))] as string[]
    const users = userIds.length
      ? ((await db('nivaro_users')
          .whereIn('id', userIds)
          .select('id', 'first_name', 'last_name')) as Array<{
          id: string
          first_name: string | null
          last_name: string | null
        }>)
      : []
    const nameOf = new Map(users.map((u) => [u.id, `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim()]))
    const lines = revs
      .map((r) => {
        let delta: Record<string, unknown> = {}
        try {
          delta = r.delta ? JSON.parse(r.delta) : {}
        } catch {
          delta = {}
        }
        const who = (r.user && nameOf.get(r.user)) || 'system'
        const when = new Date(r.timestamp).toISOString().slice(0, 10)
        const fields = Object.entries(delta)
          .slice(0, 12)
          .map(([k, v]) => `${k} → ${String(v).slice(0, 60)}`)
          .join('; ')
        return `${when} ${who} (${r.action}): ${fields || '(no field delta)'}`
      })
      .join('\n')
      .slice(0, 12000)
    const { model } = await getAiSettings()
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 400,
        system:
          'You summarize a database record\u2019s change history for a business reader. 2-5 sentences of plain prose: what changed, the overall direction, and who drove it. Note reversals or churn. Never invent changes not in the log.',
        messages: [{ role: 'user', content: `Changes to ${collection}/${item} over the last ${days} days:\n${lines}` }]
      })
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => ('text' in c ? c.text : ''))
        .join('\n')
        .trim()
      await logActivity({ action: 'ai-summarize-changes', user: req.user?.id, collection, item, req })
      return { data: { summary: text, changes: revs.length } }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      return reply.code(502).send({ error: `AI call failed: ${m.slice(0, 300)}` })
    }
  })

  app.post('/review', { preHandler: authenticate }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }
    const { collection, item } = req.body as { collection?: string; item?: string | number }
    if (!collection || item == null) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }
    if (/^nivaro_/i.test(collection) || !/^[A-Za-z0-9_]+$/.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const record = await db(collection).where({ id: item }).first()
    if (!record) return reply.code(404).send({ error: 'Item not found' })

    // Pull up to 3 O2M child sets so line items ride into the review.
    const children: Record<string, unknown[]> = {}
    try {
      const rels = (await db('nivaro_relations')
        .where({ one_collection: collection })
        .whereNotNull('many_collection')
        .limit(3)) as Array<{ many_collection: string; many_field: string; one_field: string | null }>
      for (const rel of rels) {
        if (!rel.many_collection || !rel.many_field) continue
        if (!/^[A-Za-z0-9_]+$/.test(rel.many_collection) || !/^[A-Za-z0-9_]+$/.test(rel.many_field))
          continue
        const rows = await db(rel.many_collection)
          .where({ [rel.many_field]: record.id })
          .limit(50)
        if (rows.length) children[rel.many_collection] = rows
      }
    } catch {
      // Children are best-effort context — never fail the review over them.
    }

    // Per-collection review guidance (plain-text AI rules, if configured).
    let guidance = ''
    try {
      const settings = await getAiCollectionSettings(collection)
      const textRules = (settings?.validation_rules ?? []).filter(
        (r): r is string => typeof r === 'string'
      )
      if (textRules.length) guidance = `\nCollection-specific rules:\n- ${textRules.join('\n- ')}`
    } catch {}

    const prompt = `You are reviewing a "${collection}" record before submission. Identify concrete problems a reviewer would flag: missing or blank required-looking fields, quantities/prices that are zero or negative, dates in the past where a future date is expected, inconsistent or placeholder text, and incomplete line items.${guidance}

Record:
${JSON.stringify(record).slice(0, 8000)}

${Object.entries(children)
  .map(([name, rows]) => `Related ${name} (${rows.length}):\n${JSON.stringify(rows).slice(0, 6000)}`)
  .join('\n\n')}

Respond with ONLY a JSON array (no prose): [{"severity":"error"|"warning"|"suggestion","field":"<field name or area>","message":"<specific, actionable finding>"}]. Return [] if the record looks ready.`

    const { model } = await getAiSettings()
    const message = await client.messages.create({
      model,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    let findings: Array<{ severity: string; field: string; message: string }> = []
    try {
      const match = text.match(/\[[\s\S]*\]/)
      if (match) {
        const parsed = JSON.parse(match[0]) as unknown
        if (Array.isArray(parsed)) {
          findings = parsed
            .filter(
              (f): f is { severity: string; field: string; message: string } =>
                !!f && typeof f === 'object' && typeof (f as { message?: unknown }).message === 'string'
            )
            .map((f) => ({
              severity: ['error', 'warning', 'suggestion'].includes(f.severity)
                ? f.severity
                : 'suggestion',
              field: String(f.field ?? ''),
              message: f.message
            }))
        }
      }
    } catch {}

    await logActivity({
      action: 'ai-review',
      user: req.user?.id,
      collection,
      item: String(item),
      req
    })
    return reply.send({ data: { findings } })
  })

  // POST /ai/brief — render a short plain-text briefing from caller-supplied
  // context (dashboard daily summaries etc.). The caller gathers the data —
  // this endpoint only writes the words.
  // AI text cleanup (#217): grammar/clarity fix on user prose — returns the
  // corrected text ONLY, meaning preserved.
  app.post('/cleanup', { preHandler: authenticate }, async (req, reply) => {
    if (!(await aiFeatureEnabled('cleanup'))) {
      return reply.code(403).send({ error: 'AI text cleanup is disabled on this instance' })
    }
    const client = await getClient()
    if (!client) return reply.code(503).send({ error: 'AI is not configured' })
    const text = String((req.body as { text?: string })?.text ?? '').slice(0, 4000)
    if (!text.trim()) return reply.code(400).send({ error: 'text is required' })
    const { model } = await getAiSettings()
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: Math.min(2000, text.length + 200),
        system:
          'Fix grammar, spelling and clarity in the user\u2019s text. PRESERVE meaning, tone, names, numbers and formatting. Return ONLY the corrected text — no preamble, no notes.',
        messages: [{ role: 'user', content: text }]
      })
      const out = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => ('text' in c ? c.text : ''))
        .join('')
        .trim()
      return { data: { text: out || text } }
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message.slice(0, 200) : 'AI call failed' })
    }
  })

  app.post('/brief', { preHandler: authenticate }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }
    const { context, instructions } = req.body as { context?: string; instructions?: string }
    if (!context?.trim()) return reply.code(400).send({ error: 'context is required' })

    const system =
      instructions?.slice(0, 1000) ||
      'You write a short daily briefing for a business user from the data provided. Open with one summary sentence, then 3-5 concrete insights citing real numbers from the data, call out anything needing immediate attention, and end with one or two positives. Plain text only — no markdown, no headers. 150-220 words.'

    const { model } = await getAiSettings()
    const message = await client.messages.create({
      model,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: context.slice(0, 16000) }]
    })
    const briefText = message.content[0]?.type === 'text' ? message.content[0].text.trim() : ''

    await logActivity({ action: 'ai-brief', user: req.user?.id, req })
    return reply.send({ data: { brief: briefText } })
  })

  // POST /ai/validate — pre-save content validation against the collection's AI rules.
  // Soft companion to the before-hook: lets the UI warn before submitting. Returns
  // an empty violations list when validation is disabled or no API key is set.
  app.post('/validate', { preHandler: authenticate }, async (req, reply) => {
    const { collection, data } = req.body as {
      collection?: string
      data?: Record<string, unknown>
    }
    if (!collection || !data || typeof data !== 'object') {
      return reply.code(400).send({ error: 'collection and data are required' })
    }
    if (collection.startsWith('nivaro_')) {
      return reply.code(403).send({ error: 'System collections cannot be validated' })
    }
    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const settings = await getAiCollectionSettings(collection)
    if (!settings.validation_enabled || settings.validation_rules.length === 0) {
      return reply.send({ violations: [], mode: settings.validation_mode, enabled: false })
    }

    try {
      const violations = await runAiValidation(collection, data, settings.validation_rules)
      return reply.send({ violations, mode: settings.validation_mode, enabled: true })
    } catch (err) {
      // Provider failure — never surface as a blocking error pre-save
      req.log.warn({ err, collection }, 'AI validation request failed')
      return reply.send({ violations: [], mode: settings.validation_mode, enabled: true })
    }
  })

  // POST /ai/check-duplicates — embedding-based duplicate lookup for a draft record
  app.post('/check-duplicates', { preHandler: authenticate }, async (req, reply) => {
    const { collection, data, exclude_id } = req.body as {
      collection?: string
      data?: Record<string, unknown>
      exclude_id?: string | number | null
    }
    if (!collection || !data || typeof data !== 'object') {
      return reply.code(400).send({ error: 'collection and data are required' })
    }
    if (collection.startsWith('nivaro_')) {
      return reply.code(403).send({ error: 'System collections cannot be checked' })
    }
    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const settings = await getAiCollectionSettings(collection)
    if (!settings.duplicate_detection_enabled) {
      return reply.send({ duplicates: [], enabled: false })
    }

    try {
      const duplicates = await findDuplicates(
        collection,
        data,
        settings.duplicate_threshold,
        exclude_id != null ? String(exclude_id) : null
      )
      return reply.send({ duplicates, enabled: true })
    } catch (err) {
      req.log.warn({ err, collection }, 'AI duplicate check failed')
      return reply.send({ duplicates: [], enabled: true })
    }
  })

  // ─── POST /chat — ask-your-data tool-use loop ─────────────────────────────
  app.post('/chat', { preHandler: authenticate }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }
    const { messages } = req.body as { messages?: Array<{ role: string; content: string }> }
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: 'messages array is required' })
    }
    const history = messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-20)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 4000) }))
    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      return reply.code(400).send({ error: 'last message must be from the user' })
    }

    const { CHAT_SYSTEM_PROMPT, CHAT_TOOLS, MAX_ROUNDS, executeChatTool } = await import(
      '../services/ai-chat.js'
    )
    const settings = await getAiSettings()
    const trace: Array<{ tool: string; input: Record<string, unknown>; summary: string }> = []
    const proposals: Array<Record<string, unknown>> = []
    const convo: Anthropic.MessageParam[] = history

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const response = await client.messages.create({
          model: settings.model,
          max_tokens: 1500,
          system: CHAT_SYSTEM_PROMPT,
          tools: CHAT_TOOLS,
          messages: convo
        })

        if (response.stop_reason !== 'tool_use') {
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
          await logActivity({
            action: 'ai-chat',
            user: req.user?.id,
            comment: `${trace.length} tool call(s)`,
            req
          })
          return reply.send({ data: { reply: text, trace, proposals } })
        }

        convo.push({ role: 'assistant', content: response.content })
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          const input = (block.input ?? {}) as Record<string, unknown>
          try {
            const { result, summary } = await executeChatTool(req.user!, block.name, input)
            trace.push({ tool: block.name, input, summary })
            if (block.name === 'propose_action' && result && typeof result === 'object') {
              proposals.push(result as Record<string, unknown>)
            }
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result).slice(0, 30_000)
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Tool failed'
            trace.push({ tool: block.name, input, summary: `error: ${msg}` })
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: ${msg}`,
              is_error: true
            })
          }
        }
        convo.push({ role: 'user', content: results })
      }
      return reply.send({
        data: {
          reply: 'I hit the tool-call limit before finishing — try a more specific question.',
          trace,
          proposals
        }
      })
    } catch (err) {
      req.log.error({ err }, 'AI chat failed')
      return reply.code(502).send({ error: 'AI request failed' })
    }
  })

  // ─── POST /navigate — command-bar routing: prose → target collection ──────
  app.post('/navigate', { preHandler: authenticate }, async (req, reply) => {
    const client = await getClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require ANTHROPIC_API_KEY to be configured' })
    }
    const { prompt } = req.body as { prompt?: string }
    if (!prompt?.trim()) return reply.code(400).send({ error: 'prompt is required' })

    const cols = (await db('nivaro_collections')
      .whereNot('collection', 'like', 'nivaro_%')
      .select('collection', 'display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    const readable: string[] = []
    for (const c of cols) {
      if (await can(req.user!, 'read', c.collection)) {
        readable.push(
          c.display_name ? `${c.collection} (${c.display_name})` : c.collection
        )
      }
    }
    if (readable.length === 0) return reply.code(403).send({ error: 'No readable collections' })

    const settings = await getAiSettings()
    try {
      const response = await client.messages.create({
        model: settings.model,
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: `Which ONE collection is this query about?\n\nQuery: ${prompt.slice(0, 300)}\n\nCollections:\n${readable.join('\n')}\n\nAnswer with JSON only: {"collection": "<name>"} — use the machine name before any parenthesis. If none fits, {"collection": null}.`
          }
        ]
      })
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const parsed = extractJson(text) as { collection?: string | null }
      const target = parsed?.collection
      if (!target || !readable.some((r) => r === target || r.startsWith(`${target} (`))) {
        return reply.send({ data: { collection: null } })
      }
      return reply.send({ data: { collection: target } })
    } catch (err) {
      req.log.error({ err }, 'AI navigate failed')
      return reply.code(502).send({ error: 'AI request failed' })
    }
  })

  // ─── AI action proposals — explicit user approval executes ────────────────
  app.post('/proposals/:id/approve', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const { executeProposal } = await import('../services/ai-actions.js')
      const out = await executeProposal(req.user!, id)
      await logActivity({
        action: 'ai-action-execute',
        user: req.user?.id,
        comment: `proposal ${id}: ${JSON.stringify(out.result).slice(0, 200)}`,
        req
      })
      return reply.send({ data: out })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400
      return reply.code(status).send({ error: err instanceof Error ? err.message : 'Failed' })
    }
  })

  app.post('/proposals/:id/reject', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const { rejectProposal } = await import('../services/ai-actions.js')
      await rejectProposal(req.user!, id)
      await logActivity({
        action: 'ai-action-reject',
        user: req.user?.id,
        comment: `proposal ${id}`,
        req
      })
      return reply.code(204).send()
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400
      return reply.code(status).send({ error: err instanceof Error ? err.message : 'Failed' })
    }
  })
}
