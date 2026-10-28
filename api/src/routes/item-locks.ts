import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { EDIT_LOCKED, lockHolderVerdict } from '../services/edit-lock.js'
import { isAuthor, isUuid } from '../services/help-videos.js'
import { isLockingEnabled, lockHolderName } from '../services/item-lock-guard.js'
import {
  CollectionNotFoundError,
  canUpdateItem,
  ForbiddenError,
  idFitsCollection,
  readItems
} from '../services/items.js'
import {
  holderKnownGone,
  LEGACY_LOCK_TTL_MS,
  lastHeartbeatAt,
  lockWindowMs
} from '../services/lock-presence.js'
import { announceRecordAspect } from '../services/record-events.js'
import { currentTenantKey, tenantScopedRoom } from '../services/tenant-rooms.js'

/** The help-video editor locks a video under this name (#1523). */
export const HELP_VIDEO_LOCK_COLLECTION = 'nivaro_help_videos'

/**
 * Who may lock what. Records of business collections as before. Of the
 * system tables only help videos: the editor holds a lock per video, and the
 * gate is the help-video author check (the items API has no policy for that
 * table). Every other nivaro_ / directus_ table is refused — a lock row is
 * not a place to park arbitrary keys, and a lock notification names the item.
 */
export async function lockRefusal(
  user: Parameters<typeof isAuthor>[0],
  isAdmin: boolean,
  collection: string,
  item: string | undefined
): Promise<{ status: number; error: string } | null> {
  if (collection === HELP_VIDEO_LOCK_COLLECTION) {
    if (item !== undefined && !isUuid(item)) return { status: 404, error: 'Video not found' }
    if (!(await isAuthor(user, isAdmin)))
      return { status: 403, error: 'Only help-video authors can edit videos' }
    return null
  }
  if (/^(nivaro_|directus_)/i.test(collection))
    return { status: 403, error: 'Edit locks are not available for this table' }
  return null
}

/** How a lock notification names the item and where it takes the reader. */
async function lockSubject(
  collection: string,
  item: string
): Promise<{
  label: string
  target: { kind: 'record'; collection: string; id: string } | { kind: 'external'; url: string }
}> {
  if (collection === HELP_VIDEO_LOCK_COLLECTION) {
    const row = (await db('nivaro_help_videos')
      .where({ id: item })
      .first('title')
      .catch(() => null)) as { title?: string | null } | null | undefined
    const title = String(row?.title ?? '').trim()
    return {
      label: title ? `the video “${title}”` : 'a help video',
      target: {
        kind: 'external',
        url: `${(adminBaseUrl() ?? '').replace(/\/$/, '')}/help-videos?edit=${encodeURIComponent(item)}`
      }
    }
  }
  return {
    label: `${collection}/${item}`,
    target: { kind: 'record', collection, id: String(item) }
  }
}

/**
 * A lock is a short lease the holder's open form keeps alive (2026-10-28 — a
 * 5-minute lease kept refusing everyone after its holder had left). Each
 * acquire/heartbeat grants `lockWindowMs(body)`: 30 s for a client that says
 * it beats every ≤15 s (`beat_ms`, current clients beat every 10 s), 150 s for
 * an older client that beats every 60 s. The client also lets go the moment
 * its form stops being the focused, visible edit surface. See lock-presence.ts.
 */
export const LOCK_TTL_MS = LEGACY_LOCK_TTL_MS

interface ItemLock {
  id: number
  collection: string
  item: string
  user: string
  locked_at: Date
  expires_at: Date
  note?: string | null
}

const NOTE_MAX = 300

function isExpired(lock: ItemLock): boolean {
  return new Date(lock.expires_at).getTime() <= Date.now()
}

/** Not live: lapsed lease, or (for anyone but the holder) a holder known to have left. */
function isStale(lock: ItemLock, askedBy?: string): boolean {
  if (isExpired(lock)) return true
  // The holder's own request is proof they are here (their socket may be the
  // thing that is down): only others judge them by presence.
  if (askedBy && String(askedBy).toUpperCase() === String(lock.user).toUpperCase()) return false
  return holderKnownGone(lock)
}

function cleanNote(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim().slice(0, NOTE_MAX)
  return s.length > 0 ? s : null
}

// The Fastify instance, for the release paths that run outside a handler's
// closure (an expired lock discovered by getCurrentLock). Set in itemLocksRoutes.
let _app: FastifyInstance | null = null

/**
 * The live lock on a record, or null. A stale one (no heartbeat inside its
 * lease, or a holder known to have left — not judged for `askedBy` = the
 * holder) is released on the spot: free to take silently, refuses nobody.
 */
