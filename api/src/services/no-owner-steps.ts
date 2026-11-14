/**
 * Steps with no owner (Rob 2026-11-13) — open records sitting on a pipeline
 * step that has owner-only moves (`require_owner` transitions out of it) while
 * NOBODY is assigned to own that step on the record: no owner group matches
 * it, no instance owner was set. The binding's fallback user (the creator on
 * inventory requests) still shows them "in their queue", but owner-only moves
 * judge ASSIGNED owners only (record-access checkTransitionOwner →
 * canActOn {assignedOwnersOnly}), so only an administrator can move them.
 * Production 2026-11-13: ~468 inventory requests in Warehouse Submission —
 * the creator of FDX25INV-37713 saw only Send Back and Cancel.
 *
 * One owner algorithm: owners resolve through resolveStateOwnersBatch with
 * {skipFallback} — exactly what the owner-only gate asks — and the records are
 * grouped by their dimension values with the owner-gap advisor's own
 * clustering (pipeline-engine clusterOwnerGapRecords) and words
 * (owner-gap-explain explainOwnerGapClusters: which values no group names).
 *
 * Which moves count: a manual `require_owner` move WITHOUT allow_creator (the
 * creator can still make an owner-or-creator move, so that step is not stuck)
 * from the record's state (or from any state), whose condition rules match the
 * record. Terminal and owners-not-required steps never count.
 *
 * Cost: one shared answer per tenant (single flight through the heavy-read
 * gate, kept 2 minutes), then each administrator's view keeps only records
 * they may read (compileAccessGates {actingAdmin} — restrict User Scopes bind
 * admins too) and labels a small sample.
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { personName } from './access-words.js'
import { tenantState } from './ai-tenant-state.js'
import { getPhysicalColumns } from './collections.js'
import { selectInChunks } from './db-batch.js'
import {
  clusterOwnerGapRecords,
  type OwnerGapCluster,
  type OwnerResolutionRequest,
  type ResolvedOwner,
  resolveStateOwnersBatch
} from './pipeline-engine.js'
import { ADDENDUM_COLLECTION } from './pipeline-subject.js'
import { sharedGatedRead } from './read-gate.js'
import { compileAccessGates, recordCreators, visibleIds } from './record-access.js'
import {
  evaluateConditionRules,
  fetchRecordForConditions,
  parseConditionRules
} from './workflow-conditions.js'

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface NoOwnerStateRow {
  id: string
  template: string
  key: string
  label: string
  is_terminal?: boolean | number | null
  owners_not_required?: boolean | number | null
}

export interface NoOwnerMoveRow {
  id: string
  template: string
  from_state: string | null
  label: string
  allow_creator?: boolean | number | null
  auto_trigger?: boolean | number | null
  condition_rules?: string | null
}

export interface NoOwnerInstanceRow {
  id: string
  template: string
  collection: string
  item: string
  current_state: string
  started_at?: Date | string | null
}

export interface OwnerOnlyMove {
  id: string
  label: string
  /** The record's creator may make it too (still listed, never the reason a step counts). */
  allow_creator: boolean
  /** Has condition rules — it applies to some records of the step only. */
  conditional: boolean
}

export interface NoOwnerDim {
  field: string
  label: string
  value: string
}

export interface NoOwnerClusterOut {
  key: string
  count: number
  /** The records' values on the step's owner-group dimensions. */
  dims: NoOwnerDim[]
  /** Values no owner group of the step names — the group to create. */
  uncovered: NoOwnerDim[]
  reason: string
  suggestion: { group_label: string | null; missing_labels: string[] } | null
}

interface SharedRecord {
  item: string
  instance: string
  started_at: string | null
  cluster: string | null
}

interface SharedGroup {
  template_id: string
  template_name: string
  state_id: string
  state_key: string
  state_label: string
  collection: string
  collection_label: string
  moves: OwnerOnlyMove[]
  records: SharedRecord[]
  clusters: Array<Omit<NoOwnerClusterOut, 'count'>>
  /** Records whose move conditions could not be checked (counted anyway). */
  conditions_unchecked: number
}

export interface NoOwnerShared {
  computed_at: string
  /** Open records sitting on a step with owner-only moves. */
  checked: number
  groups: SharedGroup[]
}

