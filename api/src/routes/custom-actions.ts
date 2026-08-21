import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

/**
 * Custom action buttons (#39): admin-defined no-code record buttons. Config
 * per action_type:
 *  - flow:          {flow_id}                 → executeFlow with the record as payload
 *  - external_api:  {api_id, endpoint_path, method?, body_template?}
 *                     body_template is Liquid-lite: {{field}} substitution
 *  - update_fields: {set: {field: value | '{{field}}' template}}
 * `guard` = [{field, op, value}] AND over the record — the button hides when
 * unmet, and the execute endpoint re-checks so a stale client can't run it.
 * Execution requires UPDATE permission on the collection: every action either
 * writes the record or acts on its behalf.
 */

type GuardRule = { field: string; op: string; value?: unknown }

function parseJson<T>(raw: unknown): T | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

function guardPasses(rules: GuardRule[] | null, record: Record<string, unknown>): boolean {
  for (const r of rules ?? []) {
    const v = record[r.field]
    const want = r.value
    const ok = (() => {
      switch (r.op) {
        case 'eq':
          return String(v ?? '') === String(want ?? '')
        case 'neq':
          return String(v ?? '') !== String(want ?? '')
        case 'null':
          return v === null || v === undefined || v === ''
        case 'nnull':
          return !(v === null || v === undefined || v === '')
        case 'in':
          return String(want ?? '')
            .split(',')
            .map((x) => x.trim())
            .includes(String(v ?? ''))
        default:
          return false
      }
    })()
    if (!ok) return false
  }
  return true
}

/** {{field}} → record value; unknown tokens render empty. */
function renderTemplate(tpl: string, record: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, f) => String(record[f] ?? ''))
}

function formatAction(row: Record<string, unknown>) {
  return {
    ...row,
    config: parseJson(row.config),
    guard: parseJson(row.guard),
    is_active: !!row.is_active
  }
}

