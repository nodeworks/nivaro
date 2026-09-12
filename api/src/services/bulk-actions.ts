import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import {
  type BulkActionAccess,
  type BulkActionDef,
  bulkActionRegistry
} from '../extensions/bulk-actions.js'
import { logActivity } from '../services/activity.js'
import type { User } from '../types.js'
import { type GuardRule, guardPasses, parseJsonLoose, renderTemplate } from './action-guards.js'
import { can } from './permissions.js'
import {
  coerceBool,
  parseJson,
  type WorkflowInstance,
  type WorkflowTransition
} from './pipeline-engine.js'
import { evaluateTransitionRequirements } from './transition-requirements.js'
import { TransitionBlockedError } from './workflow-actions.js'
import { evaluateConditionRules, fetchRecordForConditions } from './workflow-conditions.js'
import { applyTransition, runAutoTransitions } from './workflow-transitions.js'

/**
 * Bulk actions registry — admin-defined actions run over a selection in the
 * collection browser or a queue. Two kinds:
 *  - update_fields: {set: {field: value | '{{reason}}' | '{{field}}'}} — each
 *    record is written through updateOne (hooks, rules, validation, RLS apply);
 *    the reason rides as `_change_reason` so it lands on the activity row.
 *  - transition: {transition_label} — matched per record against the bound
 *    template's manual transitions at run time, then every gate the manual
 *    endpoint enforces (from-state, required_roles, requirements, condition
 *    rules) before applyTransition. Uncancel's `to_previous` resolves per
 *    record inside applyTransition, so the definition never names a state.
 * Access is checked once per run (everyone / admins / listed roles) ON TOP
 * of update permission on the collection. A per-record guard skips records
 * the action doesn't apply to (counted as skipped, never failed).
 */

export type BulkActionKind = 'update_fields' | 'transition'
/** Surfaces a built-in belongs to. */
export type BulkSurface = 'browser' | 'queue'

/**
 * The bars' built-in operations, exposed through the same registry so a
 * collection can switch them off or restrict who runs them. Overrides are
 * `nivaro_bulk_actions` rows with kind 'builtin' (config '{}'); no row =
 * default (active, default access). Server endpoints behind each one call
 * `builtinAllowed()`.
 */
export interface BuiltinBulkAction {
  key: string
  label: string
  summary: string
  surfaces: BulkSurface[]
  variant: 'default' | 'danger'
  defaultAccess: BulkActionAccess
  /** Access cannot be widened (record merge is admin-only by construction). */
  lockedAccess?: boolean
}
export const BUILTIN_BULK_ACTIONS: BuiltinBulkAction[] = [
  {
    key: 'update-field',
    label: 'Update Field',
    summary: 'Set one field to one value on every selected record',
    surfaces: ['browser'],
    variant: 'default',
    defaultAccess: { mode: 'everyone' }
  },
  {
    key: 'transition',
    label: 'Transition',
    summary: 'Run a pipeline transition on every selected record',
    surfaces: ['browser', 'queue'],
    variant: 'default',
    defaultAccess: { mode: 'everyone' }
  },
  {
    key: 'message',
    label: 'Message…',
    summary: 'Notify the owners / creators of the selected records',
    surfaces: ['browser'],
    variant: 'default',
    defaultAccess: { mode: 'everyone' }
  },
  {
    key: 'compare',
    label: 'Compare',
    summary: 'Side-by-side field comparison of 2–3 records',
    surfaces: ['browser'],
    variant: 'default',
    defaultAccess: { mode: 'everyone' }
  },
  {
    key: 'merge',
    label: 'Merge…',
    summary: 'Merge two duplicate records into one (admins)',
    surfaces: ['browser'],
    variant: 'default',
    defaultAccess: { mode: 'admin' },
    lockedAccess: true
  },
  {
    key: 'recipes',
    label: 'Saved recipes',
    summary: 'Personal / shared saved bulk-update and transition recipes',
    surfaces: ['browser'],
    variant: 'default',
    defaultAccess: { mode: 'everyone' }
  },
  {
    key: 'delete',
    label: 'Delete',
    summary: 'Move the selected records to the trash',
    surfaces: ['browser'],
    variant: 'danger',
    defaultAccess: { mode: 'everyone' }
  },
  {
    key: 'claim',
    label: 'Claim',
    summary: 'Claim the selected queue items for yourself',
    surfaces: ['queue'],
    variant: 'default',
    defaultAccess: { mode: 'everyone' }
  },
  {
    key: 'release',
    label: 'Release',
    summary: 'Release your claim on the selected queue items',
    surfaces: ['queue'],
    variant: 'default',
    defaultAccess: { mode: 'everyone' }
  }
]
export const BUILTIN_KEYS = new Set(BUILTIN_BULK_ACTIONS.map((b) => b.key))

