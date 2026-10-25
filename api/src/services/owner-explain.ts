import { db } from '../db/index.js'
import type { User } from '../types.js'
import { fieldLabel, type OwnerSource, ownerSourceSentence, personName } from './access-words.js'
import { findRecordInstance } from './branch-instances.js'
import { can, getAllowedFields } from './permissions.js'
import {
  buildDelegationSubstitutions,
  getOwnerGroupsForStates,
  type OwnerGroup,
  parseJson,
  pickWinningGroupsPrepared,
  prepareOwnerGroups,
  type RecordFilter,
  type RelationInfo,
  type ResolvedFilterValue,
  type ResolvedOwner,
  resolveFilterValues,
  resolveStateOwnersBatch
} from './pipeline-engine.js'
import { ADDENDUM_COLLECTION, resolvePipelineSubject } from './pipeline-subject.js'
import { compileAccessGates, unavailabilityOf, visibleIds } from './record-access.js'

/**
 * #1956 / #1907 — WHY each person owns a record's current step.
 *
 * The owner list itself always comes from resolveStateOwnersBatch (the one
 * resolver queues, panels and notifications use), so this can never name a
 * different set of owners than the rest of the app. What this adds is the
 * PROVENANCE the batch resolver throws away: which owner group won and the
 * record values that made it win, which team or manual add or fallback field
 * put a person there, and who an out-of-office owner's delegate is standing
 * in for. Group matching re-runs through the engine's own
 * pickWinningGroupsPrepared — one candidate at a time — so "this group
 * matched" means exactly what it means at runtime.
 */

export interface ExplainedOwner {
  id: string
  name: string
  email: string | null
  sources: OwnerSource[]
  sentences: string[]
  /** Set when they cannot act (suspended, redacted, out with no delegate). */
  unavailable: string | null
  /** Named only by the binding's fallback field: the record stays in their
   *  queue, but owner-only moves judge the assigned owners (skipFallback), so
   *  they cannot approve this step. */
  queue_only?: boolean
}

export interface OwnerExplanation {
  collection: string
  item: string
  instance_id: string
  state: { id: string; key: string; label: string; owners_not_required: boolean }
  /** The winning owner group(s) and the filter facts behind each. */
  groups: Array<{
    id: string
    name: string | null
    is_default: boolean
    filters: GroupFilterFact[]
  }>
  /** Other candidate groups the record ALSO matched but lost to a more specific one. */
  outranked: number
  owners: ExplainedOwner[]
  /** Owners the delegation swapped out (raw owner → their delegate). */
  delegations: Array<{
    from_id: string
    from_name: string
    to_id: string
    to_name: string
    until: string | null
  }>
  summary: string
}

export interface GroupFilterFact {
  field: string
  label: string
  wants: string
  record_value: string
  /** Dotted relation filters: the collection the label is read from (null =
   *  could not be worked out), the record's related ids there, and the
   *  group's own id value — redactOwnerFacts shows `#id` instead of a label
   *  the caller may not read. Stripped from every non-admin answer. */
  related_collection?: string | null
  record_ids?: string[]
  wants_id?: string | null
}

/** Why someone is listed, plus — for a fallback-only person — what it does not give them. */
function ownerSentences(name: string, sources: OwnerSource[], queueOnly: boolean): string[] {
  const out = sources.map((s) => ownerSourceSentence(name, s))
  if (queueOnly)
    out.push(
      `The record stays in ${name}'s queue, but only the step's assigned owners can approve it.`
    )
  return out
}

function idsOf(v: ResolvedFilterValue | undefined): string[] {
  if (!v) return []
  const ids = v.ids instanceof Set ? [...v.ids] : v.ids != null ? [v.ids] : []
  return ids.map(String).sort()
}

/** One hop: an M2O field, or an O2M / M2M alias (through its junction). */
async function hopTarget(collection: string, field: string): Promise<string | null> {
  type Rel = {
    many_collection: string
    many_field: string
    one_collection: string | null
    junction_field?: string | null
  }
  const m2o = (await db('nivaro_relations')
    .where({ many_collection: collection, many_field: field })
    .first('one_collection')
    .catch(() => null)) as Pick<Rel, 'one_collection'> | null | undefined
  if (m2o?.one_collection) return m2o.one_collection
  const alias = (await db('nivaro_relations')
    .where({ one_collection: collection, one_field: field })
    .first('many_collection', 'junction_field')
    .catch(() => null)) as Pick<Rel, 'many_collection' | 'junction_field'> | null | undefined
  if (!alias) return null
  if (!alias.junction_field) return alias.many_collection
  const leg = (await db('nivaro_relations')
    .where({ many_collection: alias.many_collection, many_field: alias.junction_field })
    .first('one_collection')
    .catch(() => null)) as Pick<Rel, 'one_collection'> | null | undefined
  return leg?.one_collection ?? null
}