async function getCurrentLock(
  collection: string,
  item: string,
  askedBy?: string
): Promise<ItemLock | null> {
  const lock = (await db('nivaro_item_locks').where({ collection, item }).first()) as
    | ItemLock
    | undefined
  if (!lock) return null
  if (isStale(lock, askedBy)) {
    await db('nivaro_item_locks').where({ id: lock.id }).delete()
    if (_app && !isExpired(lock)) emitLockEvent(_app, collection, item, lock.user, false)
    else noteLockAnnounced(collection, item, false)
    // An expiry IS a release — the next person in line should hear about it.
    if (_app) await handOffToQueue(_app, collection, item)
    return null
  }
  // A lock its holder may no longer use is void: the record moved into an
  // approval step they do not own (army v3 — the creator was locked out of
  // their own record by an approver's lock). Dropped like an expiry, and the
  // holder is told why.
  const verdict = await lockHolderVerdict(lock.user, collection, item)
  if (!verdict.allowed) {
    await db('nivaro_item_locks').where({ id: lock.id }).delete()
    if (_app) {
      emitLockEvent(_app, collection, item, lock.user, false)
      await handOffToQueue(_app, collection, item)
      const { notifyUser } = await import('../services/notification-channels.js')
      const what = await lockSubject(collection, String(item))
      await notifyUser(_app, lock.user, {
        subject: 'Your edit lock was released',
        message: `${verdict.message} Your edit lock on ${what.label} was released.`,
        collection,
        item: String(item),
        category: 'system',
        target: what.target
      }).catch(() => {})
    } else noteLockAnnounced(collection, item, false)
    return null
  }
  return lock
}

// ── View-as locks ──────────────────────────────────────────────────────────
// A lock taken through a View-as (nvm_) token is held in the viewed person's
// name. When the View-as stops, the tab's own release goes out with a token
// that no longer works — so the server remembers which records each View-as
// token locked (Redis set, keyed by a hash of the token, lives as long as a
// View-as can) and DELETE /api/auth/masquerade lets go of them.

const MASQ_LOCKS_TTL_S = 4 * 3600
const SEP = '\u0000'

function masqueradeLocksKey(token: string): string {
  const h = createHash('sha256').update(token).digest('hex').slice(0, 32)
  return `nvr:lockmq:${currentTenantKey()}:${h}`
}

function masqueradeTokenOf(req: FastifyRequest): string | null {
  if (req.authMethod !== 'masquerade') return null
  const h = req.headers?.authorization
  const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : ''
  return token.startsWith('nvm_') ? token : null
}

/** Remember that this View-as token holds the record's lock. Never fails the request. */
export function noteMasqueradeLock(req: FastifyRequest, collection: string, item: string): void {
  const token = masqueradeTokenOf(req)
  const redis = (req.server as { redis?: FastifyInstance['redis'] } | undefined)?.redis
  if (!token || !redis) return
  const key = masqueradeLocksKey(token)
  void Promise.resolve()
    .then(async () => {
      await redis.sadd(key, `${collection}${SEP}${item}`)
      await redis.expire(key, MASQ_LOCKS_TTL_S)
    })
    .catch(() => undefined)
}

/**
 * The View-as `token` ended: release every lock it took that `userId` (the
 * viewed person) still holds — announced, and handed to the wait queue, like
 * any release. Returns how many were released. Never throws.
 */
export async function releaseMasqueradeLocks(
  app: FastifyInstance,
  token: string,
  userId: string
): Promise<number> {
  let released = 0
  try {
    const key = masqueradeLocksKey(token)
    const members = ((await app.redis.smembers(key)) ?? []) as string[]
    await app.redis.del(key)
    for (const m of members) {
      const at = m.indexOf(SEP)
      if (at <= 0) continue
      const collection = m.slice(0, at)
      const item = m.slice(at + 1)
      const n = await db('nivaro_item_locks')
        .where({ collection, item })
        .whereRaw('UPPER([user]) = ?', [String(userId).toUpperCase()])
        .delete()
      if (!n) continue
      released++
      emitLockEvent(app, collection, item, userId, false)
      await handOffToQueue(app, collection, item)
    }
  } catch {
    /* best effort — the 30 s lease frees the rest */
  }
  return released
}

/** 403 for a person the approval edit lock refuses: a lock they could not use. */
async function approvalRefusal(
  req: FastifyRequest,
  collection: string,
  item: string
): Promise<{ error: string; code: typeof EDIT_LOCKED } | null> {
  if (req.isAdmin) return null
  const verdict = await lockHolderVerdict(req.user!, collection, item)
  return verdict.allowed ? null : { error: verdict.message, code: EDIT_LOCKED }
}

// ── Wait queue (migration 306) ─────────────────────────────────────────────
// nivaro_item_lock_queue: who is waiting for a record, in the order they
// asked. When the lock is released the FIRST row is popped and told (socket
// `lock:available` to their user room + an in-app notification) so their
// client auto-acquires; everyone else stays queued for the next release.

interface QueueEntry {
  user: string
  name: string
  requested_at: Date
}

