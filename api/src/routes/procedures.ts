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
