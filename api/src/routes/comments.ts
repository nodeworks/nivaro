import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { emitNotification } from '../plugins/socketio.js'
import { logActivity } from '../services/activity.js'
import { sendTeamsNotification } from '../services/microsoft.js'
import { can } from '../services/permissions.js'

/** How a child row identifies itself, for "which forecast was this about". */
const CHILD_LABEL_FIELDS = ['year', 'name', 'title', 'label', 'period', 'month', 'key', 'code']

function childRowLabel(row: Record<string, unknown>): string | null {
  for (const f of CHILD_LABEL_FIELDS) {
    const v = row[f]
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      const text = String(v).trim()
      return text.length > 40 ? `${text.slice(0, 40)}…` : text
    }
  }
  return row.id != null ? `#${row.id}` : null
}

/** The columns a revision actually changed — "february, total" says more about
 *  a forecast edit than the row's name does. */
function changedFieldNames(delta: unknown): string | null {
  let parsed: unknown = delta
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed as Record<string, unknown>).filter((k) => !k.startsWith('_'))
  if (keys.length === 0) return null
  const shown = keys.slice(0, 4).map((k) => k.replace(/_/g, ' '))
  return keys.length > 4 ? `${shown.join(', ')} +${keys.length - 4} more` : shown.join(', ')
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
})

/** What the amendment proposed, in money terms. */
function amountChange(previous: unknown, next: unknown, impact: unknown): string | null {
  const p = Number(previous)
  const n = Number(next)
  if (Number.isFinite(p) && Number.isFinite(n) && p !== n) {
    const diff = n - p
    return `${usd.format(p)} → ${usd.format(n)} (${diff >= 0 ? '+' : '−'}${usd.format(Math.abs(diff))})`
  }
  const i = Number(impact)
  if (Number.isFinite(i) && i !== 0) return `${i >= 0 ? '+' : '−'}${usd.format(Math.abs(i))}`
  return null
}


/**
 * Comment strings written by MACHINERY, not people: the legacy import stamped
 * every row it carried across, the reforecast proc marks its own writes, and
 * the forecast-revision converter tags absorbed rows. They are provenance, and
 * putting them in a notes thread buries the handful of real notes under
 * hundreds of identical markers.
 */
const MACHINE_COMMENT_EXACT = new Set(['legacy-import', 'reforecast', 'legacy-state-sync'])
const MACHINE_COMMENT_PREFIXES = ['forecast-import:', 'invoice-decision:']

function isHumanNote(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim()
  if (t === '') return false
  if (MACHINE_COMMENT_EXACT.has(t.toLowerCase())) return false
  return !MACHINE_COMMENT_PREFIXES.some((p) => t.toLowerCase().startsWith(p))
}