async function queueFor(collection: string, item: string): Promise<QueueEntry[]> {
  const rows = (await db('nivaro_item_lock_queue as q')
    .leftJoin('nivaro_users as u', 'u.id', 'q.user')
    .where({ 'q.collection': collection, 'q.item': item })
    .orderBy('q.requested_at', 'asc')
    .orderBy('q.id', 'asc')
    .select('q.user', 'q.requested_at', 'u.first_name', 'u.last_name', 'u.email')) as Array<{
    user: string
    requested_at: Date
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return rows.map((r) => ({
    user: r.user,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || r.user,
    requested_at: r.requested_at
  }))
}

function queuePosition(queue: QueueEntry[], userId: string): number | null {
  const idx = queue.findIndex((q) => String(q.user).toUpperCase() === String(userId).toUpperCase())
  return idx === -1 ? null : idx + 1
}

async function leaveQueue(collection: string, item: string, userId: string): Promise<void> {
  await db('nivaro_item_lock_queue')
    .where({ collection, item })
    .whereRaw('UPPER([user]) = ?', [String(userId).toUpperCase()])
    .delete()
    .catch(() => {})
}

/**
 * Pop the head of the wait queue and tell them the record is free. Called on
 * every release path (explicit release, idle release, expiry, handoff
 * response). Never throws — a release must never fail because the hand-off
 * notification did.
 */
async function handOffToQueue(app: FastifyInstance, collection: string, item: string) {
  try {
    const queue = await queueFor(collection, item)
    const next = queue[0]
    if (!next) return
    await db('nivaro_item_lock_queue')
      .where({ collection, item })
      .whereRaw('UPPER([user]) = ?', [String(next.user).toUpperCase()])
      .delete()
    app.io?.to(`user:${next.user}`).emit('lock:available', { collection, item: String(item) })
    const { notifyUser } = await import('../services/notification-channels.js')
    const what = await lockSubject(collection, String(item))
    await notifyUser(app, next.user, {
      subject: `It's your turn to edit ${what.label}`,
      message: `The edit lock on ${what.label} was released and you were next in line.`,
      collection,
      item: String(item),
      category: 'system',
      target: what.target
    }).catch(() => {})
  } catch {
    /* hand-off is best-effort */
  }
}

/**
 * Minutes since the lock holder's last real input, from the LEGACY
 * user_presence table (user_id, last_active, is_idle). null when there is no
 * row — and a missing/renamed table must never break a lock read, hence the
 * swallow.
 */
async function holderIdleMinutes(userId: string): Promise<number | null> {
  const row = (await db('user_presence')
    .whereRaw('UPPER(CAST(user_id AS NVARCHAR(64))) = ?', [String(userId).toUpperCase()])
    .first('last_active', 'is_idle')
    .catch(() => null)) as { last_active?: string | Date | null } | null | undefined
  if (!row?.last_active) return null
  const at = new Date(row.last_active).getTime()
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.floor((Date.now() - at) / 60_000))
}

/**
 * Broadcast lock state to viewers of the item. Clients join via the existing
 * Socket.io collection-item room.
 */
function emitLockEvent(
  app: FastifyInstance,
  collection: string,
  item: string,
  user: string,
  locked: boolean,
  fresh = false
) {
  // Cloud: this tenant's room (tenant-rooms.ts). Nothing in core joins item rooms today.
  app.io
    ?.to(tenantScopedRoom(`item:${collection}:${item}`))
    .emit('item-lock', { collection, item, user, locked })
  noteLockAnnounced(collection, item, locked, fresh)
}

// Lists show a lock icon per row, so a lock taken or released is also a
// payload-free `$lock` notice on the collection feed (rows re-read their
// locks). A refresh of a lock already announced is not news: remember the
// last state announced per record and only speak on a change. The memory is
// this process's only: a release served by another replica never clears it,
// so a lock newly TAKEN (`fresh`) is always news (army v3 — viewers were never
// told a new holder had the record).
const announcedLocks = new Map<string, boolean>()
const ANNOUNCED_MAX = 5000

function noteLockAnnounced(collection: string, item: string, locked: boolean, fresh = false) {
  if (/^(nivaro_|directus_)/i.test(collection)) return
  // Per tenant: the same record id in two tenants is two records.
  const key = `${currentTenantKey()}\u0000${collection}\u0000${item}`
  if (!fresh && announcedLocks.get(key) === locked) return
  if (announcedLocks.size >= ANNOUNCED_MAX) announcedLocks.clear()
  if (locked) announcedLocks.set(key, true)
  else announcedLocks.delete(key)
  announceRecordAspect(collection, item, '$lock')
}

/**
 * May this person read the record a lock route names? A lock on a record the
 * caller cannot see answers 404 like the record itself — otherwise the 409
 * names who is editing a record hidden from them. Same gate as /active (the
 * caller's own list read, so row filters and User Scopes apply); admins read
 * everything. A yes is remembered a minute per person + record: heartbeats
 * ask every few seconds.
 */
const readableCache = new Map<string, number>()
const READABLE_TTL_MS = 60_000

async function callerCanReadRecord(
  user: NonNullable<FastifyRequest['user']>,
  isAdmin: boolean,
  collection: string,
  item: string
): Promise<boolean> {
  if (isAdmin) return true
  const key = `${currentTenantKey()}:${user.id}:${collection}:${item}`
  const until = readableCache.get(key)
  if (until && until > Date.now()) return true
  if (!(await idFitsCollection(collection, item))) return false
  let readable = false
  try {
    const res = (await readItems(user, collection, { fields: ['id'], limit: 1 }, {
      query: { conditions: JSON.stringify([{ path: ['id'], op: '_eq', value: item }]) }
    } as never)) as { data?: Array<Record<string, unknown>> }
    readable = (res.data ?? []).some((r) => String(r.id) === String(item))
  } catch (err) {
    // Only a real "you may not read this" is a no. A pool or gate failure is
    // a server error — answered as one, never as a 404 that makes the client
    // drop a lock it holds.
    if (!(err instanceof ForbiddenError) && !(err instanceof CollectionNotFoundError)) throw err
    readable = false
  }
  if (readable) {
    if (readableCache.size >= 5000) readableCache.clear()
    readableCache.set(key, Date.now() + READABLE_TTL_MS)
  }
  return readable
}

