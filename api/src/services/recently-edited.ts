import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { activityListSource } from './activity-filters.js'
import { activityLabelsFor } from './activity-readable.js'
import { type ActivityLabels, parseTransitionComment } from './activity-sentence.js'
import { selectInChunks } from './db-batch.js'

/**
 * #22 "Recently edited by me" — the records a person CHANGED (created, edited fields, moved
 * in the pipeline, commented on), newest first across collections, beside "Recently viewed"
 * (which is what they opened). Read from nivaro_activity by the (user, timestamp DESC) index
 * (migration 334) in widening windows, so a busy person's newest edits answer from a few
 * days of their own rows. Every record is judged AS THE CALLER through `activityLabelsFor`:
 * a record they can no longer read (User Scope, row filter, policy, deleted) is left out, and
 * its label is read as them. Link-table (junction) writes and comments fold into the record
 * they were made on. Pure: `foldEdits`, `didSummary`. I/O: `recentlyEditedBy`.
 */

/** Activity actions that change a record (reads, sign-ins, exports never count). */
export const EDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'restore',
  'o2m-create',
  'o2m-update',
  'o2m-delete',
  'transition',
  'pipeline-transition',
  'pipeline-start'
] as const

const TRANSITIONS = new Set(['transition', 'pipeline-transition'])
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Meta columns every save touches — never "a field you edited". */
const META_FIELDS = new Set([
  'updated_at',
  'date_updated',
  'user_updated',
  'changed',
  'modified_at',
  'modified_by'
])

export interface EditRow {
  id: number
  action: string
  timestamp: Date | string
  collection: string | null
  item: string | null
  comment: string | null
}

/** A link row, as the caller may see it: the record it hangs off and its field. */
export interface LinkTarget {
  collection: string
  id: string
  field: string
}

export interface EditedSummary {
  collection: string
  item_id: string
  last_edited_at: string
  created: boolean
  /** Distinct fields changed (link fields included). */
  fields: number
  /** Saves with no field list (o2m rows, an update without a revision). */
  edits: number
  comments: number
  moves: number
  /** The newest move's target state ("Approved"), when the log names it. */
  moved_to: string | null
  /** Kinds, newest first: what they did last leads the sentence. */
  order: Array<'create' | 'edit' | 'move' | 'comment'>
}

const iso = (t: Date | string) => (t instanceof Date ? t.toISOString() : String(t))

/**
 * One line per record, newest first. Rows must be newest first. A record whose newest own
 * write is a delete is gone (left out); comments ride `nivaro_comments` create rows whose
 * comment is `<collection>:<item>`; link rows ride `links`.
 */
export function foldEdits(
  rows: EditRow[],
  opts: {
    fieldsByActivity?: Map<number, string[]>
    links?: Map<string, LinkTarget | null>
    isLinkTable?: (collection: string) => boolean
  } = {}
): EditedSummary[] {
  const out = new Map<string, EditedSummary & { _fields: Set<string>; _gone: boolean }>()
  const touch = (collection: string, id: string, at: string) => {
    const key = `${collection}:${id}`
    let s = out.get(key)
    if (!s) {
      s = {
        collection,
        item_id: id,
        last_edited_at: at,
        created: false,
        fields: 0,
        edits: 0,
        comments: 0,
        moves: 0,
        moved_to: null,
        order: [],
        _fields: new Set(),
        _gone: false
      }
      out.set(key, s)
    }
    return s
  }
  const kind = (s: EditedSummary, k: EditedSummary['order'][number]) => {
    if (!s.order.includes(k)) s.order.push(k)
  }
  for (const r of rows) {
    const collection = String(r.collection ?? '')
    const item = String(r.item ?? '').trim()
    if (!collection || !item) continue
    const at = iso(r.timestamp)
    const action = String(r.action ?? '')
    // A comment: `nivaro_comments` create, its comment naming the record it is on.
    if (collection === 'nivaro_comments') {
      if (action !== 'create') continue
      const m = /^([A-Za-z_][A-Za-z0-9_]*):(.+)$/.exec(String(r.comment ?? '').trim())
      if (!m) continue
      const s = touch(m[1], m[2].trim(), at)
      if (s._gone) continue
      s.comments++
      kind(s, 'comment')
      continue
    }
    if (/^(nivaro|directus)_/i.test(collection)) continue
    // A link row: an edit of the record it hangs off (its field), when the caller may see it.
    if (opts.isLinkTable?.(collection)) {
      const link = opts.links?.get(`${collection}:${item}`)
      if (!link) continue
      const s = touch(link.collection, link.id, at)
      if (s._gone) continue
      s._fields.add(link.field)
      kind(s, 'edit')
      continue
    }
    const s = touch(collection, item, at)
    if (s._gone) continue
    if (action === 'delete') {
      // Newest first: a delete seen before anything else means the record is gone now.
      if (s.order.length === 0 && s.comments === 0) s._gone = true
      continue
    }
    if (action === 'create') {
      s.created = true
      kind(s, 'create')
    } else if (TRANSITIONS.has(action) || action === 'pipeline-start') {
      s.moves++
      if (s.moved_to == null) {
        const to =
          action === 'pipeline-start'
            ? (/initial state:\s*(.+)$/i.exec(String(r.comment ?? ''))?.[1] ?? null)
            : parseTransitionComment(r.comment).to
        s.moved_to = to ? to.trim() : null
      }
      kind(s, 'move')
    } else if (action === 'restore') {
      s.edits++
      kind(s, 'edit')
    } else {
      const fields = opts.fieldsByActivity?.get(Number(r.id))
      if (fields?.length) for (const f of fields) s._fields.add(f)
      else s.edits++
      kind(s, 'edit')
    }
  }
  return [...out.values()]
    .filter((s) => !s._gone && s.order.length > 0)
    .map(({ _fields, _gone, ...s }) => ({ ...s, fields: _fields.size }))
    .sort((a, b) => (a.last_edited_at < b.last_edited_at ? 1 : -1))
}