export async function customActionRoutes(app: FastifyInstance): Promise<void> {
  /** Buttons for a record's header — active, collection-scoped; the client
   *  evaluates guards against its own draft for instant hide/show. */
  app.get<{ Querystring: { collection?: string } }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      const collection = String(req.query.collection ?? '')
      if (!collection) return reply.code(400).send({ error: 'collection is required' })
      const rows = await db('nivaro_custom_actions')
        .where({ collection, is_active: true })
        .orderBy('sort', 'asc')
        .select('*')
      return { data: rows.map(formatAction) }
    }
  )

  app.get('/all', { preHandler: requireAdmin }, async () => {
    const rows = await db('nivaro_custom_actions').orderBy(['collection', 'sort']).select('*')
    return { data: rows.map(formatAction) }
  })

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as Record<string, unknown>
    const collection = String(b.collection ?? '')
    const label = String(b.label ?? '').trim()
    const actionType = String(b.action_type ?? '')
    if (!collection || !label) {
      return reply.code(400).send({ error: 'collection and label are required' })
    }
    if (!['flow', 'external_api', 'update_fields'].includes(actionType)) {
      return reply.code(400).send({ error: 'action_type must be flow, external_api or update_fields' })
    }
    if (!b.config || typeof b.config !== 'object') {
      return reply.code(400).send({ error: 'config is required' })
    }
    const [inserted] = await db('nivaro_custom_actions')
      .insert({
        collection,
        label: label.slice(0, 120),
        action_type: actionType,
        config: JSON.stringify(b.config),
        guard: b.guard ? JSON.stringify(b.guard) : null,
        confirm_text: b.confirm_text ? String(b.confirm_text).slice(0, 500) : null,
        is_active: b.is_active !== false,
        sort: Number(b.sort) || 0,
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({
      action: 'custom-action-create',
      user: req.user?.id,
      collection,
      comment: label,
      req
    })
    return reply.code(201).send({ data: { id } })
  })

  app.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const row = await db('nivaro_custom_actions').where('id', req.params.id).first('id')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (typeof b.label === 'string' && b.label.trim()) patch.label = b.label.trim().slice(0, 120)
    if (b.config !== undefined) patch.config = b.config ? JSON.stringify(b.config) : null
    if (b.guard !== undefined) patch.guard = b.guard ? JSON.stringify(b.guard) : null
    if (b.confirm_text !== undefined) {
      patch.confirm_text = b.confirm_text ? String(b.confirm_text).slice(0, 500) : null
    }
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    if (b.sort !== undefined) patch.sort = Number(b.sort) || 0
    if (Object.keys(patch).length > 0) {
      await db('nivaro_custom_actions').where('id', row.id).update(patch)
    }
    return { data: { id: row.id } }
  })

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const row = await db('nivaro_custom_actions').where('id', req.params.id).first('id', 'label', 'collection')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_custom_actions').where('id', row.id).del()
    await logActivity({
      action: 'custom-action-delete',
      user: req.user?.id,
      collection: String(row.collection),
      comment: String(row.label),
      req
    })
    return { data: { deleted: true } }
  })

  app.post<{ Params: { id: string }; Body: { item?: string } }>(
    '/:id/execute',
    { preHandler: requireAuth },
    async (req, reply) => {
      const action = (await db('nivaro_custom_actions')
        .where({ id: req.params.id, is_active: true })
        .first()) as Record<string, unknown> | undefined
      if (!action) return reply.code(404).send({ error: 'Action not found' })
      const item = String(req.body?.item ?? '')
      if (!item) return reply.code(400).send({ error: 'item is required' })
      const collection = String(action.collection)
      if (!req.isAdmin && !(await can(req.user!, 'update', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      // Read THROUGH the items service — RLS/scopes gate what the caller can
      // act on, and the guard re-check needs the real current values.
      const { readOne, updateOne } = await import('../services/items.js')
      const record = (await readOne(req.user!, collection, item).catch(() => null)) as Record<
        string,
        unknown
      > | null
      if (!record) return reply.code(404).send({ error: 'Record not found' })
      const guard = parseJson<GuardRule[]>(action.guard)
      if (!guardPasses(guard, record)) {
        return reply.code(409).send({ error: 'This action is not available for the record right now' })
      }

      const config = parseJson<Record<string, unknown>>(action.config) ?? {}
      let result: Record<string, unknown> = {}
      try {
        if (action.action_type === 'flow') {
          const flow = await db('nivaro_flows').where({ id: config.flow_id }).first('id', 'name')
          if (!flow) return reply.code(400).send({ error: 'The configured flow no longer exists' })
          const { executeFlow } = await import('../services/flow-executor.js')
          const output = await executeFlow({
            flowId: String(flow.id),
            flowName: String(flow.name),
            trigger: 'custom-action',
            payload: { collection, keys: [item], record },
            log: app.log,
            userId: req.user?.id
          })
          result = { flow: flow.name, output_keys: Object.keys(output ?? {}) }
        } else if (action.action_type === 'external_api') {
          const { callExternalApi } = await import('../services/external-apis.js')
          const body = config.body_template
            ? (() => {
                try {
                  return JSON.parse(renderTemplate(String(config.body_template), record))
                } catch {
                  return renderTemplate(String(config.body_template), record)
                }
              })()
            : undefined
          const res = await callExternalApi(Number(config.api_id), {
            path: renderTemplate(String(config.endpoint_path ?? ''), record),
            method: (String(config.method ?? 'POST').toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'),
            body
          })
          result = { status: (res as { status?: number }).status ?? 'sent' }
        } else if (action.action_type === 'update_fields') {
          const set = (config.set as Record<string, unknown>) ?? {}
          const payload: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(set)) {
            payload[k] = typeof v === 'string' ? renderTemplate(v, record) : v
          }
          if (Object.keys(payload).length === 0) {
            return reply.code(400).send({ error: 'The action has no fields configured' })
          }
          await updateOne(req.user!, collection, item, payload)
          result = { updated: Object.keys(payload) }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: `${action.label} failed: ${msg.slice(0, 500)}` })
      }
      await logActivity({
        action: 'custom-action-execute',
        user: req.user?.id,
        collection,
        item,
        comment: String(action.label),
        req
      })
      return { data: { ok: true, ...result } }
    }
  )
}
