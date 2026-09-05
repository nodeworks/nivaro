import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import {
  ADDENDUM_COLLECTION,
  fetchPipelineRecord,
  resolvePipelineSubject,
  resolvePipelineSubjectsBatch
} from './pipeline-subject.js'
import { span } from './request-trace.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowState {
  id: string
  template: string
  key: string
  label: string
  color: string | null
  is_initial: boolean
  is_terminal: boolean
  lock_record: boolean
  sort: number
  skip_criteria: string | null
}

export interface WorkflowTransition {
  id: string
  template: string
  from_state: string | null
  to_state: string
  label: string
  color: string | null
  required_roles: string | null
  actions: string | null
  sort: number
  requirements?: string | null
}

export interface WorkflowInstance {
  id: string
  template: string
  collection: string
  item: string
  current_state: string | null
  started_at: Date
  completed_at: Date | null
}

export interface WorkflowHistory {
  id: number
  instance: string
  transition: string | null
  from_state: string | null
  to_state: string
  user: string | null
  comment: string | null
  timestamp: Date
}

export interface OwnerGroup {
  id: string
  template: string
  state: string
  name: string | null
  filters: string | null
  sort: number
  is_default: boolean
  priority: number
  max_wip: number | null
}

export interface ResolvedOwner {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
}

type SkipOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'notin'

export type SkipCondition =
  | { type: 'no_owners' }
  | { type: 'field_compare'; field: string; op: SkipOp; value: unknown }
  | { type: 'field_empty'; field: string }
  | { type: 'field_nonempty'; field: string }

export interface SkipCriteria {
  mode: 'any' | 'all'
  conditions: SkipCondition[]
}

export interface RecordFilter {
  field: string
  op: SkipOp
  value: unknown
  id_value?: number | null
}

