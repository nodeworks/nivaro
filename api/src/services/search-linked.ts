import { db } from '../db/index.js'
import type { CMSRelation, User } from '../types.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { labelFor } from './global-search.js'
import { readItems, readOne } from './items.js'
import { collectionTitle } from './record-label-fallback.js'
import { recordLabelsAsViewer } from './record-labels-as-viewer.js'

/**
 * Linked records for the search preview (Rob 2026-11-10: from a purchase order hit, see and
 * open its workflow). Both directions, every read as the caller:
 *   - this record points at (M2O): its project, vendor, region …
 *   - points at this record (O2M): invoices whose `purchase_order` is this PO …
 *   - through a junction (M2M): the workflows a PO is linked to …
 * Each group shows up to ITEMS_PER_GROUP records and how many there are. A group the caller
 * cannot read (collection, field or rows) is left out; system tables and junction tables are
 * never listed. The preview itself stays one fast read; the pane asks for this separately.
 */
export interface LinkedGroup {
  collection: string
  /** "Workflows", or "Workflows · Billing location" when one collection links two ways. */
  title: string
  direction: 'to' | 'from'
  /** Records in the group the caller may read; null when the count was not taken. */
  total: number | null
  items: Array<{ id: string; label: string }>
}

export const ITEMS_PER_GROUP = 5
const MAX_GROUPS = 10
const MAX_RELATIONS = 24
const CONCURRENCY = 6
const JUNCTION_IDS_CAP = 500

const SYSTEM = /^(nivaro_|directus_)/i
const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** One relation of `collection`, read as a linked group. Exported for tests. */
export interface LinkPlan {
  kind: 'm2o' | 'o2m' | 'm2m'
  /** The collection whose records are listed. */
  target: string
  /** m2o: this record's FK; o2m: the target's FK to this record; m2m: the junction's FK to this record. */
  field: string
  junction?: string
  /** m2m: the junction's FK to the target. */
  farField?: string
  /** m2m: the alias field on this collection (names the link when there are two). */
  alias?: string | null
}

