/**
 * ONE resolver for "can this person see / act on this record?" (#519).
 *
 * Role policy, RLS row filters and User Scopes decide what a person can SEE;
 * suspension, redaction, out-of-office and delegation decide whether they can
 * ACT; pipeline owners decide whether it is theirs to act on. access-explain
 * (one record, the denied panel), access-audit (thousands of stakeholder
 * pairs) and coverage-gaps (records nobody available owns) each assembled
 * those gates themselves, three slightly different ways. They now compile the
 * same gates from here, so they agree by construction:
 *
 *   compileAccessGates(user, collection) → the gates for one person
 *   visibleIds(gates, ids)               → which ids pass every gate (set-based)
 *   explainIds(gates, ids)               → per id, the gate(s) that hid it
 *   unavailabilityOf(userRow)            → can this person act at all
 *   canActOn(user, collection, id)       → the whole answer for one record
 *
 * Mirrors getUserScopeEnforcement's rules (reference-table skip, strict deny).
 */
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { applyRowFilter, can, getRowFilter } from './permissions.js'
import {
  applyScopeHops,
  getUserScopes,
  listScopeDimensions,
  resolveRecordDimensionIds,
  type ScopeHop,
  scopeHopsFor
} from './user-scopes.js'

export interface AccessReason {
  type: 'permission' | 'not_found' | 'row_filter' | 'scope' | 'scope_strict' | 'unknown'
  message: string
  /** scope reasons: which dimension and what the user IS limited to. */
  dimension?: string
  dimension_label?: string
  allowed_values?: string[]
  /** scope reasons: the record's own values on that dimension (ids + labels). */
  record_ids?: string[]
  record_values?: string[]
  /** not_found: the trash row, admins only. */
  trash_id?: number
}

interface ScopeGate {
  dimension: string
  label: string
  values: Array<string | number>
  hops: ScopeHop[]
  target: string
  displayField: string
}

export interface AccessGates {
  collection: string
  user: User
  /** Admin roles see everything; no gate applies. */
  bypass: boolean
  permitted: boolean
  rowFilter: unknown | null
  scopes: ScopeGate[]
  strict: { dimension: string; label: string } | null
}

const CHUNK = 1500

export async function compileAccessGates(
  user: User,
  collection: string,
  opts: { actingAdmin?: boolean } = {}
): Promise<AccessGates> {
  const base: AccessGates = {
    collection,
    user,
    bypass: !!opts.actingAdmin,
    permitted: true,
    rowFilter: null,
    scopes: [],
    strict: null
  }
  if (base.bypass) return base
  base.permitted = await can(user, 'read', collection)
  if (!base.permitted) return base
  base.rowFilter = (await getRowFilter(user, 'read', collection)) ?? null
  const restricts = (await getUserScopes(user.id)).filter(
    (s) => s.mode === 'restrict' && s.values.length > 0
  )
  if (restricts.length === 0) return base
  const dims = await listScopeDimensions()
  const isReferenceTable = new Set(dims.map((d) => d.target_collection)).has(collection)
  for (const s of restricts) {
    const dim = dims.find((d) => d.name === s.dimension)
    if (!dim) continue
    if (isReferenceTable && dim.target_collection !== collection) continue
    const hops = await scopeHopsFor(dim, collection)
    if (!hops) {
      if (dim.strict && !base.strict) base.strict = { dimension: dim.name, label: dim.label }
      continue
    }
    base.scopes.push({
      dimension: dim.name,
      label: dim.label,
      values: s.values,
      hops,
      target: dim.target_collection,
      displayField: dim.display_field || 'name'
    })
  }
  return base
}

function applyScope(q: Knex.QueryBuilder, collection: string, g: ScopeGate): void {
  if (g.hops.length === 0) void q.whereIn(`${collection}.id`, g.values as never)
  else applyScopeHops(q, collection, g.hops, g.values)
}

