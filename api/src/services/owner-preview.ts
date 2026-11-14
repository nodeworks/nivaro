import { db } from '../db/index.js'
import { fieldLabel, personName } from './access-words.js'
import { findRecordInstance, type InstanceIdentity } from './branch-instances.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { display } from './owner-explain.js'
import {
  coerceBool,
  getOwnerGroupsForStates,
  isInactivePerson,
  type OwnerGroup,
  type OwnerResolutionTrace,
  parseJson,
  pickWinningGroupsPrepared,
  prepareOwnerGroups,
  type RecordFilter,
  type ResolvedOwner,
  resolveStateOwnersBatch
} from './pipeline-engine.js'

/**
 * Owner preview ("Try a record" in the Owner Matrix): who would own EACH step
 * of one record — under the saved owner groups and under the matrix's unsaved
 * draft — and why.
 *
 * Both answers come from resolveStateOwnersBatch, the one resolver queues,
 * panels and notifications use: the draft rides in through its `groups`
 * option (the saved groups with the draft's changed/new/removed groups laid
 * over them), and the why is read off its `trace`. Nothing here matches
 * groups on its own except the "also matched" count, which re-runs the
 * engine's pickWinningGroupsPrepared one candidate at a time (the
 * owner-explain trick). Read-only; nothing is written.
 */

/** One changed, new or removed group of the matrix draft, as the editor holds it. */
export interface DraftOwnerGroupInput {
  /** A saved group's id (changed / removed) or a draft-only id (new). */
  id: string
  state: string
  name?: string | null
  filters: RecordFilter[] | null
  is_default?: boolean
  priority?: number
  /** User ids — the group's whole direct membership in the draft. */
  users: string[]
  /** Team ids linked to the cell in the draft. */
  teams: number[]
  /** The draft deletes this group. */
  removed?: boolean
}

export interface PreviewOwner {
  id: string
  name: string
  email: string | null
  /** group = an owner group member (or team member); manual = added to this record by hand;
   *  stand_in = the binding's fallback person (nobody is assigned). */
  via: 'group' | 'manual' | 'stand_in'
  /** Set when this person is a delegate covering an out-of-office owner. */
  delegate_for: string | null
  /** Suspended / redacted — named, but cannot act. */
  inactive: boolean
}

export interface PreviewFact {
  field: string
  label: string
  wants: string
  record_value: string
}

export interface PreviewStepOwners {
  owners: PreviewOwner[]
  /** No group member and no hand-added owner — at most a stand-in holds the step. */
  no_assigned_owner: boolean
  match: {
    kind: 'no_groups' | 'no_match' | 'default' | 'match'
    group: { id: string; name: string | null; is_default: boolean; is_draft: boolean } | null
    /** The winning group's filters against the record's values. */
    facts: PreviewFact[]
    /** Optional dimensions the record has a value for that the winning group does not name. */
    inherited: Array<{ label: string; value: string }>
    /** Optional dimensions the winning group names (an override cell). */
    override: string[]
    /** Other groups that also matched but lost to the more specific one. */
    outranked: number
  }
  delegations: Array<{ from_id: string; from_name: string; to_id: string; to_name: string }>
  why: string[]
}

export interface OwnerPreviewStep {
  state: {
    id: string
    key: string
    label: string
    color: string | null
    is_current: boolean
    is_terminal: boolean
    owners_not_required: boolean
  }
  saved: PreviewStepOwners
  draft: PreviewStepOwners | null
  /** The draft changes who owns this step, or which group decides it. */
  changed: boolean
}

export interface OwnerPreview {
  collection: string
  item: string
  has_instance: boolean
  current_state: string | null
  /** The draft carried at least one change. */
  has_draft: boolean
  steps: OwnerPreviewStep[]
  /** Steps that would have no assigned owner (draft when present, else saved). */
  unowned: number
}

interface StateRow {
  id: string
  key: string
  label: string
  color: string | null
  is_initial?: boolean | number
  is_terminal?: boolean | number
  owners_not_required?: boolean | number
}

interface DimRow {
  field: string
  label: string | null
  required: boolean | number | null
  is_row_axis: boolean | number | null
  collection: string
}

type PersonRow = ResolvedOwner & {
  status?: string | null
  is_redacted?: boolean | number | null
}

