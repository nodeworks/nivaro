/**
 * Move a record to a named pipeline step on an ordinary UPDATE (2026-11-18).
 *
 * An integration that knows where its record now stands (LinX cancels a
 * workflow: `update_workflows_item(id: 373049, data: {_state: "canceled"})`)
 * names the TARGET step on the update instead of a transition id:
 *   - REST `PATCH /api/items/:collection/:id` body key `$state` (or `?state=`),
 *     and `$state` on each row of `POST /items/:collection/batch`
 *   - GraphQL `update_<c>_item(id, data, state)` — or `data._state`, which is
 *     what LinX sends — and `update_<c>_items(ids, data, state)`,
 *     `update_<c>_batch` rows carrying `_state` / `$state`
 * The value is a step KEY (exact) or a step id of the record's pipeline. An
 * optional note rides `$state_comment` / `state_comment` (a move whose
 * transition requires a note is refused without one).
 *
 * It is not a second way to move a record. The step names WHICH transition:
 * of the template's transitions into the target from the current step (or
 * from any step), a specific from-step comes before "any", a manual one
 * before an automatic one, then the template's order; the first the caller is
 * allowed to run is used. That transition then runs through the very path a
 * person's move takes (runRecordTransition: record access, admin-only and
 * extension refusals, required roles, owner / creator rule, required note,
 * requirements, condition rules, edit lock, background runs, the double-fire
 * guard, actions, history, activity, notifications, realtime, View-as notes).
 *
 * Order (services/items.ts updateOne):
 *   1. planStateMove — record access, binding, instance, target step, the
 *      candidate transitions. Reads only. 400 / 404 / 409 refusals.
 *   2. judgeStateMove — the manual-move gate run as the caller for each
 *      candidate, right before the UPDATE, with the values this update will
 *      store laid over the record (requirements and condition rules read the
 *      record as it WILL be). A refusal refuses the whole request: nothing is
 *      written, fields included.
 *   3. the fields are written through the normal update.
 *   4. runStateMove — the chosen transition through runRecordTransition, which
 *      judges it once more on the record as now stored. If it fails there (a
 *      partner push refuses, someone moved the record in between), the field
 *      changes stay and the answer says the move did not happen and why.
 *
 * The target being the current step is a no-op: no move, no history row; the
 * answer says so. A record whose pipeline has not started is refused
 * (STATE_NOT_STARTED) rather than started here: a start is not a move — no
 * transition, no owner rule, no actions — and creating a record in a step
 * already has its own gated entry (`start_state`, services/start-state.ts).
 */
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { findRecordInstance } from './branch-instances.js'
import { assertInstanceAccess } from './instance-guard.js'
import {
  type GateInstance,
  type GateTransition,
  manualTransitionRefusal,
  type TransitionRefusal
} from './manual-transition-gate.js'
import { resolvePipelineSubject } from './pipeline-subject.js'
import { lockActorFor, runRecordTransition, serverMoveLog } from './record-transition.js'
import type { PendingLinks } from './transition-requirements.js'

/** The payload key an update names its target step with (REST, GraphQL `data`). */
export const STATE_KEY = '$state'
/** The note the move carries (a transition with comment_mode 'required' needs one). */
export const STATE_COMMENT_KEY = '$state_comment'
/** GraphQL input names cannot start with `$`: `data._state` is the same thing. */
export const GRAPHQL_STATE_KEY = '_state'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const on = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

/** A refused step change. statusCode + code, so REST, GraphQL and the batch
 *  surfaces answer it as the caller's refusal, never a 500. The detail keys
 *  (value, current, target, meta, requirements) ride the REST error body. */
export class UpdateStateRefusal extends Error {
  statusCode: number
  code: string
  value?: string
  current?: string | null
  target?: string
  requirements?: unknown
  meta?: Record<string, unknown>
  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: {
      value?: string
      current?: string | null
      target?: string
      requirements?: unknown
      meta?: Record<string, unknown>
    } = {}
  ) {
    super(message)
    this.name = 'UpdateStateRefusal'
    this.statusCode = statusCode
    this.code = code
    Object.assign(this, details)
  }
}

export interface StepRef {
  key: string
  label: string
}

