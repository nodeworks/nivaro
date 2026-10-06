/**
 * A record's pipeline instance, read alongside the record.
 *
 * REST: `fields=id,$workflow_instance` (add `$workflow_instance.history` for the
 * transition log). GraphQL: the `workflow_instance` field on every collection
 * bound to a pipeline. Both go through `loadCurrentInstances`, which reads a
 * whole page in a fixed number of queries: the instances, then the states and
 * transitions of the templates they use, then (only when asked) history.
 *
 * The instance is the record's CURRENT one by the rule the state views use:
 * the open instance first, else the newest by start. Addendum instances belong
 * to `nivaro_addendums`, not to the record, and never appear here.
 *
 * `available_transitions` = manual transitions out of the current state the
 * viewer's role may run. Condition rules are not evaluated (that needs the
 * record and every dotted path it names); the transition endpoint still judges
 * them, so a listed transition can still be refused. Owner-only transitions
 * (`require_owner`, #794) are offered only to a viewer who owns the current
 * step (delegation applied) and to admins — one owner resolution per page.
 */
import { db, dbRead } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { ownerOnlyAllows, ownsStep } from './record-access.js'
import { pickInstance } from './record-state.js'
import { isAdminRole } from './user-scopes.js'

export const INSTANCE_FIELD = '$workflow_instance'

export interface InstanceRow {
  id: string
  template: string
  collection: string
  item: string
  current_state: string | null
  started_at: Date | null
  completed_at: Date | null
}

export interface StateRow {
  id: string
  template: string
  key: string
  label: string
  external_label?: string | null
  color: string | null
  is_initial: unknown
  is_terminal: unknown
  lock_record: unknown
  sort: number | null
  skip_criteria?: unknown
}

export interface TransitionRow {
  id: string
  template: string
  from_state: string | null
  to_state: string
  label: string
  color: string | null
  required_roles: unknown
  actions?: unknown
  sort: number | null
  auto_trigger?: unknown
  require_owner?: unknown
}

export interface HistoryRow {
  id: number | string
  instance: string
  transition: string | null
  comment: string | null
  timestamp: Date | string
  user_id: string | null
  user_email: string | null
  user_first_name: string | null
  user_last_name: string | null
  from_state_id: string | null
  to_state_id: string | null
}

export interface LoadedInstance {
  instance: InstanceRow
  state: StateRow | null
  /** Newest history row into the current state, else the instance start. */
  enteredAt: Date | string | null
  available: TransitionRow[]
  /** Every state of the instance's template, by id (history labels). */
  states: Map<string, StateRow>
}

export interface Viewer {
  role: string | null | undefined
  isAdmin: boolean
  /** Owner-only transitions are judged against this person; absent = not an owner. */
  userId?: string | null
}

/** Owners of one instance's current step, keyed by instance id. */
export type StepOwnerResolver = (
  instances: InstanceRow[]
) => Promise<Map<string, Array<{ id: string | null | undefined }>>>

const resolveStepOwners: StepOwnerResolver = async (instances) => {
  const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
  return resolveStateOwnersBatch(
    instances
      .filter((i) => i.current_state)
      .map((i) => ({
        key: i.id,
        stateId: i.current_state as string,
        instanceId: i.id,
        collection: i.collection,
        itemId: String(i.item)
      }))
  )
}

/**
 * Drop owner-only transitions the viewer does not own (#794) — the same
 * answer the execute paths give (ownerOnlyAllows over the resolved owners of
 * the current step, delegation applied). ONE owner resolution for every
 * instance on the page that offers such a transition; admins and pages with
 * none skip it entirely.
 */
export async function applyOwnerOnly(
  entries: Array<{ instance: InstanceRow; available: TransitionRow[] }>,
  viewer: Viewer,
  resolve: StepOwnerResolver = resolveStepOwners
): Promise<void> {
  if (viewer.isAdmin) return
  const gated = entries.filter((e) => e.available.some((t) => truthy(t.require_owner)))
  if (gated.length === 0) return
  let owners: Map<string, Array<{ id: string | null | undefined }>>
  try {
    owners = viewer.userId ? await resolve(gated.map((e) => e.instance)) : new Map()
  } catch {
    // An owner question that cannot be answered hides the move, never offers it.
    owners = new Map()
  }
  for (const e of gated) {
    const list = owners.get(e.instance.id)
    const isOwner =
      viewer.userId && e.instance.current_state && list ? ownsStep(list, viewer.userId) : false
    if (ownerOnlyAllows(false, { is_owner: isOwner })) continue
    e.available = e.available.filter((t) => !truthy(t.require_owner))
  }
}

