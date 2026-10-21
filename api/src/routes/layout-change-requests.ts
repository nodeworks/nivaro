import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { readOne } from '../services/items.js'
import {
  FORM_CHANGE_CATEGORY,
  FORM_CHANGE_DESCRIPTION,
  formChangeTitle,
  formChangeTrailer,
  parseFormChange
} from '../services/layout-change-requests.js'
import {
  logTicketEvent,
  nameOf,
  notifyTicket,
  SUPPORT_KIND,
  type TicketRow,
  userName
} from '../services/support-tickets.js'
import { resolveFriendlyId } from '../services/workflow-transitions.js'
import { raiseTicket } from './support.js'

/**
 * /api/layout-change-requests (#2609) — "Suggest a form change" from a record
 * page, and the queue the layout editor shows. Requests are support requests
 * of the "Form change" type (services/layout-change-requests.ts), so they also
 * show on the Support desk and under the requester's My requests.
 *
 * An administrator can switch the feature off by deactivating the "Form
 * change" type on Support → Request types.
 */

interface CategoryRow {
  id: number
  name: string
  description: string | null
  collection: string | null
  team_id: number | null
  default_assignee: string | null
  is_active: boolean | number
  sort: number
  legacy_id: number | null
}

async function findCategory(): Promise<CategoryRow | undefined> {
  return (await db('nivaro_task_categories')
    .whereRaw('LOWER(name) = ?', [FORM_CHANGE_CATEGORY.toLowerCase()])
    .orderBy('id')
    .first()) as CategoryRow | undefined
}

/** The "Form change" type, made on first use (admins route it like any other type). */
async function ensureCategory(): Promise<CategoryRow> {
  const found = await findCategory()
  if (found) return found
  await db('nivaro_task_categories').insert({
    name: FORM_CHANGE_CATEGORY,
    description: FORM_CHANGE_DESCRIPTION,
    collection: null,
    team_id: null,
    default_assignee: null,
    is_active: true,
    sort: 900
  })
  return (await findCategory()) as CategoryRow
}