export interface OwnerPreviewDeps {
  database: typeof db
  loadStates(templateId: string): Promise<StateRow[]>
  loadDimensions(templateId: string): Promise<DimRow[]>
  findInstance(
    collection: string,
    item: string
  ): Promise<{ id: string; template: string; current_state: string | null } | undefined>
  savedGroups(stateIds: string[]): Promise<Map<string, OwnerGroup[]>>
  readPeople(ids: string[]): Promise<PersonRow[]>
  readTeamMembers(teamIds: number[]): Promise<Array<ResolvedOwner & { team: number }>>
}

const defaultDeps = (database: typeof db = db): OwnerPreviewDeps => ({
  database,
  loadStates: async (templateId) =>
    (await database('nivaro_workflow_states')
      .where({ template: templateId })
      .orderBy('sort')
      .select('*')) as StateRow[],
  loadDimensions: async (templateId) =>
    (await database('nivaro_pipeline_owner_dimensions as d')
      .join('nivaro_workflow_bindings as b', 'b.id', 'd.binding')
      .where('b.template', templateId)
      .orderBy('d.sort')
      .select('d.field', 'd.label', 'd.required', 'd.is_row_axis', 'b.collection')
      .catch(() => [])) as DimRow[],
  findInstance: (collection, item) =>
    findRecordInstance<InstanceIdentity & { current_state: string | null }>(
      collection,
      item,
      database
    ),
  savedGroups: async (stateIds) => {
    const data = await getOwnerGroupsForStates(stateIds, database)
    return new Map([...data].map(([id, e]) => [id, e.groups]))
  },
  readPeople: async (ids) =>
    ids.length === 0
      ? []
      : ((await selectInChunks(ids, 1000, (chunk) =>
          whereInList(database('nivaro_users'), 'id', chunk).select(
            'id',
            'email',
            'first_name',
            'last_name',
            'status',
            'is_redacted'
          )
        )) as PersonRow[]),
  readTeamMembers: async (teamIds) =>
    teamIds.length === 0
      ? []
      : ((await database('nivaro_user_group_members as m')
          .join('nivaro_users as u', 'm.user', 'u.id')
          .whereIn('m.group_id', teamIds)
          .select('m.group_id as team', 'u.id', 'u.email', 'u.first_name', 'u.last_name')) as Array<
          ResolvedOwner & { team: number }
        >)
})

const up = (v: unknown) => String(v ?? '').toUpperCase()

function toOwnerGroup(g: DraftOwnerGroupInput, templateId: string): OwnerGroup {
  return {
    id: g.id,
    template: templateId,
    state: g.state,
    name: g.name ?? null,
    filters: g.filters && g.filters.length > 0 ? JSON.stringify(g.filters) : null,
    sort: 0,
    is_default: !!g.is_default,
    priority: Number(g.priority ?? 0) || 0,
    max_wip: null
  }
}