/** What `collection` links to and from, in the order the pane lists them. Pure. */
export function linkPlans(collection: string, rels: CMSRelation[]): LinkPlan[] {
  const junctions = new Set(
    rels.filter((r) => r.junction_field && r.many_collection).map((r) => r.many_collection)
  )
  const m2m: LinkPlan[] = []
  const o2m: LinkPlan[] = []
  const m2o: LinkPlan[] = []
  for (const r of rels) {
    if (r.one_collection === collection && r.many_collection && r.many_field) {
      if (r.junction_field) {
        const far = rels.find(
          (x) => x.many_collection === r.many_collection && x.many_field === r.junction_field
        )
        const target = far?.one_collection
        if (target && !SYSTEM.test(target))
          m2m.push({
            kind: 'm2m',
            target,
            field: r.many_field,
            junction: r.many_collection,
            farField: r.junction_field,
            alias: r.one_field ?? null
          })
      } else if (!junctions.has(r.many_collection) && !SYSTEM.test(r.many_collection)) {
        o2m.push({ kind: 'o2m', target: r.many_collection, field: r.many_field })
      }
    }
    if (
      r.many_collection === collection &&
      r.many_field &&
      !r.junction_field &&
      r.one_collection &&
      !SYSTEM.test(r.one_collection)
    )
      m2o.push({ kind: 'm2o', target: r.one_collection, field: r.many_field })
  }
  const seen = new Set<string>()
  return [...m2m, ...o2m, ...m2o].filter((p) => {
    const k = `${p.kind}:${p.target}:${p.field}:${p.junction ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

export async function buildSearchLinked(
  user: User,
  collection: string,
  id: string
): Promise<LinkedGroup[] | null> {
  let row: Record<string, unknown> | null
  try {
    row = (await readOne(user, collection, id)) as Record<string, unknown> | null
  } catch {
    return null
  }
  if (!row) return null
  const rels = await getRelations(collection).catch(() => [] as CMSRelation[])
  // M2M legs need the far leg, which names the junction, not this collection.
  const junctionNames = [
    ...new Set(
      rels
        .filter((r) => r.one_collection === collection && r.junction_field)
        .map((r) => r.many_collection)
    )
  ]
  const farLegs = junctionNames.length
    ? ((await db('nivaro_relations').whereIn('many_collection', junctionNames)) as CMSRelation[])
    : []
  const plans = linkPlans(collection, [...rels, ...farLegs]).slice(0, MAX_RELATIONS)
  // A collection linked more than one way names the field (Billing location / Shipping location).
  const perTarget = new Map<string, number>()
  for (const p of plans) perTarget.set(p.target, (perTarget.get(p.target) ?? 0) + 1)
  const fieldLabel = async (c: string, f: string) => {
    const meta = (await getFields(c).catch(() => [])).find((x) => x.field === f)
    return (
      String((meta as { label?: string | null } | undefined)?.label ?? '').trim() || titleCase(f)
    )
  }
  const rootId = row.id

  const groups = await pool(plans, CONCURRENCY, async (p): Promise<LinkedGroup | null> => {
    try {
      const col = await getCollection(p.target)
      if (!col || (p.kind === 'o2m' && col.hidden)) return null
      const name = collectionTitle(p.target, col.display_name)
      let res: { data: unknown; total?: number | null }
      if (p.kind === 'm2o') {
        const v = row?.[p.field]
        if (v == null || typeof v === 'object') return null
        res = await readItems(user, p.target, {
          filter: { id: { _eq: v } },
          limit: 1,
          count: false
        })
      } else if (p.kind === 'o2m') {
        res = await readItems(user, p.target, {
          filter: { [p.field]: { _eq: rootId } },
          limit: ITEMS_PER_GROUP,
          count: true
        })
      } else {
        // The junction only says which far records; reading them is as the caller.
        const ids = (
          (await db(p.junction as string)
            .where(p.field, rootId as string | number)
            .whereNotNull(p.farField as string)
            .select({ v: p.farField as string })
            .limit(JUNCTION_IDS_CAP)) as Array<{ v: unknown }>
        ).map((r) => r.v as string | number)
        if (!ids.length) return null
        res = await readItems(user, p.target, {
          filter: { id: { _in: [...new Set(ids)] } },
          limit: ITEMS_PER_GROUP,
          count: true
        })
      }
      const rows = (res.data as Array<Record<string, unknown>>) ?? []
      if (!rows.length) return null
      const via =
        (perTarget.get(p.target) ?? 0) <= 1
          ? null
          : p.kind === 'm2o'
            ? await fieldLabel(collection, p.field)
            : p.kind === 'o2m'
              ? await fieldLabel(p.target, p.field)
              : p.alias
                ? await fieldLabel(collection, p.alias)
                : null
      return {
        collection: p.target,
        title: via ? `${name} · ${via}` : name,
        direction: p.kind === 'm2o' ? 'to' : 'from',
        total: p.kind === 'm2o' ? 1 : typeof res.total === 'number' ? res.total : null,
        items: rows.map((r) => {
          const label = labelFor(r, col.display_template, '')
          // No label of its own: the shared fallback names it below (never the pk).
          return { id: String(r.id), label: label.slice(0, 120) }
        })
      }
    } catch {
      return null // a group the caller cannot read is left out
    }
  })
  const out = groups.filter((g): g is LinkedGroup => g !== null).slice(0, MAX_GROUPS)
  // Records without a display label: the label every other search surface shows for them
  // (business id column, else the collection's name), read as the caller.
  const bare = out.flatMap((g) =>
    g.items.filter((i) => !i.label).map((i) => ({ collection: g.collection, id: i.id }))
  )
  if (bare.length) {
    const names = await recordLabelsAsViewer(user, bare).catch(() => ({}) as Record<string, string>)
    for (const g of out)
      for (const i of g.items)
        if (!i.label) i.label = (names[`${g.collection}:${i.id}`] || g.title).slice(0, 120)
  }
  return out
}
