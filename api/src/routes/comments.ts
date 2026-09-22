import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { emitNotification } from '../plugins/socketio.js'
import { logActivity } from '../services/activity.js'
import { ensureAutoWatch } from '../services/auto-watch.js'
import { sendTeamsNotification } from '../services/microsoft.js'
import { notifyUser } from '../services/notification-channels.js'
import { renderNotificationTemplate } from '../services/notification-templates.js'
import { can } from '../services/permissions.js'
import { resolveStateOwners } from '../services/pipeline-engine.js'
import { loadRecordNotes } from '../services/record-notes.js'

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

/** "@owners" in a comment fans out to whoever CURRENTLY resolves as the
 *  record's pipeline owners — the author doesn't have to know their names. */
const OWNERS_MENTION_RE = /(^|\s)@owners\b/i

async function resolveOwnerMentions(collection: string, item: string): Promise<MentionUserRow[]> {
  const instance = (await db('nivaro_workflow_instances')
    .where({ collection, item: String(item) })
    .whereNull('completed_at')
    .orderBy('started_at', 'desc')
    .first('id', 'current_state')) as { id: string; current_state: string } | undefined
  if (!instance?.current_state) return []
  const owners = await resolveStateOwners(
    instance.current_state,
    instance.id,
    collection,
    String(item)
  )
  return owners.map((o) => ({
    id: o.id,
    first_name: o.first_name,
    last_name: o.last_name,
    email: o.email
  }))
}

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

    // Role mentions (#441): "@finance-approvers" (role name, spaces as
    // hyphens) fans the mention to every ACTIVE member of that role. The
    // client autocomplete inserts this form; a handle matching both a person
    // and a role notifies both — mentioning is deliberately generous.
    if (users.length === 0 || handle.includes('-')) {
      // User-group mentions (#682): the handle's hyphenated form IS a group
      // slug ("@field-techs"). Groups are tried FIRST — a group is more
      // specific than a role name — and only a miss falls through to roles.
      let groupMatched = false
      const group = (await db('nivaro_user_groups')
        .whereRaw('LOWER(slug) = ?', [handle])
        .first('id')
        .catch(() => undefined)) as { id: number } | undefined
      if (group) {
        const groupMembers = (await db('nivaro_user_group_members as m')
          .join('nivaro_users as u', 'u.id', 'm.user')
          .where('m.group_id', group.id)
          .where('u.status', 'active')
          .where('u.is_redacted', false)
          .limit(100)
          .select('u.id', 'u.first_name', 'u.last_name', 'u.email')) as MentionUserRow[]
        for (const u of groupMembers) found.set(u.id, u)
        groupMatched = true
      }

      if (!groupMatched) {
        const roleName = handle.replace(/-/g, ' ')
        const role = (await db('nivaro_roles')
          .whereRaw('LOWER(name) = ?', [roleName])
          .first('id')) as { id: string } | undefined
        if (role) {
          const members = (await db('nivaro_users')
            .where({ role: role.id, status: 'active' })
            .where('is_redacted', false)
            .limit(100)
            .select('id', 'first_name', 'last_name', 'email')) as MentionUserRow[]
          for (const u of members) found.set(u.id, u)
        }
      }
    }
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

    // Reactions, aggregated per comment: [{emoji, count, mine}].
    const reactionRows = ids.length
      ? ((await db('nivaro_comment_reactions')
          .whereIn('comment', ids)
          .select('comment', 'user', 'emoji')
          .catch(() => [])) as Array<{ comment: string; user: string; emoji: string }>)
      : []
    const reactionsByComment = new Map<
      string,
      Array<{ emoji: string; count: number; mine: boolean }>
    >()
    for (const r of reactionRows) {
      const list = reactionsByComment.get(r.comment) ?? []
      let agg = list.find((a) => a.emoji === r.emoji)
      if (!agg) {
        agg = { emoji: r.emoji, count: 0, mine: false }
        list.push(agg)
      }
      agg.count++
      if (String(r.user).toUpperCase() === String(req.user!.id).toUpperCase()) agg.mine = true
      reactionsByComment.set(r.comment, list)
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
      })),
      reactions: reactionsByComment.get(c.id) ?? []
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

      return reply.send({ data: await loadRecordNotes(collection, String(item), req.user!.id) })
    }
  )

  /** Per-row comment counts for a grid's badge column — one call per grid. */
  app.get<{ Querystring: { collection?: string; ids?: string } }>('/counts', async (req, reply) => {
    const { collection } = req.query
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 500)
    if (!collection || ids.length === 0) {
      return reply.code(400).send({ error: 'collection and ids are required' })
    }
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const rows = (await db('nivaro_comments')
      .where({ collection })
      .whereIn('item', ids)
      .groupBy('item')
      .select('item')
      .count({ c: '*' })) as Array<{ item: string; c: number }>
    const data: Record<string, number> = {}
    for (const r of rows) data[String(r.item)] = Number(r.c)
    return { data }
  })

  /** Toggle a reaction (chat's fixed palette). Any reader of the collection. */
  app.post<{ Params: { id: string }; Body: { emoji?: string } }>(
    '/:id/reactions',
    async (req, reply) => {
      const REACTION_EMOJI = new Set(['👍', '✅', '👀', '🎉', '❤️', '😂'])
      const emoji = String(req.body?.emoji ?? '')
      if (!REACTION_EMOJI.has(emoji)) return reply.code(400).send({ error: 'Unknown reaction' })
      const comment = (await db('nivaro_comments')
        .where('id', req.params.id)
        .first('id', 'collection')) as { id: string; collection: string } | undefined
      if (!comment) return reply.code(404).send({ error: 'Comment not found' })
      if (!req.isAdmin && !(await can(req.user!, 'read', comment.collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const existing = await db('nivaro_comment_reactions')
        .where({ comment: comment.id, user: req.user!.id, emoji })
        .first('id')
      if (existing) {
        await db('nivaro_comment_reactions').where('id', existing.id).del()
        return { data: { reacted: false } }
      }
      await db('nivaro_comment_reactions')
        .insert({ comment: comment.id, user: req.user!.id, emoji, created_at: new Date() })
        .catch(() => {}) // unique race — a double-click is one reaction
      return { data: { reacted: true } }
    }
  )

  /** Toggle a reaction on a RECORDED note (transition comment, change
   *  reason, legacy note) — keyed by the thread entry id. */
  app.post<{ Body: { collection?: string; item?: string; entry_key?: string; emoji?: string } }>(
    '/entry-reactions',
    async (req, reply) => {
      const REACTION_EMOJI = new Set(['👍', '✅', '👀', '🎉', '❤️', '😂'])
      const { collection, item, entry_key } = req.body ?? {}
      const emoji = String(req.body?.emoji ?? '')
      if (!collection || !item || !entry_key) {
        return reply.code(400).send({ error: 'collection, item and entry_key are required' })
      }
      if (!REACTION_EMOJI.has(emoji)) return reply.code(400).send({ error: 'Unknown reaction' })
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const existing = await db('nivaro_entry_reactions')
        .where({ entry_key: String(entry_key).slice(0, 200), user: req.user!.id, emoji })
        .first('id')
      if (existing) {
        await db('nivaro_entry_reactions').where('id', existing.id).del()
        return { data: { reacted: false } }
      }
      await db('nivaro_entry_reactions')
        .insert({
          collection,
          item: String(item),
          entry_key: String(entry_key).slice(0, 200),
          user: req.user!.id,
          emoji,
          created_at: new Date()
        })
        .catch(() => {})
      return { data: { reacted: true } }
    }
  )

  app.post<{ Body: { collection: string; item: string; text: string } }>(
    '/',
    async (req, reply) => {
      const body = req.body
      if (!body?.collection || !body?.item || !body?.text) {
        return reply.code(400).send({ error: 'collection, item and text are required' })
      }

      // Gate on create permission for the parent collection. History
      // annotations (#372) comment ON a revision row — gated by READ access
      // to the revision's own record collection instead (you can annotate
      // history you're allowed to see).
      if (body.collection === 'nivaro_revisions') {
        const rev = (await db('nivaro_revisions')
          .where({ id: Number(body.item) })
          .first('collection')) as { collection?: string } | undefined
        if (!rev) return reply.code(404).send({ error: 'Revision not found' })
        if (!req.isAdmin && !(await can(req.user!, 'read', rev.collection ?? '')))
          return reply.code(403).send({ error: 'Forbidden' })
      } else if (!req.isAdmin && !(await can(req.user!, 'create', body.collection))) {
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
      // Auto-watch (#400): commenting subscribes the commenter when their
      // preference says so — fire-and-forget.
      void ensureAutoWatch(userId, body.collection, body.item, 'commented')
      // Live comments (#280): co-viewers' threads update the moment this
      // lands — record-room broadcast, clients invalidate the comments query.
      app.io
        ?.to(`record:${body.collection}:${body.item}`)
        .emit('record:comment', { collection: body.collection, item: body.item, user: userId })

      // Resolve and persist mentions. "@owners" expands to the record's
      // current pipeline owners (resolved server-side, so the set is always
      // the live one — never a stale name list); resolution failures degrade
      // to no extra recipients rather than blocking the comment.
      const mentioned = await resolveMentions(body.text)
      // @watchers (#374): one token notifying everyone watching the record —
      // field-watch subscribers + notification subscribers on this collection.
      if (/@\[?watchers\]?\b/i.test(body.text)) {
        try {
          const watcherRows = (await db('nivaro_field_watches as w')
            .join('nivaro_field_watch_subscribers as ws', 'ws.watch', 'w.id')
            .where('w.collection', body.collection)
            .where((q) => q.where('w.item_id', body.item).orWhereNull('w.item_id'))
            .distinct('ws.user')) as Array<{ user: string }>
          const subRows = (await db('nivaro_notification_subscriptions')
            .where({ collection: body.collection, is_active: true })
            .where((q) =>
              q
                .whereNull('filter_field')
                .orWhereNot('filter_field', 'id')
                .orWhere('filter_value', String(body.item))
            )
            .distinct('user')) as Array<{ user: string }>
          const seenW = new Set(mentioned.map((u) => u.id))
          for (const r of [...watcherRows, ...subRows]) {
            if (seenW.has(r.user)) continue
            seenW.add(r.user)
            mentioned.push({ id: r.user } as never)
          }
        } catch {
          /* watcher expansion is best-effort */
        }
      }
      if (OWNERS_MENTION_RE.test(body.text)) {
        try {
          const owners = await resolveOwnerMentions(body.collection, body.item)
          const seen = new Set(mentioned.map((u) => u.id))
          for (const o of owners) {
            if (seen.has(o.id)) continue
            seen.add(o.id)
            mentioned.push(o)
          }
        } catch {
          /* owners are extra recipients, never a reason the note fails */
        }
      }
      for (const u of mentioned) {
        await db('nivaro_comment_mentions').insert({ comment: id, user: u.id })

        // Don't notify yourself.
        if (u.id === userId) continue

        let subject = 'You were mentioned'
        let message = body.text.slice(0, 100)
        const actorName =
          [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ').trim() ||
          req.user?.email ||
          'Someone'
        // Notification templates: `notification:comment_mention` rewrites
        // the wording; the hardcoded line stays the default.
        const templated = await renderNotificationTemplate('comment_mention', {
          actor: actorName,
          collection: body.collection,
          record: body.item,
          text: body.text.slice(0, 300)
        }).catch(() => null)
        if (templated) {
          subject = templated.subject
          message = templated.message || message
        }
        // A mention is addressed to the person — it always lands (no record
        // mute / presence suppression), and the row offers an inline reply
        // straight back onto the record's thread.
        await notifyUser(app, u.id, {
          subject,
          message,
          sender: userId,
          collection: body.collection,
          item: body.item,
          category: 'mentions',
          always_inbox: true,
          target: { kind: 'record', collection: body.collection, id: body.item, action: 'reply' }
        }).catch(() => undefined)

        sendTeamsNotification({ title: subject, text: message }).catch(() => {})
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
