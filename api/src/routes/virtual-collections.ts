import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

export async function virtualCollectionsRoutes(app: FastifyInstance) {
  // GET /virtual-collections — list all virtual collections
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const rows = await db('nivaro_collections').where({ is_virtual: 1 })
    return reply.send({ data: rows })
  })

  // POST /virtual-collections — create a virtual collection (no physical table)
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      name: string
      display_name: string
      virtual_sql: string
    }

    if (!body.name || !body.display_name || !body.virtual_sql) {
      return reply.code(400).send({ error: 'name, display_name, and virtual_sql are required' })
    }

    // Ensure collection name doesn't start with nivaro_
    if (body.name.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'Collection name cannot start with nivaro_' })
    }

    // Check for duplicate
    const existing = await db('nivaro_collections').where({ collection: body.name }).first()
    if (existing) {
      return reply.code(409).send({ error: `Collection '${body.name}' already exists` })
    }

    const now = new Date()
    const [row] = await db('nivaro_collections')
      .insert({
        collection: body.name,
        display_name: body.display_name,
        virtual_sql: body.virtual_sql,
        is_virtual: 1,
        accountability: 'all',
        hidden: 0,
        singleton: 0,
        versioning: 0,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = await db('nivaro_collections').where({ id: insertedId }).first()

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: String(insertedId),
      req
    })

    return reply.code(201).send({ data: created })
  })

  // PATCH /virtual-collections/:collection — update virtual_sql or display_name
  app.patch('/:collection', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const existing = await db('nivaro_collections').where({ collection, is_virtual: 1 }).first()
    if (!existing) return reply.code(404).send({ error: 'Virtual collection not found' })

    const body = req.body as Partial<{ display_name: string; virtual_sql: string }>
    const patch: Record<string, unknown> = { updated_at: new Date() }

    if (body.display_name !== undefined) patch.display_name = body.display_name
    if (body.virtual_sql !== undefined) patch.virtual_sql = body.virtual_sql

    await db('nivaro_collections').where({ collection }).update(patch)
    const updated = await db('nivaro_collections').where({ collection }).first()

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: String(existing.id),
      req
    })

    return reply.send({ data: updated })
  })

  // DELETE /virtual-collections/:collection — remove from registry (no table drop)
  app.delete('/:collection', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const existing = await db('nivaro_collections').where({ collection, is_virtual: 1 }).first()
    if (!existing) return reply.code(404).send({ error: 'Virtual collection not found' })

    await db('nivaro_collections').where({ collection }).delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: String(existing.id),
      req
    })

    return reply.code(204).send()
  })

  // POST /virtual-collections/:collection/query — execute virtual SQL
  app.post('/:collection/query', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const col = await db('nivaro_collections').where({ collection, is_virtual: 1 }).first()
    if (!col) return reply.code(404).send({ error: 'Virtual collection not found' })

    if (!col.virtual_sql) {
      return reply.code(400).send({ error: 'No virtual SQL defined for this collection' })
    }

    try {
      const wrapped = `SELECT TOP 100 * FROM (${col.virtual_sql}) _v`
      const result = await db.raw(wrapped)
      // knex mssql returns result in result[0]
      const rows = Array.isArray(result) ? result[0] : result
      return reply.send({ data: rows })
    } catch (err) {
      console.error('Virtual collection query failed:', err)
      return reply.code(400).send({ error: 'Query execution failed', detail: String(err) })
    }
  })

  // POST /virtual-collections/:collection/validate-sql — validate SQL without executing
  app.post('/:collection/validate-sql', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const col = await db('nivaro_collections').where({ collection, is_virtual: 1 }).first()
    if (!col) return reply.code(404).send({ error: 'Virtual collection not found' })

    const body = req.body as { sql?: string }
    const sqlToValidate = body.sql ?? col.virtual_sql

    if (!sqlToValidate) {
      return reply.code(400).send({ error: 'No SQL provided' })
    }

    try {
      await db.raw(`SET NOEXEC ON; ${sqlToValidate}; SET NOEXEC OFF;`)
      return reply.send({ valid: true })
    } catch (err) {
      return reply.send({ valid: false, error: String(err) })
    }
  })

  // Virtual materialization (#169): snapshot the SQL view into a REAL table
  // (`<name>_snapshot`, dropped + rebuilt) so heavy view queries can be read
  // as plain rows. Manual trigger; schedule by calling this from a flow/cron.
  app.post<{ Params: { name: string } }>('/:name/materialize', { preHandler: requireAdmin }, async (req, reply) => {
    const { name } = req.params
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return reply.code(400).send({ error: 'Invalid name' })
    const col = (await db('nivaro_collections')
      .where({ collection: name, is_virtual: true })
      .first('virtual_sql')) as { virtual_sql?: string | null } | undefined
    if (!col?.virtual_sql) return reply.code(404).send({ error: 'Virtual collection not found' })
    const target = `${name}_snapshot`.slice(0, 110)
    try {
      await db.raw(`IF OBJECT_ID(?, 'U') IS NOT NULL DROP TABLE [${target}]`, [target])
      // SELECT INTO snapshots the view's current shape + rows in one pass.
      await db.raw(`SELECT * INTO [${target}] FROM (${col.virtual_sql}) _v`)
      const n = (await db(target).count({ n: '*' }).first()) as { n?: number | string } | undefined
      await logActivity({
        action: 'virtual-materialize',
        user: req.user?.id,
        collection: name,
        comment: `${target}: ${Number(n?.n ?? 0)} rows`,
        req
      })
      return reply.send({ data: { table: target, rows: Number(n?.n ?? 0) } })
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message.slice(0, 300) : 'Materialization failed' })
    }
  })
}
