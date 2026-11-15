import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { recordVisibleTo } from '../services/revision-access.js'
import { announcePrefsChanged } from '../services/user-sync.js'
import { viewAsAdminOf } from '../services/view-as-attribution.js'
import { readMentions } from '../services/watch-list/mentions.js'
import { readWatchRows } from '../services/watch-list/rows.js'
import {
  addPin,
  markSeen,
  normalizeDock,
  normalizeWatchList,
  parsePreferences,
  pinKey,
  pinnable,
  removePin,
  reorderPins,
  WATCH_PINS_MAX,
  type WatchListPrefs
} from '../services/watch-list/store.js'
import { readWaiting } from '../services/watch-list/waiting.js'

/**
 * The watch list dock (rt5 #1 / #2) — the person's own pinned records, read and written for
 * themselves only (`/api/watch-list`). Storage: `preferences.watch_list` (services/watch-list/
 * store.ts); every save tells the person's other tabs and devices (`prefs:changed`).
 *
 *   GET    /watch-list/prefs               stored list: pins, dock, seen (no record reads)
 *   GET    /watch-list?summary=1           rows as the viewer (summary: changed keys only)
 *   POST   /watch-list/pins {collection,id} pin (the record must be readable; cap 50)
 *   DELETE /watch-list/pins/:collection/:id
 *   PUT    /watch-list/order {keys}        "My order"
 *   PATCH  /watch-list/dock {state,width,tab,sort}
 *   POST   /watch-list/seen {keys?}        changed marks seen (no keys = all)
 *   GET    /watch-list/waiting             records the person raised that wait on others
 *   GET    /watch-list/mentions            mentions + replies; POST /watch-list/replies-seen
 *
 * View-as: everything reads as the person; nothing is written (a pin, a seen mark or a dock
 * move made while viewing as someone is theirs to make, not the administrator's).
 */

const KEY = 'watch_list'

async function loadList(userId: string): Promise<{
  prefs: Record<string, unknown>
  list: WatchListPrefs
}> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  const prefs = parsePreferences(row?.preferences)
  return { prefs, list: normalizeWatchList(prefs[KEY]) }
}

async function saveList(userId: string, list: WatchListPrefs): Promise<void> {
  // Re-read just before the write: another preference saved meanwhile is kept.
  const { prefs } = await loadList(userId)
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify({ ...prefs, [KEY]: list }) })
  announcePrefsChanged(userId, [KEY])
}

function publicList(list: WatchListPrefs) {
  return {
    pins: list.pins.map((p) => ({
      key: pinKey(p.c, p.id),
      collection: p.c,
      id: p.id,
      pinned_at: p.at
    })),
    dock: list.dock,
    replies_seen_at: list.replies_seen_at,
    max: WATCH_PINS_MAX
  }
}

/** True (and answered) when this request may not change the list. */
function refusedWrite(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!viewAsAdminOf(req)) return false
  void reply.code(403).send({
    error: 'While viewing as someone, their watch list can be looked at but not changed',
    code: 'VIEW_AS_READ_ONLY'
  })
  return true
}

export async function watchListRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth)

  app.get('/prefs', async (req) => {
    const { list } = await loadList(String(req.user!.id))
    return { data: publicList(list) }
  })

  app.get<{ Querystring: { summary?: string } }>('/', async (req) => {
    const { list } = await loadList(String(req.user!.id))
    const summary = req.query?.summary === '1' || req.query?.summary === 'true'
    if (list.pins.length === 0) return { data: { ...publicList(list), rows: [], changed: [] } }
    const { rows, changed } = await readWatchRows(list, {
      user: req.user!,
      isAdmin: !!req.isAdmin,
      workspaceId: req.workspaceId ?? undefined,
      summary
    })
    return { data: { ...publicList(list), rows: summary ? undefined : rows, changed } }
  })

  app.post<{ Body: { collection?: unknown; id?: unknown } }>('/pins', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    const collection = req.body?.collection
    const id = req.body?.id
    if (!pinnable(collection, id))
      return reply.code(400).send({ error: 'Name a record to watch', code: 'NOT_PINNABLE' })
    // Only a record the person can open (row filters, User Scopes): never confirms a hidden one.
    if (!(await recordVisibleTo(req, String(collection), String(id))))
      return reply.code(404).send({ error: 'Not found' })
    const userId = String(req.user!.id)
    const { list } = await loadList(userId)
    const res = addPin(list, String(collection), String(id))
    if (!res.ok) return reply.code(409).send({ error: res.message, code: res.code })
    if (res.changed) await saveList(userId, res.list)
    return reply.send({ data: publicList(res.list) })
  })

  app.delete<{ Params: { collection: string; id: string } }>(
    '/pins/:collection/:id',
    async (req, reply) => {
      if (refusedWrite(req, reply)) return
      const userId = String(req.user!.id)
      const { list } = await loadList(userId)
      // Unpinning needs no read access: a record they can no longer open can still go.
      const res = removePin(list, req.params.collection, req.params.id)
      if (res.changed) await saveList(userId, res.list)
      return reply.send({ data: publicList(res.list) })
    }
  )

  app.put<{ Body: { keys?: unknown } }>('/order', async (req, reply) => {
    if (refusedWrite(req, reply)) return
    if (!Array.isArray(req.body?.keys))
      return reply.code(400).send({ error: 'keys must be a list' })
    const userId = String(req.user!.id)
    const { list } = await loadList(userId)
    const next = reorderPins(list, req.body.keys)
    await saveList(userId, next)
    return reply.send({ data: publicList(next) })
  })

  app.patch<{ Body: Record<string, unknown> }>('/dock', async (req, reply) => {
    const userId = String(req.user!.id)
    const { list } = await loadList(userId)
    const dock = normalizeDock(req.body ?? {}, list.dock)
    const next = { ...list, dock }
    // View-as: the dock moves on screen but the person's saved arrangement stays theirs.
    if (!viewAsAdminOf(req)) await saveList(userId, next)
    return reply.send({ data: publicList(next) })
  })

  app.post<{ Body: { keys?: unknown } }>('/seen', async (req, reply) => {
    const userId = String(req.user!.id)
    const { list } = await loadList(userId)
    if (viewAsAdminOf(req)) return reply.send({ data: publicList(list) })
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 100) : null
    const res = markSeen(list, keys)
    if (res.changed) await saveList(userId, res.list)
    return reply.send({ data: publicList(res.list) })
  })

  app.get<{ Querystring: { fresh?: string } }>('/waiting', async (req) => {
    const rows = await readWaiting(req.user!, !!req.isAdmin, { fresh: req.query?.fresh === '1' })
    return { data: { rows } }
  })

  app.get('/mentions', async (req) => {
    const { list } = await loadList(String(req.user!.id))
    return { data: await readMentions(req.user!, !!req.isAdmin, list.replies_seen_at) }
  })

  app.post('/replies-seen', async (req, reply) => {
    const userId = String(req.user!.id)
    const { list } = await loadList(userId)
    if (viewAsAdminOf(req)) return reply.send({ data: publicList(list) })
    const next = { ...list, replies_seen_at: new Date().toISOString() }
    await saveList(userId, next)
    return reply.send({ data: publicList(next) })
  })
}
