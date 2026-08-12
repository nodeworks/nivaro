import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * User Scopes — per-user dimensional defaults + restrictions with
 * auto-resolved paths.
 *
 * A dimension names a TARGET collection (divisions, regions, …). For any
 * requested collection, the path from it to the target is DERIVED by
 * BFS-walking nivaro_relations (M2O edges + M2M/O2M alias edges, depth ≤ 3)
 * — never stored — so new collections are covered the moment a relation to
 * the target exists, and schema changes self-heal. The resolved segments are
 * exactly the dialect items.ts's planConditionPath already walks: a single
 * M2O field compares the FK column, a bare alias leaf compares junction ids,
 * chains mix hops. Scope values are target-collection IDS.
 *
 * This module deliberately does NOT import items.ts (items.ts imports us for
 * enforcement) — it returns {path, ids} pairs and items.ts compiles them.
 */

export interface ScopeDimension {
  id: number
  name: string
  label: string
  target_collection: string
  display_field: string | null
  options_sort: string | null
  overrides: Record<string, string[]> | null
  exclusions: string[] | null
  strict: boolean
  is_active: boolean
}

export interface UserScopeRow {
  id: number
  user: string
  dimension: string
  mode: 'default' | 'restrict'
  values: Array<string | number>
}

export interface ScopeFilter {
  hops: ScopeHop[]
  ids: Array<string | number>
}

export interface ScopeEnforcement {
  filters: ScopeFilter[]
  /** strict dimension had restrict values but no resolvable route → deny all */
  deny: boolean
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

// ── Caches (60s, same posture as the other schema caches) ────────────────────

const TTL = 60_000

let dimCache: { at: number; rows: ScopeDimension[] } | null = null
export function bustScopeDimensionCache() {
  dimCache = null
  pathCache.clear()
}

export async function listScopeDimensions(activeOnly = true): Promise<ScopeDimension[]> {
  if (!dimCache || Date.now() - dimCache.at > TTL) {
    const rows = (await db('nivaro_scope_dimensions').orderBy('name')) as Array<
      Record<string, unknown>
    >
    dimCache = {
      at: Date.now(),
      rows: rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        label: String(r.label),
        target_collection: String(r.target_collection),
        display_field: (r.display_field as string) ?? null,
        options_sort: (r.options_sort as string) ?? null,
        overrides: parseJson<Record<string, string[]>>(r.overrides),
        exclusions: parseJson<string[]>(r.exclusions),
        strict: !!r.strict,
        is_active: !!r.is_active
      }))
    }
  }
  return activeOnly ? dimCache.rows.filter((d) => d.is_active) : dimCache.rows
}

const userScopeCache = new Map<string, { at: number; rows: UserScopeRow[] }>()
export function bustUserScopeCache(userId?: string) {
  if (userId) userScopeCache.delete(userId.toLowerCase())
  else userScopeCache.clear()
}

export async function getUserScopes(userId: string): Promise<UserScopeRow[]> {
  const key = userId.toLowerCase()
  const hit = userScopeCache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.rows
  const rows = (await db('nivaro_user_scopes').where({ user: userId })) as Array<
    Record<string, unknown>
  >
  const parsed: UserScopeRow[] = rows.map((r) => ({
    id: Number(r.id),
    user: String(r.user),
    dimension: String(r.dimension),
    mode: r.mode === 'restrict' ? 'restrict' : 'default',
    values: parseJson<Array<string | number>>(r.values) ?? []
  }))
  userScopeCache.set(key, { at: Date.now(), rows: parsed })
  return parsed
}

// ── Relations adjacency + BFS path resolution (hop graph) ────────────────────
//
// Edges carry the FULL join mechanics, not just a field name:
//   m2o      — parent.fk → target.id            (plain FK column)
//   o2m      — child.childFk = parent.id        (reverse of an M2O)
//   junction — EXISTS junction WHERE junction.parentFk = parent.id
//                                AND junction.targetFk → target.id
// Junction edges are derived from the junction table's own M2O LEGS (the
// rows that carry junction_field as the pairing marker), so an M2M hop works
// even when no alias field is registered on the parent collection. The
// resolved route is compiled to nested EXISTS subqueries here — enforcement
// does not depend on alias fields existing.