export interface RelationInfo {
  many_collection: string
  many_field: string
  one_collection: string | null
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function parseJson(val: string | null | undefined): unknown {
  if (!val) return null
  try {
    return JSON.parse(val)
  } catch {
    return null
  }
}

export function toJsonStr(val: unknown): string | null {
  if (val === null || val === undefined) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

export function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (val === 1 || val === '1' || val === 'true') return true
  return false
}

export function formatState(s: WorkflowState): WorkflowState {
  return {
    ...s,
    is_initial: coerceBool(s.is_initial),
    is_terminal: coerceBool(s.is_terminal),
    lock_record: coerceBool(s.lock_record)
  }
}

export function formatTransition(t: WorkflowTransition) {
  return {
    ...t,
    required_roles: parseJson(t.required_roles) as string[] | null,
    actions: parseJson(t.actions) as unknown[] | null
  }
}

export function evalFilterOp(op: SkipOp, recordVal: unknown, value: unknown): boolean {
  switch (op) {
    case 'eq':
      return recordVal === value
    case 'neq':
      return recordVal !== value
    case 'lt':
      return Number(recordVal) < Number(value)
    case 'lte':
      return Number(recordVal) <= Number(value)
    case 'gt':
      return Number(recordVal) > Number(value)
    case 'gte':
      return Number(recordVal) >= Number(value)
    case 'in':
      return Array.isArray(value) && value.includes(recordVal)
    case 'notin':
      return Array.isArray(value) && !value.includes(recordVal)
    default:
      return false
  }
}

export function dedupeOwners(owners: ResolvedOwner[]): ResolvedOwner[] {
  const seen = new Set<string>()
  const out: ResolvedOwner[] = []
  for (const o of owners) {
    if (seen.has(o.id)) continue
    seen.add(o.id)
    out.push(o)
  }
  return out
}

// ─── Delegation / substitution ──────────────────────────────────────────────

/**
 * Resolve a user's active delegate. When the user is out of office and has a
 * delegate set that has not expired, returns the delegate's id; otherwise the
 * original id. See "Pipeline delegation" gotcha in CLAUDE.md.
 */
export async function resolveActiveDelegate(
  userId: string,
  database: typeof db = db
): Promise<string> {
  const user = await database('nivaro_users')
    .where({ id: userId })
    .select('id', 'delegate_id', 'delegate_expires_at', 'is_out_of_office')
    .first<{
      id: string
      delegate_id: string | null
      delegate_expires_at: Date | null
      is_out_of_office: boolean
    }>()
  if (!user) return userId
  if (
    coerceBool(user.is_out_of_office) &&
    user.delegate_id &&
    (!user.delegate_expires_at || new Date(user.delegate_expires_at) > new Date())
  ) {
    return user.delegate_id
  }
  return userId
}

export async function buildDelegationSubstitutions(
  ownerIds: string[],
  database: typeof db = db
): Promise<Map<string, ResolvedOwner | null>> {
  const out = new Map<string, ResolvedOwner | null>()
  if (ownerIds.length === 0) return out

  const rows = await selectInChunks(
    ownerIds,
    2000,
    (chunk) =>
      database('nivaro_users')
        .whereIn('id', chunk)
        .select('id', 'delegate_id', 'delegate_expires_at', 'is_out_of_office') as Promise<
        Array<{
          id: string
          delegate_id: string | null
          delegate_expires_at: Date | null
          is_out_of_office: boolean
        }>
      >
  )
  const byId = new Map(rows.map((r) => [r.id, r]))

  const substitutionTargets = new Map<string, string>()
  for (const id of ownerIds) {
    const u = byId.get(id)
    if (!u) continue
    if (
      coerceBool(u.is_out_of_office) &&
      u.delegate_id &&
      (!u.delegate_expires_at || new Date(u.delegate_expires_at) > new Date())
    ) {
      substitutionTargets.set(id, u.delegate_id)
    }
  }
  if (substitutionTargets.size === 0) return out

  const delegateIds = [...new Set(substitutionTargets.values())]
  const delegateRows = await selectInChunks(
    delegateIds,
    2000,
    (chunk) =>
      database('nivaro_users')
        .whereIn('id', chunk)
        .select('id', 'email', 'first_name', 'last_name') as Promise<ResolvedOwner[]>
  )
  const delegateById = new Map(delegateRows.map((d) => [d.id, d]))

  for (const [ownerId, delegateId] of substitutionTargets) {
    const delegate = delegateById.get(delegateId)
    if (delegate) out.set(ownerId, delegate)
  }
  return out
}

// ─── Owner resolution ─────────────────────────────────────────────────────────

// Pre-resolved value for one filter field on one record. `ids` carries the
// id-side comparison target: an id Set for M2M paths, or the final-hop FK for
// (multi-hop) M2O paths. `display` carries the display-column value(s) for
// filters saved without an id_value.
export interface ResolvedFilterValue {
  ids: Set<string> | unknown
  display: Set<string> | unknown
}

function evalAgainstResolved(op: RecordFilter['op'], resolved: unknown, target: unknown): boolean {
  if (resolved instanceof Set) {
    const has = resolved.has(String(target))
    if (op === 'neq') return !has
    if (op === 'eq') return has
    // Other ops don't have meaningful multi-value semantics — no match.
    return false
  }
  return evalFilterOp(op, resolved, target)
}

/**
 * A state's owner groups, partitioned and with their `filters` JSON parsed once.
 *
 * The workflows template carries ~3,900 owner groups, and every record resolved
 * against that state used to re-partition the array and re-parse every group's
 * filters — 518 records × 3,900 groups is two million JSON.parse calls per queue
 * read, which is where most of that queue's owner-resolution time went. The
 * groups for a state are identical across every record being resolved, so this
 * is prepared once and reused.
 *
 * Groups with no filters are dropped from `candidates` entirely rather than
 * being skipped inside the loop: an unfiltered non-default group can never
 * match, so it has no business being in the hot path at all.
 */
export interface PreparedOwnerGroups {
  candidates: Array<{ group: OwnerGroup; filters: RecordFilter[] }>
  defaults: OwnerGroup[]
  /** Every distinct field the candidates' filters read — the memo signature basis. */
  filterFields: string[]
}

// ── State→owner-groups cache ────────────────────────────────────────────────
// The workflows template carries ~3,900 owner groups; fetching and re-parsing
// them was ~700ms of EVERY owner resolution at this server's RTT, for data
// that changes only when an admin edits the matrix. 60s TTL; the owner-group
// CRUD routes and template restore bust it explicitly, so edits are visible
// immediately rather than a minute later.
const OWNER_GROUP_CACHE_TTL = 60_000
const ownerGroupCache = new Map<
  string,
  { groups: OwnerGroup[]; prepared: PreparedOwnerGroups; at: number }
>()

// state→template + collection bindings ride the same TTL/bust — they answer
// the owner-fallback question and change through the same admin surface.
const fallbackMetaCache = new Map<
  string,
  { templateByState: Map<string, string>; at: number }
>()
const bindingsCache = new Map<
  string,
  { rows: Array<{ collection: string; template: string; owner_fallback_field?: string | null }>; at: number }
>()

export function bustOwnerGroupCache(): void {
  ownerGroupCache.clear()
  fallbackMetaCache.clear()
  bindingsCache.clear()
}

/**
 * Groups + prepared structure per state, cached. A `database` other than the
 * module default (a transaction, a tenant DB) bypasses the cache — a cached
 * answer from a different connection would be wrong in cloud mode.
 */
async function getOwnerGroupsForStates(
  stateIds: string[],
  database: typeof db
): Promise<Map<string, { groups: OwnerGroup[]; prepared: PreparedOwnerGroups }>> {
  const out = new Map<string, { groups: OwnerGroup[]; prepared: PreparedOwnerGroups }>()
  const cacheable = database === db
  const missing: string[] = []
  const now = Date.now()
  for (const id of stateIds) {
    const hit = cacheable ? ownerGroupCache.get(id) : undefined
    if (hit && now - hit.at < OWNER_GROUP_CACHE_TTL) {
      out.set(id, { groups: hit.groups, prepared: hit.prepared })
    } else {
      missing.push(id)
    }
  }
  if (missing.length > 0) {
    let rows: OwnerGroup[]
    try {
      rows = (await database<OwnerGroup>('nivaro_pipeline_owner_groups')
        .whereIn('state', missing)
        .orderBy('sort')
        .orderBy('is_default')) as OwnerGroup[]
    } catch (err) {
      // Stale-while-revalidate (#331): a refresh failure serves each state's
      // last-known-good groups (extended one TTL) instead of dropping owner
      // resolution for the whole request. States with no prior cache rethrow.
      if (cacheable) {
        let covered = true
        for (const id of missing) {
          const stale = ownerGroupCache.get(id)
          if (!stale) {
            covered = false
            break
          }
          out.set(id, { groups: stale.groups, prepared: stale.prepared })
          ownerGroupCache.set(id, { ...stale, at: now })
        }
        if (covered) return out
      }
      throw err
    }
    const byState = new Map<string, OwnerGroup[]>()
    for (const g of rows) {
      const list = byState.get(g.state) ?? []
      list.push(g)
      byState.set(g.state, list)
    }
    for (const id of missing) {
      const groups = byState.get(id) ?? []
      const prepared = prepareOwnerGroups(groups)
      out.set(id, { groups, prepared })
      if (cacheable) ownerGroupCache.set(id, { groups, prepared, at: now })
    }
  }
  return out
}

export function prepareOwnerGroups(groups: OwnerGroup[]): PreparedOwnerGroups {
  const candidates: PreparedOwnerGroups['candidates'] = []
  const defaults: OwnerGroup[] = []
  const fieldSet = new Set<string>()
  for (const group of groups) {
    if (coerceBool(group.is_default)) {
      defaults.push(group)
      continue
    }
    const filters = parseJson(group.filters) as RecordFilter[] | null
    if (!filters || filters.length === 0) continue
    for (const f of filters) fieldSet.add(f.field)
    candidates.push({ group, filters })
  }
  return { candidates, defaults, filterFields: [...fieldSet].sort() }
}

export function pickWinningGroups(
  groups: OwnerGroup[],
  record: Record<string, unknown>,
  relations: RelationInfo[],
  resolvedValues?: Map<string, ResolvedFilterValue>
): OwnerGroup[] {
  return pickWinningGroupsPrepared(prepareOwnerGroups(groups), record, relations, resolvedValues)
}

export function pickWinningGroupsPrepared(
  prepared: PreparedOwnerGroups,
  record: Record<string, unknown>,
  relations: RelationInfo[],
  resolvedValues?: Map<string, ResolvedFilterValue>
): OwnerGroup[] {
  const { candidates, defaults } = prepared

  function evalFilter(f: RecordFilter): boolean {
    const resolved = resolvedValues?.get(f.field)
    if (resolved) {
      return f.id_value != null
        ? evalAgainstResolved(f.op, resolved.ids, f.id_value)
        : evalAgainstResolved(f.op, resolved.display, f.value)
    }
    if (f.id_value != null && f.field.includes('.')) {
      const prefix = f.field.split('.')[0]
      const m2oRel = relations.find((r) => r.many_field === prefix)
      const fkValue = m2oRel ? record[m2oRel.many_field] : null
      return evalFilterOp(f.op, fkValue, f.id_value)
    }
    if (f.id_value != null && !f.field.includes('.')) {
      return evalFilterOp(f.op, record[f.field], f.id_value)
    }
    return evalFilterOp(f.op, record[f.field], f.value)
  }

  // Only the single most specific match is returned, so track the running best
  // rather than collecting every match and sorting — the comparison is the same
  // one the sort used (more filters wins; ties break on lower priority).
  let best: { group: OwnerGroup; filterCount: number } | null = null
  for (const { group, filters } of candidates) {
    if (!filters.every((f) => evalFilter(f))) continue
    if (
      best === null ||
      filters.length > best.filterCount ||
      (filters.length === best.filterCount && (group.priority ?? 0) < (best.group.priority ?? 0))
    ) {
      best = { group, filterCount: filters.length }
    }
  }

  return best ? [best.group] : defaults
}

export interface OwnerResolutionRequest {
  key: string
  stateId: string
  instanceId: string | null
  collection: string
  itemId: string
}

// Batched, path-aware resolution of dotted owner-group filter fields for a set
// of records. Handles what pickWinningGroups' synchronous prefix lookup cannot:
//   - M2M alias dimensions (e.g. workflows.regions via workflows_regions):
//     resolves to a Set of related ids (+ Set of display values).
//   - Multi-hop M2O chains (e.g. project.project_type.name): resolves the FK at
//     the final hop (project_type id) and the display column value.
// Fields that fail to resolve are simply omitted — pickWinningGroups falls back
// to its legacy prefix behavior for them.
async function resolveFilterValues(
  collection: string,
  records: Map<string, Record<string, unknown>>,
  fields: string[],
  database: typeof db
): Promise<Map<string, Map<string, ResolvedFilterValue>>> {
  const out = new Map<string, Map<string, ResolvedFilterValue>>()
  const itemIds = [...records.keys()]
  if (itemIds.length === 0 || fields.length === 0) return out

  const setFor = (itemId: string) => {
    let m = out.get(itemId)
    if (!m) {
      m = new Map()
      out.set(itemId, m)
    }
    return m
  }

  interface RelRow {
    many_collection: string
    many_field: string
    one_collection: string | null
    one_field: string | null
    junction_field: string | null
  }
  const relCache = new Map<string, RelRow[]>()
  async function relsFor(table: string): Promise<RelRow[]> {
    if (!relCache.has(table)) {
      const rows = (await database('nivaro_relations')
        .where({ many_collection: table })
        .orWhere({ one_collection: table })
        .select(
          'many_collection',
          'many_field',
          'one_collection',
          'one_field',
          'junction_field'
        )) as RelRow[]
      relCache.set(table, rows)
    }
    return relCache.get(table) ?? []
  }

  const baseRels = await relsFor(collection)

  // Fields resolve independently (each writes its own key into the per-item
  // maps), so their query chains run concurrently — serially, four dotted
  // dims stacked their round trips end to end.
  await Promise.all(fields.map(async (field) => {
    const segments = field.split('.')
    if (segments.length < 2 || segments.length > 4) return
    const prefix = segments[0]
    try {
      const m2o = baseRels.find(
        (r) => r.many_collection === collection && r.many_field === prefix && r.one_collection
      )
      if (m2o) {
        // Walk the M2O chain: fk per item hops through intermediate tables; the
        // id-side value is the FK into the FINAL table, display is its column.
        let fkByItem = new Map<string, unknown>()
        for (const [itemId, rec] of records) fkByItem.set(itemId, rec[prefix])
        let table = m2o.one_collection as string
        for (let i = 1; i < segments.length - 1; i++) {
          const hopField = segments[i]
          const hopRels = await relsFor(table)
          const hopRel = hopRels.find(
            (r) => r.many_collection === table && r.many_field === hopField && r.one_collection
          )
          if (!hopRel) throw new Error(`no m2o hop ${table}.${hopField}`)
          const ids = [...new Set([...fkByItem.values()].filter((v) => v != null))]
          const rows = (await selectInChunks(ids as string[], 2000, (chunk) =>
            database(table).whereIn('id', chunk).select('id', hopField)
          )) as Array<Record<string, unknown>>
          const hopByRowId = new Map(rows.map((r) => [String(r.id), r[hopField]]))
          const next = new Map<string, unknown>()
          for (const [itemId, fk] of fkByItem) {
            next.set(itemId, fk == null ? null : (hopByRowId.get(String(fk)) ?? null))
          }
          fkByItem = next
          table = hopRel.one_collection as string
        }
        const displayCol = segments[segments.length - 1]
        const finalIds = [...new Set([...fkByItem.values()].filter((v) => v != null))]
        const displayRows = (await selectInChunks(finalIds as string[], 2000, (chunk) =>
          database(table).whereIn('id', chunk).select('id', displayCol)
        )) as Array<Record<string, unknown>>
        const displayByRowId = new Map(displayRows.map((r) => [String(r.id), r[displayCol]]))
        for (const [itemId, fk] of fkByItem) {
          setFor(itemId).set(field, {
            ids: fk ?? null,
            display: fk == null ? null : (displayByRowId.get(String(fk)) ?? null)
          })
        }
        return
      }

      const alias = baseRels.find((r) => r.one_collection === collection && r.one_field === prefix)
      if (alias?.junction_field) {
        const junction = alias.many_collection
        const ourCol = alias.many_field
        const relCol = alias.junction_field
        const junctionRels = await relsFor(junction)
        const relatedRel = junctionRels.find(
          (r) => r.many_collection === junction && r.many_field === relCol && r.one_collection
        )
        const junctionRows = (await selectInChunks(itemIds, 2000, (chunk) =>
          database(junction).whereIn(ourCol, chunk).select(`${ourCol} as our_id`, `${relCol} as rel_id`)
        )) as Array<{ our_id: unknown; rel_id: unknown }>
        const idsByItem = new Map<string, Set<string>>()
        const allRelated = new Set<string>()
        for (const row of junctionRows) {
          if (row.rel_id == null) continue
          const key = String(row.our_id)
          if (!idsByItem.has(key)) idsByItem.set(key, new Set())
          idsByItem.get(key)!.add(String(row.rel_id))
          allRelated.add(String(row.rel_id))
        }
        const displayCol = segments[1]
        const displayByRelId = new Map<string, string>()
        if (relatedRel?.one_collection && allRelated.size > 0 && segments.length >= 2) {
          const rows = (await selectInChunks([...allRelated], 2000, (chunk) =>
            database(relatedRel.one_collection as string)
              .whereIn('id', chunk)
              .select('id', displayCol)
          )) as Array<Record<string, unknown>>
          for (const r of rows) displayByRelId.set(String(r.id), String(r[displayCol]))
        }
        for (const itemId of itemIds) {
          const ids = idsByItem.get(itemId) ?? new Set<string>()
          const display = new Set<string>()
          for (const rid of ids) {
            const d = displayByRelId.get(rid)
            if (d != null) display.add(d)
          }
          setFor(itemId).set(field, { ids, display })
        }
      }
    } catch {
      // Unresolvable field — leave it out; legacy prefix fallback applies.
    }
  }))

  return out
}

export async function resolveStateOwnersBatch(
  requests: OwnerResolutionRequest[],
  database: typeof db = db
): Promise<Map<string, ResolvedOwner[]>> {
  const result = new Map<string, ResolvedOwner[]>()
  if (requests.length === 0) return result

  // Addendum instances resolve owners against their PARENT record (see
  // pipeline-subject.ts). The request key and instance id stay the caller's;
  // only the row the group filters read is swapped.
  const addendumIds = requests
    .filter((r) => r.collection === ADDENDUM_COLLECTION)
    .map((r) => String(r.itemId))
  if (addendumIds.length > 0) {
    const subjects = await resolvePipelineSubjectsBatch(ADDENDUM_COLLECTION, addendumIds, database)
    requests = requests.map((r) => {
      if (r.collection !== ADDENDUM_COLLECTION) return r
      const s = subjects.get(String(r.itemId))
      return s ? { ...r, collection: s.collection, itemId: s.itemId } : r
    })
  }

  const stateIds = [...new Set(requests.map((r) => r.stateId))]
  const groupData = await getOwnerGroupsForStates(stateIds, database)
  const groupsByState = new Map<string, OwnerGroup[]>()
  for (const [id, entry] of groupData) groupsByState.set(id, entry.groups)

  const withGroups = requests.filter((r) => (groupsByState.get(r.stateId) ?? []).length > 0)
  const withoutGroups = requests.filter((r) => (groupsByState.get(r.stateId) ?? []).length === 0)

  // Owner fallback: a column on the record naming a user who owns it when (or
  // as well as) the owner groups. Keyed per request because the field is a
  // property of the binding, and one state can be reached from several.
  const fallbackFieldByKey = new Map<string, string>()
  if (stateIds.length > 0) {
    const cacheable = database === db
    const stateCacheKey = [...stateIds].sort().join(',')
    let templateByState: Map<string, string>
    const metaHit = cacheable ? fallbackMetaCache.get(stateCacheKey) : undefined
    if (metaHit && Date.now() - metaHit.at < OWNER_GROUP_CACHE_TTL) {
      templateByState = metaHit.templateByState
    } else {
      const stateRows = (await selectInChunks(stateIds, 2000, (chunk) =>
        database('nivaro_workflow_states').whereIn('id', chunk).select('id', 'template')
      )) as Array<{ id: string; template: string }>
      templateByState = new Map(stateRows.map((r) => [String(r.id).toUpperCase(), r.template]))
      if (cacheable) fallbackMetaCache.set(stateCacheKey, { templateByState, at: Date.now() })
    }
    // `select('*')` rather than naming owner_fallback_field: an instance whose
    // database has not yet run migration 196 would otherwise throw "Invalid
    // column name" on EVERY owner resolution, taking down queues, panels and
    // notifications over a feature that is opt-in and null by default. Absent
    // column reads as undefined, which is exactly "no fallback configured".
    const collectionsKey = [...new Set(requests.map((r) => r.collection))].sort().join(',')
    let allBindings: Array<{
      collection: string
      template: string
      owner_fallback_field?: string | null
    }>
    const bindHit = cacheable ? bindingsCache.get(collectionsKey) : undefined
    if (bindHit && Date.now() - bindHit.at < OWNER_GROUP_CACHE_TTL) {
      allBindings = bindHit.rows
    } else {
      allBindings = (await database('nivaro_workflow_bindings')
        .whereIn('collection', [...new Set(requests.map((r) => r.collection))])
        .select('*')) as typeof allBindings
      if (cacheable) bindingsCache.set(collectionsKey, { rows: allBindings, at: Date.now() })
    }
    const bindingRows = allBindings.filter(
      (b): b is typeof b & { owner_fallback_field: string } =>
        typeof b.owner_fallback_field === 'string' && b.owner_fallback_field.trim() !== ''
    )
    if (bindingRows.length > 0) {
      const byCollectionTemplate = new Map(
        bindingRows.map((b) => [`${b.collection}::${String(b.template).toUpperCase()}`, b.owner_fallback_field])
      )
      for (const req of requests) {
        const template = templateByState.get(String(req.stateId).toUpperCase())
        if (!template) continue
        const field = byCollectionTemplate.get(`${req.collection}::${String(template).toUpperCase()}`)
        if (field) fallbackFieldByKey.set(req.key, field)
      }
    }
  }

  // Partition + parse each state's groups exactly once. Every record resolved
  // against a state sees the identical group set, so doing this per request
  // meant re-parsing the same filter JSON once per record (see
  // prepareOwnerGroups — this is the bulk of the cost on a large template).
  const preparedByState = new Map<string, PreparedOwnerGroups>()
  for (const stateId of new Set(withGroups.map((r) => r.stateId))) {
    preparedByState.set(
      stateId,
      groupData.get(stateId)?.prepared ?? prepareOwnerGroups(groupsByState.get(stateId) ?? [])
    )
  }

  // Dotted filter fields used by the groups each collection's requests can hit —
  // pre-resolved in batch so M2M and multi-hop M2O dimensions actually match.
  // Walked per (collection, state) pair rather than per request, for the same
  // reason: the answer cannot differ between two records of the same collection
  // sitting in the same state.
  const dottedFieldsByCollection = new Map<string, Set<string>>()
  const dottedSeen = new Set<string>()
  for (const req of withGroups) {
    let set = dottedFieldsByCollection.get(req.collection)
    if (!set) {
      set = new Set()
      dottedFieldsByCollection.set(req.collection, set)
    }
    const pairKey = `${req.collection}::${req.stateId}`
    if (dottedSeen.has(pairKey)) continue
    dottedSeen.add(pairKey)
    // Only `candidates` carry filters — a default group has none by definition,
    // and an unfiltered non-default group is already dropped as unmatchable.
    for (const { filters } of preparedByState.get(req.stateId)?.candidates ?? []) {
      for (const f of filters) {
        if (f.field.includes('.')) set.add(f.field)
      }
    }
  }

  const recordsByCollectionAndId = new Map<string, Map<string, Record<string, unknown>>>()
  const relationsByCollection = new Map<string, RelationInfo[]>()
  const resolvedByCollection = new Map<string, Map<string, Map<string, ResolvedFilterValue>>>()
  // A fallback field is read off the record, so those requests need their row
  // fetched even when their state has no owner groups at all.
  const needsRecord = requests.filter(
    (r) => (groupsByState.get(r.stateId) ?? []).length > 0 || fallbackFieldByKey.has(r.key)
  )
  // Columns each collection's rows are actually read for: plain filter
  // fields, the first segment of every dotted filter (the FK the prefix
  // lookup compares), and any owner-fallback field. The old `select('*')`
  // dragged the workflows table's hundred-plus columns (several nvarchar(max))
  // across a ~37ms-RTT link for every resolved record — most of the remaining
  // owner-resolution time was transfer, not matching.
  const neededColsByCollection = new Map<string, Set<string>>()
  const addCol = (collection: string, col: string) => {
    if (!col || col.includes('.')) return
    let set = neededColsByCollection.get(collection)
    if (!set) {
      set = new Set(['id'])
      neededColsByCollection.set(collection, set)
    }
    set.add(col)
  }
  for (const req of needsRecord) {
    for (const { filters } of preparedByState.get(req.stateId)?.candidates ?? []) {
      for (const f of filters) {
        if (f.field.includes('.')) {
          addCol(req.collection, f.field.split('.')[0])
          // lookup_compare-style record_field reads ride the same row
        } else {
          addCol(req.collection, f.field)
        }
      }
    }
    const fallback = fallbackFieldByKey.get(req.key)
    if (fallback) addCol(req.collection, fallback)
  }

  const collections = [...new Set(needsRecord.map((r) => r.collection))]
  for (const collection of collections) {
    const ids = [
      ...new Set(needsRecord.filter((r) => r.collection === collection).map((r) => r.itemId))
    ]
    const needed = neededColsByCollection.get(collection)
    let rows: Record<string, unknown>[] = []
    try {
      rows = await span('owners:records', () =>
        selectInChunks(ids, 2000, (chunk) =>
          database(collection)
            .whereIn('id', chunk)
            .select(needed ? [...needed] : '*')
        )
      )
    } catch {
      // A needed column that is actually an ALIAS (no physical column) throws —
      // fall back to the full row rather than resolving nobody.
      try {
        rows = await selectInChunks(ids, 2000, (chunk) =>
          database(collection).whereIn('id', chunk).select('*')
        )
      } catch {
        rows = []
      }
    }
    const byId = new Map<string, Record<string, unknown>>()
    for (const row of rows) byId.set(String(row.id), row)
    recordsByCollectionAndId.set(collection, byId)

    let relations: RelationInfo[] = []
    try {
      relations = (await database('nivaro_relations')
        .where({ many_collection: collection })
        .select('many_collection', 'many_field', 'one_collection')) as RelationInfo[]
    } catch {
      relations = []
    }
    relationsByCollection.set(collection, relations)

    const dotted = [...(dottedFieldsByCollection.get(collection) ?? [])]
    if (dotted.length > 0) {
      resolvedByCollection.set(
        collection,
        await span('owners:filter-values', () =>
          resolveFilterValues(collection, byId, dotted, database)
        )
      )
    }
  }

  const winningGroupsByKey = new Map<string, OwnerGroup[]>()
  const allGroupIds = new Set<string>()

  // Group matching is a pure function of the DIMENSION VALUES a record's
  // filters read, and hundreds of records share a handful of dimension
  // tuples (a 519-record workflows page collapses to a few dozen distinct
  // zone/region/project-type combinations). Memoize the winning-group pick
  // per (state, signature-of-those-values) — evaluating ~3,900 candidate
  // groups once per TUPLE instead of once per RECORD is most of the
  // remaining owner-resolution CPU. The signature captures exactly what
  // evalFilter reads per field: the batch-resolved ids/display sets when
  // present, else the FK prefix for dotted fields, else the record's own
  // column value.
  const sigValue = (
    field: string,
    record: Record<string, unknown>,
    relations: RelationInfo[],
    resolved: Map<string, ResolvedFilterValue> | undefined
  ): string => {
    const rv = resolved?.get(field)
    if (rv) {
      const ids = rv.ids instanceof Set ? [...rv.ids].sort().join(',') : String(rv.ids ?? '')
      const disp =
        rv.display instanceof Set ? [...rv.display].sort().join(',') : String(rv.display ?? '')
      return `${ids}\u0001${disp}`
    }
    if (field.includes('.')) {
      const prefix = field.split('.')[0]
      const rel = relations.find((r) => r.many_field === prefix)
      return String(rel ? (record[rel.many_field] ?? '') : '')
    }
    return String(record[field] ?? '')
  }

  const winningMemo = new Map<string, OwnerGroup[]>()
  for (const req of withGroups) {
    const prepared =
      preparedByState.get(req.stateId) ?? { candidates: [], defaults: [], filterFields: [] }
    const record = recordsByCollectionAndId.get(req.collection)?.get(req.itemId) ?? {}
    const relations = relationsByCollection.get(req.collection) ?? []
    const resolved = resolvedByCollection.get(req.collection)?.get(req.itemId)

    const sig =
      `${req.stateId}\u0000${req.collection}\u0000` +
      prepared.filterFields.map((f) => sigValue(f, record, relations, resolved)).join('\u0000')

    let winning = winningMemo.get(sig)
    if (!winning) {
      winning = pickWinningGroupsPrepared(prepared, record, relations, resolved)
      winningMemo.set(sig, winning)
    }
    winningGroupsByKey.set(req.key, winning)
    for (const g of winning) allGroupIds.add(g.id)
  }

  const groupUsersByGroup = new Map<string, ResolvedOwner[]>()
  if (allGroupIds.size > 0) {
    // Direct members ∪ TEAM members (nivaro_user_groups linked via
    // nivaro_pipeline_owner_group_teams) — teams edit in one place, every
    // cell they sit in follows. Deduped per group: a person can be a direct
    // member AND in a linked team.
    const [rows, teamRows] = await Promise.all([
      span('owners:group-users', () => selectInChunks([...allGroupIds], 2000, (chunk) =>
        database('nivaro_pipeline_owner_group_users as ogu')
          .join('nivaro_users as u', 'ogu.user', 'u.id')
          .whereIn('ogu.group', chunk)
          .select('ogu.group', 'u.id', 'u.email', 'u.first_name', 'u.last_name')
      )),
      span('owners:group-teams', () => selectInChunks([...allGroupIds], 2000, (chunk) =>
        database('nivaro_pipeline_owner_group_teams as ogt')
          .join('nivaro_user_group_members as m', 'm.group_id', 'ogt.team_id')
          .join('nivaro_users as u', 'm.user', 'u.id')
          .whereIn('ogt.group', chunk)
          .select('ogt.group', 'u.id', 'u.email', 'u.first_name', 'u.last_name')
      ))
    ])
    const seenByGroup = new Map<string, Set<string>>()
    for (const row of [...rows, ...teamRows] as Array<ResolvedOwner & { group: string }>) {
      const seen = seenByGroup.get(row.group) ?? new Set<string>()
      const uid = String(row.id).toUpperCase()
      if (seen.has(uid)) continue
      seen.add(uid)
      seenByGroup.set(row.group, seen)
      const list = groupUsersByGroup.get(row.group) ?? []
      list.push({
        id: row.id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name
      })
      groupUsersByGroup.set(row.group, list)
    }
  }

  const instanceIds = [
    ...new Set(requests.map((r) => r.instanceId).filter((id): id is string => !!id))
  ]
  const instanceOwnerRowsByInstance = new Map<
    string,
    Array<ResolvedOwner & { state: string | null }>
  >()
  if (instanceIds.length > 0) {
    const rows = await span('owners:instance-owners', () => selectInChunks(instanceIds, 2000, (chunk) =>
      database('nivaro_pipeline_instance_owners as io')
        .join('nivaro_users as u', 'io.user', 'u.id')
        .whereIn('io.instance', chunk)
        .select('io.instance', 'io.state', 'u.id', 'u.email', 'u.first_name', 'u.last_name')
    ))
    for (const row of rows as Array<ResolvedOwner & { instance: string; state: string | null }>) {
      const list = instanceOwnerRowsByInstance.get(row.instance) ?? []
      list.push({
        id: row.id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        state: row.state
      })
      instanceOwnerRowsByInstance.set(row.instance, list)
    }
  }

  function instanceOwnersFor(req: OwnerResolutionRequest): ResolvedOwner[] {
    if (!req.instanceId) return []
    const rows = instanceOwnerRowsByInstance.get(req.instanceId) ?? []
    return rows
      .filter((r) => r.state === req.stateId || r.state === null)
      .map((r) => ({ id: r.id, email: r.email, first_name: r.first_name, last_name: r.last_name }))
  }

  // Resolve every fallback user in one lookup. A field holding something that
  // isn't a live user id simply yields nobody — a misconfigured field name must
  // never break owner resolution for the records that do resolve normally.
  const fallbackIdByKey = new Map<string, string>()
  for (const req of requests) {
    const field = fallbackFieldByKey.get(req.key)
    if (!field) continue
    const value = recordsByCollectionAndId.get(req.collection)?.get(req.itemId)?.[field]
    if (typeof value === 'string' && value.trim() !== '') fallbackIdByKey.set(req.key, value)
  }
  const fallbackOwnerById = new Map<string, ResolvedOwner>()
  if (fallbackIdByKey.size > 0) {
    const rows = (await selectInChunks([...new Set(fallbackIdByKey.values())], 2000, (chunk) =>
      database('nivaro_users')
        .whereIn('id', chunk)
        .select('id', 'email', 'first_name', 'last_name')
    )) as ResolvedOwner[]
    for (const row of rows) fallbackOwnerById.set(String(row.id).toUpperCase(), row)
  }
  const fallbackOwnersFor = (req: OwnerResolutionRequest): ResolvedOwner[] => {
    const id = fallbackIdByKey.get(req.key)
    if (!id) return []
    const owner = fallbackOwnerById.get(id.toUpperCase())
    return owner ? [owner] : []
  }

  const combinedByKey = new Map<string, ResolvedOwner[]>()
  for (const req of withoutGroups) {
    combinedByKey.set(req.key, dedupeOwners([...instanceOwnersFor(req), ...fallbackOwnersFor(req)]))
  }
  for (const req of withGroups) {
    const winning = winningGroupsByKey.get(req.key) ?? []
    const baseOwners = winning.flatMap((g) => groupUsersByGroup.get(g.id) ?? [])
    combinedByKey.set(
      req.key,
      dedupeOwners([...baseOwners, ...instanceOwnersFor(req), ...fallbackOwnersFor(req)])
    )
  }

  // Delegation substitution only ever applied to withGroups requests — see the
  // pre-existing asymmetry documented on resolveStateOwners.
  const withGroupsKeys = new Set(withGroups.map((r) => r.key))
  const allOwnerIds = new Set<string>()
  for (const req of withGroups) {
    for (const o of combinedByKey.get(req.key) ?? []) allOwnerIds.add(o.id)
  }
  const substitutions = await buildDelegationSubstitutions([...allOwnerIds], database)

  for (const req of requests) {
    const owners = combinedByKey.get(req.key) ?? []
    if (withGroupsKeys.has(req.key)) {
      result.set(req.key, dedupeOwners(owners.map((o) => substitutions.get(o.id) ?? o)))
    } else {
      result.set(req.key, owners)
    }
  }

  return result
}

export async function resolveStateOwners(
  stateId: string,
  instanceId: string | null,
  collection: string,
  itemId: string,
  database: typeof db = db
): Promise<ResolvedOwner[]> {
  const result = await resolveStateOwnersBatch(
    [{ key: '_single', stateId, instanceId, collection, itemId }],
    database
  )
  return result.get('_single') ?? []
}

// ─── Skip criteria / auto-advance ─────────────────────────────────────────────

export async function evaluateSkipCriteria(
  stateId: string,
  record: Record<string, unknown>,
  instanceId: string | null,
  collection: string,
  itemId: string,
  database: typeof db = db
): Promise<boolean> {
  try {
    const state = await database<WorkflowState>('nivaro_workflow_states')
      .where({ id: stateId })
      .first()
    if (!state) return false

    const criteria = parseJson(state.skip_criteria) as SkipCriteria | null
    if (!criteria || !Array.isArray(criteria.conditions) || criteria.conditions.length === 0) {
      return false
    }

    const results: boolean[] = []
    for (const cond of criteria.conditions) {
      if (cond.type === 'no_owners') {
        const owners = await resolveStateOwners(stateId, instanceId, collection, itemId, database)
        results.push(owners.length === 0)
      } else if (cond.type === 'field_compare') {
        results.push(evalFilterOp(cond.op, record[cond.field], cond.value))
      } else if (cond.type === 'field_empty') {
        const v = record[cond.field]
        results.push(v == null || v === '')
      } else if (cond.type === 'field_nonempty') {
        const v = record[cond.field]
        results.push(v != null && v !== '')
      }
    }

    if (criteria.mode === 'any') return results.some(Boolean)
    return results.every(Boolean)
  } catch {
    return false
  }
}

export async function resolveTransitionTarget(
  toStateId: string,
  templateId: string,
  collection: string,
  itemId: string,
  instanceId: string | null,
  database: typeof db = db,
  depth = 0
): Promise<WorkflowState | null> {
  if (depth > 10) return null

  const state = await database<WorkflowState>('nivaro_workflow_states')
    .where({ id: toStateId })
    .first()
  if (!state) return null

  if (coerceBool(state.is_terminal) || coerceBool(state.is_initial)) return state

  // Rules read the subject record (an addendum's parent), never the
  // nivaro_addendums row — see pipeline-subject.ts.
  const subject = await resolvePipelineSubject(collection, itemId, database)
  const record = await fetchPipelineRecord(collection, itemId, database)

  const shouldSkip = await evaluateSkipCriteria(
    toStateId,
    record,
    instanceId,
    subject.collection,
    subject.itemId,
    database
  )

  if (!shouldSkip) return state

  const nextTransition = await database<WorkflowTransition>('nivaro_workflow_transitions')
    .where({ template: templateId, from_state: toStateId })
    .whereNot({ to_state: toStateId })
    .orderBy('sort')
    .first()

  if (!nextTransition) return state

  return resolveTransitionTarget(
    nextTransition.to_state,
    templateId,
    collection,
    itemId,
    instanceId,
    database,
    depth + 1
  )
}

// ─── Full instance query helpers ───────────────────────────────────────────────

export async function buildInstancePayload(
  instance: WorkflowInstance,
  userRoleId: string | null | undefined,
  isAdmin: boolean,
  database: typeof db = db
) {
  const [states, allTransitions, history] = await Promise.all([
    database<WorkflowState>('nivaro_workflow_states')
      .where({ template: instance.template })
      .orderBy('sort'),
    database<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template: instance.template })
      .orderBy('sort'),
    database('nivaro_workflow_history as h')
      .leftJoin('nivaro_users as u', 'h.user', 'u.id')
      .leftJoin('nivaro_workflow_states as fs', 'h.from_state', 'fs.id')
      .leftJoin('nivaro_workflow_states as ts', 'h.to_state', 'ts.id')
      .where('h.instance', instance.id)
      .orderBy('h.timestamp', 'asc')
      .select(
        'h.id',
        'h.transition',
        'h.comment',
        'h.timestamp',
        'u.id as user_id',
        'u.email as user_email',
        'u.first_name as user_first_name',
        'u.last_name as user_last_name',
        'fs.id as from_state_id',
        'fs.key as from_state_key',
        'fs.label as from_state_label',
        'fs.color as from_state_color',
        'fs.is_initial as from_state_is_initial',
        'fs.is_terminal as from_state_is_terminal',
        'fs.lock_record as from_state_lock_record',
        'fs.sort as from_state_sort',
        'ts.id as to_state_id',
        'ts.key as to_state_key',
        'ts.label as to_state_label',
        'ts.color as to_state_color',
        'ts.is_initial as to_state_is_initial',
        'ts.is_terminal as to_state_is_terminal',
        'ts.lock_record as to_state_lock_record',
        'ts.sort as to_state_sort'
      )
  ])

  const currentState = states.find((s) => s.id === instance.current_state)

  const availableTransitions = allTransitions.filter((t) => {
    if (t.from_state !== null && t.from_state !== instance.current_state) return false
    if (isAdmin) return true
    const roles = parseJson(t.required_roles) as string[] | null
    if (!roles || roles.length === 0) return true
    return userRoleId != null && roles.includes(userRoleId)
  })

  const formattedHistory = history.map((h) => ({
    id: h.id,
    transition: h.transition,
    fromState: h.from_state_id
      ? {
          id: h.from_state_id,
          key: h.from_state_key,
          label: h.from_state_label,
          color: h.from_state_color,
          isInitial: coerceBool(h.from_state_is_initial),
          isTerminal: coerceBool(h.from_state_is_terminal),
          lockRecord: coerceBool(h.from_state_lock_record),
          sort: h.from_state_sort ?? 0,
          skipCriteria: null
        }
      : null,
    toState: {
      id: h.to_state_id,
      key: h.to_state_key,
      label: h.to_state_label,
      color: h.to_state_color,
      isInitial: coerceBool(h.to_state_is_initial),
      isTerminal: coerceBool(h.to_state_is_terminal),
      lockRecord: coerceBool(h.to_state_lock_record),
      sort: h.to_state_sort ?? 0,
      skipCriteria: null
    },
    user: h.user_id
      ? {
          id: h.user_id,
          email: h.user_email,
          firstName: h.user_first_name,
          lastName: h.user_last_name
        }
      : null,
    comment: h.comment,
    timestamp: h.timestamp
  }))

  return {
    id: instance.id,
    collection: instance.collection,
    item: instance.item,
    currentState: currentState ? gqlState(currentState) : null,
    startedAt: instance.started_at,
    completedAt: instance.completed_at,
    history: formattedHistory,
    availableTransitions: availableTransitions.map((t) => ({
      id: t.id,
      fromState: t.from_state,
      toState: t.to_state,
      label: t.label,
      color: t.color,
      requiredRoles: parseJson(t.required_roles) as string[] | null,
      actions: parseJson(t.actions) as unknown[] | null,
      sort: t.sort
    }))
  }
}

