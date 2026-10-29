import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { selectInChunks } from './db-batch.js'
import { deleteOne, updateOne } from './items.js'
import { hasAttributionColumns } from './mcp-attribution.js'
import { CONN_RE } from './mcp-calls.js'
import { announceRecordAspect } from './record-events.js'
import { restoreTrashRow } from './trash.js'
import { getUser } from './users.js'

/**
 * Roll back what one MCP connection wrote in a time window (#3219).
 *
 * The writes are the activity rows the hosted MCP endpoint stamped with the connection
 * (`nivaro_activity.mcp_conn`, migration 512 — services/mcp-attribution.ts). A preview lists,
 * per record, what a rollback would do: delete a record the agent created, put back the values
 * it had before the agent's first change in the window, bring back a record the agent deleted
 * (from the trash), remove a comment the agent posted. A record someone else (or the same agent,
 * after the window) changed since is never touched — it is listed with who changed it and when.
 *
 * Apply re-plans and refuses unless the plan still hashes the same (409 + the fresh plan), then
 * carries each step out through the items service AS THE PERSON the connection acts for — their
 * permissions, validation, hooks and a fresh revision — and logs one `mcp-rollback` row with
 * the counts. When that person can no longer act (suspended, removed), an administrator's
 * rollback runs as the administrator, and the result says so.
 */

export const ROLLBACK_MAX_WRITES = 2000
export const ROLLBACK_MAX_DAYS = 90
const DAY = 86_400_000
/** Audit stamps move on every write; they are not something a rollback puts back. */
const STAMP_FIELDS = new Set(['id', 'updated_at', 'date_updated', 'user_updated', 'changed'])
const WRITE_ACTIONS = ['create', 'update', 'delete'] as const
const RECORD_HISTORY_ACTIONS = ['create', 'update', 'delete', 'restore']

export type RollbackKind =
  | 'delete_created'
  | 'restore_values'
  | 'restore_deleted'
  | 'remove_comment'

export interface RollbackAction {
  kind: RollbackKind
  collection: string
  collection_label: string
  item: string
  /** Fields whose earlier values are put back (names only — values are never shown here). */
  fields: string[]
  /** The agent's writes to this record in the window. */
  writes: number
  first_at: string
  last_at: string
  /** For remove_comment: the comment id. */
  comment_id?: string
}

export interface RollbackSkip {
  collection: string
  collection_label: string
  item: string
  reason: string
  by?: string | null
  at?: string | null
}

export interface RollbackPlan {
  conn: string
  owner: { id: string; name: string } | null
  from: string
  to: string
  actions: RollbackAction[]
  skipped: RollbackSkip[]
  /** Writes to configuration / system tables in the window: never rolled back here. */
  system_writes: number
  /** More writes than one rollback takes — narrow the window. */
  truncated: boolean
  plan_hash: string
}

export class RollbackError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public plan?: RollbackPlan
  ) {
    super(message)
  }
}

interface ActRow {
  id: number
  action: string
  collection: string | null
  item: string | null
  user: string | null
  timestamp: Date | string
  mcp_conn?: string | null
}

interface Internal extends RollbackAction {
  patch?: Record<string, unknown>
  trash_id?: number
  /** The newest activity id on the record when planned — part of the hash. */
  latest: number
  order: number
}

const iso = (d: Date | string) => new Date(d).toISOString()
const isSystem = (c: string) => /^(nivaro_|directus_)/i.test(c)

const parseObj = (raw: unknown): Record<string, unknown> | null => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Validate a window; `to` defaults to now. Throws RollbackError 400. */
export function parseWindow(
  from: unknown,
  to: unknown,
  now = Date.now()
): { from: Date; to: Date } {
  const f = typeof from === 'string' ? Date.parse(from) : Number.NaN
  if (!Number.isFinite(f)) throw new RollbackError('from must be a date and time', 400)
  const t = to == null || to === '' ? now : typeof to === 'string' ? Date.parse(to) : Number.NaN
  if (!Number.isFinite(t)) throw new RollbackError('to must be a date and time', 400)
  if (t <= f) throw new RollbackError('The window must end after it starts', 400)
  if (t - f > ROLLBACK_MAX_DAYS * DAY)
    throw new RollbackError(`A rollback covers at most ${ROLLBACK_MAX_DAYS} days`, 400)
  return { from: new Date(f), to: new Date(Math.min(t, now)) }
}