/** Addendum reasons are rich text; the thread shows plain prose. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}


// ─── Types ──────────────────────────────────────────────────────────────────

interface CommentRow {
  id: string
  collection: string
  item: string
  user: string
  text: string
  created_at: Date
  updated_at: Date
}

interface MentionUserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

const MENTION_RE = /(@[a-zA-Z0-9._-]+)/g

// Resolve @mentions in text to nivaro_users by email prefix or first_name match.
async function resolveMentions(text: string): Promise<MentionUserRow[]> {
  const matches = text.match(MENTION_RE)
  if (!matches || matches.length === 0) return []

  const handles = Array.from(new Set(matches.map((m) => m.slice(1).toLowerCase())))
  const found = new Map<string, MentionUserRow>()

  for (const handle of handles) {
    const users = (await db('nivaro_users')
      .where('status', 'active')
      .andWhere((qb) => {
        qb.whereRaw('LOWER(email) LIKE ?', [`${handle}@%`]).orWhereRaw('LOWER(first_name) = ?', [
          handle
        ])
      })
      .select('id', 'first_name', 'last_name', 'email')) as MentionUserRow[]
    for (const u of users) found.set(u.id, u)
  }

  return Array.from(found.values())
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function commentsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // List comments for a record
  app.get<{ Querystring: { collection?: string; item?: string } }>('/', async (req, reply) => {
    const { collection, item } = req.query
    if (!collection || !item) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }

    // Gate on read permission for the parent collection.
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const comments = (await db('nivaro_comments as c')
      .leftJoin('nivaro_users as u', 'c.user', 'u.id')
      .where({ 'c.collection': collection, 'c.item': item })
      .orderBy('c.created_at', 'asc')
      .select(
        'c.id',
        'c.collection',
        'c.item',
        'c.user',
        'c.text',
        'c.created_at',
        'c.updated_at',
        'u.first_name',
        'u.last_name',
        'u.email'
      )) as Array<
      CommentRow & {
        first_name: string | null
        last_name: string | null
        email: string | null
      }
    >

    const ids = comments.map((c) => c.id)
    const mentions = ids.length
      ? ((await db('nivaro_comment_mentions as m')
          .leftJoin('nivaro_users as u', 'm.user', 'u.id')
          .whereIn('m.comment', ids)
          .select(
            'm.id',
            'm.comment',
            'm.user',
            'u.first_name',
            'u.last_name',
            'u.email'
          )) as Array<{
          id: number
          comment: string
          user: string
          first_name: string | null
          last_name: string | null
          email: string | null
        }>)
      : []

    const mentionsByComment = new Map<string, typeof mentions>()
    for (const m of mentions) {
      const arr = mentionsByComment.get(m.comment) ?? []
      arr.push(m)
      mentionsByComment.set(m.comment, arr)
    }

    const data = comments.map((c) => ({
      id: c.id,
      collection: c.collection,
      item: c.item,
      user: c.user
        ? {
            id: c.user,
            first_name: c.first_name,
            last_name: c.last_name,
            email: c.email
          }
        : null,
      text: c.text,
      created_at: c.created_at,
      updated_at: c.updated_at,
      mentions: (mentionsByComment.get(c.id) ?? []).map((m) => ({
        id: m.user,
        first_name: m.first_name,
        last_name: m.last_name,
        email: m.email
      }))
    }))

    return { data }
  })

  // Create comment
  /**
   * Read-only note-like entries from elsewhere on the record, so the notes
   * thread shows everything anyone wrote about this item in one place rather
   * than scattering it across the pipeline panel, the addendum list and the
   * change history.
   *
   * Three sources, all things a PERSON typed:
   *  - the comment on a workflow transition
   *  - a change reason (migration 189) on this record or on a child row that
   *    requires one — a forecast's justification belongs on the workflow it
   *    is forecasting, not only on the forecast row
   *  - the reason written on an addendum
   *
   * Never editable: these belong to the thing that recorded them. Gated on
   * read permission for the parent collection, same as the comments list.
   */
  app.get<{ Querystring: { collection?: string; item?: string } }>(
    '/related',
    async (req, reply) => {
      const { collection, item } = req.query
      if (!collection || !item) {
        return reply.code(400).send({ error: 'collection and item are required' })
      }
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const CAP = 200
      type Entry = {
        id: string
        source: 'transition' | 'change_reason' | 'addendum' | 'note'
        label: string
        text: string
        user: string | null
        created_at: string | Date
        context: string | null
      }

      const instances = (await db('nivaro_workflow_instances')
        .where({ collection, item: String(item) })
        .select('id')) as Array<{ id: string }>

      const [transitions, ownReasons, addendums] = await Promise.all([
        instances.length
          ? (db('nivaro_workflow_history as h')
              .leftJoin('nivaro_workflow_states as fs', 'h.from_state', 'fs.id')
              .leftJoin('nivaro_workflow_states as ts', 'h.to_state', 'ts.id')
              .whereIn('h.instance', instances.map((i) => i.id))
              .whereNotNull('h.comment')
              .orderBy('h.timestamp', 'desc')
              .limit(CAP)
              .select('h.id', 'h.user', 'h.timestamp', 'h.comment', 'fs.label as from_label', 'ts.label as to_label')
              .catch(() => []) as Promise<Array<Record<string, unknown>>>)
          : Promise.resolve([]),
        db('nivaro_activity')
          .where({ collection, item: String(item) })
          .whereNotNull('comment')
          .orderBy('timestamp', 'desc')
          .limit(CAP)
          .select('id', 'user', 'timestamp', 'comment', 'action')
          .catch(() => []) as Promise<Array<Record<string, unknown>>>,
        // `description` IS the addendum's reason text — there is no `reason`
        // column; rejection_reason is a different thing entirely.
        db('nivaro_addendums')
          .where({ parent_collection: collection, parent_id: String(item) })
          .whereNotNull('description')
          .orderBy('created_at', 'desc')
          .limit(CAP)
          .select(
            'id',
            'title',
            'description',
            'status',
            'created_by',
            'created_at',
            'cost_impact',
            'previous_amount',
            'new_amount'
          )
          .catch(() => [] as Array<Record<string, unknown>>) as Promise<
          Array<Record<string, unknown>>
        >
      ])

      // What the record's own reasoned changes actually touched.
      const ownChanged = new Map<string, string>()
      if (ownReasons.length > 0) {
        const revs = (await db('nivaro_revisions')
          .whereIn(
            'activity',
            ownReasons.map((a) => a.id as number)
          )
          .select('activity', 'delta')
          .catch(() => [])) as Array<Record<string, unknown>>
        for (const rev of revs) {
          const fields = changedFieldNames(rev.delta)
          if (fields) ownChanged.set(String(rev.activity), fields)
        }
      }

      // Change reasons written on CHILD rows (a forecast's justification, say).
      // Only collections that actually require a reason are considered, so this
      // is a couple of cheap queries rather than a sweep of every relation.
      const childReasons: Array<Record<string, unknown>> = []
      try {
        const reasonCollections = (await db('nivaro_collections')
          .whereNotNull('change_reason_config')
          .select('collection')) as Array<{ collection: string }>
        for (const rc of reasonCollections) {
          if (rc.collection === collection) continue
          const rels = (await db('nivaro_relations')
            .where({ many_collection: rc.collection, one_collection: collection })
            .select('many_field')) as Array<{ many_field: string }>
          if (rels.length === 0) continue
          const childRows = (await db(rc.collection)
            .where((qb) => {
              for (const r of rels) void qb.orWhere(r.many_field, item)
            })
            .limit(1000)
            .select('*')) as Array<Record<string, unknown>>
          if (childRows.length === 0) continue
          // "Forecasts" alone does not say WHICH forecast — carry whatever the
          // row identifies itself by so a reader can place the note.
          const labelByChildId = new Map(
            childRows.map((r) => [String(r.id), childRowLabel(r)])
          )
          const rows = (await db('nivaro_activity')
            .where({ collection: rc.collection })
            .whereIn('item', [...labelByChildId.keys()])
            .whereNotNull('comment')
            .orderBy('timestamp', 'desc')
            .limit(CAP)
            .select('id', 'user', 'timestamp', 'comment', 'item')) as Array<Record<string, unknown>>
          // What actually changed, from the revision delta written alongside.
          const changedByActivity = new Map<string, string>()
          if (rows.length > 0) {
            const revs = (await db('nivaro_revisions')
              .whereIn(
                'activity',
                rows.map((r) => r.id as number)
              )
              .select('activity', 'delta')
              .catch(() => [])) as Array<Record<string, unknown>>
            for (const rev of revs) {
              const fields = changedFieldNames(rev.delta)
              if (fields) changedByActivity.set(String(rev.activity), fields)
            }
          }
          for (const r of rows) {
            childReasons.push({
              ...r,
              child: rc.collection,
              child_label: labelByChildId.get(String(r.item)) ?? null,
              changed: changedByActivity.get(String(r.id)) ?? null
            })
          }
        }
      } catch {
        // A missing child table or relation must not take down the thread.
      }

      // Note tables. Some deployments keep human notes as their own child
      // collection rather than in nivaro_comments — those are notes about this
      // record by any reasonable definition, and a thread that ignored them
      // showed nothing while the record plainly had commentary on it.
      // Recognised by CONVENTION, not by a hardcoded name: a child collection
      // called notes/comments (singular or plural) carrying a text column.
      const noteRows: Array<Record<string, unknown>> = []
      try {
        const rels = (await db('nivaro_relations')
          .where({ one_collection: collection })
          .whereNotNull('many_collection')
          .select('many_collection', 'many_field')) as Array<{
          many_collection: string
          many_field: string
        }>
        const noteRels = rels.filter(
          (r) => /(^|_)(notes?|comments?)$/i.test(r.many_collection) && !!r.many_field
        )
        for (const rel of noteRels) {
          const cols = (await db('information_schema.columns')
            .where({ table_name: rel.many_collection })
            .select('column_name')) as Array<{ column_name: string }>
          const names = new Set(cols.map((c) => String(c.column_name).toLowerCase()))
          const textCol = ['text', 'note', 'notes', 'comment', 'body', 'message'].find((c) =>
            names.has(c)
          )
          if (!textCol) continue
          const userCol = ['creator', 'user_created', 'created_by', 'user'].find((c) =>
            names.has(c)
          )
          const dateCol = ['created', 'date_created', 'created_at', 'timestamp'].find((c) =>
            names.has(c)
          )
          const rows = (await db(rel.many_collection)
            .where(rel.many_field, item)
            .orderBy(dateCol ?? 'id', 'desc')
            .limit(CAP)
            .select('*')) as Array<Record<string, unknown>>
          for (const r of rows) {
            const text = r[textCol]
            if (text === null || text === undefined || String(text).trim() === '') continue
            noteRows.push({
              id: `note:${rel.many_collection}:${String(r.id)}`,
              text: String(text),
              user: userCol ? (r[userCol] ?? null) : null,
              created_at: dateCol ? r[dateCol] : null,
              // A note stamped with the state it was written in says more than
              // "Note" alone.
              context: r.type ? titleCase(String(r.type)) : null
            })
          }
        }
      } catch {
        // Same posture as the rest of this route: a missing table or column
        // must never take the whole thread down.
      }

      const entries: Entry[] = [
        ...transitions.map((h) => ({
          id: `transition:${h.id}`,
          source: 'transition' as const,
          label: 'State change',
          text: String(h.comment ?? ''),
          user: (h.user as string) ?? null,
          created_at: h.timestamp as string,
          context: [h.from_label, h.to_label].filter(Boolean).join(' → ') || null
        })),
        // A transition writes its own activity row ("A → B via Approve"); the
        // transition entry above already says that, better.
        ...ownReasons
          .filter((a) => !String(a.action ?? '').toLowerCase().includes('transition'))
          .map((a) => ({
          id: `reason:${a.id}`,
          source: 'change_reason' as const,
          label: 'Change reason',
          text: String(a.comment ?? ''),
          user: (a.user as string) ?? null,
          created_at: a.timestamp as string,
          context: ownChanged.get(String(a.id)) ?? null
        })),
        ...childReasons.map((a) => ({
          id: `reason:${a.child}:${a.id}`,
          source: 'change_reason' as const,
          label: 'Change reason',
          text: String(a.comment ?? ''),
          user: (a.user as string) ?? null,
          created_at: a.timestamp as string,
          context: [titleCase(String(a.child)), a.child_label, a.changed]
            .filter(Boolean)
            .join(' · ')
        })),
        ...addendums.map((ad) => ({
          id: `addendum:${ad.id}`,
          source: 'addendum' as const,
          label: 'Addendum',
          text: stripHtml(String(ad.description ?? '')),
          user: (ad.created_by as string) ?? null,
          created_at: ad.created_at as string,
          context:
            [
              String(ad.title ?? '').trim() === stripHtml(String(ad.description ?? '')).trim()
                ? null
                : ad.title,
              ad.status,
              amountChange(ad.previous_amount, ad.new_amount, ad.cost_impact)
            ]
              .filter(Boolean)
              .join(' · ') || null
        })),
        ...noteRows.map((n) => ({
          id: String(n.id),
          source: 'note' as const,
          label: 'Note',
          // These are stored as rich text; the thread renders plain text.
          text: stripHtml(String(n.text ?? '')),
          user: (n.user as string) ?? null,
          created_at: (n.created_at as string) ?? new Date(0).toISOString(),
          context: (n.context as string) ?? null
        }))
      ].filter((e) => isHumanNote(e.text))

      // Saving a child with a reason can also stamp the parent with the same
      // text (an edit that changed nothing on the parent row still records the
      // reason). That leaves the same sentence twice — once saying what it was
      // about and once saying nothing. Keep the one that carries context.
      const contextfulKeys = new Set(
        entries
          .filter((e) => !!e.context)
          .map((e) => `${e.user ?? ''}|${e.text.trim()}|${new Date(e.created_at).toISOString().slice(0, 16)}`)
      )
      const deduped = entries.filter(
        (e) =>
          !!e.context ||
          !contextfulKeys.has(
            `${e.user ?? ''}|${e.text.trim()}|${new Date(e.created_at).toISOString().slice(0, 16)}`
          )
      )

      const userIds = [...new Set(deduped.map((e) => e.user).filter((u): u is string => !!u))]
      const users = userIds.length
        ? ((await db('nivaro_users')
            .whereIn('id', userIds)
            .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>)
        : []
      const byUser = new Map(users.map((u) => [String(u.id).toUpperCase(), u]))

      deduped.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

      return reply.send({
        data: deduped.map((e) => {
          const u = e.user ? byUser.get(e.user.toUpperCase()) : null
          return {
            ...e,
            user_name: u
              ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? '')
              : null
          }
        })
      })
    }
  )

  app.post<{ Body: { collection: string; item: string; text: string } }>(
    '/',
    async (req, reply) => {
      const body = req.body
      if (!body?.collection || !body?.item || !body?.text) {
        return reply.code(400).send({ error: 'collection, item and text are required' })
      }

      // Gate on create permission for the parent collection.
      if (!req.isAdmin && !(await can(req.user!, 'create', body.collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const userId = req.user!.id
      const id = randomUUID()
      const now = new Date()

      await db('nivaro_comments').insert({
        id,
        collection: body.collection,
        item: body.item,
        user: userId,
        text: body.text,
        created_at: now,
        updated_at: now
      })

      // Resolve and persist mentions.
      const mentioned = await resolveMentions(body.text)
      for (const u of mentioned) {
        await db('nivaro_comment_mentions').insert({ comment: id, user: u.id })

        // Don't notify yourself.
        if (u.id === userId) continue

        const message = body.text.slice(0, 100)
        const [notif] = await db('nivaro_notifications')
          .insert({
            recipient: u.id,
            subject: 'You were mentioned',
            status: 'inbox',
            timestamp: now,
            sender: userId,
            message,
            collection: body.collection,
            item: body.item
          })
          .returning('*')

        if (app.io) {
          emitNotification(app.io, u.id, {
            id: notif && typeof notif === 'object' ? (notif as { id: number }).id : null,
            subject: 'You were mentioned',
            message,
            collection: body.collection,
            item: body.item,
            sender: userId,
            timestamp: now
          })
        }

        sendTeamsNotification({ title: 'You were mentioned', text: message }).catch(() => {})
      }

      // Real-time broadcast to viewers of this record.
      if (app.io) {
        const room = `collection:${body.collection}:${body.item}`
        app.io.to(room).emit('comment:created', {
          id,
          collection: body.collection,
          item: body.item,
          user: userId,
          text: body.text,
          created_at: now
        })
      }

      const row = (await db('nivaro_comments').where({ id }).first()) as CommentRow
      await logActivity({
        action: 'create',
        collection: 'nivaro_comments',
        item: id,
        user: userId,
        req,
        comment: body.collection + ':' + body.item
      })
      return reply.code(201).send({
        data: {
          ...row,
          mentions: mentioned.map((u) => ({
            id: u.id,
            first_name: u.first_name,
            last_name: u.last_name,
            email: u.email
          }))
        }
      })
    }
  )

  // Edit own comment (or admin)
  app.patch<{ Params: { id: string }; Body: { text: string } }>('/:id', async (req, reply) => {
    const { id } = req.params
    const existing = (await db('nivaro_comments').where({ id }).first()) as CommentRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.user !== req.user!.id && !req.isAdmin) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const text = req.body?.text
    if (!text) return reply.code(400).send({ error: 'text is required' })

    await db('nivaro_comments').where({ id }).update({ text, updated_at: new Date() })
    const row = (await db('nivaro_comments').where({ id }).first()) as CommentRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_comments',
      item: id,
      user: req.user?.id,
      req
    })
    return { data: row }
  })

  // Delete own comment (or admin)
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { id } = req.params
    const existing = (await db('nivaro_comments').where({ id }).first()) as CommentRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.user !== req.user!.id && !req.isAdmin) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_comments').where({ id }).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_comments',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })
}
