import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { execCustomQuerySql } from '../services/custom-query-exec.js'

/**
 * Index advisor. The hot filter columns are already declared in config —
 * M2O FKs (nivaro_relations), queue source filters, RLS row filters,
 * workflow state mirrors — so instead of guessing from query text, cross
 * those candidates against sys.index_columns leading-column coverage on
 * tables big enough to care about. Each suggestion ships its CREATE INDEX,
 * appliable in one click (the nivaro_policies index win, systematized).
 */

const IDENT = /^[A-Za-z0-9_]+$/

interface Suggestion {
  table: string
  column: string
  rows: number
  reasons: string[]
  create_sql: string
}

const MIN_ROWS = 50_000

export async function indexAdvisorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    // Row counts in one partition-stats query (86 serial COUNT(*)s took 3.2s
    // at this RTT — the config-diff lesson).
    const counts = (await db.raw(`
      SELECT t.name AS table_name, SUM(p.row_count) AS rows
      FROM sys.tables t
      JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      GROUP BY t.name
    `)) as Array<{ table_name: string; rows: number }>
    const rowCount = new Map(counts.map((c) => [c.table_name.toLowerCase(), Number(c.rows)]))

    // Existing leading index columns per table.
    const idx = (await db.raw(`
      SELECT t.name AS table_name, c.name AS column_name
      FROM sys.index_columns ic
      JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.tables t ON t.object_id = ic.object_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE ic.key_ordinal = 1
    `)) as Array<{ table_name: string; column_name: string }>
    const indexed = new Set(idx.map((r) => `${r.table_name}.${r.column_name}`.toLowerCase()))

    const physicalCols = (await db('information_schema.columns').select(
      'table_name',
      'column_name'
    )) as Array<{ table_name: string; column_name: string }>
    const colExists = new Set(physicalCols.map((r) => `${r.table_name}.${r.column_name}`.toLowerCase()))

    // Candidate columns with the config source that makes them hot.
    const candidates = new Map<string, Set<string>>() // table.column -> reasons
    const add = (table: unknown, column: unknown, reason: string) => {
      const t = String(table ?? '').trim()
      const c = String(column ?? '').trim()
      if (!IDENT.test(t) || !IDENT.test(c) || /^nivaro_/i.test(t)) return
      const key = `${t}.${c}`.toLowerCase()
      if (!colExists.has(key)) return
      const set = candidates.get(key) ?? new Set<string>()
      set.add(reason)
      candidates.set(key, set)
    }

    const rels = (await db('nivaro_relations')
      .whereNotNull('many_collection')
      .whereNotNull('many_field')
      .select('many_collection', 'many_field')) as Array<{ many_collection: string; many_field: string }>
    for (const r of rels) add(r.many_collection, r.many_field, 'M2O foreign key (joins + relation filters)')

    const sources = (await db('nivaro_queue_sources')
      .whereNotNull('filters')
      .select('collection', 'filters')) as Array<{ collection: string | null; filters: string | null }>
    for (const srow of sources) {
      if (!srow.collection) continue
      try {
        for (const f of JSON.parse(srow.filters ?? '[]') as Array<{ field?: string }>) {
          if (f?.field && !f.field.includes('.')) add(srow.collection, f.field, 'queue source filter')
        }
      } catch {
        // unparseable filter config — skip
      }
    }

    const policies = (await db('nivaro_policies')
      .whereNotNull('row_filter')
      .select('collection', 'row_filter')) as Array<{ collection: string; row_filter: string | null }>
    for (const p of policies) {
      try {
        const rf = JSON.parse(p.row_filter ?? '{}') as Record<string, unknown>
        for (const key of Object.keys(rf)) {
          if (!key.startsWith('_') && !key.includes('.')) add(p.collection, key, 'row-level security filter')
        }
      } catch {
        // skip
      }
    }

    const bindings = (await db('nivaro_workflow_bindings')
      .whereNotNull('state_field')
      .select('collection', 'state_field')) as Array<{ collection: string; state_field: string }>
    for (const b of bindings) add(b.collection, b.state_field, 'workflow state mirror (state filters)')

    const suggestions: Suggestion[] = []
    for (const [key, reasons] of candidates) {
      const [table, column] = key.split('.')
      const rows = rowCount.get(table) ?? 0
      if (rows < MIN_ROWS) continue
      if (indexed.has(key)) continue
      suggestions.push({
        table,
        column,
        rows,
        reasons: [...reasons],
        create_sql: `CREATE NONCLUSTERED INDEX idx_${table}_${column} ON [${table}] ([${column}])`
      })
    }
    suggestions.sort((a, z) => z.rows - a.rows)
    return { data: { suggestions, min_rows: MIN_ROWS } }
  })

  /** Apply one suggestion. Identifier-checked; runs through the long-timeout
   *  executor (an index on a multi-million-row table outlives 15s). */
  app.post('/apply', async (req, reply) => {
    const b = req.body as { table?: string; column?: string }
    const table = String(b.table ?? '')
    const column = String(b.column ?? '')
    if (!IDENT.test(table) || !IDENT.test(column)) {
      return reply.code(400).send({ error: 'Invalid identifier' })
    }
    const { startJobRun } = await import('../services/job-runs.js')
    const run = await startJobRun('recalc', `index:${table}.${column}`, {
      label: 'Index creation',
      triggeredBy: req.user?.id ?? null
    })
    try {
      const name = await createIndex(table, column)
      await run.complete(`created ${name}`)
      await logActivity({ action: 'index-create', user: req.user?.id, comment: `${table}.${column}`, req })
      return { data: { created: name } }
    } catch (err) {
      await run.fail(err)
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /** Bulk apply: runs in the BACKGROUND (dozens of index builds on
   *  multi-million-row tables outlive any sane request timeout), strictly
   *  SEQUENTIAL so concurrent builds can't contend for the same tables, one
   *  job-run with live progress for the console/panel to poll. */
  app.post('/apply-bulk', async (req, reply) => {
    const b = req.body as { items?: Array<{ table?: string; column?: string }> }
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((i) => ({ table: String(i.table ?? ''), column: String(i.column ?? '') }))
      .filter((i) => IDENT.test(i.table) && IDENT.test(i.column))
      .slice(0, 100)
    if (items.length === 0) return reply.code(400).send({ error: 'No valid items' })

    const { startJobRun } = await import('../services/job-runs.js')
    const run = await startJobRun('recalc', 'index-bulk', {
      label: `Bulk index creation (${items.length})`,
      triggeredBy: req.user?.id ?? null
    })
    await logActivity({
      action: 'index-create',
      user: req.user?.id,
      comment: `bulk: ${items.length} index(es)`,
      req
    })
    void (async () => {
      let done = 0
      const failures: string[] = []
      for (const item of items) {
        try {
          await createIndex(item.table, item.column)
        } catch (err) {
          failures.push(`${item.table}.${item.column}: ${err instanceof Error ? err.message : String(err)}`)
        }
        done++
        run.progress({ done, total: items.length, current: `${item.table}.${item.column}`, failed: failures.length })
      }
      const summary = `${done - failures.length} created, ${failures.length} failed${failures.length ? ` — ${failures.slice(0, 3).join('; ').slice(0, 300)}` : ''}`
      if (failures.length === items.length) await run.fail(summary)
      else await run.complete(summary)
    })()
    return reply.code(202).send({ data: { job_run_id: run.id, total: items.length } })
  })
}

async function createIndex(table: string, column: string): Promise<string> {
  const name = `idx_${table}_${column}`.slice(0, 120)
  await execCustomQuerySql(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${name}')
     CREATE NONCLUSTERED INDEX [${name}] ON [${table}] ([${column}])`,
    {}
  )
  return name
}