// ─── GQL shape formatters ─────────────────────────────────────────────────────

export function gqlState(s: WorkflowState) {
  return {
    id: s.id,
    key: s.key,
    label: s.label,
    color: s.color,
    isInitial: coerceBool(s.is_initial),
    isTerminal: coerceBool(s.is_terminal),
    lockRecord: coerceBool(s.lock_record),
    sort: s.sort,
    skipCriteria: parseJson(s.skip_criteria),
    ownerGroups: []
  }
}

export function gqlUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    status: row.status,
    lastAccess: row.last_access,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Owner-gap advisor ───────────────────────────────────────────────────────

export interface OwnerGapCluster {
  state_id: string
  state_key: string | null
  collection: string
  count: number
  sample_items: string[]
  /** dotted filter field → the records' resolved display value(s). */
  dims: Record<string, string>
  /** Ready-to-save owner-group filters for this combination — what a
   *  "create a group for this cluster" remediation should POST verbatim. */
  filters: Array<{ field: string; op: 'eq'; value: string; id_value: number | null }>
  suggestion: {
    group_id: string | null
    group_label: string | null
    matched_filters: string[]
    mismatched_filters: string[]
  } | null
}

/**
 * Why records resolve NO owners, and the closest repair. Unowned records are
 * clustered by their resolved dimension values; per cluster, the candidate
 * owner group with the FEWEST failing filters is suggested ("extend group G —
 * it matches on zone and region but not project type"). Coverage Gaps names
 * the problem; this proposes the fix. Uses the exact evaluation the live
 * resolver uses, so a suggestion that says "would match" actually would.
 */
