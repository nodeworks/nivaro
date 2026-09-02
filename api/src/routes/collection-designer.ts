/**
 * Collection Designer — AI-assisted collection creation (routes under
 * /data-model/designer, requireAdmin).
 *
 * Three-step contract, deliberately proposal-first: nothing here creates
 * schema until an explicit /apply with a human-reviewed plan.
 *
 *   POST /parse    — multipart xlsx/csv upload → sheet inventory + a short-
 *                    lived file_token (parsed rows cached in-process, 30 min)
 *   POST /analyze  — { prompt } or { file_token, sheet } (or { plan,
 *                    instruction } to refine) → a PROPOSED DesignPlan
 *   POST /apply    — { plan, import? } → creates tables/columns/metadata/
 *                    relations, optionally imports the parsed rows
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import * as XLSX from 'xlsx'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getAiClient, getAiModelSettings } from '../services/ai-client.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const COLUMN_TYPES = new Set([
  'string',
  'text',
  'integer',
  'bigInteger',
  'boolean',
  'decimal',
  'float',
  'date',
  'datetime',
  'uuid'
])
const INTERFACES = new Set([
  'input',
  'textarea',
  'rich_text',
  'select-dropdown',
  'boolean',
  'datetime',
  'm2o',
  'tags'
])

export interface DesignField {
  field: string
  label?: string
  type: string
  interface?: string
  required?: boolean
  options?: Record<string, unknown> | null
  relation?: { related_collection: string; match_field?: string | null; junction?: string | null } | null
  source_column?: string | null
}

export interface DesignCollection {
  collection: string
  display_name: string
  singular?: string | null
  note?: string | null
  display_template?: string | null
  fields: DesignField[]
  /** Re-import upsert key — the pivot the generated import proc merges on. */
  import_key?: string[]
}

export interface DesignPlan {
  collections: DesignCollection[]
  notes?: string
}

// ─── parsed-file cache (per-replica, admin-UI-scoped) ─────────────────────

interface CachedFile {
  name: string
  sheets: Record<string, unknown[][]>
  ts: number
}
const fileCache = new Map<string, CachedFile>()
const FILE_TTL_MS = 30 * 60 * 1000
const FILE_CACHE_MAX = 20

function sweepCache() {
  const now = Date.now()
  for (const [k, v] of fileCache) if (now - v.ts > FILE_TTL_MS) fileCache.delete(k)
  while (fileCache.size > FILE_CACHE_MAX) {
    const oldest = [...fileCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (!oldest) break
    fileCache.delete(oldest[0])
  }
}

// ─── column statistics (grounds the AI beyond a handful of sample rows) ───

interface ColStats {
  column: string
  non_empty: number
  distinct: number
  samples: string[]
  numeric_pct: number
  date_like_pct: number
  max_len: number
}

function columnStats(rows: unknown[][], colIdx: number, column: string): ColStats {
  const seen = new Set<string>()
  let nonEmpty = 0
  let numeric = 0
  let dateLike = 0
  let maxLen = 0
  const scan = rows.slice(1, 801)
  for (const row of scan) {
    const raw = row?.[colIdx]
    if (raw === null || raw === undefined || String(raw).trim() === '') continue
    const s = String(raw).trim()
    nonEmpty++
    maxLen = Math.max(maxLen, s.length)
    if (seen.size < 400) seen.add(s.toLowerCase())
    const cleaned = s.replace(/[$,%\s]/g, '')
    if (cleaned !== '' && !Number.isNaN(Number(cleaned))) numeric++
    if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}([ T]|$)/.test(s)) dateLike++
  }
  const samples: string[] = []
  for (const v of seen) {
    samples.push(v.slice(0, 60))
    if (samples.length >= 6) break
  }
  return {
    column,
    non_empty: nonEmpty,
    distinct: seen.size,
    samples,
    numeric_pct: nonEmpty ? Math.round((numeric / nonEmpty) * 100) : 0,
    date_like_pct: nonEmpty ? Math.round((dateLike / nonEmpty) * 100) : 0,
    max_len: maxLen
  }
}

// ─── relation evidence — deterministic value-probe, fed to the model ──────
// "warehouse" whose values all appear in warehouses.name is an m2o FACT,
// not a guess — compute it server-side so the model can't miss it.

interface RelationEvidence {
  column: string
  collection: string
  match_field: string
  match_pct: number
  sampled: number
}

const NAME_ISH = ['name', 'code', 'short_name', 'label', 'title', 'key']

async function detectRelationEvidence(
  headers: string[],
  rows: unknown[][]
): Promise<RelationEvidence[]> {
  const collections = (
    (await db('nivaro_collections').whereNot('collection', 'like', 'nivaro_%').pluck(
      'collection'
    )) as string[]
  ).map((c) => c.toLowerCase())
  const collSet = new Set(collections)
  const out: RelationEvidence[] = []
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    if (!header) continue
    const stem = header
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_?(name|code|id|number|desc|description)$/, '')
      .replace(/_+$/, '')
    if (!stem) continue
    const candidates = new Set<string>()
    for (const cand of [stem, `${stem}s`, `${stem}es`, stem.replace(/y$/, 'ies')]) {
      if (collSet.has(cand)) candidates.add(cand)
    }
    if (collSet.has(stem.replace(/s$/, ''))) candidates.add(stem.replace(/s$/, ''))
    if (!candidates.size) continue
    // distinct sample values from the sheet column
    const vals = new Set<string>()
    for (const row of rows.slice(1, 801)) {
      const v = String(row?.[i] ?? '').trim().toLowerCase()
      if (v && vals.size < 25) vals.add(v)
    }
    if (vals.size < 1) continue
    for (const cand of candidates) {
      try {
        const cols = (await db('information_schema.columns')
          .where({ table_name: cand })
          .pluck('column_name')) as string[]
        const lower = cols.map((c) => c.toLowerCase())
        for (const mf of NAME_ISH) {
          if (!lower.includes(mf)) continue
          const targetVals = new Set(
            ((await db(cand).limit(20000).pluck(mf)) as unknown[]).map((v) =>
              String(v ?? '').trim().toLowerCase()
            )
          )
          let matched = 0
          for (const v of vals) if (targetVals.has(v)) matched++
          const pct = Math.round((matched / vals.size) * 100)
          if (pct >= 60) {
            out.push({
              column: header,
              collection: cand,
              match_field: mf,
              match_pct: pct,
              sampled: vals.size
            })
            break
          }
        }
      } catch {
        /* candidate probe failure never blocks analysis */
      }
    }
  }
  return out
}

