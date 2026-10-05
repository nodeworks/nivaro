import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { execCustomQuerySql } from '../services/custom-query-exec.js'
import { createIndexSql, indexAdvisorSuggestions, indexName } from '../services/index-advisor.js'

/**
 * Index advisor routes. The suggestions themselves live in services/index-advisor.ts
 * (config-declared hot columns crossed against leading-column index coverage); these
 * routes list them and apply one or many in one click.
 */

const IDENT = /^[A-Za-z0-9_]+$/
/** A column list — one identifier, or a comma-joined pair for a composite key. */
const COLS = /^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)?$/

export async function indexAdvisorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => ({ data: await indexAdvisorSuggestions() }))

  /** Apply one suggestion. Identifier-checked; runs through the long-timeout
   *  executor (an index on a multi-million-row table outlives 15s). */
  app.post('/apply', async (req, reply) => {
    const b = req.body as { table?: string; column?: string }
    const table = String(b.table ?? '')
    const column = String(b.column ?? '')
    if (!IDENT.test(table) || !COLS.test(column)) {
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
      await logActivity({
        action: 'index-create',
        user: req.user?.id,
        comment: `${table}.${column}`,
        req
      })
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
      .filter((i) => IDENT.test(i.table) && COLS.test(i.column))
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
          failures.push(
            `${item.table}.${item.column}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        done++
        run.progress({
          done,
          total: items.length,
          current: `${item.table}.${item.column}`,
          failed: failures.length
        })
      }
      const summary = `${done - failures.length} created, ${failures.length} failed${failures.length ? ` — ${failures.slice(0, 3).join('; ').slice(0, 300)}` : ''}`
      if (failures.length === items.length) await run.fail(summary)
      else await run.complete(summary)
    })()
    return reply.code(202).send({ data: { job_run_id: run.id, total: items.length } })
  })
}

async function createIndex(table: string, column: string): Promise<string> {
  const name = indexName(table, column)
  await execCustomQuerySql(
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = '${name}')
     ${createIndexSql(table, column)}`,
    {}
  )
  return name
}
