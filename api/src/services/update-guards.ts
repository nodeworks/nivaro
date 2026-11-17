import { db } from '../db/index.js'
import type { User } from '../types.js'
import { aliasLinkIdKey } from './alias-links.js'
import type { ScopeGate } from './record-access.js'

/**
 * Update guards (EFP prod 2026-11-17, workflow 372787 / CM27-81228): one PATCH
 * from a Zone-scoped person took the record's Zone and Region off, the save
 * answered 200, and only then did the form say "Saved, but this workflow is now
 * outside what you can see (no Zone set)" — the person had lost the record.
 *
 * Both guards judge the write BEFORE anything is stored (updateOne calls them
 * once every rule, default and derived value has settled and before the
 * UPDATE and the junction writes), so a refusal leaves the record untouched.
 * Only the caller's own payload is judged (`callerPayload`: REST PATCH, batch,
 * bulk, GraphQL updates); the items service's internal writes are not.
 *
 * 1. Scope guard (UPDATE_SCOPE_GUARD, default ON; `off` turns it off): an
 *    update that would take a record the caller can see out of their own
 *    User Scope is refused 422 OUT_OF_SCOPE, naming the field
 *    ("Pick a Zone — without it this workflow would leave your access.").
 *    Losing your own access is never what a save means. Restrict-mode scopes
 *    bind administrators too (compileAccessGates); callers with no scopes,
 *    records already outside the caller's view and writes that do not touch a
 *    scope's first link are never judged.
 * 2. Required guard (UPDATE_REQUIRED_GUARD, default ON; `off` turns it off): a
 *    write that EMPTIES a field the record's form or the field itself requires
 *    — a value sent empty, or a to-many link set left with nothing — is refused
 *    422 REQUIRED_VALUE_MISSING naming the field. A field already empty, or a
 *    field the write does not touch, never refuses.
 */

const OFF = /^(off|false|0|no)$/i

export function updateScopeGuardOn(): boolean {
  return !OFF.test((process.env.UPDATE_SCOPE_GUARD ?? '').trim())
}

export function updateRequiredGuardOn(): boolean {
  return !OFF.test((process.env.UPDATE_REQUIRED_GUARD ?? '').trim())
}

/** The shape of one alias (to-many) write, as the items service plans it. */
export interface PlannedLinkWrite {
  field: string
  junction: string
  parentFk: string
  relatedFk: string
  links: Array<{ id: string | number; collection?: string }>
  removals: Array<{ id: string | number; collection?: string }>
  set: boolean
}

interface Violation {
  field: string
  rule: string
  message: string
}

export class OutOfScopeUpdateError extends Error {
  statusCode = 422
  code = 'OUT_OF_SCOPE'
  field: string
  dimension: string
  violations: Violation[]
  constructor(message: string, field: string, dimension: string, fieldMessage: string) {
    super(message)
    this.field = field
    this.dimension = dimension
    this.violations = [{ field, rule: 'scope', message: fieldMessage }]
  }
}

export class RequiredFieldClearedError extends Error {
  statusCode = 422
  code = 'REQUIRED_VALUE_MISSING'
  field: string
  violations: Violation[]
  constructor(message: string, field: string, fieldMessage: string) {
    super(message)
    this.field = field
    this.violations = [{ field, rule: 'required', message: fieldMessage }]
  }
}

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0)

/** Pure: the related ids a junction set holds after this write (`existing` = ids stored now). */
export function linkIdsAfter(w: PlannedLinkWrite, existing: Array<string | number>): string[] {
  const key = aliasLinkIdKey
  if (w.set) return [...new Set(w.links.map((l) => key(l.id)))]
  const removed = new Set(w.removals.map((l) => key(l.id)))
  const out = new Set(existing.map(key).filter((id) => !removed.has(id)))
  for (const l of w.links) out.add(key(l.id))
  return [...out]
}

async function storedLinkIds(
  w: PlannedLinkWrite,
  id: string | number,
  cache: Map<string, Array<string | number>>
): Promise<Array<string | number>> {
  const k = `${w.junction}\u0000${w.parentFk}\u0000${w.relatedFk}`
  const hit = cache.get(k)
  if (hit) return hit
  const rows = (await db(w.junction)
    .where({ [w.parentFk]: id })
    .select(w.relatedFk)) as Array<Record<string, unknown>>
  const ids = rows.map((r) => r[w.relatedFk]).filter((v): v is string | number => v != null)
  cache.set(k, ids)
  return ids
}