/** What happened to the step an update named — `meta.state` on REST. */
export interface StateMoveOutcome {
  /**
   * What happened, in one word: `moved`; `unchanged` (it already stood in the step);
   * `refused_after_write` (the fields were saved, then the move itself did not go
   * through — `reason` says why). A refusal BEFORE the write is an error, never an outcome.
   */
  result: 'moved' | 'unchanged' | 'refused_after_write'
  /** The record moved (it may have come to rest past the target: skip rules, automatic moves). */
  moved: boolean
  /** It already stood in the named step: nothing moved, no history row. */
  already?: boolean
  target: StepRef
  from?: StepRef | null
  /** Where the record stands now. */
  to?: StepRef | null
  transition?: { id: string; label: string }
  /** The move did not happen after the fields were saved: why, in the move's own words. */
  reason?: string
  status?: number
  code?: string
  error?: string
  /** Set with a move that did not happen: the update's own field changes were saved. */
  fields_saved?: boolean
}

interface StepRow {
  id: string
  key: string
  label: string | null
}

interface PlanInstance {
  id: string
  collection: string
  item: string
  template: string
  current_state: string | null
  completed_at: Date | string | null
}

export interface CandidateTransition extends GateTransition {
  label: string
  sort?: number | null
  to_previous?: boolean | number | null
}

export interface StatePlan {
  collection: string
  item: string
  value: string
  instance: PlanInstance
  current: StepRow | null
  target: StepRow
  /** The record already stands in the target step. */
  noop: boolean
  /** In the order they are tried; empty for a no-op. */
  candidates: CandidateTransition[]
}

/** A step value as a plain trimmed string; null when none was given. */
export function normalizeStateValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  // The READ shape of `$state` ({key, label, …}) echoed back by a client that
  // saves the record it read is never a move: a record moved by someone else
  // in between would be moved back.
  if (typeof value === 'object') return null
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new UpdateStateRefusal(
      400,
      'STATE_INVALID',
      'The step must be the key of a step in the pipeline.'
    )
  }
  const s = String(value).trim()
  if (s === '') return null
  if (s.length > 100) {
    throw new UpdateStateRefusal(
      400,
      'STATE_INVALID',
      'The step must be the key of a step in the pipeline.'
    )
  }
  return s
}

function noteOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The step (and note) an update payload names, taken OFF the payload — they
 * are never columns. `$state` only; GraphQL's `_state` is mapped by its resolver.
 */
export function takeUpdateState(payload: Record<string, unknown> | null | undefined): {
  value: string | null
  comment: string | null
} {
  if (!payload || typeof payload !== 'object') return { value: null, comment: null }
  const raw = payload[STATE_KEY]
  const rawComment = payload[STATE_COMMENT_KEY]
  delete payload[STATE_KEY]
  delete payload[STATE_COMMENT_KEY]
  return { value: normalizeStateValue(raw), comment: noteOf(rawComment) }
}

/**
 * GraphQL: the step named by the `state` argument and/or `data._state`.
 * `_state` is the step only when the collection runs a pipeline and has no
 * field of its own named `_state` (else it stays a field, as before). Both
 * given and different → 400 STATE_CONFLICT. Takes `_state` off `data`.
 */
export async function graphqlStateFor(input: {
  collection: string
  data: Record<string, unknown>
  arg: unknown
  ownStateField: boolean
}): Promise<string | null> {
  const { collection, data, ownStateField } = input
  const fromArg = normalizeStateValue(input.arg)
  let fromData: string | null = null
  if (!ownStateField && data && typeof data === 'object' && GRAPHQL_STATE_KEY in data) {
    const bound = await db('nivaro_workflow_bindings')
      .where({ collection })
      .first('template')
      .catch(() => undefined)
    if (bound) {
      fromData = normalizeStateValue(data[GRAPHQL_STATE_KEY])
      delete data[GRAPHQL_STATE_KEY]
    }
  }
  if (fromArg && fromData && fromArg !== fromData) {
    throw new UpdateStateRefusal(
      400,
      'STATE_CONFLICT',
      `The state argument ("${fromArg}") and data._state ("${fromData}") name different steps. Send one.`
    )
  }
  return fromArg ?? fromData
}

