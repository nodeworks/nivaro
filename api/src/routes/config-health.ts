import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { runConfigHealthSweep } from '../services/config-health.js'

/** Config health: findings list + dismiss + run-now. Admin-only. */
export async function configHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (req) => {
    const q = req.query as { family?: string; include_dismissed?: string }
    let query = db('nivaro_config_health').orderBy([
      { column: 'severity', order: 'desc' },
      { column: 'id', order: 'asc' }
    ])
    if (q.family === 'hygiene' || q.family === 'lint') query = query.where('family', q.family)
    if (q.include_dismissed !== 'true') query = query.where('status', 'open')
    const rows = await query
    const counts = (await db('nivaro_config_health')
      .groupBy('family', 'status')
      .count({ c: '*' })
      .select('family', 'status')) as Array<{ family: string; status: string; c: number }>
    return { data: rows, counts }
  })

  app.post('/run', async (req) => {
    const { startJobRun } = await import('../services/job-runs.js')
    const run = await startJobRun('cron', 'config-health-sweep', { triggeredBy: req.user?.id ?? null })
    try {
      const outcome = await runConfigHealthSweep()
      await run.complete(outcome)
      await logActivity({ action: 'config-health-run', user: req.user?.id, comment: outcome, req })
      return { data: { outcome } }
    } catch (err) {
      await run.fail(err)
      throw err
    }
  })

  // One-click junction registration (#119): the unregistered-junction finding
  // gains its fix — register the collection (hidden), both M2O relation legs
  // (mutual junction_field pairing), and the parent-side M2M alias field.
  app.post<{ Body: { table?: string } }>('/fix-junction', async (req, reply) => {
    const table = String(req.body?.table ?? '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || /^nivaro_/i.test(table)) {
      return reply.code(400).send({ error: 'Invalid table' })
    }
    const cols = (await db('information_schema.columns')
      .where({ table_name: table })
      .select('column_name')) as Array<{ column_name: string }>
    if (cols.length === 0) return reply.code(404).send({ error: 'Table not found' })
    // A junction's shape: two *_id FK columns naming real tables.
    const fkCols = cols
      .map((c) => c.column_name)
      .filter((c) => /_id$/i.test(c) && c.toLowerCase() !== 'id')
    const legs: Array<{ column: string; target: string }> = []
    for (const c of fkCols) {
      const target = c.replace(/_id$/i, '')
      const t = await db('information_schema.tables').where({ table_name: target }).first()
      if (t) legs.push({ column: c, target })
    }
    if (legs.length !== 2) {
      return reply
        .code(422)
        .send({ error: `Expected exactly two resolvable *_id legs, found ${legs.length}` })
    }
    // Register the collection (hidden — junctions never show in nav).
    const existing = await db('nivaro_collections').where({ collection: table }).first()
    if (!existing) {
      await db('nivaro_collections').insert({
        collection: table,
        display_name: table,
        hidden: true,
        created_at: new Date()
      }).catch(() => {})
    }
    // Both legs as mutual junction relations (each names the OTHER's column
    // as junction_field — the healthy-pair invariant).
    const [a, b] = legs
    const haveA = await db('nivaro_relations')
      .where({ many_collection: table, many_field: a.column })
      .first()
    if (!haveA) {
      await db('nivaro_relations').insert({
        many_collection: table,
        many_field: a.column,
        one_collection: a.target,
        junction_field: b.column
      })
    }
    const haveB = await db('nivaro_relations')
      .where({ many_collection: table, many_field: b.column })
      .first()
    if (!haveB) {
      await db('nivaro_relations').insert({
        many_collection: table,
        many_field: b.column,
        one_collection: b.target,
        junction_field: a.column
      })
    }
    // Parent-side alias on the FIRST leg's target (convention: parent is the
    // table the junction name starts with, else leg A).
    const parent = table.startsWith(a.target) ? a.target : table.startsWith(b.target) ? b.target : a.target
    const other = parent === a.target ? b : a
    const alias = other.target
    const haveField = await db('nivaro_fields').where({ collection: parent, field: alias }).first()
    if (!haveField) {
      await db('nivaro_fields')
        .insert({
          collection: parent,
          field: alias,
          type: 'string',
          interface: 'list-m2m',
          hidden: false,
          created_at: new Date()
        })
        .catch(() => {})
      const haveAliasRel = await db('nivaro_relations')
        .where({ one_collection: parent, one_field: alias })
        .first()
      if (!haveAliasRel) {
        await db('nivaro_relations').insert({
          one_collection: parent,
          one_field: alias,
          many_collection: table,
          many_field: parent === a.target ? a.column : b.column,
          junction_field: parent === a.target ? b.column : a.column
        })
      }
    }
    const { clearMetadataCache } = await import('../services/collections.js')
    clearMetadataCache()
    await logActivity({
      action: 'schema-junction-register',
      user: req.user?.id,
      collection: table,
      comment: `${a.target} ⇄ ${b.target}`,
      req
    })
    return reply.send({ data: { registered: true, legs, alias_on: parent, alias } })
  })

  app.post<{ Params: { id: string } }>('/:id/dismiss', async (req, reply) => {
    const row = await db('nivaro_config_health').where('id', req.params.id).first('id', 'status')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const next = row.status === 'dismissed' ? 'open' : 'dismissed'
    await db('nivaro_config_health')
      .where('id', row.id)
      .update({ status: next, dismissed_by: next === 'dismissed' ? (req.user?.id ?? null) : null })
    return { data: { status: next } }
  })
}
