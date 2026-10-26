import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import { canSeeRoom, channelByKey, channels, findChannelRow } from '../services/chat.js'
import {
  answerArchiveSuggestion,
  archiveOverview,
  setIdleDays,
  suggestIdleChannels
} from '../services/chat-archive.js'
import {
  clearDraft,
  DRAFT_MAX_CHARS,
  getDraft,
  listDrafts,
  saveDraft
} from '../services/chat-drafts.js'
import {
  cleanShortcode,
  EMOJI_MAX_BYTES,
  emojiReady,
  listEmoji,
  SHORTCODE_RE,
  sniffImageType
} from '../services/chat-emoji.js'
import { historyItemsFor, loadMembershipHistory } from '../services/chat-membership-history.js'
import { deleteFile, getFile, readFileBuffer, uploadFileBuffer } from '../services/files.js'

/**
 * Chat room extras, registered inside chatRoutes (so `authenticate` already
 * ran): custom emoji (#2459), draft sync (#2474), idle-channel archive
 * suggestions (#2485) and membership history (#2784). Kept out of chat.ts so
 * the hot file takes one registration line.
 */
export function registerChatExtras(app: FastifyInstance): void {
  const forbidden = { error: 'That conversation is not available to you' }

  // ── Custom emoji (#2459) ─────────────────────────────────────────────────

  app.get('/emoji', async (req, reply) => {
    await resolveWorkspace(req, reply)
    return { data: await listEmoji(req.workspaceId ?? null) }
  })

  /** Admin upload: `POST /chat/emoji?shortcode=party_parrot` with the image as multipart. */
  app.post('/emoji', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Only an admin can add emoji' })
    if (!(await emojiReady()))
      return reply.code(503).send({ error: 'Custom emoji need the latest database update' })
    const shortcode = cleanShortcode((req.query as { shortcode?: string }).shortcode)
    if (!SHORTCODE_RE.test(shortcode))
      return reply.code(400).send({
        error: 'Shortcode must be 2-40 characters: lowercase letters, numbers, _ + or -'
      })
    const multipart = await req.file({ limits: { fileSize: EMOJI_MAX_BYTES + 1 } })
    if (!multipart) return reply.code(400).send({ error: 'No image provided' })
    const buffer = await multipart.toBuffer()
    if (buffer.length > EMOJI_MAX_BYTES || multipart.file.truncated)
      return reply
        .code(413)
        .send({ error: `Emoji images are limited to ${Math.round(EMOJI_MAX_BYTES / 1024)} KB` })
    const type = sniffImageType(buffer)
    if (!type)
      return reply.code(415).send({ error: 'Emoji must be a PNG, GIF, JPEG or WebP image' })
    await resolveWorkspace(req, reply)
    const workspace = req.workspaceId ?? null
    const taken = await db('nivaro_chat_emoji')
      .where({ shortcode })
      .where((q) => {
        q.whereNull('workspace')
        if (workspace) q.orWhere('workspace', workspace)
      })
      .first('id')
    if (taken) return reply.code(409).send({ error: `:${shortcode}: already exists` })
    const ext = type === 'image/jpeg' ? 'jpg' : type.slice(6)
    const file = await uploadFileBuffer(
      req.user!,
      buffer,
      `emoji-${shortcode}.${ext}`,
      type,
      undefined,
      {
        private: true
      }
    )
    try {
      await db('nivaro_chat_emoji').insert({
        workspace,
        shortcode,
        file: file.id,
        created_by: req.user!.id,
        created_at: new Date()
      })
    } catch (err) {
      await deleteFile(file.id).catch(() => {})
      throw err
    }
    void logActivity({
      action: 'chat-emoji-add',
      user: req.user!.id,
      collection: 'nivaro_chat_emoji',
      item: shortcode,
      req
    })
    return reply.code(201).send({ data: await listEmoji(workspace) })
  })

  app.delete<{ Params: { id: string } }>('/emoji/:id', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Only an admin can remove emoji' })
    if (!(await emojiReady())) return reply.code(404).send({ error: 'Not found' })
    const row = (await db('nivaro_chat_emoji')
      .where({ id: Number(req.params.id) })
      .first()) as { id: number; file: string; shortcode: string } | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_chat_emoji').where({ id: row.id }).del()
    await deleteFile(String(row.file)).catch(() => {})
    void logActivity({
      action: 'chat-emoji-remove',
      user: req.user!.id,
      collection: 'nivaro_chat_emoji',
      item: row.shortcode,
      req
    })
    return { data: { removed: true } }
  })

  /** The image itself, for any signed-in chat user — the file library stays admin-only. */
  app.get<{ Params: { id: string } }>(
    '/emoji/:id/image',
    { compress: false },
    async (req, reply) => {
      if (!(await emojiReady())) return reply.code(404).send({ error: 'Not found' })
      const row = (await db('nivaro_chat_emoji')
        .where({ id: Number(req.params.id) })
        .first()) as { file: string } | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const file = await getFile(String(row.file))
      if (!file) return reply.code(404).send({ error: 'Not found' })
      const buf = await readFileBuffer(file)
      const type = sniffImageType(buf)
      if (!type) return reply.code(404).send({ error: 'Not found' })
      return reply
        .header('Content-Type', type)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=86400')
        .send(buf)
    }
  )

  // ── Draft sync (#2474) ───────────────────────────────────────────────────

  /** Rooms where this person has an unsent draft (the sidebar's pencil mark). */
  app.get('/drafts', async (req) => ({ data: await listDrafts(String(req.user!.id)) }))

  app.get<{ Params: { room: string } }>('/drafts/:room', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    return { data: await getDraft(String(req.user!.id), room) }
  })

  app.put<{ Params: { room: string } }>('/drafts/:room', async (req, reply) => {
    const room = decodeURIComponent(req.params.room)
    if (!(await canSeeRoom(req.user!, room))) return reply.code(403).send(forbidden)
    const b = (req.body ?? {}) as { body?: unknown; device?: unknown }
    const body = typeof b.body === 'string' ? b.body : ''
    if (body.length > DRAFT_MAX_CHARS * 2)
      return reply.code(413).send({ error: 'That draft is too long to sync' })
    const device = typeof b.device === 'string' ? b.device.slice(0, 64) : null
    return { data: await saveDraft(String(req.user!.id), room, body, device) }
  })

  app.delete<{ Params: { room: string } }>('/drafts/:room', async (req) => {
    const device = (req.query as { device?: string }).device?.slice(0, 64) ?? null
    await clearDraft(String(req.user!.id), decodeURIComponent(req.params.room), device)
    return { data: { cleared: true } }
  })

  // ── Idle channel archive suggestions (#2485) ─────────────────────────────

  /** A channel by id or key — read from the database, so one made on another replica is found. */
  async function channelById(id: string) {
    const row = await findChannelRow(id)
    return row ? ((await channelByKey(String(row.key))) ?? null) : null
  }
  const ownsOrAdmin = (
    ch: { created_by: string | null },
    req: { user?: { id: string } | null; isAdmin?: boolean }
  ) =>
    !!req.isAdmin ||
    String(ch.created_by ?? '').toUpperCase() === String(req.user?.id).toUpperCase()

  /** The owner's (or an admin's) answer: archive the quiet channel, or keep it open. */
  app.post<{ Params: { id: string } }>('/channels/:id/archive-suggestion', async (req, reply) => {
    const ch = await channelById(req.params.id)
    if (!ch) return reply.code(404).send({ error: 'Not found' })
    if (!ownsOrAdmin(ch, req))
      return reply.code(403).send({ error: 'Only the channel owner or an admin can answer this' })
    const action = (req.body as { action?: string } | undefined)?.action
    if (action !== 'archive' && action !== 'keep')
      return reply.code(400).send({ error: "action must be 'archive' or 'keep'" })
    const ok = await answerArchiveSuggestion(ch.id, action, String(req.user!.id))
    if (!ok)
      return reply.code(503).send({ error: 'Archive suggestions need the latest database update' })
    return { data: { archived: action === 'archive', kept: action === 'keep' } }
  })

  /** Suggested and archived channels (admins). */
  app.get('/admin/archive-overview', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    return { data: await archiveOverview() }
  })

  /** Set the idle-days threshold: a number of days, 0 = off, null = the default (90). */
  app.put('/admin/archive-settings', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const raw = (req.body as { idle_days?: unknown } | undefined)?.idle_days
    const days = raw === null || raw === '' || raw === undefined ? null : Number(raw)
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 3650))
      return reply.code(400).send({ error: 'idle_days must be a whole number from 0 to 3650' })
    await setIdleDays(days)
    void logActivity({
      action: 'chat-archive-settings',
      user: req.user!.id,
      collection: 'nivaro_settings',
      item: '1',
      comment: days === null ? 'idle days reset to the default' : `idle days set to ${days}`,
      req
    })
    return { data: await archiveOverview() }
  })

  /** Run the sweep now (admins) — the daily cron does the same. */
  app.post('/admin/archive-suggest-now', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const found = await suggestIdleChannels(app)
    return { data: { suggested: found.length, overview: await archiveOverview() } }
  })

  // ── Channel membership history (#2784) ───────────────────────────────────

  /** Who joined, left, was added or removed in a channel, and by whom (owner or admin). */
  app.get<{ Params: { id: string } }>('/channels/:id/membership-history', async (req, reply) => {
    const ch = await channelById(req.params.id)
    if (!ch) return reply.code(404).send({ error: 'Not found' })
    if (!ownsOrAdmin(ch, req))
      return reply.code(403).send({ error: 'Only the channel owner or an admin can see this' })
    return { data: await loadMembershipHistory({ items: historyItemsFor(ch), limit: 200 }) }
  })

  /** Every channel's membership changes (admins), for chat analytics. */
  app.get('/admin/membership-history', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admins only' })
    const q = req.query as { days?: string; channel?: string; limit?: string }
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 365)
    const events = await loadMembershipHistory({
      items: q.channel ? [q.channel] : undefined,
      days,
      limit: Number(q.limit) || 300
    })
    const names = new Map([...(await channels()).values()].map((c) => [c.key, c.name]))
    return {
      data: events.map((e) => ({ ...e, channel_name: names.get(e.channel) ?? e.channel }))
    }
  })
}
