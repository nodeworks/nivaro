import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import {
  coerceBool as engineCoerceBool,
  type OwnerResolutionRequest,
  type ResolvedOwner,
  resolveStateOwnersBatch
} from './pipeline-engine.js'
import { fetchPipelineRecord } from './pipeline-subject.js'
import {
  evalConditionRule,
  fetchRecordForConditions,
  parseConditionRules
} from './workflow-conditions.js'
import {
  evaluateSkipCriteriaDetailed,
  type WorkflowInstance,
  type WorkflowState,
  type WorkflowTransition
} from './workflow-transitions.js'

/**
 * The record's approval chain, the way the PipelinePanel shows it: every
 * template state with owners, a skip prediction, and PATH RELEVANCE — a
 * condition-aware BFS over the forward transition graph from the initial
 * state (Beeline vs Oracle branches, CAR vs REQ endings) so states the record
 * will never visit are dropped. Shared by GET /pipelines/instance/:c/:i/
 * owners/all and the transition emails (approval-chain.ts).
 *
 * `asOf` replays the chain at a PAST moment (mail harness): current = that
 * state, history truncated to that time.
 */

export interface UnavailableChainOwner {
  id: string
  name: string
  reason: 'out' | 'suspended' | 'redacted'
  /** The working delegate covering an out-of-office owner, else null. */
  delegate: { id: string; name: string; expires_at: string | null } | null
}

export interface ChainEntry {
  /** Post-delegation owners (an OOO owner is replaced by their delegate). */
  owners: ResolvedOwner[]
  skipped: boolean
  skip_reasons: string[]
  on_path: boolean
  /** RAW owners (pre-delegation) who cannot act right now, with who covers them. */
  unavailable: UnavailableChainOwner[]
  /** ≥1 raw owner and NONE can act — every owner suspended/redacted, or out
   *  with no working delegate (the coverage-gaps rule). */
  blocked: boolean
}

interface AvailabilityUserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  status: string | null
  is_redacted: boolean | number | null
  is_out_of_office: boolean | number | null
  delegate_id: string | null
  delegate_expires_at: Date | null
}

const userName = (u: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  id?: string
}) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.id || 'Unknown'

/** Suspended / inactive / redacted — cannot act, whatever their OOO flag. */
function hardUnavailable(u: AvailabilityUserRow): 'suspended' | 'redacted' | null {
  if (engineCoerceBool(u.is_redacted)) return 'redacted'
  if (u.status === 'suspended') return 'suspended'
  if (u.status != null && u.status !== 'active') return 'suspended'
  return null
}

/**
 * Availability of every RAW owner across the chain, in two batched user
 * lookups (owners, then their delegates) — never per owner. Mirrors
 * services/coverage-gaps.ts: an owner is covered when they are active, or
 * out of office with a delegate who is themselves active and not out.
 */
