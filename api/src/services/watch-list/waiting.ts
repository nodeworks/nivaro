import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { tenantState } from '../ai-tenant-state.js'
import { whereInList } from '../db-batch.js'

/**
 * "Waiting on others" (rt5 #2): records the person raised that now sit on a pipeline step
 * someone else owns — who it waits on and since when. Read AS THE PERSON: every record passes
 * the same read gate a list applies (role policy, row filters, User Scopes) before anything
 * about it is answered.
 *
 * "Raised" = the person created the record (their `create` activity, last 180 days — the same
 * signal the Overview's "My records" uses) or a `user-created` field on the record names them.
 * The `user-created` read is only made on collections with an open pipeline and only for the
 * open records there, so it never scans a table.
 */

export const WAITING_MAX = 50
const RAISED_DAYS = 180
const RAISED_CAP = 400
const CACHE_MS = 20_000

export interface WaitingRow {
  key: string
  collection: string
  collection_label: string
  id: string
  title: string
  state: { key: string; label: string; color: string | null } | null
  /** The step's owners (not the person). */
  waiting_on: Array<{ id: string; name: string; inactive?: 'suspended' | 'former' }>
  /** When the record arrived on this step (ISO). */
  since: string | null
}

/** Is this record waiting on someone other than the person? Pure; exported for tests. */
export function waitsOnOthers(
  selfId: string,
  owners: Array<{ id: string }>,
  open: boolean
): boolean {
  if (!open || owners.length === 0) return false
  const me = selfId.toLowerCase()
  return !owners.some((o) => String(o.id).toLowerCase() === me)
}

/** Longest wait first; a record with no arrival time last. */
export function sortWaiting(rows: WaitingRow[]): WaitingRow[] {
  return [...rows].sort((a, z) => {
    const ta = a.since ? new Date(a.since).getTime() : Number.POSITIVE_INFINITY
    const tz = z.since ? new Date(z.since).getTime() : Number.POSITIVE_INFINITY
    return ta - tz
  })
}

const cache = tenantState(() => new Map<string, { at: number; rows: WaitingRow[] }>())
/** Who raised what moves slowly (a new record is seconds old at most): kept 5 minutes. */
const RAISED_MS = 5 * 60_000
const raisedCache = tenantState(
  () => new Map<string, { at: number; set: Map<string, Set<string>> }>()
)

/** Records the person raised, by collection (create activity + user-created fields). */
async function raisedRecords(userId: string, now: Date): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const add = (c: string, id: unknown) => {
    if (!c || /^(nivaro_|directus_)/i.test(c) || id == null || id === '') return
    let s = out.get(c)
    if (!s) {
      s = new Set()
      out.set(c, s)
    }
    s.add(String(id))
  }
  const created = (await db('nivaro_activity')
    .where({ user: userId, action: 'create' })
    .whereNotNull('item')
    .where('timestamp', '>=', new Date(now.getTime() - RAISED_DAYS * 86_400_000))
    .orderBy('timestamp', 'desc')
    .limit(RAISED_CAP)
    .select('collection', 'item')
    .catch(() => [])) as Array<{ collection: string; item: string }>
  for (const r of created) add(r.collection, r.item)

  // `user-created` fields, read only against open pipeline records (bounded, keyed by id).
  try {
    const { getFields } = await import('../collections.js')
    const openCols = (await db('nivaro_workflow_instances')
      .whereNull('completed_at')
      .distinct('collection')
      .catch(() => [])) as Array<{ collection: string }>
    for (const { collection } of openCols.slice(0, 10)) {
      if (!collection || /^(nivaro_|directus_)/i.test(collection)) continue
      const fields = await getFields(collection).catch(() => [])
      const creator = (fields as Array<{ field: string; special: string[] | null }>).find((f) =>
        (f.special ?? []).includes('user-created')
      )
      if (!creator) continue
      const open = (await db('nivaro_workflow_instances')
        .where({ collection })
        .whereNull('completed_at')
        .orderBy('started_at', 'desc')
        .limit(1000)
        .select('item')
        .catch(() => [])) as Array<{ item: string }>
      const ids = open.map((r) => String(r.item)).filter((i) => /^[A-Za-z0-9_.:-]{1,64}$/.test(i))
      for (let i = 0; i < ids.length; i += 500) {
        const rows = (await whereInList(db(collection), 'id', ids.slice(i, i + 500))
          .where(creator.field, userId)
          .select('id')
          .catch(() => [])) as Array<{ id: unknown }>
        for (const r of rows) add(collection, r.id)
      }
    }
  } catch {
    /* the create activity alone still answers */
  }
  return out
}

