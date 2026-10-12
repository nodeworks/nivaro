import { db } from '../db/index.js'
import type { User } from '../types.js'
import { buildAction, runAction } from './ai-actions.js'
import type {
  ConditionOutcome,
  PlanSkippedRecord,
  PlanStepCondition,
  PlanStepDef,
  StepOutcome
} from './ai-plan-runner.js'
import { getApp } from './io-holder.js'
import { readItems } from './items.js'
import { can } from './permissions.js'

/**
 * Ask AI plan STEP KINDS (#1807, #2000) and step conditions (#1953).
 *
 * A step kind is two functions, both run AS THE PERSON who owns the plan:
 *   propose(user, input)  validate + preview, never mutate
 *   execute(user, payload) do it, through the normal services
 * plus two optional ones the engine uses when present:
 *   narrow(payload, ids)  run on fewer target records (per-record conditions)
 *   recheck(user, step, lastResult)  rebuild for a retry (default: propose again)
 *
 * `registerPlanStepKind` is the extension point: a later item (fix an
 * integrity cluster, transition records, run a saved query) adds a kind here
 * and the model, the plan card, conditions, progress and retry all work
 * without touching the engine.
 */

export interface PlanStepPreview {
  /** One line a person reads on the plan card. */
  summary: string
  count: number
  changes?: Record<string, unknown> | null
  sample?: Array<{ id: string; label: string }>
  recipients?: Array<{ id: string; name: string }>
  [key: string]: unknown
}

export interface ProposedStep {
  payload: Record<string, unknown>
  preview: PlanStepPreview
  targets?: { collection: string; ids: string[] } | null
}

export interface PlanStepContext {
  planId: string
  stepId: string
}

export interface PlanStepKind {
  kind: string
  label: string
  /** Shown to the model in the propose_plan tool description. */
  describe: string
  propose: (user: User, input: Record<string, unknown>) => Promise<ProposedStep>
  execute: (
    user: User,
    payload: Record<string, unknown>,
    ctx: PlanStepContext
  ) => Promise<StepOutcome>
  narrow?: (payload: Record<string, unknown>, ids: string[]) => Record<string, unknown>
  recheck?: (
    user: User,
    step: PlanStepDef,
    lastResult: Record<string, unknown> | null
  ) => Promise<ProposedStep>
}

const kinds = new Map<string, PlanStepKind>()

export function registerPlanStepKind(def: PlanStepKind): void {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(def.kind))
    throw new Error(`Invalid plan step kind: ${def.kind}`)
  kinds.set(def.kind, def)
}

export function getPlanStepKind(kind: string): PlanStepKind | undefined {
  return kinds.get(kind)
}

export function listPlanStepKinds(): PlanStepKind[] {
  return [...kinds.values()]
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()
}

function isBusiness(collection: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(collection) && !/^(nivaro|directus)_/i.test(collection)
}

async function isAdminUser(user: User): Promise<boolean> {
  const { isAdminRole } = await import('./user-scopes.js')
  return isAdminRole(user.role)
}

async function labelsFor(collection: string, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {}
  try {
    const { getLabels } = await import('./queues.js')
    const raw = await getLabels(new Map([[collection, new Set(ids)]]))
    const out: Record<string, string> = {}
    for (const id of ids) out[id] = raw[`${collection}:${id}`] ?? `#${id}`
    return out
  } catch {
    return Object.fromEntries(ids.map((id) => [id, `#${id}`]))
  }
}

// ─── Record actions: the existing propose_action types ──────────────────────