export interface NoOwnerSampleRecord {
  item: string
  label: string
  creator: { id: string; name: string } | null
  /** Who has it in their queue without owning the step (the binding's fallback). */
  stand_in: string[]
  /** When the record entered this step (else when its pipeline started). */
  since: string | null
  cluster: string | null
}

export interface NoOwnerGroupOut extends Omit<SharedGroup, 'records' | 'clusters'> {
  count: number
  clusters: NoOwnerClusterOut[]
  /** Records not grouped by value (past the per-step read cap). */
  ungrouped: number
  sample: NoOwnerSampleRecord[]
  /** Owner matrix of this pipeline (admin path). */
  matrix_href: string
}

export interface NoOwnerReport {
  computed_at: string
  checked: number
  total: number
  groups: NoOwnerGroupOut[]
}

const on = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
const up = (v: unknown) => String(v ?? '').toUpperCase()

// ── Pure steps ──────────────────────────────────────────────────────────────

/**
 * The steps that count, keyed by upper-cased state id: a non-terminal step
 * that needs owners and has at least one manual owner-only move WITHOUT
 * allow_creator out of it (`from_state` = the step, or null = any step).
 * `moves` lists every owner-only move from the step (for the page),
 * `blocking` the ones that make it count (their conditions decide records).
 */
export function ownerOnlySteps(
  states: NoOwnerStateRow[],
  moves: NoOwnerMoveRow[]
): Map<string, { state: NoOwnerStateRow; moves: OwnerOnlyMove[]; blocking: NoOwnerMoveRow[] }> {
  const out = new Map<
    string,
    { state: NoOwnerStateRow; moves: OwnerOnlyMove[]; blocking: NoOwnerMoveRow[] }
  >()
  const manual = moves.filter((m) => !on(m.auto_trigger))
  for (const s of states) {
    if (on(s.is_terminal) || on(s.owners_not_required)) continue
    const from = manual.filter(
      (m) =>
        up(m.template) === up(s.template) && (m.from_state == null || up(m.from_state) === up(s.id))
    )
    const blocking = from.filter((m) => !on(m.allow_creator))
    if (blocking.length === 0) continue
    // Same-named moves (three "Send Back"s to different steps) list once.
    const listed = new Map<string, OwnerOnlyMove>()
    for (const m of from) {
      const move = {
        id: String(m.id),
        label: m.label,
        allow_creator: on(m.allow_creator),
        conditional: (parseConditionRules(m.condition_rules ?? null) ?? []).length > 0
      }
      const k = `${move.label.trim().toLowerCase()}|${move.allow_creator}|${move.conditional}`
      if (!listed.has(k)) listed.set(k, move)
    }
    out.set(up(s.id), { state: s, blocking, moves: [...listed.values()] })
  }
  return out
}

/** Instances (keyed by instance id in `owners`) with no ASSIGNED owner at all. */
export function withNoAssignedOwner<T extends { id: string }>(
  instances: T[],
  owners: Map<string, ResolvedOwner[]>
): T[] {
  return instances.filter((i) => (owners.get(String(i.id)) ?? []).length === 0)
}

/** Does any blocking move apply to this record (a move with no conditions applies to all)? */
export function blockingMoveApplies(
  blocking: Array<Pick<NoOwnerMoveRow, 'condition_rules'>>,
  record: Record<string, unknown>
): boolean {
  return blocking.some((m) => evaluateConditionRules(m.condition_rules ?? null, record))
}

/** Every blocking move has conditions — records must be read to know. */
export function needsConditionCheck(
  blocking: Array<Pick<NoOwnerMoveRow, 'condition_rules'>>
): boolean {
  return blocking.every((m) => (parseConditionRules(m.condition_rules ?? null) ?? []).length > 0)
}

/**
 * One administrator's view of the shared answer: only `visible` records
 * (per collection; a missing set = none visible), counts recomputed per
 * cluster, the first `sample` records (oldest first) left for labelling.
 */