/**
 * May this person CHANGE the record a lock route names (M2, security audit
 * 2026-10-27)? An edit lock keeps everyone else out of a record, so only
 * someone who could save it may take, extend, force-take, wait for or ask
 * for one — a read-only viewer holding a lock would lock the editors out.
 * The gates updateOne applies before it writes (canUpdateItem: update
 * policy, tree permission, update row filter, write scope). Help videos are
 * judged by the help-video author gate (lockRefusal). A yes is remembered a
 * minute per person + record: heartbeats ask every few seconds.
 */
const editableCache = new Map<string, number>()

export async function callerCanEditRecord(req: FastifyRequest, collection: string, item: string) {
  if (collection === HELP_VIDEO_LOCK_COLLECTION) return true
  if (req.isAdmin) return true
  const user = req.user!
  const key = `${currentTenantKey()}:${user.id}:${collection}:${item}`
  const until = editableCache.get(key)
  if (until && until > Date.now()) return true
  const ok = await canUpdateItem(user, collection, item, req.workspaceId ?? undefined)
  if (ok) {
    if (editableCache.size >= 5000) editableCache.clear()
    editableCache.set(key, Date.now() + READABLE_TTL_MS)
  }
  return ok
}

const NOT_EDITABLE = { error: 'You may not change this record', code: 'NOT_EDITABLE' }

/** Takeover permission (#256): admins, and roles in settings.lock_takeover_roles. */
async function mayTakeOver(
  user: { role?: string | null } | undefined,
  isAdmin: boolean
): Promise<boolean> {
  if (isAdmin) return true
  let allowed: string[] = []
  try {
    const settings = (await db('nivaro_settings').first('lock_takeover_roles')) as
      | { lock_takeover_roles?: string | null }
      | undefined
    allowed = settings?.lock_takeover_roles
      ? (JSON.parse(settings.lock_takeover_roles) as string[])
      : []
  } catch {
    allowed = []
  }
  const mine = String(user?.role ?? '').toUpperCase()
  return allowed.some((r) => String(r).toUpperCase() === mine)
}