const words = (field: string) => {
  const w = field.replace(/_/g, ' ').trim()
  return w ? w[0].toUpperCase() + w.slice(1) : field
}

async function collectionNoun(collection: string): Promise<string> {
  const { collectionNoun: noun } = await import('./access-request-text.js')
  return noun(collection)
}

// ── Required guard ──────────────────────────────────────────────────────────

export interface GuardInput {
  user: User
  isAdmin: boolean
  collection: string
  id: string | number
  /** The fields the caller sent. */
  callerFields: Set<string>
  /** The row as it will be stored (columns only). */
  columnPayload: Record<string, unknown>
  /** The stored row before the write. */
  previous: Record<string, unknown> | null
  /** The planned alias (to-many) writes. */
  linkWrites: PlannedLinkWrite[]
}

/**
 * The refusal for a write that empties a required field, or null. Judged
 * fields: caller-sent columns that go from a value to empty, and to-many sets
 * that go from at least one link to none. Required = the field's own mark or
 * a placement on the record's own form that requires it (bulk-field-rules.ts,
 * the rule bulk "Update field" already applies).
 */
export async function requiredClearRefusal(
  input: GuardInput,
  linkCache: Map<string, Array<string | number>> = new Map()
): Promise<RequiredFieldClearedError | null> {
  const cleared: string[] = []
  for (const f of input.callerFields) {
    if (!(f in input.columnPayload)) continue
    if (!isEmpty(input.columnPayload[f])) continue
    if (isEmpty(input.previous?.[f])) continue
    cleared.push(f)
  }
  for (const w of input.linkWrites) {
    if (w.links.length > 0 && !w.set) continue
    const before = await storedLinkIds(w, input.id, linkCache)
    if (before.length === 0) continue
    if (linkIdsAfter(w, before).length === 0) cleared.push(w.field)
  }
  if (cleared.length === 0) return null

  // Unreadable metadata never blocks a write (validation-rules.ts does the same).
  let hit: string | undefined
  let label: string | undefined
  try {
    const { bulkRuleTable, placementRequires } = await import('./bulk-field-rules.js')
    const table = await bulkRuleTable(input.collection)
    hit = cleared.find((f) => table.get(f)?.required)
    if (!hit) {
      const { resolveFormsForRecords, loadFormShape } = await import('./form-field-gate.js')
      const forms = await resolveFormsForRecords(
        input.collection,
        [input.id],
        input.user.role ?? null,
        input.isAdmin,
        input.user.id ? String(input.user.id) : null
      )
      const form = forms.get(String(input.id).toLowerCase())
      if (form) {
        const shape = await loadFormShape(form)
        hit = cleared.find((f) => placementRequires(shape.placements, f))
      }
    }
    if (hit) label = table.get(hit)?.label
  } catch {
    return null
  }
  if (!hit) return null
  label ??= words(hit)
  return new RequiredFieldClearedError(
    `${label} is required — pick a ${label} before saving. Nothing was saved.`,
    hit,
    `Pick a ${label}`
  )
}

// ── Scope guard ─────────────────────────────────────────────────────────────

async function labelsOf(g: ScopeGate, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  try {
    const rows = (await db(g.target)
      .whereIn('id', ids as never)
      .select('id', db.raw('?? as label', [g.displayField]))) as Array<{
      id: unknown
      label: unknown
    }>
    const by = new Map(rows.map((r) => [aliasLinkIdKey(r.id), String(r.label ?? r.id)]))
    return ids.map((id) => by.get(aliasLinkIdKey(id)) ?? id)
  } catch {
    return ids
  }
}

/**
 * Does a record whose first hop lands on `firstIds` (ids in the first hop's
 * table, or the scope target itself when the route is one hop long) pass the
 * gate? The rest of the route is the gate's own SQL (applyScopeHops).
 */
