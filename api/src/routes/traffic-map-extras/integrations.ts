// api/src/routes/traffic-map-extras/integrations.ts
/**
 * Traffic Map — the map in other features and business lanes (#2162 #2189 #2198 #2277). Routes
 * land under /api/traffic-map, admin only, 404 in cloud mode (the parent plugin's hooks):
 *
 * GET  /edit-locks                    records with long-held or contested edit locks (#2162)
 * GET  /role-split?window=60|300|900  traffic, background jobs and pool use per NIVARO_ROLE
 *                                     (#2198)
 * GET  /business-events?minutes=      business activity per minute, counts only (#2189)
 * GET  /chat-cards                    cards being refreshed in chat (#2277)
 * POST /chat-card {room, kind, id}    post a node card to a chat room; it keeps refreshing, then
 *                                     freezes with its last values
 * POST /chat-card/:message/freeze     freeze it now
 *
 * (#2276, traffic on a support ticket, is GET /api/support/tickets/:id/traffic: its readers are
 * the support desk, not only administrators.)
 */
import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../../admin-base.js'
import { db } from '../../db/index.js'
import { logActivity } from '../../services/activity.js'
import { canSeeRoom } from '../../services/chat.js'
import { ChatSendError, postChatMessage } from '../../services/chat-send.js'
import { INSTANCE_ID, listInstances } from '../../services/instance-roster.js'
import { tenantScopedRoom } from '../../services/tenant-rooms.js'
import {
  type BusinessEvents,
  businessEvents,
  minutesOf
} from '../../services/traffic-business-events.js'
import {
  type Card,
  type CardIo,
  type CardKind,
  cardById,
  freezeNow,
  liveCards,
  type Reading,
  renderCard,
  startCard
} from '../../services/traffic-chat-card.js'
import { trafficClusterRelay } from '../../services/traffic-cluster.js'
import { editLockLens } from '../../services/traffic-edit-locks.js'
import type { TrafficSnapshot } from '../../services/traffic-map.js'
import { roleOf, splitByRole } from '../../services/traffic-role-split.js'
import { currentStoreId } from '../../services/traffic-taps.js'
import { getUser } from '../../services/users.js'
import { localSnapshot } from './cluster.js'

const WINDOWS = new Set([60, 300, 900])
const ENTITY_RE = /^[a-z0-9_-]{1,40}\/[A-Za-z0-9_.:@/-]{1,160}$/
const DOWN_RE = /^[A-Za-z0-9_.:@/-]{1,120}$/
const ROOM_RE = /^[A-Za-z0-9_.:-]{1,200}$/