async function passing(
  collection: string,
  ids: string[],
  apply: (q: Knex.QueryBuilder) => void
): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const q = db(collection).whereIn(`${collection}.id`, ids.slice(i, i + CHUNK))
    apply(q)
    for (const r of (await q.select(`${collection}.id`)) as Array<{ id: unknown }>)
      out.add(String(r.id))
  }
  return out
}

/** The ids (of those given) that pass EVERY gate — what the person can see. */
export async function visibleIds(gates: AccessGates, ids: string[]): Promise<Set<string>> {
  if (gates.bypass) return new Set(ids)
  if (!gates.permitted || gates.strict) return new Set()
  if (!gates.rowFilter && gates.scopes.length === 0) return new Set(ids)
  return passing(gates.collection, ids, (q) => {
    if (gates.rowFilter) applyRowFilter(q, gates.rowFilter as never, gates.user)
    for (const g of gates.scopes) applyScope(q, gates.collection, g)
  })
}

async function labelsFor(
  target: string,
  displayField: string,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  try {
    const rows = (await db(target)
      .whereIn('id', ids as never)
      .select('id', db.raw('?? as label', [displayField]))) as Array<{
      id: unknown
      label: unknown
    }>
    for (const r of rows) out.set(String(r.id), String(r.label ?? r.id))
  } catch {
    for (const id of ids) out.set(id, id)
  }
  return out
}

/**
 * Per id (of those NOT visible), the gate(s) that hid it — each gate re-run
 * ALONE over the hidden set, so a record excluded by two dimensions names both.
 */
export async function explainIds(
  gates: AccessGates,
  ids: string[]
): Promise<Map<string, AccessReason[]>> {
  const out = new Map<string, AccessReason[]>()
  if (gates.bypass || ids.length === 0) return out
  const { collection } = gates
  for (const id of ids) out.set(id, [])
  if (!gates.permitted) {
    for (const id of ids)
      out.get(id)!.push({
        type: 'permission',
        message: `The role has no permission to view ${collection.replace(/_/g, ' ')} records.`
      })
    return out
  }
  if (gates.strict) {
    for (const id of ids)
      out.get(id)!.push({
        type: 'scope_strict',
        dimension: gates.strict.dimension,
        dimension_label: gates.strict.label,
        message: `The ${gates.strict.label} access filter is strict and this collection has no ${gates.strict.label} link — all its records are hidden.`
      })
    return out
  }
  if (gates.rowFilter) {
    const pass = await passing(collection, ids, (q) =>
      applyRowFilter(q, gates.rowFilter as never, gates.user)
    )
    for (const id of ids)
      if (!pass.has(id))
        out.get(id)!.push({
          type: 'row_filter',
          message:
            'A row-level security rule on the role hides this record (it does not match the conditions the role is limited to).'
        })
  }
  for (const g of gates.scopes) {
    const pass = await passing(collection, ids, (q) => applyScope(q, collection, g))
    const failed = ids.filter((id) => !pass.has(id))
    if (failed.length === 0) continue
    const recVals = await resolveRecordDimensionIds(collection, failed, g.hops)
    const lookup = [
      ...new Set([...g.values.slice(0, 20).map(String), ...[...recVals.values()].flat()])
    ]
    const labels = await labelsFor(g.target, g.displayField, lookup)
    const allowed = g.values.slice(0, 20).map((v) => labels.get(String(v)) ?? String(v))
    for (const id of failed) {
      const recIds = recVals.get(id) ?? []
      const recordVals = recIds.slice(0, 10).map((v) => labels.get(v) ?? v)
      const recordSide =
        recordVals.length > 0
          ? `this record's ${g.label} is ${recordVals.join(', ')}`
          : `this record has no ${g.label} link`
      out.get(id)!.push({
        type: 'scope',
        dimension: g.dimension,
        dimension_label: g.label,
        allowed_values: allowed,
        record_ids: recIds,
        record_values: recordVals,
        message: `The ${g.label} access filter excludes this record — ${recordSide}, and access is limited to: ${allowed.join(', ') || '(none)'}.`
      })
    }
  }
  return out
}