export async function layoutChangeRequestRoutes(app: FastifyInstance) {
  // POST /layout-change-requests { collection, item, layout_id?, field?, message }
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      collection?: unknown
      item?: unknown
      layout_id?: unknown
      field?: unknown
      field_label?: unknown
      message?: unknown
    }
    const collection = typeof b.collection === 'string' ? b.collection : ''
    const item = b.item == null || b.item === '' ? '' : String(b.item)
    const message = typeof b.message === 'string' ? b.message.trim().slice(0, 4000) : ''
    if (!message) return reply.code(400).send({ error: 'Say what should change' })
    if (!collection || !item)
      return reply.code(400).send({ error: 'collection and item are required' })
    if (/^(nivaro|directus)_/i.test(collection))
      return reply.code(400).send({ error: 'Not for system collections' })
    // The requester must be able to open the record (readOne answers null when they cannot).
    try {
      if (!(await readOne(req.user!, collection, item, req.workspaceId ?? undefined, ['id'])))
        return reply.code(404).send({ error: 'Record not found' })
    } catch {
      return reply.code(404).send({ error: 'Record not found' })
    }
    const category = await ensureCategory()
    if (!category.is_active)
      return reply.code(403).send({ error: 'Form change requests are turned off' })

    // The form they were looking at, when it is one of this collection's.
    let layout: { id: number; name: string } | null = null
    if (b.layout_id != null && /^\d{1,10}$/.test(String(b.layout_id))) {
      const l = (await db('nivaro_collection_layouts')
        .where({ id: Number(b.layout_id), collection })
        .first('id', 'name')) as { id: number; name: string } | undefined
      if (l) layout = { id: Number(l.id), name: String(l.name) }
    }
    let field: { name: string; label: string } | null = null
    if (typeof b.field === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(b.field)) {
      const f = (await db('nivaro_fields')
        .where({ collection, field: b.field })
        .first('field')
        .catch(() => undefined)) as { field: string } | undefined
      const label =
        typeof b.field_label === 'string'
          ? b.field_label.replace(/\s+/g, ' ').trim().slice(0, 120)
          : ''
      if (f) field = { name: f.field, label: label || titled(f.field) }
    }

    const s = await raiseTicket(app, req, {
      title: formChangeTitle(message),
      description: `${message}${formChangeTrailer(layout, field)}`,
      collection,
      item,
      category,
      priority: 'normal',
      attachments: [],
      replay: null
    })
    return reply.code(201).send({ data: { id: s.id, title: s.title } })
  })

  // GET /layout-change-requests?collection=&status=open|all — the editor's queue (admins).
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { collection?: string; status?: string }
    if (!q.collection) return reply.code(400).send({ error: 'collection is required' })
    const category = await findCategory().catch(() => undefined)
    if (!category) return reply.send({ data: [] })
    let query = db('nivaro_tasks as t')
      .leftJoin('nivaro_users as r', 't.created_by', 'r.id')
      .where({ 't.kind': SUPPORT_KIND, 't.category_id': category.id, 't.collection': q.collection })
      .orderBy('t.created_at', 'desc')
      .limit(200)
      .select(
        't.id',
        't.title',
        't.description',
        't.status',
        't.item',
        't.created_at',
        't.completed_at',
        'r.first_name as r_first',
        'r.last_name as r_last'
      )
    if (q.status !== 'all') query = query.whereIn('t.status', ['open', 'in_progress'])
    const rows = (await query) as Array<Record<string, unknown>>
    const labels = new Map<string, string>()
    await Promise.all(
      [...new Set(rows.map((r) => String(r.item)))].map(async (i) => {
        labels.set(i, await resolveFriendlyId(q.collection!, i).catch(() => i))
      })
    )
    return reply.send({
      data: rows.map((r) => {
        const parsed = parseFormChange(r.description as string | null)
        return {
          id: Number(r.id),
          title: String(r.title ?? ''),
          message: parsed.message,
          layout_id: parsed.layout_id,
          layout_name: parsed.layout_name,
          field: parsed.field,
          field_label: parsed.field_label,
          status: String(r.status),
          item: String(r.item),
          record_label: labels.get(String(r.item)) ?? String(r.item),
          requester_name: userName({
            first_name: r.r_first as string | null,
            last_name: r.r_last as string | null
          }),
          created_at: r.created_at,
          completed_at: r.completed_at
        }
      })
    })
  })

  // POST /layout-change-requests/:id/resolve { decision: 'accept' | 'decline', note? }
  // Closes the request (Done / Cancelled) with the note as a reply, and tells the requester.
  app.post('/:id/resolve', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { decision?: unknown; note?: unknown }
    if (b.decision !== 'accept' && b.decision !== 'decline')
      return reply.code(400).send({ error: "decision must be 'accept' or 'decline'" })
    const category = await findCategory()
    const t = (await db('nivaro_tasks')
      .where({ id: Number(id), kind: SUPPORT_KIND })
      .first()) as (TicketRow & Record<string, unknown>) | undefined
    if (!t || !category || Number(t.category_id) !== Number(category.id))
      return reply.code(404).send({ error: 'Not found' })
    const accepted = b.decision === 'accept'
    const status = accepted ? 'done' : 'cancelled'
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 4000) : ''
    const now = new Date()
    const patch: Record<string, unknown> = { status, completed_at: now, updated_at: now }
    const { taskColumns } = await import('../services/tasks.js')
    if ((await taskColumns()).completedBy) patch.completed_by = accepted ? req.user!.id : null
    await db('nivaro_tasks').where({ id: t.id }).update(patch)
    if (note) {
      const { randomUUID } = await import('node:crypto')
      await db('nivaro_comments').insert({
        id: randomUUID(),
        collection: 'nivaro_tasks',
        item: String(t.id),
        user: req.user!.id,
        text: note,
        created_at: now,
        updated_at: now
      })
    }
    await logTicketEvent(
      t.id,
      req.user!.id,
      accepted ? 'Form change accepted' : 'Form change declined',
      req
    )
    const me = (await nameOf(req.user!.id)) ?? 'An administrator'
    await notifyTicket(app, t, [t.created_by], {
      subject: `${accepted ? 'Accepted' : 'Declined'}: ${t.title}`,
      message: `${me} ${accepted ? 'accepted' : 'declined'} your form change suggestion.${note ? `\n\n${note.slice(0, 400)}` : ''}`,
      actorId: req.user!.id,
      category: 'workflow'
    })
    return reply.send({ data: { id: t.id, status } })
  })
}

const titled = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