export interface BulkActionRow {
  id: number
  collection: string
  key: string
  label: string
  icon: string | null
  variant: 'default' | 'danger'
  kind: BulkActionKind | 'builtin'
  config: Record<string, unknown>
  guard: GuardRule[] | null
  access: BulkActionAccess
  require_reason: boolean
  confirm_text: string | null
  is_active: boolean
  sort: number
  created_by: string | null
  created_at: string | Date | null
}

/** The shape both surfaces render — DB rows and extension defs alike. */
export interface AvailableBulkAction {
  key: string
  source: 'db' | 'extension' | 'builtin'
  collection: string | null
  label: string
  icon: string | null
  variant: 'default' | 'danger'
  kind: BulkActionKind | 'extension' | 'builtin'
  require_reason: boolean
  confirm_text: string | null
  guard: GuardRule[] | null
  access: BulkActionAccess
  /** Human summary of what the action does (editor lists + hover text). */
  summary: string
  /** Built-ins only: which bars render it. */
  surfaces?: BulkSurface[]
}

/** A built-in with its per-collection override state (editor rows). */
export interface BuiltinState extends BuiltinBulkAction {
  collection: string
  override_id: number | null
  is_active: boolean
  access: BulkActionAccess
}

export const BULK_ACTION_KINDS: BulkActionKind[] = ['update_fields', 'transition']
export const GUARD_OPS = ['eq', 'neq', 'null', 'nnull', 'in', 'nin']
export const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/

export function normalizeAccess(raw: unknown): BulkActionAccess {
  const a = parseJsonLoose<Partial<BulkActionAccess>>(raw)
  const mode = a?.mode === 'admin' || a?.mode === 'roles' ? a.mode : 'everyone'
  const role_ids =
    mode === 'roles' && Array.isArray(a?.role_ids)
      ? [
          ...new Set(
            a!.role_ids.filter((r): r is string => typeof r === 'string' && r.trim() !== '')
          )
        ]
      : []
  return mode === 'roles' ? { mode, role_ids } : { mode }
}

export function normalizeGuard(raw: unknown): GuardRule[] | null {
  const rules = parseJsonLoose<GuardRule[]>(raw)
  if (!Array.isArray(rules)) return null
  const out = rules.filter(
    (r) =>
      r &&
      typeof r.field === 'string' &&
      r.field.trim() !== '' &&
      typeof r.op === 'string' &&
      GUARD_OPS.includes(r.op)
  )
  return out.length > 0 ? out : null
}

export function formatRow(row: Record<string, unknown>): BulkActionRow {
  return {
    id: Number(row.id),
    collection: String(row.collection),
    key: String(row.key),
    label: String(row.label),
    icon: (row.icon as string | null) ?? null,
    variant: row.variant === 'danger' ? 'danger' : 'default',
    kind:
      row.kind === 'transition'
        ? 'transition'
        : row.kind === 'builtin'
          ? 'builtin'
          : 'update_fields',
    config: parseJsonLoose<Record<string, unknown>>(row.config) ?? {},
    guard: normalizeGuard(row.guard),
    access: normalizeAccess(row.access),
    require_reason: coerceBool(row.require_reason),
    confirm_text: (row.confirm_text as string | null) ?? null,
    is_active: coerceBool(row.is_active),
    sort: Number(row.sort ?? 0),
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | Date | null) ?? null
  }
}