/**
 * The transitions an update may use to reach the target, in the order they are
 * tried. SPECIFIC FIRST, AND ONLY: when a move leads from the current step to the
 * target, only those moves are candidates — a from-any move ("Cancel Workflow"
 * from any step) is used only when no move from the current step exists, so a
 * caller refused the specific move is refused, never routed around it. A
 * return-to-previous move is left out (where it lands depends on history).
 * Within the set: a manual move before an automatic one, then the template's
 * order and the label. Pure.
 */
export function orderCandidates<T extends CandidateTransition>(
  rows: T[],
  currentId: string | null
): T[] {
  // Automatic moves belong to the engine (never a person's), and a return-to-previous
  // move lands by history: both go BEFORE the specific/any split, so an automatic
  // step→target move never shuts out a manual any→target one.
  const usable = rows.filter((t) => !on(t.to_previous) && !on(t.auto_trigger))
  const specific = usable.filter((t) => t.from_state != null && sameId(t.from_state, currentId))
  const pool = specific.length > 0 ? specific : usable.filter((t) => t.from_state == null)
  return pool.sort(
    (a, b) =>
      Number(a.sort ?? 0) - Number(b.sort ?? 0) ||
      String(a.label ?? '').localeCompare(String(b.label ?? ''))
  )
}

const refOf = (s: StepRow | null | undefined): StepRef | null =>
  s ? { key: String(s.key), label: String(s.label ?? s.key) } : null

/**
 * Step 1: where the record stands, where the caller wants it and which moves
 * could take it there. Reads only; throws UpdateStateRefusal (or the record
 * access refusal) when there is nothing to judge.
 */
export async function planStateMove(input: {
  user: User
  isAdmin: boolean
  collection: string
  item: string | number
  value: string
}): Promise<StatePlan> {
  const { user, isAdmin, collection, value } = input
  const item = String(input.item)
  // Update permission + visibility first: nothing about a record the caller
  // cannot reach — the same gate a manual move opens with.
  await assertInstanceAccess(user, isAdmin, collection, item)

  const binding = await db('nivaro_workflow_bindings').where({ collection }).first('template')
  if (!binding) {
    throw new UpdateStateRefusal(
      400,
      'STATE_NOT_BOUND',
      `${collection} runs no pipeline, so a record cannot be moved to a step.`,
      { value }
    )
  }
  const instance = await findRecordInstance<PlanInstance>(collection, item)
  if (!instance) {
    throw new UpdateStateRefusal(
      409,
      'STATE_NOT_STARTED',
      `This record's pipeline has not started, so it cannot be moved to "${value}". Start the pipeline first (a new record can be created in a step with start_state).`,
      { value }
    )
  }
  const states = (await db('nivaro_workflow_states')
    .where({ template: instance.template })
    .select('id', 'key', 'label', 'sort')) as Array<StepRow & { sort?: number | null }>
  states.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
  // A key matches exactly (the column's collation would match any case); a
  // step id matches as an id.
  const target =
    states.find((s) => String(s.key) === value) ??
    (UUID_RE.test(value) ? states.find((s) => sameId(s.id, value)) : undefined)
  if (!target) {
    const keys = states.map((s) => String(s.key))
    throw new UpdateStateRefusal(
      400,
      'STATE_UNKNOWN',
      `The ${collection} pipeline has no step "${value}". Its steps are: ${keys.join(', ')}.`,
      { value, meta: { valid_states: keys } }
    )
  }
  const current = states.find((s) => sameId(s.id, instance.current_state)) ?? null
  const base = { collection, item, value, instance, current, target }
  if (current && sameId(current.id, target.id)) return { ...base, noop: true, candidates: [] }

  const rows = (await db('nivaro_workflow_transitions')
    .where({ template: instance.template, to_state: target.id })
    .select('*')) as CandidateTransition[]
  const candidates = orderCandidates(rows, instance.current_state)
  if (candidates.length === 0) {
    const from = current ? `"${current.label ?? current.key}"` : 'where it stands'
    throw new UpdateStateRefusal(
      409,
      'NO_TRANSITION',
      `No move takes this record from ${from} to "${target.label ?? target.key}".`,
      { value, current: current ? String(current.key) : null, target: String(target.key) }
    )
  }
  return { ...base, noop: false, candidates }
}

