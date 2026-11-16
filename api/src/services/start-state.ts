/**
 * Create a record in a chosen pipeline step, in one call (2026-11-16).
 *
 * A partner that already knows where its record stands (LinX creates a
 * workflow that is already waiting on manager approval) names the step on
 * the create: REST `POST /api/items/:collection` body key `$start_state` (or
 * `?start_state=`), GraphQL `create_<c>_item(data:…, start_state:…)`. The
 * value is the state KEY; the state id is accepted too.
 *
 * The gate (`resolveStartState`) runs BEFORE the row is written — a refused
 * start never leaves a record behind:
 *   - the collection must be bound to a pipeline (422 START_STATE_NOT_BOUND)
 *   - the state must belong to the bound template (422 START_STATE_UNKNOWN)
 *   - the caller is an administrator, or their role is in the binding's
 *     `start_state_roles` (403 START_STATE_FORBIDDEN), and — for those roles —
 *     the state is in `start_state_allowed` when that list is set
 *     (403 START_STATE_STEP_FORBIDDEN)
 *   - never under View-as for a non-administrator (403 START_STATE_VIEW_AS)
 *
 * The start itself (hooks/pipeline-autostart.ts) writes ONE instance at that
 * state and ONE start history row ("Created in <label>", the caller as actor),
 * in the request, not deferred. It is not a move: no transition, so no
 * transition actions run.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { isAdminRole } from './permissions.js'
import { viewAsAdminOf } from './view-as-attribution.js'

/** The payload key a REST create (or a before-hook) names the start step with. */
export const START_STATE_KEY = '$start_state'
/**
 * A before-hook that maps an integration's own payload to a start step sets
 * this beside it: when the gate refuses THAT step, the record is created as
 * before (initial / auto-start step) instead of the create failing. Only a
 * hook's step is soft; the caller's own `$start_state` is always judged.
 */
export const START_STATE_SOFT_KEY = '$start_state_soft'

export type StartStateCode =
  | 'START_STATE_INVALID'
  | 'START_STATE_NOT_BOUND'
  | 'START_STATE_UNKNOWN'
  | 'START_STATE_FORBIDDEN'
  | 'START_STATE_STEP_FORBIDDEN'
  | 'START_STATE_VIEW_AS'

/** A refused start step. Carries statusCode + code, so routes, GraphQL and
 *  before-hooks all answer it as the caller's refusal, never a 500. */
export class StartStateRefusal extends Error {
  statusCode: number
  code: StartStateCode
  constructor(statusCode: 403 | 422, code: StartStateCode, message: string) {
    super(message)
    this.name = 'StartStateRefusal'
    this.statusCode = statusCode
    this.code = code
  }
}

export interface StartStateTarget {
  template: string
  stateField: string | null
  state: {
    id: string
    key: string
    label: string
    external_label: string | null
    color: string | null
    is_initial: boolean
    is_terminal: boolean
  }
}

/** A start the after-hook fills in once it has written the instance. */
export interface StartStateRun extends StartStateTarget {
  instanceId?: string
  startedAt?: Date
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** The start step a payload names, taken OFF the payload (never a column). */
export function takeStartState(payload: Record<string, unknown> | null | undefined): unknown {
  if (!payload) return undefined
  delete payload[START_STATE_SOFT_KEY]
  if (!(START_STATE_KEY in payload)) return undefined
  const v = payload[START_STATE_KEY]
  delete payload[START_STATE_KEY]
  return v
}

/** Whether a before-hook marked its start step soft (and the marker, taken off). */
export function takeStartStateSoft(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload || !(START_STATE_SOFT_KEY in payload)) return false
  const v = payload[START_STATE_SOFT_KEY]
  delete payload[START_STATE_SOFT_KEY]
  return v === true || v === 1 || v === '1' || v === 'true'
}

/** A start step value as a plain trimmed string; null when none was given. */
export function normalizeStartState(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'object' && !Array.isArray(value)) {
    // `{key}` / `{id}` — the shapes a Directus-era caller sends for a state.
    const o = value as Record<string, unknown>
    return normalizeStartState(o.key ?? o.id ?? null)
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new StartStateRefusal(
      422,
      'START_STATE_INVALID',
      'The start step must be the key of a step in the pipeline.'
    )
  }
  const s = String(value).trim()
  if (s === '') return null
  if (s.length > 100 && !UUID_RE.test(s)) {
    throw new StartStateRefusal(
      422,
      'START_STATE_INVALID',
      'The start step must be the key of a step in the pipeline.'
    )
  }
  return s
}

/** A JSON list column as plain lowercase-trimmed strings (role ids / state keys). */
export function parseIdList(value: unknown): string[] {
  let v = value
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return []
    try {
      v = JSON.parse(t)
    } catch {
      v = t.split(',')
    }
  }
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x ?? '').trim()).filter((x) => x !== ''))]
}