interface RelRow {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

export type ScopeHop =
  | { kind: 'm2o'; from: string; to: string; fk: string }
  | { kind: 'o2m'; from: string; to: string; childFk: string }
  | { kind: 'junction'; from: string; to: string; junction: string; parentFk: string; targetFk: string }

interface Edge {
  hop: ScopeHop
}

let adjCache: { at: number; adj: Map<string, Edge[]> } | null = null

async function getAdjacency(): Promise<Map<string, Edge[]>> {
  if (adjCache && Date.now() - adjCache.at < TTL) return adjCache.adj
  const [rels, tableRows] = await Promise.all([
    db('nivaro_relations').select(
      'many_collection',
      'many_field',
      'one_collection',
      'one_field',
      'junction_field'
    ) as Promise<RelRow[]>,
    // nivaro_relations can outlive the physical schema: EFP carries rows for
    // junctions that were never created (forecasts_divisions / _regions /
    // _project_types). Routing a scope through one produced SQL against a
    // non-existent table and 500'd EVERY read of that collection for any
    // scoped user. Metadata is a claim; information_schema is the truth.
    db('information_schema.tables').select('table_name') as Promise<
      Array<{ table_name: string }>
    >
  ])
  const realTables = new Set(tableRows.map((t) => String(t.table_name).toLowerCase()))
  const adj = new Map<string, Edge[]>()
  const skip = (c: string) => c.startsWith('nivaro_') || c.startsWith('directus_')
  const missing = new Set<string>()
  const real = (c?: string | null) => {
    if (!c) return false
    if (realTables.has(c.toLowerCase())) return true
    missing.add(c)
    return false
  }
  const push = (hop: ScopeHop) => {
    if (skip(hop.from) || skip(hop.to)) return
    // Drop the whole hop if any table it touches doesn't exist.
    if (!real(hop.from) || !real(hop.to)) return
    if (hop.kind === 'junction' && !real(hop.junction)) return
    const list = adj.get(hop.from) ?? []
    list.push({ hop })
    adj.set(hop.from, list)
  }

  // Junction tables: any collection whose M2O legs carry the junction_field
  // pairing marker, or that an alias row names as its junction. Collect ALL
  // their M2O legs (marker rows AND plain rows — legacy data mixes both).
  const junctionTables = new Set<string>()
  for (const r of rels) {
    if (r.many_collection && r.junction_field && r.many_field) junctionTables.add(r.many_collection)
    if (r.one_collection && r.one_field && r.junction_field && r.many_collection) {
      junctionTables.add(r.many_collection)
    }
  }
  const legsByJunction = new Map<string, Array<{ field: string; target: string }>>()
  for (const r of rels) {
    if (
      r.many_collection &&
      junctionTables.has(r.many_collection) &&
      r.many_field &&
      r.one_collection
    ) {
      const legs = legsByJunction.get(r.many_collection) ?? []
      if (!legs.some((l) => l.field === r.many_field)) {
        legs.push({ field: r.many_field, target: r.one_collection })
      }
      legsByJunction.set(r.many_collection, legs)
    }
  }
  // pair every two legs of a junction → bidirectional junction edges
  for (const [junction, legs] of legsByJunction) {
    for (const a of legs) {
      for (const b of legs) {
        if (a === b || a.target === b.target) continue
        push({
          kind: 'junction',
          from: a.target,
          to: b.target,
          junction,
          parentFk: a.field,
          targetFk: b.field
        })
      }
    }
  }

  for (const r of rels) {
    if (!r.many_collection || !r.many_field || !r.one_collection) continue
    if (junctionTables.has(r.many_collection)) continue // junction legs handled above
    if (r.junction_field) continue
    // plain M2O both directions
    push({ kind: 'm2o', from: r.many_collection, to: r.one_collection, fk: r.many_field })
    push({ kind: 'o2m', from: r.one_collection, to: r.many_collection, childFk: r.many_field })
  }
  if (missing.size > 0) {
    // Surfaced once per cache rebuild (60s) so the orphan metadata still gets
    // cleaned up rather than silently degrading scope coverage forever.
    console.warn(
      `[user-scopes] ignoring relations to ${missing.size} non-existent table(s): ${[...missing].sort().join(', ')}`
    )
  }
  adjCache = { at: Date.now(), adj }
  return adj
}

const pathCache = new Map<string, ScopeHop[] | null>()
export function bustScopePathCache() {
  pathCache.clear()
  adjCache = null
}

const MAX_DEPTH = 3

/** Shortest hop route from `collection` to `target`. Null = unreachable.
 *  M2O/junction edges are preferred over O2M at equal depth (BFS pushes them
 *  first), since "belongs to" semantics beat "has many" for scoping. */
export async function resolveScopeHops(
  collection: string,
  target: string
): Promise<ScopeHop[] | null> {
  const key = `${collection}→${target}`
  if (pathCache.has(key)) return pathCache.get(key) ?? null
  const adj = await getAdjacency()
  const queue: Array<{ at: string; hops: ScopeHop[] }> = [{ at: collection, hops: [] }]
  const seen = new Set<string>([collection])
  let found: ScopeHop[] | null = null
  while (queue.length > 0) {
    const { at, hops } = queue.shift() as { at: string; hops: ScopeHop[] }
    if (hops.length >= MAX_DEPTH) continue
    // A collection can hold SEVERAL links to the same target — workflows has
    // both `project_type` and `car_project_type` pointing at project_types —
    // and taking whichever the relation order happened to yield silently
    // scoped every user by the CAR-only column, hiding every non-CAR record
    // from people who were entitled to it. Prefer the canonically-named link:
    // the one named after the target itself, over any qualified variant.
    const singular = (t: string) => (t.endsWith('s') ? t.slice(0, -1) : t)
    const linkName = (h: ScopeHop) =>
      h.kind === 'm2o' ? h.fk : h.kind === 'o2m' ? h.childFk : h.junction
    const nameRank = (h: ScopeHop) => {
      const n = (linkName(h) ?? '').toLowerCase()
      const t = h.to.toLowerCase()
      if (n === singular(t) || n === t) return 0 // project_type → project_types
      if (n === `${singular(t)}_id` || n === `${t}_id`) return 1 // junction leg
      if (h.kind === 'junction' && h.junction.toLowerCase() === `${h.from.toLowerCase()}_${t}`) {
        return 1 // workflows_divisions
      }
      return 2 // car_project_type and friends
    }
    const edges = [...(adj.get(at) ?? [])]
      // NEVER scope through a reverse (o2m) hop. An o2m route says "this row is
      // visible if one of its CHILDREN is in your scope", which is not what a
      // dimensional scope means — it means "this row belongs to your division".
      // Following them made reference data disappear: `vendors` resolved as
      // vendors.workflows(has-many) → workflows → divisions, so a vendor was
      // only visible if it happened to have a workflow in your division, and
      // `divisions` itself picked up four reverse routes that ANDed together to
      // match nothing (audit: 146 of 441 routes were reverse). A collection
      // with no forward route is simply unscoped for that dimension, which is
      // the safe direction — the items service still enforces RBAC and RLS.
      .filter((e) => e.hop.kind !== 'o2m')
      .sort((a, b) => {
      const kindRank = (h: ScopeHop) => (h.kind === 'o2m' ? 1 : 0)
      return (
        kindRank(a.hop) - kindRank(b.hop) ||
        nameRank(a.hop) - nameRank(b.hop) ||
        // Last resort: shortest link name — fewer qualifiers is the plain one.
        (linkName(a.hop) ?? '').length - (linkName(b.hop) ?? '').length
      )
    })
    for (const e of edges) {
      const nextHops = [...hops, e.hop]
      if (e.hop.to === target) {
        found = nextHops
        queue.length = 0
        break
      }
      if (!seen.has(e.hop.to)) {
        seen.add(e.hop.to)
        queue.push({ at: e.hop.to, hops: nextHops })
      }
    }
  }
  pathCache.set(key, found)
  return found
}

/** Human-readable route for coverage displays. */
export function describeHops(hops: ScopeHop[]): string {
  return hops
    .map((h) =>
      h.kind === 'm2o'
        ? `${h.fk} → ${h.to}`
        : h.kind === 'o2m'
          ? `${h.to}.${h.childFk} (has-many)`
          : `via ${h.junction} (${h.parentFk} ⇄ ${h.targetFk}) → ${h.to}`
    )
    .join(' · ')
}

/**
 * Compile a hop route into nested EXISTS subqueries on a knex query.
 * Self-contained (knex only) so enforcement never depends on alias fields.
 */
export function applyScopeHops(
  q: import('knex').Knex.QueryBuilder,
  collection: string,
  hops: ScopeHop[],
  ids: Array<string | number>
): void {
  const build = (
    qb: import('knex').Knex.QueryBuilder,
    parentTable: string,
    parentAlias: string,
    idx: number
  ): void => {
    const h = hops[idx]
    const last = idx === hops.length - 1
    if (h.kind === 'm2o') {
      if (last) {
        void qb.whereIn(`${parentAlias}.${h.fk}`, ids as never)
        return
      }
      const alias = `s${idx}`
      void qb.whereExists(function () {
        void this.select(db.raw('1'))
          .from(`${h.to} as ${alias}`)
          .whereRaw('?? = ??', [`${alias}.id`, `${parentAlias}.${h.fk}`])
        build(this, h.to, alias, idx + 1)
      })
      return
    }
    if (h.kind === 'o2m') {
      const alias = `s${idx}`
      void qb.whereExists(function () {
        void this.select(db.raw('1'))
          .from(`${h.to} as ${alias}`)
          .whereRaw('?? = ??', [`${alias}.${h.childFk}`, `${parentAlias}.id`])
        if (last) void this.whereIn(`${alias}.id`, ids as never)
        else build(this, h.to, alias, idx + 1)
      })
      return
    }
    // junction
    const jAlias = `j${idx}`
    void qb.whereExists(function () {
      void this.select(db.raw('1'))
        .from(`${h.junction} as ${jAlias}`)
        .whereRaw('?? = ??', [`${jAlias}.${h.parentFk}`, `${parentAlias}.id`])
      if (last) {
        void this.whereIn(`${jAlias}.${h.targetFk}`, ids as never)
      } else {
        const tAlias = `s${idx}`
        void this.whereExists(function () {
          void this.select(db.raw('1'))
            .from(`${h.to} as ${tAlias}`)
            .whereRaw('?? = ??', [`${tAlias}.id`, `${jAlias}.${h.targetFk}`])
          build(this, h.to, tAlias, idx + 1)
        })
      }
    })
  }
  build(q, collection, collection, 0)
}

/**
 * The RECORD side of a dimension route: walk the hops with LEFT JOINs and
 * return each record's linked target ids ("this workflow's divisions are
 * [4]"). Lets access explanations say what the record IS, not just what the
 * user is limited to. hops [] = the collection IS the target (own id).
 */
export async function resolveRecordDimensionIds(
  collection: string,
  ids: Array<string | number>,
  hops: ScopeHop[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out
  if (hops.length === 0) {
    for (const id of ids) out.set(String(id), [String(id)])
    return out
  }
  let q = db(`${collection} as t0`).whereIn('t0.id', ids as never)
  let alias = 't0'
  let valueCol: string | null = null
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i]
    const last = i === hops.length - 1
    if (h.kind === 'm2o') {
      if (last) {
        valueCol = `${alias}.${h.fk}`
        break
      }
      const next = `t${i + 1}`
      q = q.leftJoin(`${h.to} as ${next}`, `${next}.id`, `${alias}.${h.fk}`)
      alias = next
    } else if (h.kind === 'junction') {
      const j = `jx${i}`
      q = q.leftJoin(`${h.junction} as ${j}`, `${j}.${h.parentFk}`, `${alias}.id`)
      if (last) {
        valueCol = `${j}.${h.targetFk}`
        break
      }
      const next = `t${i + 1}`
      q = q.leftJoin(`${h.to} as ${next}`, `${next}.id`, `${j}.${h.targetFk}`)
      alias = next
    } else {
      // o2m (reverse) — join the child on its FK back to us
      const c = `cx${i}`
      q = q.leftJoin(`${h.to} as ${c}`, `${c}.${h.childFk}`, `${alias}.id`)
      if (last) {
        valueCol = `${c}.id`
        break
      }
      alias = c
    }
  }
  if (!valueCol) return out
  try {
    const rows = (await q.select('t0.id as __rid', db.raw('?? as __val', [valueCol]))) as Array<{
      __rid: unknown
      __val: unknown
    }>
    for (const r of rows) {
      const rid = String(r.__rid)
      if (!out.has(rid)) out.set(rid, [])
      if (r.__val != null) {
        const arr = out.get(rid) as string[]
        const v = String(r.__val)
        if (!arr.includes(v)) arr.push(v)
      }
    }
  } catch {
    /* explanatory only — never fail the caller */
  }
  return out
}

