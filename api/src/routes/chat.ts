import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  type ChatChannel,
  canSeeRoom,
  channels,
  clearChatCaches,
  listDirectory,
  listRooms,
  parseRoom
} from '../services/chat.js'
import {
  botUserId,
  chatBotName,
  clearChatBotCache,
  handleBotMention,
  mentionsBot
} from '../services/chat-bot.js'
import { notifyUser } from '../services/notification-channels.js'
import { sendWebPush } from '../services/web-push.js'

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
    return { data: await listRooms(req.user!) }
  })

  app.get('/directory', async (req) => {
    const q = req.query as { search?: string }
    return { data: await listDirectory(req.user!, q.search) }
  })

  app.get('/messages', async (req, reply) => {
    const q = req.query as { room?: string; limit?: string; before?: string }
    const room = String(q.room ?? '').trim()
    if (!room) return reply.code(400).send({ error: 'room is required' })
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)

    const limit = Math.min(Number(q.limit ?? 200) || 200, 500)
    const rows = (await db('chat_messages')
      .where({ room })
      .modify((qb) => {
        if (q.before) qb.where('id', '<', Number(q.before) || 0)
      })
      .orderBy('id', 'desc')
      .limit(limit)
      .select(
        'id',
        'sender',
        'sender_name',
        'room',
        'message',
        'date_created',
        'edited_at',
        'deleted_at',
        'attachments'
      )) as Array<Record<string, unknown>>

    // Reactions for the returned window, one query.
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

    const data = rows.map((r) => ({
      ...r,
      // A deleted message keeps its row (thread continuity) but sheds content.
      message: r.deleted_at ? '' : r.message,
      attachments: r.deleted_at ? [] : parseAttachments(r.attachments),
      reactions: reactionsByMsg.get(Number(r.id)) ?? []
    }))
    // Ascending for rendering; the query is descending so `limit` takes the
    // NEWEST messages rather than the oldest.
    return { data: data.reverse() }
  })

  app.post('/messages', async (req, reply) => {
    const b = req.body as {
      room?: string
      message?: string
      mentions?: string[]
      attachments?: string[]
    }
    const room = String(b.room ?? '').trim()
    const message = String(b.message ?? '').trim()
    // Uuid-shaped nivaro_files ids only, capped — the composer uploads first
    // and sends ids, so anything else here is a malformed client.
    const attachments = (Array.isArray(b.attachments) ? b.attachments : [])
      .filter((a) => /^[0-9a-f-]{36}$/i.test(String(a)))
      .slice(0, 10)
    if (!room || (!message && attachments.length === 0)) {
      return reply.code(400).send({ error: 'room and message are required' })
    }
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)

    const senderName =
      [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ').trim() ||
      req.user?.email ||
      null
    const [inserted] = await db('chat_messages')
      .insert({
        room,
        message,
        sender: req.user?.id ?? null,
        sender_name: senderName,
        date_created: new Date(),
        attachments: attachments.length ? JSON.stringify(attachments) : null
      })
      .returning('id')
    const id =
      typeof inserted === 'object' && inserted !== null
        ? (inserted as { id: number }).id
        : (inserted as number)

    const row = {
      id,
      room,
      message,
      sender: req.user?.id ?? null,
      sender_name: senderName,
      date_created: new Date().toISOString(),
      attachments,
      reactions: [] as unknown[]
    }
    // chat_messages is configured accountability='activity' (2026-08-06 audit
    // decision), but this native send route raw-inserts and bypasses the items
    // hooks — write the activity row it would have produced. Fire-and-forget.
    void logActivity({
      action: 'create',
      user: req.user?.id ?? null,
      collection: 'chat_messages',
      item: String(id),
      comment: `room ${room}`
    })
    // Only the room's own socket room hears it — previously every client
    // invalidated on every message anywhere via collection:update.
    app.io?.to(`chat:${room}`).emit('chat:message', row)
    // DMs ALSO deliver to both participants' personal user rooms: the
    // recipient of a brand-new DM has never joined a chat room they don't
    // know exists, so without this the first message waits for the sidebar
    // poll (~45s) instead of arriving instantly. Duplicate delivery when the
    // room IS joined is harmless — the client just invalidates queries.
    const parsedRoom = parseRoom(room)
    if (parsedRoom.kind === 'dm') {
      for (const p of parsedRoom.participants ?? []) {
        app.io?.to(`user:${p}`).emit('chat:message', row)
      }
      // Web push for the DM peer — no in-app notification row (a row per DM
      // message would bury the inbox), just the browser ping. Mute wins.
      const peer = (parsedRoom.participants ?? []).find(
        (p) => p !== String(req.user!.id).toUpperCase()
      )
      if (peer && !(await isMuted(peer, room))) {
        void sendWebPush(peer, {
          title: senderName ?? 'New message',
          body: message.slice(0, 200) || 'Sent an attachment',
          tag: `chat-${room}`
        })
      }
      // DM auto-reply when OOO (#375): the peer's out-of-office answers
      // instantly with return date + delegate — once per room per 24h, and
      // clearly marked automatic (the message row is FROM the peer).
      if (peer) {
        void (async () => {
          try {
            const p = (await db('nivaro_users')
              .where({ id: peer })
              .first('id', 'first_name', 'last_name', 'is_out_of_office', 'ooo_end', 'delegate_id')) as
              | Record<string, unknown>
              | undefined
            if (!p?.is_out_of_office) return
            const recent = await db('chat_messages')
              .where({ room, sender: peer })
              .where('message', 'like', '%(automatic out-of-office reply)%')
              .where('date_created', '>=', new Date(Date.now() - 24 * 3600e3))
              .first('id')
            if (recent) return
            let delegateName = ''
            if (p.delegate_id) {
              const d = (await db('nivaro_users')
                .where({ id: p.delegate_id })
                .first('first_name', 'last_name', 'email')) as Record<string, unknown> | undefined
              delegateName =
                [d?.first_name, d?.last_name].filter(Boolean).join(' ') || String(d?.email ?? '')
            }
            const pName = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'This person'
            const until = p.ooo_end ? ` until ${String(p.ooo_end).slice(0, 10)}` : ''
            const autoText = `${pName} is out of office${until}.${
              delegateName ? ` Reach out to ${delegateName} in the meantime.` : ''
            } (automatic out-of-office reply)`
            const [ins] = await db('chat_messages')
              .insert({
                room,
                message: autoText,
                sender: peer,
                sender_name: pName,
                date_created: new Date()
              })
              .returning('id')
            const autoId = typeof ins === 'object' && ins !== null ? (ins as { id: number }).id : ins
            app.io?.to(`chat:${room}`).emit('chat:message', {
              id: autoId,
              room,
              message: autoText,
              sender: peer,
              sender_name: pName,
              date_created: new Date().toISOString(),
              attachments: [],
              reactions: []
            })
          } catch {
            /* auto-reply is best-effort */
          }
        })()
      }
    }
    // @channel (#146): notify every room MEMBER — channel rooms only, and
    // only the channel's creator or an admin may fire it (a whole-room ping
    // is a bullhorn, not a mention).
    if (/(^|\s)@channel\b/.test(message) && room.startsWith('ch:')) {
      void (async () => {
        try {
          const ch = (await db('nivaro_chat_channels')
            .where({ key: room.slice(3) })
            .first('created_by')) as { created_by?: string | null } | undefined
          const senderId = String(req.user!.id).toUpperCase()
          const allowed = req.isAdmin || String(ch?.created_by ?? '').toUpperCase() === senderId
          if (!allowed) return
          const members = (await db('nivaro_chat_memberships')
            .where({ room })
            .select('user')) as Array<{ user: string }>
          const { notifyUser } = await import('../services/notification-channels.js')
          for (const m of members.slice(0, 300)) {
            if (String(m.user).toUpperCase() === senderId) continue
            await notifyUser(app, m.user, {
              subject: `@channel in ${room.slice(3)}`,
              message: `${senderName ?? 'Someone'}: ${message.slice(0, 300)}`,
              sender: req.user?.id ?? null
            }).catch(() => {})
          }
        } catch {
          /* bullhorn is best-effort */
        }
      })()
    }

    // '@<bot>' routes the question to the AI assistant (fire-and-forget —
    // the human's message must never wait on a model). A DM with the bot
    // needs no mention: every message there is addressed to it.
    const botName = await chatBotName()
    if (botName && message) {
      if (mentionsBot(message, botName)) {
        void handleBotMention(app, req.user!, room, message)
      } else if (parsedRoom.kind === 'dm') {
        const bid = await botUserId().catch(() => null)
        if (bid && (parsedRoom.participants ?? []).includes(bid.toUpperCase())) {
          void handleBotMention(app, req.user!, room, message)
        }
      }
    }

    // Sending is also reading: seeing your own message as unread is noise.
    await touchWatermark(String(req.user!.id), room)

    // Mentions notify explicitly (the socket only reaches people with the room
    // open). Only mention users who can actually see the room.
    for (const target of (b.mentions ?? []).slice(0, 20)) {
      if (!target || String(target) === String(req.user?.id)) continue
      const targetUser = await db('nivaro_users').where('id', target).first()
      if (!targetUser) continue
      if (!(await canSeeRoom(targetUser, room))) continue
      if (await isMuted(String(target), room)) continue
      await notifyUser(app, String(target), {
        subject: `${senderName ?? 'Someone'} mentioned you in chat`,
        message: message.slice(0, 300),
        sender: req.user?.id ?? null,
        // Pseudo-collection: clients resolve '__chat__' + room into opening
        // the chat room rather than a record route.
        collection: '__chat__',
        item: room
      })
    }

    return reply.code(201).send({ data: row })
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
    await upsertMembership(String(req.user!.id), room, {})
    return { data: { room, joined: true } }
  })

  app.delete<{ Params: { room: string } }>('/rooms/:room/join', async (req) => {
    const room = decodeURIComponent(req.params.room)
    await db('nivaro_chat_memberships').where({ user: req.user!.id, room }).del()
    return { data: { room, joined: false } }
  })

  app.patch<{ Params: { room: string } }>('/rooms/:room', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const b = req.body as { muted?: boolean; notify_mode?: string | null }
    const patch: { is_muted?: boolean; notify_mode?: string | null } = {}
    if (b.muted !== undefined) patch.is_muted = !!b.muted
    if (b.notify_mode !== undefined) {
      patch.notify_mode = b.notify_mode === 'mentions' ? 'mentions' : null
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'muted or notify_mode is required' })
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
    if (Date.now() - new Date(msg.date_created).getTime() > EDIT_WINDOW_MS) {
      return reply.code(400).send({ error: 'The edit window has passed' })
    }
    const text = String((req.body as { message?: string })?.message ?? '').trim()
    if (!text) return reply.code(400).send({ error: 'message is required' })
    await db('chat_messages').where('id', msg.id).update({ message: text, edited_at: new Date() })
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
    const q = String((req.query as { q?: string }).q ?? '').trim()
    if (q.length < 2) return { data: [] }
    const rooms = (await listRooms(req.user!)).map((r) => r.room)
    if (rooms.length === 0) return { data: [] }
    const like = `%${q.replace(/[\\%_[]/g, (m) => `\\${m}`)}%`
    const rows = await db('chat_messages')
      .whereIn('room', rooms.slice(0, 200))
      .whereNull('deleted_at')
      .whereRaw("message LIKE ? ESCAPE '\\'", [like])
      .orderBy('id', 'desc')
      .limit(50)
      .select('id', 'room', 'sender', 'sender_name', 'message', 'date_created')
    return reply.send({ data: rows })
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
      .select('s.id as saved_id', 'm.id', 'm.room', 'm.message', 'm.sender_name', 'm.date_created')) as Array<
      Record<string, unknown>
    >
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
  app.post<{ Body: { room?: string } }>('/rooms/summary', async (req, reply) => {
    const room = String(req.body?.room ?? '')
    if (!room || !(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const membership = (await db('nivaro_chat_memberships')
      .where({ user: req.user!.id, room })
      .first('last_read_at')) as { last_read_at?: Date | null } | undefined
    const since = membership?.last_read_at ?? new Date(Date.now() - 7 * 86400e3)
    const msgs = (await db('chat_messages')
      .where({ room })
      .where('date_created', '>', since)
      .whereNull('deleted_at')
      .orderBy('id', 'asc')
      .limit(120)
      .select('sender_name', 'message', 'date_created')) as Array<Record<string, unknown>>
    if (msgs.length < 5) {
      return reply.send({ data: { summary: null, count: msgs.length } })
    }
    const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
    const aiClient = await getAiClient()
    if (!aiClient) return reply.code(503).send({ error: 'AI is not configured' })
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
      const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
      return reply.send({ data: { summary: text, count: msgs.length } })
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message.slice(0, 200) : 'AI call failed' })
    }
  })

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
    }
    const name = String(b.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
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

    await db('nivaro_chat_channels').insert({
      key,
      name,
      topic: b.topic ?? null,
      visibility,
      role: visibility === 'role' ? b.role : null,
      created_by: req.user?.id ?? null
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
      if (Object.keys(patch).length > 0) {
        await db('nivaro_chat_room_types').where('id', row.id).update(patch)
        clearChatCaches()
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

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Nudge a room's members to refetch after a non-message change (reaction,
   *  edit, delete). Rides the same chat:message event clients already
   *  invalidate on; the payload only needs the room. */
  function emitRoomTouch(room: string): void {
    app.io?.to(`chat:${room}`).emit('chat:message', { room, touch: true })
  }

  async function upsertMembership(
    user: string,
    room: string,
    patch: { is_muted?: boolean; last_read_at?: Date; notify_mode?: string | null }
  ): Promise<void> {
    const existing = await db('nivaro_chat_memberships').where({ user, room }).first()
    if (existing) {
      if (Object.keys(patch).length > 0) {
        await db('nivaro_chat_memberships').where('id', existing.id).update(patch)
      }
      return
    }
    try {
      await db('nivaro_chat_memberships').insert({ user, room, joined_at: new Date(), ...patch })
    } catch {
      // UNIQUE(user, room) — a concurrent join raced us, which is not an error.
      if (Object.keys(patch).length > 0) {
        await db('nivaro_chat_memberships').where({ user, room }).update(patch)
      }
    }
  }

  async function touchWatermark(user: string, room: string): Promise<void> {
    await upsertMembership(user, room, { last_read_at: new Date() })
  }

  async function isMuted(user: string, room: string): Promise<boolean> {
    const row = await db('nivaro_chat_memberships').where({ user, room }).first()
    return !!row?.is_muted
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
