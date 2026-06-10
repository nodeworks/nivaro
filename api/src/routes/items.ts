import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import {
  CollectionNotFoundError,
  createOne,
  deleteOne,
  ForbiddenError,
  readItems,
  readOne,
  updateOne
} from '../services/items.js'
import {
  coerceBool,
  parseJson,
  resolveTransitionTarget,
  type WorkflowTransition
} from '../services/pipeline-engine.js'
import type { ItemsQuery } from '../types.js'

function handleError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof CollectionNotFoundError) {
    return reply.code(404).send({ error: err.message })
  } else if (err instanceof ForbiddenError) {
    return reply.code(403).send({ error: 'Forbidden' })
  }
  throw err
}

// ─── CSV helpers (no external dependency) ─────────────────────────────────────

function toCsv(rows: Record<string, unknown>[], fields: string[]): string {
  const escapeCsv = (v: unknown): string => {
    if (v == null) return ''
    const s = String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const header = fields.map(escapeCsv).join(',')
  const lines = rows.map((r) => fields.map((f) => escapeCsv(r[f])).join(','))
  return [header, ...lines].join('\r\n')
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''))
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
  })
}

export async function itemsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', resolveWorkspace)

  app.get('/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const q = req.query as Record<string, string>
    const query: ItemsQuery = {
      fields: q.fields?.split(','),
      sort: q.sort?.split(','),
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
      page: q.page ? Number(q.page) : undefined,
      search: q.search,
      filter: q.filter ? (JSON.parse(q.filter) as Record<string, unknown>) : undefined
    }
    try {
      const result = await readItems(
        req.user!,
        collection,
        query,
        req,
        req.workspaceId ?? undefined
      )
      return reply.send(result)
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // Export — must be registered before /:collection/:id so "export" isn't read as an id
  app.get('/:collection/export', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const q = req.query as { format?: string; fields?: string; filter?: string; sort?: string }
    const format = q.format === 'json' ? 'json' : 'csv'

    const query: ItemsQuery = {
      fields: q.fields?.split(','),
      sort: q.sort?.split(','),
      limit: 10000,
      offset: 0,
      filter: q.filter ? (JSON.parse(q.filter) as Record<string, unknown>) : undefined
    }

    try {
      const result = await readItems(
        req.user!,
        collection,
        query,
        req,
        req.workspaceId ?? undefined
      )
      const rows = result.data as Record<string, unknown>[]

      // Determine field set: explicit query fields, else union of keys from the rows
      let fields: string[]
      if (q.fields) {
        fields = q.fields.split(',').filter((f) => f && f !== '*')
      } else {
        const keySet = new Set<string>()
        for (const r of rows) {
          for (const k of Object.keys(r)) keySet.add(k)
        }
        fields = [...keySet]
      }

      if (format === 'json') {
        return reply
          .header('Content-Type', 'application/json')
          .header('Content-Disposition', `attachment; filename="${collection}-export.json"`)
          .send({ data: rows })
      }

      const csv = toCsv(rows, fields)
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', `attachment; filename="${collection}-export.csv"`)
        .send(csv)
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // Import — multipart CSV upload
  app.post('/:collection/import', async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const multipart = await req.file()
    if (!multipart) return reply.code(400).send({ error: 'No file provided' })

    const buffer = await multipart.toBuffer()
    const text = buffer.toString('utf-8')
    const records = parseCsv(text)

    let imported = 0
    const errors: Array<{ row: number; error: string }> = []

    for (let i = 0; i < records.length; i++) {
      try {
        await createOne(
          req.user!,
          collection,
          records[i] as Record<string, unknown>,
          req,
          req.workspaceId ?? undefined
        )
        imported++
      } catch (err) {
        if (err instanceof CollectionNotFoundError) {
          // Whole collection invalid — abort with a clear error.
          return reply.code(404).send({ error: err.message })
        }
        if (err instanceof ForbiddenError) {
          return reply.code(403).send({ error: 'Forbidden' })
        }
        errors.push({ row: i + 1, error: String(err) })
      }
    }

    return reply.send({ imported, errors })
  })

  // ─── Bulk actions ─────────────────────────────────────────────────────────

  app.post('/:collection/bulk-delete', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids } = req.body as { ids: string[] }
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids array required' })
    let deleted = 0
    for (const id of ids) {
      try {
        await deleteOne(req.user!, collection, id, req, req.workspaceId ?? undefined)
        deleted++
      } catch {
        // skip permission/not-found errors per item
      }
    }
    return reply.send({ deleted })
  })

  app.post('/:collection/bulk-update', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids, data } = req.body as { ids: string[]; data: Record<string, unknown> }
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids array required' })
    if (!data || typeof data !== 'object')
      return reply.code(400).send({ error: 'data object required' })
    let updated = 0
    for (const id of ids) {
      try {
        await updateOne(req.user!, collection, id, data, req, req.workspaceId ?? undefined)
        updated++
      } catch {
        // skip permission/not-found errors per item
      }
    }
    return reply.send({ updated })
  })

  app.post('/:collection/bulk-transition', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids, transition_id } = req.body as { ids: string[]; transition_id: string }
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids array required' })
    if (!transition_id) return reply.code(400).send({ error: 'transition_id required' })

    const transition = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ id: transition_id })
      .first()
    if (!transition) return reply.code(404).send({ error: 'Transition not found' })

    // Check role permission once (applies to all items)
    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && transition.required_roles) {
      const roles = parseJson(transition.required_roles) as string[] | null
      if (roles && roles.length > 0) {
        const userRole = req.user?.role ?? null
        if (!userRole || !roles.includes(userRole)) {
          return reply.code(403).send({ error: 'You do not have permission for this transition' })
        }
      }
    }

    const binding = await db('nivaro_workflow_bindings').where({ collection }).first()

    let succeeded = 0
    let failed = 0
    for (const item of ids) {
      try {
        const instance = await db('nivaro_workflow_instances').where({ collection, item }).first()
        if (!instance || instance.completed_at) {
          failed++
          continue
        }

        const fromOk =
          transition.from_state === null || transition.from_state === instance.current_state
        if (!fromOk) {
          failed++
          continue
        }

        const resolvedTarget = await resolveTransitionTarget(
          transition.to_state,
          instance.template,
          collection,
          item,
          instance.id,
          db
        )
        const newStateId = resolvedTarget?.id ?? transition.to_state
        const newStateObj =
          resolvedTarget ?? (await db('nivaro_workflow_states').where({ id: newStateId }).first())

        await db('nivaro_workflow_instances')
          .where({ id: instance.id })
          .update({
            current_state: newStateId,
            completed_at: newStateObj && coerceBool(newStateObj.is_terminal) ? new Date() : null
          })

        await db('nivaro_workflow_history').insert({
          instance: instance.id,
          transition: transition.id,
          from_state: instance.current_state,
          to_state: newStateId,
          user: req.user?.id ?? null,
          comment: null,
          timestamp: new Date()
        })

        if (binding?.state_field && newStateObj) {
          try {
            await db(collection)
              .where({ id: item })
              .update({ [binding.state_field]: newStateObj.key })
          } catch {
            /* non-fatal */
          }
        }

        succeeded++
      } catch {
        failed++
      }
    }
    return reply.send({ succeeded, failed })
  })

  // ─────────────────────────────────────────────────────────────────────────

  app.get('/:collection/:id', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    try {
      const item = await readOne(req.user!, collection, id, req.workspaceId ?? undefined)
      if (!item) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ data: item })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  app.post('/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    try {
      const item = await createOne(
        req.user!,
        collection,
        req.body as Record<string, unknown>,
        req,
        req.workspaceId ?? undefined
      )
      return reply.code(201).send({ data: item })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  app.patch('/:collection/:id', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    try {
      const item = await updateOne(
        req.user!,
        collection,
        id,
        req.body as Record<string, unknown>,
        req,
        req.workspaceId ?? undefined
      )
      return reply.send({ data: item })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  app.delete('/:collection/:id', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    try {
      await deleteOne(req.user!, collection, id, req, req.workspaceId ?? undefined)
      return reply.code(204).send()
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // POST /items/:collection/:id/clone — clone an item
  app.post('/:collection/:id/clone', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }

    try {
      const original = (await db(collection).where({ id }).first()) as
        | Record<string, unknown>
        | undefined
      if (!original) return reply.code(404).send({ error: 'Not found' })

      // Build clone: omit the id field
      const clone = { ...original }
      delete clone.id

      // If collection has draft_publish_enabled, set _status to draft
      const colMeta = await db('nivaro_collections').where({ collection }).first()
      if (colMeta?.draft_publish_enabled) {
        clone._status = 'draft'
      }

      const [row] = await db(collection).insert(clone).returning('id')
      const newId = typeof row === 'object' ? (row as { id: unknown }).id : row

      await logActivity({
        action: 'clone',
        user: req.user!.id,
        collection,
        item: String(newId),
        comment: JSON.stringify({ source_id: id }),
        req
      })

      return reply.code(201).send({ data: { id: newId } })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // GET /items/:collection/:id/field-history/:field — field change history
  app.get('/:collection/:id/field-history/:field', async (req, reply) => {
    const { collection, id, field } = req.params as {
      collection: string
      id: string
      field: string
    }

    const rows = (await db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('a.collection', collection)
      .where('a.item', id)
      .whereIn('a.action', ['update', 'create'])
      .orderBy('a.timestamp', 'desc')
      .limit(50)
      .select('r.id as revision_id', 'a.timestamp', 'r.data', 'a.user as user_id')) as Array<{
      revision_id: number
      timestamp: Date
      data: string | Record<string, unknown>
      user_id: string | null
    }>

    const history = rows.map((row) => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed =
          typeof row.data === 'string'
            ? (JSON.parse(row.data) as Record<string, unknown>)
            : (row.data as Record<string, unknown>)
      } catch {
        parsed = {}
      }
      return {
        revision_id: row.revision_id,
        timestamp: row.timestamp,
        value: parsed[field] ?? null,
        user_id: row.user_id
      }
    })

    return reply.send({ data: history })
  })
}