export function viewGroups(
  shared: NoOwnerShared,
  visible: Map<string, Set<string>>,
  sample = 10
): Array<NoOwnerGroupOut & { sampleRecords: SharedRecord[] }> {
  const out: Array<NoOwnerGroupOut & { sampleRecords: SharedRecord[] }> = []
  for (const g of shared.groups) {
    const seen = visible.get(g.collection)
    const records = g.records.filter((r) => seen?.has(String(r.item)))
    if (records.length === 0) continue
    const perCluster = new Map<string, number>()
    let ungrouped = 0
    for (const r of records) {
      if (r.cluster) perCluster.set(r.cluster, (perCluster.get(r.cluster) ?? 0) + 1)
      else ungrouped++
    }
    const clusters = g.clusters
      .map((c) => ({ ...c, count: perCluster.get(c.key) ?? 0 }))
      .filter((c) => c.count > 0)
      .sort((a, z) => z.count - a.count)
    const { records: _r, clusters: _c, ...rest } = g
    out.push({
      ...rest,
      count: records.length,
      clusters,
      ungrouped,
      sample: [],
      sampleRecords: records.slice(0, sample),
      matrix_href: `/pipelines/${g.template_id}#owner-matrix`
    })
  }
  return out.sort((a, z) => z.count - a.count)
}

// ── Reads (injectable for tests) ────────────────────────────────────────────

export interface NoOwnerDeps {
  loadMoves(): Promise<NoOwnerMoveRow[]>
  loadStates(templateIds: string[]): Promise<NoOwnerStateRow[]>
  loadInstances(stateIds: string[]): Promise<NoOwnerInstanceRow[]>
  /** ASSIGNED owners per request key (no fallback user) — the owner-only gate's answer. */
  resolveAssigned(requests: OwnerResolutionRequest[]): Promise<Map<string, ResolvedOwner[]>>
  /** Records for a condition check: rows by id + ids that could not be read. */
  conditionRecords(
    collection: string,
    items: string[],
    ruleSets: Array<string | null | undefined>
  ): Promise<{ rows: Map<string, Record<string, unknown>>; unchecked: string[] }>
  /** The advisor's clusters (explained) for one pipeline + collection. */
  cluster(
    templateId: string,
    collection: string,
    records: Array<{ item: string; current_state: string }>,
    keyByState: Map<string, string>
  ): Promise<{
    clusters: Array<Omit<NoOwnerClusterOut, 'count'> & { state_id: string }>
    clusterOf: Map<string, string>
  }>
  names(
    templateIds: string[],
    collections: string[]
  ): Promise<{ templates: Map<string, string>; collections: Map<string, string> }>
}

const RESOLVE_CHUNK = 2000
const CLUSTER_CAP = 3000
const PER_RECORD_CONDITION_CAP = 1000
const CONDITION_READS_AT_ONCE = 8

