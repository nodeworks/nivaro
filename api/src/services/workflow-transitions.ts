import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { syncMaterializedQueueItem } from './queue-materialization.js'
import { resolveStateOwners } from './pipeline-engine.js'
import { emitTrigger } from '../flows/registry.js'
import { evaluateConditionRules, fetchRecordForConditions } from './workflow-conditions.js'
import { runTransitionActions, TransitionBlockedError } from './workflow-actions.js'

// ─── Shared workflow transition engine ───────────────────────────────────────
// Houses the transition mutation chain (instance update, history, materialized
// queue sync, bound state-field mirror incl. state_field_map, activity) so the
// manual transition endpoint and the auto-transition engine share ONE
// implementation. Also owns skip-criteria target resolution (moved here from
// routes/pipelines.ts).

export interface WorkflowState {
  id: string
  template: string
  key: string
  label: string
  color: string | null
  is_initial: boolean | number
  is_terminal: boolean | number
  lock_record: boolean | number
  sort: number
  skip_criteria: string | null
  skip_if_no_owners: boolean | number
  stage_visibility: string | null
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
  auto_trigger: boolean | number
  sort: number
  group_label: string | null
  condition_rules: string | null
  requirements: string | null
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

interface WorkflowBinding {
  id: number
  template: string
  collection: string
  state_field: string | null
  state_field_map: string | null
}

export type SkipOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'notin'

export interface SkipCriteria {
  mode?: 'all' | 'any'
  conditions: Array<{
    type: 'no_owners' | 'field_compare' | 'field_empty' | 'field_nonempty' | 'lookup_compare'
    field?: string
    op?: SkipOp
    value?: unknown
    // lookup_compare: query another collection and compare a record value
    // against a column of the matched rows (EFP thresholds pattern).
    collection?: string
    filters?: Array<{ column: string; value?: unknown; record_field?: string; op?: 'eq' | 'in' }>
    compare_column?: string
    record_field?: string
    match?: 'any' | 'all'
  }>
}

export function coerceBool(val: unknown): boolean {
  return val === true || val === 1 || val === '1'
}

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
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

/**
 * Resolve a record value for lookup_compare filters: plain column, dotted M2O
 * path (walked via nivaro_relations, up to 3 segments), or an M2M alias field
 * (returns the junction's related-id array).
 */
export async function resolveRecordValue(
  collection: string,
  record: Record<string, unknown>,
  path: string,
  itemId: string,
  database: typeof db
): Promise<unknown> {
  if (!path.includes('.')) {
    if (path in record) return record[path]
    // Not a physical column — try an M2M alias via nivaro_relations
    const rel = (await database('nivaro_relations')
      .where({ one_collection: collection, one_field: path })
      .whereNotNull('junction_field')
      .first()) as
      | { many_collection: string; many_field: string; junction_field: string }
      | undefined
    if (rel) {
      try {
        const rows = (await database(rel.many_collection)
          .where({ [rel.many_field]: itemId })
          .select(rel.junction_field)) as Array<Record<string, unknown>>
        return rows.map((r) => r[rel.junction_field]).filter((v) => v != null)
      } catch {
        return []
      }
    }
    return undefined
  }
  const { fetchRecordForConditions } = await import('./workflow-conditions.js')
  const resolved = await fetchRecordForConditions(
    collection,
    itemId,
    [JSON.stringify([{ field: path, op: 'nnull' }])]
  )
  return resolved[path]
}

/** Human phrase per skip op, used in skip-reason sentences. */
function opPhrase(op: SkipOp | undefined): string {
  switch (op) {
    case 'eq':
      return 'equals'
    case 'neq':
      return 'is not'
    case 'lt':
      return 'is below'
    case 'lte':
      return 'is at or below'
    case 'gt':
      return 'is above'
    case 'gte':
      return 'is at or above'
    case 'in':
      return 'is one of'
    case 'notin':
      return 'is not one of'
    default:
      return 'matches'
  }
}

function humanizeField(field: string | undefined): string {
  return String(field ?? '').replace(/\./g, ' › ').replace(/_/g, ' ') || 'field'
}

function fmtVal(v: unknown): string {
  if (v == null || v === '') return '(empty)'
  if (Array.isArray(v)) return v.map(fmtVal).join(', ')
  const n = Number(v)
  if (typeof v !== 'boolean' && v !== '' && Number.isFinite(n) && String(v).trim() !== '') {
    return n.toLocaleString('en-US')
  }
  return String(v)
}

async function evalLookupCompare(
  cond: SkipCriteria['conditions'][number],
  record: Record<string, unknown>,
  collection: string,
  itemId: string,
  database: typeof db
): Promise<{ matched: boolean; reason: string | null }> {
  const target = cond.collection
  if (!target || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target) || /^nivaro_/i.test(target)) {
    return { matched: false, reason: null }
  }
  if (!cond.compare_column || !cond.record_field || !cond.op) {
    return { matched: false, reason: null }
  }

