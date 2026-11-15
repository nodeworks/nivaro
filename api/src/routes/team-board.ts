import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { getPagePresenceSnapshot, getRecordViewerSnapshot } from '../plugins/socketio.js'
import { createShortCache } from '../services/short-cache.js'
import {
  assembleTeamBoard,
  recordOfPath,
  type TeamBoard,
  type TeamBoardLock
} from '../services/team-board.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import type { User } from '../types.js'
import { presenceOnlineFor, resolveRecordLabels } from './presence.js'

/**
 * GET /api/realtime/team-board — administrators only (realtime round 5, item 21). Who is
 * working on which record right now, built from what presence already keeps; nothing is
 * stored. Cached per administrator for 2 s, so a burst of board refreshes costs one build.
 */
const boardCache = createShortCache<TeamBoard>('team-board', 2000, { max: 200 })

async function liveLocks(): Promise<TeamBoardLock[]> {
  try {
    const rows = (await db('nivaro_item_locks')
      .where('expires_at', '>', new Date())
      .orderBy('locked_at', 'desc')
      .limit(500)
      .select('collection', 'item', 'user', 'locked_at', 'expires_at')) as Array<
      TeamBoardLock & { expires_at: Date }
    >
    const { lockIsLive } = await import('../services/lock-presence.js')
    return rows.filter((l) => l.user && lockIsLive(l))
  } catch {
    return []
  }
}

async function managersOf(ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>()
  if (ids.length === 0) return out
  try {
    const rows = (await db('nivaro_users')
      .whereIn('id', ids.slice(0, 1000))
      .whereNotNull('manager_id')
      .select('id', 'manager_id')) as Array<{ id: string; manager_id: string }>
    const managerIds = [...new Set(rows.map((r) => String(r.manager_id)))]
    if (managerIds.length === 0) return out
    const managers = (await db('nivaro_users')
      .whereIn('id', managerIds)
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
    const names = new Map(
      managers.map((m) => [
        String(m.id).toUpperCase(),
        [m.first_name, m.last_name].filter(Boolean).join(' ') || String(m.email ?? '')
      ])
    )
    for (const r of rows) {
      const name = names.get(String(r.manager_id).toUpperCase())
      if (name) out.set(String(r.id).toUpperCase(), { id: String(r.manager_id), name })
    }
  } catch {
    /* grouping by manager falls back to "No manager" */
  }
  return out
}

export async function loadTeamBoard(app: FastifyInstance, viewer: User): Promise<TeamBoard> {
  const presence = await presenceOnlineFor(app, viewer, true)
  const pages = getPagePresenceSnapshot()
  const viewers = getRecordViewerSnapshot()
  const locks = await liveLocks()
  const ids = [
    ...new Set(
      [
        ...presence.data.map((r) => String(r.user_id ?? '')),
        ...pages.map((p) => p.user.id),
        ...viewers.flatMap((v) => v.viewers.map((u) => u.id))
      ].filter(Boolean)
    )
  ]
  const managers = await managersOf(ids)
  // Record labels through the asking administrator's own read (User Scopes bind admins too).
  const paths = new Set<string>()
  const add = (c: string, i: string) => {
    if (!/[/?#]/.test(i)) paths.add(`/collections/${c}/${i}`)
  }
  for (const r of presence.data) {
    const rec = recordOfPath(r.current_path as string | null)
    if (rec) add(rec.collection, rec.item)
  }
  for (const p of pages) {
    const rec = recordOfPath(p.path)
    if (rec) add(rec.collection, rec.item)
  }
  for (const v of viewers) add(v.collection, v.item)
  for (const l of locks) add(l.collection, String(l.item))
  const labels = await resolveRecordLabels([...paths].slice(0, 400), viewer).catch(
    () => new Map<string, string>()
  )
  return assembleTeamBoard({
    presence: presence.data,
    pages,
    viewers,
    locks,
    managers,
    labels,
    dimensions: presence.config.dimensions
  })
}

export async function teamBoardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/team-board', { preHandler: requireAdmin }, async (req) => {
    const viewer = req.user as User
    const key = `${currentTenantKey() || '-'}|${String(viewer.id).toUpperCase()}`
    return { data: await boardCache.get(key, () => loadTeamBoard(app, viewer)) }
  })
}