export interface StartStatePolicy {
  isAdmin: boolean
  viewAs: boolean
  role: string | null
  roles: string[]
  allowed: string[]
}

/**
 * Pure: may this caller create a record in `stateKey`? Null = yes, else the
 * refusal. One rule for every surface (REST, GraphQL, before-hooks).
 */
export function startStateRefusalFor(
  policy: StartStatePolicy,
  collection: string,
  state: { key: string; label: string }
): StartStateRefusal | null {
  if (policy.viewAs && !policy.isAdmin) {
    return new StartStateRefusal(
      403,
      'START_STATE_VIEW_AS',
      'Creating a record in a later step is not available while viewing as someone.'
    )
  }
  if (policy.isAdmin) return null
  const role = String(policy.role ?? '').toLowerCase()
  if (!role || !policy.roles.some((r) => r.toLowerCase() === role)) {
    return new StartStateRefusal(
      403,
      'START_STATE_FORBIDDEN',
      `You may not create ${collection} records in a later step. An administrator can allow your role in the pipeline's binding settings.`
    )
  }
  if (policy.allowed.length > 0 && !policy.allowed.some((k) => k === state.key)) {
    return new StartStateRefusal(
      403,
      'START_STATE_STEP_FORBIDDEN',
      `Your role may not create ${collection} records in "${state.label}".`
    )
  }
  return null
}

/**
 * The gate. Resolves the named step on the collection's bound pipeline and
 * judges the caller; throws a StartStateRefusal when the create must not run.
 * Reads only — call it before the row is written.
 */
export async function resolveStartState(input: {
  user: User
  req?: FastifyRequest
  collection: string
  value: string
}): Promise<StartStateTarget> {
  const { user, req, collection, value } = input
  const hasRoles = await hasColumn('nivaro_workflow_bindings', 'start_state_roles')
  const hasAllowed = await hasColumn('nivaro_workflow_bindings', 'start_state_allowed')
  const binding = (await db('nivaro_workflow_bindings')
    .where({ collection })
    .first(
      'template',
      'state_field',
      ...(hasRoles ? ['start_state_roles'] : []),
      ...(hasAllowed ? ['start_state_allowed'] : [])
    )) as
    | {
        template: string
        state_field: string | null
        start_state_roles?: string | null
        start_state_allowed?: string | null
      }
    | undefined
  if (!binding) {
    throw new StartStateRefusal(
      422,
      'START_STATE_NOT_BOUND',
      `${collection} runs no pipeline, so a record cannot be created in a step.`
    )
  }
  // The id column is a uniqueidentifier: only a uuid may be compared with it.
  const q = db('nivaro_workflow_states').where({ template: binding.template })
  if (UUID_RE.test(value)) q.where((b) => b.where({ key: value }).orWhere({ id: value }))
  else q.where({ key: value })
  const state = (await q.first(
    'id',
    'key',
    'label',
    'external_label',
    'color',
    'is_initial',
    'is_terminal'
  )) as Record<string, unknown> | undefined
  if (!state) {
    throw new StartStateRefusal(
      422,
      'START_STATE_UNKNOWN',
      `The ${collection} pipeline has no step "${value}".`
    )
  }
  const target: StartStateTarget = {
    template: String(binding.template),
    stateField: binding.state_field ?? null,
    state: {
      id: String(state.id),
      key: String(state.key),
      label: String(state.label ?? state.key),
      external_label: (state.external_label as string | null) ?? null,
      color: (state.color as string | null) ?? null,
      is_initial: truthy(state.is_initial),
      is_terminal: truthy(state.is_terminal)
    }
  }
  const isAdmin = req && typeof req.isAdmin === 'boolean' ? req.isAdmin : await isAdminRole(user)
  const refusal = startStateRefusalFor(
    {
      isAdmin,
      viewAs: viewAsAdminOf(req) !== null,
      role: (user?.role as string | null | undefined) ?? null,
      roles: parseIdList(binding.start_state_roles),
      allowed: parseIdList(binding.start_state_allowed)
    },
    collection,
    target.state
  )
  if (refusal) throw refusal
  return target
}

/** `$state` (services/record-state.ts shape) for a record just started at `run`. */
export function startedRecordState(run: StartStateRun): Record<string, unknown> | null {
  if (!run.instanceId) return null
  return {
    key: run.state.key,
    label: run.state.label,
    external_label: run.state.external_label,
    color: run.state.color,
    is_terminal: run.state.is_terminal,
    entered_at: (run.startedAt ?? new Date()).toISOString(),
    instance_id: run.instanceId
  }
}
