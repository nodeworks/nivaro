import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { channels, parseRoom } from '../services/chat.js'
import { loadChatAnalytics } from '../services/chat-analytics.js'
import { userTimeZone } from '../services/user-time.js'

/**
 * Chat administration (`/api/chat/admin`, admins only).
 *
 * `analytics` is counts and timings — no message text. `messages` and
 * `messages/:id` are the compliance view: an administrator reads messages
 * from anyone to anyone in any room, DMs and private channels included. That
 * is a deliberate exception to the rule the rest of chat keeps (admin_access
 * never opens other people's conversations), so every search and every
 * message opened here writes an activity row naming the administrator and
 * what they looked at.
 */

type Kind = 'dm' | 'group' | 'channel' | 'general' | 'record'

const MENTION_RE = /@\[([^\]]+)\](?:\([^)]*\))?/g

function nameOf(u: Record<string, unknown> | undefined): string | null {
  if (!u) return null
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.email ? String(u.email) : null)
}

function parseIdList(raw: unknown): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export async function chatAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/analytics', async (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 30, 1), 365)
    const tz = await userTimeZone(req.user ?? null)
    return { data: await loadChatAnalytics(days, tz) }
  })

  /** Room → kind + human label + participants, for a batch of rooms. */
  async function describeRooms(rooms: string[]) {
    const chans = await channels()
    const out = new Map<
      string,
      { kind: Kind; label: string; participants: Array<{ id: string; name: string | null }> }
    >()
    const userIds = new Set<string>()
    const channelRooms: string[] = []
    for (const room of rooms) {
      const p = parseRoom(room)
      if (p.kind === 'dm') for (const id of p.participants ?? []) userIds.add(id)
      if (p.kind === 'channel') channelRooms.push(room)
    }
    // Members of channels and group DMs (capped per room for the label).
    const memberRows = channelRooms.length
      ? ((await db('nivaro_chat_memberships')
          .whereIn('room', channelRooms)
          .select('room', 'user')) as Array<{ room: string; user: string }>)
      : []
    for (const m of memberRows) userIds.add(String(m.user).toUpperCase())
    const users = userIds.size
      ? ((await db('nivaro_users')
          .whereIn('id', [...userIds])
          .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>)
      : []
    const names = new Map(users.map((u) => [String(u.id).toUpperCase(), nameOf(u)]))
    const membersByRoom = new Map<string, string[]>()
    for (const m of memberRows) {
      const list = membersByRoom.get(m.room) ?? []
      list.push(String(m.user).toUpperCase())
      membersByRoom.set(m.room, list)
    }
    for (const room of rooms) {
      const p = parseRoom(room)
      if (p.kind === 'global') {
        out.set(room, { kind: 'general', label: 'General', participants: [] })
      } else if (p.kind === 'dm') {
        const people = (p.participants ?? []).map((id) => ({ id, name: names.get(id) ?? null }))
        out.set(room, {
          kind: 'dm',
          label: people.map((x) => x.name ?? 'Unknown').join(' ↔ '),
          participants: people
        })
      } else if (p.kind === 'channel') {
        const c = chans.get(p.channelKey ?? '')
        const people = (membersByRoom.get(room) ?? []).map((id) => ({
          id,
          name: names.get(id) ?? null
        }))
        out.set(room, {
          kind: c?.is_direct ? 'group' : 'channel',
          label: c?.name ?? room,
          participants: people
        })
      } else {
        const colon = room.indexOf(':')
        out.set(room, {
          kind: 'record',
          label: colon > 0 ? room.slice(colon + 1).toUpperCase() : room,
          participants: []
        })
      }
    }
    return out
  }

  function logRead(req: FastifyRequest, action: string, comment: string, item?: string) {
    void logActivity({
      action,
      user: req.user?.id,
      collection: 'chat_messages',
      item,
      comment: comment.slice(0, 500),
      req
    })
  }

  // ── Every message, filterable ────────────────────────────────────────────
  app.get('/messages', async (req, reply) => {
    const q = req.query as {
      sender?: string
      participant?: string
      room?: string
      kind?: string
      q?: string
      since?: string
      until?: string
      attachments?: string
      include_deleted?: string
      page?: string
      limit?: string
    }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
    const page = Math.max(Number(q.page) || 1, 1)
    const uuid = /^[0-9a-f-]{36}$/i
    const sender = q.sender && uuid.test(q.sender) ? q.sender.toUpperCase() : null
    const participant =
      q.participant && uuid.test(q.participant) ? q.participant.toUpperCase() : null
    const kinds = String(q.kind ?? '')
      .split(',')
      .filter((k): k is Kind => ['dm', 'group', 'channel', 'general', 'record'].includes(k))

    // A participant's rooms: their DMs, channels they belong to, and any room
    // they have written in (record rooms keep no membership).
    let participantRooms: string[] | null = null
    if (participant) {
      const [mem, sent] = await Promise.all([
        db('nivaro_chat_memberships').where('user', participant).select('room') as Promise<
          Array<{ room: string }>
        >,
        db('chat_messages').where('sender', participant).distinct('room') as Promise<
          Array<{ room: string }>
        >
      ])
      const dms = (await db('chat_messages')
        .where('room', 'like', `dm:%${participant}%`)
        .distinct('room')) as Array<{ room: string }>
      participantRooms = [...new Set([...mem, ...sent, ...dms].map((r) => String(r.room)))]
      if (participantRooms.length === 0) return reply.send({ data: [], total: 0 })
    }

    const chans = await channels()
    const groupKeys = [...chans.values()].filter((c) => c.is_direct).map((c) => `ch:${c.key}`)

    const base = db('chat_messages as m').modify((qb) => {
      if (sender) qb.where('m.sender', sender)
      if (participantRooms) qb.whereIn('m.room', participantRooms.slice(0, 2000))
      if (q.room) qb.where('m.room', String(q.room))
      if (kinds.length) {
        qb.where((w) => {
          for (const k of kinds) {
            if (k === 'dm') w.orWhere('m.room', 'like', 'dm:%')
            if (k === 'general') w.orWhere('m.room', 'global')
            if (k === 'group') {
              if (groupKeys.length) w.orWhereIn('m.room', groupKeys)
              else w.orWhereRaw('1 = 0')
            }
            if (k === 'channel')
              w.orWhere((c) => {
                c.where('m.room', 'like', 'ch:%')
                if (groupKeys.length) c.whereNotIn('m.room', groupKeys)
              })
            if (k === 'record')
              w.orWhere((c) =>
                c
                  .where('m.room', 'not like', 'dm:%')
                  .andWhere('m.room', 'not like', 'ch:%')
                  .andWhere('m.room', '<>', 'global')
              )
          }
        })
      }
      if (q.q && String(q.q).trim().length >= 2) {
        const like = `%${String(q.q)
          .trim()
          .replace(/[\\%_[]/g, (x) => `\\${x}`)}%`
        qb.whereRaw("m.message LIKE ? ESCAPE '\\'", [like])
      }
      if (q.since) {
        const d = new Date(q.since)
        if (!Number.isNaN(d.getTime())) qb.where('m.date_created', '>=', d)
      }
      if (q.until) {
        const d = new Date(q.until)
        if (!Number.isNaN(d.getTime())) qb.where('m.date_created', '<=', d)
      }
      if (q.attachments === '1') qb.whereNotNull('m.attachments').where('m.attachments', '<>', '[]')
      if (q.include_deleted !== '1') qb.whereNull('m.deleted_at')
    })

    const [{ n }] = (await base.clone().count({ n: '*' })) as Array<{ n: number | string }>
    const masqCol = await hasColumn('chat_messages', 'masquerade_admin')
    const rows = (await base
      .clone()
      .orderBy('m.id', 'desc')
      .offset((page - 1) * limit)
      .limit(limit)
      .select(
        'm.id',
        'm.room',
        'm.sender',
        'm.sender_name',
        'm.message',
        'm.date_created',
        'm.edited_at',
        'm.deleted_at',
        'm.attachments',
        ...(masqCol ? ['m.masquerade_admin'] : [])
      )) as Array<Record<string, unknown>>

    const rooms = await describeRooms([...new Set(rows.map((r) => String(r.room)))])
    const ids = rows.map((r) => Number(r.id))
    const reactionCounts = ids.length
      ? ((await db('nivaro_chat_reactions')
          .whereIn('message_id', ids)
          .groupBy('message_id')
          .select('message_id')
          .count({ n: '*' })) as Array<{ message_id: number; n: number | string }>)
      : []
    const reactions = new Map(reactionCounts.map((r) => [Number(r.message_id), Number(r.n)]))

    logRead(
      req,
      'chat-admin-search',
      `Searched chat messages: ${
        Object.entries(q)
          .filter(([k, v]) => v && !['page', 'limit'].includes(k))
          .map(([k, v]) => `${k}=${v}`)
          .join(', ') || 'no filters'
      } (page ${page}, ${rows.length} shown)`
    )

    return reply.send({
      total: Number(n),
      data: rows.map((r) => {
        const room = rooms.get(String(r.room))
        return {
          id: r.id,
          room: r.room,
          kind: room?.kind ?? 'record',
          room_label: room?.label ?? r.room,
          participants: (room?.participants ?? []).slice(0, 12),
          participant_count: room?.participants.length ?? 0,
          sender: r.sender,
          sender_name: r.sender_name,
          message: r.message,
          date_created: r.date_created,
          edited_at: r.edited_at ?? null,
          deleted_at: r.deleted_at ?? null,
          attachment_count: parseIdList(r.attachments).length,
          reaction_count: reactions.get(Number(r.id)) ?? 0,
          masquerade: !!r.masquerade_admin
        }
      })
    })
  })

  // ── One message, fully ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/messages/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const msg = (await db('chat_messages').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!msg) return reply.code(404).send({ error: 'Message not found' })
    const room = String(msg.room)
    const [before, after] = await Promise.all([
      db('chat_messages')
        .where('room', room)
        .where('id', '<', id)
        .orderBy('id', 'desc')
        .limit(10)
        .select(
          'id',
          'sender',
          'sender_name',
          'message',
          'date_created',
          'edited_at',
          'deleted_at'
        ),
      db('chat_messages')
        .where('room', room)
        .where('id', '>', id)
        .orderBy('id', 'asc')
        .limit(10)
        .select('id', 'sender', 'sender_name', 'message', 'date_created', 'edited_at', 'deleted_at')
    ])
    const described = (await describeRooms([room])).get(room)

    // Who has read it: each member's read watermark against the send time.
    const marks = (await db('nivaro_chat_memberships as mb')
      .leftJoin('nivaro_users as u', 'u.id', 'mb.user')
      .where('mb.room', room)
      .select('mb.user', 'mb.last_read_at', 'u.first_name', 'u.last_name', 'u.email')) as Array<
      Record<string, unknown>
    >
    const sent = new Date(String(msg.date_created)).getTime()
    const reads = marks.map((m) => {
      const at = m.last_read_at ? new Date(String(m.last_read_at)).getTime() : 0
      return {
        user: m.user,
        name: nameOf(m),
        read: at >= sent,
        last_read_at: m.last_read_at ?? null
      }
    })

    const reactionRows = (await db('nivaro_chat_reactions as r')
      .leftJoin('nivaro_users as u', 'u.id', 'r.user')
      .where('r.message_id', id)
      .select('r.emoji', 'r.user', 'u.first_name', 'u.last_name', 'u.email')) as Array<
      Record<string, unknown>
    >
    const attachmentIds = parseIdList(msg.attachments)
    const files = attachmentIds.length
      ? ((await db('nivaro_files')
          .whereIn('id', attachmentIds)
          .select('id', 'title', 'filename_download', 'type', 'filesize')) as Array<
          Record<string, unknown>
        >)
      : []
    const mentions = [...String(msg.message ?? '').matchAll(MENTION_RE)].map((m) => m[1])
    const allHistory = (await db('nivaro_activity')
      .where({ collection: 'chat_messages', item: String(id) })
      .orderBy('timestamp', 'asc')
      .select('action', 'user', 'timestamp', 'comment')) as Array<Record<string, unknown>>
    // Administrators opening this message are summarised, not listed — the
    // message's own history is what it went through, not who looked at it.
    const views = allHistory.filter((h) => String(h.action).startsWith('chat-admin-'))
    const history = allHistory.filter((h) => !String(h.action).startsWith('chat-admin-'))
    const actorIds = [
      ...new Set(
        [...history.map((h) => h.user), ...views.slice(-1).map((v) => v.user), msg.masquerade_admin]
          .filter(Boolean)
          .map((x) => String(x))
      )
    ]
    const actors = actorIds.length
      ? ((await db('nivaro_users')
          .whereIn('id', actorIds)
          .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>)
      : []
    const actorName = new Map(actors.map((a) => [String(a.id).toUpperCase(), nameOf(a)]))
    const saved = Number(
      (
        (await db('nivaro_chat_saved').where('message_id', id).count({ n: '*' }).first()) as
          | { n?: number | string }
          | undefined
      )?.n ?? 0
    )
    const pinned = !!(await db('nivaro_chat_pins').where('message_id', id).first('id'))

    logRead(req, 'chat-admin-read', `Opened a chat message in ${room}`, String(id))

    return reply.send({
      data: {
        message: {
          id: msg.id,
          room,
          sender: msg.sender,
          sender_name: msg.sender_name,
          message: msg.message,
          date_created: msg.date_created,
          edited_at: msg.edited_at ?? null,
          deleted_at: msg.deleted_at ?? null,
          masquerade_admin: msg.masquerade_admin ?? null,
          masquerade_admin_name: msg.masquerade_admin
            ? (actorName.get(String(msg.masquerade_admin).toUpperCase()) ?? 'an administrator')
            : null
        },
        room: {
          room,
          kind: described?.kind ?? 'record',
          label: described?.label ?? room,
          participants: described?.participants ?? []
        },
        mentions,
        attachments: files.map((f) => ({
          id: f.id,
          name: f.title || f.filename_download,
          type: f.type,
          size: f.filesize != null ? Number(f.filesize) : null
        })),
        reactions: reactionRows.map((r) => ({ emoji: r.emoji, user: r.user, name: nameOf(r) })),
        reads,
        saved_by: saved,
        pinned,
        admin_views: {
          // This read is logged after the answer is built, so it counts as one more.
          count: views.length + 1,
          previous: views.length
            ? {
                by: views[views.length - 1].user
                  ? (actorName.get(String(views[views.length - 1].user).toUpperCase()) ?? null)
                  : null,
                at: views[views.length - 1].timestamp
              }
            : null
        },
        history: history.map((h) => ({
          action: h.action,
          at: h.timestamp,
          by: h.user ? (actorName.get(String(h.user).toUpperCase()) ?? null) : null,
          comment: h.comment
        })),
        context: {
          before: (before as Array<Record<string, unknown>>).reverse(),
          after
        }
      }
    })
  })
}
