import Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { findDuplicates, getAiCollectionSettings, runAiValidation } from '../hooks/ai-validation.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

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

    const prompt = `Summarize this ${collection} record in 2-3 sentences for a business user. Data: ${JSON.stringify(item)}. Be concise and factual.`

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
}