  try {
    let q = database(target)
    for (const f of cond.filters ?? []) {
      if (!f?.column) continue
      const val =
        f.record_field != null
          ? await resolveRecordValue(collection, record, f.record_field, itemId, database)
          : f.value
      if (f.op === 'in' || Array.isArray(val)) {
        const list = Array.isArray(val) ? val : [val]
        if (list.length === 0) return { matched: false, reason: null }
        q = q.whereIn(f.column, list as never[])
      } else {
        if (val === undefined || val === null) return { matched: false, reason: null }
        q = q.where(f.column, val as never)
      }
    }
    const rows = (await q.select(cond.compare_column)) as Array<Record<string, unknown>>
    if (rows.length === 0) return { matched: false, reason: null }
    const recordVal = await resolveRecordValue(
      collection,
      record,
      cond.record_field,
      itemId,
      database
    )
    const checks = rows.map((r) => evalFilterOp(cond.op as SkipOp, Number(recordVal), Number(r[cond.compare_column as string])))
    const matched = cond.match === 'all' ? checks.every(Boolean) : checks.some(Boolean)
    const compareVals = [
      ...new Set(rows.map((r) => fmtVal(r[cond.compare_column as string])))
    ].slice(0, 5)
    const reason = matched
      ? `${humanizeField(cond.record_field)} (${fmtVal(recordVal)}) ${opPhrase(cond.op)} the ${humanizeField(cond.compare_column)} of ${compareVals.join(' / ')}`
      : null
    return { matched, reason }
  } catch {
    return { matched: false, reason: null }
  }
}

export interface SkipEvaluation {
  skipped: boolean
  /** Human-readable sentences for each criterion that contributed to the skip. */
  reasons: string[]
}

const NO_OWNERS_REASON = 'No owners resolve for this record'

export async function evaluateSkipCriteriaDetailed(
  stateId: string,
  record: Record<string, unknown>,
  instanceId: string | null,
  collection: string,
  itemId: string,
  database: typeof db,
  // Simulation override: evaluate PROPOSED criteria instead of the stored
  // row's — how the impact-preview endpoint answers "what changes if I save
  // this" without saving it. Everything else (owners, lookups) stays live.
  criteriaOverride?: { criteria?: SkipCriteria | null; skipIfNoOwners?: boolean }
): Promise<SkipEvaluation> {
  try {
    const state = await database<WorkflowState>('nivaro_workflow_states')
      .where({ id: stateId })
      .first()
    if (!state) return { skipped: false, reasons: [] }

    // Standalone skip-if-no-owners flag: skip the state when THIS RECORD resolves
    // zero owners for it — owner groups may exist but match other dimensions
    // (EFP getRealOwners semantics; includes manually-assigned instance owners).
    const effectiveSkipNoOwners =
      criteriaOverride?.skipIfNoOwners !== undefined
        ? criteriaOverride.skipIfNoOwners
        : coerceBool(state.skip_if_no_owners)
    if (effectiveSkipNoOwners) {
      const owners = await resolveStateOwners(stateId, instanceId, collection, itemId, database)
      if (owners.length === 0) return { skipped: true, reasons: [NO_OWNERS_REASON] }
    }

    const criteria =
      criteriaOverride !== undefined && 'criteria' in criteriaOverride
        ? (criteriaOverride.criteria ?? null)
        : parseJson<SkipCriteria>(state.skip_criteria)
    if (!criteria || !Array.isArray(criteria.conditions) || criteria.conditions.length === 0) {
      return { skipped: false, reasons: [] }
    }

    const results: Array<{ matched: boolean; reason: string | null }> = []
    for (const cond of criteria.conditions) {
      if (cond.type === 'no_owners') {
        const owners = await resolveStateOwners(stateId, instanceId, collection, itemId, database)
        results.push({
          matched: owners.length === 0,
          reason: owners.length === 0 ? NO_OWNERS_REASON : null
        })
      } else if (cond.type === 'field_compare') {
        const matched = evalFilterOp(cond.op as SkipOp, record[cond.field as string], cond.value)
        results.push({
          matched,
          reason: matched
            ? `${humanizeField(cond.field)} (${fmtVal(record[cond.field as string])}) ${opPhrase(cond.op)} ${fmtVal(cond.value)}`
            : null
        })
      } else if (cond.type === 'field_empty') {
        const v = record[cond.field as string]
        const matched = v == null || v === ''
        results.push({
          matched,
          reason: matched ? `${humanizeField(cond.field)} is empty` : null
        })
      } else if (cond.type === 'field_nonempty') {
        const v = record[cond.field as string]
        const matched = v != null && v !== ''
        results.push({
          matched,
          reason: matched ? `${humanizeField(cond.field)} has a value (${fmtVal(v)})` : null
        })
      } else if (cond.type === 'lookup_compare') {
        results.push(await evalLookupCompare(cond, record, collection, itemId, database))
      }
    }

    const skipped =
      criteria.mode === 'any'
        ? results.some((r) => r.matched)
        : results.every((r) => r.matched)
    // 'any' mode: only the criteria that fired explain the skip. 'all' mode:
    // every criterion held, so every reason belongs in the explanation.
    const reasons = skipped
      ? results.filter((r) => r.matched && r.reason).map((r) => r.reason as string)
      : []
    return { skipped, reasons }
  } catch {
    return { skipped: false, reasons: [] }
  }
}

