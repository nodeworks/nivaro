import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import {
  parseUndoComment,
  type UndoActivityRow,
  type UndoDeps,
  type UndoFieldMeta,
  type UndoneMark
} from './activity-undo.js'
import { getFields } from './collections.js'
import { selectInChunks } from './db-batch.js'
import { editLockRefusal } from './item-lock-guard.js'
import { canUpdateItem, dropServerSetFields, readOne, updateOne } from './items.js'
import { can } from './permissions.js'
import { currentTenantKey } from './tenant-rooms.js'
import { restoreTrashRow } from './trash.js'

/**
 * The real UndoDeps (activity-undo.ts): every read of the record is the
 * CALLER's (readOne — null for a row they cannot see), every write goes
 * through updateOne as the caller with `callerPayload` (field lists,
 * read-only fields, row filters, User Scopes, approval edit lock, hooks,
 * rollups, activity + revision). A delete comes back through the trash
 * restore service (the original id kept; create permission required) — the
 * one path that can bring a row back under its own id.
 */

const ACTIVITY_COLS = [
  'id',
  'action',
  'user',
  'collection',
  'item',
  'comment',
  'timestamp'
] as const

interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<string | null>
  del(key: string): Promise<number>
}

const localClaims = new Set<string>()

/** The activity columns, plus chain_id where migration 351 has run. */
async function activityCols(): Promise<string[]> {
  const { hasChainColumns } = await import('./chain-columns.js')
  return (await hasChainColumns('nivaro_activity'))
    ? [...ACTIVITY_COLS, 'chain_id']
    : [...ACTIVITY_COLS]
}

export function realUndoDeps(req: FastifyRequest, redis?: RedisLike | null): UndoDeps {
  const user = req.user as User
  const workspaceId = req.workspaceId ?? undefined
  const claimKey = (id: number) => `nvr:undo:${currentTenantKey() || '-'}:${id}`

  return {
    isAdmin: !!req.isAdmin,
    userId: user.id,

    async loadActivity(id) {
      if (!Number.isFinite(id)) return null
      const row = (await db('nivaro_activity')
        .where({ id })
        .first(...(await activityCols()))) as UndoActivityRow | undefined
      return row ?? null
    },

    async groupSiblings(row, max) {
      if (!row.chain_id) return [row]
      const q = db('nivaro_activity')
        .where({ chain_id: row.chain_id, action: 'update', collection: row.collection })
        .modify((qb) => {
          if (row.user) qb.where('user', row.user)
          else qb.whereNull('user')
        })
        .whereNotNull('item')
        .orderBy('id', 'asc')
        .limit(max)
        .select(...ACTIVITY_COLS, 'chain_id')
      return (await q) as UndoActivityRow[]
    },

    async revision(row) {
      const rev = (await db('nivaro_revisions').where({ activity: row.id }).first('id', 'delta')) as
        | { id: number; delta: string | null }
        | undefined
      if (!rev) return null
      const prev = (await db('nivaro_revisions')
        .where({ collection: row.collection, item: String(row.item) })
        .where('id', '<', rev.id)
        .orderBy('id', 'desc')
        .first('data')) as { data: string | null } | undefined
      return { delta: parse(rev.delta), before: parse(prev?.data ?? null) }
    },

    async fieldMeta(collection): Promise<UndoFieldMeta> {
      const audit = new Set<string>()
      const readonly = new Set<string>()
      const fields = await getFields(collection).catch(() => [])
      for (const f of fields) {
        const specials = f.special ?? []
        if (specials.some((s) => /^(user|date)-(created|updated)$/.test(s))) audit.add(f.field)
        if (f.readonly) readonly.add(f.field)
      }
      return { audit, readonly }
    },

    async readCurrent(collection, item) {
      try {
        return ((await readOne(user, collection, item, workspaceId)) ?? null) as Record<
          string,
          unknown
        > | null
      } catch {
        return null
      }
    },

    canUpdate: (collection, item) => canUpdateItem(user, collection, item, workspaceId),

    async lockedBy(collection, item) {
      const held = await editLockRefusal(req, collection, item).catch(() => null)
      return held ? String(held.body.error ?? 'Someone is editing this record') : null
    },

    async notAllowed(collection, fields) {
      const probe = Object.fromEntries(fields.map((f) => [f, null]))
      const dropped = await dropServerSetFields(user, collection, probe, 'update', req, true)
      return new Set(dropped)
    },

    async undoneIn(collection, since, ids) {
      const out = new Map<number, UndoneMark>()
      if (ids.length === 0) return out
      const want = new Set(ids)
      // (collection, action, timestamp) index; undo entries are few.
      const rows = (await db('nivaro_activity')
        .where({ collection, action: 'undo' })
        .where('timestamp', '>=', new Date(since.getTime() - 60_000))
        .orderBy('id', 'asc')
        .limit(5000)
        .select('id', 'user', 'timestamp', 'comment')) as Array<{
        id: number
        user: string | null
        timestamp: Date | string
        comment: string | null
      }>
      for (const r of rows) {
        const parsed = parseUndoComment(r.comment)
        if (!parsed) continue
        for (const e of parsed.entries) {
          if (want.has(e) && !out.has(e))
            out.set(e, {
              activity_id: Number(r.id),
              at: new Date(r.timestamp).toISOString(),
              by: r.user ?? null
            })
        }
      }
      return out
    },

    async trashFor(row) {
      const at = new Date(row.timestamp).getTime()
      const q = db('nivaro_trash')
        .where({ collection: row.collection, item_id: String(row.item) })
        .whereBetween('deleted_at', [new Date(at - 10 * 60_000), new Date(at + 10 * 60_000)])
        .orderBy('deleted_at', 'desc')
      if (row.user) q.where('deleted_by', row.user)
      const hit = (await q.first('id').catch(() => undefined)) as { id: number } | undefined
      return hit ? { id: Number(hit.id) } : null
    },

    async recordExists(collection, item) {
      const hit = await db(collection)
        .where({ id: item })
        .first('id')
        .catch(() => undefined)
      return !!hit
    },

    canCreate: (collection) => can(user, 'create', collection),

    async update(collection, item, data, reason) {
      await updateOne(
        user,
        collection,
        item,
        { ...data, _change_reason: reason },
        req,
        workspaceId,
        {
          callerPayload: true
        }
      )
    },

    async restore(trashId) {
      await restoreTrashRow(user, trashId, req)
    },

    logUndo: (entry) =>
      logActivity({
        action: 'undo',
        user: user.id,
        collection: entry.collection,
        item: entry.item ?? undefined,
        comment: entry.comment,
        req
      }),

    async claim(id) {
      const key = claimKey(id)
      if (localClaims.has(key)) return false
      if (redis) {
        try {
          const ok = await redis.set(key, req.id ?? '1', 'EX', 300, 'NX')
          if (ok === null) return false
        } catch {
          /* Redis trouble: the in-process claim still holds this replica */
        }
      }
      localClaims.add(key)
      return true
    },

    async release(id) {
      const key = claimKey(id)
      localClaims.delete(key)
      await redis?.del(key).catch(() => 0)
    }
  }
}