async function passesFrom(g: ScopeGate, firstIds: string[]): Promise<boolean> {
  if (firstIds.length === 0) return false
  const allowed = new Set(g.values.map(aliasLinkIdKey))
  if (g.hops.length === 1) return firstIds.some((id) => allowed.has(aliasLinkIdKey(id)))
  const { applyScopeHops } = await import('./user-scopes.js')
  const next = g.hops[0].to
  const q = db(next).whereIn(`${next}.id`, firstIds as never)
  applyScopeHops(q, next, g.hops.slice(1), g.values)
  const row = await q.first(`${next}.id`)
  return !!row
}

/**
 * The refusal for an update that would take a record the caller can see now
 * out of their own User Scope, or null. Only routes whose FIRST link this
 * write changes are judged (a many-to-one column it sets, or a to-many set it
 * changes); the record's resulting first-hop values are walked down the rest
 * of the route with the gate's own SQL. Never throws: a guard that cannot
 * judge lets the write stand (the after-save "outside what you can see" note
 * still tells the person).
 */
export async function scopeLossRefusal(
  input: GuardInput,
  linkCache: Map<string, Array<string | number>> = new Map()
): Promise<OutOfScopeUpdateError | null> {
  try {
    const { compileAccessGates, visibleIds } = await import('./record-access.js')
    const gates = await compileAccessGates(input.user, input.collection, {
      actingAdmin: input.isAdmin
    })
    if (gates.bypass || !gates.permitted || gates.strict || gates.scopes.length === 0) return null
    const changed: Array<{ g: ScopeGate; field: string; first: string[] }> = []
    for (const g of gates.scopes) {
      const h = g.hops[0]
      if (!h) continue
      if (h.kind === 'm2o') {
        if (!(h.fk in input.columnPayload)) continue
        const now = input.columnPayload[h.fk]
        const before = input.previous?.[h.fk]
        if (aliasLinkIdKey(now) === aliasLinkIdKey(before) && isEmpty(now) === isEmpty(before))
          continue
        changed.push({ g, field: h.fk, first: isEmpty(now) ? [] : [String(now)] })
      } else if (h.kind === 'junction') {
        const w = input.linkWrites.find(
          (x) =>
            x.junction === h.junction && x.parentFk === h.parentFk && x.relatedFk === h.targetFk
        )
        if (!w) continue
        const before = await storedLinkIds(w, input.id, linkCache)
        const after = linkIdsAfter(w, before)
        const same =
          after.length === before.length && before.every((b) => after.includes(aliasLinkIdKey(b)))
        if (same) continue
        changed.push({ g, field: w.field, first: after })
      }
    }
    if (changed.length === 0) return null
    // Judged only while the caller can see the record now: a write to a record
    // already outside their view is not the save that loses it.
    const id = String(input.id)
    if (!(await visibleIds(gates, [id])).has(id)) return null
    for (const c of changed) {
      if (await passesFrom(c.g, c.first)) continue
      const noun = await collectionNoun(input.collection)
      const label = c.g.label
      const yours = await labelsOf(
        c.g,
        c.g.values.slice(0, 10).map((v) => String(v))
      )
      const theirs = c.g.values.length > 10 ? `${yours.join(', ')} …` : yours.join(', ')
      const message =
        c.first.length === 0
          ? `Pick a ${label} — without it this ${noun} would leave your access${
              theirs ? ` (yours: ${theirs})` : ''
            }. Nothing was saved.`
          : `Pick a ${label} you have access to${theirs ? ` (yours: ${theirs})` : ''} — as entered, this ${noun} would leave your access. Nothing was saved.`
      return new OutOfScopeUpdateError(
        message,
        c.field,
        c.g.dimension,
        c.first.length === 0 ? `Pick a ${label}` : `Pick a ${label} you have access to`
      )
    }
    return null
  } catch {
    return null
  }
}

/**
 * Both guards, in the order a person fixes them: a required field first (its
 * message names the field), then the scope. Throws the refusal.
 */
export async function assertUpdateKeepsRecord(input: GuardInput): Promise<void> {
  const cache = new Map<string, Array<string | number>>()
  if (updateRequiredGuardOn()) {
    const r = await requiredClearRefusal(input, cache)
    if (r) throw r
  }
  if (updateScopeGuardOn()) {
    const r = await scopeLossRefusal(input, cache)
    if (r) throw r
  }
}
