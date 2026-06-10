import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { notifyUser } from '../services/notification-channels.js'
import { can } from '../services/permissions.js'

interface TaskRow {
  id: number
  collection: string
  item: string
  title: string
  description: string | null
  assignee: string
  due_date: Date | null
  status: 'open' | 'done' | 'cancelled'
  created_by: string
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

const TASK_STATUSES = ['open', 'done', 'cancelled']

function userName(row: { first_name?: string | null; last_name?: string | null } | undefined) {
  if (!row) return null
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || null
}

const LABEL_CANDIDATES = ['title', 'name', 'label', 'subject']

/** Best-effort display labels for the items a set of tasks points at. */
async function getItemLabels(tasks: TaskRow[]): Promise<Record<string, string>> {
  const labels: Record<string, string> = {}
  const byCollection = new Map<string, Set<string>>()
  for (const t of tasks) {
    if (!byCollection.has(t.collection)) byCollection.set(t.collection, new Set())
    byCollection.get(t.collection)!.add(t.item)
  }

  for (const [collection, ids] of byCollection) {
    try {
      const fields = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
        field: string
      }>
      const fieldNames = fields.map((f) => f.field)
      const labelField = LABEL_CANDIDATES.find((c) => fieldNames.includes(c))
      const pk = fieldNames.includes('id') ? 'id' : null
      if (!labelField || !pk) continue

      const rows = (await db(collection)
        .whereIn(pk, [...ids])
        .select(pk, labelField)) as Array<Record<string, unknown>>
      for (const row of rows) {
        const value = row[labelField]
        if (value != null) labels[`${collection}:${row[pk]}`] = String(value)
      }
    } catch {
      // Collection table may not exist or be queryable — labels stay empty
    }
  }
  return labels
}

function withNames(rows: Array<TaskRow & Record<string, unknown>>) {
  return rows.map((r) => ({
    ...r,
    assignee_name: userName({
      first_name: r.assignee_first as string | null,
      last_name: r.assignee_last as string | null
    }),
    created_by_name: userName({
      first_name: r.creator_first as string | null,
      last_name: r.creator_last as string | null
    }),
    assignee_first: undefined,
    assignee_last: undefined,
    creator_first: undefined,
    creator_last: undefined
  }))
}

function baseQuery() {
  return db('nivaro_tasks as t')
    .leftJoin('nivaro_users as a', 't.assignee', 'a.id')
    .leftJoin('nivaro_users as c', 't.created_by', 'c.id')
    .select(
      't.*',
      'a.first_name as assignee_first',
      'a.last_name as assignee_last',
      'c.first_name as creator_first',
      'c.last_name as creator_last'
    )
}

async function notifyAssignee(app: FastifyInstance, task: TaskRow, actorId: string): Promise<void> {
  if (task.assignee === actorId) return // self-assignment needs no notification
  await notifyUser(app, task.assignee, {
    subject: `Task assigned: ${task.title}`,
    message: task.description
      ? task.description.slice(0, 400)
      : `You have been assigned a task on ${task.collection}/${task.item}.`,
    collection: task.collection,
    item: task.item,
    sender: actorId
  })
}

