// api/src/services/traffic-taps/hot-records.ts
/**
 * Traffic Map tap `hot-records` (#1119) — the records of an entity being written or locked right
 * now: writes per record (capped), 409s per record (item writes and item-lock routes), lock
 * acquisitions; the inspector's detail adds who holds a lock and how long its wait queue is
 * (read from nivaro_item_locks / nivaro_item_lock_queue at detail time). Memory + one read.
 */
import { db } from '../../db/index.js'
import { MinuteCounter } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const HOT_RECORDS_TAP = 'hot-records'
const ENTITY_CAP = 400
const RECORDS_PER_ENTITY = 40
const ROW_LIMIT = 10
const COLLECTION_RE = /^[A-Za-z0-9_]{1,120}$/
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
/** `/api/items/:collection/<word>` routes that are not a record. */
const NOT_A_RECORD = new Set(['bulk', 'batch', 'aggregate', 'distinct', 'resolve-paths', 'by-slug'])

interface EntityRecords {
  writes: MinuteCounter
  conflicts: MinuteCounter
  locks: MinuteCounter
}
interface State {
  entities: Map<string, EntityRecords>
}
const state = () => tapState<State>(HOT_RECORDS_TAP, () => ({ entities: new Map() }))

/** The lane a collection's writes land on (the map's own rule for writes). */
export function laneOfCollection(collection: string): 'items' | 'system' {
  return /^(nivaro_|directus_|sys)/.test(collection) ? 'system' : 'items'
}

function recordsOf(entityKey: string): EntityRecords | null {
  const map = state().entities
  let e = map.get(entityKey)
  if (e) return e
  if (map.size >= ENTITY_CAP) return null
  e = {
    writes: new MinuteCounter(RECORDS_PER_ENTITY),
    conflicts: new MinuteCounter(RECORDS_PER_ENTITY),
    locks: new MinuteCounter(RECORDS_PER_ENTITY)
  }
  map.set(entityKey, e)
  return e
}

/** `{collection, id, lock}` a request path names a record by (items + item-lock routes). */
export function recordOfRequestPath(
  path: string
): { collection: string; id: string; lock: boolean } | null {
  const seg = path.split('?')[0].split('/').filter(Boolean)
  // api / items / :collection / :id
  if (seg[0] !== 'api' || seg.length < 4) return null
  if (seg[1] !== 'items' && seg[1] !== 'item-locks') return null
  if (seg[1] === 'item-locks' && seg[2] === 'config') return null
  const collection = decodeURIComponent(seg[2])
  const id = decodeURIComponent(seg[3])
  if (!COLLECTION_RE.test(collection) || !ID_RE.test(id) || NOT_A_RECORD.has(id)) return null
  return { collection, id, lock: seg[1] === 'item-locks' }
}

export function recordWrite(entityKey: string, id: string, sec: number): void {
  if (!ID_RE.test(id)) return
  recordsOf(entityKey)?.writes.bump(id, sec)
}

export function recordRequest(path: string, method: string, status: number, sec: number): void {
  const rec = recordOfRequestPath(path)
  if (!rec) return
  const key = `${laneOfCollection(rec.collection)}/${rec.collection}`
  if (status === 409) {
    recordsOf(key)?.conflicts.bump(rec.id, sec)
    return
  }
  // A lock acquisition (POST …/lock) that succeeded: the record is being edited right now.
  if (rec.lock && method === 'POST' && status < 400 && /\/lock\/?$/.test(path.split('?')[0]))
    recordsOf(key)?.locks.bump(rec.id, sec)
}

export interface HotRecordRow {
  id: string
  label: string | null
  writes: number
  conflicts: number
  lock_acquires: number
  locked_by: string | null
  queue: number
}

/** Rank by activity: writes + 3 × 409s + lock acquisitions + held lock + waiting people. */
export function rankHotRecords(
  rows: Array<Omit<HotRecordRow, 'label'>>,
  limit = ROW_LIMIT
): Array<Omit<HotRecordRow, 'label'>> {
  const score = (r: Omit<HotRecordRow, 'label'>) =>
    r.writes + 3 * r.conflicts + r.lock_acquires + (r.locked_by ? 2 : 0) + r.queue * 2
  return rows
    .filter((r) => score(r) > 0)
    .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
    .slice(0, limit)
}

interface LockRead {
  locks: Map<string, string>
  queues: Map<string, number>
}

