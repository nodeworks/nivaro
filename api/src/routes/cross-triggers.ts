import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import {
  type CrossTriggerAction,
  type CrossTriggerCondition,
  invalidateCrossTriggerCache
} from '../hooks/cross-triggers.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// CRUD over nivaro_rules rows whose `actions` JSON is a cross_collection action.
// See hooks/cross-triggers.ts for the storage contract.

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

const VALID_TRIGGERS = ['create', 'update', 'delete']
const VALID_OPERATIONS = ['create', 'update']

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

function extractCrossAction(raw: string | null): CrossTriggerAction | null {
  const parsed = parseJson<unknown>(raw)
  if (!parsed) return null
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const found = list.find(
    (a) => !!a && typeof a === 'object' && (a as { type?: string }).type === 'cross_collection'
  )
  return (found as CrossTriggerAction) ?? null
}

function serialize(row: RuleRow, action: CrossTriggerAction) {
  return {
    id: row.id,
    name: row.name,
    collection: row.collection,
    trigger: row.trigger,
    conditions: parseJson<CrossTriggerCondition[]>(row.conditions) ?? [],
    action,
    enabled: !!row.enabled,
    sort: row.sort,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

interface ActionBody {
  target_collection?: string
  operation?: string
  field_map?: Record<string, string>
  match_field?: string | null
}

function validateAction(action: ActionBody | undefined): string | null {
  if (!action) return 'action is required'
  if (!action.target_collection) return 'action.target_collection is required'
  if (action.target_collection.startsWith('nivaro_')) {
    return 'System collections cannot be cross-trigger targets'
  }
  if (!action.operation || !VALID_OPERATIONS.includes(action.operation)) {
    return `action.operation must be one of: ${VALID_OPERATIONS.join(', ')}`
  }
  if (
    !action.field_map ||
    typeof action.field_map !== 'object' ||
    Object.keys(action.field_map).length === 0
  ) {
    return 'action.field_map must map at least one target field'
  }
  if (action.operation === 'update') {
    if (!action.match_field) return 'action.match_field is required for update operations'
    if (action.field_map[action.match_field] === undefined) {
      return 'action.match_field must be a key of action.field_map'
    }
  }
  return null
}

function toStoredAction(action: ActionBody): string {
  return JSON.stringify({
    type: 'cross_collection',
    target_collection: action.target_collection,
    operation: action.operation,
    field_map: action.field_map,
    ...(action.match_field ? { match_field: action.match_field } : {})
  })
}

export async function crossTriggersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // List — optional ?collection= filter (source collection)
  app.get<{ Querystring: { collection?: string } }>('/', async (req) => {
    let query = db('nivaro_rules').orderBy('sort', 'asc').orderBy('id', 'asc')
    if (req.query.collection) query = query.where({ collection: req.query.collection })
    const rows = (await query.select('*')) as RuleRow[]
    const data = rows
      .map((row) => {
        const action = extractCrossAction(row.actions)
        return action ? serialize(row, action) : null
      })
      .filter(Boolean)
    return { data }
  })

  // Single
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_rules')
      .where({ id: Number(req.params.id) })
      .first()) as RuleRow | undefined
    const action = row ? extractCrossAction(row.actions) : null
    if (!row || !action) return reply.code(404).send({ error: 'Not found' })
    return { data: serialize(row, action) }
  })

  // Create
  app.post<{
    Body: {
      name?: string
      collection?: string
      trigger?: string
      conditions?: CrossTriggerCondition[]
      action?: ActionBody
      enabled?: boolean
      sort?: number
    }
  }>('/', async (req, reply) => {
    const body = req.body ?? {}
    if (!body.name || !body.collection || !body.trigger) {
      return reply.code(400).send({ error: 'name, collection and trigger are required' })
    }
    if (!VALID_TRIGGERS.includes(body.trigger)) {
      return reply.code(400).send({ error: `trigger must be one of: ${VALID_TRIGGERS.join(', ')}` })
    }
    if (body.collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'System collections cannot be cross-trigger sources' })
    }
    const actionError = validateAction(body.action)
    if (actionError) return reply.code(400).send({ error: actionError })

    const now = new Date()
    const [inserted] = await db('nivaro_rules')
      .insert({
        name: body.name,
        collection: body.collection,
        trigger: body.trigger,
        conditions: JSON.stringify(Array.isArray(body.conditions) ? body.conditions : []),
        actions: toStoredAction(body.action as ActionBody),
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

    invalidateCrossTriggerCache()
    await logActivity({
      action: 'create',
      collection: 'nivaro_rules',
      item: String(row.id),
      user: req.user?.id,
      req,
      comment: 'cross-trigger'
    })
    const createdAction = extractCrossAction(row.actions)
    if (!createdAction) return reply.code(500).send({ error: 'Failed to persist action' })
    return reply.code(201).send({ data: serialize(row, createdAction) })
  })

  // Update
  app.patch<{
    Params: { id: string }
    Body: Partial<{
      name: string
      collection: string
      trigger: string
      conditions: CrossTriggerCondition[]
      action: ActionBody
      enabled: boolean
      sort: number
    }>
  }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_rules').where({ id }).first()) as RuleRow | undefined
    if (!existing || !extractCrossAction(existing.actions)) {
      return reply.code(404).send({ error: 'Not found' })
    }

    const body = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }

    if (body.name !== undefined) patch.name = body.name
    if (body.collection !== undefined) {
      if (body.collection.startsWith('nivaro_')) {
        return reply.code(400).send({ error: 'System collections cannot be cross-trigger sources' })
      }
      patch.collection = body.collection
    }
    if (body.trigger !== undefined) {
      if (!VALID_TRIGGERS.includes(body.trigger)) {
        return reply
          .code(400)
          .send({ error: `trigger must be one of: ${VALID_TRIGGERS.join(', ')}` })
      }
      patch.trigger = body.trigger
    }
    if (body.conditions !== undefined) {
      patch.conditions = JSON.stringify(Array.isArray(body.conditions) ? body.conditions : [])
    }
    if (body.action !== undefined) {
      const actionError = validateAction(body.action)
      if (actionError) return reply.code(400).send({ error: actionError })
      patch.actions = toStoredAction(body.action)
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled
    if (body.sort !== undefined) patch.sort = body.sort

    await db('nivaro_rules').where({ id }).update(patch)
    const row = (await db('nivaro_rules').where({ id }).first()) as RuleRow

    invalidateCrossTriggerCache()
    await logActivity({
      action: 'update',
      collection: 'nivaro_rules',
      item: String(id),
      user: req.user?.id,
      req,
      comment: 'cross-trigger'
    })
    const updatedAction = extractCrossAction(row.actions)
    if (!updatedAction) return reply.code(500).send({ error: 'Failed to persist action' })
    return { data: serialize(row, updatedAction) }
  })

  // Delete
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_rules').where({ id }).first()) as RuleRow | undefined
    if (!existing || !extractCrossAction(existing.actions)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    await db('nivaro_rules').where({ id }).delete()
    invalidateCrossTriggerCache()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_rules',
      item: String(id),
      user: req.user?.id,
      req,
      comment: 'cross-trigger'
    })
    return reply.code(204).send()
  })
}
