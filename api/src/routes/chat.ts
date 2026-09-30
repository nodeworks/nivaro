import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  type ChatChannel,
  canSeeRoom,
  channelLookPatch,
  channels,
  cleanChannelLinks,
  clearChatCaches,
  listDirectory,
  listRooms,
  parseRoom
} from '../services/chat.js'
import { botUserId, chatBotName } from '../services/chat-bot.js'
import { recordChatDelivery } from '../services/chat-health.js'
import { clearRoomTypeCache, roomForRecord, roomRecordFacts } from '../services/chat-records.js'
import {
  ChatSendError,
  chatColumns,
  loadMessage,
  parseJsonList,
  postChatMessage,
  redeemReplyToken,
  touchWatermark,
  upsertMembership
} from '../services/chat-send.js'
import { parseTimeRefs } from '../services/chat-time-refs.js'

/**
 * Chat (`/api/chat`).
 *
 * Every read and write goes through `canSeeRoom` — the client no longer reads
 * `chat_messages` directly, because a table-level policy cannot express "only
 * the rooms you belong to". Presence and typing stay on the plain items API.
 */

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const forbidden = { error: 'That conversation is not available to you' }

  // ── Rooms ─────────────────────────────────────────────────────────────────

  app.get('/rooms', async (req) => {
    const q = req.query as { archived?: string }
    return {
      data: await listRooms(req.user!, { archived: q.archived === '1' || q.archived === 'true' })
    }
  })

  app.get('/directory', async (req) => {
    const q = req.query as { search?: string }
    return { data: await listDirectory(req.user!, q.search) }
  })

  /**
   * Messages for a room. The timeline shows top-level messages only — thread
   * replies (#927) live under their root and come back with `thread=<id>`.
   * Paging: `before` / `after` an id, `around` an id (#977 — a search hit in
   * context) or `date` (#976 — jump to a day, loads the history around it).
   */
  app.get('/messages', async (req, reply) => {
    const q = req.query as {
      room?: string
      limit?: string
      before?: string
      after?: string
      around?: string
      date?: string
      thread?: string
    }
    const room = String(q.room ?? '').trim()
    if (!room) return reply.code(400).send({ error: 'room is required' })
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const cols = await chatColumns()
    const limit = Math.min(Number(q.limit ?? 200) || 200, 500)
    const thread = q.thread ? Number(q.thread) : null

    const base = () => {
      const qb = db('chat_messages').where({ room })
      if (cols.has('parent_id')) {
        if (thread) qb.andWhere((w) => w.where('parent_id', thread).orWhere('id', thread))
        else qb.whereNull('parent_id')
      }
      return qb
    }
    const selectCols = [
      'id',
      'sender',
      'sender_name',
      'room',
      'message',
      'date_created',
      'edited_at',
      'deleted_at',
      'attachments',
      ...[...cols]
    ]

    let rows: Array<Record<string, unknown>>
    let hasOlder = false
    let hasNewer = false
    let anchorId: number | null = null
    if (q.around || q.date) {
      if (q.around) anchorId = Number(q.around) || null
      else {
        const day = new Date(String(q.date))
        if (Number.isNaN(day.getTime())) return reply.code(400).send({ error: 'Invalid date' })
        const first = (await base()
          .where('date_created', '>=', day)
          .orderBy('id', 'asc')
          .first('id')) as { id?: number } | undefined
        const last = first?.id
          ? null
          : ((await base().orderBy('id', 'desc').first('id')) as { id?: number } | undefined)
        anchorId = first?.id ?? last?.id ?? null
      }
      if (!anchorId) return { data: [], meta: { has_older: false, has_newer: false, anchor: null } }
      const half = Math.max(10, Math.floor(limit / 2))
      const older = (await base()
        .where('id', '<', anchorId)
        .orderBy('id', 'desc')
        .limit(half + 1)
        .select(selectCols)) as Array<Record<string, unknown>>
      const newer = (await base()
        .where('id', '>=', anchorId)
        .orderBy('id', 'asc')
        .limit(half + 1)
        .select(selectCols)) as Array<Record<string, unknown>>
      hasOlder = older.length > half
      hasNewer = newer.length > half
      rows = [...older.slice(0, half).reverse(), ...newer.slice(0, half)]
    } else if (q.after) {
      const newer = (await base()
        .where('id', '>', Number(q.after) || 0)
        .orderBy('id', 'asc')
        .limit(limit + 1)
        .select(selectCols)) as Array<Record<string, unknown>>
      hasNewer = newer.length > limit
      rows = newer.slice(0, limit)
    } else {
      const older = (await base()
        .modify((qb) => {
          if (q.before) qb.where('id', '<', Number(q.before) || 0)
        })
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .select(selectCols)) as Array<Record<string, unknown>>
      hasOlder = older.length > limit
      rows = older.slice(0, limit).reverse()
    }

    const data = await decorateMessages(rows, cols)
    return { data, meta: { has_older: hasOlder, has_newer: hasNewer, anchor: anchorId } }
  })

  /** Reactions, masquerade names, quotes and thread summaries for a window. */
  async function decorateMessages(
    rows: Array<Record<string, unknown>>,
    cols: Set<string>
  ): Promise<Array<Record<string, unknown>>> {
    const masqAdmins = [
      ...new Set(
        rows.map((r) => (r.masquerade_admin ? String(r.masquerade_admin) : null)).filter(Boolean)
      )
    ] as string[]
    const masqNames = new Map<string, string>()
    if (masqAdmins.length) {
      const admins = (await db('nivaro_users')
        .whereIn('id', masqAdmins)
        .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
      for (const a of admins)
        masqNames.set(
          String(a.id).toUpperCase(),
          [a.first_name, a.last_name].filter(Boolean).join(' ') || String(a.email ?? '')
        )
    }

    const ids = rows.map((r) => Number(r.id))
    const reactionRows = ids.length
      ? ((await db('nivaro_chat_reactions as r')
          .leftJoin('nivaro_users as u', 'u.id', 'r.user')
          .whereIn('r.message_id', ids)
          .select('r.message_id', 'r.emoji', 'r.user', 'u.first_name', 'u.last_name')) as Array<
          Record<string, unknown>
        >)
      : []
    const reactionsByMsg = new Map<number, Array<Record<string, unknown>>>()
    for (const r of reactionRows) {
      const list = reactionsByMsg.get(Number(r.message_id)) ?? []
      list.push({
        emoji: String(r.emoji),
        user: String(r.user),
        user_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null
      })
      reactionsByMsg.set(Number(r.message_id), list)
    }

    // Quoted originals (#928), one read.
    const quoteIds = cols.has('quote_id')
      ? [...new Set(rows.map((r) => Number(r.quote_id)).filter((n) => n > 0))]
      : []
    const quotes = new Map<number, Record<string, unknown>>()
    if (quoteIds.length) {
      const qrows = (await db('chat_messages')
        .whereIn('id', quoteIds)
        .select('id', 'sender_name', 'message', 'deleted_at', 'attachments')) as Array<
        Record<string, unknown>
      >
      for (const qr of qrows)
        quotes.set(Number(qr.id), {
          id: Number(qr.id),
          sender_name: qr.sender_name ?? null,
          message: qr.deleted_at ? '' : String(qr.message ?? '').slice(0, 280),
          deleted: !!qr.deleted_at,
          has_attachments: !qr.deleted_at && parseAttachments(qr.attachments).length > 0
        })
    }

    // Thread summaries (#927) for roots in the window, one grouped read.
    const threads = new Map<number, Record<string, unknown>>()
    if (cols.has('parent_id') && ids.length) {
      const trows = (await db('chat_messages')
        .whereIn('parent_id', ids)
        .whereNull('deleted_at')
        .groupBy('parent_id')
        .select('parent_id')
        .count({ n: 'id' })
        .max({ last: 'date_created' })) as Array<Record<string, unknown>>
      if (trows.length) {
        const who = (await db('chat_messages')
          .whereIn(
            'parent_id',
            trows.map((t) => Number(t.parent_id))
          )
          .whereNull('deleted_at')
          .whereNotNull('sender')
          .select('parent_id', 'sender', 'sender_name')) as Array<Record<string, unknown>>
        const people = new Map<number, Map<string, string | null>>()
        for (const w of who) {
          const m = people.get(Number(w.parent_id)) ?? new Map()
          m.set(String(w.sender).toUpperCase(), (w.sender_name as string | null) ?? null)
          people.set(Number(w.parent_id), m)
        }
        for (const t of trows)
          threads.set(Number(t.parent_id), {
            count: Number(t.n),
            last_reply_at: t.last ? new Date(String(t.last)).toISOString() : null,
            people: [...(people.get(Number(t.parent_id)) ?? new Map()).entries()]
              .slice(0, 5)
              .map(([id, name]) => ({ id, name }))
          })
      }
    }

    return rows.map((r) => ({
      ...r,
      message: r.deleted_at ? '' : r.message,
      attachments: r.deleted_at ? [] : parseAttachments(r.attachments),
      reactions: reactionsByMsg.get(Number(r.id)) ?? [],
      parent_id: r.parent_id ? Number(r.parent_id) : null,
      quote_id: r.quote_id ? Number(r.quote_id) : null,
      quote: r.quote_id ? (quotes.get(Number(r.quote_id)) ?? null) : null,
      thread: threads.get(Number(r.id)) ?? null,
      urgent: !!r.urgent,
      is_system: !!r.is_system,
      no_preview: !!r.no_preview,
      mentions: parseJsonList(r.mentions),
      time_refs: r.deleted_at ? [] : parseJsonList(r.time_refs),
      masquerade_admin_name: r.masquerade_admin
        ? (masqNames.get(String(r.masquerade_admin).toUpperCase()) ?? 'an administrator')
        : null
    }))
  }

  app.post('/messages', async (req, reply) => {
    const b = req.body as {
      room?: string
      message?: string
      mentions?: string[]
      attachments?: string[]
      parent_id?: number | null
      quote_id?: number | null
      urgent?: boolean
      client_id?: string | null
      no_preview?: boolean
    }
    try {
      const row = await postChatMessage(
        app,
        {
          user: req.user!,
          isAdmin: !!req.isAdmin,
          masqueradeAdminId: req.masqueradeAdminId ?? null
        },
        {
          room: String(b.room ?? ''),
          message: String(b.message ?? ''),
          attachments: b.attachments,
          mentions: b.mentions,
          parentId: b.parent_id ?? null,
          quoteId: b.quote_id ?? null,
          urgent: !!b.urgent,
          clientId: b.client_id ?? null,
          noPreview: !!b.no_preview
        }
      )
      return reply.code(row.duplicate ? 200 : 201).send({ data: row })
    } catch (err) {
      if (err instanceof ChatSendError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code })
      }
      throw err
    }
  })

  /** A browser saw a message this long after it was stored (#989 sample). */
  app.post('/health/delivery', async (req) => {
    const ms = Number((req.body as { ms?: unknown })?.ms)
    if (Number.isFinite(ms)) recordChatDelivery(ms)
    return { data: { ok: true } }
  })

  /** Mark a room read up to now. */
  app.post<{ Params: { room: string } }>('/rooms/:room/read', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    await touchWatermark(String(req.user!.id), room)
    return { data: { room, read: true } }
  })

  /** Join / mute state. Joining a room you cannot see is refused rather than
   *  silently creating a membership row that never resolves. */
  app.post<{ Params: { room: string } }>('/rooms/:room/join', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    // Joining starts the read watermark NOW — a room's whole history is not
    // something the newcomer has to catch up on (General holds years of it).
    await upsertMembership(String(req.user!.id), room, { last_read_at: new Date() })
    if (room.startsWith('ch:')) {
      void logActivity({
        action: 'chat-channel-join',
        user: req.user?.id ?? null,
        collection: 'nivaro_chat_channels',
        item: room.slice(3),
        comment: `joined #${room.slice(3)}`
      })
    }
    return { data: { room, joined: true } }
  })

  app.delete<{ Params: { room: string } }>('/rooms/:room/join', async (req) => {
    const room = decodeURIComponent(req.params.room)
    await db('nivaro_chat_memberships').where({ user: req.user!.id, room }).del()
    if (room.startsWith('ch:')) {
      void logActivity({
        action: 'chat-channel-leave',
        user: req.user?.id ?? null,
        collection: 'nivaro_chat_channels',
        item: room.slice(3),
        comment: `left #${room.slice(3)}`
      })
    }
    return { data: { room, joined: false } }
  })

  app.patch<{ Params: { room: string } }>('/rooms/:room', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const b = req.body as {
      muted?: boolean
      notify_mode?: string | null
      archived?: boolean
      starred?: boolean
      welcome_seen?: boolean
    }
    const patch: {
      is_muted?: boolean
      notify_mode?: string | null
      archived_at?: Date | null
      starred?: boolean
      welcome_seen_at?: Date | null
    } = {}
    if (b.muted !== undefined) patch.is_muted = !!b.muted
    if (b.archived !== undefined) patch.archived_at = b.archived ? new Date() : null
    if (b.starred !== undefined && (await hasColumn('nivaro_chat_memberships', 'starred')))
      patch.starred = !!b.starred
    if (
      b.welcome_seen !== undefined &&
      (await hasColumn('nivaro_chat_memberships', 'welcome_seen_at'))
    )
      patch.welcome_seen_at = b.welcome_seen ? new Date() : null
    if (b.notify_mode !== undefined) {
      patch.notify_mode = b.notify_mode === 'mentions' ? 'mentions' : null
    }
    if (Object.keys(patch).length === 0) {
      return reply
        .code(400)
        .send({ error: 'muted, notify_mode, archived, starred or welcome_seen is required' })
    }
    await upsertMembership(String(req.user!.id), room, patch)
    return { data: { room, ...patch } }
  })

  /** DM read receipt: when did the other participant last read this room? */
  app.get<{ Params: { room: string } }>('/rooms/:room/peer-read', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const parsed = parseRoom(room)
    if (parsed.kind !== 'dm') return { data: { last_read_at: null } }
    const peer = (parsed.participants ?? []).find((p) => p !== String(req.user!.id).toUpperCase())
    if (!peer) return { data: { last_read_at: null } }
    const row = await db('nivaro_chat_memberships').where({ user: peer, room }).first()
    return { data: { last_read_at: row?.last_read_at ?? null } }
  })

  // ── Message actions (reactions / edit / delete) ───────────────────────────

  const REACTION_EMOJI = new Set(['👍', '✅', '👀', '🎉', '❤️', '😂'])

  /** Toggle a reaction. Same fixed palette client and server. */
  app.post<{ Params: { id: string } }>('/messages/:id/reactions', async (req, reply) => {
    const msg = await db('chat_messages').where('id', Number(req.params.id)).first()
    if (!msg) return reply.code(404).send({ error: 'Not found' })
    if (!(await canSeeRoom(req.user!, String(msg.room)))) return reply.code(403).send(forbidden)
    const emoji = String((req.body as { emoji?: string })?.emoji ?? '')
    if (!REACTION_EMOJI.has(emoji)) return reply.code(400).send({ error: 'Unknown reaction' })

    const existing = await db('nivaro_chat_reactions')
      .where({ message_id: msg.id, user: req.user!.id, emoji })
      .first()
    if (existing) {
      await db('nivaro_chat_reactions').where('id', existing.id).del()
    } else {
      await db('nivaro_chat_reactions')
        .insert({ message_id: msg.id, user: req.user!.id, emoji })
        .catch(() => {}) // UNIQUE race — the reaction exists, which is the goal
    }
    emitRoomTouch(String(msg.room))
    return { data: { toggled: emoji, on: !existing } }
  })

  /** Edit own message within the window. Mentions are NOT re-processed — an
   *  edit fixes words, it doesn't re-page people. */
  const EDIT_WINDOW_MS = 15 * 60_000
  app.patch<{ Params: { id: string } }>('/messages/:id', async (req, reply) => {
    const msg = await db('chat_messages').where('id', Number(req.params.id)).first()
    if (!msg) return reply.code(404).send({ error: 'Not found' })
    if (String(msg.sender ?? '').toUpperCase() !== String(req.user!.id).toUpperCase()) {
      return reply.code(403).send({ error: 'You can only edit your own messages' })
    }
    if (msg.deleted_at) return reply.code(400).send({ error: 'Message was deleted' })
    const body = req.body as { message?: string; no_preview?: boolean }
    // Removing (or restoring) a link preview is the sender's call at any time
    // and is not an edit of the words.
    if (body.message === undefined && body.no_preview !== undefined) {
      if (await hasColumn('chat_messages', 'no_preview')) {
        await db('chat_messages').where('id', msg.id).update({ no_preview: !!body.no_preview })
      }
      emitRoomTouch(String(msg.room))
      return { data: { id: msg.id, no_preview: !!body.no_preview } }
    }
    if (Date.now() - new Date(msg.date_created).getTime() > EDIT_WINDOW_MS) {
      return reply.code(400).send({ error: 'The edit window has passed' })
    }
    const text = String(body.message ?? '').trim()
    if (!text) return reply.code(400).send({ error: 'message is required' })
    const editPatch: Record<string, unknown> = { message: text, edited_at: new Date() }
    if (await hasColumn('chat_messages', 'time_refs')) {
      const { userTimeZone } = await import('../services/user-time.js')
      const refs = parseTimeRefs(text, await userTimeZone(req.user!), new Date(msg.date_created))
      editPatch.time_refs = refs.length ? JSON.stringify(refs) : null
    }
    await db('chat_messages').where('id', msg.id).update(editPatch)
    // The send is an accountability record (accountability='activity' on
    // chat_messages) — a rewrite of that record must be too.
    void logActivity({
      action: 'chat-message-edit',
      user: req.user?.id,
      collection: 'chat_messages',
      item: String(msg.id),
      comment: `room ${String(msg.room)}`
    })
    emitRoomTouch(String(msg.room))
    return { data: { id: msg.id, message: text } }
  })

  /** Soft delete — own message, or admin. The row survives as a tombstone so
   *  the conversation's shape (and reply context) stays honest. */
  app.delete<{ Params: { id: string } }>('/messages/:id', async (req, reply) => {
    const msg = await db('chat_messages').where('id', Number(req.params.id)).first()
    if (!msg) return reply.code(404).send({ error: 'Not found' })
    const own = String(msg.sender ?? '').toUpperCase() === String(req.user!.id).toUpperCase()
    if (!own && !req.isAdmin) {
      return reply.code(403).send({ error: 'You can only delete your own messages' })
    }
    await db('chat_messages')
      .where('id', msg.id)
      .update({ message: '', attachments: null, deleted_at: new Date() })
    await db('nivaro_chat_reactions').where({ message_id: msg.id }).del()
    // Admins may delete OTHER people's messages — the log records who did.
    void logActivity({
      action: 'chat-message-delete',
      user: req.user?.id,
      collection: 'chat_messages',
      item: String(msg.id),
      comment: `room ${String(msg.room)}${own ? '' : ` — sender ${String(msg.sender)}`}`
    })
    emitRoomTouch(String(msg.room))
    return { data: { deleted: true } }
  })

  // ── Search across my rooms ────────────────────────────────────────────────

  /** Message search over every room in MY sidebar (visibility enforced by
   *  construction — the room set comes from listRooms). Entity rooms outside
   *  the sidebar are not searchable; they have no enumerable room list. */
  app.get('/search', async (req, reply) => {
    const q = req.query as {
      q?: string
      sender?: string
      room?: string
      from?: string
      to?: string
      has_attachment?: string
      mentions_me?: string
    }
    const term = String(q.q ?? '').trim()
    const filtered =
      !!q.sender || !!q.room || !!q.from || !!q.to || !!q.has_attachment || !!q.mentions_me
    if (term.length < 2 && !filtered) return { data: [] }
    let rooms = (await listRooms(req.user!)).map((r) => r.room)
    if (q.room) rooms = rooms.includes(q.room) ? [q.room] : []
    if (rooms.length === 0) return { data: [] }
    const cols = await chatColumns()
    const me = String(req.user!.id).toUpperCase()
    const rows = await db('chat_messages')
      .whereIn('room', rooms.slice(0, 200))
      .whereNull('deleted_at')
      .modify((qb) => {
        if (term.length >= 2) {
          const like = `%${term.replace(/[\\%_[]/g, (m) => `\\${m}`)}%`
          qb.whereRaw("message LIKE ? ESCAPE '\\'", [like])
        }
        if (q.sender)
          qb.whereRaw('UPPER(CAST(sender AS NVARCHAR(36))) = ?', [String(q.sender).toUpperCase()])
        if (q.from) {
          const d = new Date(q.from)
          if (!Number.isNaN(d.getTime())) qb.where('date_created', '>=', d)
        }
        if (q.to) {
          const d = new Date(q.to)
          if (!Number.isNaN(d.getTime())) qb.where('date_created', '<=', d)
        }
        if (q.has_attachment === '1') qb.whereNotNull('attachments').whereNot('attachments', '[]')
        if (q.mentions_me === '1') {
          qb.andWhere((w) => {
            if (cols.has('mentions')) w.where('mentions', 'like', `%${me}%`)
            w.orWhere('message', 'like', '%@channel%').orWhere('message', 'like', '%@here%')
          })
        }
      })
      .orderBy('id', 'desc')
      .limit(80)
      .select(
        'id',
        'room',
        'sender',
        'sender_name',
        'message',
        'date_created',
        ...(cols.has('parent_id') ? ['parent_id'] : [])
      )
    return reply.send({ data: rows })
  })

  /**
   * Every message that names me (#943): explicit @mentions (stored ids) plus
   * @channel / @here in rooms I belong to. Unread first.
   */
  app.get('/mentions', async (req) => {
    const rooms = await listRooms(req.user!)
    if (rooms.length === 0) return { data: [] }
    const cols = await chatColumns()
    const me = String(req.user!.id).toUpperCase()
    const rows = (await db('chat_messages')
      .whereIn('room', rooms.map((r) => r.room).slice(0, 300))
      .whereNull('deleted_at')
      .whereRaw('(sender IS NULL OR UPPER(CAST(sender AS NVARCHAR(36))) <> ?)', [me])
      .andWhere((w) => {
        if (cols.has('mentions')) w.where('mentions', 'like', `%${me}%`)
        w.orWhere('message', 'like', '%@channel%').orWhere('message', 'like', '%@here%')
      })
      .orderBy('id', 'desc')
      .limit(100)
      .select(
        'id',
        'room',
        'sender',
        'sender_name',
        'message',
        'date_created',
        ...(cols.has('parent_id') ? ['parent_id'] : [])
      )) as Array<Record<string, unknown>>
    const marks = new Map(
      (
        (await db('nivaro_chat_memberships')
          .where('user', req.user!.id)
          .select('room', 'last_read_at')) as Array<{ room: string; last_read_at: Date | null }>
      ).map((m) => [m.room, m.last_read_at])
    )
    const labels = new Map(rooms.map((r) => [r.room, r.label]))
    const data: Array<Record<string, unknown> & { unread: boolean }> = rows.map((r) => {
      const read = marks.get(String(r.room))
      return {
        ...r,
        room_label: labels.get(String(r.room)) ?? null,
        unread: !read || new Date(String(r.date_created)) > new Date(read)
      }
    })
    data.sort((a, b) => Number(b.unread) - Number(a.unread) || Number(b.id) - Number(a.id))
    return { data }
  })

  /** Files and links shared in a room (#944), newest first. */
  app.get<{ Params: { room: string } }>('/rooms/:room/shared', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const rows = (await db('chat_messages')
      .where({ room })
      .whereNull('deleted_at')
      .andWhere((w) =>
        w
          .where((a) => a.whereNotNull('attachments').whereNot('attachments', '[]'))
          .orWhere('message', 'like', '%http%')
          .orWhere('message', 'like', '%/collections/%')
      )
      .orderBy('id', 'desc')
      .limit(300)
      .select('id', 'sender_name', 'message', 'attachments', 'date_created')) as Array<
      Record<string, unknown>
    >
    const files: Array<Record<string, unknown>> = []
    const links: Array<Record<string, unknown>> = []
    const URL_RE = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/gi
    for (const r of rows) {
      for (const f of parseAttachments(r.attachments))
        files.push({
          file_id: f,
          message_id: r.id,
          sender_name: r.sender_name,
          date_created: r.date_created
        })
      for (const m of String(r.message ?? '').matchAll(URL_RE))
        links.push({
          url: m[0],
          message_id: r.id,
          sender_name: r.sender_name,
          date_created: r.date_created
        })
    }
    const fileIds = [...new Set(files.map((f) => String(f.file_id)))].slice(0, 200)
    const meta = new Map<string, Record<string, unknown>>()
    if (fileIds.length) {
      const fr = (await db('nivaro_files')
        .whereIn('id', fileIds)
        .select('id', 'filename_download', 'title', 'type', 'filesize')
        .catch(() => [])) as Array<Record<string, unknown>>
      for (const f of fr) meta.set(String(f.id).toLowerCase(), f)
    }
    return {
      data: {
        files: files.slice(0, 200).map((f) => {
          const m = meta.get(String(f.file_id).toLowerCase())
          return {
            ...f,
            name: m ? String(m.title || m.filename_download || 'File') : 'File',
            type: m?.type ?? null,
            size: m?.filesize != null ? Number(m.filesize) : null
          }
        }),
        links: links.slice(0, 200)
      }
    }
  })

  // ── Pinned messages ───────────────────────────────────────────────────────

  /** Toggle a pin. Any room member may pin/unpin — a pin is shared context,
   *  not a moderation act. */
  app.post<{ Params: { id: string } }>('/messages/:id/pin', async (req, reply) => {
    const msg = await db('chat_messages').where('id', Number(req.params.id)).first()
    if (!msg || msg.deleted_at) return reply.code(404).send({ error: 'Not found' })
    if (!(await canSeeRoom(req.user!, String(msg.room)))) return reply.code(403).send(forbidden)
    const existing = await db('nivaro_chat_pins')
      .where({ room: String(msg.room), message_id: msg.id })
      .first()
    if (existing) {
      await db('nivaro_chat_pins').where('id', existing.id).del()
    } else {
      await db('nivaro_chat_pins')
        .insert({ room: String(msg.room), message_id: msg.id, pinned_by: req.user!.id })
        .catch(() => {})
    }
    emitRoomTouch(String(msg.room))
    return { data: { pinned: !existing } }
  })

  app.get<{ Params: { room: string } }>('/rooms/:room/pins', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const rows = await db('nivaro_chat_pins as p')
      .join('chat_messages as m', 'm.id', 'p.message_id')
      .where('p.room', room)
      .whereNull('m.deleted_at')
      .orderBy('p.id', 'desc')
      .limit(20)
      .select('p.id as pin_id', 'm.id', 'm.sender_name', 'm.message', 'm.date_created')
    return reply.send({ data: rows })
  })

  // ── Group DMs ─────────────────────────────────────────────────────────────

  /** Ad-hoc multi-person conversation: a private channel flagged is_direct,
   *  rendered like a DM (member names as the title). */
  // Saved messages (#148): personal cross-room bookmarks.
  app.post<{ Params: { id: string } }>('/messages/:id/save', async (req, reply) => {
    const mid = Number(req.params.id)
    const msg = (await db('chat_messages').where({ id: mid }).first('id', 'room')) as
      | { id: number; room: string }
      | undefined
    if (!msg) return reply.code(404).send({ error: 'Message not found' })
    if (!(await canSeeRoom(req.user!, msg.room))) return reply.code(403).send(forbidden)
    const existing = await db('nivaro_chat_saved')
      .where({ user: req.user!.id, message_id: mid })
      .first('id')
    if (existing) {
      await db('nivaro_chat_saved').where({ id: existing.id }).del()
      return reply.send({ data: { saved: false } })
    }
    await db('nivaro_chat_saved')
      .insert({ user: req.user!.id, message_id: mid, room: msg.room, created_at: new Date() })
      .catch(() => {})
    return reply.send({ data: { saved: true } })
  })
  app.get('/saved', async (req, reply) => {
    const rows = (await db('nivaro_chat_saved as s')
      .join('chat_messages as m', 's.message_id', 'm.id')
      .where('s.user', req.user!.id)
      .orderBy('s.id', 'desc')
      .limit(100)
      .select(
        's.id as saved_id',
        'm.id',
        'm.room',
        'm.message',
        'm.sender_name',
        'm.date_created'
      )) as Array<Record<string, unknown>>
    // Visibility can change after saving — re-check per room (cheap cache).
    const out: typeof rows = []
    const seen = new Map<string, boolean>()
    for (const r of rows) {
      const room = String(r.room)
      if (!seen.has(room)) seen.set(room, await canSeeRoom(req.user!, room))
      if (seen.get(room)) out.push(r)
    }
    return reply.send({ data: out })
  })

  // Group-chat seen-by (#147): members' read watermarks for a room — the
  // client derives "seen by N" per message from them.
  app.get<{ Params: { room: string } }>('/rooms/:room/read-marks', async (req, reply) => {
    const room = req.params.room
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const marks = (await db('nivaro_chat_memberships as ms')
      .join('nivaro_users as u', 'ms.user', 'u.id')
      .where('ms.room', room)
      .whereNotNull('ms.last_read_at')
      .select('ms.user', 'ms.last_read_at', 'u.first_name', 'u.last_name')) as Array<
      Record<string, unknown>
    >
    return reply.send({
      data: marks.map((m) => ({
        user: m.user,
        last_read_at: m.last_read_at,
        name: [m.first_name, m.last_name].filter(Boolean).join(' ')
      }))
    })
  })

  // Chat mentions on records (#132): messages naming this record's token in
  // rooms the VIEWER can see — beyond its own entity room.
  app.get<{ Params: { collection: string; item: string } }>(
    '/record-mentions/:collection/:item',
    async (req, reply) => {
      const { collection, item } = req.params
      const { can } = await import('../services/permissions.js')
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send(forbidden)
      }
      const rt = (await db('nivaro_chat_room_types')
        .where({ collection, is_active: true })
        .first('prefix', 'match_field')) as { prefix: string; match_field: string } | undefined
      if (!rt) return reply.send({ data: [] })
      let token = item
      if (rt.match_field && rt.match_field !== 'id') {
        try {
          const row = (await db(collection).where({ id: item }).first(rt.match_field)) as
            | Record<string, unknown>
            | undefined
          token = String(row?.[rt.match_field] ?? item)
        } catch {
          /* fall back to the raw id */
        }
      }
      if (!token || token.length < 4) return reply.send({ data: [] })
      const like = `%${token.replace(/[%_[]/g, (c) => `[${c}]`)}%`
      const rows = (await db('chat_messages')
        .where('message', 'like', like)
        .whereNot('room', `${rt.prefix}:${token}`)
        .whereNull('deleted_at')
        .orderBy('id', 'desc')
        .limit(30)
        .select('id', 'room', 'message', 'sender_name', 'date_created')) as Array<
        Record<string, unknown>
      >
      const out: typeof rows = []
      const seen = new Map<string, boolean>()
      for (const r of rows) {
        const room = String(r.room)
        if (!seen.has(room)) seen.set(room, await canSeeRoom(req.user!, room))
        if (seen.get(room)) out.push(r)
        if (out.length >= 15) break
      }
      return reply.send({ data: out })
    }
  )

  // Room catch-up (#346): AI summary of what happened since your watermark.
  app.post<{ Body: { room?: string; since?: string; until?: string; thread?: number } }>(
    '/rooms/summary',
    async (req, reply) => {
      const room = String(req.body?.room ?? '')
      if (!room || !(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
      const thread = req.body?.thread ? Number(req.body.thread) : null
      let since: Date
      if (req.body?.since) {
        since = new Date(req.body.since)
        if (Number.isNaN(since.getTime())) return reply.code(400).send({ error: 'Invalid date' })
      } else if (thread) {
        since = new Date(0)
      } else {
        const membership = (await db('nivaro_chat_memberships')
          .where({ user: req.user!.id, room })
          .first('last_read_at')) as { last_read_at?: Date | null } | undefined
        since = membership?.last_read_at ?? new Date(Date.now() - 7 * 86400e3)
      }
      const until = req.body?.until ? new Date(req.body.until) : null
      const hasThreads = await hasColumn('chat_messages', 'parent_id')
      const msgs = (await db('chat_messages')
        .where({ room })
        .where('date_created', '>', since)
        .modify((qb) => {
          if (until && !Number.isNaN(until.getTime())) qb.where('date_created', '<=', until)
          if (thread && hasThreads)
            qb.andWhere((w) => w.where('parent_id', thread).orWhere('id', thread))
        })
        .whereNull('deleted_at')
        .orderBy('id', 'asc')
        .limit(thread ? 200 : 160)
        .select('sender_name', 'message', 'date_created')) as Array<Record<string, unknown>>
      if (msgs.length < (thread ? 2 : 5)) {
        return reply.send({ data: { summary: null, count: msgs.length } })
      }
      const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
      const aiClient = await getAiClient()
      if (!aiClient) return reply.code(503).send({ error: 'AI is not configured' })
      // Every other AI invocation is attributed — this one was the odd one out.
      void logActivity({ action: 'ai-room-summary', user: req.user!.id, comment: room, req })
      const { model } = await getAiModelSettings()
      const transcript = msgs
        .map((m) => `${String(m.sender_name ?? 'Someone')}: ${String(m.message).slice(0, 300)}`)
        .join('\n')
        .slice(0, 14000)
      try {
        const resp = await aiClient.messages.create({
          model,
          max_tokens: 350,
          system:
            'Summarize a chat room\u2019s recent messages for someone catching up: 2-4 sentences, decisions and open questions first, names attached. No preamble.',
          messages: [{ role: 'user', content: transcript }]
        })
        const text = resp.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
          .trim()
        return reply.send({ data: { summary: text, count: msgs.length } })
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message.slice(0, 200) : 'AI call failed' })
      }
    }
  )

  app.post('/group-dm', async (req, reply) => {
    const b = req.body as { user_ids?: string[]; name?: string }
    const userIds = [...new Set((b.user_ids ?? []).map(String).filter(Boolean))].filter(
      (u) => u.toUpperCase() !== String(req.user!.id).toUpperCase()
    )
    if (userIds.length < 1) return reply.code(400).send({ error: 'Pick at least one person' })
    if (userIds.length > 20) return reply.code(400).send({ error: 'Too many people for a group' })

    const users = (await db('nivaro_users')
      .whereIn('id', userIds)
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
    if (users.length !== userIds.length) {
      return reply.code(400).send({ error: 'One of those users does not exist' })
    }
    const firstNames = [
      String(req.user?.first_name ?? '').trim() || 'Me',
      ...users.map((u) => String(u.first_name ?? '').trim() || String(u.email ?? '').split('@')[0])
    ]
    const name = String(b.name ?? '').trim() || firstNames.slice(0, 4).join(', ')
    const key = `grp-${Math.random().toString(16).slice(2, 10)}`

    await db('nivaro_chat_channels').insert({
      key,
      name: name.slice(0, 100),
      visibility: 'private',
      is_direct: true,
      created_by: req.user?.id ?? null
    })
    clearChatCaches()
    const room = `ch:${key}`
    await upsertMembership(String(req.user!.id), room, {})
    for (const u of userIds) await upsertMembership(u, room, {})
    void logActivity({
      action: 'chat-group-create',
      user: req.user?.id ?? null,
      collection: 'nivaro_chat_channels',
      item: key,
      comment: `${userIds.length + 1} members`
    })
    return reply.code(201).send({ data: { room, name } })
  })

  // ── Client config ─────────────────────────────────────────────────────────

  /** What the composer needs to know about this instance's chat. */
  app.get('/config', async () => {
    const name = await chatBotName()
    return {
      data: {
        bot_name: name,
        bot_user_id: name ? await botUserId().catch(() => null) : null
      }
    }
  })

  // ── Channels ──────────────────────────────────────────────────────────────

  app.post('/channels', async (req, reply) => {
    const b = req.body as {
      key?: string
      name?: string
      topic?: string
      visibility?: ChatChannel['visibility']
      role?: string | null
      icon?: string | null
      color?: string | null
      announce?: boolean
      description?: string | null
      links?: unknown
      welcome_note?: string | null
      default_roles?: unknown
    }
    const name = String(b.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const look = channelLookPatch(b as Record<string, unknown>)
    if ('error' in look) return reply.code(400).send({ error: look.error })
    // A database behind migration 369 has no look columns — create without them.
    const lookCols = (await hasColumn('nivaro_chat_channels', 'icon')) ? look.patch : {}
    const key =
      String(b.key ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || slugify(name)
    if (!key) return reply.code(400).send({ error: 'A channel key could not be derived' })
    if ((await channels()).has(key)) {
      return reply.code(409).send({ error: `A channel named "${key}" already exists` })
    }
    const visibility: ChatChannel['visibility'] =
      b.visibility === 'role' || b.visibility === 'private' ? b.visibility : 'open'
    if (visibility === 'role' && !b.role) {
      return reply.code(400).send({ error: 'A role-scoped channel needs a role' })
    }

    const extras = await channelExtrasPatch(b as Record<string, unknown>, !!req.isAdmin)
    if ('error' in extras) return reply.code(400).send({ error: extras.error })
    await db('nivaro_chat_channels').insert({
      key,
      name,
      topic: b.topic ?? null,
      visibility,
      role: visibility === 'role' ? b.role : null,
      created_by: req.user?.id ?? null,
      ...lookCols,
      ...extras.patch
    })
    clearChatCaches()
    // The creator is a member — otherwise a private channel would be invisible
    // to the person who just made it.
    await upsertMembership(String(req.user!.id), `ch:${key}`, {})
    await logActivity({
      action: 'chat-channel-create',
      user: req.user?.id,
      collection: 'nivaro_chat_channels',
      item: key,
      req
    })
    return reply.code(201).send({ data: (await channels()).get(key) })
  })

  app.patch<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const row = await db('nivaro_chat_channels').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    // Creator or admin — the same mutation posture queues use.
    if (!req.isAdmin && String(row.created_by ?? '') !== String(req.user?.id)) {
      return reply.code(403).send({ error: 'Only the channel owner or an admin can change it' })
    }
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const f of ['name', 'topic', 'visibility', 'role']) {
      if (b[f] !== undefined) patch[f] = b[f]
    }
    if (b.is_archived !== undefined) patch.is_archived = !!b.is_archived
    if (b.icon !== undefined || b.color !== undefined) {
      const look = channelLookPatch(b)
      if ('error' in look) return reply.code(400).send({ error: look.error })
      if (await hasColumn('nivaro_chat_channels', 'icon')) Object.assign(patch, look.patch)
    }
    const extras = await channelExtrasPatch(b, !!req.isAdmin)
    if ('error' in extras) return reply.code(400).send({ error: extras.error })
    Object.assign(patch, extras.patch)
    if (patch.visibility === 'role' && !(patch.role ?? row.role)) {
      return reply.code(400).send({ error: 'A role-scoped channel needs a role' })
    }
    if (patch.visibility && patch.visibility !== 'role') patch.role = null
    if (Object.keys(patch).length > 0) {
      await db('nivaro_chat_channels').where('id', row.id).update(patch)
      clearChatCaches()
    }
    await logActivity({
      action: 'chat-channel-update',
      user: req.user?.id,
      collection: 'nivaro_chat_channels',
      item: String(row.key),
      comment: Object.keys(patch).length
        ? `changed ${Object.keys(patch)
            .map((k) => (k === 'is_archived' ? 'archived' : k.replace(/_/g, ' ')))
            .join(', ')}`
        : undefined,
      req
    })
    return { data: (await channels()).get(String(row.key)) }
  })

  /** Members of a private channel, so an owner can see who is in it. */
  app.get<{ Params: { id: string } }>('/channels/:id/members', async (req, reply) => {
    const row = await db('nivaro_chat_channels').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!(await canSeeRoom(req.user!, `ch:${row.key}`))) return reply.code(403).send(forbidden)
    const rows = await db('nivaro_chat_memberships as m')
      .leftJoin('nivaro_users as u', 'u.id', 'm.user')
      .where('m.room', `ch:${row.key}`)
      .select('m.user', 'u.first_name', 'u.last_name', 'u.email', 'm.joined_at')
    return { data: rows }
  })

  /** Add someone to a private channel (owner/admin only). */
  app.post<{ Params: { id: string } }>('/channels/:id/members', async (req, reply) => {
    const row = await db('nivaro_chat_channels').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && String(row.created_by ?? '') !== String(req.user?.id)) {
      return reply.code(403).send({ error: 'Only the channel owner or an admin can add members' })
    }
    const b = req.body as { user_id?: string }
    if (!b.user_id) return reply.code(400).send({ error: 'user_id is required' })
    await upsertMembership(String(b.user_id), `ch:${row.key}`, {})
    void logActivity({
      action: 'chat-channel-member-add',
      user: req.user?.id ?? null,
      collection: 'nivaro_chat_channels',
      item: String(row.id),
      comment: `${b.user_id} added to #${row.key}`
    })
    return reply.code(201).send({ data: { room: `ch:${row.key}`, user: b.user_id } })
  })

  app.delete<{ Params: { id: string; userId: string } }>(
    '/channels/:id/members/:userId',
    async (req, reply) => {
      const row = await db('nivaro_chat_channels').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const self = String(req.params.userId) === String(req.user?.id)
      if (!self && !req.isAdmin && String(row.created_by ?? '') !== String(req.user?.id)) {
        return reply
          .code(403)
          .send({ error: 'Only the channel owner or an admin can remove members' })
      }
      await db('nivaro_chat_memberships')
        .where({ user: req.params.userId, room: `ch:${row.key}` })
        .del()
      void logActivity({
        action: 'chat-channel-member-remove',
        user: req.user?.id ?? null,
        collection: 'nivaro_chat_channels',
        item: String(row.id),
        comment: `${req.params.userId} removed from #${row.key}`
      })
      return { data: { removed: true } }
    }
  )

  /**
   * Roles, for the role-scoped channel picker. Id + name only, and readable by
   * any authenticated user: /api/roles is admin-only, but a non-admin creating
   * a channel has to be able to name the role it is for — and role names
   * already reach every user through presence (the Online list shows them).
   */
  app.get('/roles', async () => {
    return { data: await db('nivaro_roles').select('id', 'name').orderBy('name') }
  })

  // ── Entity room registry (admin) ──────────────────────────────────────────

  app.get('/room-types', async () => {
    return { data: await db('nivaro_chat_room_types').orderBy('prefix') }
  })

  app.post('/room-types', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as {
      prefix?: string
      collection?: string
      match_field?: string
      label?: string
    }
    const prefix = String(b.prefix ?? '').trim()
    if (!prefix || !b.collection) {
      return reply.code(400).send({ error: 'prefix and collection are required' })
    }
    if (await db('nivaro_chat_room_types').where({ prefix }).first()) {
      return reply.code(409).send({ error: `Prefix "${prefix}" is already registered` })
    }
    await db('nivaro_chat_room_types').insert({
      prefix,
      collection: b.collection,
      match_field: b.match_field || 'id',
      label: b.label ?? null
    })
    clearChatCaches()
    clearRoomTypeCache()
    void logActivity({
      action: 'chat-room-type-create',
      user: req.user?.id ?? null,
      collection: 'nivaro_chat_room_types',
      comment: `${prefix} → ${b.collection}.${b.match_field || 'id'}`
    })
    return reply
      .code(201)
      .send({ data: await db('nivaro_chat_room_types').where({ prefix }).first() })
  })

  app.patch<{ Params: { id: string } }>(
    '/room-types/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_chat_room_types').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const b = req.body as Record<string, unknown>
      const patch: Record<string, unknown> = {}
      for (const f of ['collection', 'match_field', 'label'])
        if (b[f] !== undefined) patch[f] = b[f]
      if (b.is_active !== undefined) patch.is_active = !!b.is_active
      for (const f of ['post_activity', 'owners_follow']) {
        if (b[f] !== undefined && (await hasColumn('nivaro_chat_room_types', f))) patch[f] = !!b[f]
      }
      if (Object.keys(patch).length > 0) {
        await db('nivaro_chat_room_types').where('id', row.id).update(patch)
        clearChatCaches()
        clearRoomTypeCache()
        void logActivity({
          action: 'chat-room-type-update',
          user: req.user?.id ?? null,
          collection: 'nivaro_chat_room_types',
          item: String(row.id),
          comment: `${row.prefix}: ${Object.keys(patch).join(', ')}`
        })
      }
      return { data: await db('nivaro_chat_room_types').where('id', row.id).first() }
    }
  )

  // ── Channel extras: bulk invite (#937), audit log (#975) ──────────────────

  /** Add every member of a Team or a role to a channel, skipping people
   *  already in it and suspended/redacted accounts. Owner or admin. */
  app.post<{ Params: { id: string } }>('/channels/:id/members/bulk', async (req, reply) => {
    const row = await db('nivaro_chat_channels').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && String(row.created_by ?? '') !== String(req.user?.id)) {
      return reply.code(403).send({ error: 'Only the channel owner or an admin can add members' })
    }
    const b = req.body as { team_id?: string | number; role_id?: string; dry_run?: boolean }
    let candidates: string[] = []
    let source = ''
    if (b.team_id != null && b.team_id !== '') {
      const team = (await db('nivaro_user_groups').where('id', b.team_id).first('id', 'name')) as
        | { id: string; name: string }
        | undefined
      if (!team) return reply.code(404).send({ error: 'Team not found' })
      candidates = (await db('nivaro_user_group_members')
        .where({ group_id: team.id })
        .pluck('user')) as string[]
      source = `team ${team.name}`
    } else if (b.role_id) {
      const role = (await db('nivaro_roles').where('id', b.role_id).first('id', 'name')) as
        | { id: string; name: string }
        | undefined
      if (!role) return reply.code(404).send({ error: 'Role not found' })
      candidates = (await db('nivaro_users').where({ role: role.id }).pluck('id')) as string[]
      source = `role ${role.name}`
    } else {
      return reply.code(400).send({ error: 'team_id or role_id is required' })
    }
    const room = `ch:${row.key}`
    const active = new Set(
      (
        (await db('nivaro_users')
          .whereIn('id', candidates.slice(0, 2000))
          .whereNot('status', 'suspended')
          .andWhere((q) => q.whereNull('is_redacted').orWhere('is_redacted', false))
          .pluck('id')) as string[]
      ).map((u) => String(u).toUpperCase())
    )
    const already = new Set(
      ((await db('nivaro_chat_memberships').where({ room }).pluck('user')) as string[]).map((u) =>
        String(u).toUpperCase()
      )
    )
    const toAdd = [...active].filter((u) => !already.has(u))
    const skipped = candidates.length - toAdd.length
    if (b.dry_run) return { data: { would_add: toAdd.length, skipped, source } }
    for (const u of toAdd) await upsertMembership(u, room, { last_read_at: new Date() })
    void logActivity({
      action: 'chat-channel-member-add',
      user: req.user?.id ?? null,
      collection: 'nivaro_chat_channels',
      item: String(row.key),
      comment: `${toAdd.length} added from ${source} to #${row.key}`
    })
    return { data: { added: toAdd.length, skipped, source } }
  })

  /** Joins, leaves, renames and settings changes for a channel (#975). */
  app.get<{ Params: { id: string } }>('/channels/:id/audit', async (req, reply) => {
    const row = await db('nivaro_chat_channels').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!(await canSeeRoom(req.user!, `ch:${row.key}`))) return reply.code(403).send(forbidden)
    const rows = (await db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where('a.collection', 'nivaro_chat_channels')
      .whereIn('a.item', [String(row.key), String(row.id)])
      .orderBy('a.timestamp', 'desc')
      .limit(100)
      .select(
        'a.id',
        'a.action',
        'a.comment',
        'a.timestamp',
        'a.user',
        'u.first_name',
        'u.last_name',
        'u.email'
      )) as Array<Record<string, unknown>>
    return {
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        comment: r.comment ?? null,
        at: r.timestamp,
        user: r.user,
        user_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || null
      }))
    }
  })

  // ── Scheduled send (#939) ─────────────────────────────────────────────────

  app.get('/scheduled', async (req) => {
    if (!(await hasTable('nivaro_chat_scheduled'))) return { data: [] }
    const rows = (await db('nivaro_chat_scheduled')
      .where({ user: req.user!.id })
      .whereIn('status', ['pending', 'failed'])
      .orderBy('send_at', 'asc')
      .limit(100)) as Array<Record<string, unknown>>
    return {
      data: rows.map((r) => ({ ...r, attachments: parseAttachments(r.attachments) }))
    }
  })

  app.post('/scheduled', async (req, reply) => {
    if (!(await hasTable('nivaro_chat_scheduled')))
      return reply.code(503).send({ error: 'Scheduled messages need migration 370' })
    const b = req.body as {
      room?: string
      message?: string
      attachments?: string[]
      parent_id?: number | null
      send_at?: string
    }
    const room = String(b.room ?? '').trim()
    const message = String(b.message ?? '').trim()
    const sendAt = new Date(String(b.send_at ?? ''))
    if (!room || (!message && !(b.attachments ?? []).length))
      return reply.code(400).send({ error: 'room and message are required' })
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() < Date.now() + 30_000)
      return reply.code(400).send({ error: 'Pick a time at least a minute from now' })
    if (sendAt.getTime() > Date.now() + 90 * 86_400_000)
      return reply.code(400).send({ error: 'Schedule within the next 90 days' })
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const { scheduleChatMessage } = await import('../services/chat-scheduled.js')
    const id = await scheduleChatMessage(app, {
      user: String(req.user!.id),
      room,
      message,
      attachments: (b.attachments ?? [])
        .filter((a) => /^[0-9a-f-]{36}$/i.test(String(a)))
        .slice(0, 10),
      parentId: b.parent_id ?? null,
      sendAt
    })
    return reply.code(201).send({ data: { id, send_at: sendAt.toISOString() } })
  })

  app.patch<{ Params: { id: string } }>('/scheduled/:id', async (req, reply) => {
    const row = (await db('nivaro_chat_scheduled')
      .where({ id: Number(req.params.id), user: req.user!.id })
      .first()) as Record<string, unknown> | undefined
    if (!row || row.status === 'sent') return reply.code(404).send({ error: 'Not found' })
    const b = req.body as { message?: string; send_at?: string }
    const patch: Record<string, unknown> = { status: 'pending', error: null }
    if (b.message !== undefined) {
      const m = String(b.message).trim()
      if (!m) return reply.code(400).send({ error: 'message is required' })
      patch.message = m
    }
    if (b.send_at !== undefined) {
      const d = new Date(b.send_at)
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 30_000)
        return reply.code(400).send({ error: 'Pick a time at least a minute from now' })
      patch.send_at = d
    }
    await db('nivaro_chat_scheduled').where({ id: row.id }).update(patch)
    if (patch.send_at) {
      const { armScheduledTimer } = await import('../services/chat-scheduled.js')
      armScheduledTimer(app, Number(row.id), patch.send_at as Date)
    }
    return { data: { id: row.id, ...patch } }
  })

  app.delete<{ Params: { id: string } }>('/scheduled/:id', async (req, reply) => {
    const n = await db('nivaro_chat_scheduled')
      .where({ id: Number(req.params.id), user: req.user!.id })
      .whereNot('status', 'sent')
      .update({ status: 'cancelled' })
    if (!n) return reply.code(404).send({ error: 'Not found' })
    return { data: { cancelled: true } }
  })

  // ── Link previews (#930) ──────────────────────────────────────────────────

  app.get('/link-preview', async (req, reply) => {
    const url = String((req.query as { url?: string }).url ?? '').trim()
    if (!/^https?:\/\//i.test(url) || url.length > 2000)
      return reply.code(400).send({ error: 'A full http(s) URL is required' })
    const { linkPreview } = await import('../services/chat-link-preview.js')
    return { data: await linkPreview(app, url) }
  })

  /** A card for a link to this app (#930 records, #947 queues/reports/
   *  dashboards/saved views), read as the viewer. */
  app.get('/app-card', async (req) => {
    const path = String((req.query as { path?: string }).path ?? '').slice(0, 1000)
    if (!path.startsWith('/')) return { data: null }
    const { appCardFor } = await import('../services/chat-app-card.js')
    return { data: await appCardFor(req.user!, !!req.isAdmin, path).catch(() => null) }
  })

  // ── Room info (#978, #980) ────────────────────────────────────────────────

  app.get<{ Params: { room: string } }>('/rooms/:room/info', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const parsed = parseRoom(room)
    let memberIds: string[] = []
    let createdBy: string | null = null
    let createdAt: string | null = null
    if (parsed.kind === 'dm') memberIds = parsed.participants ?? []
    else
      memberIds = (
        (await db('nivaro_chat_memberships').where({ room }).pluck('user')) as string[]
      ).map((u) => String(u).toUpperCase())
    if (parsed.kind === 'channel') {
      const ch = (await channels()).get(parsed.channelKey ?? '') as
        | (ChatChannel & { created_at?: unknown })
        | undefined
      createdBy = ch?.created_by ?? null
      const act = (await db('nivaro_activity')
        .where({
          collection: 'nivaro_chat_channels',
          item: parsed.channelKey,
          action: 'chat-channel-create'
        })
        .orderBy('id', 'asc')
        .first('timestamp', 'user')
        .catch(() => undefined)) as { timestamp?: Date; user?: string } | undefined
      createdAt = act?.timestamp ? new Date(act.timestamp).toISOString() : null
      createdBy = createdBy ?? act?.user ?? null
    }
    const first = (await db('chat_messages')
      .where({ room })
      .orderBy('id', 'asc')
      .first('date_created')) as { date_created?: Date } | undefined
    const users = memberIds.length
      ? ((await db('nivaro_users')
          .whereIn('id', memberIds.slice(0, 500))
          .select('id', 'first_name', 'last_name', 'email', 'title', 'status')) as Array<
          Record<string, unknown>
        >)
      : []
    // Online = heartbeat within 70s — the Online tab's rule; visibility of
    // people follows the room itself (you can see who shares a room with you).
    const since = new Date(Date.now() - 70_000)
    const online = new Set(
      (
        (await db('user_presence')
          .whereIn('user_id', memberIds.slice(0, 500))
          .where('last_seen', '>=', since)
          .andWhere((q) => q.whereNull('is_online').orWhere('is_online', true))
          .pluck('user_id')
          .catch(() => [])) as string[]
      ).map((u) => String(u).toUpperCase())
    )
    const creator = createdBy
      ? (users.find((u) => String(u.id).toUpperCase() === String(createdBy).toUpperCase()) ??
        ((await db('nivaro_users')
          .where('id', createdBy)
          .first('first_name', 'last_name', 'email')) as Record<string, unknown> | undefined))
      : null
    const fileCount = Number(
      (
        (await db('chat_messages')
          .where({ room })
          .whereNull('deleted_at')
          .whereNotNull('attachments')
          .whereNot('attachments', '[]')
          .count({ n: 'id' })
          .first()) as { n?: number } | undefined
      )?.n ?? 0
    )
    const pinCount = Number(
      (
        (await db('nivaro_chat_pins').where({ room }).count({ n: 'id' }).first()) as
          | { n?: number }
          | undefined
      )?.n ?? 0
    )
    const membership = (await db('nivaro_chat_memberships')
      .where({ user: req.user!.id, room })
      .first()) as Record<string, unknown> | undefined
    return {
      data: {
        room,
        kind: parsed.kind,
        members: users
          .filter((u) => u.status !== 'suspended')
          .map((u) => ({
            id: String(u.id),
            name: [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.email ?? ''),
            title: u.title ?? null,
            online: online.has(String(u.id).toUpperCase())
          }))
          .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
        member_count: users.filter((u) => u.status !== 'suspended').length,
        online_count: [...online].length,
        created_by: creator
          ? [creator.first_name, creator.last_name].filter(Boolean).join(' ') ||
            String(creator.email ?? '')
          : null,
        created_at:
          createdAt ?? (first?.date_created ? new Date(first.date_created).toISOString() : null),
        file_count: fileCount,
        pin_count: pinCount,
        notify: {
          muted: !!membership?.is_muted,
          mode: membership?.notify_mode === 'mentions' ? 'mentions' : 'all'
        }
      }
    }
  })

  // ── Record rooms (#985, #986, #969, #946, #949) ───────────────────────────

  /** State, SLA and owners for the record a room is about. */
  app.get<{ Params: { room: string } }>('/rooms/:room/record', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    return { data: await roomRecordFacts(req.user!, room) }
  })

  /** The room for a record + my unread in it — the record header's button. */
  app.get('/record-room', async (req, reply) => {
    const q = req.query as { collection?: string; item?: string }
    if (!q.collection || !q.item)
      return reply.code(400).send({ error: 'collection and item are required' })
    const { can } = await import('../services/permissions.js')
    if (!req.isAdmin && !(await can(req.user!, 'read', q.collection))) return { data: null }
    const target = await roomForRecord(q.collection, q.item)
    if (!target || !(await canSeeRoom(req.user!, target.room))) return { data: null }
    const m = (await db('nivaro_chat_memberships')
      .where({ user: req.user!.id, room: target.room })
      .first('last_read_at')) as { last_read_at?: Date | null } | undefined
    const me = String(req.user!.id).toUpperCase()
    const unread = Number(
      (
        (await db('chat_messages')
          .where({ room: target.room })
          .whereNull('deleted_at')
          .whereRaw('(sender IS NULL OR UPPER(CAST(sender AS NVARCHAR(36))) <> ?)', [me])
          .modify((qb) => {
            if (m?.last_read_at) qb.where('date_created', '>', m.last_read_at)
          })
          .count({ n: 'id' })
          .first()) as { n?: number } | undefined
      )?.n ?? 0
    )
    const total = Number(
      (
        (await db('chat_messages').where({ room: target.room }).count({ n: 'id' }).first()) as
          | { n?: number }
          | undefined
      )?.n ?? 0
    )
    return { data: { room: target.room, unread: m ? unread : 0, messages: total, joined: !!m } }
  })

  /** Unread record rooms for records I own or follow (#969 — My Work). */
  app.get('/my-record-rooms', async (req) => {
    const rooms = (await listRooms(req.user!)).filter((r) => r.kind === 'entity' && r.unread > 0)
    return {
      data: rooms.slice(0, 30).map((r) => ({
        room: r.room,
        label: r.label ?? r.room.toUpperCase(),
        unread: r.unread,
        mentions: r.mentions,
        last_message: r.last_message
      }))
    }
  })

  /** Copy a message into the record's Notes thread, credited to its author (#946). */
  app.post<{ Params: { id: string } }>('/messages/:id/to-notes', async (req, reply) => {
    const msg = await loadMessage(Number(req.params.id))
    if (!msg || msg.deleted_at) return reply.code(404).send({ error: 'Not found' })
    const room = String(msg.room)
    const { resolveRoomRecord } = await import('../services/chat-records.js')
    const rec = await resolveRoomRecord(req.user!, room)
    if (!rec) return reply.code(400).send({ error: 'This message is not in a record’s room' })
    const { can } = await import('../services/permissions.js')
    if (
      !req.isAdmin &&
      !(await can(req.user!, 'create', rec.collection)) &&
      !(await can(req.user!, 'read', rec.collection))
    ) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const author = msg.sender ? String(msg.sender) : String(req.user!.id)
    const when = new Date(String(msg.date_created))
    const esc = (t: string) =>
      t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
    const text = `<p>${esc(String(msg.message ?? ''))
      .split(/\n+/)
      .join(
        '</p><p>'
      )}</p><p><em>From chat (${esc(room)}), ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC${
      author.toUpperCase() !== String(req.user!.id).toUpperCase()
        ? ` · added by ${esc([req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || 'someone')}`
        : ''
    }</em></p>`
    const { randomUUID } = await import('node:crypto')
    const id = randomUUID()
    await db('nivaro_comments').insert({
      id,
      collection: rec.collection,
      item: rec.id,
      user: author,
      text,
      created_at: new Date(),
      updated_at: new Date()
    })
    app.io
      ?.to(`record:${rec.collection}:${rec.id}`)
      .emit('record:comment', { collection: rec.collection, item: rec.id, user: author })
    void logActivity({
      action: 'chat-to-notes',
      user: req.user?.id ?? null,
      collection: rec.collection,
      item: rec.id,
      comment: `chat message ${msg.id} copied to Notes`
    })
    return reply
      .code(201)
      .send({ data: { comment_id: id, collection: rec.collection, item: rec.id } })
  })

  /** The record's file fields a chat attachment can be copied into (#949). */
  app.get<{ Params: { room: string } }>('/rooms/:room/file-targets', async (req) => {
    const room = decodeURIComponent(req.params.room)
    const { resolveRoomRecord } = await import('../services/chat-records.js')
    const rec = await resolveRoomRecord(req.user!, room)
    if (!rec) return { data: [] }
    const { can } = await import('../services/permissions.js')
    if (!req.isAdmin && !(await can(req.user!, 'update', rec.collection))) return { data: [] }
    return { data: await recordFileTargets(rec.collection) }
  })

  app.post<{ Params: { id: string } }>('/messages/:id/attach-to-record', async (req, reply) => {
    const msg = await loadMessage(Number(req.params.id))
    if (!msg || msg.deleted_at) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as { file_id?: string; field?: string }
    const fileId = String(b.file_id ?? '')
    if (!parseAttachments(msg.attachments).some((f) => f.toLowerCase() === fileId.toLowerCase()))
      return reply.code(400).send({ error: 'That file is not attached to this message' })
    const { resolveRoomRecord } = await import('../services/chat-records.js')
    const rec = await resolveRoomRecord(req.user!, String(msg.room))
    if (!rec) return reply.code(400).send({ error: 'This message is not in a record’s room' })
    const targets = await recordFileTargets(rec.collection)
    const target =
      targets.find((t) => t.field === b.field) ?? (targets.length === 1 ? targets[0] : null)
    if (!target) return reply.code(400).send({ error: 'Pick the record field to attach it to' })
    const { createOne, updateOne } = await import('../services/items.js')
    try {
      if (target.kind === 'm2m') {
        const exists = await db(target.junction!)
          .where({ [target.parent_fk!]: rec.id, [target.file_fk!]: fileId })
          .first()
        if (!exists)
          await createOne(req.user!, target.junction!, {
            [target.parent_fk!]: rec.id,
            [target.file_fk!]: fileId
          })
      } else {
        await updateOne(req.user!, rec.collection, rec.id, { [target.field]: fileId })
      }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500
      return reply
        .code(status)
        .send({ error: err instanceof Error ? err.message : 'Could not attach the file' })
    }
    void logActivity({
      action: 'chat-attach-to-record',
      user: req.user?.id ?? null,
      collection: rec.collection,
      item: rec.id,
      comment: `file ${fileId} from chat message ${msg.id} → ${target.label}`
    })
    return {
      data: { attached: true, field: target.field, collection: rec.collection, item: rec.id }
    }
  })

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Nudge a room's members to refetch after a non-message change (reaction,
   *  edit, delete). Rides the same chat:message event clients already
   *  invalidate on; the payload only needs the room. */
  function emitRoomTouch(room: string): void {
    app.io?.to(`chat:${room}`).emit('chat:message', { room, touch: true })
  }
}