function actionKind(
  kind: 'bulk_update' | 'create_record' | 'create_task' | 'create_dashboard',
  label: string,
  describe: string
): PlanStepKind {
  const propose = async (user: User, input: Record<string, unknown>): Promise<ProposedStep> => {
    const built = await buildAction(user, { ...input, action_type: kind })
    const p = built.preview
    const summary =
      kind === 'bulk_update'
        ? `Update ${p.count} ${built.collection} record${p.count === 1 ? '' : 's'}`
        : kind === 'create_record'
          ? `Create a ${built.collection} record`
          : kind === 'create_task'
            ? `Create a task on ${p.sample[0]?.label ?? 'the record'}`
            : `Create dashboard “${String(p.changes?.name ?? '')}”`
    return {
      payload: { collection: built.collection, ...built.payload },
      preview: { ...p, summary },
      targets: built.targets ?? null
    }
  }
  return {
    kind,
    label,
    describe,
    propose,
    async execute(user, payload) {
      // The extra `collection` key is harmless to every action (a task's own
      // payload carries it anyway).
      const result = await runAction(user, kind, str(payload.collection), payload)
      if (kind === 'bulk_update') {
        const updated = Number(result.updated ?? 0)
        const failed = Number(result.failed ?? 0)
        return {
          ok: failed === 0,
          result,
          records_changed: updated,
          error: failed
            ? `${failed} of ${updated + failed} record(s) refused: ${((result.errors as string[]) ?? []).slice(0, 3).join('; ')}`
            : undefined
        }
      }
      return { ok: true, result, records_changed: kind === 'create_dashboard' ? 0 : 1 }
    },
    narrow:
      kind === 'bulk_update'
        ? (payload, ids) => {
            const keep = new Set(ids.map(String))
            return {
              ...payload,
              ids: ((payload.ids as string[]) ?? []).filter((id) => keep.has(String(id)))
            }
          }
        : undefined,
    recheck:
      kind === 'bulk_update'
        ? async (user, step, last) => {
            // Re-resolve the filter as the person NOW; after a partial run
            // only the records that refused are tried again.
            const fresh = await propose(user, step.input)
            const failedIds = Array.isArray(last?.failed_ids) ? (last.failed_ids as string[]) : []
            if (failedIds.length === 0) return fresh
            const keep = new Set(failedIds.map(String))
            const ids = ((fresh.payload.ids as string[]) ?? []).filter((id) => keep.has(String(id)))
            return {
              payload: { ...fresh.payload, ids },
              preview: {
                ...fresh.preview,
                count: ids.length,
                summary: `Retry ${ids.length} ${str(fresh.payload.collection)} record${ids.length === 1 ? '' : 's'} that refused`,
                sample: (fresh.preview.sample ?? []).filter((s) => keep.has(String(s.id)))
              },
              targets: { collection: str(fresh.payload.collection), ids }
            }
          }
        : undefined
  }
}

// ─── send_message: tell people (by name, or the owners of records) ──────────

/** Current owners (+ optionally creators) of records — the same audience
 *  rule as POST /notifications/message-stakeholders. */
export async function recordStakeholders(
  collection: string,
  ids: string[],
  includeCreators: boolean
): Promise<Set<string>> {
  const audience = new Set<string>()
  if (ids.length === 0) return audience
  const instances = (await db('nivaro_workflow_instances')
    .where({ collection })
    .whereIn('item', ids)
    .whereNull('completed_at')
    .select('id', 'item', 'current_state')) as Array<Record<string, unknown>>
  if (instances.length > 0) {
    const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
    const owners = await resolveStateOwnersBatch(
      instances.map((i) => ({
        key: String(i.item),
        stateId: String(i.current_state),
        instanceId: String(i.id),
        collection,
        itemId: String(i.item)
      }))
    )
    for (const list of owners.values()) {
      for (const o of list as Array<{ id: unknown }>) audience.add(String(o.id).toUpperCase())
    }
  }
  if (includeCreators) {
    const cols = (await db('information_schema.columns' as never)
      .where({ table_name: collection })
      .whereIn('column_name', ['user_created', 'creator'])
      .select('column_name')) as Array<{ column_name: string }>
    for (const c of cols) {
      const rows = (await db(collection)
        .whereIn('id', ids)
        .whereNotNull(c.column_name)
        .select(c.column_name)) as Array<Record<string, unknown>>
      for (const r of rows) audience.add(String(r[c.column_name]).toUpperCase())
    }
  }
  return audience
}