export function summarize(
  kind: BulkActionKind | 'builtin',
  config: Record<string, unknown>
): string {
  if (kind === 'builtin') return 'Built-in'
  if (kind === 'transition') return `Transition: ${String(config.transition_label ?? '')}`
  const set = (config.set as Record<string, unknown> | undefined) ?? {}
  const parts = Object.entries(set).map(([k, v]) => `${k} = ${v === null ? 'empty' : String(v)}`)
  return parts.length ? `Set ${parts.join(', ')}` : 'Set fields'
}

/** Does this request's user pass the action's access rule? (Admins always do.) */
export function accessAllows(access: BulkActionAccess, req: FastifyRequest): boolean {
  if (req.isAdmin) return true
  if (access.mode === 'everyone') return true
  if (access.mode === 'admin') return false
  const role = req.user?.role ? String(req.user.role).toUpperCase() : null
  return !!role && (access.role_ids ?? []).some((r) => String(r).toUpperCase() === role)
}

/** Custom (non-builtin) definitions for a collection, in order. */
export async function listDefinitions(collection: string): Promise<BulkActionRow[]> {
  const rows = await db('nivaro_bulk_actions')
    .where({ collection })
    .whereNot({ kind: 'builtin' })
    .orderBy([
      { column: 'sort', order: 'asc' },
      { column: 'id', order: 'asc' }
    ])
    .select('*')
  return rows.map((r) => formatRow(r as Record<string, unknown>))
}

/** Built-ins with this collection's override state applied. */
export async function listBuiltins(collection: string): Promise<BuiltinState[]> {
  const rows = (await db('nivaro_bulk_actions')
    .where({ collection, kind: 'builtin' })
    .select('*')) as Array<Record<string, unknown>>
  return BUILTIN_BULK_ACTIONS.map((b) => {
    const o = rows.find((r) => String(r.key) === b.key)
    return {
      ...b,
      collection,
      override_id: o ? Number(o.id) : null,
      is_active: o ? coerceBool(o.is_active) : true,
      access: b.lockedAccess ? b.defaultAccess : o ? normalizeAccess(o.access) : b.defaultAccess
    }
  })
}

/** Upsert a built-in's override (access / active) for a collection. */
export async function setBuiltin(
  collection: string,
  key: string,
  patch: { access?: unknown; is_active?: unknown },
  userId: string | null
): Promise<BuiltinState> {
  const b = BUILTIN_BULK_ACTIONS.find((x) => x.key === key)
  if (!b) throw new Error(`Unknown built-in bulk action "${key}"`)
  const existing = await db('nivaro_bulk_actions')
    .where({ collection, key, kind: 'builtin' })
    .first()
  const next: Record<string, unknown> = {}
  if ('access' in patch && !b.lockedAccess)
    next.access = JSON.stringify(normalizeAccess(patch.access))
  if ('is_active' in patch) next.is_active = patch.is_active !== false
  if (existing) {
    if (Object.keys(next).length)
      await db('nivaro_bulk_actions').where({ id: existing.id }).update(next)
  } else {
    await db('nivaro_bulk_actions').insert({
      collection,
      key,
      label: b.label,
      variant: b.variant,
      kind: 'builtin',
      config: '{}',
      guard: null,
      access: (next.access as string | undefined) ?? JSON.stringify(b.defaultAccess),
      require_reason: false,
      confirm_text: null,
      is_active: 'is_active' in next ? (next.is_active as boolean) : true,
      sort: 1000 + BUILTIN_BULK_ACTIONS.indexOf(b),
      created_by: userId
    })
  }
  const all = await listBuiltins(collection)
  return all.find((x) => x.key === key) as BuiltinState
}

/**
 * May this request use a built-in bar operation on the collection? Used by
 * the endpoints behind them (bulk-update/-delete/-transition, message,
 * queue claim/release) so a switched-off or restricted built-in cannot be
 * driven from a stale client. Unknown key = allowed (nothing to restrict).
 */
export async function builtinAllowed(
  collection: string,
  key: string,
  req: FastifyRequest
): Promise<boolean> {
  const b = BUILTIN_BULK_ACTIONS.find((x) => x.key === key)
  if (!b) return true
  const o = (await db('nivaro_bulk_actions')
    .where({ collection, key, kind: 'builtin' })
    .first('is_active', 'access')) as Record<string, unknown> | undefined
  if (o && !coerceBool(o.is_active)) return req.isAdmin === true
  const access = b.lockedAccess ? b.defaultAccess : o ? normalizeAccess(o.access) : b.defaultAccess
  return accessAllows(access, req)
}