export const realDeps: NoOwnerDeps = {
  async loadMoves() {
    if (!(await hasColumn('nivaro_workflow_transitions', 'require_owner'))) return []
    const creator = await hasColumn('nivaro_workflow_transitions', 'allow_creator')
    return (await db('nivaro_workflow_transitions')
      .where('require_owner', 1)
      .select(
        'id',
        'template',
        'from_state',
        'label',
        'auto_trigger',
        'condition_rules',
        ...(creator ? ['allow_creator'] : [])
      )) as NoOwnerMoveRow[]
  },
  async loadStates(templateIds) {
    return (await selectInChunks(templateIds, 1000, (chunk) =>
      db('nivaro_workflow_states')
        .whereIn('template', chunk)
        .select('id', 'template', 'key', 'label', 'is_terminal', 'owners_not_required')
    )) as NoOwnerStateRow[]
  },
  async loadInstances(stateIds) {
    return (await selectInChunks(stateIds, 1000, (chunk) =>
      db('nivaro_workflow_instances')
        .whereNull('completed_at')
        .whereIn('current_state', chunk)
        .select('id', 'template', 'collection', 'item', 'current_state', 'started_at')
    )) as NoOwnerInstanceRow[]
  },
  async resolveAssigned(requests) {
    const out = new Map<string, ResolvedOwner[]>()
    for (let i = 0; i < requests.length; i += RESOLVE_CHUNK) {
      const part = await resolveStateOwnersBatch(requests.slice(i, i + RESOLVE_CHUNK), db, {
        skipFallback: true
      })
      for (const [k, v] of part) out.set(k, v)
    }
    return out
  },
  async conditionRecords(collection, items, ruleSets) {
    const rows = new Map<string, Record<string, unknown>>()
    const fields = [
      ...new Set(
        ruleSets.flatMap((raw) =>
          (parseConditionRules(raw ?? null) ?? [])
            .map((r) => (typeof r?.field === 'string' ? r.field : ''))
            .filter(Boolean)
        )
      )
    ]
    const perRecord =
      collection === ADDENDUM_COLLECTION || fields.some((f) => f.includes('.') || f.includes(':'))
    if (!perRecord) {
      // Plain columns only: one narrow read for every record.
      const physical = await getPhysicalColumns(collection)
      const cols = ['id', ...fields.filter((f) => physical?.has(f.toLowerCase()))]
      try {
        const read = (await selectInChunks(items, 1000, (chunk) =>
          db(collection).whereIn('id', chunk).select(cols)
        )) as Array<Record<string, unknown>>
        for (const r of read) rows.set(String(r.id), r)
        return { rows, unchecked: [] }
      } catch {
        return { rows, unchecked: items }
      }
    }
    // Related / dotted rules: the transition path's own reader, per record,
    // a few at a time, up to a cap — the rest are counted, unchecked.
    const checked = items.slice(0, PER_RECORD_CONDITION_CAP)
    const unchecked = items.slice(PER_RECORD_CONDITION_CAP)
    for (let i = 0; i < checked.length; i += CONDITION_READS_AT_ONCE) {
      await Promise.all(
        checked.slice(i, i + CONDITION_READS_AT_ONCE).map(async (id) => {
          try {
            rows.set(id, await fetchRecordForConditions(collection, id, ruleSets, { strict: true }))
          } catch {
            unchecked.push(id)
          }
        })
      )
    }
    return { rows, unchecked }
  },
  async cluster(templateId, collection, records, keyByState) {
    const clusters = new Map<string, OwnerGapCluster>()
    const clusterOf = new Map<string, string>()
    await clusterOwnerGapRecords(collection, records, keyByState, clusters, {
      perStateCap: CLUSTER_CAP,
      clusterOf
    })
    const keys = [...clusters.keys()]
    const list = keys.map((k) => clusters.get(k) as OwnerGapCluster)
    const { explainOwnerGapClusters } = await import('./owner-gap-explain.js')
    const explained = await explainOwnerGapClusters(templateId, list).catch(() => null)
    const { dimensionLabels } = await import('./owner-explain.js')
    const labels = await dimensionLabels(templateId).catch(() => new Map<string, string>())
    const { fieldLabel } = await import('./access-words.js')
    return {
      clusterOf,
      clusters: list.map((c, i) => {
        const e = explained?.[i]
        return {
          key: keys[i],
          state_id: String(c.state_id),
          dims: Object.entries(c.dims)
            .filter(([, v]) => !!v)
            .map(([field, value]) => ({ field, label: fieldLabel(field, labels), value })),
          uncovered: e?.uncovered ?? [],
          reason: e?.reason ?? '',
          suggestion: e?.suggestion
            ? {
                group_label: e.suggestion.group_label,
                missing_labels: (e.suggestion as { missing_labels?: string[] }).missing_labels ?? []
              }
            : null
        }
      })
    }
  },
  async names(templateIds, collections) {
    const [t, c] = await Promise.all([
      selectInChunks(templateIds, 1000, (chunk) =>
        db('nivaro_workflow_templates').whereIn('id', chunk).select('id', 'name')
      ).catch(() => []) as Promise<Array<{ id: string; name: string | null }>>,
      selectInChunks(collections, 1000, (chunk) =>
        db('nivaro_collections').whereIn('collection', chunk).select('collection', 'display_name')
      ).catch(() => []) as Promise<Array<{ collection: string; display_name: string | null }>>
    ])
    return {
      templates: new Map(t.map((r) => [up(r.id), String(r.name ?? '').trim() || 'Pipeline'])),
      collections: new Map(
        c.map((r) => [r.collection, String(r.display_name ?? '').trim() || r.collection])
      )
    }
  }
}

// ── The shared answer ───────────────────────────────────────────────────────