/** Effective route for a dimension on a collection: exclusion > override > BFS.
 *  Overrides are FIELD-SEGMENT lists (M2O chains / alias names) resolved
 *  against live relations into hops. */
export async function scopeHopsFor(
  dim: ScopeDimension,
  collection: string
): Promise<ScopeHop[] | null> {
  if (dim.exclusions?.includes(collection)) return null
  if (collection === dim.target_collection) return [] // self: compare own id
  const override = dim.overrides?.[collection]
  if (override && override.length > 0) {
    const hops = await segmentsToHops(collection, override)
    if (hops) return hops
  }
  return resolveScopeHops(collection, dim.target_collection)
}

/** Resolve override segments (M2O field / alias field names) into hops. */
async function segmentsToHops(collection: string, segments: string[]): Promise<ScopeHop[] | null> {
  const rels = (await db('nivaro_relations').select(
    'many_collection',
    'many_field',
    'one_collection',
    'one_field',
    'junction_field'
  )) as RelRow[]
  const hops: ScopeHop[] = []
  let current = collection
  for (const seg of segments) {
    const m2o = rels.find(
      (r) => r.many_collection === current && r.many_field === seg && !r.junction_field
    )
    if (m2o?.one_collection) {
      hops.push({ kind: 'm2o', from: current, to: m2o.one_collection, fk: seg })
      current = m2o.one_collection
      continue
    }
    const alias = rels.find((r) => r.one_collection === current && r.one_field === seg)
    if (alias?.many_collection) {
      if (alias.junction_field) {
        const targetLeg = rels.find(
          (r) => r.many_collection === alias.many_collection && r.many_field === alias.junction_field
        )
        if (!targetLeg?.one_collection) return null
        const parentLeg = rels.find(
          (r) =>
            r.many_collection === alias.many_collection &&
            r.one_collection === current &&
            r.many_field !== alias.junction_field
        )
        if (!parentLeg?.many_field) return null
        hops.push({
          kind: 'junction',
          from: current,
          to: targetLeg.one_collection,
          junction: alias.many_collection,
          parentFk: parentLeg.many_field,
          targetFk: alias.junction_field
        })
        current = targetLeg.one_collection
      } else {
        hops.push({
          kind: 'o2m',
          from: current,
          to: alias.many_collection,
          childFk: alias.many_field ?? ''
        })
        current = alias.many_collection
      }
      continue
    }
    return null
  }
  return hops
}