// ─── plan sanitizer — the model proposes, this decides what may render ────

async function sanitizePlan(raw: unknown): Promise<DesignPlan> {
  const existing = new Set(
    ((await db('nivaro_collections').pluck('collection')) as string[]).map((c) => c.toLowerCase())
  )
  const plan: DesignPlan = { collections: [], notes: undefined }
  const obj = (raw ?? {}) as { collections?: unknown; notes?: unknown }
  if (typeof obj.notes === 'string') plan.notes = obj.notes.slice(0, 2000)
  const cols = Array.isArray(obj.collections) ? obj.collections.slice(0, 6) : []
  // Pre-collect every valid in-plan name FIRST — a relation may point at a
  // collection defined LATER in the array (main table before its lookup
  // table), and validating during the same loop silently dropped those.
  const planNames = new Set<string>()
  for (const c of cols) {
    const n = String((c as Partial<DesignCollection>).collection ?? '').trim()
    if (IDENT.test(n) && !/^(nivaro|directus)_/i.test(n)) planNames.add(n.toLowerCase())
  }
  const emitted = new Set<string>()
  for (const c of cols) {
    const cc = c as Partial<DesignCollection>
    const name = String(cc.collection ?? '').trim()
    if (!IDENT.test(name) || /^(nivaro|directus)_/i.test(name)) continue
    if (emitted.has(name.toLowerCase())) continue
    emitted.add(name.toLowerCase())
    const fields: DesignField[] = []
    const seenFields = new Set(['id', 'created_at'])
    for (const f of Array.isArray(cc.fields) ? cc.fields.slice(0, 120) : []) {
      const ff = f as Partial<DesignField>
      const fname = String(ff.field ?? '').trim()
      if (!IDENT.test(fname) || seenFields.has(fname.toLowerCase())) continue
      if (!COLUMN_TYPES.has(String(ff.type))) continue
      seenFields.add(fname.toLowerCase())
      let relation: DesignField['relation'] = null
      let relTarget = String(ff.relation?.related_collection ?? '').trim()
      // Legacy shape from imported schemas — users live in nivaro_users now.
      if (relTarget.toLowerCase() === 'directus_users') relTarget = 'nivaro_users'
      if (relTarget) {
        // Relation targets: existing business collections, in-plan siblings,
        // or nivaro_users — the one allowed system parent (documented rule).
        const lower = relTarget.toLowerCase()
        const allowed =
          lower === 'nivaro_users' ||
          (IDENT.test(relTarget) &&
            !/^(nivaro|directus)_/i.test(relTarget) &&
            (existing.has(lower) || planNames.has(lower)))
        if (allowed) {
          const mf = String(
            (ff.relation as { match_field?: unknown } | undefined)?.match_field ?? ''
          ).trim()
          const jn = String(
            (ff.relation as { junction?: unknown } | undefined)?.junction ?? ''
          ).trim()
          relation = {
            related_collection: relTarget,
            match_field: IDENT.test(mf) ? mf : null,
            junction:
              IDENT.test(jn) && !/^(nivaro|directus)_/i.test(jn) && jn.length <= 120 ? jn : null
          }
        }
      }
      let options: Record<string, unknown> | null = null
      if (ff.options && typeof ff.options === 'object') {
        const choices = (ff.options as { choices?: unknown }).choices
        if (Array.isArray(choices)) {
          const clean = choices
            .slice(0, 40)
            .map((ch) => ch as { value?: unknown; text?: unknown })
            .filter((ch) => ch && ch.value !== undefined)
            .map((ch) => ({
              value: String(ch.value).slice(0, 120),
              text: String(ch.text ?? ch.value).slice(0, 120)
            }))
          if (clean.length) options = { choices: clean }
        }
      }
      fields.push({
        field: fname,
        label: typeof ff.label === 'string' ? ff.label.slice(0, 120) : undefined,
        type: String(ff.type),
        interface: INTERFACES.has(String(ff.interface)) ? String(ff.interface) : undefined,
        required: ff.required === true,
        options,
        relation,
        source_column: typeof ff.source_column === 'string' ? ff.source_column : null
      })
    }
    if (!fields.length) continue
    const fieldNames = new Set(fields.filter((f) => f.type !== 'm2m').map((f) => f.field))
    const importKey = (Array.isArray(cc.import_key) ? cc.import_key : [])
      .map((k) => String(k).trim())
      .filter((k) => fieldNames.has(k))
      .slice(0, 5)
    plan.collections.push({
      collection: name,
      display_name: String(cc.display_name ?? name).slice(0, 120),
      singular: typeof cc.singular === 'string' ? cc.singular.slice(0, 120) : null,
      note: typeof cc.note === 'string' ? cc.note.slice(0, 500) : null,
      display_template:
        typeof cc.display_template === 'string' ? cc.display_template.slice(0, 255) : null,
      fields,
      import_key: importKey
    })
  }
  return plan
}

