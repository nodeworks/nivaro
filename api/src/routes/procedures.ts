import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Stored-procedure management (admin) — the Developer → Procedures page.
 *
 * The database is the runtime source of truth; deployments that vendor their
 * procs (efp-ops/procedures) get drift visibility via that extension's
 * registry route, which the page merges in when present.
 *
 * Trust model: requireAdmin end to end, same tier as custom queries (an
 * admin there already authors arbitrary SQL that executes on demand). Every
 * save/exec/drop is activity-logged.
 *
 * Parameter "auto-parsing" reads sys.parameters — the engine's own catalog —
 * so the execute form always matches the deployed signature, never a regex's
 * guess at the header.
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface ProcParam {
  name: string // includes the leading @
  type: string
  max_length: number
  precision: number
  scale: number
  is_output: boolean
  has_default: boolean
  position: number
}

async function procParams(name: string): Promise<ProcParam[]> {
  const rows = (await db.raw(
    `SELECT pa.name, t.name AS type_name, pa.max_length, pa.precision, pa.scale,
            pa.is_output, pa.has_default_value, pa.parameter_id
     FROM sys.parameters pa
     JOIN sys.procedures p ON p.object_id = pa.object_id
     JOIN sys.types t ON t.user_type_id = pa.user_type_id
     WHERE p.name = ? AND pa.parameter_id > 0
     ORDER BY pa.parameter_id`,
    [name]
  )) as Array<{
    name: string
    type_name: string
    max_length: number
    precision: number
    scale: number
    is_output: boolean
    has_default_value: boolean
    parameter_id: number
  }>
  return rows.map((r) => ({
    name: r.name,
    type: r.type_name,
    max_length: r.max_length,
    precision: r.precision,
    scale: r.scale,
    is_output: !!r.is_output,
    // sys.parameters.has_default_value is only populated for CLR procs; for
    // T-SQL the definition carries the defaults. The client treats every
    // param as omittable and lets the engine complain when one is required.
    has_default: !!r.has_default_value,
    position: r.parameter_id
  }))
}

/** The definition must be a single CREATE [OR ALTER] PROCEDURE for exactly
 * the named proc — deploying under one name while defining another is how
 * list state and reality diverge. */
function definitionNameMatches(definition: string, name: string): boolean {
  const m = /create\s+(?:or\s+alter\s+)?proc(?:edure)?\s+(?:\[?dbo\]?\s*\.\s*)?\[?([A-Za-z_][A-Za-z0-9_]*)\]?/i.exec(
    definition
  )
  return !!m && m[1].toLowerCase() === name.toLowerCase()
}

const toCreateOrAlter = (definition: string) =>
  definition.replace(/create\s+(or\s+alter\s+)?proc(edure)?/i, 'CREATE OR ALTER PROCEDURE')

/** Engine-accurate context for the AI routes: referenced base tables with
 * live columns/indexes/row counts, plus where the app invokes the proc. */