/** The manual gate's answers have no codes for some refusals: these do. */
function codeFor(status: number, message: string): string {
  if (message === 'Pipeline is already completed') return 'PIPELINE_COMPLETED'
  if (message === 'Automatic transitions cannot be executed manually') return 'TRANSITION_AUTOMATIC'
  if (message === 'Transition is not valid from the current state') return 'TRANSITION_NOT_VALID'
  if (message === 'Transition conditions not met') return 'TRANSITION_CONDITIONS'
  if (status === 403) return 'TRANSITION_FORBIDDEN'
  if (status === 409) return 'TRANSITION_CONFLICT'
  return 'TRANSITION_REFUSED'
}

/** A requirements refusal in a sentence: the titles of what is missing. */
function requirementsSentence(targetLabel: string, requirements: unknown): string {
  const titles = Array.isArray(requirements)
    ? [
        ...new Set(
          (requirements as Array<{ title?: unknown; optional?: unknown }>)
            .filter((r) => r && r.optional !== true && typeof r.title === 'string')
            .map((r) => String(r.title))
        )
      ]
    : []
  const what = titles.length > 0 ? `: ${titles.join('; ')}` : ''
  return `Moving to "${targetLabel}" needs information this record does not have yet${what}.`
}

/** The manual gate's refusal as the update's refusal: same status, code and words. */
export function refusalFromGate(
  refusal: TransitionRefusal,
  plan: Pick<StatePlan, 'value' | 'current' | 'target'>,
  transition: Pick<CandidateTransition, 'id' | 'label'>
): UpdateStateRefusal {
  const body = refusal.body as {
    error?: unknown
    code?: unknown
    requirements?: unknown
  } & Record<string, unknown>
  const raw = typeof body.error === 'string' ? body.error : 'This move is not allowed.'
  const targetLabel = String(plan.target.label ?? plan.target.key)
  const isRequirements = raw === 'TRANSITION_REQUIREMENTS'
  const message = isRequirements ? requirementsSentence(targetLabel, body.requirements) : raw
  const code =
    typeof body.code === 'string'
      ? body.code
      : isRequirements
        ? 'TRANSITION_REQUIREMENTS'
        : codeFor(refusal.status, raw)
  const extra: Record<string, unknown> = {}
  for (const k of ['locked_by_name', 'run', 'first']) if (body[k] !== undefined) extra[k] = body[k]
  return new UpdateStateRefusal(refusal.status, code, message, {
    value: plan.value,
    current: plan.current ? String(plan.current.key) : null,
    target: String(plan.target.key),
    ...(isRequirements ? { requirements: body.requirements } : {}),
    meta: { transition: { id: String(transition.id), label: transition.label }, ...extra }
  })
}

/** Alias M2M writes (items.ts) as the requirements overlay reads them. */
export function pendingLinksOf(
  writes: Array<{
    field: string
    links: Array<{ id: string | number }>
    removals: Array<{ id: string | number }>
    set: boolean
  }>
): PendingLinks {
  const out: PendingLinks = {}
  for (const w of writes)
    out[w.field] = {
      add: w.links.map((l) => l.id),
      remove: w.removals.map((l) => l.id),
      set: w.set
    }
  return out
}

/**
 * Step 2: the first candidate the caller may run, judged by the manual-move
 * gate as the caller — with `pending` (the values this update will store)
 * laid over the record. Throws the best candidate's refusal when none may
 * run. Reads only; call it right before the update writes.
 */
