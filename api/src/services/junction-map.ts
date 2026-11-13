import { db } from '../db/index.js'
import { tenantState } from './ai-tenant-state.js'

/**
 * Link (junction) tables and the record each link row hangs off: `workflows_divisions` →
 * parent `workflows` (column `workflows_id`), the other leg `divisions`. Read from
 * nivaro_relations (rows that carry `junction_field`), cached per tenant for a minute.
 * Used to say a link write in words ("Added Division Zone 2 to Workflow CM26-79704") and
 * to fold link writes into their parent's edit (services/person-did.ts).
 */

export interface JunctionInfo {
  junction: string
  /** The collection whose records the link rows hang off ("workflows"). */
  parent: string
  /** The junction column holding the parent's id. */
  parentFk: string
  /** The parent's alias field for the link ("divisions"), when the relation names one. */
  alias: string | null
  /** The collection on the other leg ("divisions"); null for a many-to-any leg. */
  target: string | null
  /** The junction column holding the other leg's id. */
  targetFk: string | null
  /** Many-to-any: the junction column naming the other leg's collection per row. */
  discriminator: string | null
}

interface RelationRow {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
  one_collection_field?: string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Junction collection → its parent (the leg whose collection prefixes the junction's name,
 *  else the leg that names an alias field on its side, else the first). */
export function buildJunctionMap(rels: RelationRow[]): Map<string, JunctionInfo> {
  const by = new Map<string, RelationRow[]>()
  for (const r of rels) {
    if (!r.junction_field || !r.many_collection || !r.many_field) continue
    if (!IDENT.test(r.many_collection) || !IDENT.test(r.many_field)) continue
    const list = by.get(r.many_collection) ?? []
    if (!list.some((l) => l.many_field === r.many_field)) list.push(r)
    by.set(r.many_collection, list)
  }
  const out = new Map<string, JunctionInfo>()
  for (const [junction, legs] of by) {
    if (legs.length < 2) continue
    const named = legs.filter((l) => l.one_collection && IDENT.test(l.one_collection))
    if (named.length === 0) continue
    const parent =
      named.find((l) => junction.startsWith(`${l.one_collection}_`)) ??
      named.find((l) => !!l.one_field) ??
      named[0]
    const other = legs.find((l) => l !== parent)
    const disc = other?.one_collection_field
    out.set(junction, {
      junction,
      parent: String(parent.one_collection),
      parentFk: String(parent.many_field),
      alias: parent.one_field && IDENT.test(parent.one_field) ? parent.one_field : null,
      target:
        other?.one_collection && IDENT.test(other.one_collection) ? other.one_collection : null,
      targetFk: other?.many_field && IDENT.test(other.many_field) ? other.many_field : null,
      discriminator: !other?.one_collection && disc && IDENT.test(disc) ? disc : null
    })
  }
  return out
}

const junctionCache = tenantState(() => ({
  at: 0,
  value: null as Map<string, JunctionInfo> | null
}))
const JUNCTION_TTL_MS = 60_000

export async function loadJunctionMap(): Promise<Map<string, JunctionInfo>> {
  const c = junctionCache()
  if (c.value && Date.now() - c.at < JUNCTION_TTL_MS) return c.value
  try {
    const rels = (await db('nivaro_relations').select(
      'many_collection',
      'many_field',
      'one_collection',
      'one_field',
      'junction_field',
      'one_collection_field'
    )) as RelationRow[]
    c.value = buildJunctionMap(rels)
    c.at = Date.now()
    return c.value
  } catch {
    return c.value ?? new Map()
  }
}

/** The junction collections that hang off `parent`. */
export function junctionsOf(parent: string, junctions: Map<string, JunctionInfo>): string[] {
  return [...junctions.values()].filter((j) => j.parent === parent).map((j) => j.junction)
}