/** Active, unredacted people among `ids` — never machine accounts. */
async function activePeople(ids: string[]): Promise<Array<{ id: string; name: string }>> {
  if (ids.length === 0) return []
  const rows = (await db('nivaro_users')
    .whereIn('id', ids)
    .where((q) => q.where('is_redacted', false).orWhereNull('is_redacted'))
    .where((q) => q.whereNull('status').orWhereNot('status', 'suspended'))
    .select('id', 'first_name', 'last_name', 'email', 'account_kind')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    account_kind: string | null
  }>
  const { isMachineAccount } = await import('./machine-accounts.js')
  return rows
    .filter((u) => !isMachineAccount(u))
    .map((u) => ({
      id: String(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || String(u.id)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The records whose owners a message goes to, read AS THE PERSON. */
async function visibleRecordIds(
  user: User,
  collection: string,
  spec: Record<string, unknown>
): Promise<string[]> {
  if (!isBusiness(collection)) throw new Error('Invalid collection for owners_of')
  if (!(await can(user, 'read', collection))) throw new Error(`You cannot read ${collection}`)
  const ids = Array.isArray(spec.ids) ? spec.ids.map(String).slice(0, 200) : []
  const filter =
    ids.length > 0
      ? { id: { _in: ids } }
      : spec.filter && typeof spec.filter === 'object'
        ? (spec.filter as Record<string, unknown>)
        : null
  if (!filter) throw new Error('owners_of needs ids or a filter')
  const res = (await readItems(user, collection, { filter, fields: ['id'], limit: 201 })) as {
    data?: Array<Record<string, unknown>>
  }
  const rows = res.data ?? []
  if (rows.length === 0) throw new Error(`owners_of matches no ${collection} records you can read`)
  if (rows.length > 200) throw new Error('owners_of matches more than 200 records — narrow it')
  return rows.map((r) => String(r.id))
}

const sendMessageKind: PlanStepKind = {
  kind: 'send_message',
  label: 'Send a message',
  describe:
    'send_message: {subject, message, to?: [person ids, emails or full names], owners_of?: {collection, ids? | filter?}, include_creators?: boolean} — an in-app notification from the person to named people and/or the CURRENT owners of records (resolved again when the step runs).',
  async propose(user, input) {
    const subject = str(input.subject).slice(0, 200)
    const message = str(input.message).slice(0, 4000)
    if (!subject || !message) throw new Error('send_message needs a subject and a message')
    const { findPerson } = await import('./ai-actions.js')
    const people: string[] = []
    for (const ref of (Array.isArray(input.to) ? input.to : []).slice(0, 25)) {
      people.push((await findPerson(String(ref))).id.toUpperCase())
    }
    let ownersOf: { collection: string; ids: string[]; include_creators: boolean } | null = null
    const recipients = new Set(people)
    if (input.owners_of && typeof input.owners_of === 'object') {
      const spec = input.owners_of as Record<string, unknown>
      const collection = str(spec.collection)
      const ids = await visibleRecordIds(user, collection, spec)
      ownersOf = { collection, ids, include_creators: input.include_creators === true }
      for (const id of await recordStakeholders(collection, ids, ownersOf.include_creators))
        recipients.add(id)
    }
    recipients.delete(String(user.id).toUpperCase())
    if (people.length === 0 && !ownersOf) throw new Error('send_message needs `to` or `owners_of`')
    const list = await activePeople([...recipients])
    return {
      payload: { subject, message, people, owners_of: ownersOf },
      preview: {
        summary: `Message ${list.length} ${list.length === 1 ? 'person' : 'people'}: “${subject}”`,
        count: list.length,
        changes: { Subject: subject, Message: message.slice(0, 300) },
        recipients: list.slice(0, 20)
      },
      targets: ownersOf ? { collection: ownersOf.collection, ids: ownersOf.ids } : null
    }
  },
  async execute(user, payload) {
    const recipients = new Set(((payload.people as string[]) ?? []).map((x) => x.toUpperCase()))
    const ownersOf = payload.owners_of as {
      collection: string
      ids: string[]
      include_creators: boolean
    } | null
    if (ownersOf) {
      for (const id of await recordStakeholders(
        ownersOf.collection,
        ownersOf.ids,
        ownersOf.include_creators
      ))
        recipients.add(id)
    }
    recipients.delete(String(user.id).toUpperCase())
    const list = await activePeople([...recipients])
    const app = getApp()
    if (!app) throw new Error('Messaging is not available right now')
    const { notifyUser } = await import('./notification-channels.js')
    let sent = 0
    for (const p of list) {
      await notifyUser(app, p.id, {
        subject: str(payload.subject),
        message: str(payload.message),
        sender: user.id,
        collection: ownersOf?.collection ?? null,
        item: ownersOf && ownersOf.ids.length === 1 ? ownersOf.ids[0] : null,
        source: { kind: 'ai-plan', label: 'Ask AI plan' }
      })
      sent++
    }
    return {
      ok: true,
      result: { sent, recipients: list.slice(0, 50) },
      records_changed: 0
    }
  },
  narrow(payload, ids) {
    const o = payload.owners_of as { ids: string[] } | null
    if (!o) return payload
    const keep = new Set(ids.map(String))
    return { ...payload, owners_of: { ...o, ids: o.ids.filter((id) => keep.has(String(id))) } }
  }
}

// ─── post_chat: a message in a chat room the person can see ────────────────

const postChatKind: PlanStepKind = {
  kind: 'post_chat',
  label: 'Post to a chat room',
  describe:
    'post_chat: {room, message} — a chat message from the person in a room they can see (room key like "global", "ch:<key>", or a record room).',
  async propose(user, input) {
    const room = str(input.room)
    const message = str(input.message).slice(0, 8000)
    if (!room || !message) throw new Error('post_chat needs a room and a message')
    const { canSeeRoom } = await import('./chat.js')
    if (!(await canSeeRoom(user, room))) throw new Error('That chat room is not available to you')
    return {
      payload: { room, message },
      preview: { summary: `Post in ${room}`, count: 1, changes: { Room: room, Message: message } }
    }
  },
  async execute(user, payload) {
    const app = getApp()
    if (!app) throw new Error('Chat is not available right now')
    const { postChatMessage } = await import('./chat-send.js')
    const row = await postChatMessage(
      app,
      { user, isAdmin: await isAdminUser(user) },
      { room: str(payload.room), message: str(payload.message) }
    )
    return { ok: true, result: { message_id: row.id, room: row.room }, records_changed: 0 }
  }
}

// ─── run_flow: a manual flow (administrators — the flows API is theirs) ────

const runFlowKind: PlanStepKind = {
  kind: 'run_flow',
  label: 'Run a flow',
  describe:
    'run_flow: {flow: flow id or exact name, payload?: object} — run an ACTIVE manual flow (administrators only).',
  async propose(user, input) {
    if (!(await isAdminUser(user))) throw new Error('Only administrators can run flows')
    const ref = str(input.flow)
    if (!ref) throw new Error('run_flow needs a flow')
    const flow = (await db('nivaro_flows')
      .where((q) => {
        if (/^[0-9a-f-]{36}$/i.test(ref)) q.where('id', ref)
        else q.whereRaw('LOWER(name) = ?', [ref.toLowerCase()])
      })
      .first('id', 'name', 'description', 'status', 'trigger')) as
      | { id: string; name: string; description: string | null; status: string; trigger: string }
      | undefined
    if (!flow) throw new Error(`No flow named "${ref}"`)
    if (flow.status !== 'active') throw new Error(`Flow "${flow.name}" is not active`)
    if (flow.trigger !== 'manual') throw new Error(`Flow "${flow.name}" is not a manual flow`)
    const payload =
      input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : {}
    return {
      payload: { flow_id: flow.id, flow_name: flow.name, data: payload },
      preview: {
        summary: `Run the flow “${flow.name}”`,
        count: 1,
        changes: { Flow: flow.name, ...(flow.description ? { About: flow.description } : {}) }
      }
    }
  },
  async execute(user, payload, ctx) {
    if (!(await isAdminUser(user))) throw new Error('Only administrators can run flows')
    const flowId = str(payload.flow_id)
    const flow = (await db('nivaro_flows').where({ id: flowId }).first('name', 'status')) as
      | { name: string; status: string }
      | undefined
    if (flow?.status !== 'active') throw new Error('The flow is no longer active')
    const app = getApp()
    const { executeFlow } = await import('./flow-executor.js')
    const started = new Date(Date.now() - 1000)
    await executeFlow({
      flowId,
      flowName: flow.name,
      trigger: 'manual',
      payload: {
        ...((payload.data as Record<string, unknown>) ?? {}),
        $plan: { plan_id: ctx.planId, step_id: ctx.stepId }
      },
      log: app?.log ?? console,
      userId: user.id
    })
    const run = (await db('nivaro_flow_runs')
      .where({ flow: flowId })
      .where('started_at', '>=', started)
      .orderBy('started_at', 'desc')
      .first('id', 'status', 'error_message')
      .catch(() => undefined)) as
      | { id: string; status: string; error_message: string | null }
      | undefined
    const failed = run?.status === 'error'
    return {
      ok: !failed,
      result: { flow_run: run?.id ?? null, status: run?.status ?? 'unknown' },
      records_changed: 0,
      error: failed ? `The flow failed: ${run?.error_message ?? 'see its run history'}` : undefined
    }
  }
}

registerPlanStepKind(
  actionKind(
    'bulk_update',
    'Update records',
    'bulk_update: {collection, filter (query_items shape), changes (field: value)}'
  )
)
registerPlanStepKind(
  actionKind('create_record', 'Create a record', 'create_record: {collection, data (field: value)}')
)
registerPlanStepKind(
  actionKind(
    'create_task',
    'Create a task',
    'create_task: {task: {collection, id, title, assignee, due_date, priority}}'
  )
)
registerPlanStepKind(
  actionKind(
    'create_dashboard',
    'Create a dashboard',
    'create_dashboard: {dashboard: {name, widgets:[…same as propose_action…]}}'
  )
)
registerPlanStepKind(sendMessageKind)
registerPlanStepKind(postChatKind)
registerPlanStepKind(runFlowKind)

// ─── Conditions (#1953) ─────────────────────────────────────────────────────

/** Values compare as people read them: null and '' agree, numbers numerically. */
export function sameValue(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) => v == null || v === ''
  if (blank(a) || blank(b)) return blank(a) && blank(b)
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '')
    return na === nb
  return String(a) === String(b)
}

/** Which records a condition checks: its own, else the step's targets. */
export function conditionTargets(
  step: Pick<PlanStepDef, 'condition' | 'targets'>
): { collection: string; ids: string[]; own: boolean } | null {
  const c = step.condition
  if (!c) return null
  if (c.collection && Array.isArray(c.ids) && c.ids.length > 0)
    return { collection: c.collection, ids: c.ids.map(String), own: false }
  if (step.targets && step.targets.ids.length > 0)
    return { collection: step.targets.collection, ids: step.targets.ids, own: true }
  return null
}

/** Read the condition's records AS THE PERSON: the ids that pass `where`
 *  (RLS applies — a record they can no longer see does not pass), with the
 *  `unchanged` fields. */
async function readConditionRows(
  user: User,
  collection: string,
  ids: string[],
  cond: PlanStepCondition
): Promise<Map<string, Record<string, unknown>>> {
  const { compileChatFilterFor } = await import('./ai-chat.js')
  const conditions = await compileChatFilterFor(collection, cond.where ?? null)
  conditions.push({ path: ['id'], op: '_in', value: ids } as never)
  const fields = ['id', ...(cond.unchanged ?? [])]
  const fakeReq = { query: { conditions: JSON.stringify(conditions) } } as never
  const res = (await readItems(user, collection, { fields, limit: ids.length + 1 }, fakeReq)) as {
    data?: Array<Record<string, unknown>>
  }
  return new Map((res.data ?? []).map((r) => [String(r.id), r]))
}

/** Validate a condition when the plan is proposed, and snapshot the
 *  `unchanged` fields as the person sees them now. */
export async function prepareCondition(
  user: User,
  raw: unknown,
  targets: { collection: string; ids: string[] } | null | undefined
): Promise<PlanStepCondition | null> {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('condition must be an object')
  const r = raw as Record<string, unknown>
  const cond: PlanStepCondition = {}
  if (r.label) cond.label = str(r.label).slice(0, 200)
  if (r.collection) {
    cond.collection = str(r.collection)
    if (!isBusiness(cond.collection)) throw new Error('condition.collection is invalid')
    const idList = Array.isArray(r.ids) ? r.ids : r.id != null ? [r.id] : []
    cond.ids = idList.map(String).slice(0, 200)
    if (cond.ids.length === 0) throw new Error('condition.collection needs id or ids')
  }
  if (r.where != null) {
    if (typeof r.where !== 'object' || Array.isArray(r.where))
      throw new Error('condition.where must be a filter object')
    cond.where = r.where as Record<string, unknown>
  }
  if (Array.isArray(r.unchanged)) cond.unchanged = r.unchanged.map(String).slice(0, 10)
  if (!cond.where && !cond.unchanged?.length) throw new Error('condition needs where or unchanged')
  const t = conditionTargets({ condition: cond, targets: targets ?? null })
  if (!t)
    throw new Error(
      'condition needs records: give condition.collection + id, or use it on a step that acts on records'
    )
  if (!(await can(user, 'read', t.collection))) throw new Error(`You cannot read ${t.collection}`)
  if (cond.unchanged?.length) {
    const { chatFieldSet } = await import('./ai-chat.js')
    const valid = await chatFieldSet(t.collection)
    const bad = cond.unchanged.filter((f) => !valid.has(f))
    if (bad.length) throw new Error(`condition.unchanged names unknown field(s): ${bad.join(', ')}`)
    const rows = await readConditionRows(user, t.collection, t.ids, { unchanged: cond.unchanged })
    cond.snapshot = {}
    for (const [id, row] of rows) {
      cond.snapshot[id] = Object.fromEntries(cond.unchanged.map((f) => [f, row[f] ?? null]))
    }
  } else {
    // Compile now so a bad filter is the model's error at propose time.
    const { compileChatFilterFor } = await import('./ai-chat.js')
    await compileChatFilterFor(t.collection, cond.where)
  }
  return cond
}

/** Check a step's condition when it is about to run. A per-record check on
 *  a step's own targets narrows the step when its kind can; otherwise the
 *  whole step runs only when every record passes. */
export async function checkStepCondition(user: User, step: PlanStepDef): Promise<ConditionOutcome> {
  const cond = step.condition
  const t = conditionTargets(step)
  if (!cond || !t) return { pass: true }
  const rows = await readConditionRows(user, t.collection, t.ids, cond)
  const labels = await labelsFor(t.collection, t.ids)
  const failing: PlanSkippedRecord[] = []
  const passing: string[] = []
  const what = cond.label ? `not ${cond.label.replace(/^only if\s+/i, '')}` : 'condition not met'
  for (const id of t.ids) {
    const row = rows.get(id)
    if (!row) {
      failing.push({
        id,
        label: labels[id],
        reason: cond.where ? what : 'no longer visible to you'
      })
      continue
    }
    const before = cond.snapshot?.[id]
    const changed = (cond.unchanged ?? []).find((f) => before && !sameValue(before[f], row[f]))
    if (changed) {
      failing.push({
        id,
        label: labels[id],
        reason: `${changed} changed since the plan was made (was ${JSON.stringify(before?.[changed] ?? null)}, now ${JSON.stringify(row[changed] ?? null)})`
      })
      continue
    }
    passing.push(id)
  }
  if (failing.length === 0) return { pass: true }
  const kind = getPlanStepKind(step.kind)
  if (t.own && kind?.narrow && passing.length > 0) {
    return {
      pass: true,
      payload: kind.narrow(step.payload, passing),
      skipped_records: failing
    }
  }
  const first = failing[0]
  return {
    pass: false,
    reason:
      failing.length === 1
        ? `${first.label ?? first.id}: ${first.reason}`
        : `${failing.length} of ${t.ids.length} records failed the condition (${first.label ?? first.id}: ${first.reason})`,
    skipped_records: failing
  }
}