// ── Enforcement (restrict mode) ──────────────────────────────────────────────

const roleAdminCache = new Map<string, { at: number; admin: boolean }>()

async function isAdminRole(roleId: string | null | undefined): Promise<boolean> {
  if (!roleId) return false
  const hit = roleAdminCache.get(roleId)
  if (hit && Date.now() - hit.at < TTL) return hit.admin
  const role = (await db('nivaro_roles').where({ id: roleId }).first()) as
    | { admin_access?: boolean }
    | undefined
  const admin = !!role?.admin_access
  roleAdminCache.set(roleId, { at: Date.now(), admin })
  return admin
}

/**
 * Restrict-mode filters for this user on this collection. Empty filters +
 * deny=false → no scoping applies. Called from items.ts on every read.
 */
export async function getUserScopeEnforcement(
  user: User,
  collection: string
): Promise<ScopeEnforcement> {
  const none: ScopeEnforcement = { filters: [], deny: false }
  if (collection.startsWith('nivaro_') || collection.startsWith('directus_')) return none
  if (await isAdminRole(user.role)) return none
  const scopes = await getUserScopes(user.id)
  const restricts = scopes.filter((s) => s.mode === 'restrict' && s.values.length > 0)
  if (restricts.length === 0) return none
  const dims = await listScopeDimensions()
  // A dimension TARGET table (divisions, regions, project_types, …) is shared
  // reference data every user must read to render a label. Filtering one by a
  // DIFFERENT dimension is meaningless — a division does not live in a region —
  // and ANDing several of them together made these tables resolve to zero rows,
  // which broke every relation label and picker in the app. A target table is
  // still scoped by its OWN dimension (you see divisions 1-3 and no others).
  const targets = new Set(dims.map((d) => d.target_collection))
  const isReferenceTable = targets.has(collection)
  const out: ScopeEnforcement = { filters: [], deny: false }
  for (const s of restricts) {
    const dim = dims.find((d) => d.name === s.dimension)
    if (!dim) continue
    if (isReferenceTable && dim.target_collection !== collection) continue
    const hops = await scopeHopsFor(dim, collection)
    if (hops) out.filters.push({ hops, ids: s.values })
    else if (dim.strict) out.deny = true
  }
  return out
}