function parse(v: string | null): Record<string, unknown> | null {
  if (!v) return null
  try {
    const j = JSON.parse(v) as unknown
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Of `ids`, the activity entries that may show Undo to this caller — the
 * cheap list check (no record reads): a reversible action on a business
 * collection, by the caller unless they are an administrator, with a revision
 * (update) or a trash copy (delete), and not undone already. The full verdict
 * (changed since, permissions, locks) is the preview's.
 */
export async function undoableIds(req: FastifyRequest, ids: number[]): Promise<number[]> {
  const { reversibleAction } = await import('./activity-undo.js')
  if (ids.length === 0) return []
  const rows = (await selectInChunks(ids, 500, (chunk) =>
    db('nivaro_activity')
      .whereIn('id', chunk)
      .select(...ACTIVITY_COLS)
  )) as UndoActivityRow[]
  const me = String(req.user?.id ?? '').toLowerCase()
  const candidates = rows.filter(
    (r) => reversibleAction(r).ok && (req.isAdmin || String(r.user ?? '').toLowerCase() === me)
  )
  if (candidates.length === 0) return []
  const updates = candidates.filter((r) => r.action === 'update').map((r) => r.id)
  const withRev = new Set(
    (
      (await selectInChunks(updates, 500, (chunk) =>
        db('nivaro_revisions').whereIn('activity', chunk).whereNotNull('delta').select('activity')
      )) as Array<{ activity: number }>
    ).map((r) => Number(r.activity))
  )
  const deps = realUndoDeps(req, null)
  const out: number[] = []
  const byCollection = new Map<string, UndoActivityRow[]>()
  for (const r of candidates) {
    if (r.action === 'update' && !withRev.has(r.id)) continue
    if (r.action === 'delete' && !(await deps.trashFor(r))) continue
    const list = byCollection.get(String(r.collection)) ?? []
    list.push(r)
    byCollection.set(String(r.collection), list)
  }
  for (const [collection, list] of byCollection) {
    const since = new Date(Math.min(...list.map((r) => new Date(r.timestamp).getTime())))
    const undone = await deps.undoneIn(
      collection,
      since,
      list.map((r) => r.id)
    )
    for (const r of list) if (!undone.has(r.id)) out.push(r.id)
  }
  return out
}