/** The newest one-minute figure of a node, from this process's snapshot. */
export function readNode(kind: CardKind, node: string): Reading | null {
  const s = localSnapshot(60)
  if (kind === 'entity') {
    const e = s.entities.find((x) => x.key === node)
    return e ? { label: e.label, req: e.req, error: e.error, p95: e.p95 } : null
  }
  const d = s.down.find((x) => x.id === node)
  return d ? { label: d.label, req: d.req, error: d.error, p95: d.p95 } : null
}

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/edit-locks', async () => ({ data: await editLockLens() }))

  app.get<{ Querystring: { window?: string } }>('/role-split', async (req, reply) => {
    const window = Number(req.query.window ?? 60)
    if (!WINDOWS.has(window)) {
      return reply
        .code(400)
        .send({ error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' })
    }
    const relay = trafficClusterRelay()
    const snaps: Map<string, TrafficSnapshot> = relay
      ? await relay.collect(currentStoreId(), window)
      : new Map([[INSTANCE_ID, localSnapshot(window)]])
    const roles = new Map<string, string>()
    for (const r of await listInstances()) roles.set(String(r.id ?? ''), roleOf(r.role))
    // without a roster (no Redis) this process is the only one and knows its own role
    if (!roles.has(INSTANCE_ID)) roles.set(INSTANCE_ID, roleOf(process.env.NIVARO_ROLE))
    return { data: splitByRole(snaps, roles, window) }
  })

  app.get<{ Querystring: { minutes?: string } }>('/business-events', async (req) => {
    const data: BusinessEvents = await businessEvents(minutesOf(req.query.minutes))
    return { data }
  })

  // ── #2277 chat cards ───────────────────────────────────────────────────────
  const io: CardIo = {
    read: readNode,
    async mayPost(card) {
      const user = await getUser(card.by)
      if (!user || user.status !== 'active') return false
      return canSeeRoom(user, card.room)
    },
    async write(message, text) {
      const row = (await db('chat_messages').where({ id: message }).first('room', 'deleted_at')) as
        | { room: string; deleted_at: unknown }
        | undefined
      if (!row || row.deleted_at) return false
      await db('chat_messages').where({ id: message }).update({ message: text })
      app.io?.to(tenantScopedRoom(`chat:${row.room}`)).emit('chat:message', {
        room: row.room,
        touch: true
      })
      return true
    }
  }
  const brief = (c: Card) => ({
    message: c.message,
    room: c.room,
    kind: c.kind,
    node: c.node,
    label: c.label,
    status: c.status,
    reason: c.reason,
    started: c.started,
    updated: c.updated,
    frozen_at: c.frozen_at
  })

  app.get('/chat-cards', async () => ({ data: liveCards().map(brief) }))

  app.post<{ Body: { room?: string; kind?: string; id?: string } }>(
    '/chat-card',
    async (req, reply) => {
      const b = req.body ?? {}
      const kind: CardKind | null = b.kind === 'entity' || b.kind === 'down' ? b.kind : null
      const node = String(b.id ?? '')
      const room = String(b.room ?? '')
      if (!kind || !(kind === 'entity' ? ENTITY_RE : DOWN_RE).test(node) || !ROOM_RE.test(room)) {
        return reply
          .code(400)
          .send({ error: 'room, kind and id are required', code: 'CARD_INVALID' })
      }
      const reading = readNode(kind, node)
      if (!reading) {
        return reply
          .code(404)
          .send({ error: 'That node has no traffic to share', code: 'NODE_QUIET' })
      }
      const base = adminBaseUrl()
      const now = Date.now()
      const card: Card = {
        message: 0,
        room,
        kind,
        node,
        label: reading.label,
        started: now,
        updated: now,
        readings: [Math.round(reading.req)],
        last: reading,
        startedWithErrors: reading.error > 0,
        quiet: 0,
        status: 'live',
        frozen_at: null,
        reason: null,
        by: String(req.user!.id),
        link: base ? `${base.replace(/\/$/, '')}/traffic-map` : null
      }
      if (liveCards().filter((c) => c.status === 'live').length >= 10) {
        return reply
          .code(429)
          .send({ error: 'At most 10 live cards at a time', code: 'CARD_LIMIT' })
      }
      try {
        const row = await postChatMessage(
          app,
          { user: req.user!, isAdmin: !!req.isAdmin },
          { room, message: renderCard(card), noPreview: true }
        )
        card.message = row.id
      } catch (err) {
        if (err instanceof ChatSendError) {
          return reply.code(err.statusCode).send({ error: err.message, code: err.code })
        }
        throw err
      }
      startCard(card, io)
      void logActivity({
        action: 'traffic-chat-card',
        user: req.user!.id,
        collection: 'chat_messages',
        item: String(card.message),
        comment: `Posted a live ${card.label} card to ${room}`
      })
      return reply.code(201).send({ data: brief(card) })
    }
  )

  app.post<{ Params: { message: string } }>('/chat-card/:message/freeze', async (req, reply) => {
    const id = Number(req.params.message)
    if (!cardById(id))
      return reply.code(404).send({ error: 'No live card', code: 'CARD_NOT_FOUND' })
    const card = await freezeNow(id, io)
    if (card) {
      void logActivity({
        action: 'traffic-chat-card-freeze',
        user: req.user!.id,
        collection: 'chat_messages',
        item: String(id),
        comment: `Froze the ${card.label} card`
      })
    }
    return { data: card ? brief(card) : null }
  })
}