async function computeAvailability(
  rawByState: Map<string, ResolvedOwner[]>
): Promise<Map<string, { unavailable: UnavailableChainOwner[]; blocked: boolean }>> {
  const out = new Map<string, { unavailable: UnavailableChainOwner[]; blocked: boolean }>()
  const ownerIds = new Set<string>()
  for (const owners of rawByState.values()) for (const o of owners) ownerIds.add(String(o.id))
  if (ownerIds.size === 0) {
    for (const k of rawByState.keys()) out.set(k, { unavailable: [], blocked: false })
    return out
  }
  const cols = [
    'id',
    'first_name',
    'last_name',
    'email',
    'status',
    'is_redacted',
    'is_out_of_office',
    'delegate_id',
    'delegate_expires_at'
  ]
  const ownerRows = (await selectInChunks([...ownerIds], 2000, (chunk) =>
    db('nivaro_users').whereIn('id', chunk).select(cols)
  )) as AvailabilityUserRow[]
  const byId = new Map(ownerRows.map((u) => [String(u.id).toUpperCase(), u]))
  const delegateIds = [
    ...new Set(
      ownerRows
        .map((u) => (u.delegate_id ? String(u.delegate_id).toUpperCase() : null))
        .filter((id): id is string => !!id && !byId.has(id))
    )
  ]
  if (delegateIds.length > 0) {
    const delegateRows = (await selectInChunks(delegateIds, 2000, (chunk) =>
      db('nivaro_users').whereIn('id', chunk).select(cols)
    )) as AvailabilityUserRow[]
    for (const d of delegateRows) byId.set(String(d.id).toUpperCase(), d)
  }
  const now = Date.now()
  const workingDelegate = (u: AvailabilityUserRow): AvailabilityUserRow | null => {
    if (!u.delegate_id) return null
    if (u.delegate_expires_at && new Date(u.delegate_expires_at).getTime() <= now) return null
    const d = byId.get(String(u.delegate_id).toUpperCase())
    if (!d || hardUnavailable(d) || engineCoerceBool(d.is_out_of_office)) return null
    return d
  }
  for (const [stateId, owners] of rawByState) {
    const unavailable: UnavailableChainOwner[] = []
    let covered = 0
    for (const o of owners) {
      const u = byId.get(String(o.id).toUpperCase())
      if (!u) {
        // Unknown user row — cannot act.
        unavailable.push({ id: o.id, name: userName(o), reason: 'suspended', delegate: null })
        continue
      }
      const hard = hardUnavailable(u)
      if (hard) {
        unavailable.push({ id: o.id, name: userName(u), reason: hard, delegate: null })
        continue
      }
      if (engineCoerceBool(u.is_out_of_office)) {
        const d = workingDelegate(u)
        if (d) covered++
        unavailable.push({
          id: o.id,
          name: userName(u),
          reason: 'out',
          delegate: d
            ? {
                id: d.id,
                name: userName(d),
                expires_at: u.delegate_expires_at
                  ? new Date(u.delegate_expires_at).toISOString()
                  : null
              }
            : null
        })
        continue
      }
      covered++
    }
    out.set(stateId, { unavailable, blocked: owners.length > 0 && covered === 0 })
  }
  return out
}

export interface StateChain {
  templateId: string
  instance: WorkflowInstance | undefined
  currentStateId: string | null
  states: WorkflowState[]
  history: Array<{
    from_state: string | null
    to_state: string
    timestamp: Date
    user: string | null
  }>
  entries: Record<string, ChainEntry>
}

