import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, authenticate } from '../middleware/authenticate.js'

function parseJson(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try { return JSON.parse(val) } catch { return null }
}

function fmt(row: Record<string, unknown>) {
  return {
    ...row,
    fields: parseJson(row.fields),
  }
}

export async function addendumConfigsRoutes(app: FastifyInstance) {
  // GET /addendum-configs/:collection
  app.get('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const row = await db('nivaro_addendum_configs').where({ collection }).first() as Record<string, unknown> | undefined
    return reply.send({ data: row ? fmt(row) : null })
  })

  // PUT /addendum-configs/:collection — upsert (admin)
  app.put('/:collection', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const body = req.body as {
      fields?: Array<{ field: string; label_override?: string | null }>
      workflow_template_id?: string | null
      display_template?: string | null
    }

    const now = new Date()
    const existing = await db('nivaro_addendum_configs').where({ collection }).first()

    const payload = {
      fields: body.fields != null ? JSON.stringify(body.fields) : null,
      workflow_template_id: body.workflow_template_id ?? null,
      display_template: body.display_template ?? null,
      updated_at: now,
    }

    if (existing) {
      await db('nivaro_addendum_configs').where({ collection }).update(payload)
    } else {
      await db('nivaro_addendum_configs').insert({ collection, ...payload, created_at: now })
    }

    const row = await db('nivaro_addendum_configs').where({ collection }).first() as Record<string, unknown>
    return reply.send({ data: fmt(row) })
  })

  // DELETE /addendum-configs/:collection (admin)
  app.delete('/:collection', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    await db('nivaro_addendum_configs').where({ collection }).delete()
    return reply.code(204).send()
  })
}
