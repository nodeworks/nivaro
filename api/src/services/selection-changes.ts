/**
 * "3 selected rows changed since you picked them" (realtime round 8, item 6).
 *
 * A list's selection remembers when each row was picked; before a bulk action the bar asks
 * which of them someone ELSE has changed since — who, which fields, or a move to another step.
 * Everything is judged as the caller:
 *
 * - only records the caller can read NOW (the record-room gate: role read, row filters,
 *   User Scopes — visibleRecordIds); the rest answer nothing, as if unchanged;
 * - field NAMES only, cut to the caller's read list, labelled as the caller may read them;
 * - people by display name through the activity labels (directory columns, never a redacted
 *   account); a View-as write names the person, never the administrator behind it;
 * - the caller's own writes never count.
 *
 * Reads: one activity read + one revision read (field names) + one pipeline history read per
 * call, each bounded (≤ MAX_ITEMS records, ≤ MAX_ROWS rows, a window of ≤ MAX_WINDOW_MS).
 */
import type { User } from '../types.js'

export const MAX_ITEMS = 200
export const MAX_ROWS = 2000
/** A selection older than this is judged from this far back (a stale tab, a bad clock). */
export const MAX_WINDOW_MS = 7 * 24 * 3_600_000

export const SELECTION_ACTIONS = ['create', 'update', 'delete'] as const

/** Audit stamps move on every write; they are not what a reader means by "changed". */
const STAMP_FIELDS = new Set(['updated_at', 'date_updated', 'user_updated', 'changed'])
const NAME_RE = /^[A-Za-z0-9_]{1,128}$/

export interface SelectionAsk {
  collection: string
  /** Record id → the instant (ms) it was picked. */
  since: Map<string, number>
}

/** Read and bound the body; null when it names no usable collection or record. */
export function parseSelectionAsk(body: unknown, now = Date.now()): SelectionAsk | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const collection = typeof b.collection === 'string' ? b.collection : ''
  if (!NAME_RE.test(collection) || /^(nivaro_|directus_)/i.test(collection)) return null
  const items = Array.isArray(b.items) ? b.items : []
  const since = new Map<string, number>()
  const floor = now - MAX_WINDOW_MS
  for (const raw of items) {
    if (since.size >= MAX_ITEMS) break
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const id = r.id
    if (id == null || (typeof id !== 'string' && typeof id !== 'number')) continue
    const key = String(id).trim()
    if (!key || key.length > 100) continue
    const t = typeof r.since === 'number' ? r.since : new Date(String(r.since ?? '')).getTime()
    if (!Number.isFinite(t)) continue
    since.set(key, Math.min(Math.max(t, floor), now))
  }
  return since.size > 0 ? { collection, since } : null
}