const coerceBool = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export async function computeStateChain(
  collection: string,
  item: string,
  opts: { asOf?: { stateId: string; time: Date } | null } = {}
): Promise<StateChain | null> {
  const binding = (await db('nivaro_workflow_bindings').where({ collection }).first()) as
    | { template: string }
    | undefined
  const instance = (await db<WorkflowInstance>('nivaro_workflow_instances')
    .where({ collection, item })
    .orderBy('started_at', 'desc')
    .first()) as WorkflowInstance | undefined
  const templateId = binding?.template ?? instance?.template
  if (!templateId) return null

  const states = (await db<WorkflowState>('nivaro_workflow_states')
    .where({ template: templateId })
    .orderBy('sort')) as WorkflowState[]
  const currentStateId = opts.asOf?.stateId ?? instance?.current_state ?? null

  const record = await fetchPipelineRecord(collection, item)

  let history: StateChain['history'] = instance
    ? ((await db('nivaro_workflow_history')
        .where({ instance: instance.id })
        .orderBy('timestamp', 'asc')
        .select('from_state', 'to_state', 'timestamp', 'user')) as StateChain['history'])
    : []
  if (opts.asOf) {
    const t = opts.asOf.time.getTime()
    history = history.filter((h) => new Date(h.timestamp).getTime() <= t)
  }

  const onPath = new Set<string>()
  try {
    const transitions = (await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template: templateId })
      .whereNotNull('from_state')
      .select('from_state', 'to_state', 'condition_rules')) as Array<{
      from_state: string
      to_state: string
      condition_rules: string | null
    }>
    const takenEdges = new Set(
      history.filter((h) => h.from_state).map((h) => `${h.from_state}:${h.to_state}`)
    )
    const conditioned = transitions.filter((t) => t.condition_rules)
    const conditionRecord =
      conditioned.length > 0
        ? await fetchRecordForConditions(
            collection,
            item,
            conditioned.map((t) => t.condition_rules)
          )
        : record
    const DISCRIMINATOR_OPS = new Set(['eq', 'neq', 'in', 'notin'])
    const passes = (t: { condition_rules: string | null }) => {
      const rules = parseConditionRules(t.condition_rules)
      if (!rules) return true
      return rules.every((r) => {
        if (!r || typeof r !== 'object' || typeof r.field !== 'string' || !r.field) return true
        if (!DISCRIMINATOR_OPS.has(String(r.op))) return true
        return evalConditionRule(r, conditionRecord)
      })
    }
    const sortOf = new Map(states.map((s) => [s.id, s.sort ?? 0]))
    const fwd = new Map<string, string[]>()
    for (const t of transitions) {
      if ((sortOf.get(t.to_state) ?? 0) < (sortOf.get(t.from_state) ?? 0)) continue
      if (!passes(t) && !takenEdges.has(`${t.from_state}:${t.to_state}`)) continue
      const arr = fwd.get(t.from_state) ?? []
      arr.push(t.to_state)
      fwd.set(t.from_state, arr)
    }
    for (const key of takenEdges) {
      const [fromId, toId] = key.split(':')
      if ((sortOf.get(toId) ?? 0) < (sortOf.get(fromId) ?? 0)) continue
      const arr = fwd.get(fromId) ?? []
      if (!arr.includes(toId)) {
        arr.push(toId)
        fwd.set(fromId, arr)
      }
    }
    const queue = states.filter((s) => coerceBool(s.is_initial)).map((s) => s.id)
    while (queue.length) {
      const id = queue.shift() as string
      if (onPath.has(id)) continue
      onPath.add(id)
      for (const next of fwd.get(id) ?? []) if (!onPath.has(next)) queue.push(next)
    }
    for (const h of history) onPath.add(h.to_state)
    if (currentStateId) onPath.add(currentStateId)
    if (onPath.size === 0) for (const s of states) onPath.add(s.id)
  } catch {
    for (const s of states) onPath.add(s.id)
  }

  // Owners for EVERY state in one batch, twice: the post-delegation set the
  // panel has always shown, and the raw set that says who is actually out and
  // who covers them. Availability then needs two user lookups for the whole
  // chain, never one per owner.
  const requests: OwnerResolutionRequest[] = states.map((s) => ({
    key: s.id,
    stateId: s.id,
    instanceId: instance?.id ?? null,
    collection,
    itemId: item
  }))
  const [ownersByState, rawByState, skipByState] = await Promise.all([
    resolveStateOwnersBatch(requests, db).catch(() => new Map<string, ResolvedOwner[]>()),
    resolveStateOwnersBatch(requests, db, { skipDelegation: true }).catch(
      () => new Map<string, ResolvedOwner[]>()
    ),
    Promise.all(
      states.map(async (s) => {
        const skip =
          s.id === currentStateId
            ? { skipped: false, reasons: [] as string[] }
            : await evaluateSkipCriteriaDetailed(
                s.id,
                record,
                instance?.id ?? null,
                collection,
                item,
                db
              ).catch(() => ({ skipped: false, reasons: [] as string[] }))
        return [s.id, skip] as const
      })
    ).then((pairs) => new Map(pairs))
  ])
  const availability = await computeAvailability(rawByState).catch(
    () => new Map<string, { unavailable: UnavailableChainOwner[]; blocked: boolean }>()
  )

  const entries: Record<string, ChainEntry> = {}
  for (const s of states) {
    const skip = skipByState.get(s.id) ?? { skipped: false, reasons: [] }
    const avail = availability.get(s.id) ?? { unavailable: [], blocked: false }
    entries[s.id] = {
      owners: ownersByState.get(s.id) ?? [],
      skipped: skip.skipped,
      skip_reasons: skip.reasons,
      on_path: onPath.has(s.id),
      unavailable: avail.unavailable,
      blocked: avail.blocked
    }
  }
  return { templateId, instance, currentStateId, states, history, entries }
}