export async function previewRecordOwners(
  input: {
    templateId: string
    collection: string
    item: string
    draft?: DraftOwnerGroupInput[] | null
  },
  deps: OwnerPreviewDeps = defaultDeps()
): Promise<OwnerPreview> {
  const { templateId, collection, item } = input
  const [states, dims, instance] = await Promise.all([
    deps.loadStates(templateId),
    deps.loadDimensions(templateId),
    deps.findInstance(collection, item)
  ])
  // An instance of ANOTHER template (the record moved pipelines) says nothing
  // about this one's steps.
  const inst = instance && up(instance.template) === up(templateId) ? instance : undefined
  const stateIds = states.map((s) => String(s.id))
  const stateIdSet = new Set(stateIds.map(up))
  const initial = states.find((s) => coerceBool(s.is_initial)) ?? states[0]
  const currentState = inst?.current_state ?? (initial ? String(initial.id) : null)

  const requests = stateIds.map((id) => ({
    key: id,
    stateId: id,
    instanceId: inst ? String(inst.id) : null,
    collection,
    itemId: String(item)
  }))

  const draft = (input.draft ?? []).filter((g) => stateIdSet.has(up(g.state)))
  const savedTrace = new Map<string, OwnerResolutionTrace>()
  const draftTrace = new Map<string, OwnerResolutionTrace>()

  const saved = await resolveStateOwnersBatch(requests, deps.database, { trace: savedTrace })

  let drafted: Map<string, ResolvedOwner[]> | null = null
  const draftIds = new Set<string>()
  if (draft.length > 0) {
    const savedByState = await deps.savedGroups(stateIds)
    const byId = new Map(draft.map((g) => [up(g.id), g]))
    const byState = new Map<string, OwnerGroup[]>()
    for (const id of stateIds) {
      const kept = (savedByState.get(id) ?? []).filter((g) => !byId.has(up(g.id)))
      const added = draft
        .filter((g) => up(g.state) === up(id) && !g.removed)
        .map((g) => toOwnerGroup(g, templateId))
      byState.set(id, [...kept, ...added])
    }
    // Draft memberships: direct users ∪ linked team rosters, like the resolver's own join.
    const live = draft.filter((g) => !g.removed)
    const [people, teamRows] = await Promise.all([
      deps.readPeople([...new Set(live.flatMap((g) => g.users.map(String)))]),
      deps.readTeamMembers([...new Set(live.flatMap((g) => g.teams.map(Number)))])
    ])
    const personById = new Map(people.map((p) => [up(p.id), p]))
    const members = new Map<string, ResolvedOwner[]>()
    for (const g of live) {
      draftIds.add(up(g.id))
      const list: ResolvedOwner[] = []
      for (const u of g.users) {
        const p = personById.get(up(u))
        if (p)
          list.push({ id: p.id, email: p.email, first_name: p.first_name, last_name: p.last_name })
      }
      const teams = new Set(g.teams.map(Number))
      for (const r of teamRows) {
        if (teams.has(Number(r.team)))
          list.push({ id: r.id, email: r.email, first_name: r.first_name, last_name: r.last_name })
      }
      members.set(g.id, list)
    }
    drafted = await resolveStateOwnersBatch(requests, deps.database, {
      groups: { byState, members },
      trace: draftTrace
    })
  }

  // Who can act: one read for every person named in either answer.
  const named = new Set<string>()
  for (const m of [saved, drafted]) {
    for (const list of m?.values() ?? []) for (const o of list) named.add(String(o.id))
  }
  const statusById = new Map(
    (await deps.readPeople([...named]).catch(() => [] as PersonRow[])).map((p) => [up(p.id), p])
  )

  const optionalDims = dims.filter(
    (d) =>
      !coerceBool(d.required) &&
      !coerceBool(d.is_row_axis) &&
      (!d.collection || d.collection === collection)
  )
  const labels = new Map(dims.filter((d) => d.label).map((d) => [d.field, String(d.label)]))

  const describe = (
    state: StateRow,
    finals: ResolvedOwner[],
    trace: OwnerResolutionTrace | undefined,
    isDraft: boolean
  ): PreviewStepOwners => {
    const t = trace
    const winning = t?.winning ?? []
    const winner = winning[0] ?? null
    const prepared = t?.prepared ?? null
    const record = t?.record ?? {}
    const resolved = t?.resolved
    const kind: PreviewStepOwners['match']['kind'] = !t?.hasGroups
      ? 'no_groups'
      : winning.length === 0
        ? 'no_match'
        : winning.every((g) => coerceBool(g.is_default))
          ? 'default'
          : 'match'
    const filters =
      kind === 'match' && winner ? ((parseJson(winner.filters) as RecordFilter[] | null) ?? []) : []
    const recordValue = (field: string) =>
      display(resolved?.get(field), record[field.split('.')[0]])
    const facts: PreviewFact[] = filters.map((f) => ({
      field: f.field,
      label: fieldLabel(f.field, labels),
      wants: String(f.value ?? f.id_value ?? ''),
      record_value: recordValue(f.field)
    }))
    let matched = 0
    if (prepared && t) {
      for (const c of prepared.candidates) {
        const one = prepareOwnerGroups([c.group])
        if (pickWinningGroupsPrepared(one, record, t.relations, resolved).length > 0) matched++
      }
    }
    const outranked = kind === 'match' ? Math.max(0, matched - 1) : 0
    const winnerFields = new Set(filters.map((f) => f.field))
    const override = optionalDims
      .filter((d) => winnerFields.has(d.field))
      .map((d) => d.label || fieldLabel(d.field))
    const inherited =
      kind === 'match'
        ? optionalDims
            .filter((d) => !winnerFields.has(d.field))
            .map((d) => ({ label: d.label || fieldLabel(d.field), value: recordValue(d.field) }))
            .filter((d) => d.value !== '')
        : []

    const groupIds = new Set((t?.groupOwners ?? []).map((o) => up(o.id)))
    const manualIds = new Set((t?.instanceOwners ?? []).map((o) => up(o.id)))
    const standInIds = new Set((t?.standIn ?? []).map((o) => up(o.id)))
    const covers = new Map<string, ResolvedOwner[]>()
    for (const s of t?.substitutions ?? []) {
      const k = up(s.to.id)
      covers.set(k, [...(covers.get(k) ?? []), s.from])
    }
    const owners: PreviewOwner[] = finals.map((o) => {
      const k = up(o.id)
      const covered = covers.get(k) ?? []
      const via: PreviewOwner['via'] = standInIds.has(k)
        ? 'stand_in'
        : manualIds.has(k) && !groupIds.has(k) && covered.length === 0
          ? 'manual'
          : 'group'
      const p = statusById.get(k)
      return {
        id: String(o.id),
        name: personName(o),
        email: o.email ?? null,
        via,
        delegate_for: covered.length > 0 ? covered.map((c) => personName(c)).join(', ') : null,
        inactive: p ? isInactivePerson(p) : false
      }
    })
    const noAssigned = (t?.groupOwners.length ?? 0) + (t?.instanceOwners.length ?? 0) === 0
    const delegations = (t?.substitutions ?? []).map((s) => ({
      from_id: String(s.from.id),
      from_name: personName(s.from),
      to_id: String(s.to.id),
      to_name: personName(s.to)
    }))

    const why: string[] = []
    const groupName = winner?.name?.trim() || null
    const notRequired = coerceBool(state.owners_not_required)
    if (kind === 'no_groups') why.push('This step has no owner groups.')
    else if (kind === 'no_match')
      why.push('No owner group matches this record, and the step has no default group.')
    else if (kind === 'default')
      why.push(
        `No group matches this record's values, so the default group${groupName ? ` "${groupName}"` : ''} applies.`
      )
    else {
      const parts = facts.map((f) => `${f.label} = ${f.record_value || f.wants}`)
      why.push(
        `${groupName ? `"${groupName}"` : 'The owner group'} matched${parts.length ? `: ${parts.join(', ')}` : ''}.`
      )
      if (outranked > 0)
        why.push(
          `${outranked} broader group${outranked === 1 ? '' : 's'} also matched; the most specific one wins.`
        )
      for (const i of inherited)
        why.push(`No override for ${i.label} = ${i.value}, so the base group applies (inherited).`)
      if (override.length > 0) why.push(`Override for ${override.join(', ')}.`)
    }
    if (isDraft && winner && draftIds.has(up(winner.id)))
      why.push('This group is changed in your draft.')
    if (kind !== 'no_groups' && kind !== 'no_match' && (t?.groupOwners.length ?? 0) === 0)
      why.push('The group has nobody in it.')
    for (const d of delegations)
      why.push(`${d.from_name} is out of office — ${d.to_name} stands in.`)
    for (const o of owners)
      if (o.via === 'manual') why.push(`${o.name} was added to this record by hand.`)
    if (noAssigned) {
      if (notRequired) why.push('This step does not need an owner.')
      else if (owners.some((o) => o.via === 'stand_in'))
        why.push(
          `Nobody is assigned. ${owners
            .filter((o) => o.via === 'stand_in')
            .map((o) => o.name)
            .join(
              ', '
            )} stands in from the record, so it waits in their queue — but only an assigned owner can approve it.`
        )
      else why.push('Nobody owns this step for this record.')
    }
    return {
      owners,
      no_assigned_owner: noAssigned && !notRequired,
      match: {
        kind,
        group: winner
          ? {
              id: String(winner.id),
              name: winner.name ?? null,
              is_default: coerceBool(winner.is_default),
              is_draft: isDraft && draftIds.has(up(winner.id))
            }
          : null,
        facts,
        inherited,
        override,
        outranked
      },
      delegations,
      why
    }
  }

  const sig = (s: PreviewStepOwners) =>
    `${s.owners
      .map((o) => up(o.id))
      .sort()
      .join(',')}|${s.match.group?.id ?? ''}|${s.no_assigned_owner}`

  const steps: OwnerPreviewStep[] = states.map((s) => {
    const id = String(s.id)
    const savedStep = describe(s, saved.get(id) ?? [], savedTrace.get(id), false)
    const draftStep = drafted ? describe(s, drafted.get(id) ?? [], draftTrace.get(id), true) : null
    return {
      state: {
        id,
        key: s.key,
        label: s.label,
        color: s.color ?? null,
        is_current: currentState != null && up(currentState) === up(id),
        is_terminal: coerceBool(s.is_terminal),
        owners_not_required: coerceBool(s.owners_not_required)
      },
      saved: savedStep,
      draft: draftStep,
      changed: !!draftStep && sig(draftStep) !== sig(savedStep)
    }
  })

  return {
    collection,
    item: String(item),
    has_instance: !!inst,
    current_state: currentState,
    has_draft: draft.length > 0,
    steps,
    unowned: steps.filter((s) => !s.state.is_terminal && (s.draft ?? s.saved).no_assigned_owner)
      .length
  }
}