const iso = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export async function computeNoOwnerSteps(deps: NoOwnerDeps = realDeps): Promise<NoOwnerShared> {
  const computed_at = new Date().toISOString()
  const moves = await deps.loadMoves()
  if (moves.length === 0) return { computed_at, checked: 0, groups: [] }
  const templateIds = [...new Set(moves.map((m) => String(m.template)))]
  const states = await deps.loadStates(templateIds)
  const steps = ownerOnlySteps(states, moves)
  if (steps.size === 0) return { computed_at, checked: 0, groups: [] }

  const instances = (await deps.loadInstances([...steps.values()].map((s) => s.state.id))).filter(
    (i) => steps.has(up(i.current_state))
  )
  const owners = await deps.resolveAssigned(
    instances.map((i) => ({
      key: String(i.id),
      stateId: String(i.current_state),
      instanceId: String(i.id),
      collection: i.collection,
      itemId: String(i.item)
    }))
  )
  const unowned = withNoAssignedOwner(instances, owners)

  // Per step + collection, keep the records a blocking move applies to.
  const byGroup = new Map<string, NoOwnerInstanceRow[]>()
  for (const i of unowned) {
    const k = `${up(i.current_state)}|${i.collection}`
    byGroup.set(k, [...(byGroup.get(k) ?? []), i])
  }
  const kept = new Map<string, { rows: NoOwnerInstanceRow[]; unchecked: number }>()
  for (const [k, rows] of byGroup) {
    const step = steps.get(k.split('|')[0])
    if (!step) continue
    if (!needsConditionCheck(step.blocking)) {
      kept.set(k, { rows, unchecked: 0 })
      continue
    }
    const collection = rows[0].collection
    const read = await deps.conditionRecords(
      collection,
      rows.map((r) => String(r.item)),
      step.blocking.map((m) => m.condition_rules)
    )
    const unchecked = new Set(read.unchecked)
    const applies = rows.filter((r) => {
      const id = String(r.item)
      if (unchecked.has(id)) return true
      const rec = read.rows.get(id)
      return rec ? blockingMoveApplies(step.blocking, rec) : false
    })
    if (applies.length) kept.set(k, { rows: applies, unchecked: unchecked.size })
  }
  if (kept.size === 0) return { computed_at, checked: instances.length, groups: [] }

  // Group values: the advisor's clustering per pipeline + collection.
  const keyByState = new Map([...steps.entries()].map(([id, s]) => [id, s.state.key]))
  const perTemplateCollection = new Map<string, Array<{ item: string; current_state: string }>>()
  for (const { rows } of kept.values())
    for (const r of rows) {
      const k = `${up(r.template)}|${r.collection}`
      perTemplateCollection.set(k, [
        ...(perTemplateCollection.get(k) ?? []),
        { item: String(r.item), current_state: String(r.current_state) }
      ])
    }
  const clustered = new Map<string, Awaited<ReturnType<NoOwnerDeps['cluster']>>>()
  for (const [k, recs] of perTemplateCollection) {
    const collection = k.slice(k.indexOf('|') + 1)
    const templateId = String(
      steps.get(up(recs[0].current_state))?.state.template ?? k.slice(0, k.indexOf('|'))
    )
    clustered.set(
      k,
      await deps
        .cluster(templateId, collection, recs, keyByState)
        .catch(() => ({ clusters: [], clusterOf: new Map<string, string>() }))
    )
  }

  const names = await deps.names(templateIds, [
    ...new Set([...kept.values()].flatMap((v) => v.rows.map((r) => r.collection)))
  ])

  const groups: SharedGroup[] = []
  for (const [k, { rows, unchecked }] of kept) {
    const step = steps.get(k.split('|')[0])
    if (!step) continue
    const collection = rows[0].collection
    const tc = clustered.get(`${up(rows[0].template)}|${collection}`)
    const sorted = [...rows].sort((a, z) =>
      String(iso(a.started_at) ?? '').localeCompare(String(iso(z.started_at) ?? ''))
    )
    groups.push({
      template_id: String(step.state.template),
      template_name: names.templates.get(up(step.state.template)) ?? 'Pipeline',
      state_id: String(step.state.id),
      state_key: step.state.key,
      state_label: step.state.label,
      collection,
      collection_label: names.collections.get(collection) ?? collection,
      moves: step.moves,
      records: sorted.map((r) => ({
        item: String(r.item),
        instance: String(r.id),
        started_at: iso(r.started_at),
        cluster: tc?.clusterOf.get(String(r.item)) ?? null
      })),
      clusters: (tc?.clusters ?? [])
        .filter((c) => up(c.state_id) === up(step.state.id))
        .map(({ state_id: _s, ...c }) => c),
      conditions_unchecked: unchecked
    })
  }
  groups.sort((a, z) => z.records.length - a.records.length)
  return { computed_at, checked: instances.length, groups }
}

