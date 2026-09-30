import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { linkTo } from './app-links.js'
import { canSeeRoom, channels, generalChannel, parseRoom } from './chat.js'
import { recordChatSend, recordChatSendFailure } from './chat-health.js'
import { parseTimeRefs, type TimeRef } from './chat-time-refs.js'

/**
 * The one way a chat message is posted (#927–#989).
 *
 * People (the send route), the assistant, flows ("chat-post"), extensions
 * (ctx.chat.post), scheduled sends and record-activity lines all come through
 * here, so a message gets the same checks and the same fan-out whoever wrote
 * it: visibility, announce channels, thread and quote validation, the mention
 * notifications, DM push + out-of-office auto-reply, @channel / @here,
 * urgent, the email fallback for unread DMs and the chat-message flow trigger.
 */

export class ChatSendError extends Error {
  statusCode: number
  code: string
  constructor(statusCode: number, message: string, code = 'CHAT_SEND_REFUSED') {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

export interface PostChatInput {
  room: string
  message: string
  attachments?: string[]
  /** User ids picked from the @ list. */
  mentions?: string[]
  /** Reply in the thread under this message. */
  parentId?: number | null
  /** Quote this message above the new one. */
  quoteId?: number | null
  urgent?: boolean
  /** The sender's own id for this message (retries never send twice). */
  clientId?: string | null
  noPreview?: boolean
}

export interface PostChatActor {
  /** The person sending. Null for a platform line (record activity, flows). */
  user: User | null
  /** Override the sender row (the assistant posts as its own user). */
  senderId?: string | null
  senderName?: string | null
  isAdmin?: boolean
  masqueradeAdminId?: string | null
  /** A platform line: stored with is_system, never pages anyone. */
  system?: boolean
  /** Already checked by the caller (flows validate their own room). */
  skipVisibility?: boolean
}

export interface ChatRow {
  id: number
  room: string
  message: string
  sender: string | null
  sender_name: string | null
  date_created: string
  attachments: string[]
  reactions: unknown[]
  parent_id: number | null
  quote_id: number | null
  urgent: boolean
  is_system: boolean
  no_preview: boolean
  client_id: string | null
  mentions: string[]
  time_refs: TimeRef[]
  masquerade_admin?: string | null
  masquerade_admin_name?: string | null
  /** A retry that matched an earlier send — nothing was re-sent. */
  duplicate?: boolean
}

/** Optional columns written only where migration 370 has run. */
const OPTIONAL = [
  'parent_id',
  'quote_id',
  'urgent',
  'is_system',
  'no_preview',
  'client_id',
  'mentions',
  'time_refs',
  'masquerade_admin'
] as const
type OptionalCol = (typeof OPTIONAL)[number]

export async function chatColumns(): Promise<Set<OptionalCol>> {
  const out = new Set<OptionalCol>()
  const found = await Promise.all(OPTIONAL.map((c) => hasColumn('chat_messages', c)))
  OPTIONAL.forEach((c, i) => {
    if (found[i]) out.add(c)
  })
  return out
}

/** Urgent messages a person may send per hour — a bullhorn, not a habit. */
const URGENT_PER_HOUR = 5

function nameOf(u: Record<string, unknown> | null | undefined): string | null {
  if (!u) return null
  return (
    [u.first_name, u.last_name].filter(Boolean).join(' ').trim() ||
    (u.email ? String(u.email) : null)
  )
}

export function parseJsonList<T = string>(raw: unknown): T[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw as T[]
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

// ── Memberships ─────────────────────────────────────────────────────────────

export interface MembershipPatch {
  is_muted?: boolean
  last_read_at?: Date
  notify_mode?: string | null
  archived_at?: Date | null
  starred?: boolean
  welcome_seen_at?: Date | null
  dm_emailed_at?: Date | null
}

export async function upsertMembership(
  user: string,
  room: string,
  patch: MembershipPatch
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

export async function touchWatermark(user: string, room: string): Promise<void> {
  await upsertMembership(user, room, { last_read_at: new Date() })
}

/** Muted OR archived — either way the person asked not to be told. */
export async function isMuted(user: string, room: string): Promise<boolean> {
  const row = await db('nivaro_chat_memberships').where({ user, room }).first()
  return !!row?.is_muted || !!row?.archived_at
}

// ── Reading a message back ──────────────────────────────────────────────────

export async function loadMessage(id: number): Promise<Record<string, unknown> | undefined> {
  if (!Number.isFinite(id) || id <= 0) return undefined
  return (await db('chat_messages').where({ id }).first()) as Record<string, unknown> | undefined
}

// ── Post ────────────────────────────────────────────────────────────────────

export async function postChatMessage(
  app: FastifyInstance,
  actor: PostChatActor,
  input: PostChatInput
): Promise<ChatRow> {
  const started = Date.now()
  try {
    const row = await postInner(app, actor, input)
    recordChatSend(Date.now() - started)
    return row
  } catch (err) {
    if (!(err instanceof ChatSendError) || err.statusCode >= 500) {
      recordChatSendFailure(err instanceof Error ? err.message : String(err))
    }
    throw err
  }
}

async function postInner(
  app: FastifyInstance,
  actor: PostChatActor,
  input: PostChatInput
): Promise<ChatRow> {
  const room = String(input.room ?? '').trim()
  const message = String(input.message ?? '')
    .replace(/\s+$/, '')
    .replace(/^\n+/, '')
    .slice(0, 8000)
  const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
    .map(String)
    .filter((a) => /^[0-9a-f-]{36}$/i.test(a))
    .slice(0, 10)
  if (!room || (!message.trim() && attachments.length === 0)) {
    throw new ChatSendError(400, 'room and message are required')
  }
  const user = actor.user
  if (!actor.skipVisibility) {
    if (!user) throw new ChatSendError(403, 'That conversation is not available to you')
    if (!(await canSeeRoom(user, room))) {
      throw new ChatSendError(403, 'That conversation is not available to you')
    }
  }
  const cols = await chatColumns()
  const senderId = actor.senderId !== undefined ? actor.senderId : (user?.id ?? null)
  const senderName =
    actor.senderName !== undefined
      ? actor.senderName
      : nameOf(user as unknown as Record<string, unknown>)
  const system = !!actor.system
  const clientId = input.clientId ? String(input.clientId).slice(0, 64) : null

  // A retry of a send that already landed returns the stored row.
  if (clientId && cols.has('client_id') && senderId) {
    const prior = (await db('chat_messages')
      .where({ client_id: clientId, room })
      .whereRaw('UPPER(CAST(sender AS NVARCHAR(36))) = ?', [String(senderId).toUpperCase()])
      .first()) as Record<string, unknown> | undefined
    if (prior) return { ...toRow(prior), duplicate: true }
  }

  // Thread replies always hang off the root, never off another reply.
  let parentId: number | null = null
  if (input.parentId != null && cols.has('parent_id')) {
    const parent = await loadMessage(Number(input.parentId))
    if (!parent || String(parent.room) !== room) {
      throw new ChatSendError(400, 'That thread is not in this conversation')
    }
    if (parent.deleted_at && !parent.parent_id) {
      // A removed root still holds its thread together — replies may continue.
    }
    parentId = parent.parent_id ? Number(parent.parent_id) : Number(parent.id)
  }
  let quoteId: number | null = null
  if (input.quoteId != null && cols.has('quote_id')) {
    const quoted = await loadMessage(Number(input.quoteId))
    if (!quoted || String(quoted.room) !== room) {
      throw new ChatSendError(400, 'You can only quote a message from this conversation')
    }
    quoteId = Number(quoted.id)
  }

  // Announcement channels: members read, react and reply in threads.
  const parsedRoom = parseRoom(room)
  if ((parsedRoom.kind === 'channel' || parsedRoom.kind === 'global') && !system && !parentId) {
    const ch = (
      parsedRoom.kind === 'global'
        ? await generalChannel()
        : (await channels()).get(parsedRoom.channelKey ?? '')
    ) as (Record<string, unknown> & { created_by?: string | null }) | undefined
    if (ch?.announce) {
      const owner = String(ch.created_by ?? '').toUpperCase() === String(senderId).toUpperCase()
      if (!owner && !actor.isAdmin) {
        throw new ChatSendError(
          403,
          'Only the channel owner and admins post here. Reply in a thread instead.',
          'ANNOUNCE_ONLY'
        )
      }
    }
  }

  // Urgent: rate-limited per sender, and never from a platform line.
  let urgent = !!input.urgent && !system && cols.has('urgent')
  if (urgent && senderId) {
    const recent = (await db('chat_messages')
      .where({ urgent: true })
      .whereRaw('UPPER(CAST(sender AS NVARCHAR(36))) = ?', [String(senderId).toUpperCase()])
      .where('date_created', '>=', new Date(Date.now() - 3600_000))
      .count({ n: 'id' })
      .first()) as { n?: number | string } | undefined
    if (Number(recent?.n ?? 0) >= URGENT_PER_HOUR) {
      throw new ChatSendError(
        429,
        `You have sent ${URGENT_PER_HOUR} urgent messages in the last hour. Send it as a normal message, or wait a little.`,
        'URGENT_RATE_LIMITED'
      )
    }
  }
  if (!senderId) urgent = false

  // Mentions: only ids that are real people, capped.
  const mentionIds = [
    ...new Set((input.mentions ?? []).map((m) => String(m).toUpperCase()).filter(Boolean))
  ].slice(0, 20)

  // Times, read in the sender's own zone.
  let timeRefs: TimeRef[] = []
  if (cols.has('time_refs') && message && !system) {
    try {
      const { userTimeZone } = await import('./user-time.js')
      timeRefs = parseTimeRefs(message, await userTimeZone(user))
    } catch {
      timeRefs = []
    }
  }

  const masq = actor.masqueradeAdminId ?? null
  const now = new Date()
  const insert: Record<string, unknown> = {
    room,
    message,
    sender: senderId,
    sender_name: senderName,
    date_created: now,
    attachments: attachments.length ? JSON.stringify(attachments) : null
  }
  if (cols.has('masquerade_admin') && masq) insert.masquerade_admin = masq
  if (cols.has('parent_id') && parentId) insert.parent_id = parentId
  if (cols.has('quote_id') && quoteId) insert.quote_id = quoteId
  if (cols.has('urgent') && urgent) insert.urgent = true
  if (cols.has('is_system') && system) insert.is_system = true
  if (cols.has('no_preview') && input.noPreview) insert.no_preview = true
  if (cols.has('client_id') && clientId) insert.client_id = clientId
  if (cols.has('mentions') && mentionIds.length) insert.mentions = JSON.stringify(mentionIds)
  if (cols.has('time_refs') && timeRefs.length) insert.time_refs = JSON.stringify(timeRefs)

  const [inserted] = await db('chat_messages').insert(insert).returning('id')
  const id = Number(
    typeof inserted === 'object' && inserted !== null ? (inserted as { id: number }).id : inserted
  )

  let masqName: string | null = null
  if (masq) {
    const a = (await db('nivaro_users')
      .where({ id: masq })
      .first('first_name', 'last_name', 'email')) as Record<string, unknown> | undefined
    masqName = nameOf(a)
  }

  const row: ChatRow = {
    id,
    room,
    message,
    sender: senderId,
    sender_name: senderName,
    date_created: now.toISOString(),
    attachments,
    reactions: [],
    parent_id: parentId,
    quote_id: quoteId,
    urgent,
    is_system: system,
    no_preview: !!input.noPreview,
    client_id: clientId,
    mentions: mentionIds,
    time_refs: timeRefs,
    masquerade_admin: masq,
    masquerade_admin_name: masqName
  }

  // chat_messages is accountability='activity'; this raw insert bypasses the
  // items hooks, so write the activity row it would have produced.
  void logActivity({
    action: 'create',
    user: senderId,
    collection: 'chat_messages',
    item: String(id),
    comment: `room ${room}${parentId ? ` · thread ${parentId}` : ''}${urgent ? ' · urgent' : ''}`
  })
  if (urgent) {
    void logActivity({
      action: 'chat-urgent',
      user: senderId,
      collection: 'chat_messages',
      item: String(id),
      comment: `room ${room}`
    })
  }

  // Live delivery: the room, plus both DM participants' own rooms (the
  // recipient of a brand-new DM has not joined a room they don't know of).
  app.io?.to(`chat:${room}`).emit('chat:message', row)
  if (parsedRoom.kind === 'dm') {
    for (const p of parsedRoom.participants ?? []) app.io?.to(`user:${p}`).emit('chat:message', row)
  }

  if (!system && senderId) {
    void fanOut(app, actor, row, parsedRoom).catch((err) =>
      app.log.warn({ err, room }, 'chat fan-out failed')
    )
    // Sending is also reading; writing in an archived room brings it back.
    if (user && String(user.id).toUpperCase() === String(senderId).toUpperCase()) {
      await touchWatermark(String(senderId), room)
      await db('nivaro_chat_memberships')
        .where({ user: String(senderId), room })
        .whereNotNull('archived_at')
        .update({ archived_at: null })
        .catch(() => {})
    }
  }
  return row
}

export function toRow(r: Record<string, unknown>): ChatRow {
  return {
    id: Number(r.id),
    room: String(r.room),
    message: r.deleted_at ? '' : String(r.message ?? ''),
    sender: r.sender ? String(r.sender) : null,
    sender_name: r.sender_name ? String(r.sender_name) : null,
    date_created: new Date(String(r.date_created)).toISOString(),
    attachments: r.deleted_at ? [] : parseJsonList(r.attachments),
    reactions: [],
    parent_id: r.parent_id ? Number(r.parent_id) : null,
    quote_id: r.quote_id ? Number(r.quote_id) : null,
    urgent: !!r.urgent,
    is_system: !!r.is_system,
    no_preview: !!r.no_preview,
    client_id: r.client_id ? String(r.client_id) : null,
    mentions: parseJsonList(r.mentions),
    time_refs: parseJsonList<TimeRef>(r.time_refs)
  }
}

// ── Fan-out (after the row is stored; never fails the send) ─────────────────

async function fanOut(
  app: FastifyInstance,
  actor: PostChatActor,
  row: ChatRow,
  parsedRoom: ReturnType<typeof parseRoom>
): Promise<void> {
  const { notifyUser } = await import('./notification-channels.js')
  const room = row.room
  const senderId = String(row.sender)
  const senderName = row.sender_name
  const text = row.message
  const told = new Set<string>([senderId.toUpperCase()])

  // ── DMs: push (grouped per room, inline reply), OOO auto-reply, email fallback
  if (parsedRoom.kind === 'dm') {
    const peer = (parsedRoom.participants ?? []).find((p) => p !== senderId.toUpperCase())
    if (peer) {
      if (row.urgent) {
        told.add(peer)
        await notifyUser(app, peer, {
          subject: `Critical: urgent message from ${senderName ?? 'someone'}`,
          message: text.slice(0, 300) || 'Sent an attachment',
          category: 'mentions',
          always_inbox: true,
          sender: senderId,
          collection: '__chat__',
          item: room
        }).catch(() => {})
      } else if (!(await isMuted(peer, room))) {
        const { sendWebPush } = await import('./web-push.js')
        void sendWebPush(peer, {
          title: senderName ?? 'New message',
          body: text.slice(0, 200) || 'Sent an attachment',
          tag: `chat-${room}`,
          room,
          url: await linkTo('chat', { room }, { recipientUserId: peer }).catch(() => null),
          reply_token: await mintReplyToken(app, peer, room)
        })
      }
      void outOfOfficeReply(app, room, peer)
      scheduleEmailFallback(app, peer, room)
    }
  }

  // ── Group DMs: urgent reaches every member
  if (parsedRoom.kind === 'channel' && row.urgent) {
    const ch = (await channels()).get(parsedRoom.channelKey ?? '')
    if (ch?.is_direct) {
      const members = (await db('nivaro_chat_memberships')
        .where({ room })
        .select('user')) as Array<{ user: string }>
      for (const m of members.slice(0, 50)) {
        const uid = String(m.user).toUpperCase()
        if (told.has(uid)) continue
        told.add(uid)
        await notifyUser(app, m.user, {
          subject: `Critical: urgent message from ${senderName ?? 'someone'}`,
          message: text.slice(0, 300),
          category: 'mentions',
          always_inbox: true,
          sender: senderId,
          collection: '__chat__',
          item: room
        }).catch(() => {})
      }
    }
  }

  // ── @channel / @here: channel rooms only, owner or admin
  const bullhorn = /(^|\s)@channel\b/.test(text)
    ? 'channel'
    : /(^|\s)@here\b/.test(text)
      ? 'here'
      : null
  if (bullhorn && parsedRoom.kind === 'channel') {
    const ch = (await db('nivaro_chat_channels')
      .where({ key: parsedRoom.channelKey })
      .first('created_by', 'name')) as { created_by?: string | null; name?: string } | undefined
    const allowed =
      actor.isAdmin || String(ch?.created_by ?? '').toUpperCase() === senderId.toUpperCase()
    if (allowed) {
      let members = (
        (await db('nivaro_chat_memberships').where({ room }).select('user')) as Array<{
          user: string
        }>
      ).map((m) => String(m.user))
      if (bullhorn === 'here') {
        const online = await onlineUserIds(members)
        members = members.filter((m) => online.has(m.toUpperCase()))
      }
      const { buildMentionMail } = await import('./mail-builders.js')
      const built = await buildMentionMail({
        senderId,
        senderName,
        room,
        message: text,
        channelWide: true
      }).catch(() => null)
      for (const m of members.slice(0, 300)) {
        const uid = m.toUpperCase()
        if (told.has(uid)) continue
        if (await isMuted(m, room)) continue
        told.add(uid)
        await notifyUser(app, m, {
          subject: `@${bullhorn} in ${ch?.name ?? parsedRoom.channelKey}`,
          category: 'mentions',
          message: `${senderName ?? 'Someone'}: ${text.slice(0, 300)}`,
          sender: senderId,
          collection: '__chat__',
          item: room,
          ...(built ? { template: built.template, template_data: built.data } : {})
        }).catch(() => {})
      }
    }
  }

  // ── Explicit mentions: only people who can see the room and haven't muted it
  for (const target of row.mentions) {
    if (told.has(target.toUpperCase())) continue
    const targetUser = (await db('nivaro_users').where('id', target).first()) as User | undefined
    if (!targetUser) continue
    if (!(await canSeeRoom(targetUser, room))) continue
    if (!row.urgent && (await isMuted(target, room))) continue
    told.add(target.toUpperCase())
    const { buildMentionMail } = await import('./mail-builders.js')
    const built = await buildMentionMail({ senderId, senderName, room, message: text }).catch(
      () => null
    )
    const { renderNotificationTemplate } = await import('./notification-templates.js')
    const templated = await renderNotificationTemplate('chat_mention', {
      actor: senderName ?? 'Someone',
      room,
      text: text.slice(0, 300)
    }).catch(() => null)
    await notifyUser(app, target, {
      subject: row.urgent
        ? `Critical: urgent mention from ${senderName ?? 'someone'}`
        : (templated?.subject ?? `${senderName ?? 'Someone'} mentioned you in chat`),
      message: templated?.message || text.slice(0, 300),
      category: 'mentions',
      always_inbox: true,
      sender: senderId,
      collection: '__chat__',
      item: room,
      ...(built ? { template: built.template, template_data: built.data } : {})
    }).catch(() => {})
  }

  // ── Thread replies tell the root's author and everyone who replied before
  if (row.parent_id) {
    const root = await loadMessage(row.parent_id)
    const repliers = (await db('chat_messages')
      .where({ parent_id: row.parent_id })
      .whereNotNull('sender')
      .distinct('sender')) as Array<{ sender: string }>
    const followers = [
      ...new Set(
        [root?.sender, ...repliers.map((r) => r.sender)]
          .filter(Boolean)
          .map((s) => String(s).toUpperCase())
      )
    ]
    for (const f of followers.slice(0, 30)) {
      if (told.has(f)) continue
      const u = (await db('nivaro_users').where('id', f).first()) as User | undefined
      if (!u || !(await canSeeRoom(u, room)) || (await isMuted(f, room))) continue
      told.add(f)
      const mine = String(root?.sender ?? '').toUpperCase() === f
      await notifyUser(app, f, {
        subject: mine
          ? `${senderName ?? 'Someone'} replied to your message`
          : `${senderName ?? 'Someone'} replied in a thread you are in`,
        message: text.slice(0, 300),
        category: 'mentions',
        sender: senderId,
        collection: '__chat__',
        item: room
      }).catch(() => {})
    }
  }

  // ── The assistant
  const { botUserId, chatBotName, handleBotMention, mentionsBot } = await import('./chat-bot.js')
  const botName = await chatBotName()
  const bot = botName ? (await botUserId().catch(() => null))?.toUpperCase() : null
  if (botName && text && actor.user && senderId.toUpperCase() !== bot) {
    if (mentionsBot(text, botName)) {
      void handleBotMention(app, actor.user, room, text)
    } else if (parsedRoom.kind === 'dm' && bot && (parsedRoom.participants ?? []).includes(bot)) {
      void handleBotMention(app, actor.user, room, text)
    }
  }

  // ── Flow trigger (#971): people's messages only — never the bot's, which
  // would let a flow that posts into a room trigger itself.
  if (senderId.toUpperCase() !== bot) {
    const { emitTrigger } = await import('../flows/registry.js')
    emitTrigger(
      'chat-message',
      {
        room,
        room_kind: parsedRoom.kind,
        room_prefix: parsedRoom.kind === 'entity' ? (parsedRoom.prefix ?? null) : null,
        room_token: parsedRoom.kind === 'entity' ? (parsedRoom.token ?? null) : null,
        message_id: row.id,
        parent_id: row.parent_id,
        sender: senderId,
        sender_name: senderName,
        text,
        has_attachments: row.attachments.length > 0,
        urgent: row.urgent
      },
      app.log,
      senderId
    )
  }
}

/** People online right now among `ids` (presence heartbeat within 70s). */
async function onlineUserIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const since = new Date(Date.now() - 70_000)
  const rows = (await db('user_presence')
    .whereIn('user_id', ids.slice(0, 500))
    .where('last_seen', '>=', since)
    .where((q) => q.whereNull('is_online').orWhere('is_online', true))
    .select('user_id')
    .catch(() => [])) as Array<{ user_id: string }>
  return new Set(rows.map((r) => String(r.user_id).toUpperCase()))
}

/** One-time token a push notification's inline Reply posts with (#956). */
export async function mintReplyToken(
  app: FastifyInstance,
  user: string,
  room: string
): Promise<string | null> {
  const redis = (app as unknown as { redis?: { set: (...a: unknown[]) => Promise<unknown> } }).redis
  if (!redis) return null
  const token = randomUUID()
  try {
    await redis.set(`nvr:chatreply:${token}`, JSON.stringify({ user, room }), 'EX', 3 * 24 * 3600)
    return token
  } catch {
    return null
  }
}

export async function redeemReplyToken(
  app: FastifyInstance,
  token: string
): Promise<{ user: string; room: string } | null> {
  const redis = (
    app as unknown as {
      redis?: { get: (k: string) => Promise<string | null>; del: (k: string) => Promise<unknown> }
    }
  ).redis
  if (!redis || !/^[0-9a-f-]{36}$/i.test(token)) return null
  try {
    const raw = await redis.get(`nvr:chatreply:${token}`)
    if (!raw) return null
    // Usable for a burst of replies from the same notification, not forever.
    return JSON.parse(raw) as { user: string; room: string }
  } catch {
    return null
  }
}

// ── Out-of-office auto-reply ────────────────────────────────────────────────

async function outOfOfficeReply(app: FastifyInstance, room: string, peer: string): Promise<void> {
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
      delegateName = nameOf(d) ?? ''
    }
    const pName = nameOf(p) || 'This person'
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
}

// ── Email fallback for unread DMs (#965) ────────────────────────────────────

export const DM_EMAIL_AFTER_MS = 30 * 60_000

function scheduleEmailFallback(app: FastifyInstance, user: string, room: string): void {
  const t = setTimeout(() => {
    void emailUnreadDm(app, user, room).catch(() => {})
  }, DM_EMAIL_AFTER_MS + 5_000)
  t.unref?.()
}

function prefsOf(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Email one person about a DM they have not read for 30 minutes — once per
 * unread stretch (the claim is `dm_emailed_at` older than the first unread
 * message). Opt-in per person; quiet hours and mail test mode apply.
 */
export async function emailUnreadDm(
  _app: FastifyInstance,
  user: string,
  room: string
): Promise<boolean> {
  if (!(await hasColumn('nivaro_chat_memberships', 'dm_emailed_at'))) return false
  const u = (await db('nivaro_users')
    .where({ id: user })
    .first('id', 'email', 'first_name', 'status', 'preferences')) as
    | Record<string, unknown>
    | undefined
  if (!u?.email || u.status === 'suspended') return false
  if (prefsOf(u.preferences).chat_email_fallback !== true) return false
  const membership = (await db('nivaro_chat_memberships').where({ user, room }).first()) as
    | Record<string, unknown>
    | undefined
  if (membership?.is_muted || membership?.archived_at) return false
  const readAt = membership?.last_read_at ? new Date(String(membership.last_read_at)) : null
  const unread = (await db('chat_messages')
    .where({ room })
    .whereNull('deleted_at')
    .whereRaw('UPPER(CAST(sender AS NVARCHAR(36))) <> ?', [String(user).toUpperCase()])
    .modify((q) => {
      if (readAt) q.where('date_created', '>', readAt)
    })
    .where('date_created', '>=', new Date(Date.now() - 24 * 3600_000))
    .orderBy('id', 'asc')
    .limit(20)
    .select('id', 'sender_name', 'message', 'date_created')) as Array<Record<string, unknown>>
  if (unread.length === 0) return false
  const first = new Date(String(unread[0].date_created))
  if (Date.now() - first.getTime() < DM_EMAIL_AFTER_MS) return false
  const emailedAt = membership?.dm_emailed_at ? new Date(String(membership.dm_emailed_at)) : null
  if (emailedAt && emailedAt >= first) return false

  // Claim: only one deliverer (timer or sweep) wins the stretch.
  await upsertMembership(user, room, {})
  const claimed = Number(
    await db('nivaro_chat_memberships')
      .where({ user, room })
      .andWhere((q) => q.whereNull('dm_emailed_at').orWhere('dm_emailed_at', '<', first))
      .update({ dm_emailed_at: new Date() })
  )
  if (!claimed) return false

  const who = String(unread[unread.length - 1].sender_name ?? 'Someone')
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const lines = unread
    .slice(-8)
    .map(
      (m) =>
        `<p style="margin:0 0 8px"><strong>${esc(String(m.sender_name ?? 'Someone'))}</strong>: ${esc(
          String(m.message ?? '').slice(0, 400)
        )}</p>`
    )
    .join('')
  const { linkTo } = await import('./app-links.js').catch(() => ({ linkTo: null }))
  let url: string | null = null
  try {
    url = linkTo ? await linkTo('chat', { room }, { recipientUserId: user }) : null
  } catch {
    url = null
  }
  const { sendRawMail } = await import('./mail.js')
  await sendRawMail({
    to: String(u.email),
    subject: `${who} sent you ${unread.length === 1 ? 'a message' : `${unread.length} messages`}`,
    title: 'Unread messages',
    html: `${lines}${url ? `<p style="margin:16px 0 0"><a href="${esc(url)}">Open the conversation</a></p>` : ''}`,
    category: 'mentions',
    why: 'You turned on email for direct messages you have not read for 30 minutes.'
  })
  void logActivity({
    action: 'chat-dm-email-fallback',
    user,
    collection: 'chat_messages',
    item: String(unread[unread.length - 1].id),
    comment: `room ${room}`
  })
  return true
}

/** The sweep: DMs whose recipient opted in and has unread for 30+ minutes. */
export async function sweepDmEmailFallback(app: FastifyInstance): Promise<number> {
  const people = (await db('nivaro_users')
    .where('preferences', 'like', '%"chat_email_fallback":true%')
    .whereNot('status', 'suspended')
    .select('id')
    .catch(() => [])) as Array<{ id: string }>
  let sent = 0
  const since = new Date(Date.now() - 24 * 3600_000)
  const until = new Date(Date.now() - DM_EMAIL_AFTER_MS)
  for (const p of people.slice(0, 500)) {
    const uid = String(p.id).toUpperCase()
    const rooms = (await db('chat_messages')
      .distinct('room')
      .where('room', 'like', 'dm:%')
      .andWhere((q) =>
        q.where('room', 'like', `dm:${uid}:%`).orWhere('room', 'like', `dm:%:${uid}`)
      )
      .where('date_created', '>=', since)
      .where('date_created', '<=', until)
      .then((rows) => (rows as Array<{ room: string }>).map((r) => String(r.room)))) as string[]
    for (const room of [...new Set(rooms)]) {
      if (await emailUnreadDm(app, p.id, room).catch(() => false)) sent++
    }
  }
  return sent
}
