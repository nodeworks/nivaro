import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can, getAllowedFields } from './permissions.js'

/**
 * Field-level reads for history (H2, security audit 2026-10-27).
 *
 * A revision snapshot holds EVERY column the row had, so a reader who may
 * open the record but not every field of it must get the snapshot cut to the
 * fields their read policy lists — the same list a record read projects to.
 * `null` = no cut (an admin role, or a policy with every field).
 */
export async function readableFieldSet(
  user: User,
  collection: string
): Promise<Set<string> | null> {
  const allowed = await getAllowedFields(user, 'read', collection)
  if (allowed === null || allowed.includes('*')) return null
  return new Set(['id', ...allowed])
}

/** The object with only the keys in `fields` (null = unchanged). */
export function pickFields<T extends Record<string, unknown> | null | undefined>(
  obj: T,
  fields: Set<string> | null
): T {
  if (!fields || obj == null || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (fields.has(k)) out[k] = v
  return out as T
}

/** Field NAMES the caller may read, in the given order. */
export function keepReadable(names: string[], fields: Set<string> | null): string[] {
  return fields ? names.filter((n) => fields.has(n)) : names
}

interface RevisionLike {
  data?: Record<string, unknown> | null
  delta?: Record<string, unknown> | null
  comment?: string | null
  action?: string | null
}

/** One changed field of a child row, as the reader may see it (labels, never ids). */
export interface O2mChange {
  field: string
  label: string
  from: string | null
  to: string | null
}

/**
 * What an `o2m-*` history row says, readable (army 6 H1): "changed Materials · 110140:
 * Quantity 4 → 5". The stored activity comment (`{child_collection, child_id, snapshot,
 * changes?}`) never reaches a reader — it carried row ids and user uuids into Notes,
 * History and Comments. Built per reader: only fields their read policy lists, link
 * values named as THEY may read them, people by name.
 */
export interface O2mSummary {
  verb: 'added' | 'changed' | 'removed'
  /** The child collection's key (for client-side labels; not shown). */
  collection: string
  collection_label: string
  /** The row's label ("110140", "2026 · Goods"); null when it has none the reader may see. */
  row_label: string | null
  changes: O2mChange[]
}

/** The stored shape of an o2m activity comment (routes/items.ts writes it). */
export interface O2mPayload {
  child_collection?: unknown
  child_id?: unknown
  snapshot?: unknown
  /** field → [before, after] (written since army 6 for o2m-update). */
  changes?: unknown
}

/** The parsed payload of an o2m activity comment, or null when it is not one. */
export function parseO2mComment(comment: unknown): O2mPayload | null {
  if (typeof comment !== 'string') return null
  const t = comment.trim()
  if (!t.startsWith('{') || !t.includes('child_collection')) return null
  try {
    const v = JSON.parse(t) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    return 'child_collection' in (v as object) ? (v as O2mPayload) : null
  } catch {
    return null
  }
}

/** True for an activity row that is an o2m pointer, not something a person wrote. */
export function isO2mActivity(action: unknown, comment: unknown): boolean {
  return /^o2m-/i.test(String(action ?? '')) || parseO2mComment(comment) !== null
}

export interface O2mLabelDeps {
  /** The collection's display name (or its key in title case). */
  collectionTitle(collection: string): Promise<string>
  /** Field labels, audit-special fields and many-to-one targets of a collection. */
  fieldMeta(collection: string): Promise<{
    labels: Map<string, string>
    hidden: Set<string>
    m2o: Map<string, string>
  }>
  /** `collection:id` → label, read AS the viewer (never a primary key). */
  recordLabels(
    user: User,
    refs: Array<{ collection: string; id: string }>
  ): Promise<Record<string, string>>
  /** The label a snapshot of the row would carry (display template plain tokens / name columns). */
  snapshotLabel(collection: string, row: Record<string, unknown>): Promise<string | null>
  /** People by name. */
  userNames(ids: string[]): Promise<Map<string, string>>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER_COLLECTIONS = new Set(['nivaro_users', 'directus_users'])
const AUDIT_SPECIALS = ['user-created', 'user-updated', 'date-created', 'date-updated']
const MAX_CHANGES = 8

const titleCase = (s: string) =>
  s
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())

const defaultDeps: O2mLabelDeps = {
  async collectionTitle(collection) {
    const { getCollection } = await import('./collections.js')
    const { collectionTitle } = await import('./record-label-fallback.js')
    const col = (await getCollection(collection).catch(() => null)) as {
      display_name?: string | null
    } | null
    return collectionTitle(collection, col?.display_name ?? null)
  },
  async fieldMeta(collection) {
    const { getFields, getRelations } = await import('./collections.js')
    const [fields, labelRows, rels] = await Promise.all([
      getFields(collection).catch(() => []),
      (
        db('nivaro_fields').where({ collection }).select('field', 'label') as Promise<
          Array<{ field: string; label: string | null }>
        >
      ).catch(() => []),
      getRelations(collection).catch(() => [])
    ])
    const labels = new Map<string, string>()
    for (const r of labelRows) if (r.label?.trim()) labels.set(r.field, r.label.trim())
    const hidden = new Set<string>()
    for (const f of fields as Array<{ field: string; special?: string[] | null }>)
      if ((f.special ?? []).some((x) => AUDIT_SPECIALS.includes(x))) hidden.add(f.field)
    const m2o = new Map<string, string>()
    for (const r of rels as Array<{
      many_collection: string
      many_field: string
      one_collection: string | null
    }>)
      if (r.many_collection === collection && r.one_collection)
        m2o.set(r.many_field, r.one_collection)
    return { labels, hidden, m2o }
  },
  async recordLabels(user, refs) {
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    return recordLabelsAsViewer(user, refs)
  },
  async snapshotLabel(collection, row) {
    const { labelFromSnapshot } = await import('./record-headline.js')
    return labelFromSnapshot(collection, row)
  },
  async userNames(ids) {
    const out = new Map<string, string>()
    if (ids.length === 0) return out
    const rows = (await db('nivaro_users')
      .whereIn('id', ids.slice(0, 100))
      .select('id', 'first_name', 'last_name', 'email')
      .catch(() => [])) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    for (const r of rows) {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
      out.set(String(r.id).toLowerCase(), name || 'Someone')
    }
    return out
  }
}

/**
 * A record's history as `user` may read it: every snapshot and delta cut to
 * the record collection's readable fields, and an `o2m-*` activity row turned
 * into a readable `o2m` summary cut to the CHILD collection's fields (the raw
 * comment never leaves the server; the row says only "changed rows" when the
 * child collection is not readable at all).
 */
export async function revisionsForReader<T extends RevisionLike>(
  user: User,
  collection: string,
  revisions: T[],
  deps: O2mLabelDeps = defaultDeps
): Promise<Array<T & { o2m?: O2mSummary | null }>> {
  const own = await readableFieldSet(user, collection)
  const childSets = new Map<string, Promise<Set<string> | null | false>>()
  const childFields = (child: string) => {
    let hit = childSets.get(child)
    if (!hit) {
      hit = (async () => {
        if (!(await can(user, 'read', child))) return false as const
        return readableFieldSet(user, child)
      })()
      childSets.set(child, hit)
    }
    return hit
  }
  const out: Array<T & { o2m?: O2mSummary | null }> = []
  const pending: Array<{ index: number; payload: O2mPayload; action: string }> = []
  for (const rev of revisions) {
    const next = { ...rev } as T & { o2m?: O2mSummary | null }
    if (rev.data != null) next.data = pickFields(rev.data, own)
    if (rev.delta != null) next.delta = pickFields(rev.delta, own)
    const action = String(rev.action ?? '')
    if (/^o2m-/.test(action) && action !== 'o2m-restore') {
      const payload = parseO2mComment(rev.comment)
      next.comment = null
      next.o2m = null
      if (payload) pending.push({ index: out.length, payload, action })
    }
    out.push(next)
  }
  if (pending.length > 0) {
    const summaries = await o2mSummaries(user, pending, childFields, deps).catch(() => null)
    if (summaries) for (const [i, s] of summaries) out[i].o2m = s
  }
  return out
}

/** Readable summaries for the o2m rows of one history read, labels batched. */
async function o2mSummaries(
  user: User,
  rows: Array<{ index: number; payload: O2mPayload; action: string }>,
  childFields: (child: string) => Promise<Set<string> | null | false>,
  deps: O2mLabelDeps
): Promise<Map<number, O2mSummary>> {
  type Work = {
    index: number
    verb: O2mSummary['verb']
    child: string
    childId: string | null
    snapshot: Record<string, unknown> | null
    pairs: Array<[string, unknown, unknown]>
  }
  const work: Work[] = []
  const metaFor = new Map<string, ReturnType<O2mLabelDeps['fieldMeta']>>()
  const meta = (c: string) => {
    let m = metaFor.get(c)
    if (!m) {
      m = deps.fieldMeta(c)
      metaFor.set(c, m)
    }
    return m
  }
  const titles = new Map<string, Promise<string>>()
  const title = (c: string) => {
    let t = titles.get(c)
    if (!t) {
      t = deps.collectionTitle(c).catch(() => titleCase(c))
      titles.set(c, t)
    }
    return t
  }
  for (const r of rows) {
    const child = typeof r.payload.child_collection === 'string' ? r.payload.child_collection : ''
    if (!child) continue
    const verb: O2mSummary['verb'] =
      r.action === 'o2m-create' ? 'added' : r.action === 'o2m-delete' ? 'removed' : 'changed'
    const fields = await childFields(child)
    const childId = r.payload.child_id == null ? null : String(r.payload.child_id)
    if (fields === false) {
      work.push({ index: r.index, verb, child, childId: null, snapshot: null, pairs: [] })
      continue
    }
    const snap =
      r.payload.snapshot &&
      typeof r.payload.snapshot === 'object' &&
      !Array.isArray(r.payload.snapshot)
        ? pickFields(r.payload.snapshot as Record<string, unknown>, fields)
        : null
    const { hidden } = await meta(child)
    const pairs: Array<[string, unknown, unknown]> = []
    const changes = r.payload.changes
    if (verb === 'changed' && changes && typeof changes === 'object' && !Array.isArray(changes)) {
      for (const [field, pair] of Object.entries(changes as Record<string, unknown>)) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        if (field === 'id' || hidden.has(field)) continue
        if (fields && !fields.has(field)) continue
        pairs.push([field, pair[0], pair[1]])
      }
    }
    work.push({ index: r.index, verb, child, childId, snapshot: snap, pairs })
  }

  // Link values and row labels, as the reader, in one batch.
  const refs: Array<{ collection: string; id: string }> = []
  const userIds = new Set<string>()
  for (const w of work) {
    if (w.childId && w.verb !== 'removed') refs.push({ collection: w.child, id: w.childId })
    if (w.pairs.length === 0) continue
    const { m2o } = await meta(w.child)
    for (const [field, a, b] of w.pairs) {
      const target = m2o.get(field)
      for (const v of [a, b]) {
        if (v == null || v === '' || typeof v === 'object') continue
        if (target && USER_COLLECTIONS.has(target)) userIds.add(String(v))
        else if (target) refs.push({ collection: target, id: String(v) })
        else if (UUID.test(String(v))) userIds.add(String(v))
      }
    }
  }
  const [labels, names] = await Promise.all([
    refs.length ? deps.recordLabels(user, refs).catch(() => ({}) as Record<string, string>) : {},
    userIds.size ? deps.userNames([...userIds]).catch(() => new Map<string, string>()) : new Map()
  ])

  const out = new Map<number, O2mSummary>()
  for (const w of work) {
    const collectionLabel = await title(w.child)
    let rowLabel: string | null = null
    if (w.childId && w.verb !== 'removed') {
      const l = (labels as Record<string, string>)[`${w.child}:${w.childId}`]?.trim()
      if (l && l !== collectionLabel) rowLabel = l
    }
    if (!rowLabel && w.snapshot) {
      const l = (await deps.snapshotLabel(w.child, w.snapshot).catch(() => null))?.trim()
      if (l && !UUID.test(l) && l !== w.childId) rowLabel = l
    }
    const changes: O2mChange[] = []
    if (w.pairs.length) {
      const { labels: fieldLabels, m2o } = await meta(w.child)
      for (const [field, a, b] of w.pairs) {
        const target = m2o.get(field)
        const show = (v: unknown): string | null | undefined => {
          if (v == null || v === '') return null
          if (target && USER_COLLECTIONS.has(target)) return names.get(String(v).toLowerCase())
          if (target) {
            const l = (labels as Record<string, string>)[`${target}:${String(v)}`]?.trim()
            return l || undefined
          }
          return plainValue(v, names)
        }
        const from = show(a)
        const to = show(b)
        // A value the reader cannot be shown by name (an unresolved id) leaves the line out.
        if (from === undefined || to === undefined) continue
        if (from === to) continue
        changes.push({ field, label: fieldLabels.get(field) ?? titleCase(field), from, to })
        if (changes.length >= MAX_CHANGES) break
      }
    }
    out.set(w.index, {
      verb: w.verb,
      collection: w.child,
      collection_label: collectionLabel,
      row_label: rowLabel,
      changes
    })
  }
  return out
}

/** A plain value as text; undefined when it is something no person should read (an id). */
function plainValue(v: unknown, names: Map<string, string>): string | null | undefined {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (UUID.test(s)) return names.get(s.toLowerCase())
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 10)
  const plain = s.replace(/<[^>]+>/g, '').trim()
  if (!plain) return null
  return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain
}