/**
 * Owner-matrix impact preview (#87): how many LIVE records a proposed cell
 * (state + filter set) would govern, before saving it. Matching runs through
 * the same prepare/pick machinery real resolution uses — a synthetic group
 * carrying the proposed filters is offered alongside no competitors, so
 * "matches" means exactly what it will mean at runtime.
 */
export interface OwnerImpactPreview {
  state_key: string
  matched: number
  total_in_state: number
  sample: Array<{ item: string; label: string }>
}
export async function previewOwnerGroupImpact(
  templateId: string,
  stateId: string,
  filters: unknown
): Promise<OwnerImpactPreview> {
  const state = (await db('nivaro_workflow_states')
    .where({ id: stateId, template: templateId })
    .first('id', 'key')) as { id: string; key: string } | undefined
  if (!state) throw Object.assign(new Error('State not found'), { statusCode: 404 })

  const synthetic: OwnerGroup = {
    id: 'synthetic',
    template: templateId,
    state: stateId,
    name: 'preview',
    filters: JSON.stringify(filters ?? []),
    sort: 0,
    is_default: false,
    priority: 0,
    max_wip: null
  }
  const prepared = prepareOwnerGroups([synthetic])

  const instances = (await db('nivaro_workflow_instances')
    .where({ template: templateId, current_state: stateId })
    .whereNull('completed_at')
    .select('collection', 'item')
    .limit(2000)) as Array<{ collection: string; item: string }>
  if (instances.length === 0)
    return { state_key: state.key, matched: 0, total_in_state: 0, sample: [] }

  const byCollection = new Map<string, string[]>()
  for (const i of instances) {
    byCollection.set(i.collection, [...(byCollection.get(i.collection) ?? []), String(i.item)])
  }

  let matched = 0
  const sample: Array<{ item: string; label: string }> = []
  for (const [collection, items] of byCollection) {
    const rows = (await db(collection).whereIn('id', items.slice(0, 1000)).select('*')) as Array<
      Record<string, unknown>
    >
    const records = new Map(rows.map((r) => [String(r.id), r]))
    const relations = (await db('nivaro_relations')
      .where({ many_collection: collection })
      .select('many_collection', 'many_field', 'one_collection')
      .catch(() => [])) as RelationInfo[]
    const resolved = await resolveFilterValues(collection, records, prepared.filterFields, db)
    for (const [id, record] of records) {
      const winners = pickWinningGroupsPrepared(prepared, record, relations, resolved.get(id))
      if (winners.some((g) => g.id === 'synthetic')) {
        matched++
        if (sample.length < 10) {
          sample.push({
            item: id,
            label: String(
              record.workflow_id ?? record.name ?? record.title ?? record.label ?? id
            )
          })
        }
      }
    }
  }
  return { state_key: state.key, matched, total_in_state: instances.length, sample }
}