/** "Moved to Approved · edited 3 fields · commented" — what they did, newest first. */
export function didSummary(s: EditedSummary): string {
  const parts: string[] = []
  for (const k of s.order) {
    if (k === 'create') parts.push('created')
    else if (k === 'move')
      parts.push(
        s.moved_to ? `moved to ${s.moved_to}` : s.moves > 1 ? `moved ${s.moves} times` : 'moved'
      )
    else if (k === 'comment') parts.push(s.comments > 1 ? `commented ${s.comments}×` : 'commented')
    else if (k === 'edit') {
      // "created" already says the fields were set; a later edit still counts.
      if (s.fields > 0) parts.push(`edited ${s.fields} field${s.fields === 1 ? '' : 's'}`)
      else parts.push('edited')
    }
  }
  const text = parts.join(' · ')
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Edited'
}

/** Field names a revision delta changed (meta columns left out). */
export function deltaFields(delta: unknown): string[] {
  let d: unknown = delta
  if (typeof delta === 'string') {
    try {
      d = JSON.parse(delta)
    } catch {
      return []
    }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return []
  return Object.keys(d as Record<string, unknown>).filter((f) => !META_FIELDS.has(f))
}

export interface RecentlyEdited {
  collection: string
  collection_label: string
  item_id: string
  label: string
  did: string
  last_edited_at: string
  kinds: EditedSummary['order']
  state: { key: string; label: string; color: string | null } | null
}

/** Days each read looks back, smallest first; the next only when the last found too few. */
const WINDOWS_DAYS = [3, 30, 180]
/** Rows one window reads at most. */
const MAX_ROWS = 400
/** Distinct records judged at most (activityLabelsFor's ref budget is 200). */
const MAX_REFS = 120

function titleOf(c: string): string {
  return c
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export interface RecentlyEditedDeps {
  rows(userId: string, since: Date, limit: number): Promise<EditRow[]>
  deltas(activityIds: number[]): Promise<Array<{ activity: number; delta: unknown }>>
  junctions(): Promise<Map<string, { parent: string; alias: string | null }>>
  labels(
    user: User,
    refs: Array<{ collection: string; id: string }>,
    admin: boolean
  ): Promise<ActivityLabels>
  states(
    byCollection: Map<string, string[]>
  ): Promise<
    Array<{ collection: string; item: string; key: string; label: string; color: string | null }>
  >
}

export const defaultRecentlyEditedDeps: RecentlyEditedDeps = {
  async rows(userId, since, limit) {
    return (await activityListSource(db, isMssql(db))
      .where('a.user', userId)
      .where('a.timestamp', '>=', since)
      .whereIn('a.action', [...EDIT_ACTIONS])
      .whereNotNull('a.collection')
      .whereNotNull('a.item')
      .orderBy([
        { column: 'a.timestamp', order: 'desc' },
        { column: 'a.id', order: 'desc' }
      ])
      .limit(limit)
      .select(
        'a.id',
        'a.action',
        'a.timestamp',
        'a.collection',
        'a.item',
        'a.comment'
      )) as EditRow[]
  },
  async deltas(ids) {
    return (await selectInChunks(ids, 500, (chunk) =>
      Promise.resolve(db('nivaro_revisions').whereIn('activity', chunk).select('activity', 'delta'))
    )) as Array<{ activity: number; delta: unknown }>
  },
  async junctions() {
    const { loadJunctionMap } = await import('./junction-map.js')
    return loadJunctionMap()
  },
  labels: (user, refs, admin) => activityLabelsFor(user, { refs }, { isAdmin: admin }),
  async states(byCollection) {
    if (byCollection.size === 0) return []
    return (await db('nivaro_workflow_instances as wi')
      .join('nivaro_workflow_states as s', 'wi.current_state', 's.id')
      .where((qb) => {
        for (const [collection, ids] of byCollection)
          void qb.orWhere((q2) => q2.where('wi.collection', collection).whereIn('wi.item', ids))
      })
      .select('wi.collection', 'wi.item', 's.key', 's.label', 's.color')
      .catch(() => [])) as Array<{
      collection: string
      item: string
      key: string
      label: string
      color: string | null
    }>
  }
}

/**
 * The caller's recently edited records, newest first, as they may see them now.
 * Never throws for one bad part: a failed delta / state read just says less.
 */
export async function recentlyEditedBy(
  user: User,
  opts: { limit: number; isAdmin: boolean; now?: Date },
  deps: RecentlyEditedDeps = defaultRecentlyEditedDeps
): Promise<RecentlyEdited[]> {
  const limit = Math.min(30, Math.max(1, Math.floor(opts.limit) || 10))
  const now = opts.now ?? new Date()
  const userId = String(user.id)
  let rows: EditRow[] = []
  for (const days of WINDOWS_DAYS) {
    const since = new Date(now.getTime() - days * 86_400_000)
    rows = await deps.rows(userId, since, MAX_ROWS)
    // Enough distinct records to fill the list after the visibility check, or the window
    // already held fewer rows than one read takes (a wider one would add nothing new).
    const distinct = new Set(rows.map((r) => `${r.collection}:${r.item}`)).size
    if (distinct >= limit * 3 || rows.length >= MAX_ROWS) break
  }
  if (rows.length === 0) return []

  const jmap = await deps
    .junctions()
    .catch(() => new Map<string, { parent: string; alias: string | null }>())
  const isLinkTable = (c: string) => jmap.has(c)
  // Field lists for plain updates (their revision delta), one batched read.
  const updateIds = rows
    .filter((r) => r.action === 'update' && !isLinkTable(String(r.collection)))
    .map((r) => Number(r.id))
  const fieldsByActivity = new Map<number, string[]>()
  if (updateIds.length) {
    const deltas = await deps.deltas(updateIds).catch(() => [])
    for (const d of deltas) {
      const list = deltaFields(d.delta)
      if (list.length)
        fieldsByActivity.set(Number(d.activity), [
          ...(fieldsByActivity.get(Number(d.activity)) ?? []),
          ...list
        ])
    }
  }

  // Everything named — records, link rows, comment targets — judged as the caller, in one
  // labels read. Link rows come back with the record they hang off (labelled as the caller).
  const refs: Array<{ collection: string; id: string }> = []
  const seen = new Set<string>()
  const addRef = (collection: string, id: string) => {
    const key = `${collection}:${id}`
    if (seen.has(key) || refs.length >= MAX_REFS || !IDENT.test(collection)) return
    seen.add(key)
    refs.push({ collection, id })
  }
  for (const r of rows) {
    const c = String(r.collection ?? '')
    const id = String(r.item ?? '').trim()
    if (c === 'nivaro_comments') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):(.+)$/.exec(String(r.comment ?? '').trim())
      if (m && r.action === 'create') addRef(m[1], m[2].trim())
    } else if (!/^(nivaro|directus)_/i.test(c)) addRef(c, id)
  }
  const labels = await deps.labels(user, refs, opts.isAdmin).catch(() => ({}) as ActivityLabels)
  const links = new Map<string, LinkTarget | null>()
  for (const r of refs) {
    const j = jmap.get(r.collection)
    if (!j) continue
    const jl = labels.junctions?.[`${r.collection}:${r.id}`]
    const parentId = jl?.parent_id ? String(jl.parent_id) : null
    links.set(
      `${r.collection}:${r.id}`,
      parentId
        ? { collection: jl!.parent_collection, id: parentId, field: j.alias ?? r.collection }
        : null
    )
  }
  const folded = foldEdits(rows, { fieldsByActivity, links, isLinkTable })
  const visible: Array<EditedSummary & { label: string }> = []
  for (const s of folded) {
    // Undefined = never judged (over budget); null = the caller cannot see it. Both stay out.
    const label = labels.records?.[`${s.collection}:${s.item_id}`]
    if (label == null) continue
    visible.push({ ...s, label })
    if (visible.length >= limit) break
  }
  if (visible.length === 0) return []

  const byCollection = new Map<string, string[]>()
  for (const v of visible) {
    const list = byCollection.get(v.collection) ?? []
    list.push(v.item_id)
    byCollection.set(v.collection, list)
  }
  const states = await deps.states(byCollection).catch(() => [])
  const stateBy = new Map(
    states.map((s) => [
      `${s.collection}:${String(s.item).toLowerCase()}`,
      { key: s.key, label: s.label, color: s.color ?? null }
    ])
  )
  return visible.map((v) => {
    const names = labels.collections?.[v.collection]
    const collectionLabel =
      typeof names === 'string'
        ? names
        : String(names?.singular || names?.plural || '').trim() || titleOf(v.collection)
    return {
      collection: v.collection,
      collection_label: collectionLabel,
      item_id: v.item_id,
      label: v.label,
      did: didSummary(v),
      last_edited_at: v.last_edited_at,
      kinds: v.order,
      state: stateBy.get(`${v.collection}:${v.item_id.toLowerCase()}`) ?? null
    }
  })
}