// ── Cached + per viewer ─────────────────────────────────────────────────────

const CACHE_MS = 2 * 60_000
const cache = tenantState(() => ({ at: 0, value: null as NoOwnerShared | null }))

/** The shared answer, at most 2 minutes old (`fresh` recomputes). One flight
 *  per tenant through the heavy-read gate. */
export async function sharedNoOwnerSteps(
  opts: { fresh?: boolean; who?: string } = {}
): Promise<NoOwnerShared> {
  const c = cache()
  if (!opts.fresh && c.value && Date.now() - c.at < CACHE_MS) return c.value
  const { value } = await sharedGatedRead(
    'no-owner-steps',
    opts.who ?? 'system',
    () => computeNoOwnerSteps(),
    { label: 'no-owner-steps' }
  )
  const slot = cache()
  slot.at = Date.now()
  slot.value = value
  return value
}

export interface NoOwnerViewDeps {
  visible(user: User, collection: string, ids: string[]): Promise<Set<string>>
  labels(collection: string, ids: string[]): Promise<Map<string, string>>
  creators(collection: string, ids: string[]): Promise<Map<string, { id: string; name: string }>>
  standIns(requests: OwnerResolutionRequest[]): Promise<Map<string, string[]>>
  entered(instances: Array<{ instance: string; state_id: string }>): Promise<Map<string, string>>
}

export const realViewDeps: NoOwnerViewDeps = {
  async visible(user, collection, ids) {
    const gates = await compileAccessGates(user, collection, { actingAdmin: true })
    return visibleIds(gates, ids)
  },
  async labels(collection, ids) {
    const { getLabels } = await import('./queues.js')
    const got = await getLabels(new Map([[collection, new Set(ids)]])).catch(
      () => ({}) as Record<string, string>
    )
    return new Map(ids.map((id) => [id, got[`${collection}:${id}`] ?? id]))
  },
  async creators(collection, ids) {
    const byItem = await recordCreators(collection, ids).catch(() => new Map<string, string>())
    const userIds = [...new Set(byItem.values())]
    const users = userIds.length
      ? ((await selectInChunks(userIds, 1000, (chunk) =>
          db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
        ).catch(() => [])) as Array<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string | null
        }>)
      : []
    const nameOf = new Map(users.map((u) => [up(u.id), personName(u)]))
    const out = new Map<string, { id: string; name: string }>()
    for (const [item, uid] of byItem)
      out.set(item, { id: uid, name: nameOf.get(up(uid)) ?? 'someone' })
    return out
  },
  async standIns(requests) {
    // With the fallback: for a record no one owns, that is the queue person.
    const owners = await resolveStateOwnersBatch(requests, db).catch(
      () => new Map<string, ResolvedOwner[]>()
    )
    return new Map([...owners].map(([k, v]) => [k, v.map(personName)]))
  },
  async entered(instances) {
    const ids = [...new Set(instances.map((i) => i.instance))]
    const rows = (await selectInChunks(ids, 1000, (chunk) =>
      db('nivaro_workflow_history')
        .whereIn('instance', chunk)
        .groupBy('instance', 'to_state')
        .select('instance', 'to_state')
        .max('timestamp as at')
    ).catch(() => [])) as Array<{ instance: string; to_state: string; at: Date | string }>
    const want = new Map(instances.map((i) => [up(i.instance), up(i.state_id)]))
    const out = new Map<string, string>()
    for (const r of rows) {
      if (want.get(up(r.instance)) !== up(r.to_state)) continue
      const at = iso(r.at)
      if (at) out.set(up(r.instance), at)
    }
    return out
  }
}