function parseAttachments(raw: unknown): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(String(raw))
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

export { parseRoom }

async function hasTable(t: string): Promise<boolean> {
  return db.schema.hasTable(t).catch(() => false)
}

/**
 * New channel fields (#935/#936/#960/#961) from a request body. Default roles
 * are admin-only: they add people to a channel without asking them.
 */
async function channelExtrasPatch(
  b: Record<string, unknown>,
  isAdmin: boolean
): Promise<{ patch: Record<string, unknown> } | { error: string }> {
  const patch: Record<string, unknown> = {}
  if (!(await hasColumn('nivaro_chat_channels', 'announce'))) return { patch }
  if (b.announce !== undefined) patch.announce = !!b.announce
  if (b.description !== undefined)
    patch.description = b.description ? String(b.description).slice(0, 2000) : null
  if (b.welcome_note !== undefined)
    patch.welcome_note = b.welcome_note ? String(b.welcome_note).slice(0, 2000) : null
  if (b.links !== undefined) {
    const links = cleanChannelLinks(b.links)
    if (links === null) return { error: 'Links need a full http(s) address or an app path' }
    patch.links = links.length ? JSON.stringify(links) : null
  }
  if (b.default_roles !== undefined) {
    if (!isAdmin) return { error: 'Only an admin can set default roles' }
    const ids = Array.isArray(b.default_roles)
      ? [...new Set(b.default_roles.map((r) => String(r).toUpperCase()))].slice(0, 50)
      : []
    patch.default_roles = ids.length ? JSON.stringify(ids) : null
  }
  return { patch }
}