async function gatherProcContext(name: string): Promise<{ tables: string[]; schemaCtx: string[]; usage: string[] }> {
  let tables: string[] = []
  try {
    const refs = (await db.raw(
      `SELECT DISTINCT referenced_entity_name AS t
       FROM sys.dm_sql_referenced_entities(?, 'OBJECT')
       WHERE referenced_minor_id = 0 AND referenced_entity_name IS NOT NULL`,
      [`dbo.${name}`]
    )) as Array<{ t: string }>
    tables = refs
      .map((r) => r.t)
      .filter((t) => NAME_RE.test(t))
      .slice(0, 12)
  } catch {
    /* unresolved refs — proceed without table context */
  }
  if (tables.length) {
    const real = (await db('information_schema.tables')
      .whereIn('table_name', tables)
      .where('table_type', 'BASE TABLE')
      .pluck('table_name')) as string[]
    tables = real
  }
  const schemaCtx: string[] = []
  for (const t of tables) {
    const cols = (await db('information_schema.columns')
      .where({ table_name: t })
      .orderBy('ordinal_position')
      .select('column_name', 'data_type', 'is_nullable')) as Array<{
      column_name: string
      data_type: string
      is_nullable: string
    }>
    const idx = (await db.raw(
      `SELECT i.name, i.type_desc, i.is_unique,
              STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS cols
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(?) AND i.type > 0
       GROUP BY i.name, i.type_desc, i.is_unique`,
      [`dbo.${t}`]
    )) as Array<{ name: string; type_desc: string; is_unique: boolean; cols: string }>
    const cnt = (await db
      .raw(
        `SELECT SUM(ps.row_count) AS n FROM sys.dm_db_partition_stats ps
         WHERE ps.object_id = OBJECT_ID(?) AND ps.index_id IN (0, 1)`,
        [`dbo.${t}`]
      )
      .catch(() => [{ n: null }])) as Array<{ n: number | null }>
    schemaCtx.push(
      `TABLE ${t} (~${cnt[0]?.n ?? '?'} rows)\n  columns: ${cols
        .map((c) => `${c.column_name} ${c.data_type}${c.is_nullable === 'YES' ? '?' : ''}`)
        .join(', ')}\n  indexes: ${
        idx.length ? idx.map((i) => `${i.name}(${i.cols})${i.is_unique ? ' UNIQUE' : ''}`).join('; ') : 'NONE beyond heap'
      }`
    )
  }
  const usage: string[] = []
  try {
    const cq = (await db('nivaro_custom_queries')
      .where('sql_text', 'like', `%${name}%`)
      .pluck('slug')) as string[]
    if (cq.length) usage.push(`custom queries: ${cq.slice(0, 10).join(', ')}`)
    const defs = (await db('nivaro_import_definitions')
      .where({ procedure: name })
      .pluck('key')
      .catch(() => [])) as string[]
    if (defs.length) usage.push(`staged-import definitions: ${defs.join(', ')}`)
    const rules = (await db('nivaro_rules')
      .where('actions', 'like', `%${name}%`)
      .pluck('name')
      .catch(() => [])) as string[]
    if (rules.length) usage.push(`automation rules: ${rules.slice(0, 6).join(', ')}`)
  } catch {
    /* usage context is best-effort */
  }
  return { tables, schemaCtx, usage }
}

