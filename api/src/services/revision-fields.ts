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
  /** What this row's write moved on the parent's stored totals ("Requisition Amount +2,059"),
   *  only totals the reader may read on the parent. Absent when nothing moved. */
  totals?: Array<{ field: string; label: string; delta: number; source_field?: string }>
  /** Written on the row itself (its own page, an import, a sync), not from the parent's page. */
  elsewhere?: boolean
}

/** The stored shape of an o2m activity comment (routes/items.ts writes it). */
export interface O2mPayload {
  child_collection?: unknown
  child_id?: unknown
  snapshot?: unknown
  /** field → [before, after] (written since army 6 for o2m-update). */
  changes?: unknown
  /** Set by the history read for a child write made away from the parent's page. */
  elsewhere?: unknown
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
  /** The many-to-one fields the collection's display template reads through
   *  ("{{inventory_request.inventory_request_id}} - {{cifa.cifa_number}}" →
   *  inventory_request, cifa). Optional: absent = none. */
  templateRelations?(collection: string): Promise<string[]>
  /** Of `ids` in `collection`, those the reader may see (row filters, User Scopes) — compared
   *  lower-cased. Optional: absent = an off-page child write is never shown. */
  visibleIds?(user: User, collection: string, ids: string[]): Promise<Set<string>>
  /** The stored rollups on `parent` fed by `child` rows (services/rollup-moves.ts).
   *  Optional: absent = no totals. */
  rollupSources?(
    parent: string,
    child: string
  ): Promise<import('./rollup-moves.js').ParentRollupSource[]>
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
  async visibleIds(user, collection, ids) {
    const { readableIds } = await import('./form-field-gate.js')
    return readableIds(user, collection, ids)
  },
  async rollupSources(parent, child) {
    const { rollupSourcesFrom } = await import('./rollup-moves.js')
    return rollupSourcesFrom(parent, child)
  },
  async templateRelations(collection) {
    const { getCollection } = await import('./collections.js')
    const col = (await getCollection(collection).catch(() => null)) as {
      display_template?: string | null
    } | null
    return templateRelationHeads(col?.display_template)
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
  // A child write made away from this record's page (services/revisions.ts) is shown only when
  // the reader may see that child row: the record being visible says nothing about its lines.
  const drop = new Set<number>()
  const elsewhere = pending.filter((p) => p.payload.elsewhere === true)
  if (elsewhere.length > 0) {
    const byChild = new Map<string, Set<string>>()
    for (const p of elsewhere) {
      const child = String(p.payload.child_collection ?? '')
      const id = p.payload.child_id == null ? '' : String(p.payload.child_id)
      if (!child || !id) continue
      byChild.set(child, (byChild.get(child) ?? new Set()).add(id))
    }
    const seen = new Map<string, Set<string>>()
    for (const [child, ids] of byChild) {
      const fields = await childFields(child)
      seen.set(
        child,
        fields === false || !deps.visibleIds
          ? new Set()
          : await deps.visibleIds(user, child, [...ids]).catch(() => new Set<string>())
      )
    }
    for (const p of elsewhere) {
      const id = String(p.payload.child_id ?? '').toLowerCase()
      const ok = seen.get(String(p.payload.child_collection ?? ''))
      if (!id || !ok?.has(id)) drop.add(p.index)
    }
  }
  if (pending.length > 0) {
    const summaries = await o2mSummaries(user, pending, childFields, deps, collection, own).catch(
      () => null
    )
    if (summaries) for (const [i, s] of summaries) out[i].o2m = s
  }
  return drop.size > 0 ? out.filter((_, i) => !drop.has(i)) : out
}

/** The relation heads a display template reads through, in order, once each. */
export function templateRelationHeads(template: string | null | undefined): string[] {
  if (!template) return []
  const out: string[] = []
  for (const m of template.matchAll(/\{\{\s*([\w]+)\.[\w.]+\s*\}\}/g))
    if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** Readable summaries for the o2m rows of one history read, labels batched. */
async function o2mSummaries(
  user: User,
  rows: Array<{ index: number; payload: O2mPayload; action: string }>,
  childFields: (child: string) => Promise<Set<string> | null | false>,
  deps: O2mLabelDeps,
  parentCollection?: string,
  /** The parent fields the reader may read (null = all) — totals are named only from these. */
  parentFields: Set<string> | null = null
): Promise<Map<number, O2mSummary>> {
  type Work = {
    index: number
    verb: O2mSummary['verb']
    child: string
    childId: string | null
    snapshot: Record<string, unknown> | null
    pairs: Array<[string, unknown, unknown]>
    totals: Array<{ field: string; delta: number; source_field?: string }>
    elsewhere: boolean
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
      work.push({
        index: r.index,
        verb,
        child,
        childId: null,
        snapshot: null,
        pairs: [],
        totals: [],
        elsewhere: r.payload.elsewhere === true
      })
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
    // The totals this write moved, worked out from the FULL stored row (a total the reader may
    // read is shown even when the column behind it is not theirs to read: the parent's own
    // figure already tells them as much).
    let totals: Array<{ field: string; delta: number; source_field?: string }> = []
    if (parentCollection && deps.rollupSources) {
      // Only totals worked out from child columns the reader may read (the value and any
      // filter column): a move is the difference of those values, so it would disclose them.
      const sources = (await deps.rollupSources(parentCollection, child).catch(() => [])).filter(
        (src) =>
          !fields ||
          ((src.source.aggregate === 'count' || fields.has(src.source.value_field)) &&
            Object.keys(src.source.filter ?? {}).every((c) => fields.has(c)))
      )
      if (sources.length > 0) {
        const full =
          r.payload.snapshot &&
          typeof r.payload.snapshot === 'object' &&
          !Array.isArray(r.payload.snapshot)
            ? (r.payload.snapshot as Record<string, unknown>)
            : null
        let before: Record<string, unknown> | null = null
        let after: Record<string, unknown> | null = null
        if (verb === 'added') after = full
        else if (verb === 'removed') before = full
        else if (full && changes && typeof changes === 'object' && !Array.isArray(changes)) {
          before = { ...full }
          after = { ...full }
          for (const [field, pair] of Object.entries(changes as Record<string, unknown>)) {
            if (!Array.isArray(pair) || pair.length !== 2) continue
            before[field] = pair[0]
            after[field] = pair[1]
          }
        }
        if (before || after) {
          const { rollupMoves } = await import('./rollup-moves.js')
          totals = rollupMoves(sources, before, after).filter(
            (m) => !parentFields || parentFields.has(m.field)
          )
        }
      }
    }
    work.push({
      index: r.index,
      verb,
      child,
      childId,
      snapshot: snap,
      pairs,
      totals,
      elsewhere: r.payload.elsewhere === true
    })
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
  // A row whose own label is only the template's related parts (an IR
  // material: "{{inventory_request…}} - {{cifa.cifa_number}}") is named by the
  // record it is about — its item — never by the parent it sits on: "changed
  // Inventory Request Materials" said nothing about WHICH line (army8 b02).
  const itemRef = new Map<number, { collection: string; id: string }>()
  for (const w of work) {
    if (!w.snapshot || !deps.templateRelations) continue
    const heads = await deps.templateRelations(w.child).catch(() => [] as string[])
    if (heads.length === 0) continue
    const { m2o } = await meta(w.child)
    for (const h of heads) {
      const target = m2o.get(h)
      const v = w.snapshot[h]
      if (!target || target === parentCollection || USER_COLLECTIONS.has(target)) continue
      if (v == null || v === '' || typeof v === 'object') continue
      itemRef.set(w.index, { collection: target, id: String(v) })
      refs.push({ collection: target, id: String(v) })
      break
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
    if (!rowLabel && itemRef.has(w.index)) {
      const ref = itemRef.get(w.index) as { collection: string; id: string }
      const l = (labels as Record<string, string>)[`${ref.collection}:${ref.id}`]?.trim()
      // An unreadable item reads as its collection's name — that names nothing.
      if (l && l !== ref.id && !UUID.test(l) && l !== (await title(ref.collection))) rowLabel = l
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
    let totals: O2mSummary['totals']
    if (w.totals.length > 0 && parentCollection) {
      const { labels: parentLabels } = await meta(parentCollection)
      totals = w.totals.map((m) => ({
        field: m.field,
        label: parentLabels.get(m.field) ?? titleCase(m.field),
        delta: m.delta,
        ...(m.source_field ? { source_field: m.source_field } : {})
      }))
    }
    out.set(w.index, {
      verb: w.verb,
      collection: w.child,
      collection_label: collectionLabel,
      row_label: rowLabel,
      changes,
      ...(totals ? { totals } : {}),
      ...(w.elsewhere ? { elsewhere: true } : {})
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
