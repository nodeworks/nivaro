import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import {
  type CellLockRedis,
  type CellLockStore,
  cellLockKey,
  MAX_CELL_READ,
  memoryCellLockStore,
  readCellLocks,
  redisCellLockStore,
  releaseCellLock,
  takeCellLock
} from '../services/cell-locks.js'
import { recordWriteRefusal } from '../services/edit-lock.js'
import { can, getAllowedFields } from '../services/permissions.js'
import { compileAccessGates, visibleIds } from '../services/record-access.js'
import { announceRecordAspect } from '../services/record-events.js'
import { isSystemCollection } from '../services/system-collections.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { viewAsAdminOf } from '../services/view-as-attribution.js'

/**
 * Soft locks on list cells (services/cell-locks.ts).
 *
 *   POST /api/cell-locks/take    {collection, id, field, beat?} → {ok} | {ok:false, holder:{name, since}}
 *   POST /api/cell-locks/release {collection, id, field}        → {ok}
 *   POST /api/cell-locks/read    {collection, ids, fields}      → {data: [{id, field, name, since, mine}]}
 *
 * take: judged like a write to that record and field by the caller — the field must be one
 * their role may update, and the record must pass recordWriteRefusal (read as them, update row
 * filter / tree permission, nobody else's edit lock, the approval lock). read: the caller must
 * be able to read the collection; fields they cannot read are dropped and only rows they can see
 * answer (role policy, row filter, User Scopes — admins included). A take (not a beat) and a
 * release announce `$cells` on the record — ids and the aspect name only; lists re-read here.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const ID = /^[A-Za-z0-9_.:-]{1,64}$/

const VISIBLE_TTL_MS = 30_000
const visibleCache = new Map<string, { at: number; ids: Set<string> }>()

/** For tests. */
export function resetCellLockCaches() {
  visibleCache.clear()
}

/**
 * Who exactly is asking, for the visibility cache: the person, how they signed in, the API key
 * and its scopes / scope restrictions, and the administrator behind a View-as. Two callers that
 * could see different rows never share an entry.
 */
export function callerIdentity(req: FastifyRequest): string {
  const r = req as FastifyRequest & {
    authMethod?: string
    apiKeyId?: number | string | null
    apiKeySimulatedId?: number | string | null
  }
  const u = req.user as
    | (Record<string, unknown> & {
        id?: string
        api_key_scopes?: unknown
        api_key_scope_restrictions?: unknown
      })
    | undefined
  const scope = createHash('sha1')
    .update(
      JSON.stringify([
        u?.api_key_scopes ?? null,
        u?.api_key_scope_restrictions ?? null,
        u?.role ?? null,
        req.isAdmin === true
      ])
    )
    .digest('hex')
  return [
    currentTenantKey(),
    u?.id ?? '',
    r.authMethod ?? '',
    r.apiKeyId ?? '',
    r.apiKeySimulatedId ?? '',
    viewAsAdminOf(req) ?? '',
    scope
  ].join('\u0001')
}

async function visibleRowIds(req: FastifyRequest, collection: string, ids: string[]) {
  const key = [callerIdentity(req), collection, [...ids].sort().join(',')].join('\u0002')
  const hit = visibleCache.get(key)
  if (hit && Date.now() - hit.at < VISIBLE_TTL_MS) return hit.ids
  // Restrict User Scopes bind administrators too: never "admin = every row".
  const gates = await compileAccessGates(req.user!, collection, {
    actingAdmin: req.isAdmin === true
  })
  const seen = await visibleIds(gates, ids)
  const out = new Set([...seen].map((i) => String(i).toUpperCase()))
  if (visibleCache.size > 2000) visibleCache.clear()
  visibleCache.set(key, { at: Date.now(), ids: out })
  return out
}

/** The fields of `wanted` the caller's role may `action` (null policy list = every field). */
async function allowedOf(
  req: FastifyRequest,
  action: 'read' | 'update',
  collection: string,
  wanted: string[]
): Promise<string[]> {
  const allowed = await getAllowedFields(req.user!, action, collection)
  if (allowed === null || allowed.includes('*')) return wanted
  return wanted.filter((f) => allowed.includes(f))
}

function displayName(req: FastifyRequest): string {
  const u = req.user as { first_name?: string | null; last_name?: string | null } | undefined
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim()
  return name || 'Someone'
}

function cellOf(body: unknown): { collection: string; id: string; field: string } | null {
  const b = (body ?? {}) as { collection?: unknown; id?: unknown; field?: unknown }
  const collection = typeof b.collection === 'string' ? b.collection : ''
  const id = typeof b.id === 'string' || typeof b.id === 'number' ? String(b.id) : ''
  const field = typeof b.field === 'string' ? b.field : ''
  if (!IDENT.test(collection) || !ID.test(id) || !IDENT.test(field)) return null
  return { collection, id, field }
}