export async function evaluateSkipCriteria(
  stateId: string,
  record: Record<string, unknown>,
  instanceId: string | null,
  collection: string,
  itemId: string,
  database: typeof db
): Promise<boolean> {
  const result = await evaluateSkipCriteriaDetailed(
    stateId,
    record,
    instanceId,
    collection,
    itemId,
    database
  )
  return result.skipped
}

export async function resolveTransitionTarget(
  toStateId: string,
  templateId: string,
  collection: string,
  itemId: string,
  instanceId: string | null,
  database: typeof db,
  depth = 0
): Promise<WorkflowState | null> {
  if (depth > 10) return null

  const state = await database<WorkflowState>('nivaro_workflow_states')
    .where({ id: toStateId })
    .first()
  if (!state) return null

  if (coerceBool(state.is_terminal) || coerceBool(state.is_initial)) return state

  let record: Record<string, unknown> = {}
  try {
    const r = await database(collection).where({ id: itemId }).first()
    if (r) record = r as Record<string, unknown>
  } catch {
    record = {}
  }

  const shouldSkip = await evaluateSkipCriteria(
    toStateId,
    record,
    instanceId,
    collection,
    itemId,
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

/**
 * Mirror the current state into the bound record's state_field. When the
 * binding carries a state_field_map ({stateKey: value}), the mapped value is
 * written instead of the raw key — this is how legacy INT/enum state columns
 * (e.g. inventory_request.request_state) stay in sync.
 */
export async function syncStateField(
  collection: string,
  item: string,
  stateObj: Pick<WorkflowState, 'key'> | null,
  database: typeof db = db
): Promise<void> {
  if (!stateObj) return
  const binding = (await database('nivaro_workflow_bindings').where({ collection }).first()) as
    | WorkflowBinding
    | undefined
  if (!binding?.state_field) return
  const map = parseJson<Record<string, unknown>>(binding.state_field_map)
  const value = map && stateObj.key in map ? map[stateObj.key] : stateObj.key
  try {
    await database(collection)
      .where({ id: item })
      .update({ [binding.state_field]: value })
  } catch {
    // Non-fatal: field may not exist on this collection
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Human-facing record id for notifications — workflows show `workflow_id`,
 * inventory requests `inventory_request_id`, etc. The mapping comes from the
 * entity-room registry (`nivaro_chat_room_types.match_field`), which already
 * records each collection's human id column; unregistered collections (or a
 * missing value) fall back to the internal id. Never throws.
 */
export async function resolveFriendlyId(collection: string, item: string): Promise<string> {
  try {
    const rt = (await db('nivaro_chat_room_types')
      .where({ collection, is_active: true })
      .first()) as { match_field?: string | null } | undefined
    const field = rt?.match_field
    if (field && field !== 'id' && IDENT_RE.test(field)) {
      const row = (await db(collection).where({ id: item }).select(field).first()) as
        | Record<string, unknown>
        | undefined
      const v = row?.[field]
      if (v !== null && v !== undefined && v !== '') return String(v)
    }
  } catch {
    /* fall through to the internal id */
  }
  return String(item)
}

export interface ApplyTransitionResult {
  updatedInstance: WorkflowInstance | undefined
  newStateObj: WorkflowState | null
  previousState: string | null
}

/**
 * Execute a transition's mutation chain. Validation (role gates, requirements,
 * condition rules) is the CALLER's responsibility — the manual endpoint applies
 * user-facing gates; the auto engine applies condition rules only.
 */
export async function applyTransition(opts: {
  instance: WorkflowInstance
  transition: WorkflowTransition
  userId?: string | null
  comment?: string | null
  source?: 'manual' | 'auto'
}): Promise<ApplyTransitionResult> {
  const { instance, transition } = opts
  const previousState = instance.current_state

  // Resolve skip criteria — may advance past the nominal target state
  const resolvedTarget = await resolveTransitionTarget(
    transition.to_state,
    instance.template,
    instance.collection,
    instance.item,
    instance.id,
    db
  )
  const newState = resolvedTarget?.id ?? transition.to_state

  // Blocking actions (e.g. the MDSi submission) run BEFORE anything mutates:
  // a failure throws TransitionBlockedError and the record stays in its
  // current state — no order number, no state change.
  {
    const targetStateObj = (await db<WorkflowState>('nivaro_workflow_states')
      .where({ id: newState })
      .first()) as WorkflowState | undefined
    const { blockedError } = await runTransitionActions({
      transition,
      instance,
      newStateObj: targetStateObj ? { key: targetStateObj.key, label: targetStateObj.label } : null,
      userId: opts.userId ?? null,
      phase: 'blocking'
    })
    if (blockedError) throw new TransitionBlockedError(blockedError)
  }
  const newStateObj =
    resolvedTarget ??
    (await db<WorkflowState>('nivaro_workflow_states').where({ id: newState }).first()) ??
    null

  await db('nivaro_workflow_instances')
    .where({ id: instance.id })
    .update({
      current_state: newState,
      completed_at: newStateObj && coerceBool(newStateObj.is_terminal) ? new Date() : null
    })

  await db('nivaro_workflow_history').insert({
    instance: instance.id,
    transition: transition.id,
    from_state: previousState,
    to_state: newState,
    user: opts.userId ?? null,
    comment: await annotateDelegateComment(opts.userId ?? null, opts.comment ?? null),
    timestamp: new Date()
  })

  // Transitions never pass through the generic collection-write hook — keep
  // materialized queue caches current explicitly.
  await syncMaterializedQueueItem(instance.collection, instance.item)

  await syncStateField(instance.collection, instance.item, newStateObj)

  const updatedInstance = (await db<WorkflowInstance>('nivaro_workflow_instances')
    .where({ id: instance.id })
    .first()) as WorkflowInstance | undefined

  // Transition actions (external submissions etc.) — never block or fail the
  // transition itself.
  try {
    await runTransitionActions({
      transition,
      instance: updatedInstance ?? instance,
      newStateObj,
      userId: opts.userId ?? null,
      phase: 'post'
    })
  } catch {
    /* logged inside runTransitionActions */
  }

  // Fire the core 'workflow-transition' flow trigger with resolved owners of
  // the NEW state — lets admins compose notifications (mail/in-app/webhook)
  // as ordinary flows instead of hardcoded behavior. Fire-and-forget.
  try {
    const prevStateObj = previousState
      ? await db<WorkflowState>('nivaro_workflow_states').where({ id: previousState }).first()
      : null
    const owners = newStateObj
      ? await resolveStateOwners(newStateObj.id, instance.id, instance.collection, instance.item)
      : []
    const friendlyId = await resolveFriendlyId(instance.collection, instance.item)
    emitTrigger(
      'workflow-transition',
      {
        collection: instance.collection,
        item: instance.item,
        friendly_id: friendlyId,
        template: instance.template,
        transition_id: transition.id,
        transition_label: transition.label,
        source: opts.source ?? 'manual',
        comment: opts.comment ?? null,
        user_id: opts.userId ?? null,
        from_state: prevStateObj ? { key: prevStateObj.key, label: prevStateObj.label } : null,
        to_state: newStateObj ? { key: newStateObj.key, label: newStateObj.label } : null,
        owners,
        owner_emails: owners
          .map((o) => o.email)
          .filter(Boolean)
          .join(',')
      },
      console as unknown as Parameters<typeof emitTrigger>[2],
      opts.userId ?? undefined
    )
  } catch {
    /* trigger emission is best-effort */
  }

  // State-scoped notification subscriptions (multi-dim filters) — best-effort.
  if (newStateObj) {
    import('../hooks/notification-subscriptions.js')
      .then(async ({ fireWorkflowStateSubscriptions }) =>
        fireWorkflowStateSubscriptions({
          collection: instance.collection,
          item: instance.item,
          friendlyId: await resolveFriendlyId(instance.collection, instance.item),
          stateKey: newStateObj.key,
          stateLabel: newStateObj.label,
          transitionLabel: transition.label,
          actorUserId: opts.userId ?? null
        })
      )
      .catch(() => {})
  }

  return { updatedInstance, newStateObj, previousState }
}

/**
 * Fire eligible auto transitions for an item: transitions flagged auto_trigger
 * whose from_state matches the instance's current state (or null = any) and
 * whose condition_rules pass against the live record (dotted paths + date ops
 * supported). Chains until nothing more fires (cap 5). Never throws.
 */
export async function runAutoTransitions(collection: string, item: string): Promise<void> {
  try {
    for (let hop = 0; hop < 5; hop++) {
      const instance = (await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()) as WorkflowInstance | undefined
      if (!instance || instance.completed_at) return

      const candidates = (await db<WorkflowTransition>('nivaro_workflow_transitions')
        .where({ template: instance.template, auto_trigger: true })
        .where((qb) => qb.where({ from_state: instance.current_state }).orWhereNull('from_state'))
        .whereNot({ to_state: instance.current_state ?? '' })
        .orderBy('sort')) as WorkflowTransition[]
      if (candidates.length === 0) return

      const record = await fetchRecordForConditions(
        collection,
        item,
        candidates.map((c) => c.condition_rules)
      )
      const fired = candidates.find((c) => evaluateConditionRules(c.condition_rules, record))
      if (!fired) return

      await applyTransition({
        instance,
        transition: fired,
        userId: null,
        comment: `auto: ${fired.label}`,
        source: 'auto'
      })
      await logActivity({
        action: 'pipeline-transition',
        collection,
        item,
        user: null,
        comment: `auto-transition "${fired.label}"`
      })
    }
  } catch (err) {
    console.error({ err, collection, item }, 'runAutoTransitions failed')
  }
}

/**
 * Periodic sweep: re-evaluate auto transitions for every open instance whose
 * template has any — catches date-based conditions that become true purely by
 * time passing (e.g. within_days). Bounded per template.
 */
export async function sweepAutoTransitions(): Promise<void> {
  try {
    const autoTemplates = (await db('nivaro_workflow_transitions')
      .where({ auto_trigger: true })
      .distinct('template')
      .pluck('template')) as string[]
    for (const template of autoTemplates) {
      const fromStates = (await db('nivaro_workflow_transitions')
        .where({ template, auto_trigger: true })
        .distinct('from_state')
        .pluck('from_state')) as Array<string | null>
      let q = db('nivaro_workflow_instances').where({ template }).whereNull('completed_at')
      if (!fromStates.includes(null)) {
        q = q.whereIn(
          'current_state',
          fromStates.filter((s): s is string => s !== null)
        )
      }
      const instances = (await q.select('collection', 'item').limit(5000)) as Array<{
        collection: string
        item: string
      }>
      for (const inst of instances) {
        await runAutoTransitions(inst.collection, inst.item)
      }
    }
  } catch (err) {
    console.error({ err }, 'sweepAutoTransitions failed')
  }
}


/**
 * Delegate transparency (#102): when the acting user is currently covering
 * for someone (their id sits in another user's delegate_id while that user is
 * OOO), the history comment records "as delegate for X" — audits can tell who
 * was supposed to sign. Best-effort; never blocks the transition.
 */
async function annotateDelegateComment(
  userId: string | null,
  comment: string | null
): Promise<string | null> {
  if (!userId) return comment
  try {
    const principals = (await db('nivaro_users')
      .where({ delegate_id: userId, is_out_of_office: true })
      .limit(3)
      .select('first_name', 'last_name', 'email')) as Array<{
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    if (principals.length === 0) return comment
    const names = principals
      .map((p) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || '?')
      .join(', ')
    const note = `(as delegate for ${names})`
    return comment ? `${comment} ${note}` : note
  } catch {
    return comment
  }
}