export async function procedureRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // ── List ──────────────────────────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    const rows = (await db.raw(`
      SELECT p.name, p.create_date, p.modify_date, LEN(m.definition) AS bytes,
             (SELECT COUNT(*) FROM sys.parameters pa
               WHERE pa.object_id = p.object_id AND pa.parameter_id > 0) AS param_count
      FROM sys.procedures p
      JOIN sys.sql_modules m ON m.object_id = p.object_id
      WHERE p.is_ms_shipped = 0
      ORDER BY p.name`)) as Array<Record<string, unknown>>
    return reply.send({
      data: rows.map((r) => ({
        name: r.name,
        created: r.create_date,
        modified: r.modify_date,
        bytes: Number(r.bytes ?? 0),
        param_count: Number(r.param_count ?? 0)
      }))
    })
  })

  // ── Read one: definition + catalog-parsed parameters ─────────────────────
  app.get<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const { name } = req.params
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    const row = (await db.raw(
      `SELECT p.name, p.create_date, p.modify_date, m.definition
       FROM sys.procedures p JOIN sys.sql_modules m ON m.object_id = p.object_id
       WHERE p.name = ? AND p.is_ms_shipped = 0`,
      [name]
    )) as Array<{ name: string; create_date: Date; modify_date: Date; definition: string }>
    if (!row.length) return reply.code(404).send({ error: 'Procedure not found' })
    return reply.send({
      data: {
        name: row[0].name,
        created: row[0].create_date,
        modified: row[0].modify_date,
        definition: row[0].definition,
        params: await procParams(name)
      }
    })
  })

  // ── Deploy (create or update) ────────────────────────────────────────────
  app.put<{ Params: { name: string }; Body: { definition?: string } }>(
    '/:name',
    async (req, reply) => {
      const { name } = req.params
      const definition = String(req.body?.definition ?? '')
      if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
      if (!definition.trim()) return reply.code(400).send({ error: 'definition is required' })
      if (!definitionNameMatches(definition, name)) {
        return reply.code(400).send({
          error: `The definition must be a CREATE [OR ALTER] PROCEDURE for "${name}" — the statement's name doesn't match.`
        })
      }
      const existing = (await db.raw(
        'SELECT 1 AS x FROM sys.procedures WHERE name = ? AND is_ms_shipped = 0',
        [name]
      )) as unknown[]
      try {
        await db.raw(toCreateOrAlter(definition))
      } catch (e) {
        // knex/mssql AggregateErrors carry an empty .message — the real SQL
        // Server messages live in .errors.
        const errs = (e as { errors?: Array<{ message?: string }> })?.errors ?? [e as Error]
        return reply.code(400).send({
          error: errs.map((x) => x?.message).filter(Boolean).join(' | ') || 'Deploy failed'
        })
      }
      await logActivity({
        action: existing.length ? 'procedure-update' : 'procedure-create',
        user: req.user?.id,
        collection: 'sys.procedures',
        item: name,
        comment: `${definition.length} chars`,
        req
      })
      return reply.send({ ok: true, created: !existing.length })
    }
  )

  // ── Drop ─────────────────────────────────────────────────────────────────
  app.delete<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const { name } = req.params
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    const existing = (await db.raw(
      'SELECT 1 AS x FROM sys.procedures WHERE name = ? AND is_ms_shipped = 0',
      [name]
    )) as unknown[]
    if (!existing.length) return reply.code(404).send({ error: 'Procedure not found' })
    await db.raw(`DROP PROCEDURE [${name}]`)
    await logActivity({
      action: 'procedure-drop',
      user: req.user?.id,
      collection: 'sys.procedures',
      item: name,
      req
    })
    return reply.code(204).send()
  })

  // ── AI review ────────────────────────────────────────────────────────────
  // Gathers ENGINE-ACCURATE context (sys.dm_sql_referenced_entities for the
  // tables the proc actually touches, live columns/indexes/row counts for
  // each) plus where the app uses the proc, and asks the model for a summary,
  // improvements, and index suggestions. The model only ever SUGGESTS —
  // nothing here executes its output.
  app.post<{ Params: { name: string } }>('/:name/ai-review', async (req, reply) => {
    const { name } = req.params
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    const row = (await db.raw(
      `SELECT m.definition FROM sys.procedures p
       JOIN sys.sql_modules m ON m.object_id = p.object_id
       WHERE p.name = ? AND p.is_ms_shipped = 0`,
      [name]
    )) as Array<{ definition: string }>
    if (!row.length) return reply.code(404).send({ error: 'Procedure not found' })
    const definition = row[0].definition

    const { getAiClient } = await import('../services/ai-client.js')
    const client = await getAiClient()
    if (!client) return reply.code(503).send({ error: 'AI is not configured (no Anthropic key)' })

    const { tables, schemaCtx, usage } = await gatherProcContext(name)

    const { model } = await (await import('../services/ai-client.js')).getAiModelSettings()
    const prompt = `You are reviewing a SQL Server stored procedure for a production system.

PROCEDURE DEFINITION:
${definition.slice(0, 24000)}

LIVE SCHEMA OF REFERENCED TABLES (columns, existing indexes, approx row counts):
${schemaCtx.join('\n\n') || '(dependency resolution unavailable)'}

WHERE THE APP USES IT:
${usage.join('\n') || '(no registered app usage found — may be invoked externally or by cron)'}