/** One administrator's report: records they may read, a labelled sample per step. */
export async function noOwnerReportFor(
  user: User,
  shared: NoOwnerShared,
  opts: { sample?: number } = {},
  deps: NoOwnerViewDeps = realViewDeps
): Promise<NoOwnerReport> {
  const idsByCollection = new Map<string, string[]>()
  for (const g of shared.groups)
    idsByCollection.set(g.collection, [
      ...(idsByCollection.get(g.collection) ?? []),
      ...g.records.map((r) => r.item)
    ])
  const visible = new Map<string, Set<string>>()
  for (const [collection, ids] of idsByCollection)
    visible.set(collection, await deps.visible(user, collection, [...new Set(ids)]))

  const viewed = viewGroups(shared, visible, Math.max(1, Math.min(50, opts.sample ?? 10)))

  // Label the samples: one read of each kind per collection.
  const sampleIds = new Map<string, Set<string>>()
  for (const g of viewed) {
    const set = sampleIds.get(g.collection) ?? new Set<string>()
    for (const r of g.sampleRecords) set.add(r.item)
    sampleIds.set(g.collection, set)
  }
  const labels = new Map<string, Map<string, string>>()
  const creators = new Map<string, Map<string, { id: string; name: string }>>()
  for (const [collection, ids] of sampleIds) {
    labels.set(collection, await deps.labels(collection, [...ids]))
    creators.set(collection, await deps.creators(collection, [...ids]))
  }
  const all = viewed.flatMap((g) => g.sampleRecords.map((r) => ({ g, r })))
  const standIns = await deps.standIns(
    all.map(({ g, r }) => ({
      key: r.instance,
      stateId: g.state_id,
      instanceId: r.instance,
      collection: g.collection,
      itemId: r.item
    }))
  )
  const entered = await deps.entered(
    all.map(({ g, r }) => ({ instance: r.instance, state_id: g.state_id }))
  )

  const groups: NoOwnerGroupOut[] = viewed.map(({ sampleRecords, ...g }) => ({
    ...g,
    sample: sampleRecords.map((r) => ({
      item: r.item,
      label: labels.get(g.collection)?.get(r.item) ?? r.item,
      creator: creators.get(g.collection)?.get(r.item) ?? null,
      stand_in: standIns.get(r.instance) ?? [],
      since: entered.get(up(r.instance)) ?? r.started_at,
      cluster: r.cluster
    }))
  }))
  return {
    computed_at: shared.computed_at,
    checked: shared.checked,
    total: groups.reduce((s, g) => s + g.count, 0),
    groups
  }
}

// ── Daily report section ────────────────────────────────────────────────────

/** "Warehouse FRE · Zone 1" — the first cluster's uncovered values, for a note. */
function uncoveredNote(g: SharedGroup): string {
  const c = g.clusters.find((x) => x.uncovered.length > 0)
  if (!c) return ''
  return `No group covers ${c.uncovered.map((u) => `${u.label} ${u.value}`).join(', ')}`
}

/** Rows for Health → Daily report: the total, then the biggest steps. Unscoped
 *  (the report is for administrators of the whole instance). */
export function noOwnerSectionRows(shared: NoOwnerShared): Array<{
  key: string
  label: string
  value: number
  unit: 'count'
  note?: string
  better: 'down'
}> {
  const total = shared.groups.reduce((s, g) => s + g.records.length, 0)
  const rows: Array<{
    key: string
    label: string
    value: number
    unit: 'count'
    note?: string
    better: 'down'
  }> = [
    {
      key: 'records',
      label: 'Records on a step nobody owns',
      value: total,
      unit: 'count',
      note: total
        ? `${shared.groups.length} step${shared.groups.length === 1 ? '' : 's'} — only an administrator can move them. Coverage › No owner`
        : 'Every step with owner-only moves has an owner.',
      better: 'down'
    }
  ]
  for (const g of shared.groups.slice(0, 12)) {
    const key = `${g.state_key}_${g.collection}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40)
    rows.push({
      key: /^[a-z]/.test(key) ? key : `s_${key}`.slice(0, 40),
      label: `${g.template_name} · ${g.state_label}`,
      value: g.records.length,
      unit: 'count',
      note: uncoveredNote(g) || undefined,
      better: 'down'
    })
  }
  return rows
}
