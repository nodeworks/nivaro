import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { emitNotification } from '../plugins/socketio.js'
import { logActivity } from '../services/activity.js'
import { ensureAutoWatch } from '../services/auto-watch.js'
import { findRecordInstance } from '../services/branch-instances.js'
import {
  cleanCommentField,
  fieldCommentGate,
  fieldCommentQuery,
  fieldMayBeCommented,
  hasFieldCommentColumns,
  plainFieldLabel
} from '../services/field-comments.js'
import { agentBadgesForComments } from '../services/mcp-attribution.js'
import { mentionReceipts, receiptKey } from '../services/mention-receipts.js'
import { sendTeamsNotification } from '../services/microsoft.js'
import { notifyUser } from '../services/notification-channels.js'
import { renderNotificationTemplate } from '../services/notification-templates.js'
import { can } from '../services/permissions.js'
import { resolveStateOwners } from '../services/pipeline-engine.js'
import { recordDisplayRef } from '../services/record-display-ref.js'
import { announceRecordAspect } from '../services/record-events.js'
import { loadRecordNotes } from '../services/record-notes.js'
import { canSeeRecordRoom, visibleRecordIds } from '../services/socket-access.js'
import { tenantScopedRoom } from '../services/tenant-rooms.js'
import type { User } from '../types.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface CommentRow {
  id: string
  collection: string
  item: string
  user: string
  text: string
  created_at: Date
  updated_at: Date
  deleted_at?: Date | null
  deleted_by?: string | null
  /** #3232 (migration 521): the field the comment was left on; null = the whole record. */
  field?: string | null
  resolved_at?: Date | null
  resolved_by?: string | null
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
  // The record's own instance (never a parallel-branch child), open only.
  const instance = await findRecordInstance<{
    id: string
    collection: string
    item: string
    template: string
    current_state: string | null
    completed_at: Date | null
  }>(collection, item)
  if (!instance?.current_state || instance.completed_at) return []
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

/**
 * May the caller open the record a comment thread hangs on? The record read
 * gate (role read, row filter, User Scopes — canSeeRecordRoom), not just the
 * collection: comments, notes and reactions on a record the caller cannot
 * open answer 404 like the record does. A history annotation (#372) hangs on
 * a revision row — judged by the revision's own record.
 */
async function recordVisible(
  req: FastifyRequest,
  collection: string,
  item: string | number | null | undefined
): Promise<boolean> {
  if (req.isAdmin) return true
  if (item == null || item === '') return false
  if (collection === 'nivaro_revisions') {
    const rev = (await db('nivaro_revisions')
      .where({ id: Number(item) })
      .first('collection', 'item')) as { collection?: string; item?: string | number } | undefined
    if (!rev?.collection || rev.item == null) return false
    return canSeeRecordRoom(req.user!, rev.collection, String(rev.item), false)
  }
  return canSeeRecordRoom(req.user!, collection, String(item), false)
}

/**
 * Of the people a field comment mentions, those who may open the record and read the
 * field: the field-watch gate (subscribersWhoMayRead), judged as each recipient.
 * Lower-cased ids.
 */