export async function itemLocksRoutes(app: FastifyInstance) {
  _app = app
  app.addHook('preHandler', authenticate)
  // Every route naming a collection: may this person lock in it at all?
  // (Signed-out requests fall through to the routes' own requireAuth.)
  app.addHook('preHandler', async (req, reply) => {
    const p = (req.params ?? {}) as { collection?: string; item?: string }
    if (!p.collection || !req.user) return
    const refused = await lockRefusal(req.user, !!req.isAdmin, p.collection, p.item)
    if (refused) return reply.code(refused.status).send({ error: refused.error })
    // A record the caller cannot read has no lock as far as they can tell.
    // Letting go (release, leave the queue) stays open: it only ever removes
    // the caller's own rows.
    const lettingGo = req.method === 'DELETE' || /\/lock\/release$/.test(req.url.split('?')[0])
    if (
      p.item !== undefined &&
      p.collection !== HELP_VIDEO_LOCK_COLLECTION &&
      !lettingGo &&
      !(await callerCanReadRecord(req.user, !!req.isAdmin, p.collection, p.item))
    ) {
      return reply.code(404).send({ error: 'Not found' })
    }
  })

  // ── Config: GET/PATCH locking enabled flag per collection (admin) ─────────

  app.get('/config/:collection', { preHandler: [requireAdmin] }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    try {
      const enabled = await isLockingEnabled(collection)
      return reply.send({ data: { collection, item_locking_enabled: enabled } })
    } catch {
      return reply.send({ data: { collection, item_locking_enabled: true } })
    }
  })

  app.patch('/config/:collection', { preHandler: [requireAdmin] }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { item_locking_enabled } = req.body as { item_locking_enabled: boolean }

    const exists = await db('nivaro_collections').where({ collection }).first()
    if (!exists) return reply.code(404).send({ error: 'Collection not found' })

    await db('nivaro_collections')
      .where({ collection })
      .update({ item_locking_enabled: item_locking_enabled ? 1 : 0 })

    // Release all active locks when disabling
    if (!item_locking_enabled) {
      await db('nivaro_item_locks').where({ collection }).delete()
      // Cloud: the requesting tenant's collection room (tenant-rooms.ts).
      app.io?.to(tenantScopedRoom(`collection:${collection}`)).emit('item-lock-disabled', {
        collection
      })
    }

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: collection,
      comment: `item_locking_enabled: ${item_locking_enabled}`,
      req
    })

    return reply.send({ data: { collection, item_locking_enabled } })
  })

  // ── Lock state ────────────────────────────────────────────────────────────

  // POST /:collection/active {ids} — who is editing which of these records
  // right now (list rows show a lock icon + the editor's name). Only ids the
  // caller can READ answer — the lock is not a side channel around row
  // filters / User Scopes — and a collection with locking off answers nothing.
  app.post<{ Params: { collection: string }; Body: { ids?: unknown } }>(
    '/:collection/active',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection } = req.params
      const asked = Array.isArray(req.body?.ids) ? req.body.ids : []
      const ids = [
        ...new Set(
          asked.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x))
        )
      ].slice(0, 200)
      if (ids.length === 0 || !(await isLockingEnabled(collection))) {
        return reply.send({ data: [] })
      }
      const locks = (await db('nivaro_item_locks')
        .where({ collection })
        .whereIn('item', ids)
        .where('expires_at', '>', new Date())
        .select('item', 'user', 'locked_at', 'expires_at')) as Array<{
        item: string
        user: string
        locked_at: Date
        expires_at: Date
      }>
      // Live locks only: a holder known to have left holds nothing (lock-presence.ts).
      const live = locks.filter((l) => !holderKnownGone(l))
      if (live.length === 0) return reply.send({ data: [] })
      const fakeReq = {
        query: {
          conditions: JSON.stringify([{ path: ['id'], op: '_in', value: live.map((l) => l.item) }])
        }
      } as never
      let readable: Set<string>
      try {
        const res = (await readItems(
          req.user!,
          collection,
          { fields: ['id'], limit: live.length + 1 },
          fakeReq
        )) as { data?: Array<Record<string, unknown>> }
        readable = new Set((res.data ?? []).map((r) => String(r.id)))
      } catch {
        return reply.send({ data: [] })
      }
      const shown = live.filter((l) => readable.has(String(l.item)))
      const names = new Map<string, string | null>()
      for (const uid of new Set(shown.map((l) => l.user))) names.set(uid, await lockHolderName(uid))
      return reply.send({
        data: shown.map((l) => ({
          item: String(l.item),
          locked_by: l.user,
          locked_by_name: names.get(l.user) ?? null,
          is_mine: String(l.user).toUpperCase() === String(req.user!.id).toUpperCase()
        }))
      })
    }
  )

  // GET /:collection/:item/lock — current lock state (null when free/expired/disabled)
  app.get('/:collection/:item/lock', { preHandler: [requireAuth] }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }

    if (!(await isLockingEnabled(collection))) {
      return reply.send({ data: null, locking_disabled: true })
    }

    const lock = await getCurrentLock(collection, item, req.user!.id)
    const queue = await queueFor(collection, item)
    const my_position = queuePosition(queue, req.user!.id)
    // Free record: `data` stays null (clients read null = free) but the queue
    // still rides along so a waiting client can show its position.
    if (!lock) return reply.send({ data: null, queue, my_position })

    const [locked_by_name, locked_by_idle_minutes, may_take_over] = await Promise.all([
      lockHolderName(lock.user),
      holderIdleMinutes(lock.user),
      lock.user === req.user!.id ? false : mayTakeOver(req.user, !!req.isAdmin)
    ])
    return reply.send({
      data: {
        collection: lock.collection,
        item: lock.item,
        user: lock.user,
        locked_by: lock.user,
        locked_by_name,
        // Minutes since the holder's last real input (user_presence.last_active);
        // null when they have no presence row. Lets a waiting client say
        // "held by X, idle 12m" instead of just "held by X".
        locked_by_idle_minutes,
        // nivaro_item_locks has no heartbeat column — the heartbeat only slides
        // expires_at forward, so expires_at − its window is the last heartbeat.
        locked_by_last_heartbeat: lastHeartbeatAt(lock.expires_at),
        note: lock.note ?? null,
        locked_at: lock.locked_at,
        expires_at: lock.expires_at,
        is_mine: lock.user === req.user!.id,
        // Whether POST …/lock/force would take it — the client shows "Take
        // over" only then, never as a button that answers 403.
        may_take_over,
        queue,
        my_position
      }
    })
  })

  // POST /:collection/:item/lock — acquire/refresh lock for the current user
  // All live locks (#89) — the admin console behind force-unlock: who is
  // holding what, for how long. Expired rows are excluded, not deleted (the
  // holder's heartbeat may still refresh them).
  app.get('/', { preHandler: [requireAuth] }, async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const rows = (await db('nivaro_item_locks as l')
      .leftJoin('nivaro_users as u', 'u.id', 'l.user')
      .where('l.expires_at', '>', new Date())
      .orderBy('l.locked_at', 'desc')
      .limit(200)
      .select(
        'l.id',
        'l.collection',
        'l.item',
        'l.user',
        'l.locked_at',
        'l.expires_at',
        'l.note',
        db.raw("CONCAT(u.first_name, ' ', u.last_name) as holder_name"),
        'u.email as holder_email'
      )) as Array<Record<string, unknown>>
    return reply.send({
      data: rows.filter(
        (r) =>
          !holderKnownGone({
            user: String(r.user),
            locked_at: r.locked_at as Date,
            expires_at: r.expires_at as Date
          })
      )
    })
  })

  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!.id
      const body = (req.body ?? {}) as { note?: unknown }
      const noteGiven = body.note !== undefined
      const note = cleanNote(body.note)

      // Silently no-op when locking is disabled for this collection
      if (!(await isLockingEnabled(collection))) {
        return reply.send({ data: null, locking_disabled: true })
      }
      // A person who may not save the record gets no lock on it.
      if (!(await callerCanEditRecord(req, collection, item))) {
        return reply.code(403).send(NOT_EDITABLE)
      }

      const existing = await getCurrentLock(collection, item, me)
      // Someone the approval edit lock refuses gets no lock: they could not
      // save, and holding it would lock out the people who may.
      const waiting = await approvalRefusal(req, collection, item)
      if (waiting) {
        if (existing && existing.user === me) {
          await db('nivaro_item_locks').where({ id: existing.id }).delete()
          emitLockEvent(app, collection, item, me, false)
          await handOffToQueue(app, collection, item)
        }
        return reply.code(403).send(waiting)
      }
      if (existing && existing.user !== me) {
        return reply.code(409).send({
          error: 'Item is locked by another user',
          locked_by: existing.user,
          locked_by_name: await lockHolderName(existing.user),
          note: existing.note ?? null,
          expires_at: existing.expires_at,
          may_take_over: await mayTakeOver(req.user, !!req.isAdmin)
        })
      }

      const now = new Date()
      const expiresAt = new Date(now.getTime() + lockWindowMs(req.body))

      if (existing) {
        await db('nivaro_item_locks')
          .where({ id: existing.id })
          .update(noteGiven ? { expires_at: expiresAt, note } : { expires_at: expiresAt })
      } else {
        try {
          await db('nivaro_item_locks').insert({
            collection,
            item,
            user: me,
            locked_at: now,
            expires_at: expiresAt,
            note
          })
        } catch {
          const winner = await getCurrentLock(collection, item, me)
          if (winner && winner.user !== me) {
            return reply.code(409).send({
              error: 'Item is locked by another user',
              locked_by: winner.user,
              locked_by_name: await lockHolderName(winner.user),
              note: winner.note ?? null,
              expires_at: winner.expires_at,
              may_take_over: await mayTakeOver(req.user, !!req.isAdmin)
            })
          }
        }
      }

      noteMasqueradeLock(req, collection, item)
      // Holding the lock means no longer waiting for it.
      await leaveQueue(collection, item, me)
      emitLockEvent(app, collection, item, me, true, !existing)

      if (!existing) {
        await logActivity({
          action: 'lock-acquire',
          user: me,
          collection,
          item: String(item),
          req
        })
      }

      const lock = await getCurrentLock(collection, item, me)
      return reply.send({
        data: lock
          ? {
              collection,
              item,
              user: lock.user,
              locked_by: lock.user,
              note: lock.note ?? null,
              locked_at: lock.locked_at,
              expires_at: lock.expires_at
            }
          : null
      })
    }
  )

  // POST /:collection/:item/lock/note — the holder updates their own note.
  app.post<{ Params: { collection: string; item: string }; Body: { note?: unknown } }>(
    '/:collection/:item/lock/note',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!.id
      const existing = await getCurrentLock(collection, item, me)
      if (!existing || existing.user !== me) {
        return reply.code(403).send({ error: 'You do not hold a lock on this item' })
      }
      const note = cleanNote(req.body?.note)
      await db('nivaro_item_locks').where({ id: existing.id }).update({ note })
      emitLockEvent(app, collection, item, me, true)
      return reply.send({ data: { collection, item, user: me, note } })
    }
  )

  // POST /:collection/:item/lock/queue — join the wait queue (idempotent).
  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/queue',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!
      if (!(await isLockingEnabled(collection))) {
        return reply.send({ data: null, locking_disabled: true })
      }
      // Waiting for a lock one could never use only pings the holder.
      if (!(await callerCanEditRecord(req, collection, item))) {
        return reply.code(403).send(NOT_EDITABLE)
      }
      const existing = await getCurrentLock(collection, item, me.id)
      if (existing && existing.user === me.id) {
        return reply.code(400).send({ error: 'You already hold this lock' })
      }
      // Nobody holds it (released before the ask arrived): there is nothing
      // to wait for — answer `free` so the client drops its stale banner
      // instead of queuing for a lock no one will ever release.
      if (!existing) return reply.send({ data: { position: null, free: true, queue: [] } })
      let queue = await queueFor(collection, item)
      const already = queuePosition(queue, me.id)
      if (already === null) {
        try {
          await db('nivaro_item_lock_queue').insert({
            collection,
            item: String(item),
            user: me.id,
            requested_at: new Date()
          })
        } catch {
          /* UNIQUE race — already queued */
        }
        queue = await queueFor(collection, item)
      }
      const position = queuePosition(queue, me.id) ?? queue.length
      // Tell the holder someone is waiting — same channels as lock/request.
      if (existing && already === null) {
        const fromName =
          [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email || me.id
        app.io?.to(`user:${existing.user}`).emit('lock:queued', {
          collection,
          item: String(item),
          user_name: fromName,
          position,
          from: { id: me.id, name: fromName }
        })
        const { notifyUser } = await import('../services/notification-channels.js')
        const what = await lockSubject(collection, String(item))
        await notifyUser(app, existing.user, {
          subject: 'Someone is waiting to edit',
          message: `${fromName} is waiting for ${what.label} (position ${position} in line).`,
          collection,
          item: String(item),
          sender: me.id,
          category: 'system',
          target: what.target
        }).catch(() => {})
      }
      return reply.send({ data: { position, queue } })
    }
  )

  // DELETE /:collection/:item/lock/queue — leave the wait queue.
  app.delete<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/queue',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      await leaveQueue(collection, item, req.user!.id)
      return reply.code(204).send()
    }
  )

  // POST /:collection/:item/heartbeat — extend own lock (no-op when disabled)
  // Takeover permission (#256): roles listed in settings.lock_takeover_roles
  // may FORCE-take a lock (delete + re-acquire) — the holder finds out on
  // their next heartbeat (the existing 404-with-holder path) and via an
  // in-app notification. Admins always may.
  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/force',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      if (!(await isLockingEnabled(collection))) {
        return reply.send({ data: null, locking_disabled: true })
      }
      if (!(await mayTakeOver(req.user, !!req.isAdmin))) {
        return reply.code(403).send({ error: 'Your role may not take over locks' })
      }
      if (!(await callerCanEditRecord(req, collection, item))) {
        return reply.code(403).send(NOT_EDITABLE)
      }
      const waiting = await approvalRefusal(req, collection, item)
      if (waiting) return reply.code(403).send(waiting)
      const existing = await getCurrentLock(collection, item, req.user!.id)
      if (existing && existing.user !== req.user!.id) {
        await db('nivaro_item_locks').where({ collection, item }).del()
        const { notifyUser } = await import('../services/notification-channels.js')
        const what = await lockSubject(collection, String(item))
        void notifyUser(app, existing.user, {
          subject: 'Your edit lock was taken over',
          message: `${[req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || 'An authorized user'} took over editing ${what.label}. Unsaved changes there may conflict.`,
          collection,
          item,
          sender: req.user?.id ?? null,
          ...(collection === HELP_VIDEO_LOCK_COLLECTION ? { target: what.target } : {})
        }).catch(() => {})
      }
      await db('nivaro_item_locks').insert({
        collection,
        item,
        user: req.user!.id,
        locked_at: new Date(),
        expires_at: new Date(Date.now() + lockWindowMs(req.body))
      })
      noteMasqueradeLock(req, collection, item)
      // The taker now holds it — they are no longer waiting. The rest of the
      // queue stays: the lock was not released, it changed hands.
      await leaveQueue(collection, item, req.user!.id)
      emitLockEvent(app, collection, item, req.user!.id, true, true)
      await logActivity({
        action: 'lock-force-take',
        user: req.user!.id,
        collection,
        item,
        req
      })
      return reply.send({ data: { taken: true } })
    }
  )

  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/heartbeat',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!.id

      if (!(await isLockingEnabled(collection))) {
        return reply.send({ data: null, locking_disabled: true })
      }

      const existing = await getCurrentLock(collection, item, me)
      // The record moved into a step this person may not change: their lock
      // was dropped (getCurrentLock) — say so, so the form turns read-only
      // instead of re-acquiring.
      if (!existing) {
        const waiting = await approvalRefusal(req, collection, item)
        if (waiting) return reply.code(403).send(waiting)
      }
      if (!existing || existing.user !== me) {
        // Say WHO holds it now. A heartbeat is the only moment a client whose
        // lock was taken over finds out, and without the holder it cannot show
        // the banner naming them — it would just stop beating and carry on
        // letting the person edit.
        return reply.code(404).send({
          error: 'You do not hold a lock on this item',
          locked_by: existing?.user ?? null,
          locked_by_name: existing ? await lockHolderName(existing.user) : null,
          note: existing?.note ?? null
        })
      }

      // A holder who may no longer change the record (role or row filter
      // changed since) keeps no lock on it.
      if (!(await callerCanEditRecord(req, collection, item))) {
        await db('nivaro_item_locks').where({ id: existing.id }).del()
        emitLockEvent(app, collection, item, me, false)
        await handOffToQueue(app, collection, item)
        // EDIT_LOCKED: the client stops holding, says why and re-reads who may edit.
        return reply.code(403).send({
          error: 'You can no longer change this record — your edit lock was let go',
          code: EDIT_LOCKED
        })
      }

      // Idle release: the heartbeat carries how long the holder has been
      // without real input. When settings.lock_idle_release_minutes is set and
      // the holder has idled past it, the lock is released server-side — a tab
      // left open must not hold a record hostage. The client re-acquires on
      // the holder's next real input if the record is still free.
      const idleSeconds = Number((req.body as { idle_seconds?: unknown } | null)?.idle_seconds)
      if (Number.isFinite(idleSeconds) && idleSeconds > 0) {
        const settings = (await db('nivaro_settings').first('lock_idle_release_minutes')) as
          | { lock_idle_release_minutes?: number | null }
          | undefined
        const idleMinutes = Number(settings?.lock_idle_release_minutes)
        if (Number.isFinite(idleMinutes) && idleMinutes > 0 && idleSeconds >= idleMinutes * 60) {
          await db('nivaro_item_locks').where({ id: existing.id }).del()
          emitLockEvent(app, collection, item, me, false)
          await handOffToQueue(app, collection, item)
          return reply.send({ data: null, idle_released: true })
        }
      }

      const expiresAt = new Date(Date.now() + lockWindowMs(req.body))
      await db('nivaro_item_locks').where({ id: existing.id }).update({ expires_at: expiresAt })
      noteMasqueradeLock(req, collection, item)

      return reply.send({ data: { collection, item, user: me, expires_at: expiresAt } })
    }
  )

  // DELETE /:collection/:item/lock — release own lock (admin: ?force=1 releases any)
  const release = async (
    req: FastifyRequest,
    reply: FastifyReply,
    collection: string,
    item: string,
    force: boolean
  ) => {
    const me = req.user!.id
    const existing = await getCurrentLock(collection, item, me)
    if (!existing) return reply.code(204).send()

    if (existing.user !== me && !force) {
      // Someone who cannot read the record learns nothing about who edits
      // it: their release of a lock that is not theirs is a quiet no-op.
      // Help videos are locked by authors through the help-video gate, not
      // the items API (no read check reaches them): their 403 stays.
      if (
        collection !== HELP_VIDEO_LOCK_COLLECTION &&
        !(await callerCanReadRecord(req.user!, !!req.isAdmin, collection, item))
      ) {
        return reply.code(204).send()
      }
      return reply.code(403).send({ error: 'Lock is held by another user' })
    }

    await db('nivaro_item_locks').where({ id: existing.id }).delete()
    emitLockEvent(app, collection, item, existing.user, false)
    await handOffToQueue(app, collection, item)

    await logActivity({
      action: 'lock-release',
      user: me,
      collection,
      item: String(item),
      req
    })

    return reply.code(204).send()
  }
  app.delete<{ Params: { collection: string; item: string }; Querystring: { force?: string } }>(
    '/:collection/:item/lock',
    { preHandler: [requireAuth] },
    async (req, reply) =>
      release(
        req,
        reply,
        req.params.collection,
        req.params.item,
        req.query.force === '1' && !!req.isAdmin
      )
  )
  // POST /:collection/:item/lock/release — the same release of the caller's
  // OWN lock, for a tab that is leaving the record: navigator.sendBeacon (and
  // keepalive fetches) can only POST. Never releases someone else's lock.
  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/release',
    { preHandler: [requireAuth] },
    async (req, reply) => release(req, reply, req.params.collection, req.params.item, false)
  )

  // ── Lock handoff (#286) ───────────────────────────────────────────────────
  // "Request the lock" pings the holder live (socket to their user room +
  // an in-app notification fallback); the holder releases or declines with a
  // note. Chat-them-and-wait, replaced with a button.
  app.post<{ Params: { collection: string; item: string } }>(
    '/:collection/:item/lock/request',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { collection, item } = req.params
      const me = req.user!
      if (!(await callerCanEditRecord(req, collection, item))) {
        return reply.code(403).send(NOT_EDITABLE)
      }
      const existing = await getCurrentLock(collection, item, me.id)
      if (!existing) return reply.code(404).send({ error: 'Nobody holds this lock' })
      if (existing.user === me.id)
        return reply.code(400).send({ error: 'You already hold this lock' })
      const fromName = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email || me.id
      app.io?.to(`user:${existing.user}`).emit('lock:requested', {
        collection,
        item: String(item),
        from: { id: me.id, name: fromName }
      })
      const { notifyUser } = await import('../services/notification-channels.js')
      const what = await lockSubject(collection, String(item))
      await notifyUser(app, existing.user, {
        subject: 'Edit lock requested',
        message: `${fromName} is asking you to release ${what.label} so they can edit it.`,
        collection,
        item: String(item),
        sender: me.id,
        ...(collection === HELP_VIDEO_LOCK_COLLECTION ? { target: what.target } : {})
      }).catch(() => {})
      return { data: { requested: true } }
    }
  )

  app.post<{
    Params: { collection: string; item: string }
    Body: { to?: string; action?: string; note?: string }
  }>('/:collection/:item/lock/respond', { preHandler: [requireAuth] }, async (req, reply) => {
    const { collection, item } = req.params
    const me = req.user!
    const to = String(req.body?.to ?? '')
    const action = req.body?.action === 'release' ? 'release' : 'decline'
    const note = String(req.body?.note ?? '').slice(0, 300)
    if (!to) return reply.code(400).send({ error: 'to (requester id) is required' })
    if (!isUuid(to)) return reply.code(400).send({ error: 'to must be a user id' })
    const existing = await getCurrentLock(collection, item, me.id)
    // Only the person holding the lock answers a request for it — otherwise
    // anyone could send anyone a "lock released / declined" notification.
    if (!existing || String(existing.user).toUpperCase() !== String(me.id).toUpperCase()) {
      return reply.code(403).send({ error: 'You do not hold a lock on this item' })
    }
    if (action === 'release') {
      await db('nivaro_item_locks').where({ id: existing.id }).delete()
      emitLockEvent(app, collection, item, me.id, false)
      // The explicit requester is the intended recipient (they get
      // lock:response below and auto-acquire); drop their queue row so the
      // hand-off does not ALSO wake the queue head and race them. When the
      // requester never queued, the head of the queue is told as usual.
      await leaveQueue(collection, item, to)
      await handOffToQueue(app, collection, item)
      // The history names the person, never their raw id.
      const toName = await lockHolderName(to).catch(() => null)
      await logActivity({
        action: 'lock-release',
        user: me.id,
        collection,
        item: String(item),
        req,
        comment: `Handed the edit lock to ${toName ?? 'the person who asked for it'}`
      })
    }
    const myName = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email || me.id
    app.io?.to(`user:${to}`).emit('lock:response', {
      collection,
      item: String(item),
      action,
      note,
      from: { id: me.id, name: myName }
    })
    const { notifyUser } = await import('../services/notification-channels.js')
    const what = await lockSubject(collection, String(item))
    await notifyUser(app, to, {
      subject: action === 'release' ? 'Lock released for you' : 'Lock request declined',
      message:
        action === 'release'
          ? `${myName} released ${what.label} — it's yours.`
          : `${myName} declined to release ${what.label}${note ? `: "${note}"` : '.'}`,
      collection,
      item: String(item),
      sender: me.id,
      ...(collection === HELP_VIDEO_LOCK_COLLECTION ? { target: what.target } : {})
    }).catch(() => {})
    return { data: { responded: action } }
  })
}
