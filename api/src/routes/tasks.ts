import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { notifyUser } from '../services/notification-channels.js'
import { can } from '../services/permissions.js'
import {
  ACTIVE_STATUSES,
  bustDoneWhenCache,
  canReadTaskRecord,
  completeTask,
  createTask,
  describeTaskChange,
  emitTaskEvent,
  isTaskParty,
  logTaskEvent,
  namesOf,
  normalizeDoneWhen,
  notifyAssignee,
  shortDate,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskInputError,
  type TaskRow,
  taskColumns
} from '../services/tasks.js'

// urgent first in any 'what next' ordering
const PRIORITY_RANK_SQL = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END"
/** A nudge reaches the assignee at most once in this window (#1015). */
const NUDGE_WINDOW_MS = 20 * 60 * 60_000

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

function userName(row: { first_name?: string | null; last_name?: string | null } | undefined) {
  if (!row) return null
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || null
}

/** The record's human id (TP26-80366), the way people name it; General
 *  Support for a ticket with no record. */
async function withItemLabels<T extends Record<string, unknown>>(rows: T[]) {
  const byCollection = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.collection || !r.item) continue
    const c = String(r.collection)
    if (!byCollection.has(c)) byCollection.set(c, [])
    byCollection.get(c)!.push(String(r.item))
  }
  const labels = new Map<string, string>()
  if (byCollection.size) {
    const { resolveFriendlyIds } = await import('../services/workflow-transitions.js')
    await Promise.all(
      [...byCollection].map(async ([c, ids]) => {
        const m = await resolveFriendlyIds(c, ids).catch(() => new Map<string, string>())
        for (const [id, label] of m) labels.set(`${c}\u0000${id}`, label)
      })
    )
  }
  return rows.map((r) => ({
    ...r,
    item_label:
      r.collection && r.item
        ? (labels.get(`${r.collection}\u0000${r.item}`) ?? String(r.item))
        : r.kind === 'support'
          ? 'General Support'
          : null
  }))
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
    completed_by_name: userName({
      first_name: r.completer_first as string | null,
      last_name: r.completer_last as string | null
    }),
    team_name: (r.team_name as string | null) ?? null,
    assignee_first: undefined,
    assignee_last: undefined,
    creator_first: undefined,
    creator_last: undefined,
    completer_first: undefined,
    completer_last: undefined
  }))
}

/** Sync on purpose: an async function returning a knex builder would RUN it
 *  (builders are thenables). `completedBy` = migration 372 is applied. */
function baseQuery(completedBy: boolean) {
  const q = db('nivaro_tasks as t')
    .leftJoin('nivaro_users as a', 't.assignee', 'a.id')
    .leftJoin('nivaro_users as c', 't.created_by', 'c.id')
    .leftJoin('nivaro_user_groups as g', 't.team_id', 'g.id')
    .select(
      't.*',
      'a.first_name as assignee_first',
      'a.last_name as assignee_last',
      'c.first_name as creator_first',
      'c.last_name as creator_last',
      'g.name as team_name'
    )
  if (completedBy) {
    q.leftJoin('nivaro_users as d', 't.completed_by', 'd.id').select(
      'd.first_name as completer_first',
      'd.last_name as completer_last'
    )
  }
  return q
}

async function teamIdsOf(userId: string): Promise<number[]> {
  const rows = (await db('nivaro_user_group_members')
    .where('user', userId)
    .select('group_id')
    .catch(() => [])) as Array<{ group_id: number }>
  return rows.map((r) => Number(r.group_id))
}

/** May this person see the task? Admin, its assignee or requester, a member
 *  of its team, or anyone who can read the record it sits on (#1000). A
 *  support ticket is private to its own people. */
async function canSeeTask(req: FastifyRequest, t: TaskRow): Promise<boolean> {
  if (req.isAdmin) return true
  const me = req.user!.id
  if (isTaskParty(t, me)) return true
  if (t.team_id != null && (await teamIdsOf(me)).includes(Number(t.team_id))) return true
  if (t.kind === 'support') return false
  return canReadTaskRecord(req.user!, t.collection, t.item, req.workspaceId ?? undefined)
}