export async function cellLockRoutes(app: FastifyInstance, opts: { store?: CellLockStore } = {}) {
  const redis = (app as unknown as { redis?: CellLockRedis }).redis
  const store = opts.store ?? (redis ? redisCellLockStore(redis) : memoryCellLockStore())

  app.post('/take', { preHandler: requireAuth }, async (req, reply) => {
    const cell = cellOf(req.body)
    if (!cell) return reply.code(400).send({ error: 'collection, id and field required' })
    const beat = (req.body as { beat?: unknown }).beat === true
    if (isSystemCollection(cell.collection) && !req.isAdmin)
      return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', cell.collection)))
      return reply.code(403).send({ error: 'You cannot change these records' })
    if ((await allowedOf(req, 'update', cell.collection, [cell.field])).length === 0)
      return reply.code(403).send({ error: 'You cannot change this field' })
    // In view for the caller — Restrict User Scopes and key scope restrictions bind
    // administrators too (recordWriteRefusal lets an admin past its read).
    const inView = await visibleRowIds(req, cell.collection, [cell.id])
    if (!inView.has(cell.id.toUpperCase())) return reply.code(404).send({ error: 'Not found' })
    // The record itself, as the caller: readable, updatable, not locked against them.
    const refusal = await recordWriteRefusal(req, cell.collection, cell.id, {
      fields: [cell.field]
    })
    if (refusal) return reply.code(refusal.status).send(refusal.body)

    const key = cellLockKey(cell.collection, cell.id, cell.field)
    try {
      const r = await takeCellLock(store, key, { id: String(req.user!.id), name: displayName(req) })
      if (!r.ok) {
        return reply.send({
          ok: false,
          holder: { name: r.holder.name, since: r.holder.locked_at }
        })
      }
    } catch (err) {
      // Soft: a lock store that is away never stops anyone editing.
      req.log.warn({ err }, 'cell-locks: take failed')
      return reply.send({ ok: true, unavailable: true })
    }
    if (!beat) announceRecordAspect(cell.collection, cell.id, '$cells')
    return reply.send({ ok: true })
  })

  app.post('/release', { preHandler: requireAuth }, async (req, reply) => {
    const cell = cellOf(req.body)
    if (!cell) return reply.code(400).send({ error: 'collection, id and field required' })
    try {
      const released = await releaseCellLock(
        store,
        cellLockKey(cell.collection, cell.id, cell.field),
        String(req.user!.id)
      )
      // Only the holder's own release is announced (nothing to say otherwise).
      if (released) announceRecordAspect(cell.collection, cell.id, '$cells')
    } catch (err) {
      req.log.warn({ err }, 'cell-locks: release failed')
    }
    return reply.send({ ok: true })
  })

  app.post('/read', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { collection?: unknown; ids?: unknown; fields?: unknown }
    const collection = typeof b.collection === 'string' ? b.collection : ''
    if (!IDENT.test(collection) || !Array.isArray(b.ids) || !Array.isArray(b.fields))
      return reply.code(400).send({ error: 'collection, ids and fields required' })
    const ids = [
      ...new Set(
        b.ids
          .filter((i) => typeof i === 'string' || typeof i === 'number')
          .map(String)
          .filter((i) => ID.test(i))
      )
    ]
    const asked = [
      ...new Set(b.fields.filter((f): f is string => typeof f === 'string' && IDENT.test(f)))
    ]
    if (ids.length * asked.length > MAX_CELL_READ)
      return reply.code(400).send({ error: `At most ${MAX_CELL_READ} cells per request` })
    if (ids.length === 0 || asked.length === 0) return reply.send({ data: [] })
    if (isSystemCollection(collection) && !req.isAdmin) return reply.send({ data: [] })
    // Judged on every request (only the per-id visibility is cached): the collection is
    // readable, and only fields the caller may read are looked up at all.
    if (!(await can(req.user!, 'read', collection))) return reply.send({ data: [] })
    const fields = await allowedOf(req, 'read', collection, asked)
    if (fields.length === 0) return reply.send({ data: [] })
    const visible = await visibleRowIds(req, collection, ids)
    const shown = ids.filter((i) => visible.has(i.toUpperCase()))
    try {
      const data = await readCellLocks(
        store,
        collection,
        shown.flatMap((id) => fields.map((field) => ({ id, field }))),
        String(req.user!.id)
      )
      return reply.send({
        data: data.map(({ user_id: _u, ...rest }) => rest)
      })
    } catch (err) {
      req.log.warn({ err }, 'cell-locks: read failed')
      return reply.send({ data: [] })
    }
  })
}
