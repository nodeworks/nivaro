import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { uploadFileBuffer } from '../services/files.js'
import { readOne } from '../services/items.js'
import {
  canSeeTicket,
  canWorkDesk,
  canWorkTicket,
  logTicketEvent,
  nameOf,
  notifyTicket,
  OPEN_STATUSES,
  parseAttachments,
  STATUS_LABELS,
  SUPPORT_KIND,
  supportAudience,
  TICKET_STATUSES,
  type TicketRow,
  type TicketStatus,
  teamIdsOf,
  userName,
  viewerOf
} from '../services/support-tickets.js'
import { resolveFriendlyId } from '../services/workflow-transitions.js'

/**
 * /api/support — support tickets (#999) on the Tasks system.
 *
 * Anyone signed in can raise a ticket (about a record they can read, or General
 * Support) and follow their own; administrators — and members of a team a
 * category routes to — work the desk: claim, reply, move status, reassign.
 * Every change leaves a history line and tells the other side through their
 * notification rules.
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

const PRIORITIES = ['low', 'normal', 'urgent']

interface RaiseTicketInput {
  title?: string
  description?: string | null
  category_id?: number | null
  collection?: string | null
  item?: string | number | null
  priority?: string
  attachments?: string[]
}

function serializeCategory(c: CategoryRow & Record<string, unknown>) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    collection: c.collection,
    team_id: c.team_id,
    team_name: (c.team_name as string | null) ?? null,
    default_assignee: c.default_assignee,
    default_assignee_name: userName({
      first_name: c.da_first as string | null,
      last_name: c.da_last as string | null
    }),
    is_active: !!c.is_active,
    sort: c.sort,
    legacy: c.legacy_id != null
  }
}

function ticketQuery() {
  return db('nivaro_tasks as t')
    .leftJoin('nivaro_users as a', 't.assignee', 'a.id')
    .leftJoin('nivaro_users as r', 't.created_by', 'r.id')
    .leftJoin('nivaro_task_categories as c', 't.category_id', 'c.id')
    .leftJoin('nivaro_user_groups as g', 't.team_id', 'g.id')
    .where('t.kind', SUPPORT_KIND)
    .select(
      't.*',
      'a.first_name as a_first',
      'a.last_name as a_last',
      'r.first_name as r_first',
      'r.last_name as r_last',
      'r.email as r_email',
      'c.name as category_name',
      'g.name as team_name'
    )
}

async function recordLabels(rows: TicketRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const pairs = new Map<string, { c: string; i: string }>()
  for (const r of rows) {
    if (r.collection && r.item)
      pairs.set(`${r.collection}:${r.item}`, { c: r.collection, i: r.item })
  }
  await Promise.all(
    [...pairs.entries()].map(async ([k, { c, i }]) => {
      out.set(k, await resolveFriendlyId(c, i).catch(() => i))
    })
  )
  return out
}

async function serializeTickets(rows: Array<TicketRow & Record<string, unknown>>) {
  const labels = await recordLabels(rows)
  const ids = rows.map((r) => String(r.id))
  const counts = ids.length
    ? ((await db('nivaro_comments')
        .where('collection', 'nivaro_tasks')
        .whereIn('item', ids)
        .groupBy('item')
        .select('item')
        .count('* as n')
        .catch(() => [])) as Array<{ item: string; n: number }>)
    : []
  const countOf = new Map(counts.map((c) => [String(c.item), Number(c.n)]))
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    status_label: STATUS_LABELS[r.status as TicketStatus] ?? r.status,
    priority: r.priority,
    collection: r.collection,
    item: r.item,
    record_label:
      r.collection && r.item ? (labels.get(`${r.collection}:${r.item}`) ?? r.item) : null,
    category_id: r.category_id,
    category_name: (r.category_name as string | null) ?? null,
    team_id: r.team_id,
    team_name: (r.team_name as string | null) ?? null,
    assignee: r.assignee,
    assignee_name: userName({
      first_name: r.a_first as string | null,
      last_name: r.a_last as string | null
    }),
    created_by: r.created_by,
    requester_name: userName({
      first_name: r.r_first as string | null,
      last_name: r.r_last as string | null,
      email: r.r_email as string | null
    }),
    attachments: parseAttachments(r.attachments),
    replies: countOf.get(String(r.id)) ?? 0,
    legacy: r.legacy_id != null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at
  }))
}

async function loadTicket(id: number): Promise<(TicketRow & Record<string, unknown>) | undefined> {
  if (!Number.isInteger(id) || id <= 0) return undefined
  return (await ticketQuery().where('t.id', id).first()) as
    | (TicketRow & Record<string, unknown>)
    | undefined
}

export async function supportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ── Categories (ticket types) ──────────────────────────────────────────────

  // GET /categories?collection=<c>  — the types offered for that kind of record
  //   (plus types with no collection). No collection = General Support types.
  //   ?all=1 (admins) = every category incl. inactive, for the editor.
  app.get<{ Querystring: { collection?: string; all?: string } }>(
    '/categories',
    async (req, reply) => {
      const q = db('nivaro_task_categories as c')
        .leftJoin('nivaro_user_groups as g', 'c.team_id', 'g.id')
        .leftJoin('nivaro_users as u', 'c.default_assignee', 'u.id')
        .select('c.*', 'g.name as team_name', 'u.first_name as da_first', 'u.last_name as da_last')
        .orderBy('c.sort', 'asc')
        .orderBy('c.name', 'asc')
      if (!(req.query.all === '1' && req.isAdmin)) {
        q.where('c.is_active', true)
        const col = req.query.collection
        if (col) q.where((w) => w.where('c.collection', col).orWhereNull('c.collection'))
        else q.whereNull('c.collection')
      }
      const rows = (await q) as Array<CategoryRow & Record<string, unknown>>
      return reply.send({ data: rows.map(serializeCategory) })
    }
  )

  app.post<{ Body: Partial<CategoryRow> }>(
    '/categories',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = req.body ?? {}
      const name = String(b.name ?? '').trim()
      if (!name) return reply.code(400).send({ error: 'name is required' })
      const now = new Date()
      const [row] = (await db('nivaro_task_categories')
        .insert({
          name: name.slice(0, 200),
          description: b.description ?? null,
          collection: b.collection || null,
          team_id: b.team_id ?? null,
          default_assignee: b.default_assignee || null,
          is_active: b.is_active === undefined ? true : !!b.is_active,
          sort: Number(b.sort ?? 0) || 0,
          created_at: now,
          updated_at: now
        })
        .returning('id')) as Array<{ id: number } | number>
      const id = typeof row === 'object' ? row.id : row
      await logActivity({
        action: 'create',
        user: req.user!.id,
        collection: 'nivaro_task_categories',
        item: String(id),
        comment: `Support type created: ${name}`,
        req
      })
      return reply.code(201).send({ data: { id } })
    }
  )

  app.patch<{ Params: { id: string }; Body: Partial<CategoryRow> }>(
    '/categories/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_task_categories').where({ id }).first('id')
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      const b = req.body ?? {}
      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (b.name !== undefined) {
        const name = String(b.name).trim()
        if (!name) return reply.code(400).send({ error: 'name cannot be empty' })
        patch.name = name.slice(0, 200)
      }
      if (b.description !== undefined) patch.description = b.description || null
      if (b.collection !== undefined) patch.collection = b.collection || null
      if (b.team_id !== undefined) patch.team_id = b.team_id ?? null
      if (b.default_assignee !== undefined) patch.default_assignee = b.default_assignee || null
      if (b.is_active !== undefined) patch.is_active = !!b.is_active
      if (b.sort !== undefined) patch.sort = Number(b.sort) || 0
      await db('nivaro_task_categories').where({ id }).update(patch)
      return reply.send({ data: { id } })
    }
  )

  // DELETE removes an unused type; one that tickets name is switched off instead.
  app.delete<{ Params: { id: string } }>(
    '/categories/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const used = await db('nivaro_tasks').where('category_id', id).first('id')
      if (used) {
        await db('nivaro_task_categories')
          .where({ id })
          .update({ is_active: false, updated_at: new Date() })
        return reply.send({ data: { id, deactivated: true } })
      }
      await db('nivaro_task_categories').where({ id }).delete()
      return reply.code(204).send()
    }
  )

  // ── Tickets ────────────────────────────────────────────────────────────────

  // GET /summary — counts for badges: my open requests, and (desk) unclaimed + mine.
  app.get('/summary', async (req, reply) => {
    const viewer = viewerOf(req)
    const n = (row: unknown) => Number((row as { n?: number } | undefined)?.n ?? 0)
    const mine = n(
      await db('nivaro_tasks')
        .where({ kind: SUPPORT_KIND, created_by: viewer.id })
        .whereIn('status', OPEN_STATUSES)
        .count('* as n')
        .first()
    )
    const desk = await canWorkDesk(viewer)
    let unassigned = 0
    let assigned = 0
    if (desk) {
      const teams = viewer.isAdmin ? null : await teamIdsOf(viewer.id)
      const uq = db('nivaro_tasks')
        .where('kind', SUPPORT_KIND)
        .whereNull('assignee')
        .where('status', 'open')
      if (teams) uq.whereIn('team_id', teams.length ? teams : [-1])
      unassigned = n(await uq.count('* as n').first())
      assigned = n(
        await db('nivaro_tasks')
          .where({ kind: SUPPORT_KIND, assignee: viewer.id })
          .whereIn('status', OPEN_STATUSES)
          .count('* as n')
          .first()
      )
    }
    return reply.send({ data: { mine_open: mine, desk, unassigned, assigned_to_me: assigned } })
  })

  // GET /tickets?scope=mine|desk&status=open|closed|all|<status>&category=&assignee=me|unassigned&q=&page=&limit=
  app.get<{
    Querystring: {
      scope?: string
      status?: string
      category?: string
      assignee?: string
      q?: string
      collection?: string
      item?: string
      page?: string
      limit?: string
    }
  }>('/tickets', async (req, reply) => {
    const viewer = viewerOf(req)
    const qs = req.query
    const limit = Math.min(Math.max(Number(qs.limit) || 50, 1), 200)
    const page = Math.max(Number(qs.page) || 1, 1)
    let q = ticketQuery()
    if (qs.scope === 'desk') {
      if (!(await canWorkDesk(viewer))) return reply.code(403).send({ error: 'Forbidden' })
      if (!viewer.isAdmin) {
        const teams = await teamIdsOf(viewer.id)
        q = q.where((w) =>
          w.whereIn('t.team_id', teams.length ? teams : [-1]).orWhere('t.assignee', viewer.id)
        )
      }
    } else if (qs.collection && qs.item) {
      // A record's tickets: requester's own, or everything for a desk worker.
      q = q.where({ 't.collection': qs.collection, 't.item': String(qs.item) })
      if (!(await canWorkDesk(viewer))) q = q.where('t.created_by', viewer.id)
    } else {
      q = q.where('t.created_by', viewer.id)
    }
    const status = qs.status ?? 'open'
    if (status === 'open') q = q.whereIn('t.status', OPEN_STATUSES)
    else if (status === 'closed') q = q.whereIn('t.status', ['done', 'cancelled'])
    else if ((TICKET_STATUSES as readonly string[]).includes(status))
      q = q.where('t.status', status)
    if (qs.category) q = q.where('t.category_id', Number(qs.category))
    if (qs.assignee === 'me') q = q.where('t.assignee', viewer.id)
    else if (qs.assignee === 'unassigned') q = q.whereNull('t.assignee')
    const search = qs.q?.trim() ?? ''
    if (search) {
      const term = `%${search.replace(/[%_[]/g, (m) => `[${m}]`)}%`
      q = q.where((w) =>
        w
          .where('t.title', 'like', term)
          .orWhere('t.description', 'like', term)
          .orWhere('t.item', 'like', term)
          .orWhereRaw('CAST(t.id AS nvarchar(20)) = ?', [search])
      )
    }
    const total = Number(
      (
        (await q.clone().clearSelect().clearOrder().count('* as n').first()) as
          | { n?: number }
          | undefined
      )?.n ?? 0
    )
    const rows = (await q
      .orderByRaw("CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END")
      .orderByRaw("CASE t.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END")
      .orderBy('t.created_at', status === 'closed' ? 'desc' : 'asc')
      .offset((page - 1) * limit)
      .limit(limit)) as Array<TicketRow & Record<string, unknown>>
    return reply.send({ data: await serializeTickets(rows), total, page, limit })
  })

  // GET /tickets/:id — the ticket, its thread and its history.
  app.get<{ Params: { id: string } }>('/tickets/:id', async (req, reply) => {
    const viewer = viewerOf(req)
    const t = await loadTicket(Number(req.params.id))
    if (!t || !(await canSeeTicket(viewer, t))) return reply.code(404).send({ error: 'Not found' })
    const [ticket] = await serializeTickets([t])
    const thread = (await db('nivaro_comments as c')
      .leftJoin('nivaro_users as u', 'c.user', 'u.id')
      .where({ 'c.collection': 'nivaro_tasks', 'c.item': String(t.id) })
      .orderBy('c.created_at', 'asc')
      .select('c.id', 'c.text', 'c.user', 'c.created_at', 'u.first_name', 'u.last_name')) as Array<
      Record<string, unknown>
    >
    const history = (await db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'a.user', 'u.id')
      .where({ 'a.collection': 'nivaro_tasks', 'a.item': String(t.id) })
      .whereNotNull('a.comment')
      .orderBy('a.timestamp', 'asc')
      .limit(200)
      .select(
        'a.id',
        'a.comment',
        'a.user',
        'a.timestamp',
        'u.first_name',
        'u.last_name'
      )) as Array<Record<string, unknown>>
    const files = ticket.attachments.length
      ? ((await db('nivaro_files')
          .whereIn('id', ticket.attachments)
          .select('id', 'title', 'filename_download', 'type', 'filesize')) as Array<
          Record<string, unknown>
        >)
      : []
    const work = await canWorkTicket(viewer, t)
    const isRequester = String(t.created_by).toUpperCase() === viewer.id
    return reply.send({
      data: {
        ...ticket,
        files,
        thread: thread.map((c) => ({
          id: c.id,
          text: c.text,
          user: c.user,
          user_name: userName(c as never),
          created_at: c.created_at,
          from_requester: String(c.user).toUpperCase() === String(t.created_by).toUpperCase()
        })),
        history: history.map((h) => ({
          id: h.id,
          text: h.comment,
          user: h.user,
          user_name: userName(h as never),
          at: h.timestamp
        })),
        can: {
          work: work,
          reply: work || isRequester,
          cancel: (work || isRequester) && OPEN_STATUSES.includes(t.status as TicketStatus),
          reopen: (work || isRequester) && !OPEN_STATUSES.includes(t.status as TicketStatus)
        }
      }
    })
  })

  // POST /tickets — raise one.
  app.post<{ Body: RaiseTicketInput }>('/tickets', async (req, reply) => {
    const out = await raiseTicket(req, req.body ?? {})
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    return reply.code(201).send({ data: out.ticket })
  })

  /**
   * Raise a ticket as the caller (POST /tickets and the portal's "Report a
   * problem"). Answers the serialized ticket, or the refusal to send.
   */
  async function raiseTicket(
    req: FastifyRequest,
    b: RaiseTicketInput,
    opts: { trustedAttachments?: string[] } = {}
  ): Promise<
    | { ticket: Awaited<ReturnType<typeof serializeTickets>>[number] }
    | { status: number; error: string }
  > {
    const title = String(b.title ?? '').trim()
    if (!title) return { status: 400, error: 'A short summary is required' }
    const collection = b.collection ? String(b.collection) : null
    const item = b.item != null && b.item !== '' ? String(b.item) : null
    if ((collection && !item) || (!collection && item)) {
      return { status: 400, error: 'collection and item go together' }
    }
    if (collection && item) {
      if (/^(nivaro|directus)_/i.test(collection)) {
        return { status: 400, error: 'Tickets cannot target system collections' }
      }
      // The requester must be able to open the record they are asking about.
      try {
        // readOne answers NULL (no throw) for a row the caller cannot see.
        if (!(await readOne(req.user!, collection, item, req.workspaceId ?? undefined, ['id']))) {
          return { status: 404, error: 'Record not found' }
        }
      } catch {
        return { status: 404, error: 'Record not found' }
      }
    }
    let category: CategoryRow | undefined
    if (b.category_id != null) {
      category = (await db('nivaro_task_categories')
        .where({ id: Number(b.category_id), is_active: true })
        .first()) as CategoryRow | undefined
      if (!category) return { status: 400, error: 'Unknown support type' }
      if (category.collection && category.collection !== collection) {
        return { status: 400, error: 'That type is only for a different kind of record' }
      }
    }
    const priority = b.priority && PRIORITIES.includes(b.priority) ? b.priority : 'normal'
    const attachments = Array.isArray(b.attachments)
      ? b.attachments
          .map(String)
          .filter((s) => /^[0-9a-f-]{32,36}$/i.test(s))
          .slice(0, 20)
      : []
    // Only files the requester uploaded ride along (the admin will open them).
    let ownFiles = attachments
    if (attachments.length && !req.isAdmin) {
      const rows = (await db('nivaro_files')
        .whereIn('id', attachments)
        .where('uploaded_by', req.user!.id)
        .select('id')) as Array<{ id: string }>
      const ok = new Set(rows.map((r) => String(r.id).toLowerCase()))
      ownFiles = attachments.filter((a) => ok.has(a.toLowerCase()))
    }
    // Files the server itself stored for this caller (a problem report's
    // screenshot) ride along without the ownership re-check.
    if (opts.trustedAttachments?.length) ownFiles = [...ownFiles, ...opts.trustedAttachments]
    const now = new Date()
    const [row] = (await db('nivaro_tasks')
      .insert({
        kind: SUPPORT_KIND,
        collection,
        item,
        title: title.slice(0, 500),
        description: b.description ?? null,
        assignee: category?.default_assignee ?? null,
        category_id: category?.id ?? null,
        team_id: category?.team_id ?? null,
        attachments: ownFiles.length ? JSON.stringify(ownFiles) : null,
        priority,
        status: category?.default_assignee ? 'in_progress' : 'open',
        created_by: req.user!.id,
        completed_at: null,
        created_at: now,
        updated_at: now
      })
      .returning('id')) as Array<{ id: number } | number>
    const id = Number(typeof row === 'object' ? row.id : row)
    await logTicketEvent(id, req.user!.id, 'Raised the request', req, 'create')
    const t = (await loadTicket(id))!
    const [s] = await serializeTickets([t])
    const where = s.record_label ? ` on ${s.record_label}` : ' (General Support)'
    const who = s.requester_name ?? 'Someone'
    const audience = t.assignee ? [t.assignee] : await supportAudience(t.team_id)
    await notifyTicket(app, t, audience, {
      subject: `New support request: ${s.title}`,
      message: `${who} asked${where}${s.category_name ? ` · ${s.category_name}` : ''}.${
        s.description ? `\n\n${String(s.description).slice(0, 400)}` : ''
      }`,
      actorId: req.user!.id,
      category: 'system'
    })
    return { ticket: s }
  }

  /**
   * POST /problem-reports — "Report a problem" from a portal (#1390). One
   * sentence from the person plus what their browser saw: a screenshot (inputs
   * masked client-side), the replay clip of the moment when error replay or
   * full recording is on, the console tail and the route. Files an issue
   * (source client, raised by the person) AND a General Support request that
   * links to it, so the person follows it under My requests and the desk sees
   * the screenshot and replay without asking.
   */
  app.post<{
    Body: {
      description?: string
      screenshot?: string | null
      console?: string[]
      route?: string
      url?: string
      app?: string
      user_agent?: string
      viewport?: string
      recording_id?: string | null
      recording_offset_ms?: number | null
    }
  }>('/problem-reports', { bodyLimit: 4_000_000 }, async (req, reply) => {
    const b = req.body ?? {}
    const description = String(b.description ?? '').trim()
    if (!description) return reply.code(400).send({ error: 'Say what went wrong' })
    const screenshot = typeof b.screenshot === 'string' && b.screenshot ? b.screenshot : null
    if (screenshot && !/^data:image\/(png|jpeg|webp);base64,/.test(screenshot)) {
      return reply.code(400).send({ error: 'screenshot must be a data:image URI' })
    }
    if (screenshot && screenshot.length > 2_500_000) {
      return reply.code(400).send({ error: 'screenshot too large (2MB cap)' })
    }
    const userId = req.user!.id
    // The replay link is caller-supplied: only a recording that exists and
    // belongs to the reporter (same rule as POST /issues/client).
    let recordingId: string | null = null
    if (typeof b.recording_id === 'string' && /^[0-9a-f-]{36}$/i.test(b.recording_id)) {
      const rec = await db('nivaro_session_recordings')
        .where({ id: b.recording_id, user: userId })
        .first('id')
      if (rec) recordingId = b.recording_id
    }
    const recordingOffsetMs =
      recordingId && b.recording_offset_ms != null && Number.isFinite(Number(b.recording_offset_ms))
        ? Math.max(0, Math.floor(Number(b.recording_offset_ms)))
        : null
    // Control characters out (a log line must not forge new lines in details).
    const clean = (v: unknown, max: number) =>
      typeof v === 'string'
        ? Array.from(v, (c) => (c.charCodeAt(0) < 32 ? ' ' : c))
            .join('')
            .trim()
            .slice(0, max)
        : ''
    const route = clean(b.route, 300) || clean(b.url, 300) || 'unknown'
    const app = clean(b.app, 60)
    const consoleTail = Array.isArray(b.console)
      ? b.console
          .filter((l): l is string => typeof l === 'string')
          .slice(-40)
          .map((l) => l.slice(0, 300))
      : []
    const title = (description.split('\n')[0] ?? '').slice(0, 140) || 'Problem report'

    // 1. The screenshot as a file the requester owns, so the desk sees it on
    // the ticket (the issue keeps its own copy inline, like the bug reporter).
    let screenshotFileId: string | null = null
    if (screenshot) {
      try {
        const [, mimeType, data] = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(screenshot) ?? []
        if (mimeType && data) {
          const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
          const file = await uploadFileBuffer(
            req.user!,
            Buffer.from(data, 'base64'),
            `problem-report-${stamp}.${ext}`,
            mimeType
          )
          screenshotFileId = String(file.id)
        }
      } catch (err) {
        req.log.warn({ err }, 'problem report: screenshot file could not be stored')
      }
    }

    // 2. The issue.
    const now = new Date()
    const details = [
      description,
      '',
      `Route: ${route}`,
      app ? `App: ${app}` : null,
      b.user_agent ? `User agent: ${clean(b.user_agent, 300)}` : null,
      b.viewport ? `Viewport: ${clean(b.viewport, 40)}` : null,
      recordingId ? 'Replay: attached' : null,
      '',
      consoleTail.length > 0 ? `Console tail:\n${consoleTail.join('\n')}` : 'Console tail: empty'
    ]
      .filter((l) => l !== null)
      .join('\n')
    const [issueRow] = (await db('nivaro_issues')
      .insert({
        title,
        severity: 'medium',
        status: 'open',
        collection: null,
        item: null,
        assigned_to: null,
        details: details.slice(0, 8000),
        screenshot,
        source: 'client',
        raised_by: userId,
        recording_id: recordingId,
        recording_offset_ms: recordingOffsetMs,
        created_at: now,
        updated_at: now
      })
      .returning('id')) as Array<{ id: number } | number>
    const issueId = Number(typeof issueRow === 'object' ? issueRow.id : issueRow)
    await logActivity({
      action: 'create',
      user: userId,
      collection: 'nivaro_issues',
      item: String(issueId),
      comment: 'Problem report',
      req
    })

    // 3. The support request, linked to the issue.
    const out = await raiseTicket(
      req,
      {
        title,
        description: `${description}\n\nReported from ${route}${app ? ` (${app})` : ''}. Issue #${issueId} holds the screenshot, console${recordingId ? ' and replay' : ''}.`,
        priority: 'normal'
      },
      { trustedAttachments: screenshotFileId ? [screenshotFileId] : [] }
    )
    if ('error' in out) return reply.code(out.status).send({ error: out.error })
    await db('nivaro_issues')
      .where({ id: issueId })
      .update({
        details: `${details}\n\nSupport request #${out.ticket.id}`.slice(0, 8000),
        updated_at: new Date()
      })
    return reply.code(201).send({
      data: { ticket: out.ticket, issue_id: issueId, replay: recordingId != null }
    })
  })

  // POST /tickets/:id/comments — reply on the thread.
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/tickets/:id/comments',
    async (req, reply) => {
      const viewer = viewerOf(req)
      const t = await loadTicket(Number(req.params.id))
      if (!t || !(await canSeeTicket(viewer, t)))
        return reply.code(404).send({ error: 'Not found' })
      const isRequester = String(t.created_by).toUpperCase() === viewer.id
      if (!isRequester && !(await canWorkTicket(viewer, t))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const text = String(req.body?.text ?? '').trim()
      if (!text) return reply.code(400).send({ error: 'Write something first' })
      const now = new Date()
      const { randomUUID } = await import('node:crypto')
      await db('nivaro_comments').insert({
        id: randomUUID(),
        collection: 'nivaro_tasks',
        item: String(t.id),
        user: req.user!.id,
        text: text.slice(0, 8000),
        created_at: now,
        updated_at: now
      })
      await db('nivaro_tasks').where({ id: t.id }).update({ updated_at: now })
      const me = (await nameOf(req.user!.id)) ?? 'Someone'
      const recipients = isRequester
        ? t.assignee
          ? [t.assignee]
          : await supportAudience(t.team_id)
        : [t.created_by, t.assignee]
      await notifyTicket(app, t, recipients, {
        subject: `${me} replied: ${t.title}`,
        message: text.slice(0, 400),
        actorId: req.user!.id,
        category: isRequester ? 'system' : 'workflow'
      })
      return reply.code(201).send({ data: { ok: true } })
    }
  )

  // POST /tickets/:id/claim — take it: assigned to me, In progress.
  app.post<{ Params: { id: string } }>('/tickets/:id/claim', async (req, reply) => {
    const viewer = viewerOf(req)
    const t = await loadTicket(Number(req.params.id))
    if (!t || !(await canSeeTicket(viewer, t))) return reply.code(404).send({ error: 'Not found' })
    if (!(await canWorkTicket(viewer, t)) && !(await canWorkDesk(viewer))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    if (!OPEN_STATUSES.includes(t.status as TicketStatus)) {
      return reply.code(409).send({
        error: `This request is already ${STATUS_LABELS[t.status as TicketStatus] ?? t.status}`
      })
    }
    await db('nivaro_tasks')
      .where({ id: t.id })
      .update({ assignee: req.user!.id, status: 'in_progress', updated_at: new Date() })
    const me = (await nameOf(req.user!.id)) ?? 'Someone'
    await logTicketEvent(t.id, req.user!.id, `Picked up by ${me} · In progress`, req)
    const updated = (await loadTicket(t.id))!
    await notifyTicket(app, updated, [t.created_by], {
      subject: `Your request is in progress: ${t.title}`,
      message: `${me} picked it up.`,
      actorId: req.user!.id,
      category: 'workflow'
    })
    const [s] = await serializeTickets([updated])
    return reply.send({ data: s })
  })

  // PATCH /tickets/:id — status / assignee / type / priority / summary.
  // The requester may only cancel or reopen their own request.
  app.patch<{
    Params: { id: string }
    Body: {
      status?: string
      assignee?: string | null
      category_id?: number | null
      priority?: string
      title?: string
    }
  }>('/tickets/:id', async (req, reply) => {
    const viewer = viewerOf(req)
    const t = await loadTicket(Number(req.params.id))
    if (!t || !(await canSeeTicket(viewer, t))) return reply.code(404).send({ error: 'Not found' })
    const work = await canWorkTicket(viewer, t)
    const isRequester = String(t.created_by).toUpperCase() === viewer.id
    const b = req.body ?? {}
    const onlyStatus = Object.keys(b).every((k) => k === 'status')
    if (
      !work &&
      !(isRequester && onlyStatus && (b.status === 'cancelled' || b.status === 'open'))
    ) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const patch: Record<string, unknown> = { updated_at: new Date() }
    const events: string[] = []
    const me = (await nameOf(req.user!.id)) ?? 'Someone'
    if (b.status !== undefined && b.status !== t.status) {
      if (!(TICKET_STATUSES as readonly string[]).includes(b.status)) {
        return reply
          .code(400)
          .send({ error: `status must be one of ${TICKET_STATUSES.join(', ')}` })
      }
      patch.status = b.status
      patch.completed_at = b.status === 'done' || b.status === 'cancelled' ? new Date() : null
      // Who closed it (#1001), where the column exists.
      const { taskColumns } = await import('../services/tasks.js')
      if ((await taskColumns()).completedBy)
        patch.completed_by = b.status === 'done' ? viewer.id : null
      events.push(
        `${STATUS_LABELS[t.status as TicketStatus] ?? t.status} → ${STATUS_LABELS[b.status as TicketStatus]}`
      )
    }
    if (b.assignee !== undefined && (b.assignee ?? null) !== (t.assignee ?? null)) {
      if (b.assignee) {
        const u = await db('nivaro_users').where({ id: b.assignee }).first('id')
        if (!u) return reply.code(400).send({ error: 'Unknown assignee' })
      }
      patch.assignee = b.assignee || null
      events.push(
        b.assignee ? `Assigned to ${(await nameOf(b.assignee)) ?? 'someone'}` : 'Unassigned'
      )
    }
    if (b.category_id !== undefined && (b.category_id ?? null) !== (t.category_id ?? null)) {
      let label = 'no type'
      if (b.category_id != null) {
        const c = (await db('nivaro_task_categories')
          .where({ id: Number(b.category_id) })
          .first('id', 'name', 'team_id')) as
          | { id: number; name: string; team_id: number | null }
          | undefined
        if (!c) return reply.code(400).send({ error: 'Unknown support type' })
        label = c.name
        patch.team_id = c.team_id
      }
      patch.category_id = b.category_id ?? null
      events.push(`Type changed to ${label}`)
    }
    if (b.priority !== undefined && b.priority !== t.priority) {
      if (!PRIORITIES.includes(b.priority))
        return reply.code(400).send({ error: 'Unknown priority' })
      patch.priority = b.priority
      events.push(`Priority ${b.priority}`)
    }
    if (b.title !== undefined && String(b.title).trim() && b.title !== t.title) {
      patch.title = String(b.title).trim().slice(0, 500)
      events.push('Summary edited')
    }
    if (!events.length) return reply.send({ data: (await serializeTickets([t]))[0] })
    await db('nivaro_tasks').where({ id: t.id }).update(patch)
    await logTicketEvent(t.id, req.user!.id, events.join(' · '), req)
    const updated = (await loadTicket(t.id))!
    const statusMoved = patch.status !== undefined
    const recipients = [t.created_by, updated.assignee]
    if (patch.assignee && patch.assignee !== req.user!.id) recipients.push(patch.assignee as string)
    await notifyTicket(app, updated, recipients, {
      subject: statusMoved
        ? `${STATUS_LABELS[updated.status as TicketStatus]}: ${t.title}`
        : `Support request updated: ${t.title}`,
      message: `${me}: ${events.join(' · ')}`,
      actorId: req.user!.id,
      category: 'workflow'
    })
    return reply.send({ data: (await serializeTickets([updated]))[0] })
  })
}