function fromExtension(def: BulkActionDef, collection: string): AvailableBulkAction {
  return {
    key: def.id,
    source: 'extension',
    collection,
    label: def.label,
    icon: def.icon ?? null,
    variant: def.variant === 'danger' ? 'danger' : 'default',
    kind: 'extension',
    require_reason: def.require_reason === true,
    confirm_text: def.confirm ?? null,
    guard: null,
    access: normalizeAccess(def.access),
    summary: 'Extension action'
  }
}

function fromRow(row: BulkActionRow): AvailableBulkAction {
  return {
    key: row.key,
    source: 'db',
    collection: row.collection,
    label: row.label,
    icon: row.icon,
    variant: row.variant,
    kind: row.kind,
    require_reason: row.require_reason,
    confirm_text: row.confirm_text,
    guard: row.guard,
    access: row.access,
    summary: summarize(row.kind, row.config)
  }
}

function fromBuiltin(b: BuiltinState): AvailableBulkAction {
  return {
    key: b.key,
    source: 'builtin',
    collection: b.collection,
    label: b.label,
    icon: null,
    variant: b.variant,
    kind: 'builtin',
    require_reason: false,
    confirm_text: null,
    guard: null,
    access: b.access,
    summary: b.summary,
    surfaces: b.surfaces
  }
}

/** Every ACTIVE action for the collection, no access filter (editor pickers):
 *  built-ins first, then custom definitions, then extension actions. */
export async function listAllForCollection(collection: string): Promise<AvailableBulkAction[]> {
  const [rows, builtins] = await Promise.all([
    listDefinitions(collection),
    listBuiltins(collection)
  ])
  const ext = bulkActionRegistry.list(collection).map((d) => fromExtension(d, collection))
  return [
    ...builtins.filter((b) => b.is_active).map(fromBuiltin),
    ...rows.filter((r) => r.is_active).map(fromRow),
    ...ext
  ]
}

/** Active actions the CALLER may run for the collection (what the bars render). */
export async function listAvailable(
  collection: string,
  req: FastifyRequest
): Promise<AvailableBulkAction[]> {
  if (!req.isAdmin && !(await can(req.user as User, 'update', collection))) return []
  const all = await listAllForCollection(collection)
  return all.filter((a) => accessAllows(a.access, req))
}

/** Manual (non-auto) transition labels on the collection's bound template. */
export async function transitionLabelsFor(collection: string): Promise<string[]> {
  const binding = await db('nivaro_workflow_bindings').where({ collection }).first('template')
  if (!binding) return []
  const rows = await db('nivaro_workflow_transitions')
    .where({ template: binding.template })
    .orderBy('sort', 'asc')
    .select('label', 'auto_trigger')
  const out: string[] = []
  for (const r of rows) {
    if (coerceBool(r.auto_trigger)) continue
    const l = String(r.label ?? '').trim()
    if (l && !out.includes(l)) out.push(l)
  }
  return out
}

export interface BulkRunResult {
  succeeded: number
  failed: number
  skipped: number
  errors: Array<{ item: string; error: string }>
  skipped_items: string[]
}