export async function judgeStateMove(
  plan: StatePlan,
  input: {
    user: User
    isAdmin: boolean
    req?: FastifyRequest
    comment?: string | null
    pending?: Record<string, unknown>
    pendingLinks?: PendingLinks
    /** The same request writes child rows (nested O2M): checks that read children wait. */
    nestedWrites?: boolean
    log?: Pick<FastifyBaseLogger, 'warn'>
  }
): Promise<CandidateTransition> {
  const { user, isAdmin, req } = input
  const { collection, item } = plan
  // Someone else is editing it right now: refused before anything is written,
  // with the edit lock's own words (integrations and apps hold no locks).
  const lockActor = lockActorFor({ user, req })
  if (lockActor) {
    const { editLockRefusal } = await import('./item-lock-guard.js')
    const held = await editLockRefusal(lockActor, collection, item).catch(() => null)
    if (held) {
      const body = held.body as Record<string, unknown>
      throw new UpdateStateRefusal(
        held.status,
        String(body.code ?? 'RECORD_LOCKED'),
        String(body.error ?? 'Someone else is editing this record right now.'),
        {
          value: plan.value,
          target: String(plan.target.key),
          meta: { locked_by_name: body.locked_by_name ?? null }
        }
      )
    }
  }
  // An addendum's rules read its parent: the update's own values are not the parent's.
  const subject = await resolvePipelineSubject(collection, item)
  const overlay =
    subject.collection === collection
      ? {
          ...(input.pending ? { pending: input.pending } : {}),
          ...(input.pendingLinks ? { pendingLinks: input.pendingLinks } : {})
        }
      : {}
  const refusals: Array<{ refusal: TransitionRefusal; transition: CandidateTransition }> = []
  for (const transition of plan.candidates) {
    const refusal = await manualTransitionRefusal({
      user,
      isAdmin,
      collection,
      item,
      instance: plan.instance as unknown as GateInstance,
      // The record's own values are laid over it; child rows and related records are
      // not. Checks that read those wait for the judgment after the write.
      transition: preWriteTransition(transition, input.nestedWrites === true),
      comment: input.comment ?? null,
      ...(input.log ? { log: input.log } : {}),
      ...overlay
    })
    if (!refusal) return transition
    refusals.push({ refusal, transition })
  }
  const best = refusals[0]
  throw refusalFromGate(best.refusal, plan, best.transition)
}

const quietLog = serverMoveLog

const DOTTED_FIELD_RE = /"field"\s*:\s*"[^"]*\./

/** Requirements without their child_fields entries (they read child rows). */
export function withoutChildFieldRequirements(requirements: string | null | undefined) {
  if (!requirements) return requirements ?? null
  try {
    const parsed = JSON.parse(requirements)
    if (!Array.isArray(parsed)) return requirements
    const kept = parsed.filter(
      (e) => !(e && typeof e === 'object' && (e as { type?: unknown }).type === 'child_fields')
    )
    if (kept.length === parsed.length) return requirements
    return kept.length > 0 ? JSON.stringify(kept) : null
  } catch {
    return requirements
  }
}

/**
 * The transition as the PRE-write judgment asks about it. The update's own column
 * values are laid over the record, but child rows (child_fields requirements) and
 * related records (dotted condition paths) are read as stored — and when the same
 * request writes child rows, condition rules may read rollups of them too. Those
 * checks are left to the judgment runRecordTransition makes after the write, so a
 * request that adds the lines a move needs is not refused for lacking them. Pure.
 */
export function preWriteTransition<T extends CandidateTransition>(
  transition: T,
  nestedWrites: boolean
): T {
  const requirements = withoutChildFieldRequirements(transition.requirements)
  const rules = transition.condition_rules
  const deferConditions = !!rules && (nestedWrites || DOTTED_FIELD_RE.test(String(rules)))
  if (requirements === transition.requirements && !deferConditions) return transition
  return { ...transition, requirements, ...(deferConditions ? { condition_rules: null } : {}) }
}

/**
 * A connected app (MCP) whose tool list leaves out `transition` may not move a record
 * by naming a step on an update either (2026-11-18 review): same tool, same limit.
 */
export function assertMayMoveByUpdate(req: FastifyRequest | undefined): void {
  const tools = req?.mcpScope?.tools
  if (Array.isArray(tools) && !tools.includes('transition')) {
    throw new UpdateStateRefusal(
      403,
      'MCP_TOOL_NOT_ALLOWED',
      'This connection may not move records between steps: its tools do not include transition. Ask an administrator to add the transition tool to the connection, or update the record without $state.'
    )
  }
}

/** A writer that does not take step changes got `$state` / `_state`: refused, never a move. */
export function stateNotAcceptedHere(key: string): UpdateStateRefusal {
  return new UpdateStateRefusal(
    400,
    'STATE_NOT_ALLOWED_HERE',
    `"${key}" is not a field this write takes: a step change goes through PATCH /api/items/:collection/:id ($state), the batch and bulk item routes, the GraphQL update mutations, or a transition.`
  )
}