/** 'project.project_type.name' on workflows → 'project_types' (the label's table). */
async function relatedCollectionOf(collection: string, path: string): Promise<string | null> {
  const segs = path.split('.')
  let cur = collection
  for (const seg of segs.slice(0, -1)) {
    const next = await hopTarget(cur, seg)
    if (!next) return null
    cur = next
  }
  return cur
}

function display(v: ResolvedFilterValue | undefined, raw: unknown): string {
  if (v) {
    const d = v.display instanceof Set ? [...v.display] : v.display != null ? [v.display] : []
    if (d.length > 0) return d.map(String).sort().join(', ')
  }
  return raw == null ? '' : String(raw)
}

export async function dimensionLabels(templateId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const rows = (await db('nivaro_pipeline_owner_dimensions as d')
      .join('nivaro_workflow_bindings as b', 'b.id', 'd.binding')
      .where('b.template', templateId)
      .select('d.field', 'd.label')) as Array<{ field: string; label: string | null }>
    for (const r of rows) if (r.label && !out.has(r.field)) out.set(r.field, r.label)
  } catch {
    /* labels are cosmetic */
  }
  return out
}

function fmtDate(v: unknown): string | null {
  if (!v) return null
  const d = new Date(v as string)
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export async function explainRecordOwners(
  collection: string,
  item: string
): Promise<OwnerExplanation | null> {
  const instance = (await findRecordInstance(collection, item)) as
    | { id: string; template: string; current_state: string | null; completed_at: Date | null }
    | undefined
  if (!instance?.current_state) return null
  const state = (await db('nivaro_workflow_states')
    .where({ id: instance.current_state })
    .first('id', 'key', 'label', 'owners_not_required')) as
    | { id: string; key: string; label: string; owners_not_required?: boolean | number }
    | undefined
  if (!state) return null
  const stateId = String(state.id)

  // Group filters read the PARENT record for an addendum (pipeline-subject).
  const subject =
    collection === ADDENDUM_COLLECTION
      ? await resolvePipelineSubject(collection, item)
      : { collection, itemId: String(item) }

  const [groupData, labels] = await Promise.all([
    getOwnerGroupsForStates([stateId], db),
    dimensionLabels(String(instance.template))
  ])
  const entry = groupData.get(stateId) ?? { groups: [], prepared: prepareOwnerGroups([]) }
  const prepared = entry.prepared

  let record: Record<string, unknown> = {}
  let relations: RelationInfo[] = []
  let resolved: Map<string, ResolvedFilterValue> | undefined
  if (entry.groups.length > 0) {
    record =
      ((await db(subject.collection)
        .where({ id: subject.itemId })
        .first()
        .catch(() => null)) as Record<string, unknown> | null) ?? {}
    relations = (await db('nivaro_relations')
      .where({ many_collection: subject.collection })
      .select('many_collection', 'many_field', 'one_collection')
      .catch(() => [])) as RelationInfo[]
    const dotted = prepared.filterFields.filter((f) => f.includes('.'))
    if (dotted.length > 0) {
      const map = await resolveFilterValues(
        subject.collection,
        new Map([[subject.itemId, record]]),
        dotted,
        db
      )
      resolved = map.get(subject.itemId)
    }
  }

  // Winner via the engine itself; then count the candidates that ALSO
  // matched (one-candidate prepared sets — the previewOwnerGroupImpact trick).
  const winners: OwnerGroup[] =
    entry.groups.length > 0 ? pickWinningGroupsPrepared(prepared, record, relations, resolved) : []
  let matchedCandidates = 0
  for (const c of prepared.candidates) {
    const one = prepareOwnerGroups([c.group])
    if (pickWinningGroupsPrepared(one, record, relations, resolved).length > 0) matchedCandidates++
  }
  const winnerIsDefault = winners.length > 0 && winners.every((g) => !!g.is_default)
  const groups = await Promise.all(
    winners.map(async (g) => {
      const filters = (parseJson(g.filters) as RecordFilter[] | null) ?? []
      return {
        id: String(g.id),
        name: g.name,
        is_default: !!g.is_default,
        filters: await Promise.all(
          filters.map(async (f): Promise<GroupFilterFact> => {
            const fact: GroupFilterFact = {
              field: f.field,
              label: fieldLabel(f.field, labels),
              wants: String(f.value ?? f.id_value ?? ''),
              record_value: display(resolved?.get(f.field), record[f.field.split('.')[0]])
            }
            if (f.field.includes('.')) {
              fact.related_collection = await relatedCollectionOf(subject.collection, f.field)
              fact.record_ids = idsOf(resolved?.get(f.field))
              fact.wants_id = f.id_value != null ? String(f.id_value) : null
            }
            return fact
          })
        )
      }
    })
  )

  // Membership provenance: direct vs through a team, per winning group.
  const winnerIds = winners.map((g) => String(g.id))
  const memberVia = new Map<string, { group: string; team: string | null }>()
  if (winnerIds.length > 0) {
    const [direct, team] = await Promise.all([
      db('nivaro_pipeline_owner_group_users')
        .whereIn('group', winnerIds)
        .select('group', 'user') as Promise<Array<{ group: string; user: string }>>,
      db('nivaro_pipeline_owner_group_teams as ogt')
        .join('nivaro_user_group_members as m', 'm.group_id', 'ogt.team_id')
        .join('nivaro_user_groups as t', 't.id', 'ogt.team_id')
        .whereIn('ogt.group', winnerIds)
        .select('ogt.group', 'm.user', 't.name as team_name')
        .catch(() => []) as Promise<Array<{ group: string; user: string; team_name: string }>>
    ])
    for (const r of direct)
      memberVia.set(String(r.user).toUpperCase(), { group: String(r.group), team: null })
    for (const r of team) {
      const k = String(r.user).toUpperCase()
      if (!memberVia.has(k)) memberVia.set(k, { group: String(r.group), team: r.team_name })
    }
  }

  // Manual adds on this instance for this step (or every step).
  const manual = (await db('nivaro_pipeline_instance_owners as io')
    .leftJoin('nivaro_users as a', 'a.id', 'io.added_by')
    .where('io.instance', instance.id)
    .where((q) => void q.where('io.state', stateId).orWhereNull('io.state'))
    .select('io.user', 'a.first_name', 'a.last_name', 'a.email')
    .catch(() => [])) as Array<{
    user: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  const manualBy = new Map(
    manual.map((m) => [
      String(m.user).toUpperCase(),
      m.first_name || m.last_name || m.email ? personName(m) : null
    ])
  )

  // Owner-fallback field on the binding (a user column on the record).
  let fallback: { field: string; user: string } | null = null
  try {
    const binding = (await db('nivaro_workflow_bindings')
      .where({ collection: subject.collection, template: instance.template })
      .first()) as { owner_fallback_field?: string | null } | undefined
    const f = binding?.owner_fallback_field?.trim()
    if (f) {
      const row = (await db(subject.collection)
        .where({ id: subject.itemId })
        .first(f)
        .catch(() => null)) as Record<string, unknown> | null
      const v = row?.[f]
      if (typeof v === 'string' && v.trim()) fallback = { field: f, user: v }
    }
  } catch {
    fallback = null
  }

  // The authoritative final list (after delegation), and the raw list.
  const req = [
    {
      key: 'x',
      stateId,
      instanceId: String(instance.id),
      collection,
      itemId: String(item)
    }
  ]
  const [finalMap, rawMap, assignedMap] = await Promise.all([
    resolveStateOwnersBatch(req),
    resolveStateOwnersBatch(req, db, { skipDelegation: true }),
    // Who the owner-only gate counts (checkTransitionOwner: no fallback user).
    resolveStateOwnersBatch(req, db, { skipFallback: true })
  ])
  const finals = finalMap.get('x') ?? []
  const assignedIds = new Set((assignedMap.get('x') ?? []).map((o) => String(o.id).toUpperCase()))
  const raws = rawMap.get('x') ?? []
  const subs =
    entry.groups.length > 0
      ? await buildDelegationSubstitutions(raws.map((o) => o.id))
      : new Map<string, ResolvedOwner | null>()

  // Delegation stand-ins: delegate id → the raw owner(s) they cover.
  const coveredBy = new Map<string, ResolvedOwner[]>()
  const delegations: OwnerExplanation['delegations'] = []
  const rawIds = raws.map((r) => r.id)
  const untilRows = rawIds.length
    ? ((await db('nivaro_users')
        .whereIn('id', rawIds)
        .select('id', 'delegate_expires_at', 'ooo_end')
        .catch(() =>
          db('nivaro_users').whereIn('id', rawIds).select('id', 'delegate_expires_at')
        )) as Array<{ id: string; delegate_expires_at?: Date | null; ooo_end?: Date | null }>)
    : []
  const untilById = new Map(
    untilRows.map((u) => [
      String(u.id).toUpperCase(),
      fmtDate(u.ooo_end ?? null) ?? fmtDate(u.delegate_expires_at ?? null)
    ])
  )
  for (const r of raws) {
    const d = subs.get(r.id)
    if (!d) continue
    const k = String(d.id).toUpperCase()
    coveredBy.set(k, [...(coveredBy.get(k) ?? []), r])
    delegations.push({
      from_id: r.id,
      from_name: personName(r),
      to_id: d.id,
      to_name: personName(d),
      until: untilById.get(String(r.id).toUpperCase()) ?? null
    })
  }

  const availRows = finals.length
    ? ((await db('nivaro_users')
        .whereIn(
          'id',
          finals.map((f) => f.id)
        )
        .select('id', 'status', 'is_redacted', 'is_out_of_office', 'delegate_id')) as Array<
        Record<string, unknown> & { id: string }
      >)
    : []
  const availById = new Map(availRows.map((u) => [String(u.id).toUpperCase(), u]))

  const winnerGroup = groups[0]
  const owners: ExplainedOwner[] = finals.map((o) => {
    const name = personName(o)
    const k = String(o.id).toUpperCase()
    const sources: OwnerSource[] = []
    const covers = coveredBy.get(k) ?? []
    for (const c of covers) {
      sources.push({
        kind: 'delegate',
        for_name: personName(c),
        until: untilById.get(String(c.id).toUpperCase()) ?? null
      })
    }
    const via = memberVia.get(k)
    if (via) {
      const g = groups.find((x) => x.id === via.group) ?? winnerGroup
      sources.push(
        g?.is_default || winnerIsDefault
          ? { kind: 'default_group', group_name: g?.name ?? null, via_team: via.team }
          : {
              kind: 'group',
              group_name: g?.name ?? null,
              via_team: via.team,
              matched: (g?.filters ?? []).map((f) => ({
                field: f.field,
                label: f.label,
                wants: f.wants,
                record_value: f.record_value
              }))
            }
      )
    }
    if (manualBy.has(k)) sources.push({ kind: 'manual', added_by: manualBy.get(k) ?? null })
    if (fallback && String(fallback.user).toUpperCase() === k)
      sources.push({
        kind: 'fallback',
        field: fallback.field,
        field_label: fieldLabel(fallback.field)
      })
    const u = availById.get(k)
    const unavailable = u ? unavailabilityOf(u as never) : null
    const queueOnly = !assignedIds.has(k)
    const sentences = ownerSentences(name, sources, queueOnly)
    return {
      id: o.id,
      name,
      email: o.email ?? null,
      sources,
      sentences,
      unavailable,
      ...(queueOnly ? { queue_only: true } : {})
    }
  })

  const notRequired = state.owners_not_required === true || state.owners_not_required === 1
  const summary =
    owners.length === 0
      ? notRequired
        ? `Nobody owns ${state.label} — this step does not need an owner.`
        : `Nobody owns ${state.label} for this record: ${
            entry.groups.length === 0
              ? 'the step has no owner groups'
              : 'no owner group matches it and no default group has members'
          }.`
      : `${owners.length} ${owners.length === 1 ? 'person owns' : 'people own'} ${state.label}${
          winners.length > 0 && !winnerIsDefault && winnerGroup?.name
            ? ` through the owner group "${winnerGroup.name}"`
            : ''
        }${
          matchedCandidates > 1
            ? ` (${matchedCandidates - 1} broader group${matchedCandidates - 1 === 1 ? '' : 's'} also matched, but the most specific one wins)`
            : ''
        }.`

  return {
    collection,
    item: String(item),
    instance_id: String(instance.id),
    state: { id: stateId, key: state.key, label: state.label, owners_not_required: notRequired },
    groups,
    outranked: Math.max(0, matchedCandidates - (winnerIsDefault ? 0 : 1)),
    owners,
    delegations,
    summary
  }
}

/** What a filter on a field the caller cannot read is shown as. */
export const HIDDEN_FIELD_LABEL = 'a field you cannot see'

/**
 * What a non-admin may hear about a record's owners. A field their role
 * cannot read is never named nor valued: the winning group MATCHED this
 * record, so its wanted value is the record's value too — both go, and so
 * does a fallback field that names the owner. A related-record label (a
 * dotted filter such as region.name) is shown only when they can read that
 * collection and see those records; otherwise the record's related ids
 * stand in as `#id`.
 */
export async function redactOwnerFacts(
  ex: OwnerExplanation,
  user: User,
  isAdmin: boolean
): Promise<OwnerExplanation> {
  if (isAdmin) return ex
  // null = every field (getAllowedFields' own convention); a lookup failure
  // reads as nothing readable, so it fails closed.
  const allowed = await getAllowedFields(user, 'read', ex.collection).catch(() => [] as string[])
  const all = allowed === null || allowed.includes('*')
  const ok = new Set(all ? [] : allowed)
  const hidden = (field: string) => !all && !ok.has(field.split('.')[0])

  // Related labels: one verdict per (collection, ids), as the caller.
  const labelOk = new Map<string, boolean>()
  for (const f of ex.groups.flatMap((g) => g.filters)) {
    if (f.related_collection === undefined || hidden(f.field)) continue
    const ids = f.record_ids ?? []
    const key = `${f.related_collection}|${ids.join(',')}`
    if (labelOk.has(key)) continue
    labelOk.set(key, await canSeeRelated(user, f.related_collection, ids))
  }
  const relatedHidden = (f: GroupFilterFact) =>
    f.related_collection !== undefined &&
    !labelOk.get(`${f.related_collection}|${(f.record_ids ?? []).join(',')}`)

  const masked: GroupFilterFact = {
    field: '',
    label: HIDDEN_FIELD_LABEL,
    wants: '',
    record_value: ''
  }
  const clean = (f: GroupFilterFact): GroupFilterFact => {
    if (hidden(f.field)) return masked
    const out: GroupFilterFact = {
      field: f.field,
      label: f.label,
      wants: f.wants,
      record_value: f.record_value
    }
    if (relatedHidden(f)) {
      out.wants = f.wants_id ? `#${f.wants_id}` : ''
      out.record_value = (f.record_ids ?? []).map((id) => `#${id}`).join(', ')
    }
    return out
  }
  const byField = new Map(ex.groups.flatMap((g) => g.filters).map((f) => [f.field, f]))
  const groups = ex.groups.map((g) => ({ ...g, filters: g.filters.map(clean) }))
  const owners = ex.owners.map((o) => {
    const sources = o.sources.map((s): OwnerSource => {
      if (s.kind === 'group' && s.matched)
        return {
          ...s,
          matched: s.matched.map((m) => {
            if (m.field && hidden(m.field)) return { ...masked, hidden: true }
            const fact = m.field ? byField.get(m.field) : undefined
            if (!fact) return m
            const c = clean(fact)
            return { ...m, wants: c.wants, record_value: c.record_value }
          })
        }
      if (s.kind === 'fallback' && s.field && hidden(s.field))
        return { kind: 'fallback', field: null, field_label: null, field_hidden: true }
      if (s.kind === 'fallback') return { ...s, field: null }
      return s
    })
    return { ...o, sources, sentences: ownerSentences(o.name, sources, !!o.queue_only) }
  })
  return { ...ex, groups, owners }
}

/** The caller may read the collection AND sees every one of these records. */
async function canSeeRelated(
  user: User,
  collection: string | null,
  ids: string[]
): Promise<boolean> {
  if (!collection) return false
  if (!(await can(user, 'read', collection).catch(() => false))) return false
  if (ids.length === 0) return true
  try {
    const gates = await compileAccessGates(user, collection)
    const seen = await visibleIds(gates, ids)
    return ids.every((id) => seen.has(id))
  } catch {
    return false
  }
}