export async function readWaiting(
  user: User,
  isAdmin: boolean,
  opts: { now?: Date; fresh?: boolean } = {}
): Promise<WaitingRow[]> {
  const now = opts.now ?? new Date()
  const userId = String(user.id)
  const ck = `${userId}|${isAdmin ? 'a' : 'u'}`
  const hit = cache().get(ck)
  if (!opts.fresh && hit && now.getTime() - hit.at < CACHE_MS) return hit.rows

  const rc = raisedCache().get(userId)
  let raised: Map<string, Set<string>>
  if (!opts.fresh && rc && now.getTime() - rc.at < RAISED_MS) raised = rc.set
  else {
    raised = await raisedRecords(userId, now)
    raisedCache().set(userId, { at: now.getTime(), set: raised })
    if (raisedCache().size > 2000) raisedCache().clear()
  }
  const out: WaitingRow[] = []
  const { compileAccessGates, visibleIds } = await import('../record-access.js')
  const { getCollection } = await import('../collections.js')
  const { readableName } = await import('../command-center/regions.js')
  const { resolvedOwnerNames } = await import('../../routes/pipelines.js')
  const { excludeBranchChildren } = await import('../branch-instances.js')
  const { pickInstancePerItem } = await import('../../routes/pipelines.js')

  for (const [collection, idSet] of raised) {
    const ids = [...idSet]
    // Open pipeline records only.
    const instRows = (await whereInList(
      db('nivaro_workflow_instances').where({ collection }),
      'item',
      ids
    )
      .select('id', 'collection', 'item', 'template', 'current_state', 'completed_at', 'started_at')
      .catch(() => [])) as Array<{
      id: string
      collection: string
      item: string
      template: string
      current_state: string | null
      completed_at: Date | null
      started_at: Date | null
    }>
    const insts = pickInstancePerItem(await excludeBranchChildren(instRows)).filter(
      (i) => !i.completed_at && i.current_state
    )
    if (insts.length === 0) continue
    const gates = await compileAccessGates(user, collection, { actingAdmin: isAdmin }).catch(
      () => null
    )
    if (!gates) continue
    const visible = await visibleIds(
      gates,
      insts.map((i) => String(i.item))
    ).catch(() => new Set<string>())
    const live = insts.filter((i) => visible.has(String(i.item)))
    if (live.length === 0) continue
    const liveIds = live.map((i) => String(i.item))
    const owners = await resolvedOwnerNames(collection, liveIds).catch(
      () => ({}) as Record<string, WaitingRow['waiting_on']>
    )
    const waiting = live.filter((i) =>
      waitsOnOthers(userId, owners[String(i.item)] ?? [], !i.completed_at)
    )
    if (waiting.length === 0) continue
    // Arrival on the step: the newest history row into the current state, else the start.
    const arrivals = (await whereInList(
      db('nivaro_workflow_history'),
      'instance',
      waiting.map((i) => i.id)
    )
      .select('instance', 'to_state')
      .max({ at: 'timestamp' })
      .groupBy('instance', 'to_state')
      .catch(() => [])) as Array<{ instance: string; to_state: string | null; at: Date }>
    const arrivedAt = new Map<string, Date>()
    for (const a of arrivals) arrivedAt.set(`${a.instance}|${a.to_state}`.toLowerCase(), a.at)
    const states = (await db('nivaro_workflow_states')
      .whereIn('id', [...new Set(waiting.map((i) => i.current_state as string))])
      .select('id', 'key', 'label', 'color')
      .catch(() => [])) as Array<{ id: string; key: string; label: string; color: string | null }>
    const stateById = new Map(states.map((s) => [String(s.id).toLowerCase(), s]))
    const meta = await getCollection(collection).catch(() => undefined)
    const label = readableName(collection, meta?.singular ?? meta?.display_name)
    let titles: Record<string, string> = {}
    try {
      const { recordLabelsAsViewer } = await import('../record-labels-as-viewer.js')
      titles = await recordLabelsAsViewer(
        user,
        waiting.map((i) => ({ collection, id: String(i.item) }))
      )
    } catch {
      /* fall back to the collection name + id */
    }
    for (const i of waiting) {
      const st = stateById.get(String(i.current_state).toLowerCase())
      const arrived =
        arrivedAt.get(`${i.id}|${i.current_state}`.toLowerCase()) ?? i.started_at ?? null
      out.push({
        key: `${collection}:${i.item}`,
        collection,
        collection_label: label,
        id: String(i.item),
        title: titles[`${collection}:${i.item}`] || `${label} ${i.item}`,
        state: st ? { key: st.key, label: st.label, color: st.color ?? null } : null,
        waiting_on: (owners[String(i.item)] ?? []).slice(0, 4),
        since: arrived ? new Date(arrived).toISOString() : null
      })
    }
  }
  const rows = sortWaiting(out).slice(0, WAITING_MAX)
  cache().set(ck, { at: now.getTime(), rows })
  if (cache().size > 2000) cache().clear()
  return rows
}