export async function tasksRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET / — list tasks with filters
  app.get<{
    Querystring: { collection?: string; item?: string; assignee?: string; status?: string }
  }>('/', async (req, reply) => {
    const { collection, item, assignee, status } = req.query

    let query = baseQuery().orderBy('t.created_at', 'desc')
    if (collection) query = query.where('t.collection', collection)
    if (item) query = query.where('t.item', item)
    if (assignee) {
      query = query.where('t.assignee', assignee === 'me' ? req.user!.id : assignee)
    }
    if (status) query = query.where('t.status', status)

    const rows = (await query) as Array<TaskRow & Record<string, unknown>>
    return reply.send({ data: withNames(rows) })
  })

  // GET /mine — open tasks for the current user, with item labels
  app.get('/mine', async (req, reply) => {
    const rows = (await baseQuery()
      .where('t.assignee', req.user!.id)
      .where('t.status', 'open')
      .orderBy('t.due_date', 'asc')) as Array<TaskRow & Record<string, unknown>>

    const labels = await getItemLabels(rows as TaskRow[])
    const data = withNames(rows).map((r) => ({
      ...r,
      item_label: labels[`${r.collection}:${r.item}`] ?? null
    }))
    return reply.send({ data })
  })

  // GET /:id — single task
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const rows = (await baseQuery().where('t.id', Number(req.params.id))) as Array<
      TaskRow & Record<string, unknown>
    >
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: withNames(rows)[0] })
  })

  // POST / — create task + notify assignee
  app.post<{
    Body: {
      collection?: string
      item?: string
      title?: string
      description?: string | null
      assignee?: string
      due_date?: string | null
    }
  }>('/', async (req, reply) => {
    const { collection, item, title, description, assignee, due_date } = req.body ?? {}
    if (!collection || !item || !title || !assignee) {
      return reply.code(400).send({ error: 'collection, item, title, and assignee are required' })
    }
    if (collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'Tasks cannot target system collections' })
    }
    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const assigneeUser = await db('nivaro_users').where({ id: assignee }).first('id')
    if (!assigneeUser) return reply.code(400).send({ error: 'Unknown assignee' })

    const now = new Date()
    const [task] = (await db('nivaro_tasks')
      .insert({
        collection,
        item: String(item),
        title: title.slice(0, 500),
        description: description ?? null,
        assignee,
        due_date: due_date ? new Date(due_date) : null,
        status: 'open',
        created_by: req.user!.id,
        completed_at: null,
        created_at: now,
        updated_at: now
      })
      .returning('*')) as unknown as [TaskRow]

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_tasks',
      item: String(task.id),
      req
    })

    await notifyAssignee(app, task, req.user!.id)

    return reply.code(201).send({ data: task })
  })

  // PATCH /:id — update (assignee, creator, or admin)
  app.patch<{
    Params: { id: string }
    Body: {
      title?: string
      description?: string | null
      assignee?: string
      due_date?: string | null
      status?: string
    }
  }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_tasks').where({ id }).first()) as TaskRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const me = req.user!.id
    if (!req.isAdmin && existing.assignee !== me && existing.created_by !== me) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = req.body ?? {}
    if (body.status && !TASK_STATUSES.includes(body.status)) {
      return reply.code(400).send({ error: `status must be one of ${TASK_STATUSES.join(', ')}` })
    }

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.title !== undefined) patch.title = String(body.title).slice(0, 500)
    if (body.description !== undefined) patch.description = body.description
    if (body.assignee !== undefined) {
      const assigneeUser = await db('nivaro_users').where({ id: body.assignee }).first('id')
      if (!assigneeUser) return reply.code(400).send({ error: 'Unknown assignee' })
      patch.assignee = body.assignee
    }
    if (body.due_date !== undefined) {
      patch.due_date = body.due_date ? new Date(body.due_date) : null
    }
    if (body.status !== undefined) {
      patch.status = body.status
      patch.completed_at = body.status === 'done' ? new Date() : null
    }

    await db('nivaro_tasks').where({ id }).update(patch)
    const updated = (await db('nivaro_tasks').where({ id }).first()) as TaskRow

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_tasks',
      item: String(id),
      req
    })

    // Re-assignment notifies the new assignee
    if (body.assignee && body.assignee !== existing.assignee) {
      await notifyAssignee(app, updated, me)
    }

    return reply.send({ data: updated })
  })

  // POST /:id/complete — mark done
  app.post<{ Params: { id: string } }>('/:id/complete', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_tasks').where({ id }).first()) as TaskRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const me = req.user!.id
    if (!req.isAdmin && existing.assignee !== me && existing.created_by !== me) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (existing.status !== 'open') {
      return reply.code(409).send({ error: `Task is already ${existing.status}` })
    }

    await db('nivaro_tasks')
      .where({ id })
      .update({ status: 'done', completed_at: new Date(), updated_at: new Date() })
    const updated = (await db('nivaro_tasks').where({ id }).first()) as TaskRow

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_tasks',
      item: String(id),
      req
    })

    return reply.send({ data: updated })
  })

  // DELETE /:id — creator or admin
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_tasks').where({ id }).first()) as TaskRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (!req.isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_tasks').where({ id }).delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_tasks',
      item: String(id),
      req
    })

    return reply.code(204).send()
  })
}