/** Same normalisation as `$state`: `item` is a string mirror of the id, and
 *  uuid-keyed collections have it stored in either casing. */
export const itemKey = (v: unknown) => String(v).toLowerCase()

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

function parseRoles(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function availableFor(
  instance: InstanceRow,
  transitions: TransitionRow[],
  viewer: Viewer
): TransitionRow[] {
  return transitions.filter((t) => {
    // Engine-only: the manual endpoint refuses them.
    if (truthy(t.auto_trigger)) return false
    if (instance.completed_at != null) {
      // A finished instance only offers transitions written out of its final
      // state (Uncancel) — the endpoint's completed-instance escape hatch.
      if (t.from_state !== instance.current_state) return false
    } else if (t.from_state !== null && t.from_state !== instance.current_state) {
      return false
    }
    if (viewer.isAdmin) return true
    const roles = parseRoles(t.required_roles)
    if (roles.length === 0) return true
    return (
      viewer.role != null &&
      roles.some((r) => r.toLowerCase() === String(viewer.role).toLowerCase())
    )
  })
}

/** The current instance per record id (keyed by `itemKey`); records running no
 *  pipeline are absent from the map. */
export async function loadCurrentInstances(
  collection: string,
  ids: Array<string | number>,
  viewer: Viewer
): Promise<Map<string, LoadedInstance>> {
  const out = new Map<string, LoadedInstance>()
  const unique = [...new Set(ids.filter((v) => v != null && v !== '').map(String))]
  if (unique.length === 0) return out

  const instances = (await selectInChunks(unique, 1500, (chunk) =>
    dbRead('nivaro_workflow_instances')
      .where('collection', collection)
      .whereIn('item', chunk)
      .select('id', 'template', 'collection', 'item', 'current_state', 'started_at', 'completed_at')
  )) as InstanceRow[]
  if (instances.length === 0) return out

  const byItem = new Map<string, InstanceRow[]>()
  for (const i of instances) {
    const k = itemKey(i.item)
    const list = byItem.get(k)
    if (list) list.push(i)
    else byItem.set(k, [i])
  }
  const chosen = new Map<string, InstanceRow>()
  for (const [k, list] of byItem) {
    const pick = pickInstance(list)
    if (pick) chosen.set(k, pick)
  }

  const templates = [...new Set([...chosen.values()].map((i) => i.template))]
  const chosenIds = [...chosen.values()].map((i) => i.id)
  const [states, transitions, entered] = await Promise.all([
    dbRead('nivaro_workflow_states').whereIn('template', templates).select('*') as Promise<
      StateRow[]
    >,
    dbRead('nivaro_workflow_transitions')
      .whereIn('template', templates)
      .orderBy('sort')
      .select('*') as Promise<TransitionRow[]>,
    selectInChunks(chosenIds, 1500, (chunk) =>
      dbRead('nivaro_workflow_history as h')
        .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
        .whereIn('h.instance', chunk)
        .whereRaw('h.to_state = i.current_state')
        .groupBy('h.instance')
        .select('h.instance', db.raw('MAX(h.timestamp) as at'))
    ) as Promise<Array<{ instance: string; at: Date | string }>>
  ])

  const statesByTemplate = new Map<string, Map<string, StateRow>>()
  for (const s of states) {
    let m = statesByTemplate.get(s.template)
    if (!m) {
      m = new Map()
      statesByTemplate.set(s.template, m)
    }
    m.set(s.id, s)
  }
  const transitionsByTemplate = new Map<string, TransitionRow[]>()
  for (const t of transitions) {
    const list = transitionsByTemplate.get(t.template)
    if (list) list.push(t)
    else transitionsByTemplate.set(t.template, [t])
  }
  const enteredBy = new Map(entered.map((e) => [e.instance, e.at]))

  for (const [k, instance] of chosen) {
    const tplStates = statesByTemplate.get(instance.template) ?? new Map<string, StateRow>()
    out.set(k, {
      instance,
      state: instance.current_state ? (tplStates.get(instance.current_state) ?? null) : null,
      enteredAt: enteredBy.get(instance.id) ?? instance.started_at,
      available: availableFor(instance, transitionsByTemplate.get(instance.template) ?? [], viewer),
      states: tplStates
    })
  }
  await applyOwnerOnly([...out.values()], viewer)
  return out
}

/** Transition log per instance id, oldest first. */
export async function loadInstanceHistory(
  instanceIds: string[]
): Promise<Map<string, HistoryRow[]>> {
  const out = new Map<string, HistoryRow[]>()
  const unique = [...new Set(instanceIds)]
  if (unique.length === 0) return out
  const rows = (await selectInChunks(unique, 1500, (chunk) =>
    dbRead('nivaro_workflow_history as h')
      .leftJoin('nivaro_users as u', 'h.user', 'u.id')
      .whereIn('h.instance', chunk)
      .orderBy('h.timestamp', 'asc')
      .orderBy('h.id', 'asc')
      .select(
        'h.id',
        'h.instance',
        'h.transition',
        'h.comment',
        'h.timestamp',
        'u.id as user_id',
        'u.email as user_email',
        'u.first_name as user_first_name',
        'u.last_name as user_last_name',
        'h.from_state as from_state_id',
        'h.to_state as to_state_id'
      )
  )) as HistoryRow[]
  for (const r of rows) {
    const list = out.get(r.instance)
    if (list) list.push(r)
    else out.set(r.instance, [r])
  }
  return out
}

// ── REST projection ──────────────────────────────────────────────────────────

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const restStateRef = (s: StateRow | null | undefined) =>
  s ? { id: s.id, key: s.key, label: s.label, color: s.color ?? null } : null

/**
 * Takes `$workflow_instance` (and `$workflow_instance.history` / `.*`) out of a
 * field list before the column machinery sees it. `nested` is the expansion
 * map parseFieldExpansion built; its entry is removed in place.
 */
export function splitInstanceField(
  direct: string[],
  nested: Record<string, string[]>
): { fields: string[]; instance: { history: boolean } | null } {
  const sub = nested[INSTANCE_FIELD]
  delete nested[INSTANCE_FIELD]
  if (!direct.includes(INSTANCE_FIELD) && !sub) return { fields: [...direct], instance: null }
  const history = !!sub?.some((f) => f === 'history' || f === '*' || f.startsWith('history.'))
  return { fields: direct.filter((f) => f !== INSTANCE_FIELD), instance: { history } }
}

/** Sets `row.$workflow_instance` on every row (null when it runs no pipeline). */
export async function attachRecordInstance(
  collection: string,
  rows: Record<string, unknown>[],
  user: { id?: string | null; role?: string | null } | null | undefined,
  opts: { history: boolean }
): Promise<void> {
  if (rows.length === 0) return
  const role = user?.role ?? null
  const viewer: Viewer = { role, isAdmin: await isAdminRole(role), userId: user?.id ?? null }
  const loaded = await loadCurrentInstances(
    collection,
    rows.map((r) => r.id as string | number),
    viewer
  )
  const history = opts.history
    ? await loadInstanceHistory([...loaded.values()].map((l) => l.instance.id))
    : null

  for (const row of rows) {
    const l = loaded.get(itemKey(row.id))
    if (!l) {
      row[INSTANCE_FIELD] = null
      continue
    }
    const s = l.state
    const value: Record<string, unknown> = {
      id: l.instance.id,
      template: l.instance.template,
      started_at: iso(l.instance.started_at),
      completed_at: iso(l.instance.completed_at),
      entered_at: iso(l.enteredAt),
      current_state: s
        ? {
            id: s.id,
            key: s.key,
            label: s.label,
            external_label: s.external_label ?? null,
            color: s.color ?? null,
            is_initial: truthy(s.is_initial),
            is_terminal: truthy(s.is_terminal)
          }
        : null,
      available_transitions: l.available.map((t) => ({
        id: t.id,
        label: t.label,
        color: t.color ?? null,
        to_state: restStateRef(l.states.get(t.to_state))
      }))
    }
    if (history) {
      value.history = (history.get(l.instance.id) ?? []).map((h) => ({
        id: h.id,
        at: iso(h.timestamp),
        transition: h.transition,
        from_state: restStateRef(h.from_state_id ? l.states.get(h.from_state_id) : null),
        to_state: restStateRef(h.to_state_id ? l.states.get(h.to_state_id) : null),
        comment: h.comment,
        user: h.user_id
          ? {
              id: h.user_id,
              name:
                [h.user_first_name, h.user_last_name].filter(Boolean).join(' ') ||
                h.user_email ||
                null
            }
          : null
      }))
    }
    row[INSTANCE_FIELD] = value
  }
}

// ── GraphQL ──────────────────────────────────────────────────────────────────

/** Collections bound to a pipeline (read at schema build). */
export async function boundCollections(): Promise<Set<string>> {
  try {
    const rows = (await dbRead('nivaro_workflow_bindings').select('collection')) as Array<{
      collection: string
    }>
    return new Set(rows.map((r) => r.collection))
  } catch {
    return new Set()
  }
}

/**
 * Collects every key asked for in one pass over a result list, then loads them
 * in one call. GraphQL calls a list's field resolvers row by row in the same
 * tick, so a page of 25 records costs one load, not 25.
 */
class Batch<V> {
  private keys = new Set<string>()
  private run: Promise<Map<string, V>> | null = null
  constructor(private readonly load: (keys: string[]) => Promise<Map<string, V>>) {}
  get(key: string): Promise<V | null> {
    if (!this.run) {
      this.run = new Promise((resolve, reject) => {
        setImmediate(() => {
          const keys = [...this.keys]
          this.keys = new Set()
          this.run = null
          this.load(keys).then(resolve, reject)
        })
      })
    }
    this.keys.add(key)
    return this.run.then((m) => m.get(key) ?? null)
  }
}

const requestBatches = new WeakMap<object, Map<string, Batch<unknown>>>()

function batchFor<V>(
  ctx: object,
  name: string,
  load: (keys: string[]) => Promise<Map<string, V>>
): Batch<V> {
  let m = requestBatches.get(ctx)
  if (!m) {
    m = new Map()
    requestBatches.set(ctx, m)
  }
  let b = m.get(name) as Batch<V> | undefined
  if (!b) {
    b = new Batch(load)
    m.set(name, b as Batch<unknown>)
  }
  return b
}

function gqlState(s: StateRow) {
  return {
    id: s.id,
    key: s.key,
    label: s.label,
    externalLabel: s.external_label ?? null,
    color: s.color ?? null,
    isInitial: truthy(s.is_initial),
    isTerminal: truthy(s.is_terminal),
    lockRecord: truthy(s.lock_record),
    sort: s.sort ?? 0,
    skipCriteria: null
  }
}

/**
 * The `WorkflowInstance` payload for one record, or null. `history` is a
 * function, so graphql-js only calls it (and the batched history read behind
 * it) when the query selects it.
 */
export async function resolveRecordInstanceGql(
  ctx: { user?: { id?: string | null; role?: string | null } | null; isAdmin?: boolean },
  collection: string,
  recordId: unknown
): Promise<Record<string, unknown> | null> {
  if (!ctx.user || recordId == null) return null
  const viewer: Viewer = {
    role: ctx.user.role ?? null,
    isAdmin: ctx.isAdmin ?? false,
    userId: ctx.user.id ?? null
  }
  const batch = batchFor<LoadedInstance>(ctx, `instance:${collection}`, async (keys) => {
    return loadCurrentInstances(collection, keys, viewer)
  })
  const l = await batch.get(String(recordId))
  if (!l) return null
  const historyBatch = batchFor<HistoryRow[]>(ctx, 'instance-history', loadInstanceHistory)
  return {
    id: l.instance.id,
    collection: l.instance.collection,
    item: l.instance.item,
    currentState: l.state ? gqlState(l.state) : null,
    startedAt: l.instance.started_at,
    completedAt: l.instance.completed_at,
    enteredAt: l.enteredAt,
    availableTransitions: l.available.map((t) => ({
      id: t.id,
      fromState: t.from_state,
      toState: t.to_state,
      label: t.label,
      color: t.color,
      requiredRoles: parseRoles(t.required_roles),
      actions: null,
      sort: t.sort ?? 0
    })),
    history: async () => {
      const rows = (await historyBatch.get(l.instance.id)) ?? []
      return rows.map((h) => {
        const from = h.from_state_id ? l.states.get(h.from_state_id) : null
        const to = h.to_state_id ? l.states.get(h.to_state_id) : null
        return {
          id: h.id,
          transition: h.transition,
          fromState: from ? gqlState(from) : null,
          toState: to ? gqlState(to) : null,
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
        }
      })
    }
  }
}