/** Field names of a revision delta, without the audit stamps (null = not knowable). */
export function deltaNames(delta: unknown): string[] | null {
  let obj: unknown = delta
  if (typeof delta === 'string') {
    try {
      obj = JSON.parse(delta)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  return Object.keys(obj as Record<string, unknown>).filter((k) => !STAMP_FIELDS.has(k))
}

export interface ActivityHit {
  item: string
  action: string
  user: string | null
  at: number
  /** Changed field names (updates), already cut to what the caller may read; null = unknown. */
  fields?: string[] | null
}

export interface MoveHit {
  item: string
  user: string | null
  at: number
  /** The step it went to (label as stored). */
  to: string | null
}

export interface SelectionChange {
  /** Newest change (ISO). */
  at: string
  /** Who changed it (person ids, newest first); empty = an automatic / unnamed write. */
  by: string[]
  /** Fields changed (names, readable ones); empty with `fields_unknown` = could not say. */
  fields: string[]
  fields_unknown?: boolean
  /** The step it moved to, when someone moved it. */
  moved_to?: string | null
  /** Someone deleted it. */
  deleted?: boolean
}

const keyOf = (id: string) => id.toLowerCase()

/**
 * Fold the reads into one change per record, keeping only what happened after that record
 * was picked and was not the caller's own doing. Ids keep the spelling the caller sent.
 */
export function foldSelectionChanges(
  ask: SelectionAsk,
  me: string,
  activity: ActivityHit[],
  moves: MoveHit[]
): Record<string, SelectionChange> {
  const sent = new Map([...ask.since.keys()].map((id) => [keyOf(id), id]))
  const since = new Map([...ask.since].map(([id, t]) => [keyOf(id), t]))
  const mine = me.toLowerCase()
  const acc = new Map<
    string,
    {
      at: number
      by: string[]
      fields: Set<string>
      unknown: boolean
      moved?: string | null
      deleted?: boolean
    }
  >()
  const entry = (k: string) => {
    let e = acc.get(k)
    if (!e) {
      e = { at: 0, by: [], fields: new Set(), unknown: false }
      acc.set(k, e)
    }
    return e
  }
  const counts = (item: string, user: string | null, at: number) => {
    const k = keyOf(item)
    const s = since.get(k)
    if (s == null || at <= s) return null
    if (user && user.toLowerCase() === mine) return null
    return k
  }
  const noteBy = (e: { by: string[] }, user: string | null) => {
    if (!user) return
    if (!e.by.some((b) => b.toLowerCase() === user.toLowerCase())) e.by.push(user)
  }
  for (const a of [...activity].sort((x, y) => y.at - x.at)) {
    const k = counts(a.item, a.user, a.at)
    if (!k) continue
    const e = entry(k)
    e.at = Math.max(e.at, a.at)
    noteBy(e, a.user)
    if (a.action === 'delete') e.deleted = true
    else if (a.action === 'update') {
      if (a.fields == null) e.unknown = true
      else for (const f of a.fields) e.fields.add(f)
    }
  }
  for (const m of [...moves].sort((x, y) => y.at - x.at)) {
    const k = counts(m.item, m.user, m.at)
    if (!k) continue
    const e = entry(k)
    // Newest move first: the step it sits in now.
    if (e.moved === undefined) e.moved = m.to
    e.at = Math.max(e.at, m.at)
    noteBy(e, m.user)
  }
  const out: Record<string, SelectionChange> = {}
  for (const [k, e] of acc) {
    const id = sent.get(k)
    if (!id) continue
    // An update that named only audit stamps changed nothing a reader would call a change.
    if (!e.deleted && e.moved === undefined && e.fields.size === 0 && !e.unknown) continue
    out[id] = {
      at: new Date(e.at).toISOString(),
      by: e.by,
      fields: [...e.fields],
      ...(e.unknown && e.fields.size === 0 ? { fields_unknown: true } : {}),
      ...(e.moved !== undefined ? { moved_to: e.moved } : {}),
      ...(e.deleted ? { deleted: true } : {})
    }
  }
  return out
}

export interface SelectionChangesAnswer {
  changes: Record<string, SelectionChange>
  /** Labels read as the caller: records (`collection:id`), people (id), fields (`collection.field`). */
  labels: {
    records: Record<string, string | null>
    users: Record<string, string>
    fields: Record<string, string>
  }
}

/** The database half (kept apart so the fold above stays a plain, tested function). */
export async function readSelectionChanges(
  user: User,
  isAdmin: boolean,
  ask: SelectionAsk
): Promise<SelectionChangesAnswer> {
  const empty: SelectionChangesAnswer = {
    changes: {},
    labels: { records: {}, users: {}, fields: {} }
  }
  const [{ db }, { can }, { visibleRecordIds }, { readableFieldSet, keepReadable }, batch] =
    await Promise.all([
      import('../db/index.js'),
      import('./permissions.js'),
      import('./socket-access.js'),
      import('./revision-fields.js'),
      import('./db-batch.js')
    ])
  const { collection } = ask
  if (!isAdmin && !(await can(user, 'read', collection).catch(() => false))) return empty
  const visible = await visibleRecordIds(user, collection, [...ask.since.keys()], isAdmin)
  if (visible.length === 0) return empty
  const seen = new Set(visible.map(keyOf))
  const scoped: SelectionAsk = {
    collection,
    since: new Map([...ask.since].filter(([id]) => seen.has(keyOf(id))))
  }
  const ids = [...scoped.since.keys()]
  const from = new Date(Math.min(...scoped.since.values()))

  const activityRows = (await batch
    .whereInList(db('nivaro_activity'), 'item', ids)
    .where('collection', collection)
    .whereIn('action', SELECTION_ACTIONS as unknown as string[])
    .where('timestamp', '>', from)
    .where((q) => q.whereNull('user').orWhereNot('user', String(user.id)))
    .orderBy('id', 'desc')
    .limit(MAX_ROWS)
    .select('id', 'item', 'action', 'user', 'timestamp')) as Array<{
    id: number
    item: string | number
    action: string
    user: string | null
    timestamp: Date | string
  }>

  const updateIds = activityRows.filter((r) => r.action === 'update').map((r) => r.id)
  const names = new Map<number, string[] | null>()
  if (updateIds.length) {
    const revs = (await batch.selectInChunks(updateIds, 1000, (chunk) =>
      batch.whereInList(db('nivaro_revisions'), 'activity', chunk).select('activity', 'delta')
    )) as Array<{ activity: number; delta: unknown }>
    for (const r of revs) names.set(Number(r.activity), deltaNames(r.delta))
  }
  const readable = await readableFieldSet(user, collection).catch(() => new Set(['id']))
  const activity: ActivityHit[] = activityRows.map((r) => {
    const n = r.action === 'update' ? (names.get(r.id) ?? null) : undefined
    return {
      item: String(r.item),
      action: r.action,
      user: r.user ? String(r.user) : null,
      at: new Date(r.timestamp).getTime(),
      ...(n !== undefined ? { fields: n ? keepReadable(n, readable) : null } : {})
    }
  })

  const moveRows = (await batch
    .whereInList(
      db('nivaro_workflow_history as h')
        .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
        .leftJoin('nivaro_workflow_states as ts', 'ts.id', 'h.to_state'),
      'i.item',
      ids
    )
    .where('i.collection', collection)
    .where('h.timestamp', '>', from)
    .whereNotNull('h.from_state')
    .where((q) => q.whereNull('h.user').orWhereNot('h.user', String(user.id)))
    .orderBy('h.timestamp', 'desc')
    .limit(MAX_ROWS)
    .select('i.item', 'h.user', 'h.timestamp', 'ts.label as to_label')
    .catch(() => [])) as Array<{
    item: string | number
    user: string | null
    timestamp: Date | string
    to_label: string | null
  }>
  const moves: MoveHit[] = moveRows.map((r) => ({
    item: String(r.item),
    user: r.user ? String(r.user) : null,
    at: new Date(r.timestamp).getTime(),
    to: r.to_label ?? null
  }))

  const changes = foldSelectionChanges(scoped, String(user.id), activity, moves)
  const changed = Object.keys(changes)
  if (changed.length === 0) return empty

  const { activityLabelsFor } = await import('./activity-readable.js')
  const people = [...new Set(changed.flatMap((id) => changes[id].by))]
  const fieldNames = [...new Set(changed.flatMap((id) => changes[id].fields))]
  const labels = await activityLabelsFor(
    user,
    {
      refs: changed.map((id) => ({ collection, id })),
      users: people,
      fields: fieldNames.map((field) => ({ collection, field })),
      collections: [collection]
    },
    { isAdmin }
  ).catch(() => null)
  return {
    changes,
    labels: {
      records: labels?.records ?? {},
      users: labels?.users ?? {},
      fields: labels?.fields ?? {}
    }
  }
}
