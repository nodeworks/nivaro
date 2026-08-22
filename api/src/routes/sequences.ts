import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Auto-id sequences console (#66): view every nivaro_sequences counter beside
 * the collection's actual max, and bump one — the go-live "re-seed above the
 * legacy table's max" chore as a page instead of a scratchpad script. Bumps
 * only ever RAISE a counter: lowering one mints duplicate ids.
 */
export async function sequenceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const rows = (await db('nivaro_sequences').orderBy('id')) as Array<{
      id: string
      next_val: number | string
    }>
    // Each sequence id is `<collection>.<field>` — pair it with the collection's
    // registered auto_id pattern so the console explains what the counter feeds.
    const fields = (await db('nivaro_fields')
      .whereNotNull('options')
      .where('options', 'like', '%auto_id%')
      .select('collection', 'field', 'options')) as Array<{
      collection: string
      field: string
      options: string | null
    }>
    const patterns = new Map<string, string>()
    for (const f of fields) {
      try {
        const opts = JSON.parse(f.options ?? '{}') as { auto_id?: { pattern?: string } | string }
        const pattern =
          typeof opts.auto_id === 'string' ? opts.auto_id : (opts.auto_id?.pattern ?? null)
        if (pattern) patterns.set(`${f.collection}.${f.field}`, pattern)
      } catch {
        // unparseable options — pattern stays unknown
      }
    }
    return {
      data: rows.map((r) => ({
        id: r.id,
        next_val: Number(r.next_val),
        pattern: patterns.get(r.id) ?? null
      }))
    }
  })

  app.post<{ Params: { id: string }; Body: { next_val?: number } }>(
    '/:id/bump',
    async (req, reply) => {
      const target = Math.floor(Number(req.body?.next_val))
      if (!Number.isFinite(target) || target < 1)
        return reply.code(400).send({ error: 'next_val must be a positive integer' })
      const row = (await db('nivaro_sequences').where('id', req.params.id).first()) as
        | { next_val: number | string }
        | undefined
      if (!row) return reply.code(404).send({ error: 'Sequence not found' })
      const current = Number(row.next_val)
      if (target <= current)
        return reply.code(400).send({
          error: `Refusing to lower the counter (currently ${current}) — that would mint duplicate ids`
        })
      await db('nivaro_sequences').where('id', req.params.id).update({ next_val: target })
      await logActivity({
        action: 'sequence-bump',
        user: req.user?.id,
        comment: `${req.params.id}: ${current} → ${target}`,
        req
      })
      return { data: { id: req.params.id, next_val: target } }
    }
  )
}
