import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { bustContractCache } from '../services/integration-contracts.js'

/** Payload-contract CRUD. Admin-only; enforcement lives in the items service. */
export async function integrationContractRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const rows = await db('nivaro_integration_contracts as c')
      .leftJoin('nivaro_users as u', 'u.id', 'c.user_id')
      .orderBy('c.id', 'asc')
      .select('c.*', 'u.email as user_email')
    return {
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        config: r.config ? JSON.parse(String(r.config)) : null
      }))
    }
  })

  app.post('/', async (req, reply) => {
    const b = req.body as {
      name?: string
      collection?: string
      user_id?: string | null
      config?: unknown
      mode?: string
      is_active?: boolean
    }
    const name = String(b.name ?? '').trim()
    const collection = String(b.collection ?? '').trim()
    if (!name || !collection) return reply.code(400).send({ error: 'name and collection are required' })
    if (/^nivaro_/i.test(collection)) return reply.code(400).send({ error: 'System collections cannot carry contracts' })
    const [inserted] = await db('nivaro_integration_contracts')
      .insert({
        name: name.slice(0, 200),
        collection: collection.slice(0, 255),
        user_id: b.user_id || null,
        config: b.config ? JSON.stringify(b.config) : null,
        mode: b.mode === 'reject' ? 'reject' : 'flag',
        is_active: b.is_active !== false,
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    bustContractCache()
    await logActivity({ action: 'integration-contract-create', user: req.user?.id, item: String(id), comment: `${collection}: ${name}`, req })
    return reply.code(201).send({ data: { id } })
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_integration_contracts').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 200)
    if (b.user_id !== undefined) patch.user_id = b.user_id || null
    if (b.config !== undefined) patch.config = b.config ? JSON.stringify(b.config) : null
    if (b.mode !== undefined) patch.mode = b.mode === 'reject' ? 'reject' : 'flag'
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    if (Object.keys(patch).length > 0) await db('nivaro_integration_contracts').where('id', row.id).update(patch)
    bustContractCache()
    await logActivity({ action: 'integration-contract-update', user: req.user?.id, item: String(row.id), req })
    return { data: { id: row.id } }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_integration_contracts').where('id', req.params.id).first('id', 'name')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_integration_contracts').where('id', row.id).del()
    bustContractCache()
    await logActivity({ action: 'integration-contract-delete', user: req.user?.id, item: String(row.id), comment: String(row.name), req })
    return { data: { deleted: true } }
  })
}