async function schemaContext(hint: string): Promise<string> {
  const collections = (await db('nivaro_collections')
    .whereNot('collection', 'like', 'nivaro_%')
    .pluck('collection')) as string[]
  const hay = hint.toLowerCase()
  const wanted = collections.filter((c) => {
    const base = c.toLowerCase()
    return hay.includes(base) || hay.includes(base.replace(/s$/, '')) || hay.includes(base.replace(/_/g, ' '))
  })
  const blocks: string[] = []
  for (const t of wanted.slice(0, 10)) {
    try {
      const cols = (await db('information_schema.columns')
        .where({ table_name: t })
        .orderBy('ordinal_position')
        .limit(40)
        .select('column_name', 'data_type')) as Array<{ column_name: string; data_type: string }>
      blocks.push(`${t}(${cols.map((c) => c.column_name).join(', ')})`)
    } catch {
      /* skip */
    }
  }
  return `Existing collections: ${collections.join(', ')}\n${blocks.length ? `Relevant column detail:\n${blocks.join('\n')}` : ''}`
}

const PLAN_SHAPE = `Return ONLY a fenced json code block with this exact shape:
{
  "collections": [{
    "collection": "snake_case_table_name",
    "display_name": "Human Name",
    "singular": "Human Name Singular",
    "note": "one-line purpose",
    "display_template": "{{best_identifying_field}}",
    "fields": [{
      "field": "snake_case",
      "label": "Human Label",
      "type": "string|text|integer|bigInteger|boolean|decimal|float|date|datetime|uuid",
      "interface": "input|textarea|rich_text|select-dropdown|boolean|datetime|m2o|tags",
      "required": false,
      "options": {"choices": [{"value": "x", "text": "X"}]},
      "relation": {"related_collection": "existing_or_new_collection"},
      "source_column": "Original Column Header"
    }]
  }],
  "notes": "short explanation of decisions, skipped columns, and suggested follow-ups"
}

Rules:
- field/collection names snake_case; never prefix nivaro_ or directus_; never include id or created_at fields (added automatically).
- A dropdown/enum = type string + interface select-dropdown + options.choices — only when the values are a small closed set (roughly ≤15 distinct that repeat heavily).
- Money = type decimal. Counts/quantities = integer (or decimal when fractional). Percent = decimal.
- Dates = type date (or datetime only when a time of day matters), interface datetime.
- Propose an m2o relation ONLY when a column clearly holds identifiers/keys of an existing collection, or when normalizing into a new collection defined in this same plan (e.g. repeated supplier names → a suppliers collection with a name field, and the main table gets supplier m2o). A relation field's type is integer (uuid when the target is nivaro_users).
- When a relation's source column holds DISPLAY values (codes, names) rather than numeric ids, the relation MUST include "match_field": the column on the target collection those values match (for a new in-plan target, the field that will store them — and that field then needs NO source_column of its own; the importer fills it from the distinct values). Omit match_field only when the source values are literal numeric ids.
- Long free text = type text, interface textarea (rich_text only for authored content).
- Mark "required": true ONLY for identity-critical fields (the record's key identifier, a mandatory relation) — measurement, quantity, date, and free-text fields default to optional.
- Skip useless columns (fully empty, duplicate of another) and say so in notes.
- source_column: for file-derived fields, the EXACT original header; omit for invented fields.
- For the MAIN file-derived collection, include "import_key": the minimal field set that uniquely identifies one row of the file (e.g. ["po_number","item_number"]) — it becomes the upsert key when the same file shape is re-imported. Omit only when no combination is unique.`

// ─── routes ───────────────────────────────────────────────────────────────