async function readLocks(collection: string): Promise<LockRead> {
  const out: LockRead = { locks: new Map(), queues: new Map() }
  try {
    const locks = (await db('nivaro_item_locks as l')
      .leftJoin('nivaro_users as u', 'u.id', 'l.user')
      .where('l.collection', collection)
      .where('l.expires_at', '>', new Date())
      .select('l.item', 'u.first_name', 'u.last_name', 'u.email')
      .limit(200)) as Array<{
      item: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    for (const l of locks) {
      const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'someone'
      out.locks.set(String(l.item), name)
    }
  } catch {
    /* table absent on an old tenant */
  }
  try {
    const q = (await db('nivaro_item_lock_queue')
      .where('collection', collection)
      .groupBy('item')
      .select('item')
      .count('* as n')) as Array<{ item: string; n: number | string }>
    for (const r of q) out.queues.set(String(r.item), Number(r.n) || 0)
  } catch {
    /* migration 306 not run */
  }
  return out
}

export interface HotRecordsDetail {
  window_s: number
  collection: string
  rows: HotRecordRow[]
}

export async function hotRecordsDetail(
  entityKey: string,
  windowS: number,
  sec: number,
  deps: {
    locks?: (collection: string) => Promise<LockRead>
    labels?: (collection: string, ids: string[]) => Promise<Record<string, string>>
  } = {}
): Promise<HotRecordsDetail | undefined> {
  const cut = entityKey.indexOf('/')
  const lane = entityKey.slice(0, cut)
  if (lane !== 'items' && lane !== 'system') return undefined
  const collection = entityKey.slice(cut + 1)
  if (!COLLECTION_RE.test(collection)) return undefined
  const e = state().entities.get(entityKey)
  const lockRead = await (deps.locks ?? readLocks)(collection)
  const byId = new Map<string, Omit<HotRecordRow, 'label'>>()
  const row = (id: string) => {
    let r = byId.get(id)
    if (!r) {
      r = { id, writes: 0, conflicts: 0, lock_acquires: 0, locked_by: null, queue: 0 }
      byId.set(id, r)
    }
    return r
  }
  if (e) {
    for (const [id, n] of e.writes.top(windowS, sec)) if (id !== '__other__') row(id).writes = n
    for (const [id, n] of e.conflicts.top(windowS, sec))
      if (id !== '__other__') row(id).conflicts = n
    for (const [id, n] of e.locks.top(windowS, sec))
      if (id !== '__other__') row(id).lock_acquires = n
  }
  for (const [id, who] of lockRead.locks) row(id).locked_by = who
  for (const [id, n] of lockRead.queues) row(id).queue = n
  const ranked = rankHotRecords([...byId.values()])
  if (ranked.length === 0) return undefined
  let labels: Record<string, string> = {}
  try {
    labels = await (
      deps.labels ??
      (async (c: string, ids: string[]) => {
        const { getLabels } = await import('../queues.js')
        const raw = await getLabels(new Map([[c, new Set(ids)]]))
        const out: Record<string, string> = {}
        for (const id of ids) if (raw[`${c}:${id}`]) out[id] = raw[`${c}:${id}`]
        return out
      })
    )(
      collection,
      ranked.map((r) => r.id)
    )
  } catch {
    labels = {}
  }
  return {
    window_s: windowS,
    collection,
    rows: ranked.map((r) => ({ ...r, label: labels[r.id] ?? null }))
  }
}

export const hotRecordsTap: TrafficTap = {
  id: HOT_RECORDS_TAP,
  onWrite(c) {
    recordWrite(c.entityKey, String(c.ev.item), c.sec)
  },
  onRequest(c) {
    if (c.ev.status === 409 || (c.ev.method === 'POST' && c.ev.path.includes('/item-locks/')))
      recordRequest(c.ev.path, c.ev.method, c.ev.status, c.sec)
  },
  entityDetail(key, windowS, sec) {
    return hotRecordsDetail(key, windowS, sec)
  },
  sweep(sec) {
    const map = state().entities
    for (const [k, e] of map) {
      e.writes.sweep(sec)
      e.conflicts.sweep(sec)
      e.locks.sweep(sec)
      if (e.writes.size + e.conflicts.size + e.locks.size === 0) map.delete(k)
    }
  }
}

registerTrafficTap(hotRecordsTap)
