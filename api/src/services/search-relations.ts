/**
 * Related-label search: `nivaro_collections.browser_config.search_relations`.
 *
 * A list `?search=` matches the collection's OWN text columns. A record is often
 * known by a label it only reaches through a relation — a project by its
 * region's name — and "2026 Big South" found nothing because no project column
 * holds "Big South". `search_relations` lists relation paths ending in a text
 * field of the related collection (`["regions.name", "division.region.name"]`);
 * each word of a search then also matches when a related record's field
 * contains it (the words stay ANDed, each word may match a column OR a path).
 *
 * A path is a CLAIM, never a grant. It is judged as the caller, hop by hop:
 *   - every hop is an M2O (FK on this collection) or an M2M alias (through its
 *     junction) — no O2M fan-out, at most MAX_HOPS hops;
 *   - the alias / FK at every hop is a field the caller may read on that
 *     collection, the related collection is readable to them (API key scopes
 *     included) and the last segment is a string/text column they may read
 *     there. A collection with no read policy for them reads nothing;
 *   - system tables (nivaro_ / directus_) are never reached;
 *   - rows: the compiler's filter scope gate puts the caller's read row filter
 *     and User Scopes on every hop (services/filter-scope-gate.ts), exactly as a
 *     relational filter the caller sent would be judged (H12).
 * A path that fails any check is dropped silently (the search keeps its own
 * columns), so a stale or hostile config never widens what a person can match.
 *
 * Unset, empty or malformed = no related search (the search as before).
 */

/** Hops a path may take before its field (`division.region.name` = 2). */
export const MAX_HOPS = 3
/** Paths a collection may list (each adds an EXISTS per word). */
export const MAX_PATHS = 6

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** The configured paths as segment lists; null when unset, empty or holding no valid path. */
export function parseSearchRelations(browserConfig: unknown): string[][] | null {
  try {
    const bc =
      typeof browserConfig === 'string'
        ? (JSON.parse(browserConfig) as Record<string, unknown>)
        : (browserConfig as Record<string, unknown> | null)
    const raw = bc?.search_relations
    if (!Array.isArray(raw)) return null
    const seen = new Set<string>()
    const out: string[][] = []
    for (const v of raw) {
      const segs = String(v ?? '')
        .trim()
        .split('.')
        .map((s) => s.trim())
      if (segs.length < 2 || segs.length > MAX_HOPS + 1) continue
      if (!segs.every((s) => IDENT.test(s))) continue
      const key = segs.join('.').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(segs)
      if (out.length >= MAX_PATHS) break
    }
    return out.length ? out : null
  } catch {
    return null
  }
}

/** One relation hop, as the list read compiles it (an EXISTS per hop). */
export type SearchHop =
  | {
      kind: 'm2o'
      /** The collection the hop lands on. */
      to: string
      /** The FK column on the current collection. */
      column: string
    }
  | {
      kind: 'm2m'
      to: string
      /** The alias field on the current collection. */
      column: string
      junction: string
      /** The junction's FK to the current row / to the far row. */
      fkToParent: string
      fkToOther: string
    }

export interface SearchRelationDeps {
  /** The M2O / M2M hop `seg` names on `collection`, null for anything else (O2M, a column). */
  hop(collection: string, seg: string): Promise<SearchHop | null>
  /** Whether `field` is a string/text column of `collection`. */
  isTextColumn(collection: string, field: string): Promise<boolean>
  /** The caller may read `collection` at all (role + API key scopes). */
  canRead(collection: string): Promise<boolean>
  /** The caller's readable fields on `collection`: null = every field, [] = none. */
  allowedFields(collection: string): Promise<string[] | null>
  isSystem(collection: string): boolean
}

export interface JudgedSearchRelation {
  segments: string[]
  hops: SearchHop[]
  /** The text field on the last hop's collection. */
  field: string
}

/** Judged paths that take the same hops, one EXISTS per word for all their fields. */
export interface SearchRelationGroup {
  hops: SearchHop[]
  fields: string[]
}

const readableIn = (allowed: string[] | null, field: string) =>
  allowed === null ||
  allowed.includes('*') ||
  allowed.some((f) => f.toLowerCase() === field.toLowerCase())

/**
 * The configured paths the caller may search through (see the header). `rootAllowed`
 * is the caller's field list on the root collection as the read already resolved it
 * (null / '*' = every field). A path that names a table twice (the root included, or a
 * junction) is refused: the EXISTS chain names tables unaliased.
 */
export async function judgeSearchRelations(
  collection: string,
  paths: string[][] | null,
  rootAllowed: string[] | null,
  deps: SearchRelationDeps
): Promise<JudgedSearchRelation[]> {
  if (!paths?.length) return []
  const allowedCache = new Map<string, Promise<string[] | null>>()
  const canCache = new Map<string, Promise<boolean>>()
  const allowedOf = (c: string) => {
    let hit = allowedCache.get(c)
    if (!hit) {
      hit = deps.allowedFields(c)
      allowedCache.set(c, hit)
    }
    return hit
  }
  const canOf = (c: string) => {
    let hit = canCache.get(c)
    if (!hit) {
      hit = deps.canRead(c)
      canCache.set(c, hit)
    }
    return hit
  }
  const out: JudgedSearchRelation[] = []
  for (const segments of paths) {
    let current = collection
    let allowed: string[] | null = rootAllowed
    const hops: SearchHop[] = []
    const tables = new Set([collection.toLowerCase()])
    const fresh = (t: string) => {
      const k = t.toLowerCase()
      if (tables.has(k)) return false
      tables.add(k)
      return true
    }
    let ok = true
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const hop = await deps.hop(current, seg).catch(() => null)
      if (
        !hop ||
        !(readableIn(allowed, seg) || readableIn(allowed, hop.column)) ||
        (hop.kind === 'm2m' && (!fresh(hop.junction) || deps.isSystem(hop.junction))) ||
        !fresh(hop.to) ||
        deps.isSystem(hop.to) ||
        !(await canOf(hop.to).catch(() => false))
      ) {
        ok = false
        break
      }
      hops.push(hop)
      current = hop.to
      allowed = await allowedOf(current).catch(() => [] as string[])
      // No read policy on the related collection: nothing there is readable.
      if (allowed !== null && allowed.length === 0) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const field = segments[segments.length - 1]
    if (!readableIn(allowed, field)) continue
    if (!(await deps.isTextColumn(current, field).catch(() => false))) continue
    out.push({ segments, hops, field })
  }
  return out
}

/** Paths taking the same hops share one EXISTS (`regions.name` + `regions.short_name`). */
export function groupSearchRelations(paths: JudgedSearchRelation[]): SearchRelationGroup[] {
  const groups = new Map<string, SearchRelationGroup>()
  for (const p of paths) {
    const key = p.segments.slice(0, -1).join('.').toLowerCase()
    const g = groups.get(key)
    if (!g) groups.set(key, { hops: p.hops, fields: [p.field] })
    else if (!g.fields.includes(p.field)) g.fields.push(p.field)
  }
  return [...groups.values()]
}

/** Every collection a group reaches (each needs the caller's scope gate primed). */
export function searchRelationCollections(groups: SearchRelationGroup[]): string[] {
  return [...new Set(groups.flatMap((g) => g.hops.map((h) => h.to)))]
}