/** Run a DB-defined action over ids as the requesting user. */
export async function runDefinition(
  def: BulkActionRow,
  ids: Array<string | number>,
  reason: string | null,
  req: FastifyRequest
): Promise<BulkRunResult> {
  const { readOne, updateOne } = await import('./items.js')
  const user = req.user as User
  const result: BulkRunResult = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    skipped_items: []
  }
  const collection = def.collection

  // Transition kind: resolve the template's transitions ONCE; the per-record
  // pick depends on the record's current state.
  let candidates: WorkflowTransition[] = []
  if (def.kind === 'transition') {
    const binding = await db('nivaro_workflow_bindings').where({ collection }).first('template')
    if (!binding) throw new Error(`${collection} has no pipeline bound — cannot run a transition`)
    const label = String(def.config.transition_label ?? '').trim()
    candidates = (await db('nivaro_workflow_transitions')
      .where({ template: binding.template })
      .orderBy('sort', 'asc')
      .select('*')) as WorkflowTransition[]
    candidates = candidates.filter(
      (t) =>
        String(t.label ?? '').trim() === label &&
        !coerceBool((t as { auto_trigger?: unknown }).auto_trigger)
    )
    if (candidates.length === 0)
      throw new Error(`No transition labelled "${label}" on the ${collection} pipeline`)
  }

  for (const rawId of ids) {
    const item = String(rawId)
    try {
      const record = (await readOne(user, collection, item).catch(() => null)) as Record<
        string,
        unknown
      > | null
      if (!record) {
        result.failed++
        result.errors.push({ item, error: 'Record not found or not readable' })
        continue
      }
      if (!guardPasses(def.guard, record)) {
        result.skipped++
        result.skipped_items.push(item)
        continue
      }

      if (def.kind === 'update_fields') {
        const set = (def.config.set as Record<string, unknown> | undefined) ?? {}
        const ctx = { ...record, reason: reason ?? '' }
        const payload: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(set)) {
          payload[k] = typeof v === 'string' ? renderTemplate(v, ctx) : v
        }
        if (Object.keys(payload).length === 0)
          throw new Error('The action has no fields configured')
        if (reason) payload._change_reason = reason
        await updateOne(user, collection, item, payload, req)
        result.succeeded++
        continue
      }

      // ── transition ──
      const instance = (await db('nivaro_workflow_instances')
        .where({ collection, item })
        .first()) as WorkflowInstance | undefined
      if (!instance) {
        result.skipped++
        result.skipped_items.push(item)
        continue
      }
      const transition = candidates.find(
        (t) =>
          t.from_state === null ||
          String(t.from_state).toUpperCase() === String(instance.current_state ?? '').toUpperCase()
      )
      if (!transition) {
        result.skipped++
        result.skipped_items.push(item)
        continue
      }
      if (instance.completed_at) {
        const escapes =
          String(transition.from_state ?? '').toUpperCase() ===
          String(instance.current_state ?? '').toUpperCase()
        if (!escapes) {
          result.skipped++
          result.skipped_items.push(item)
          continue
        }
      }
      if (!req.isAdmin && transition.required_roles) {
        const roles = parseJson(transition.required_roles) as string[] | null
        if (roles && roles.length > 0) {
          const userRole = req.user?.role ?? null
          if (!userRole || !roles.includes(userRole)) {
            result.failed++
            result.errors.push({ item, error: 'You do not have permission for this transition' })
            continue
          }
        }
      }
      if (transition.requirements) {
        const blocking = await evaluateTransitionRequirements(
          db,
          transition.requirements,
          item,
          req.log,
          collection
        )
        if (blocking) {
          result.failed++
          result.errors.push({ item, error: 'Transition requirements not met (open the record)' })
          continue
        }
      }
      const condRaw = (transition as { condition_rules?: string | null }).condition_rules
      if (condRaw) {
        const conditionRecord = await fetchRecordForConditions(collection, item, [condRaw])
        if (!evaluateConditionRules(condRaw, conditionRecord)) {
          result.failed++
          result.errors.push({ item, error: 'Transition conditions not met' })
          continue
        }
      }
      try {
        const applied = await applyTransition({
          instance: instance as unknown as Parameters<typeof applyTransition>[0]['instance'],
          transition: transition as unknown as Parameters<typeof applyTransition>[0]['transition'],
          userId: req.user?.id ?? null,
          comment: reason ?? null,
          source: 'manual'
        })
        await runAutoTransitions(collection, item)
        const toLabel = applied.newStateObj?.label ?? 'Unknown'
        await logActivity({
          action: 'pipeline-transition',
          collection,
          item,
          user: req.user?.id,
          req,
          comment: `→ ${toLabel} via ${transition.label} (bulk: ${def.label})${reason ? ` — "${reason}"` : ''}`
        })
        result.succeeded++
      } catch (err) {
        if (err instanceof TransitionBlockedError) {
          result.failed++
          result.errors.push({ item, error: err.message })
          continue
        }
        throw err
      }
    } catch (err) {
      result.failed++
      result.errors.push({
        item,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300)
      })
    }
  }
  return result
}