export async function collectionDesignerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // POST /parse — upload a spreadsheet, get sheet inventory + file_token
  app.post('/parse', async (req, reply) => {
    const file = await (
      req as unknown as {
        file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | undefined>
      }
    ).file()
    if (!file) return reply.code(400).send({ error: 'A file is required' })
    let wb: XLSX.WorkBook
    try {
      wb = XLSX.read(await file.toBuffer(), { type: 'buffer', raw: false, cellDates: false })
    } catch {
      return reply.code(400).send({ error: 'Could not parse the file — is it a valid xlsx/csv?' })
    }
    const sheets: Record<string, unknown[][]> = {}
    const inventory: Array<{ name: string; columns: string[]; row_count: number }> = []
    for (const name of wb.SheetNames.slice(0, 12)) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
        header: 1,
        raw: false,
        defval: null
      }) as unknown[][]
      if (!rows.length) continue
      sheets[name] = rows
      inventory.push({
        name,
        columns: (rows[0] ?? []).map((c) => String(c ?? '').trim()).filter(Boolean),
        row_count: Math.max(0, rows.length - 1)
      })
    }
    if (!inventory.length) return reply.code(400).send({ error: 'No usable sheets found in the file' })
    sweepCache()
    const token = randomUUID()
    fileCache.set(token, { name: file.filename, sheets, ts: Date.now() })
    return { data: { file_token: token, file_name: file.filename, sheets: inventory } }
  })

  // POST /analyze — prompt-mode, file-mode, or refine-mode → proposed plan
  app.post('/analyze', async (req, reply) => {
    const b = req.body as {
      prompt?: string
      file_token?: string
      sheet?: string
      plan?: unknown
      instruction?: string
    }
    const client = await getAiClient()
    if (!client) {
      return reply
        .code(503)
        .send({ error: 'AI features require an Anthropic API key (Settings → AI Features)' })
    }

    let userContent = ''
    let hint = String(b.prompt ?? '')
    let fileMeta: { sheet: string; row_count: number } | null = null

    if (b.plan && b.instruction?.trim()) {
      // Refine an existing (possibly hand-edited) plan.
      const current = await sanitizePlan(b.plan)
      hint += ` ${JSON.stringify(current.collections.map((c) => c.collection))}`
      userContent = `Here is the current proposed plan:\n\`\`\`json\n${JSON.stringify(current, null, 1).slice(0, 24000)}\n\`\`\`\n\nAdjust it per this instruction, keeping everything else intact:\n${b.instruction.slice(0, 2000)}`
    } else if (b.file_token) {
      const cached = fileCache.get(b.file_token)
      if (!cached) {
        return reply
          .code(410)
          .send({ error: 'The uploaded file has expired — upload it again' })
      }
      const sheetName = b.sheet && cached.sheets[b.sheet] ? b.sheet : Object.keys(cached.sheets)[0]
      const rows = cached.sheets[sheetName]
      const headers = (rows[0] ?? []).map((c) => String(c ?? '').trim())
      const stats = headers
        .map((h, i) => (h ? columnStats(rows, i, h) : null))
        .filter(Boolean) as ColStats[]
      const sample = rows
        .slice(1, 9)
        .map((r) => headers.map((_, i) => String(r?.[i] ?? '').slice(0, 60)))
      fileMeta = { sheet: sheetName, row_count: rows.length - 1 }
      hint += ` ${headers.join(' ')}`
      const evidence = await detectRelationEvidence(headers, rows)
      const evidenceBlock = evidence.length
        ? `\n\nRELATION EVIDENCE (verified against live data — you MUST honor these as m2o relations with the given match_field unless the user says otherwise):\n${evidence
            .map(
              (e) =>
                `- column "${e.column}": ${e.match_pct}% of ${e.sampled} sampled distinct values exist in ${e.collection}.${e.match_field} -> m2o to ${e.collection}, match_field "${e.match_field}"`
            )
            .join('\n')}`
        : ''

      userContent = `Design collection(s) for this spreadsheet ("${cached.name}", sheet "${sheetName}", ${rows.length - 1} data rows).${b.prompt?.trim() ? `\nUser guidance: ${b.prompt.slice(0, 1000)}` : ''}

Column statistics (from up to 800 rows):
${stats
  .map(
    (s) =>
      `- "${s.column}": ${s.non_empty} non-empty, ${s.distinct} distinct, ${s.numeric_pct}% numeric, ${s.date_like_pct}% date-like, max len ${s.max_len}. Samples: ${s.samples.join(' | ') || '(none)'}`
  )
  .join('\n')}

Sample rows:
${sample.map((r) => JSON.stringify(r)).join('\n').slice(0, 16000)}${evidenceBlock}`
    } else if (b.prompt?.trim()) {
      userContent = `Design collection(s) for this request:\n${b.prompt.slice(0, 4000)}`
    } else {
      return reply.code(400).send({ error: 'Provide a prompt, a file_token, or a plan + instruction' })
    }

    const context = await schemaContext(hint)
    const { model } = await getAiModelSettings()
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 8000,
        system: `You are a data modeler for a headless CMS on Microsoft SQL Server. You design collections (tables) with typed fields and relations. You only PROPOSE — a human reviews and edits your plan before anything is created.\n\n${context}\n\n${PLAN_SHAPE}`,
        messages: [{ role: 'user', content: userContent }]
      })
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => ('text' in c ? c.text : ''))
        .join('\n')
      const jsonMatch = text.match(/```json\n?([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/)
      let parsed: unknown = null
      try {
        parsed = JSON.parse(jsonMatch?.[1] ?? '{}')
      } catch {
        return reply.code(502).send({ error: 'AI returned an unparseable plan — try again' })
      }
      const plan = await sanitizePlan(parsed)
      // Insurance: a relation sourced from a DISPLAY-value column (names,
      // codes) is useless without match_field — the importer would parseInt
      // names into null. When the model omits it, derive one: in-plan target
      // → its first string field (or "name"); existing target → the first
      // name-ish column it actually has.
      if (b.file_token) {
        const cached2 = fileCache.get(b.file_token)
        const sheetName2 =
          b.sheet && cached2?.sheets[b.sheet] ? b.sheet : Object.keys(cached2?.sheets ?? {})[0]
        const rows2 = cached2?.sheets[sheetName2]
        const headers2 = ((rows2?.[0] as unknown[]) ?? []).map((c) => String(c ?? '').trim())
        const inPlan = new Map(plan.collections.map((c) => [c.collection.toLowerCase(), c]))
        for (const c of plan.collections) {
          for (const f of c.fields) {
            if (!f.relation || f.relation.match_field || !f.source_column) continue
            const idx = headers2.indexOf(f.source_column)
            if (idx < 0 || !rows2) continue
            const st = columnStats(rows2, idx, f.source_column)
            if (st.numeric_pct >= 90) continue
            const targetLower = f.relation.related_collection.toLowerCase()
            const planTarget = inPlan.get(targetLower)
            if (planTarget) {
              f.relation.match_field =
                planTarget.fields.find((tf) => tf.type === 'string' && !tf.relation)?.field ??
                'name'
            } else {
              try {
                const cols2 = (await db('information_schema.columns')
                  .where({ table_name: f.relation.related_collection })
                  .pluck('column_name')) as string[]
                const lower2 = cols2.map((x) => x.toLowerCase())
                f.relation.match_field =
                  ['name', 'code', 'short_name', 'label', 'title', 'key'].find((cand) =>
                    lower2.includes(cand)
                  ) ?? null
              } catch {
                /* leave null — import will report unmatched */
              }
            }
          }
        }
      }
      if (!plan.collections.length) {
        return reply
          .code(422)
          .send({ error: 'AI could not produce a usable plan from that input', notes: plan.notes })
      }
      await logActivity({
        action: 'designer-analyze',
        user: req.user?.id,
        comment: (b.instruction ?? b.prompt ?? fileMeta?.sheet ?? '').slice(0, 200),
        req
      })
      return { data: { plan, file: fileMeta } }
    } catch (err) {
      req.log.warn({ err }, 'collection designer analyze failed')
      return reply.code(502).send({ error: 'AI request failed' })
    }
  })

  // POST /apply — create the reviewed plan (and optionally import the rows)
  app.post('/apply', async (req, reply) => {
    const b = req.body as {
      plan?: unknown
      import?: { file_token: string; sheet: string } | null
      create_import?: boolean
    }
    const plan = await sanitizePlan(b.plan)
    if (!plan.collections.length) return reply.code(400).send({ error: 'Plan has no collections' })

    const errors: string[] = []
    const created: string[] = []
    const junctionInfo = new Map<string, { junction: string; parentFk: string; targetFk: string }>()

    for (const c of plan.collections) {
      const exists = await db.raw(
        `SELECT 1 FROM information_schema.tables WHERE table_name = ?`,
        [c.collection]
      )
      if ((exists as unknown[]).length) {
        errors.push(`Table "${c.collection}" already exists — skipped`)
        continue
      }
      try {
        await db.schema.createTable(c.collection, (t) => {
          t.increments('id').primary()
          t.timestamp('created_at').defaultTo(db.fn.now())
        })
      } catch (err) {
        errors.push(`Create "${c.collection}" failed: ${err instanceof Error ? err.message : err}`)
        continue
      }
      created.push(c.collection)

      for (const f of c.fields) {
        try {
          await db.schema.table(c.collection, (t) => {
            switch (f.relation ? (f.type === 'uuid' ? 'uuid' : 'integer') : f.type) {
              case 'text':
                t.text(f.field)
                break
              case 'integer':
                t.integer(f.field)
                break
              case 'bigInteger':
                t.bigInteger(f.field)
                break
              case 'boolean':
                t.boolean(f.field)
                break
              case 'decimal':
                t.decimal(f.field, 14, 2)
                break
              case 'float':
                t.float(f.field, 8)
                break
              case 'date':
                t.date(f.field)
                break
              case 'datetime':
                t.datetime(f.field)
                break
              case 'uuid':
                t.uuid(f.field)
                break
              default:
                t.string(f.field, f.type === 'string' ? 500 : 255)
            }
          })
        } catch (err) {
          errors.push(
            `Column ${c.collection}.${f.field} failed: ${err instanceof Error ? err.message : err}`
          )
        }
      }

      await db('nivaro_collections').insert({
        collection: c.collection,
        display_name: c.display_name || c.collection,
        singular: c.singular ?? null,
        note: c.note ?? null,
        display_template: c.display_template ?? null,
        hidden: false,
        singleton: false
      })

      let sort = 1
      for (const f of c.fields) {
        const iface =
          f.interface ??
          (f.relation
            ? 'm2o'
            : f.type === 'boolean'
              ? 'boolean'
              : f.type === 'text'
                ? 'textarea'
                : f.type === 'date' || f.type === 'datetime'
                  ? 'datetime'
                  : 'input')
        await db('nivaro_fields').insert({
          collection: c.collection,
          field: f.field,
          type: f.relation ? (f.type === 'uuid' ? 'uuid' : 'integer') : f.type,
          interface: f.relation ? 'm2o' : iface,
          options: f.options ? JSON.stringify(f.options) : null,
          note: f.label && f.label !== f.field ? null : null,
          hidden: 0,
          readonly: 0,
          required: f.required ? 1 : 0,
          sort: sort++
        })
      }
    }

    // Relations after every table exists (in-plan targets may come later in
    // the array than the collection referencing them).
    for (const c of plan.collections) {
      if (!created.includes(c.collection)) continue
      for (const f of c.fields) {
        if (!f.relation) continue
        const target = f.relation.related_collection
        const targetExists = await db.raw(
          `SELECT 1 FROM information_schema.tables WHERE table_name = ?`,
          [target]
        )
        if (!(targetExists as unknown[]).length) {
          errors.push(`Relation ${c.collection}.${f.field} → ${target}: target missing — skipped`)
          continue
        }
        if (f.type === 'm2m') {
          // Junction table + the MUTUAL relation pair (each side's
          // junction_field names the other's many_field — documented shape).
          let junction = f.relation.junction ?? `${c.collection}_${target}`.slice(0, 120)
          const jExists = await db.raw(
            `SELECT 1 FROM information_schema.tables WHERE table_name = ?`,
            [junction]
          )
          if ((jExists as unknown[]).length) {
            if (f.relation.junction) {
              errors.push(
                `Junction "${f.relation.junction}" already exists — used ${c.collection}_${f.field}_junction instead`
              )
            }
            junction = `${c.collection}_${f.field}_junction`.slice(0, 120)
          }
          const parentFk = `${c.collection}_id`
          const targetFk = `${target}_id`
          const targetIsUuid = target.toLowerCase() === 'nivaro_users'
          junctionInfo.set(`${c.collection}.${f.field}`, { junction, parentFk, targetFk })
          try {
            await db.schema.createTable(junction, (t) => {
              t.increments('id').primary()
              t.integer(parentFk)
              if (targetIsUuid) t.uuid(targetFk)
              else t.integer(targetFk)
            })
            await db('nivaro_collections').insert({
              collection: junction,
              display_name: null,
              hidden: true,
              singleton: false
            })
            await db('nivaro_relations').insert([
              {
                many_collection: junction,
                many_field: targetFk,
                one_collection: target,
                one_field: null,
                junction_field: parentFk,
                one_deselect_action: 'nullify'
              },
              {
                many_collection: junction,
                many_field: parentFk,
                one_collection: c.collection,
                one_field: f.field,
                junction_field: targetFk,
                one_deselect_action: 'nullify'
              }
            ])
            try {
              await db.schema.table(junction, (t) => {
                t.foreign(parentFk).references('id').inTable(c.collection).onDelete('NO ACTION')
                t.foreign(targetFk).references('id').inTable(target).onDelete('NO ACTION')
              })
            } catch {
              /* best-effort */
            }
          } catch (err) {
            errors.push(
              `Junction for ${c.collection}.${f.field} failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`
            )
          }
          continue
        }
        await db('nivaro_relations').insert({
          many_collection: c.collection,
          many_field: f.field,
          one_collection: target,
          one_field: null,
          one_deselect_action: 'nullify'
        })
        try {
          await db.schema.table(c.collection, (t) => {
            t.foreign(f.field)
              .references('id')
              .inTable(target)
              .onDelete('NO ACTION')
              .onUpdate('NO ACTION')
          })
        } catch {
          /* FK is best-effort — the CMS relation row is what the app reads */
        }
      }
    }

    // Repeatable-import pipeline: staging table + import_{name} procedure +
    // Import Console definition, generated from the same reviewed plan.
    const importPipeline: Array<{ collection: string; procedure: string; staging_table: string }> =
      []
    if (b.create_import) {
      for (const c of plan.collections) {
        if (!created.includes(c.collection)) continue
        if (!c.fields.some((f) => f.source_column && f.type !== 'm2m')) continue
        const procName = `import_${c.collection}`.slice(0, 120)
        const stagingTable = `staging_${c.collection}`.slice(0, 120)
        try {
          const procExists = (await db.raw(
            `SELECT 1 FROM sys.procedures WHERE name = ?`,
            [procName]
          )) as unknown[]
          if (procExists.length) {
            errors.push(`Procedure ${procName} already exists — import pipeline skipped`)
            continue
          }
          const { sql, stagingColumns, skipped: m2mSkipped } = generateImportProc(
            c,
            procName,
            stagingTable
          )
          if (!(await db.schema.hasTable(stagingTable))) {
            await db.schema.createTable(stagingTable, (t) => {
              t.increments()
              for (const col of stagingColumns) t.text(col)
            })
          }
          await db.raw(sql)
          const defRow = {
            key: c.collection,
            label: c.display_name || c.collection,
            description: `Generated by the Collection Designer — upserts into ${c.collection}${c.import_key?.length ? ` keyed on ${c.import_key.join(', ')}` : ' (append-only)'}`,
            staging_table: stagingTable,
            procedure: procName,
            loader: 'insert',
            is_active: 1,
            staging_columns: JSON.stringify(stagingColumns),
            procedure_body: sql,
            procedure_deployed_at: new Date()
          }
          const existingDef = await db('nivaro_import_definitions')
            .where({ key: c.collection })
            .first()
          if (existingDef) await db('nivaro_import_definitions').where({ key: c.collection }).update(defRow)
          else await db('nivaro_import_definitions').insert(defRow)
          if (m2mSkipped.length) {
            errors.push(
              `${procName} does not sync m2m field(s) ${m2mSkipped.join(', ')} — re-imports leave those links untouched`
            )
          }
          importPipeline.push({
            collection: c.collection,
            procedure: procName,
            staging_table: stagingTable
          })
        } catch (err) {
          errors.push(
            `Import pipeline for ${c.collection} failed: ${err instanceof Error ? err.message.slice(0, 300) : err}`
          )
        }
      }
    }

    // Optional data import (file mode) — coerce per field type, chunked
    // under MSSQL's ~2100 bound-parameter cap.
    let imported: { inserted: number; skipped: number } | null = null
    if (b.import?.file_token && created.length) {
      const cached = fileCache.get(b.import.file_token)
      const rows = cached?.sheets[b.import.sheet]
      if (!rows) {
        errors.push('Import skipped — the uploaded file expired')
      } else {
        const target = plan.collections.find(
          (c) => created.includes(c.collection) && c.fields.some((f) => f.source_column)
        )
        if (target) {
          const headers = (rows[0] ?? []).map((c) => String(c ?? '').trim())
          const mapped = target.fields
            .filter((f) => f.source_column && headers.includes(f.source_column))
            .map((f) => ({ f, idx: headers.indexOf(f.source_column!) }))

          // Relation lookup maps: a relation whose source column holds display
          // values (codes/names) resolves through the target's match_field --
          // in-plan targets are POPULATED from the distinct values first.
          const lookups = new Map<string, Map<string, unknown>>()
          for (const { f, idx } of mapped) {
            const mf = f.relation?.match_field
            if (!f.relation || !mf) continue
            const targetCol = f.relation.related_collection
            const distinct = new Set<string>()
            for (const row of rows.slice(1, 50001)) {
              const raw = String(row?.[idx] ?? '').trim()
              if (!raw) continue
              // m2m cells hold multiple delimited values — collect each part
              const parts = f.type === 'm2m' ? raw.split(/[,;|]/) : [raw]
              for (const part of parts) {
                const v = part.trim()
                if (v && distinct.size < 10000) distinct.add(v)
              }
            }
            try {
              if (created.includes(targetCol)) {
                const have = new Set(
                  ((await db(targetCol).pluck(mf)) as unknown[]).map((v) =>
                    String(v).toLowerCase()
                  )
                )
                const toInsert = [...distinct].filter((v) => !have.has(v.toLowerCase()))
                for (let i = 0; i < toInsert.length; i += 300) {
                  await db(targetCol).insert(toInsert.slice(i, i + 300).map((v) => ({ [mf]: v })))
                }
              }
              const lookup = new Map<string, unknown>()
              const targetRows = (await db(targetCol)
                .select('id', mf)
                .limit(50000)) as Array<Record<string, unknown>>
              for (const r of targetRows) {
                const key = String(r[mf] ?? '').trim().toLowerCase()
                if (key) lookup.set(key, r.id)
              }
              lookups.set(f.field, lookup)
            } catch (err) {
              errors.push(
                `Lookup for ${target.collection}.${f.field} via ${targetCol}.${mf} failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`
              )
            }
          }

          const scalarMapped = mapped.filter(({ f }) => f.type !== 'm2m')
          const m2mMapped = mapped.filter(
            ({ f }) => f.type === 'm2m' && junctionInfo.has(`${target.collection}.${f.field}`)
          )
          const unmatched: Record<string, number> = {}
          const records: Record<string, unknown>[] = []
          // per-record m2m related-id arrays, aligned with records[]
          const m2mIds: Record<string, unknown[]>[] = []
          let skipped = 0
          for (const row of rows.slice(1, 50001)) {
            const rec: Record<string, unknown> = {}
            let hasValue = false
            for (const { f, idx } of scalarMapped) {
              let v: unknown
              const lookup = lookups.get(f.field)
              if (lookup) {
                const key = String(row?.[idx] ?? '').trim().toLowerCase()
                v = key ? (lookup.get(key) ?? null) : null
                if (key && v === null) unmatched[f.field] = (unmatched[f.field] ?? 0) + 1
              } else {
                v = coerceValue(row?.[idx], f.relation ? 'integer' : f.type)
              }
              if (v !== null) hasValue = true
              rec[f.field] = v
            }
            const rowM2m: Record<string, unknown[]> = {}
            for (const { f, idx } of m2mMapped) {
              const lookup = lookups.get(f.field)
              const ids: unknown[] = []
              for (const part of String(row?.[idx] ?? '').split(/[,;|]/)) {
                const key = part.trim().toLowerCase()
                if (!key) continue
                const id = lookup?.get(key)
                if (id !== undefined) ids.push(id)
                else unmatched[f.field] = (unmatched[f.field] ?? 0) + 1
              }
              if (ids.length) hasValue = true
              rowM2m[f.field] = ids
            }
            if (hasValue) {
              records.push(rec)
              m2mIds.push(rowM2m)
            } else skipped++
          }
          for (const [field, n] of Object.entries(unmatched)) {
            const rc = target.fields.find((f) => f.field === field)?.relation?.related_collection
            errors.push(`${n} values had no ${field} match in ${rc} -- left empty`)
          }
          // Bulk insert, then recover ids via the identity range: the table is
          // brand new (no concurrent writers), chunks insert sequentially, so
          // ids > beforeMax ordered ascending line up with records[] order.
          const beforeMax = m2mMapped.length
            ? Number(
                ((await db(target.collection).max('id as m').first()) as { m?: number } | undefined)
                  ?.m ?? 0
              )
            : 0
          const perChunk = Math.max(1, Math.floor(2000 / Math.max(1, scalarMapped.length || 1)))
          let inserted = 0
          for (let i = 0; i < records.length; i += perChunk) {
            try {
              await db(target.collection).insert(records.slice(i, i + perChunk))
              inserted += Math.min(perChunk, records.length - i)
            } catch (err) {
              errors.push(
                `Import chunk at row ${i + 1} failed: ${err instanceof Error ? err.message.slice(0, 300) : err}`
              )
            }
          }
          if (m2mMapped.length && inserted === records.length) {
            const newIds = (await db(target.collection)
              .where('id', '>', beforeMax)
              .orderBy('id', 'asc')
              .pluck('id')) as unknown[]
            for (const { f } of m2mMapped) {
              const info = junctionInfo.get(`${target.collection}.${f.field}`)!
              const junctionRows: Record<string, unknown>[] = []
              for (let ri = 0; ri < newIds.length && ri < m2mIds.length; ri++) {
                for (const relId of m2mIds[ri][f.field] ?? []) {
                  junctionRows.push({ [info.parentFk]: newIds[ri], [info.targetFk]: relId })
                }
              }
              for (let i = 0; i < junctionRows.length; i += 500) {
                try {
                  await db(info.junction).insert(junctionRows.slice(i, i + 500))
                } catch (err) {
                  errors.push(
                    `Junction import for ${f.field} failed at ${i}: ${err instanceof Error ? err.message.slice(0, 200) : err}`
                  )
                }
              }
            }
          } else if (m2mMapped.length) {
            errors.push('M2M links skipped — some main-row chunks failed, id alignment unsafe')
          }
          imported = { inserted, skipped }
        }
      }
    }

    await logActivity({
      action: 'designer-apply',
      collection: 'schema',
      item: created.join(','),
      user: req.user?.id,
      req,
      comment: `AI collection designer: ${created.length} created${imported ? `, ${imported.inserted} rows imported` : ''}${importPipeline.length ? `, import proc ${importPipeline.map((p) => p.procedure).join(', ')}` : ''}`
    })
    return { data: { created, imported, import_pipeline: importPipeline, errors } }
  })
}

// ─── repeatable-import generator — staging table + import_{name} proc ─────
// Deterministic T-SQL templating from the sanitized plan (never AI-written):
// staging text columns per source header (the staged-import worker's own
// normalizeHeader convention), lookups resolved by match_field, MERGE keyed
// on the configured pivot. Registered in nivaro_import_definitions so the
// Import Console can run the same file shape forever after.

function normalizeHeader(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function sqlValueExpr(f: DesignField, stagingCol: string): string {
  const raw = `NULLIF(LTRIM(RTRIM(st.[${stagingCol}])), '')`
  const numericClean = `NULLIF(REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(st.[${stagingCol}])), ',', ''), '$', ''), '%', ''), '')`
  if (f.relation && !f.relation.match_field) return `TRY_CONVERT(INT, ${numericClean})`
  switch (f.type) {
    case 'integer':
    case 'bigInteger':
      return `TRY_CONVERT(${f.type === 'bigInteger' ? 'BIGINT' : 'INT'}, ${numericClean})`
    case 'decimal':
      return `TRY_CONVERT(DECIMAL(14,2), ${numericClean})`
    case 'float':
      return `TRY_CONVERT(FLOAT, ${numericClean})`
    case 'boolean':
      return `CASE WHEN LOWER(LTRIM(RTRIM(st.[${stagingCol}]))) IN ('true','yes','y','1') THEN 1 WHEN LOWER(LTRIM(RTRIM(st.[${stagingCol}]))) IN ('false','no','n','0') THEN 0 ELSE NULL END`
    case 'date':
      return `COALESCE(TRY_CONVERT(DATE, ${raw}), TRY_CONVERT(DATE, ${raw}, 101))`
    case 'datetime':
      return `COALESCE(TRY_CONVERT(DATETIME2, ${raw}), TRY_CONVERT(DATETIME2, ${raw}, 101))`
    default:
      return raw
  }
}

export function generateImportProc(
  c: DesignCollection,
  procName: string,
  stagingTable: string
): { sql: string; stagingColumns: string[]; skipped: string[] } {
  const mapped = c.fields.filter((f) => f.source_column && f.type !== 'm2m')
  const skipped = c.fields
    .filter((f) => f.source_column && f.type === 'm2m')
    .map((f) => f.field)
  const stagingColumns = mapped.map((f) => normalizeHeader(f.source_column!))
  const pivot = (c.import_key ?? []).filter((k) => mapped.some((f) => f.field === k))

  const joins: string[] = []
  const selects: string[] = []
  for (const f of mapped) {
    const stagingCol = normalizeHeader(f.source_column!)
    if (f.relation?.match_field) {
      const alias = `lk_${f.field}`.slice(0, 100)
      joins.push(
        `        LEFT JOIN [${f.relation.related_collection}] ${alias} ON LOWER(LTRIM(RTRIM(${alias}.[${f.relation.match_field}]))) = LOWER(LTRIM(RTRIM(st.[${stagingCol}])))`
      )
      selects.push(`            ${alias}.id AS [${f.field}]`)
    } else {
      selects.push(`            ${sqlValueExpr(f, stagingCol)} AS [${f.field}]`)
    }
  }

  const fieldList = mapped.map((f) => `[${f.field}]`).join(', ')
  const sourceList = mapped.map((f) => `source.[${f.field}]`).join(', ')
  const updateSet = mapped
    .filter((f) => !pivot.includes(f.field))
    .map((f) => `            target.[${f.field}] = source.[${f.field}]`)
    .join(',\n')

  const dedupe = pivot.length
    ? `,\n            ROW_NUMBER() OVER (PARTITION BY ${pivot.map((k) => `${exprFor(mapped, k)}`).join(', ')} ORDER BY st.id DESC) AS _rn`
    : ''

  function exprFor(fields: DesignField[], fieldName: string): string {
    const f = fields.find((x) => x.field === fieldName)!
    const stagingCol = normalizeHeader(f.source_column!)
    return f.relation?.match_field
      ? `LOWER(LTRIM(RTRIM(st.[${stagingCol}])))`
      : sqlValueExpr(f, stagingCol)
  }

  const body = pivot.length
    ? `        MERGE [${c.collection}] AS target
        USING (SELECT ${mapped.map((f) => `[${f.field}]`).join(', ')} FROM cte_src WHERE _rn = 1) AS source
        ON ${pivot
          .map((k) => `((target.[${k}] = source.[${k}]) OR (target.[${k}] IS NULL AND source.[${k}] IS NULL))`)
          .join(' AND ')}
        WHEN MATCHED THEN
            UPDATE SET