/** Full enforcement entry point: apply every restrict filter to a query. */
export function applyScopeEnforcement(
  q: import('knex').Knex.QueryBuilder,
  collection: string,
  enforcement: ScopeEnforcement
): void {
  if (enforcement.deny) {
    void q.whereRaw('1 = 0')
    return
  }
  for (const f of enforcement.filters) {
    if (f.hops.length === 0) {
      // dimension targets this collection itself — compare own id
      void q.whereIn(`${collection}.id`, f.ids as never)
      continue
    }
    applyScopeHops(q, collection, f.hops, f.ids)
  }
}

export async function applyUserScopesToQuery(
  q: import('knex').Knex.QueryBuilder,
  collection: string,
  user: User
): Promise<void> {
  applyScopeEnforcement(q, collection, await getUserScopeEnforcement(user, collection))
}

// ── Defaults + display (for /users/me/scopes and editors) ────────────────────

export async function describeUserScopes(userId: string): Promise<{
  dimensions: Array<{
    name: string
    label: string
    target_collection: string
    display_field: string | null
    options_sort: string | null
  }>
  defaults: Record<string, Array<string | number>>
  restricted: Record<string, Array<string | number>>
}> {
  const [dims, scopes] = await Promise.all([listScopeDimensions(), getUserScopes(userId)])
  const defaults: Record<string, Array<string | number>> = {}
  const restricted: Record<string, Array<string | number>> = {}
  for (const s of scopes) {
    if (!dims.some((d) => d.name === s.dimension)) continue
    if (s.mode === 'default') defaults[s.dimension] = s.values
    else restricted[s.dimension] = s.values
  }
  return {
    dimensions: dims.map((d) => ({
      name: d.name,
      label: d.label,
      target_collection: d.target_collection,
      display_field: d.display_field,
      options_sort: d.options_sort
    })),
    defaults,
    restricted
  }
}
