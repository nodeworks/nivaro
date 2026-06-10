import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface RuleRow {
  id: number
  name: string
  collection: string
  trigger: string
  conditions: string | null
  actions: string | null
  enabled: boolean
  sort: number | null
  created_at: Date
  updated_at: Date
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val == null) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

function serialize(row: RuleRow) {
  return {
    id: row.id,
    name: row.name,
    collection: row.collection,
    trigger: row.trigger,
    conditions: parseJson(row.conditions),
    actions: parseJson(row.actions),
    enabled: !!row.enabled,
    sort: row.sort,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function rulesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // List — optional ?collection= filter, ordered by sort.
  app.get<{ Querystring: { collection?: string } }>('/', async (req) => {
    let query = db('nivaro_rules').orderBy('sort', 'asc')
    if (req.query.collection) query = query.where({ collection: req.query.collection })
    const rows = (await query.select('*')) as RuleRow[]
    return { data: rows.map(serialize) }
  })

  // Single
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_rules')
      .where({ id: Number(req.params.id) })
      .first()) as RuleRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: serialize(row) }
  })

  // Create
  app.post<{
    Body: {
      name: string
      collection: string
      trigger: string
      conditions?: unknown
      actions?: unknown
      enabled?: boolean
      sort?: number
    }
  }>('/', async (req, reply) => {
    const body = req.body
    if (!body?.name || !body?.collection || !body?.trigger) {
      return reply.code(400).send({ error: 'name, collection and trigger are required' })
    }
    const now = new Date()
    const [inserted] = await db('nivaro_rules')
      .insert({
        name: body.name,
        collection: body.collection,
        trigger: body.trigger,
        conditions: toJsonStr(body.conditions ?? null),
        actions: toJsonStr(body.actions ?? null),
        enabled: body.enabled ?? true,
        sort: body.sort ?? 0,
        created_at: now,
        updated_at: now
      })
      .returning('*')

    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as RuleRow)
        : ((await db('nivaro_rules')
            .where({ id: inserted as number })
            .first()) as RuleRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_rules',
      item: String(row.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: serialize(row) })
  })

  // Update
  app.patch<{
    Params: { id: string }
    Body: Partial<{
      name: string
      collection: string
      trigger: string
      conditions: unknown
      actions: unknown
      enabled: boolean
      sort: number
    }>
  }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_rules').where({ id }).first()) as RuleRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }

    if (body.name !== undefined) patch.name = body.name
    if (body.collection !== undefined) patch.collection = body.collection
    if (body.trigger !== undefined) patch.trigger = body.trigger
    if (body.conditions !== undefined) patch.conditions = toJsonStr(body.conditions)
    if (body.actions !== undefined) patch.actions = toJsonStr(body.actions)
    if (body.enabled !== undefined) patch.enabled = body.enabled
    if (body.sort !== undefined) patch.sort = body.sort

    await db('nivaro_rules').where({ id }).update(patch)
    const row = (await db('nivaro_rules').where({ id }).first()) as RuleRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_rules',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: serialize(row) }
  })

  // Delete
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const deleted = await db('nivaro_rules')
      .where({ id: Number(req.params.id) })
      .delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_rules',
      item: req.params.id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })
}