Respond with ONLY a JSON object, no fences:
{
  "summary": "2-4 sentences: what this procedure does and when it runs",
  "improvements": ["specific, actionable improvement", ...],
  "index_suggestions": [{"table": "...", "columns": "col1, col2", "reason": "which predicate/join this serves", "create_sql": "CREATE INDEX ... ON ..."}],
  "risks": ["correctness or operational risk worth knowing", ...]
}
Rules: suggest an index ONLY when the definition's predicates/joins hit columns the listed indexes do not cover AND the table is large enough to matter; empty arrays are fine; never invent tables or columns not shown above.`

    try {
      const message = await client.messages.create({
        model,
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }]
      })
      const text = message.content
        .map((b) => ('text' in b ? b.text : ''))
        .join('')
        .trim()
      const jsonText = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(jsonText)
      } catch {
        parsed = { summary: text, improvements: [], index_suggestions: [], risks: [] }
      }
      await logActivity({
        action: 'procedure-ai-review',
        user: req.user?.id,
        collection: 'sys.procedures',
        item: name,
        req
      })
      return reply.send({ data: { ...parsed, tables_analyzed: tables } })
    } catch (e) {
      return reply.code(502).send({ error: `AI review failed: ${(e as Error).message}` })
    }
  })

  // ── AI fix ───────────────────────────────────────────────────────────────
  // Produce a corrected FULL definition addressing ONE named finding. The
  // result is returned as a DRAFT for the editor — it is never deployed here;
  // the human reviews and hits Deploy like any hand edit.
  app.post<{
    Params: { name: string }
    Body: { issue?: string; issues?: string[]; definition?: string }
  }>(
    '/:name/ai-fix',
    async (req, reply) => {
      const { name } = req.params
      // Single finding or a whole section's worth — a batch goes to the model
      // as ONE request so the fixes come out coherent instead of N sequential
      // rewrites stepping on each other.
      const issues = (
        Array.isArray(req.body?.issues) ? req.body.issues.map((i) => String(i)) : [String(req.body?.issue ?? '')]
      )
        .map((i) => i.trim())
        .filter(Boolean)
        .slice(0, 12)
      const issue = issues.map((it, i) => (issues.length > 1 ? `${i + 1}. ${it}` : it)).join('\n')
      if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
      if (!issue) return reply.code(400).send({ error: 'issue is required' })
      // Fix against the editor's CURRENT draft when supplied, so sequential
      // fixes stack instead of each starting from the deployed version.
      let definition = String(req.body?.definition ?? '')
      if (!definition.trim()) {
        const row = (await db.raw(
          `SELECT m.definition FROM sys.procedures p
           JOIN sys.sql_modules m ON m.object_id = p.object_id
           WHERE p.name = ? AND p.is_ms_shipped = 0`,
          [name]
        )) as Array<{ definition: string }>
        if (!row.length) return reply.code(404).send({ error: 'Procedure not found' })
        definition = row[0].definition
      }
      const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
      const client = await getAiClient()
      if (!client) return reply.code(503).send({ error: 'AI is not configured (no Anthropic key)' })
      const { schemaCtx, usage } = await gatherProcContext(name)
      const { model } = await getAiModelSettings()
      const prompt = `You are fixing ${issues.length > 1 ? `${issues.length} specific issues` : 'ONE specific issue'} in a SQL Server stored procedure for a production system.

CURRENT DEFINITION:
${definition.slice(0, 24000)}

LIVE SCHEMA OF REFERENCED TABLES (columns, existing indexes, approx row counts):
${schemaCtx.join('\n\n') || '(dependency resolution unavailable)'}

WHERE THE APP USES IT:
${usage.join('\n') || '(no registered app usage found)'}

THE ISSUE${issues.length > 1 ? 'S' : ''} TO FIX (address every one):
${issue.slice(0, 4000)}

Respond with ONLY a JSON object, no fences:
{
  "definition": "the COMPLETE corrected procedure as CREATE OR ALTER PROCEDURE ${name} ... — full body, not a diff",
  "explanation": "2-4 sentences: exactly what changed and why it fixes the issue(s)"
}
Rules: change the MINIMUM needed to address the stated issue; preserve every other behavior, parameter, and output shape exactly; never reference tables or columns not shown above; the procedure name must remain ${name}.`
      try {
        const message = await client.messages.create({
          model,
          max_tokens: issues.length > 1 ? 12000 : 8000,
          messages: [{ role: 'user', content: prompt }]
        })
        const text = message.content
          .map((b) => ('text' in b ? b.text : ''))
          .join('')
          .trim()
        const jsonText = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
        let parsed: { definition?: string; explanation?: string }
        try {
          parsed = JSON.parse(jsonText)
        } catch {
          return reply.code(502).send({ error: 'AI returned an unparseable fix — try again' })
        }
        const fixed = String(parsed.definition ?? '')
        if (!fixed.trim() || !definitionNameMatches(fixed, name)) {
          return reply.code(502).send({
            error: 'AI produced a definition that does not match this procedure — nothing applied'
          })
        }
        await logActivity({
          action: 'procedure-ai-fix',
          user: req.user?.id,
          collection: 'sys.procedures',
          item: name,
          comment: issue.slice(0, 200),
          req
        })
        return reply.send({
          data: { definition: fixed, explanation: String(parsed.explanation ?? '') }
        })
      } catch (e) {
        return reply.code(502).send({ error: `AI fix failed: ${(e as Error).message}` })
      }
    }
  )

  // ── AI generate (New procedure) ──────────────────────────────────────────
  // Describe what you want; the model writes the full CREATE OR ALTER against
  // the real schema (business table names + column lists for the tables the
  // prompt mentions — same fuzzy-match context the SQL copilot uses). The
  // result fills the editor; deploying stays an explicit human action.
  app.post<{ Body: { name?: string; prompt?: string } }>('/ai-generate', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim()
    const prompt = String(req.body?.prompt ?? '').trim()
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    if (!prompt) return reply.code(400).send({ error: 'prompt is required' })
    const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
    const client = await getAiClient()
    if (!client) return reply.code(503).send({ error: 'AI is not configured (no Anthropic key)' })

    const collections = (await db('nivaro_collections')
      .whereNot('collection', 'like', 'nivaro_%')
      .pluck('collection')) as string[]
    const referenced = new Set<string>()
    const haystack = prompt.toLowerCase()
    for (const n of collections) {
      if (haystack.includes(n.toLowerCase()) || haystack.includes(n.toLowerCase().replace(/_/g, ' '))) {
        referenced.add(n)
      }
    }
    for (const word of haystack.split(/[^a-z_]+/)) {
      if (word.length < 4) continue
      for (const n of collections) if (n.toLowerCase().includes(word)) referenced.add(n)
    }
    const columnBlocks: string[] = []
    for (const t of [...referenced].slice(0, 12)) {
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

    const { model } = await getAiModelSettings()
    const userPrompt = `Write a Microsoft SQL Server (T-SQL) stored procedure.

NAME: ${name}
WHAT IT SHOULD DO:
${prompt.slice(0, 4000)}

AVAILABLE TABLES: ${collections.join(', ')}

DETAILED SCHEMAS (tables the request mentions):
${columnBlocks.join('\n') || '(none matched — ask only for tables from the available list)'}

Respond with ONLY a JSON object, no fences:
{
  "definition": "CREATE OR ALTER PROCEDURE ${name} ... — complete, production-quality T-SQL with SET NOCOUNT ON, sensible parameters with defaults, and TRY/CATCH around any writes",
  "explanation": "2-3 sentences on what it does and any assumptions made"
}
Rules: only reference tables and columns shown above; the procedure name must be exactly ${name}; prefer read-only unless the request clearly asks for writes.`
    try {
      const message = await client.messages.create({
        model,
        max_tokens: 6000,
        messages: [{ role: 'user', content: userPrompt }]
      })
      const text = message.content
        .map((b) => ('text' in b ? b.text : ''))
        .join('')
        .trim()
      const jsonText = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
      let parsed: { definition?: string; explanation?: string }
      try {
        parsed = JSON.parse(jsonText)
      } catch {
        return reply.code(502).send({ error: 'AI returned an unparseable result — try rephrasing' })
      }
      const definition = String(parsed.definition ?? '')
      if (!definition.trim() || !definitionNameMatches(definition, name)) {
        return reply.code(502).send({ error: 'AI produced a definition that does not match the requested name' })
      }
      await logActivity({
        action: 'procedure-ai-generate',
        user: req.user?.id,
        collection: 'sys.procedures',
        item: name,
        comment: prompt.slice(0, 200),
        req
      })
      return reply.send({ data: { definition, explanation: String(parsed.explanation ?? '') } })
    } catch (e) {
      return reply.code(502).send({ error: `AI generation failed: ${(e as Error).message}` })
    }
  })

  // ── Execute with typed params ────────────────────────────────────────────
  // Param names are validated against sys.parameters (the catalog, not the
  // request), values always BIND — nothing from the body is interpolated.
  app.post<{ Params: { name: string }; Body: { params?: Record<string, unknown> } }>(
    '/:name/execute',
    async (req, reply) => {
      const { name } = req.params
      if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
      const catalog = await procParams(name)
      if (catalog.length === 0) {
        const exists = (await db.raw(
          'SELECT 1 AS x FROM sys.procedures WHERE name = ? AND is_ms_shipped = 0',
          [name]
        )) as unknown[]
        if (!exists.length) return reply.code(404).send({ error: 'Procedure not found' })
      }
      const supplied = req.body?.params ?? {}
      const known = new Map(catalog.map((p) => [p.name.replace(/^@/, '').toLowerCase(), p]))
      const parts: string[] = []
      const bindings: unknown[] = []
      for (const [rawKey, value] of Object.entries(supplied)) {
        const p = known.get(rawKey.replace(/^@/, '').toLowerCase())
        if (!p) return reply.code(400).send({ error: `Unknown parameter: ${rawKey}` })
        if (value === null || value === undefined || value === '') continue
        parts.push(`${p.name} = ?`)
        bindings.push(value)
      }
      const started = Date.now()
      try {
        // execCustomQuerySql = the custom-queries executor: :param
        // substitution with escaping, 120s per-request timeout (heavy report
        // procs outlive tedious's 15s connection default), row collection.
        const { execCustomQuerySql } = await import('../services/custom-query-exec.js')
        const finalParams: Record<string, unknown> = {}
        parts.length = 0
        bindings.forEach((v, i) => {
          finalParams[`p${i}`] = v
        })
        let i = 0
        for (const [rawKey, value] of Object.entries(supplied)) {
          const p = known.get(rawKey.replace(/^@/, '').toLowerCase())
          if (!p || value === null || value === undefined || value === '') continue
          parts.push(`${p.name} = :p${i}`)
          i++
        }
        const sql = `EXEC [${name}]${parts.length ? ` ${parts.join(', ')}` : ''}`
        const rows = await execCustomQuerySql(sql, finalParams)
        await logActivity({
          action: 'procedure-exec',
          user: req.user?.id,
          collection: 'sys.procedures',
          item: name,
          comment: `${rows.length} rows · ${Date.now() - started}ms`,
          req
        })
        return reply.send({
          data: {
            rows: rows.slice(0, 1000),
            row_count: rows.length,
            truncated: rows.length > 1000,
            duration_ms: Date.now() - started
          }
        })
      } catch (e) {
        const errs = (e as { errors?: Array<{ message?: string }> })?.errors ?? [e as Error]
        return reply.code(400).send({
          error: errs.map((x) => x?.message).filter(Boolean).join(' | ') || 'Execution failed'
        })
      }
    }
  )
}