export async function analyzeOwnerGaps(templateId: string): Promise<OwnerGapCluster[]> {
  const bindings = (await db('nivaro_workflow_bindings')
    .where({ template: templateId })
    .select('collection')) as Array<{ collection: string }>
  const states = (await db('nivaro_workflow_states')
    .where({ template: templateId })
    .select('id', 'key', 'owners_not_required')) as Array<{
    id: string
    key: string
    owners_not_required?: boolean | number
  }>
  const keyByState = new Map(states.map((st) => [String(st.id).toUpperCase(), st.key]))
  // States flagged owners-not-required (Started, Completed…) are not gaps —
  // nobody is SUPPOSED to own records parked there.
  const noOwnerStates = new Set(
    states
      .filter((st) => st.owners_not_required === true || st.owners_not_required === 1)
      .map((st) => String(st.id).toUpperCase())
  )

  const clusters = new Map<string, OwnerGapCluster>()
  for (const b of bindings) {
    const allInstances = (await db('nivaro_workflow_instances')
      .where({ template: templateId, collection: b.collection })
      .whereNull('completed_at')
      .whereNotNull('current_state')
      .select('id', 'item', 'current_state')) as Array<{
      id: string
      item: string
      current_state: string
    }>
    const instances = allInstances.filter(
      (i) => !noOwnerStates.has(String(i.current_state).toUpperCase())
    )
    if (instances.length === 0) continue

    const requests: OwnerResolutionRequest[] = instances.map((i) => ({
      key: String(i.item),
      stateId: String(i.current_state),
      instanceId: String(i.id),
      collection: b.collection,
      itemId: String(i.item)
    }))
    const owners = await resolveStateOwnersBatch(requests)
    const unowned = instances.filter((i) => (owners.get(String(i.item)) ?? []).length === 0)
    if (unowned.length === 0) continue

    // Per state: prepared groups + the records' resolved filter values.
    const byState = new Map<string, typeof unowned>()
    for (const u of unowned) {
      const sid = String(u.current_state)
      byState.set(sid, [...(byState.get(sid) ?? []), u])
    }
    const groupData = await getOwnerGroupsForStates([...byState.keys()], db)

    for (const [sid, insts] of byState) {
      const prepared = groupData.get(sid)?.prepared
      const fields = prepared?.filterFields ?? []
      const items = insts.map((i) => String(i.item)).slice(0, 500)
      const rows = (await db(b.collection).whereIn('id', items).select('*')) as Array<
        Record<string, unknown>
      >
      const records = new Map(rows.map((r) => [String(r.id), r]))
      const resolved = await resolveFilterValues(b.collection, records, fields, db)

      const displayOf = (v: ResolvedFilterValue | undefined): string => {
        if (!v) return ''
        const d = v.display instanceof Set ? [...v.display] : v.display != null ? [v.display] : []
        return d.map(String).sort().join(', ')
      }

      const firstOf = (v: unknown): unknown => {
        if (v instanceof Set) {
          const arr = [...v]
          return arr.length > 0 ? arr.sort()[0] : null
        }
        return v ?? null
      }

      for (const inst of insts) {
        const item = String(inst.item)
        const rv = resolved.get(item)
        const dims: Record<string, string> = {}
        for (const f of fields) dims[f] = displayOf(rv?.get(f)) || String(records.get(item)?.[f] ?? '')
        const clusterKey = `${sid}|${b.collection}|${JSON.stringify(dims)}`
        let cluster = clusters.get(clusterKey)
        if (!cluster) {
          // Closest group: fewest failing filters, at least one passing.
          let bestSuggestion: OwnerGapCluster['suggestion'] = null
          for (const { group, filters } of prepared?.candidates ?? []) {
            const matched: string[] = []
            const mismatched: string[] = []
            for (const f of filters) {
              const r = rv?.get(f.field)
              const ok = r
                ? f.id_value != null
                  ? evalAgainstResolved(f.op, r.ids, f.id_value)
                  : evalAgainstResolved(f.op, r.display, f.value)
                : evalFilterOp(f.op, records.get(item)?.[f.field], f.id_value ?? f.value)
              if (ok) matched.push(f.field)
              else mismatched.push(`${f.field} (wants ${String(f.id_value ?? f.value)})`)
            }
            if (matched.length === 0) continue
            if (
              !bestSuggestion ||
              mismatched.length < bestSuggestion.mismatched_filters.length ||
              (mismatched.length === bestSuggestion.mismatched_filters.length &&
                matched.length > bestSuggestion.matched_filters.length)
            ) {
              bestSuggestion = {
                group_id: String(group.id),
                group_label:
                  ((group as { name?: string | null }).name ?? '').trim() ||
                  // Unnamed group (legacy sync left a few): describe it by its
                  // own filter values rather than showing a uuid.
                  filters.map((f) => String(f.value)).join(' · ') ||
                  String(group.id),
                matched_filters: matched,
                mismatched_filters: mismatched
              }
            }
          }
          // Filters a remediation group would need: one eq per dimension the
          // records actually resolved a value for (first id when multi-valued
          // — Set membership makes a single-id eq still match those records).
          const clusterFilters: OwnerGapCluster['filters'] = []
          for (const f of fields) {
            const r = rv?.get(f)
            const display = dims[f]
            if (!display) continue
            const rawId = r ? firstOf(r.ids) : null
            const idNum = rawId != null && !Number.isNaN(Number(rawId)) ? Number(rawId) : null
            clusterFilters.push({
              field: f,
              op: 'eq',
              value: display.split(', ')[0],
              id_value: idNum
            })
          }
          cluster = {
            state_id: sid,
            state_key: keyByState.get(sid.toUpperCase()) ?? null,
            collection: b.collection,
            count: 0,
            sample_items: [],
            dims,
            filters: clusterFilters,
            suggestion: bestSuggestion
          }
          clusters.set(clusterKey, cluster)
        }
        cluster.count++
        if (cluster.sample_items.length < 5) cluster.sample_items.push(item)
      }
    }
  }
  return [...clusters.values()].sort((a, z) => z.count - a.count).slice(0, 50)
}