async function names(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean).map((i) => i.toLowerCase()))]
  if (!uniq.length) return new Map()
  const rows = (await selectInChunks(uniq, 1000, (chunk) =>
    Promise.resolve(
      db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
    )
  )) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return new Map(
    rows.map((u) => [
      String(u.id).toLowerCase(),
      `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() ||
        (u.email ?? '').split('@')[0] ||
        'Someone'
    ])
  )
}

async function collectionLabels(cols: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(cols)]
  if (!uniq.length) return new Map()
  const rows = (await db('nivaro_collections')
    .whereIn('collection', uniq)
    .select('collection', 'display_name')
    .catch(() => [])) as Array<{ collection: string; display_name: string | null }>
  return new Map(rows.map((r) => [String(r.collection), r.display_name || String(r.collection)]))
}

/** The person most of the rows belong to (a connection acts for one person). */
function ownerOf(rows: ActRow[]): string | null {
  const n = new Map<string, number>()
  for (const r of rows)
    if (r.user) n.set(String(r.user).toLowerCase(), (n.get(String(r.user).toLowerCase()) ?? 0) + 1)
  let best: string | null = null
  for (const [u, c] of n) if (!best || c > (n.get(best) ?? 0)) best = u
  return best
}

function hashOf(actions: Internal[]): string {
  const canon = actions
    .map((a) => [
      a.kind,
      a.collection,
      a.item,
      [...a.fields].sort().join(','),
      a.trash_id ?? '',
      a.comment_id ?? '',
      a.latest
    ])
    .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 32)
}

/**
 * What rolling back `conn` over the window would do. `ownerId` limits it to that person's
 * writes (the person's own route); administrators pass none.
 */
export async function planRollback(opts: {
  conn: string
  from: Date
  to: Date
  ownerId?: string | null
}): Promise<{ plan: RollbackPlan; internal: Internal[] }> {
  if (!CONN_RE.test(opts.conn)) throw new RollbackError('conn is not valid', 400)
  if (!(await hasAttributionColumns()))
    throw new RollbackError(
      'Agent writes are not recorded by connection on this database yet (migration 512)',
      409
    )
  const q = db('nivaro_activity')
    .where('mcp_conn', opts.conn)
    .where('timestamp', '>=', opts.from)
    .where('timestamp', '<=', opts.to)
    .whereIn('action', [...WRITE_ACTIONS])
    .orderBy('id', 'asc')
    .limit(ROLLBACK_MAX_WRITES + 1)
    .select('id', 'action', 'collection', 'item', 'user', 'timestamp')
  if (opts.ownerId) q.where('user', opts.ownerId)
  const raw = (await q) as ActRow[]
  const truncated = raw.length > ROLLBACK_MAX_WRITES
  const ownerId = opts.ownerId?.toLowerCase() ?? ownerOf(raw)
  const rows = raw
    .slice(0, ROLLBACK_MAX_WRITES)
    .filter((r) => !ownerId || String(r.user ?? '').toLowerCase() === ownerId)

  const recordActs = new Map<string, ActRow[]>()
  const commentActs: ActRow[] = []
  let systemWrites = 0
  for (const r of rows) {
    const c = String(r.collection ?? '')
    if (!c || r.item == null || r.item === '') continue
    if (c === 'nivaro_comments') {
      if (r.action === 'create') commentActs.push(r)
      continue
    }
    if (isSystem(c)) {
      systemWrites++
      continue
    }
    const k = `${c}\u0000${r.item}`
    recordActs.set(k, [...(recordActs.get(k) ?? []), r])
  }

  // Everything that happened to those records since the agent's first write in the window.
  const byColl = new Map<string, Array<{ item: string; first: number }>>()
  for (const acts of recordActs.values()) {
    const c = String(acts[0].collection)
    byColl.set(c, [...(byColl.get(c) ?? []), { item: String(acts[0].item), first: acts[0].id }])
  }
  const later = new Map<string, ActRow[]>()
  const revOfAct = new Map<number, { id: number; delta: unknown }>()
  const firstRev = new Map<string, number>()
  for (const [c, list] of byColl) {
    const minFirst = Math.min(...list.map((l) => l.first))
    const items = list.map((l) => l.item)
    const hist = (await selectInChunks(items, 500, (chunk) =>
      Promise.resolve(
        db('nivaro_activity')
          .where('collection', c)
          .whereIn('item', chunk)
          .where('id', '>=', minFirst)
          .whereIn('action', RECORD_HISTORY_ACTIONS)
          .orderBy('id', 'asc')
          .select('id', 'action', 'collection', 'item', 'user', 'timestamp', 'mcp_conn')
      )
    )) as ActRow[]
    const byItem = new Map(list.map((l) => [l.item.toLowerCase(), l]))
    for (const h of hist) {
      // Only what happened from this record's own first agent write on.
      const own = byItem.get(String(h.item).toLowerCase())
      if (!own || Number(h.id) < own.first) continue
      const k = `${c}\u0000${own.item}`
      later.set(k, [...(later.get(k) ?? []), h])
    }
    const actIds = list.flatMap((l) =>
      (recordActs.get(`${c}\u0000${l.item}`) ?? []).map((a) => a.id)
    )
    const revs = (await selectInChunks(actIds, 1000, (chunk) =>
      Promise.resolve(
        db('nivaro_revisions')
          .where('collection', c)
          .whereIn('activity', chunk)
          .select('id', 'activity', 'item', 'delta')
      )
    )) as Array<{ id: number; activity: number; item: string; delta: unknown }>
    for (const r of revs) {
      revOfAct.set(Number(r.activity), { id: Number(r.id), delta: r.delta })
      const k = `${c}\u0000${r.item}`
      const cur = firstRev.get(k)
      if (cur == null || Number(r.id) < cur) firstRev.set(k, Number(r.id))
    }
  }

  // The version before the agent's first change: newest revision older than its first one.
  const baseData = new Map<string, Record<string, unknown> | null>()
  for (const [k, revId] of firstRev) {
    const [c, item] = k.split('\u0000')
    const prev = (await db('nivaro_revisions')
      .where({ collection: c, item })
      .where('id', '<', revId)
      .orderBy('id', 'desc')
      .first('data')) as { data: unknown } | undefined
    baseData.set(k, parseObj(prev?.data))
  }

  const labels = await collectionLabels([
    ...[...recordActs.values()].map((a) => String(a[0].collection))
  ])
  const foreignUsers: string[] = []
  const internal: Internal[] = []
  const skipped: Array<RollbackSkip & { _by?: string | null }> = []
  let order = 0
  for (const [k, acts] of recordActs) {
    const c = String(acts[0].collection)
    const item = String(acts[0].item)
    const label = labels.get(c) ?? c
    const mine = new Set(acts.map((a) => a.id))
    const hist = later.get(k) ?? []
    const foreign = hist.filter((h) => !mine.has(Number(h.id)))
    const latest = hist.length
      ? Math.max(...hist.map((h) => Number(h.id)))
      : acts[acts.length - 1].id
    const base = {
      collection: c,
      collection_label: label,
      item,
      writes: acts.length,
      first_at: iso(acts[0].timestamp),
      last_at: iso(acts[acts.length - 1].timestamp)
    }
    if (foreign.length) {
      const f = foreign[foreign.length - 1]
      const sameAgent = String(f.mcp_conn ?? '').toLowerCase() === opts.conn
      if (f.user) foreignUsers.push(String(f.user))
      skipped.push({
        collection: c,
        collection_label: label,
        item,
        reason: sameAgent
          ? 'The same app changed it again after this window'
          : 'Changed since by someone else',
        at: iso(f.timestamp),
        _by: sameAgent ? null : f.user ? String(f.user) : null
      })
      continue
    }
    const created = acts.some((a) => a.action === 'create')
    const last = acts[acts.length - 1]
    if (created && last.action === 'delete') {
      skipped.push({
        collection: c,
        collection_label: label,
        item,
        reason: 'Created and deleted again in this window — nothing to put back'
      })
      continue
    }
    if (created) {
      internal.push({ ...base, kind: 'delete_created', fields: [], latest, order: order++ })
      continue
    }
    // Fields the agent's updates changed, and their values before its first change.
    const updates = acts.filter((a) => a.action === 'update')
    const changed = new Set<string>()
    let missingHistory = false
    for (const u of updates) {
      const rev = revOfAct.get(u.id)
      if (!rev) {
        missingHistory = true
        continue
      }
      for (const f of Object.keys(parseObj(rev.delta) ?? {}))
        if (!STAMP_FIELDS.has(f)) changed.add(f)
    }
    const before = baseData.get(k) ?? null
    const patch: Record<string, unknown> = {}
    if (before) for (const f of changed) if (f in before) patch[f] = before[f]
    const fields = Object.keys(patch).sort()

    if (last.action === 'delete') {
      const trash = (await db('nivaro_trash')
        .where({ collection: c, item_id: item })
        .where('deleted_at', '>=', new Date(new Date(last.timestamp).getTime() - 60_000))
        .orderBy('deleted_at', 'desc')
        .first('id')
        .catch(() => undefined)) as { id: number } | undefined
      if (!trash) {
        skipped.push({
          collection: c,
          collection_label: label,
          item,
          reason: 'Deleted, and no longer in the trash'
        })
        continue
      }
      internal.push({
        ...base,
        kind: 'restore_deleted',
        fields,
        ...(fields.length ? { patch } : {}),
        trash_id: Number(trash.id),
        latest,
        order: order++
      })
      continue
    }
    if (updates.length && missingHistory && !fields.length) {
      skipped.push({
        collection: c,
        collection_label: label,
        item,
        reason: 'No history is kept for this collection, so the earlier values are not known'
      })
      continue
    }
    if (!before) {
      skipped.push({
        collection: c,
        collection_label: label,
        item,
        reason: 'No earlier version was kept'
      })
      continue
    }
    if (!fields.length) {
      skipped.push({ collection: c, collection_label: label, item, reason: 'Nothing to put back' })
      continue
    }
    internal.push({ ...base, kind: 'restore_values', fields, patch, latest, order: order++ })
  }

  // Comments the agent posted (still standing).
  if (commentActs.length) {
    const ids = [...new Set(commentActs.map((a) => String(a.item)))]
    const comments = (await selectInChunks(ids, 1000, (chunk) =>
      Promise.resolve(
        db('nivaro_comments')
          .whereIn('id', chunk)
          .select('id', 'collection', 'item', 'user', 'deleted_at', 'created_at')
      )
    )) as Array<{
      id: string
      collection: string
      item: string
      user: string
      deleted_at: Date | null
      created_at: Date | string
    }>
    const clabels = await collectionLabels(comments.map((c) => c.collection))
    for (const cm of comments) {
      if (cm.deleted_at) continue
      if (ownerId && String(cm.user).toLowerCase() !== ownerId) continue
      const act = commentActs.find(
        (a) => String(a.item).toLowerCase() === String(cm.id).toLowerCase()
      )
      internal.push({
        kind: 'remove_comment',
        collection: String(cm.collection),
        collection_label: clabels.get(String(cm.collection)) ?? String(cm.collection),
        item: String(cm.item),
        fields: [],
        writes: 1,
        first_at: iso(act?.timestamp ?? cm.created_at),
        last_at: iso(act?.timestamp ?? cm.created_at),
        comment_id: String(cm.id),
        latest: Number(act?.id ?? 0),
        order: order++
      })
    }
  }

  const who = await names([...(ownerId ? [ownerId] : []), ...foreignUsers])
  const plan: RollbackPlan = {
    conn: opts.conn,
    owner: ownerId ? { id: ownerId, name: who.get(ownerId) ?? 'Someone' } : null,
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    actions: internal.map(({ patch: _p, trash_id: _t, latest: _l, order: _o, ...a }) => a),
    skipped: skipped.map(({ _by, ...s }) => ({
      ...s,
      ...(_by !== undefined ? { by: _by ? (who.get(_by.toLowerCase()) ?? 'Someone') : null } : {})
    })),
    system_writes: systemWrites,
    truncated,
    plan_hash: hashOf(internal)
  }
  return { plan, internal }
}

export interface RollbackResult {
  plan_hash: string
  done: number
  failed: Array<{ collection: string; item: string; kind: RollbackKind; error: string }>
  skipped: number
  acted_as: 'owner' | 'administrator'
}

/** Soft-delete one comment the way DELETE /comments/:id does (tombstone + version). */
async function removeComment(id: string, byUserId: string, req?: FastifyRequest): Promise<void> {
  const row = await db.transaction(async (trx) => {
    const existing = (await trx('nivaro_comments').where({ id }).forUpdate().first()) as
      | { id: string; text: string; collection: string; item: string; deleted_at: Date | null }
      | undefined
    if (!existing || existing.deleted_at) return null
    const last = (await trx('nivaro_comment_versions')
      .where('comment', id)
      .max({ v: 'version' })
      .first()) as { v: number | null } | undefined
    await trx('nivaro_comment_versions').insert({
      comment: id,
      version: Number(last?.v ?? 0) + 1,
      text: existing.text,
      user: byUserId,
      created_at: new Date()
    })
    await trx('nivaro_comments')
      .where({ id })
      .update({ text: '', deleted_at: new Date(), deleted_by: byUserId })
    await trx('nivaro_comment_reactions').where('comment', id).del()
    await trx('nivaro_comment_mentions').where('comment', id).del()
    return existing
  })
  if (!row) return
  announceRecordAspect(row.collection, row.item, '$comments')
  await logActivity({
    action: 'delete',
    collection: 'nivaro_comments',
    item: id,
    user: byUserId,
    req
  })
}

/**
 * Carry out a previewed rollback. `caller` is the person asking (the owner, or an
 * administrator); the plan must still hash to `planHash`.
 */
export async function applyRollback(opts: {
  caller: User
  callerIsAdmin: boolean
  req: FastifyRequest
  conn: string
  from: Date
  to: Date
  ownerId?: string | null
  planHash: string
}): Promise<RollbackResult> {
  const { plan, internal } = await planRollback({
    conn: opts.conn,
    from: opts.from,
    to: opts.to,
    ownerId: opts.ownerId
  })
  if (plan.truncated)
    throw new RollbackError(
      `More than ${ROLLBACK_MAX_WRITES} changes in this window — choose a shorter one`,
      400,
      plan
    )
  if (plan.plan_hash !== opts.planHash)
    throw new RollbackError(
      'Records changed since the preview — review the new preview and apply again',
      409,
      plan
    )
  const ownerId = plan.owner?.id ?? null
  const callerId = String(opts.caller.id).toLowerCase()
  let actor: User = opts.caller
  let actedAs: RollbackResult['acted_as'] = 'owner'
  if (ownerId && ownerId !== callerId) {
    if (!opts.callerIsAdmin) throw new RollbackError('That connection is not yours', 403)
    const owner = await getUser(ownerId).catch(() => undefined)
    if (owner && owner.status === 'active') actor = owner
    else actedAs = 'administrator'
  }
  // The caller's own request rides along only when the caller is the one acting.
  const req = actor === opts.caller ? opts.req : undefined
  const ws = opts.req.workspaceId ?? undefined

  const failed: RollbackResult['failed'] = []
  let done = 0
  // Newest first, so a child the agent created after its parent goes before the parent.
  const ordered = [...internal].sort((a, b) => b.order - a.order)
  for (const a of ordered) {
    try {
      if (a.kind === 'delete_created') await deleteOne(actor, a.collection, a.item, req, ws)
      else if (a.kind === 'restore_values' && a.patch)
        await updateOne(actor, a.collection, a.item, a.patch, req, ws)
      else if (a.kind === 'restore_deleted' && a.trash_id != null) {
        await restoreTrashRow(actor, a.trash_id, req)
        if (a.patch && Object.keys(a.patch).length)
          await updateOne(actor, a.collection, a.item, a.patch, req, ws)
      } else if (a.kind === 'remove_comment' && a.comment_id)
        await removeComment(a.comment_id, String(actor.id), req)
      done++
    } catch (err) {
      failed.push({
        collection: a.collection,
        item: a.item,
        kind: a.kind,
        error: ((err as Error)?.message ?? 'Failed').slice(0, 300)
      })
    }
  }
  await logActivity({
    action: 'mcp-rollback',
    user: opts.caller.id,
    comment: JSON.stringify({
      conn: opts.conn,
      owner: ownerId,
      from: plan.from,
      to: plan.to,
      done,
      failed: failed.length,
      skipped: plan.skipped.length,
      acted_as: actedAs
    }).slice(0, 2000),
    req: opts.req
  })
  return {
    plan_hash: plan.plan_hash,
    done,
    failed,
    skipped: plan.skipped.length,
    acted_as: actedAs
  }
}