${updateSet}
        WHEN NOT MATCHED BY TARGET THEN
            INSERT (${fieldList})
            VALUES (${sourceList});`
    : `        INSERT INTO [${c.collection}] (${fieldList})
        SELECT ${fieldList} FROM cte_src;`

  const sql = `CREATE OR ALTER PROCEDURE [${procName}]
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    -- Generated by the Collection Designer for [${c.collection}].
    -- Re-import behavior: ${
      pivot.length
        ? `upsert keyed on (${pivot.join(', ')}) — matched rows update, new rows insert.`
        : 'append-only (no re-import key configured).'
    }${skipped.length ? `\n    -- NOT handled here (m2m fields need app-side import): ${skipped.join(', ')}` : ''}
    BEGIN TRY
        BEGIN TRAN;
        ;WITH cte_src AS (
            SELECT
${selects.join(',\n')}${dedupe}
            FROM [${stagingTable}] st
${joins.join('\n')}
        )
${body}
        COMMIT;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
    END CATCH
END`
  return { sql, stagingColumns, skipped }
}

function coerceValue(raw: unknown, type: string): unknown {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  if (s === '' || s === '-') return null
  switch (type) {
    case 'integer':
    case 'bigInteger': {
      const n = Number.parseInt(s.replace(/[$,%\s]/g, ''), 10)
      return Number.isFinite(n) ? n : null
    }
    case 'decimal':
    case 'float': {
      const cleaned = s.replace(/[$,%\s]/g, '').replace(/^\((.*)\)$/, '-$1')
      const n = Number.parseFloat(cleaned)
      return Number.isFinite(n) ? n : null
    }
    case 'boolean': {
      const low = s.toLowerCase()
      if (['true', 'yes', 'y', '1'].includes(low)) return true
      if (['false', 'no', 'n', '0'].includes(low)) return false
      return null
    }
    case 'date':
    case 'datetime': {
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) return null
      return type === 'date' ? d.toISOString().slice(0, 10) : d
    }
    default:
      return s.slice(0, 4000)
  }
}