interface FileTarget {
  field: string
  label: string
  kind: 'm2m' | 'm2o'
  junction?: string
  parent_fk?: string
  file_fk?: string
}

/** A collection's file fields: M2M aliases through a junction to the files
 *  table, and plain M2O file columns. */
async function recordFileTargets(collection: string): Promise<FileTarget[]> {
  const FILES = ['nivaro_files', 'directus_files']
  const rels = (await db('nivaro_relations')
    .where((q) => q.where('one_collection', collection).orWhere('many_collection', collection))
    .orWhereIn('one_collection', FILES)
    .select(
      'many_collection',
      'many_field',
      'one_collection',
      'one_field',
      'junction_field'
    )) as Array<Record<string, string | null>>
  const out: FileTarget[] = []
  for (const r of rels) {
    if (r.many_collection === collection && r.one_collection && FILES.includes(r.one_collection)) {
      out.push({ field: String(r.many_field), label: String(r.many_field), kind: 'm2o' })
    }
    if (r.one_collection === collection && r.one_field && r.junction_field && r.many_collection) {
      const companion = rels.find(
        (c) =>
          c.many_collection === r.many_collection &&
          c.many_field === r.junction_field &&
          c.one_collection &&
          FILES.includes(c.one_collection)
      )
      if (companion)
        out.push({
          field: String(r.one_field),
          label: String(r.one_field),
          kind: 'm2m',
          junction: String(r.many_collection),
          parent_fk: String(r.many_field),
          file_fk: String(r.junction_field)
        })
    }
  }
  const labels = (await db('nivaro_fields')
    .where({ collection })
    .whereIn(
      'field',
      out.map((o) => o.field)
    )
    .select('field', 'label')
    .catch(() => [])) as Array<{ field: string; label: string | null }>
  for (const o of out) {
    const l = labels.find((x) => x.field === o.field)?.label
    o.label = l || o.field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  }
  return out
}

/**
 * Inline reply from a push notification (#956). Authenticated by the
 * one-time-per-notification token the push carried, not the session — the
 * service worker may be answering while no tab is open.
 */
export async function chatPushReplyRoutes(app: FastifyInstance) {
  app.post('/push-reply', async (req, reply) => {
    const b = req.body as { token?: string; message?: string }
    const text = String(b.message ?? '').trim()
    if (!text) return reply.code(400).send({ error: 'message is required' })
    const claim = await redeemReplyToken(app, String(b.token ?? ''))
    if (!claim) return reply.code(401).send({ error: 'This reply link has expired' })
    const user = (await db('nivaro_users').where({ id: claim.user }).first()) as
      | import('../types.js').User
      | undefined
    if (!user || (user as unknown as { status?: string }).status === 'suspended')
      return reply.code(401).send({ error: 'This reply link has expired' })
    try {
      const row = await postChatMessage(app, { user }, { room: claim.room, message: text })
      await touchWatermark(String(user.id), claim.room)
      return reply.code(201).send({ data: { id: row.id } })
    } catch (err) {
      if (err instanceof ChatSendError)
        return reply.code(err.statusCode).send({ error: err.message })
      throw err
    }
  })
}