/** May this person change it? Admin, assignee or requester. */
function canWorkTask(req: FastifyRequest, t: TaskRow): boolean {
  return !!req.isAdmin || isTaskParty(t, req.user!.id)
}

function inputError(reply: import('fastify').FastifyReply, err: unknown) {
  if (err instanceof TaskInputError) return reply.code(400).send({ error: err.message })
  throw err
}

export async function tasksRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET / — list tasks with filters. A record's list (collection + item) is
  // gated by the record: someone who cannot read it sees only the tasks that
  // are theirs. Without a record, non-admins see their own tasks (assigned,
  // requested or their team's).
  app.get<{
    Querystring: {
      collection?: string
      item?: string
      assignee?: string
      created_by?: string
      status?: string
      priority?: string
      due?: string
      search?: string
      limit?: string
    }
  }>('/', async (req, reply) => {
    const { collection, item, assignee, status, priority, due, search } = req.query
    const me = req.user!.id
    const q = baseQuery((await taskColumns()).completedBy).orderBy('t.created_at', 'desc')
    if (collection) q.where('t.collection', collection)
    if (item) q.where('t.item', item)
    if (assignee) q.where('t.assignee', assignee === 'me' ? me : assignee)
    if (status === 'active') q.whereIn('t.status', ACTIVE_STATUSES)
    else if (status && status !== 'all') q.where('t.status', status)
    if (priority && TASK_PRIORITIES.includes(priority)) q.where('t.priority', priority)
    if (due === 'overdue')
      q.whereIn('t.status', ACTIVE_STATUSES).whereRaw(
        'CAST(t.due_date AS date) < CAST(GETUTCDATE() AS date)'
      )
    else if (due === 'today') q.whereRaw('CAST(t.due_date AS date) = CAST(GETUTCDATE() AS date)')
    else if (due === 'week')
      q.whereRaw(
        'CAST(t.due_date AS date) BETWEEN CAST(GETUTCDATE() AS date) AND CAST(DATEADD(day, 7, GETUTCDATE()) AS date)'
      )
    else if (due === 'none') q.whereNull('t.due_date')
    if (search?.trim()) {
      const like = `%${search.trim().replace(/[\\%_[]/g, (c) => `[${c}]`)}%`
      q.where((w) => w.where('t.title', 'like', like).orWhere('t.description', 'like', like))
    }
    const createdBy = req.query.created_by
    if (createdBy) q.where('t.created_by', createdBy === 'me' ? me : createdBy)

    if (!req.isAdmin) {
      const recordVisible =
        collection && item
          ? await canReadTaskRecord(req.user!, collection, item, req.workspaceId ?? undefined)
          : false
      const teams = await teamIdsOf(me)
      q.where((w) => {
        w.where('t.created_by', me).orWhere('t.assignee', me)
        if (teams.length) w.orWhereIn('t.team_id', teams)
        // Support tickets stay private to their own people, even on a record
        // the viewer can read.
        if (recordVisible) w.orWhere((x) => x.whereNull('t.kind').orWhereNot('t.kind', 'support'))
      })
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000)
    const rows = (await q.limit(limit)) as Array<TaskRow & Record<string, unknown>>
    return reply.send({ data: await withItemLabels(withNames(rows)) })
  })

  // GET /mine — open tasks for the current user, with item labels
  app.get('/mine', async (req, reply) => {
    const rows = (await baseQuery((await taskColumns()).completedBy)
      .where('t.assignee', req.user!.id)
      .whereIn('t.status', ACTIVE_STATUSES)
      .orderByRaw(PRIORITY_RANK_SQL)
      .orderBy('t.due_date', 'asc')) as Array<TaskRow & Record<string, unknown>>
    return reply.send({ data: await withItemLabels(withNames(rows)) })
  })

  // GET /team — open, unclaimed tasks waiting with one of my teams (#1014).
  app.get('/team', async (req, reply) => {
    const teams = await teamIdsOf(req.user!.id)
    if (!teams.length) return reply.send({ data: [] })
    const rows = (await baseQuery((await taskColumns()).completedBy)
      .whereIn('t.team_id', teams)
      .whereNull('t.assignee')
      .whereIn('t.status', ACTIVE_STATUSES)
      .where((w) => w.whereNull('t.kind').orWhereNot('t.kind', 'support'))
      .orderByRaw(PRIORITY_RANK_SQL)
      .orderBy('t.due_date', 'asc')
      .limit(100)) as Array<TaskRow & Record<string, unknown>>
    return reply.send({ data: await withItemLabels(withNames(rows)) })
  })

  // GET /requested?days=14 — tasks I asked other people to do (created by me,
  // assigned to someone else or to nobody yet), support requests included:
  // everything still open, plus what was finished in the last `days` days so
  // the requester sees it land.
  app.get<{ Querystring: { days?: string } }>('/requested', async (req, reply) => {
    const me = req.user!.id
    const days = Math.min(Math.max(Number(req.query.days) || 14, 0), 90)
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = (await baseQuery((await taskColumns()).completedBy)
      .where('t.created_by', me)
      .where((w) => w.whereNull('t.assignee').orWhereNot('t.assignee', me))
      .where((w) =>
        w
          .whereIn('t.status', ACTIVE_STATUSES)
          .orWhere((d) =>
            d.whereIn('t.status', ['done', 'cancelled']).where('t.completed_at', '>=', since)
          )
      )
      .orderByRaw("CASE WHEN t.status IN ('open', 'in_progress') THEN 0 ELSE 1 END")
      .orderByRaw('CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END')
      .orderBy('t.due_date', 'asc')
      .orderBy('t.completed_at', 'desc')
      .orderBy('t.created_at', 'desc')
      .limit(100)) as Array<TaskRow & Record<string, unknown>>
    return reply.send({ data: await withItemLabels(withNames(rows)) })
  })

  // GET /open-counts?ids=a,b,c — open-task counts per assignee (#410): picker
  // load hints ("Beth · 3 open") so assignment can weigh who's already loaded.
  app.get<{ Querystring: { ids?: string } }>('/open-counts', async (req, reply) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 200)
    if (ids.length === 0) return reply.send({ data: {} })
    const rows = (await db('nivaro_tasks')
      .whereIn('assignee', ids)
      .whereIn('status', ACTIVE_STATUSES)
      .groupBy('assignee')
      .select('assignee')
      .count('* as n')) as Array<{ assignee: string; n: number }>
    const out: Record<string, number> = {}
    for (const id of ids) out[id.toUpperCase()] = 0
    for (const r of rows) out[String(r.assignee).toUpperCase()] = Number(r.n)
    return reply.send({ data: out })
  })

  // GET /people?collection=&item= — who to offer first when assigning a task
  // on this record (#1005): the current state's owners, then every person a
  // user field on the record names (creator, internal contact…). Active
  // people only; machine accounts never.
  app.get<{ Querystring: { collection?: string; item?: string } }>(
    '/people',
    async (req, reply) => {
      const collection = String(req.query.collection ?? '')
      const item = String(req.query.item ?? '')
      if (!collection || !item || collection.startsWith('nivaro_')) return reply.send({ data: [] })
      if (!(await canReadTaskRecord(req.user!, collection, item, req.workspaceId ?? undefined)))
        return reply.code(404).send({ error: 'Record not found' })
      const { currentOwnerIds } = await import('../services/tasks.js')
      const reasons = new Map<string, string[]>()
      const add = (id: unknown, why: string) => {
        if (!id) return
        const k = String(id).toUpperCase()
        const list = reasons.get(k) ?? []
        if (!list.includes(why)) list.push(why)
        reasons.set(k, list)
      }
      for (const id of await currentOwnerIds(collection, item).catch(() => [])) add(id, 'Owner now')
      const rels = (await db('nivaro_relations')
        .where('many_collection', collection)
        .whereIn('one_collection', ['nivaro_users', 'directus_users'])
        .whereNull('junction_field')
        .select('many_field')
        .catch(() => [])) as Array<{ many_field: string }>
      if (rels.length) {
        const labels = new Map(
          (
            (await db('nivaro_fields')
              .where('collection', collection)
              .whereIn(
                'field',
                rels.map((r) => r.many_field)
              )
              .select('field', 'label')
              .catch(() => [])) as Array<{ field: string; label: string | null }>
          ).map((f) => [f.field, f.label])
        )
        const row = (await db(collection)
          .where('id', item)
          .first(rels.map((r) => r.many_field))
          .catch(() => undefined)) as Record<string, unknown> | undefined
        for (const r of rels) {
          const label =
            labels.get(r.many_field) ||
            (r.many_field === 'user_created' || r.many_field === 'creator'
              ? 'Creator'
              : r.many_field === 'user_updated'
                ? 'Last edited'
                : r.many_field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()))
          add(row?.[r.many_field], label)
        }
      }
      if (reasons.size === 0) return reply.send({ data: [] })
      const people = (await db('nivaro_users')
        .whereIn('id', [...reasons.keys()])
        .where('status', 'active')
        .whereNull('account_kind')
        .where((q) => q.where('is_redacted', false).orWhereNull('is_redacted'))
        .select(
          'id',
          'first_name',
          'last_name',
          'email',
          'is_out_of_office',
          'ooo_end',
          'delegate_id'
        )
        .catch(() => [])) as Array<Record<string, unknown>>
      const order = [...reasons.keys()]
      people.sort(
        (a, b) =>
          order.indexOf(String(a.id).toUpperCase()) - order.indexOf(String(b.id).toUpperCase())
      )
      return reply.send({
        data: people.map((p) => ({ ...p, reasons: reasons.get(String(p.id).toUpperCase()) ?? [] }))
      })
    }
  )

  // POST /counts {collection, ids} — open and overdue task counts per record
  // for one page of a list or queue (#1017). Support tickets are not counted:
  // they are private to their own people.
  app.post<{ Body: { collection?: string; ids?: Array<string | number> } }>(
    '/counts',
    async (req, reply) => {
      const collection = String(req.body?.collection ?? '')
      const ids = [...new Set((req.body?.ids ?? []).map(String).filter(Boolean))].slice(0, 500)
      if (!collection || ids.length === 0) return reply.send({ data: {} })
      if (collection.startsWith('nivaro_')) return reply.send({ data: {} })
      if (!(await can(req.user!, 'read', collection)))
        return reply.code(403).send({ error: 'Forbidden' })
      const rows = (await db('nivaro_tasks')
        .where('collection', collection)
        .whereIn('item', ids)
        .whereIn('status', ACTIVE_STATUSES)
        .where((w) => w.whereNull('kind').orWhereNot('kind', 'support'))
        .groupBy('item')
        .select(
          'item',
          db.raw('COUNT(*) as open_count'),
          db.raw(
            'SUM(CASE WHEN due_date IS NOT NULL AND CAST(due_date AS date) < CAST(GETUTCDATE() AS date) THEN 1 ELSE 0 END) as overdue_count'
          )
        )) as Array<{ item: string; open_count: number; overdue_count: number }>
      const out: Record<string, { open: number; overdue: number }> = {}
      for (const r of rows)
        out[String(r.item)] = { open: Number(r.open_count), overdue: Number(r.overdue_count) }
      return reply.send({ data: out })
    }
  )

  // GET /:id — single task
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const rows = (await baseQuery((await taskColumns()).completedBy).where(
      't.id',
      Number(req.params.id)
    )) as Array<TaskRow & Record<string, unknown>>
    if (!rows.length) return reply.code(404).send({ error: 'Not found' })
    if (!(await canSeeTask(req, rows[0]))) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: (await withItemLabels(withNames(rows)))[0] })
  })

  // GET /:id/history — the task's plain-language history lines.
  app.get<{ Params: { id: string } }>('/:id/history', async (req, reply) => {
    const id = Number(req.params.id)
    const t = (await db('nivaro_tasks').where({ id }).first()) as TaskRow | undefined
    if (!t || !(await canSeeTask(req, t))) return reply.code(404).send({ error: 'Not found' })
    const rows = (await db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where('a.collection', 'nivaro_tasks')
      .where('a.item', String(id))
      .orderBy('a.timestamp', 'desc')
      .limit(100)
      .select(
        'a.id',
        'a.action',
        'a.comment',
        'a.timestamp',
        'a.user',
        'u.first_name',
        'u.last_name'
      )) as Array<Record<string, unknown>>
    return reply.send({
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        text: (r.comment as string | null) ?? (r.action === 'create' ? 'Created' : 'Updated'),
        at: r.timestamp,
        user: r.user,
        user_name: userName(r as { first_name?: string; last_name?: string })
      }))
    })
  })

  // POST / — create task + notify assignee (or the team)
  app.post<{
    Body: {
      collection?: string
      item?: string
      title?: string
      description?: string | null
      assignee?: string | null
      team_id?: number | null
      due_date?: string | null
      priority?: string
      done_when?: unknown
    }
  }>('/', async (req, reply) => {
    const body = req.body ?? {}
    if (body.collection) {
      if (String(body.collection).startsWith('nivaro_'))
        return reply.code(400).send({ error: 'Tasks cannot target system collections' })
      if (!(await can(req.user!, 'read', body.collection)))
        return reply.code(403).send({ error: 'Forbidden' })
      if (
        body.item &&
        !(await canReadTaskRecord(
          req.user!,
          body.collection,
          String(body.item),
          req.workspaceId ?? undefined
        ))
      )
        return reply.code(404).send({ error: 'Record not found' })
    }
    try {
      const { task, delegated_from } = await createTask(app, req.user!.id, body, { req })
      if (task.done_when) bustDoneWhenCache()
      // Tell the caller the redirect happened so the UI can say so.
      return reply.code(201).send({ data: { ...task, delegated_from } })
    } catch (err) {
      return inputError(reply, err)
    }
  })

  // PATCH /:id — update (assignee, creator, or admin)
  app.patch<{
    Params: { id: string }
    Body: {
      title?: string
      description?: string | null
      assignee?: string | null
      due_date?: string | null
      status?: string
      priority?: string
      done_when?: unknown
    }
  }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_tasks').where({ id }).first()) as TaskRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (!canWorkTask(req, existing)) return reply.code(403).send({ error: 'Forbidden' })

    const body = req.body ?? {}
    if (body.status && !(TASK_STATUSES as readonly string[]).includes(body.status)) {
      return reply.code(400).send({ error: `status must be one of ${TASK_STATUSES.join(', ')}` })
    }
    const cols = await taskColumns()
    const me = req.user!.id
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.title !== undefined) {
      const title = String(body.title).trim()
      if (!title) return reply.code(400).send({ error: 'title is required' })
      patch.title = title.slice(0, 500)
    }
    if (body.description !== undefined) patch.description = body.description || null
    if (body.assignee !== undefined && !same(body.assignee, existing.assignee)) {
      if (body.assignee) {
        const assigneeUser = await db('nivaro_users').where({ id: body.assignee }).first('id')
        if (!assigneeUser) return reply.code(400).send({ error: 'Unknown assignee' })
      } else if (existing.team_id == null && existing.kind !== 'support') {
        return reply.code(400).send({ error: 'A task needs a person or a team' })
      }
      patch.assignee = body.assignee || null
      if (cols.reminders) patch.reminded_at = null
    }
    if (body.due_date !== undefined) {
      patch.due_date = body.due_date ? new Date(body.due_date) : null
      // A new due date earns a new reminder and a fresh overdue clock.
      if (cols.reminders) {
        patch.reminded_at = null
        patch.escalated_at = null
      }
    }
    if (body.priority !== undefined) {
      if (!TASK_PRIORITIES.includes(String(body.priority))) {
        return reply
          .code(400)
          .send({ error: `priority must be one of ${TASK_PRIORITIES.join(', ')}` })
      }
      patch.priority = body.priority
    }
    if (body.done_when !== undefined && cols.doneWhen) {
      try {
        patch.done_when = normalizeDoneWhen(body.done_when)
      } catch (err) {
        return inputError(reply, err)
      }
    }
    const finishing = body.status === 'done' && ACTIVE_STATUSES.includes(existing.status)
    if (body.status !== undefined && body.status !== existing.status) {
      patch.status = body.status
      const closed = body.status === 'done' || body.status === 'cancelled'
      patch.completed_at = closed ? new Date() : null
      if (cols.completedBy) patch.completed_by = body.status === 'done' ? me : null
      if (cols.autoClosed && !closed) patch.auto_closed = null
    }

    const sentences = await describeTaskChange(existing, patch as Partial<TaskRow>)
    await db('nivaro_tasks').where({ id }).update(patch)
    const updated = (await db('nivaro_tasks').where({ id }).first()) as TaskRow

    if (sentences.length) {
      const names = await namesOf([me])
      const finished = finishing ? [`Done by ${names.get(me.toUpperCase()) ?? 'someone'}`] : []
      await logTaskEvent(
        id,
        me,
        [...sentences.filter((s) => !(finishing && s.startsWith('Marked done'))), ...finished].join(
          ' · '
        ),
        req
      )
    }
    if (patch.done_when !== undefined) bustDoneWhenCache()

    // Re-assignment notifies the new assignee
    if (patch.assignee && !same(patch.assignee, existing.assignee)) {
      await notifyAssignee(app, updated, me)
      emitTaskEvent(app, 'task-reassigned', updated, {
        actor: me,
        previous_assignee: existing.assignee
      })
    }
    if (finishing) emitTaskEvent(app, 'task-completed', updated, { actor: me })

    return reply.send({ data: updated })
  })

  // POST /:id/complete — mark done
  app.post<{ Params: { id: string } }>('/:id/complete', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_tasks').where({ id }).first()) as TaskRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (!canWorkTask(req, existing)) return reply.code(403).send({ error: 'Forbidden' })
    if (!ACTIVE_STATUSES.includes(existing.status)) {
      return reply.code(409).send({ error: `Task is already ${existing.status}` })
    }
    const updated = await completeTask(app, existing, req.user!.id, { req })
    return reply.send({ data: updated })
  })

  // POST /:id/claim — a team member takes an unclaimed team task (#1014).
  app.post<{ Params: { id: string } }>('/:id/claim', async (req, reply) => {
    const id = Number(req.params.id)
    const t = (await db('nivaro_tasks').where({ id }).first()) as TaskRow | undefined
    if (!t) return reply.code(404).send({ error: 'Not found' })
    const me = req.user!.id
    if (t.team_id == null) return reply.code(400).send({ error: 'Not a team task' })
    if (!req.isAdmin && !(await teamIdsOf(me)).includes(Number(t.team_id)))
      return reply.code(403).send({ error: 'Only members of the team can pick this up' })
    if (!ACTIVE_STATUSES.includes(t.status))
      return reply.code(409).send({ error: `Task is already ${t.status}` })
    // Conditional write: two people clicking at once — one wins.
    const n = await db('nivaro_tasks')
      .where({ id })
      .whereNull('assignee')
      .update({ assignee: me, updated_at: new Date() })
    if (!n) return reply.code(409).send({ error: 'Someone else picked it up first' })
    const names = await namesOf([me])
    await logTaskEvent(id, me, `Picked up by ${names.get(me.toUpperCase()) ?? 'someone'}`, req)
    const updated = (await db('nivaro_tasks').where({ id }).first()) as TaskRow
    emitTaskEvent(app, 'task-reassigned', updated, { actor: me, previous_assignee: null })
    return reply.send({ data: updated })
  })

  // POST /:id/nudge — the requester chases the assignee (#1015), at most
  // once per 20 hours.
  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/:id/nudge',
    async (req, reply) => {
      const id = Number(req.params.id)
      const t = (await db('nivaro_tasks').where({ id }).first()) as
        | (TaskRow & { nudged_at?: Date | string | null })
        | undefined
      if (!t) return reply.code(404).send({ error: 'Not found' })
      const me = req.user!.id
      // The requester, an admin, or the assignee's manager (#1035).
      if (!req.isAdmin && !same(t.created_by, me)) {
        const { isManagerOf } = await import('../services/team.js')
        const manages = !!t.assignee && (await isManagerOf(me, String(t.assignee)))
        if (!manages)
          return reply
            .code(403)
            .send({ error: 'Only the person who asked, or the assignee’s manager, can nudge' })
      }
      if (!ACTIVE_STATUSES.includes(t.status))
        return reply.code(409).send({ error: `Task is already ${t.status}` })
      const cols = await taskColumns()
      if (cols.nudged && t.nudged_at) {
        const next = new Date(t.nudged_at).getTime() + NUDGE_WINDOW_MS
        if (next > Date.now())
          return reply.code(429).send({
            error: 'Already nudged today',
            code: 'NUDGE_TOO_SOON',
            next_at: new Date(next).toISOString()
          })
      }
      const recipients: string[] = []
      if (t.assignee) recipients.push(t.assignee)
      else if (t.team_id != null) {
        const members = (await db('nivaro_user_group_members')
          .where('group_id', t.team_id)
          .select('user')) as Array<{ user: string }>
        recipients.push(...members.map((m) => m.user))
      }
      if (!recipients.length) return reply.code(409).send({ error: 'Nobody to nudge' })
      const names = await namesOf([me, t.assignee])
      const asker = names.get(me.toUpperCase()) ?? 'Someone'
      let where = ''
      if (t.collection && t.item) {
        const { resolveFriendlyId } = await import('../services/workflow-transitions.js')
        where = ` on ${await resolveFriendlyId(t.collection, t.item).catch(() => t.item)}`
      }
      const note = String(req.body?.note ?? '')
        .trim()
        .slice(0, 300)
      for (const r of recipients) {
        if (same(r, me)) continue
        await notifyUser(app, r, {
          subject: `Reminder: ${t.title}`,
          category: 'workflow',
          message: `${asker} is waiting on this task${where}${t.due_date ? ` (due ${shortDate(t.due_date)})` : ''}.${note ? ` “${note}”` : ''}`,
          collection: t.collection,
          item: t.item,
          sender: me,
          target:
            t.collection && t.item
              ? {
                  kind: 'record',
                  collection: t.collection,
                  id: t.item,
                  task_id: t.id,
                  action: 'complete'
                }
              : null,
          source: { kind: 'task', label: 'Task reminder', id: t.id },
          why: `${asker} asked for this task`
        }).catch(() => undefined)
      }
      if (cols.nudged) await db('nivaro_tasks').where({ id }).update({ nudged_at: new Date() })
      await logTaskEvent(
        id,
        me,
        `Nudged ${t.assignee ? (names.get(String(t.assignee).toUpperCase()) ?? 'the assignee') : 'the team'}${note ? ` — “${note}”` : ''}`,
        req
      )
      return reply.send({ data: { nudged: recipients.length } })
    }
  )

  // DELETE /:id — creator or admin
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_tasks').where({ id }).first()) as TaskRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (!req.isAdmin && !same(existing.created_by, req.user!.id)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_tasks').where({ id }).delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_tasks',
      item: String(id),
      comment: `Deleted “${existing.title}”`,
      req
    })

    return reply.code(204).send()
  })
}