async function fieldCommentListeners(
  ids: string[],
  collection: string,
  item: string,
  field: string
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  try {
    const users = (await db('nivaro_users')
      .whereIn('id', [...new Set(ids)])
      .select('id', 'email', 'first_name', 'last_name', 'role', 'status')) as User[]
    const { subscribersWhoMayRead } = await import('../hooks/field-watches.js')
    const ok = await subscribersWhoMayRead(users, collection, item, field)
    return new Set(ok.map((u) => String(u.id).toLowerCase()))
  } catch {
    return new Set()
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/** The 400 body when `text` links a file the writer cannot open (new links only). */
async function fileIdsRefused(
  req: import('fastify').FastifyRequest,
  text: unknown,
  previous?: unknown
): Promise<{ error: string; code: string; field: string } | null> {
  const { assertFileIdsReadable } = await import('../services/file-access.js')
  try {
    await assertFileIdsReadable('text', text, req, previous)
    return null
  } catch (err) {
    const e = err as Error & { code?: string; statusCode?: number }
    if (e.statusCode !== 400) throw err
    return { error: e.message, code: String(e.code), field: 'text' }
  }
}

export async function commentsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // List comments for a record
  app.get<{ Querystring: { collection?: string; item?: string } }>('/', async (req, reply) => {
    const { collection, item } = req.query
    if (!collection || !item) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }

    if (!(await recordVisible(req, collection, item))) {
      return reply.code(404).send({ error: 'Not found' })
    }

    const fieldCols = await hasFieldCommentColumns()
    const allComments = (await db('nivaro_comments as c')
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
        'c.deleted_at',
        'c.deleted_by',
        ...(fieldCols ? ['c.field', 'c.resolved_at'] : []),
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
    // A field comment shows only to people who may read that field (#3232).
    const mayReadField = fieldCols
      ? await fieldCommentGate(req.user!, !!req.isAdmin, collection)
      : () => true
    const comments = allComments.filter((c) => mayReadField(c.field))

    // Edit history: how many earlier versions each comment has (edited = at least one).
    const ids0 = comments.map((c) => c.id)
    const versionCounts = new Map<string, number>()
    if (ids0.length) {
      const vc = (await db('nivaro_comment_versions')
        .whereIn('comment', ids0)
        .groupBy('comment')
        .select('comment')
        .count({ n: '*' })) as Array<{ comment: string; n: number | string }>
      for (const r of vc) versionCounts.set(String(r.comment).toLowerCase(), Number(r.n))
    }
    const deleterIds = [...new Set(comments.map((c) => c.deleted_by).filter(Boolean))] as string[]
    const deleterNames = new Map<string, string>()
    if (deleterIds.length) {
      const du = (await db('nivaro_users')
        .whereIn('id', deleterIds)
        .select('id', 'first_name', 'last_name', 'email')) as MentionUserRow[]
      for (const d of du) {
        deleterNames.set(
          String(d.id).toLowerCase(),
          [d.first_name, d.last_name].filter(Boolean).join(' ').trim() || d.email
        )
      }
    }

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

    // Read receipts (#2117): who has opened the record or read the mention since it was
    // written. Only for a reader who can open this very record (row filter and scopes too).
    const receipts =
      mentions.length > 0 && (await canSeeRecordRoom(req.user!, collection, item, !!req.isAdmin))
        ? await mentionReceipts(
            collection,
            item,
            mentions.map((m) => ({
              comment: m.comment,
              user: m.user,
              at: comments.find((c) => c.id === m.comment)?.created_at ?? new Date()
            }))
          )
        : new Map<string, string>()

    // #3213: comments an agent posted through MCP carry its badge ("via Claude").
    const agentBadges = await agentBadgesForComments(ids).catch(() => new Map<string, string>())

    const data = comments.map((c) => ({
      id: c.id,
      collection: c.collection,
      item: c.item,
      via_agent: agentBadges.get(String(c.id).toLowerCase()) ?? null,
      user: c.user
        ? {
            id: c.user,
            first_name: c.first_name,
            last_name: c.last_name,
            email: c.email
          }
        : null,
      text: c.deleted_at ? '' : c.text,
      created_at: c.created_at,
      updated_at: c.updated_at,
      edited: !c.deleted_at && (versionCounts.get(String(c.id).toLowerCase()) ?? 0) > 0,
      version_count: versionCounts.get(String(c.id).toLowerCase()) ?? 0,
      deleted: !!c.deleted_at,
      deleted_by_name: c.deleted_at
        ? (deleterNames.get(String(c.deleted_by).toLowerCase()) ?? null)
        : null,
      mentions: (mentionsByComment.get(c.id) ?? []).map((m) => ({
        id: m.user,
        first_name: m.first_name,
        last_name: m.last_name,
        email: m.email,
        seen_at: receipts.get(receiptKey(c.id, m.user)) ?? null
      })),
      reactions: reactionsByComment.get(c.id) ?? [],
      // #3232: a comment left on one field ("on Amount") and whether it was resolved.
      field: c.field ?? null,
      resolved_at: c.resolved_at ?? null
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
  // GET /comments/machine-markers — the comment strings machinery writes
  // (core + every extension's ctx.notes.registerMachineMarkers), so row
  // history renders them as provenance instead of quoting them as reasons
  // (#730). Strings only — nothing record-specific.
  app.get('/machine-markers', async (_req, reply) => {
    const { relatedNoteRegistry } = await import('../extensions/related-notes.js')
    return reply.send({ data: relatedNoteRegistry.describeMarkers() })
  })

  app.get<{ Querystring: { collection?: string; item?: string } }>(
    '/related',
    async (req, reply) => {
      const { collection, item } = req.query
      if (!collection || !item) {
        return reply.code(400).send({ error: 'collection and item are required' })
      }
      if (!(await recordVisible(req, collection, item))) {
        return reply.code(404).send({ error: 'Not found' })
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
    // Counts only for the rows the caller can open (row filter, User Scopes).
    const visible = req.isAdmin ? ids : await visibleRecordIds(req.user!, collection, ids, false)
    if (visible.length === 0) return { data: {} }
    const rows = (await db('nivaro_comments')
      .where({ collection })
      .whereNull('deleted_at')
      .whereIn('item', visible)
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
        .first('id', 'collection', 'item')) as
        | { id: string; collection: string; item?: string | number | null }
        | undefined
      if (!comment) return reply.code(404).send({ error: 'Comment not found' })
      if (!(await recordVisible(req, comment.collection, comment.item))) {
        return reply.code(404).send({ error: 'Comment not found' })
      }
      const existing = await db('nivaro_comment_reactions')
        .where({ comment: comment.id, user: req.user!.id, emoji })
        .first('id')
      if (existing) {
        await db('nivaro_comment_reactions').where('id', existing.id).del()
        announceRecordAspect(comment.collection, comment.item, '$comments')
        return { data: { reacted: false } }
      }
      await db('nivaro_comment_reactions')
        .insert({ comment: comment.id, user: req.user!.id, emoji, created_at: new Date() })
        .catch(() => {}) // unique race — a double-click is one reaction
      announceRecordAspect(comment.collection, comment.item, '$comments')
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
      if (!(await recordVisible(req, collection, item))) {
        return reply.code(404).send({ error: 'Not found' })
      }
      const existing = await db('nivaro_entry_reactions')
        .where({ entry_key: String(entry_key).slice(0, 200), user: req.user!.id, emoji })
        .first('id')
      if (existing) {
        await db('nivaro_entry_reactions').where('id', existing.id).del()
        announceRecordAspect(collection, item, '$comments')
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
      announceRecordAspect(collection, item, '$comments')
      return { data: { reacted: true } }
    }
  )

  app.post<{
    Body: { collection: string; item: string; text: string; field?: string; field_label?: string }
  }>('/', async (req, reply) => {
    const body = req.body
    if (!body?.collection || !body?.item || !body?.text) {
      return reply.code(400).send({ error: 'collection, item and text are required' })
    }
    // #3232: a comment on one field of the record (`field`), else on the whole record.
    const field = cleanCommentField(body.field)
    if (field === 'invalid') {
      return reply.code(400).send({ error: 'field must be a field name', code: 'BAD_FIELD' })
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
    // …and on the record itself: no comment (and no @owners / @watchers
    // fan-out naming its people) on a record the caller cannot open.
    if (!(await recordVisible(req, body.collection, body.item))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    if (field) {
      if (body.collection === 'nivaro_revisions' || !(await hasFieldCommentColumns())) {
        return reply.code(409).send({
          error: 'Comments on a single field are not available here yet',
          code: 'FIELD_COMMENTS_UNAVAILABLE'
        })
      }
      // Only a field the writer may read (and that exists): a thread never confirms a
      // field the caller cannot see.
      if (!(await fieldMayBeCommented(req.user!, !!req.isAdmin, body.collection, field))) {
        return reply.code(404).send({ error: 'Field not found', code: 'FIELD_NOT_FOUND' })
      }
    }
    // A comment may only link files its writer can open.
    const unreadable = await fileIdsRefused(req, body.text)
    if (unreadable) return reply.code(400).send(unreadable)

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
      updated_at: now,
      ...(field ? { field } : {})
    })
    // Auto-watch (#400): commenting subscribes the commenter when their
    // preference says so — fire-and-forget.
    void ensureAutoWatch(userId, body.collection, body.item, 'commented')
    // #1874: list/queue rows showing a comment count refresh it.
    announceRecordAspect(body.collection, body.item, '$comments')
    // Live comments (#280): co-viewers' threads update the moment this
    // lands — record-room broadcast, clients invalidate the comments query.
    // Cloud: the record room of this request's tenant (tenant-rooms.ts).
    app.io
      ?.to(tenantScopedRoom(`record:${body.collection}:${body.item}`))
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
    // #3232: a field comment reaches only people who may open THIS record and read the
    // field (judged as each recipient: row filter, User Scopes, field list). The mention is
    // still stored for the others; they hear nothing about a record they cannot open.
    const mayHear = field
      ? await fieldCommentListeners(
          mentioned.map((u) => u.id),
          body.collection,
          String(body.item),
          field
        )
      : null
    const fieldLabel = field ? plainFieldLabel(field, body.field_label) : null
    for (const u of mentioned) {
      await db('nivaro_comment_mentions').insert({ comment: id, user: u.id })

      // Don't notify yourself.
      if (u.id === userId) continue
      if (mayHear && !mayHear.has(String(u.id).toLowerCase())) continue

      // The record by its readable id, read as the person mentioned (#776).
      const recordRef = await recordDisplayRef(body.collection, body.item, { recipient: u.id })
      let subject = `You were mentioned on ${recordRef}`
      let message = body.text.slice(0, 100)
      const actorName =
        [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ').trim() ||
        req.user?.email ||
        'Someone'
      // Notification templates: `notification:comment_mention` rewrites
      // the wording; the hardcoded line stays the default.
      if (fieldLabel) {
        subject = `You were mentioned on ${fieldLabel} in ${recordRef}`
        message = `On ${fieldLabel}: ${body.text}`.slice(0, 100)
      }
      const templated = await renderNotificationTemplate('comment_mention', {
        actor: actorName,
        collection: body.collection,
        record: body.item,
        record_ref: recordRef,
        text: body.text.slice(0, 300),
        field: field ?? '',
        field_label: fieldLabel ?? ''
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
        // A field comment opens the record scrolled to and highlighting that field.
        target: {
          kind: 'record',
          collection: body.collection,
          id: body.item,
          action: 'reply',
          ...(field ? { query: fieldCommentQuery(field) } : {})
        }
      }).catch(() => undefined)

      sendTeamsNotification({ title: subject, text: message }).catch(() => {})
    }

    // (No comment-text broadcast here: the record room's `record:comment` above — ids only —
    // is how co-viewers learn of a new comment; they read it through the comments route.)

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
  })

  // #3232: resolve / reopen a field comment. Anyone who may comment on the record.
  app.post<{ Params: { id: string }; Body: { resolved?: boolean } }>(
    '/:id/resolve',
    async (req, reply) => {
      if (!(await hasFieldCommentColumns())) {
        return reply.code(409).send({
          error: 'Comments on a single field are not available here yet',
          code: 'FIELD_COMMENTS_UNAVAILABLE'
        })
      }
      const comment = (await db('nivaro_comments')
        .where('id', req.params.id)
        .first('id', 'collection', 'item', 'field', 'deleted_at')) as
        | Pick<CommentRow, 'id' | 'collection' | 'item' | 'field' | 'deleted_at'>
        | undefined
      if (!comment || comment.deleted_at) return reply.code(404).send({ error: 'Not found' })
      if (!(await recordVisible(req, comment.collection, comment.item))) {
        return reply.code(404).send({ error: 'Not found' })
      }
      if (!comment.field) {
        return reply.code(400).send({ error: 'Only field comments can be resolved' })
      }
      if (!req.isAdmin && !(await can(req.user!, 'create', comment.collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const resolved = req.body?.resolved !== false
      await db('nivaro_comments')
        .where('id', comment.id)
        .update(
          resolved
            ? { resolved_at: new Date(), resolved_by: req.user!.id }
            : { resolved_at: null, resolved_by: null }
        )
      announceRecordAspect(comment.collection, comment.item, '$comments')
      app.io
        ?.to(tenantScopedRoom(`record:${comment.collection}:${comment.item}`))
        .emit('record:comment', {
          collection: comment.collection,
          item: comment.item,
          user: req.user!.id
        })
      await logActivity({
        action: 'update',
        collection: 'nivaro_comments',
        item: comment.id,
        user: req.user?.id,
        req,
        comment: resolved ? 'resolved' : 'reopened'
      })
      return { data: { id: comment.id, resolved } }
    }
  )

  // Edit history: admins, the record's current pipeline owners, and the comment's author.
  app.get<{ Params: { id: string } }>('/:id/history', async (req, reply) => {
    const comment = (await db('nivaro_comments').where('id', req.params.id).first()) as
      | CommentRow
      | undefined
    if (!comment) return reply.code(404).send({ error: 'Not found' })
    if (!(await recordVisible(req, comment.collection, comment.item))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const me = String(req.user!.id).toLowerCase()
    let allowed = !!req.isAdmin || String(comment.user).toLowerCase() === me
    if (!allowed) {
      const owners = await resolveOwnerMentions(comment.collection, comment.item).catch(() => [])
      allowed = owners.some((o) => String(o.id).toLowerCase() === me)
    }
    if (!allowed) return reply.code(403).send({ error: 'Forbidden' })

    const rows = (await db('nivaro_comment_versions as v')
      .leftJoin('nivaro_users as u', 'v.user', 'u.id')
      .where('v.comment', comment.id)
      .orderBy('v.version', 'asc')
      .select(
        'v.version',
        'v.text',
        'v.user',
        'v.created_at',
        'u.first_name',
        'u.last_name',
        'u.email'
      )) as Array<{
      version: number
      text: string
      user: string | null
      created_at: Date
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    return {
      data: rows.map((r) => ({
        version: r.version,
        text: r.text,
        user: r.user,
        user_name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email || null,
        created_at: r.created_at
      }))
    }
  })

  // Edit own comment (or admin)
  app.patch<{ Params: { id: string }; Body: { text: string } }>('/:id', async (req, reply) => {
    const { id } = req.params
    const text = req.body?.text
    // New file links only for files the writer can open (checked before the
    // row lock: the check reads nivaro_comments).
    const before = (await db('nivaro_comments').where({ id }).first('text', 'user')) as
      | { text?: string; user?: string }
      | undefined
    if (before && text && (before.user === req.user!.id || req.isAdmin)) {
      const unreadable = await fileIdsRefused(req, text, before.text)
      if (unreadable) return reply.code(400).send(unreadable)
    }

    // Lock the comment row so concurrent edits/deletes serialize on it and
    // version allocation + deletion checks see committed state.
    const result = await db.transaction(async (trx) => {
      const existing = (await trx('nivaro_comments').where({ id }).forUpdate().first()) as
        | CommentRow
        | undefined
      if (!existing) return { code: 404, error: 'Not found' } as const
      if (existing.user !== req.user!.id && !req.isAdmin) {
        return { code: 403, error: 'Forbidden' } as const
      }
      if (!text) return { code: 400, error: 'text is required' } as const
      if (existing.deleted_at) return { code: 400, error: 'Comment was deleted' } as const

      const last = (await trx('nivaro_comment_versions')
        .where('comment', id)
        .max({ v: 'version' })
        .first()) as { v: number | null } | undefined
      const next = Number(last?.v ?? 0) + 1
      await trx('nivaro_comment_versions').insert({
        comment: id,
        version: next,
        text: existing.text,
        user: req.user!.id,
        created_at: new Date()
      })
      await trx('nivaro_comments').where({ id }).update({ text, updated_at: new Date() })
      return { code: 200, existing, versionCount: next } as const
    })
    if (result.code !== 200) return reply.code(result.code).send({ error: result.error })
    const { existing, versionCount } = result
    announceRecordAspect(existing.collection, existing.item, '$comments')
    const row = (await db('nivaro_comments').where({ id }).first()) as CommentRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_comments',
      item: id,
      user: req.user?.id,
      req
    })
    return { data: { ...row, edited: true, version_count: versionCount } }
  })

  // Delete own comment (or admin)
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { id } = req.params

    const result = await db.transaction(async (trx) => {
      const existing = (await trx('nivaro_comments').where({ id }).forUpdate().first()) as
        | CommentRow
        | undefined
      if (!existing) return { code: 404, error: 'Not found' } as const
      if (existing.user !== req.user!.id && !req.isAdmin) {
        return { code: 403, error: 'Forbidden' } as const
      }
      if (existing.deleted_at) return { code: 204 } as const

      const last = (await trx('nivaro_comment_versions')
        .where('comment', id)
        .max({ v: 'version' })
        .first()) as { v: number | null } | undefined
      await trx('nivaro_comment_versions').insert({
        comment: id,
        version: Number(last?.v ?? 0) + 1,
        text: existing.text,
        user: req.user!.id,
        created_at: new Date()
      })
      await trx('nivaro_comments')
        .where({ id })
        .update({ text: '', deleted_at: new Date(), deleted_by: req.user!.id })
      await trx('nivaro_comment_reactions').where('comment', id).del()
      await trx('nivaro_comment_mentions').where('comment', id).del()
      return { code: 200, existing } as const
    })
    if (result.code === 404 || result.code === 403) {
      return reply.code(result.code).send({ error: result.error })
    }
    if (result.code === 204) return reply.code(204).send()
    announceRecordAspect(result.existing.collection, result.existing.item, '$comments')
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