// ── Can the person act at all ────────────────────────────────────────────────

export interface AvailabilityRow {
  status?: string | null
  is_redacted?: boolean | number | null
  is_out_of_office?: boolean | number | null
  delegate_id?: string | null
  delegate_expires_at?: Date | string | null
}

export type Unavailability = 'suspended' | 'inactive' | 'redacted' | 'ooo_no_delegate'

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

/**
 * Null when the person can act. Judged AFTER delegation: a resolved owner who
 * is still out of office means no working delegate exists (resolution already
 * substituted one if it could) — that is the gap coverage-gaps reports.
 */
export function unavailabilityOf(u: AvailabilityRow): Unavailability | null {
  if (truthy(u.is_redacted)) return 'redacted'
  if (u.status === 'suspended') return 'suspended'
  if (u.status != null && u.status !== 'active') return 'inactive'
  if (truthy(u.is_out_of_office)) return 'ooo_no_delegate'
  return null
}

export const UNAVAILABLE_TEXT: Record<Unavailability, string> = {
  suspended: 'Their account is suspended.',
  inactive: 'Their account is not active.',
  redacted: 'Their account was redacted.',
  ooo_no_delegate: 'They are out of office with no working delegate.'
}

// ── The whole answer for one record ─────────────────────────────────────────

export interface ActVerdict {
  can_see: boolean
  can_update: boolean
  available: boolean
  unavailable_reason: Unavailability | null
  /** Resolved owner of the record's current pipeline state (after delegation). */
  is_owner: boolean | null
  state: string | null
  can_act: boolean
  reasons: AccessReason[]
  summary: string
}

export async function canActOn(
  user: User & AvailabilityRow,
  collection: string,
  id: string,
  opts: { actingAdmin?: boolean } = {}
): Promise<ActVerdict> {
  const gates = await compileAccessGates(user, collection, opts)
  const exists = !!(await db(collection)
    .where({ id })
    .first('id')
    .catch(() => null))
  const seen = exists ? (await visibleIds(gates, [id])).has(String(id)) : false
  const reasons = exists
    ? seen
      ? []
      : ((await explainIds(gates, [String(id)])).get(String(id)) ?? [])
    : [{ type: 'not_found' as const, message: 'This record does not exist.' }]
  const canUpdate = seen && (opts.actingAdmin || (await can(user, 'update', collection)))
  const unavailable = unavailabilityOf(user)

  let isOwner: boolean | null = null
  let state: string | null = null
  const inst = (await db('nivaro_workflow_instances as i')
    .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
    .where({ 'i.collection': collection, 'i.item': String(id) })
    .whereNull('i.completed_at')
    .first('i.id', 's.id as state_id', 's.label')
    .catch(() => undefined)) as { id: string; state_id: string; label: string } | undefined
  if (inst) {
    state = inst.label
    const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
    const owners = await resolveStateOwnersBatch([
      { key: 'x', stateId: inst.state_id, instanceId: inst.id, collection, itemId: String(id) }
    ])
    isOwner = (owners.get('x') ?? []).some(
      (o) => String(o.id).toUpperCase() === String(user.id).toUpperCase()
    )
  }
  const canAct = seen && !!canUpdate && !unavailable
  const summary = !exists
    ? 'The record does not exist.'
    : !seen
      ? 'They cannot see this record.'
      : unavailable
        ? `They can see it but cannot act — ${UNAVAILABLE_TEXT[unavailable].toLowerCase()}`
        : !canUpdate
          ? 'They can see it but their role cannot change it.'
          : isOwner === false
            ? `They can act on it, but ${state} is not theirs — someone else owns this step.`
            : isOwner
              ? `They can act on it and own ${state}.`
              : 'They can act on it.'
  return {
    can_see: seen,
    can_update: !!canUpdate,
    available: !unavailable,
    unavailable_reason: unavailable,
    is_owner: isOwner,
    state,
    can_act: canAct,
    reasons,
    summary
  }
}