/** The no-op answer: the record already stands in the named step. */
export function alreadyThere(plan: StatePlan): StateMoveOutcome {
  const target = refOf(plan.target) as StepRef
  return { result: 'unchanged', moved: false, already: true, target, from: target, to: target }
}

/**
 * Step 4: run the chosen transition through the manual-move path. Never
 * throws for a refused move: the update's fields are already saved, so the
 * answer says the move did not happen and why.
 */
export async function runStateMove(
  plan: StatePlan,
  transition: CandidateTransition,
  input: {
    user: User
    isAdmin: boolean
    req?: FastifyRequest
    comment?: string | null
    log?: FastifyBaseLogger
    /** False when the update wrote nothing (a step change alone). */
    fieldsWritten?: boolean
  }
): Promise<StateMoveOutcome> {
  const target = refOf(plan.target) as StepRef
  const from = refOf(plan.current)
  const ref = { id: String(transition.id), label: String(transition.label) }
  const log = input.log ?? input.req?.log ?? quietLog
  let r: { status: number; body: unknown }
  try {
    r = await runRecordTransition({
      user: input.user,
      isAdmin: input.isAdmin,
      collection: plan.collection,
      item: plan.item,
      transitionId: String(transition.id),
      comment: input.comment ?? null,
      log,
      ...(input.req ? { req: input.req } : {})
    })
  } catch (err) {
    // Not a refusal: the move broke. The fields are saved either way, so this is
    // reported like a refusal (the log keeps the error), never a bare 500.
    log.error({ err, collection: plan.collection, item: plan.item }, 'update step change failed')
    const e = err as { statusCode?: unknown; code?: unknown }
    r = {
      status: typeof e?.statusCode === 'number' ? e.statusCode : 500,
      body: {
        error: 'The move ran into a problem.',
        code:
          typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code)
            ? e.code
            : 'TRANSITION_FAILED'
      }
    }
  }
  if (r.status >= 200 && r.status < 300) {
    const data = (r.body as { data?: { new_state?: StepRow | null } } | null)?.data
    return {
      result: 'moved',
      moved: true,
      target,
      from,
      to: refOf(data?.new_state ?? plan.target),
      transition: ref
    }
  }
  const body = (r.body ?? {}) as { error?: unknown; code?: unknown; requirements?: unknown }
  const raw = typeof body.error === 'string' ? body.error : 'The move was refused.'
  const reason =
    raw === 'TRANSITION_REQUIREMENTS' ? requirementsSentence(target.label, body.requirements) : raw
  const saved = input.fieldsWritten !== false
  return {
    result: 'refused_after_write',
    moved: false,
    target,
    from,
    to: from,
    transition: ref,
    reason,
    status: r.status,
    code: typeof body.code === 'string' ? body.code : codeFor(r.status, raw),
    error: `${ref.label} did not go through. The record was not moved${saved ? ' (your other changes were saved)' : ''}: ${reason}`,
    ...(saved ? { fields_saved: true } : {})
  }
}

/** A move that did not happen after the fields were saved, as an error (GraphQL). */
export function notMovedError(
  outcome: StateMoveOutcome,
  opts: { fieldsRestored?: boolean } = {}
): UpdateStateRefusal {
  const label = outcome.transition?.label ?? `The move to ${outcome.target.label}`
  const message = opts.fieldsRestored
    ? `${label} did not go through. The record was not moved${outcome.reason ? `: ${outcome.reason}` : '.'}`
    : (outcome.error ?? 'The record was not moved.')
  return new UpdateStateRefusal(
    outcome.status && outcome.status >= 400 && outcome.status < 500 ? outcome.status : 409,
    'STATE_NOT_MOVED',
    message,
    {
      target: outcome.target.key,
      current: outcome.from?.key ?? null,
      meta: {
        fields_saved: opts.fieldsRestored ? false : outcome.fields_saved === true,
        reason_code: outcome.code ?? null,
        ...(outcome.transition ? { transition: outcome.transition } : {})
      }
    }
  )
}
