import { Parser } from 'expr-eval'
import { getFormulaContext, networkdaysBetween } from './formula-context.js'
import type { FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { dbRead, db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { hooks } from '../hooks/registry.js'
import { getAncestors, getTreeConfig, type TreeConfig } from '../lib/tree.js'
import { fetchDefaultWorkspaceId } from '../middleware/workspace.js'
import type { CMSRelation, ItemsQuery, User } from '../types.js'
import {
  applyAutoIdsExt,
  autoIdFieldsFor,
  autoIdJunctionTargets,
  parseAutoIdPattern,
  recomputeAutoIdPrefix
} from './auto-ids.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { decryptItemFields, encryptItemFields } from './encryption.js'
import { evaluateRulesForTrigger } from './field-rules.js'
import { applyRowFilter, can, getAllowedFields, getRowFilter } from './permissions.js'
import { enforceContracts } from './integration-contracts.js'
import { applyUserScopesToQuery } from './user-scopes.js'
import { writeTrashRow } from './trash.js'
import { checkQuota, incrementUsage, QuotaExceededError } from './quotas.js'
import { broadcastCollectionUpdate } from './realtime.js'
import { span } from './request-trace.js'
import { applyRowRulesOnCreate } from './row-rules-autofill.js'
import { enforceValidationRules } from './validation-rules.js'
import {
  computeRollupTotal,
  parseRollupFormula,
  recalcAffectedRollups,
  type NormalizedRollup,
  type RollupSource
} from './rollups.js'
import { isPathMaintained } from './tree-path.js'
import { filterRowsByTreePermissions, getTreePermission } from './tree-permissions.js'

// Re-exported for compatibility with existing importers/tests — canonical
// definitions and the recalc engine live in ./rollups.js.
export { computeRollupTotal, parseRollupFormula }
export type { NormalizedRollup, RollupSource }

const _exprParser = new Parser({
  operators: {
    logical: true,
    comparison: true,
    in: true,
    concatenate: true
  }
})

// String helpers available in all formulas
_exprParser.functions.concat = (...args: unknown[]) =>
  args
    .filter((v) => v !== null && v !== undefined)
    .map(String)
    .join('')
_exprParser.functions.join = (sep: unknown, ...args: unknown[]) =>
  args
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map(String)
    .join(String(sep))
_exprParser.functions.upper = (s: unknown) => String(s ?? '').toUpperCase()
_exprParser.functions.lower = (s: unknown) => String(s ?? '').toLowerCase()
_exprParser.functions.trim = (s: unknown) => String(s ?? '').trim()
_exprParser.functions.len = (s: unknown) => String(s ?? '').length
_exprParser.functions.substr = (s: unknown, start: unknown, len?: unknown) =>
  String(s ?? '').substring(
    Number(start),
    len !== undefined ? Number(start) + Number(len) : undefined
  )
_exprParser.functions.replace = (s: unknown, find: unknown, rep: unknown) =>
  String(s ?? '').replaceAll(String(find), String(rep))
_exprParser.functions.coalesce = (...args: unknown[]) =>
  args.find((v) => v !== null && v !== undefined && v !== '') ?? null
// Date/business-calendar helpers (#343/#344)
_exprParser.functions.networkdays = (a: unknown, b: unknown) => {
  const da = toFormulaDate(a)
  const dbb = toFormulaDate(b)
  return da && dbb ? networkdaysBetween(da, dbb) : null
}
_exprParser.functions.fiscal_year = (d: unknown) => {
  const dt = toFormulaDate(d)
  if (!dt) return null
  const start = _formulaSnapshot.fiscalStartMonth
  return dt.getMonth() + 1 >= start ? dt.getFullYear() + (start > 1 ? 1 : 0) : dt.getFullYear()
}
_exprParser.functions.fiscal_quarter = (d: unknown) => {
  const dt = toFormulaDate(d)
  if (!dt) return null
  const start = _formulaSnapshot.fiscalStartMonth
  const offset = (dt.getMonth() + 1 - start + 12) % 12
  return Math.floor(offset / 3) + 1
}
function toFormulaDate(v: unknown): Date | null {
  if (v instanceof Date) return v
  if (typeof v !== 'string' || !v) return null
  const d = v.length === 10 ? new Date(`${v}T00:00:00`) : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}
// Sync snapshot of the formula context — refreshed fire-and-forget wherever
// computed fields are about to run (evalFormula itself is synchronous).
let _formulaSnapshot: { constants: Record<string, number>; fiscalStartMonth: number } = {
  constants: {},
  fiscalStartMonth: 1
}
function refreshFormulaSnapshot(): void {
  getFormulaContext()
    .then((ctx) => {
      _formulaSnapshot = ctx
    })
    .catch(() => {})
}

export class CollectionNotFoundError extends Error {
  constructor(collection: string) {
    super(`Collection "${collection}" not found in registry`)
    this.name = 'CollectionNotFoundError'
  }
}

/**
 * Collections the generic items API refuses to serve.
 *
 * `chat_messages` visibility is per-ROOM, which a table-level policy cannot
 * express — before this, any role holding `read` could list every DM and every
 * entity room through /api/items (verified: a non-admin got other users' DMs
 * back). Serving it here would leave the door the /api/chat gate closes, and
 * GraphQL resolves through this same service, so one guard covers both.
 */
const ROUTE_ONLY_COLLECTIONS = new Map<string, string>([
  ['chat_messages', '/api/chat/messages'],
  ['chat_last_read', '/api/chat/rooms/:room/read']
])

export class RouteOnlyCollectionError extends Error {
  statusCode = 403
  constructor(collection: string, route: string) {
    super(`${collection} is only available through ${route}, which enforces per-room visibility`)
    this.name = 'RouteOnlyCollectionError'
  }
}

function assertNotRouteOnly(collection: string): void {
  const route = ROUTE_ONLY_COLLECTIONS.get(collection)
  if (route) throw new RouteOnlyCollectionError(collection, route)
}

// ─── Change-reason requirement ───────────────────────────────────────────────
// nivaro_collections.change_reason_config: { fields, reasons?, allow_free_text? }
// When a listed field actually changes in an update, the caller must supply
// `_change_reason` (stripped from the payload; stored on the activity row).
export interface ChangeReasonConfig {
  fields: string[]
  reasons?: string[]
  allow_free_text?: boolean
}

export function parseChangeReasonConfig(raw: unknown): ChangeReasonConfig | null {
  if (!raw) return null
  try {
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!cfg || !Array.isArray(cfg.fields) || cfg.fields.length === 0) return null
    return {
      fields: cfg.fields.map(String),
      reasons: Array.isArray(cfg.reasons) ? cfg.reasons.map(String).filter(Boolean) : [],
      allow_free_text: cfg.allow_free_text !== false
    }
  } catch {
    return null
  }
}

export class ChangeReasonRequiredError extends Error {
  statusCode = 422
  code = 'CHANGE_REASON_REQUIRED'
  violations: { fields_changed: string[]; reasons: string[]; allow_free_text: boolean }
  constructor(fieldsChanged: string[], cfg: ChangeReasonConfig) {
    super(`A reason is required when changing: ${fieldsChanged.join(', ')}`)
    this.name = 'ChangeReasonRequiredError'
    this.violations = {
      fields_changed: fieldsChanged,
      reasons: cfg.reasons ?? [],
      allow_free_text: cfg.allow_free_text !== false
    }
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('Forbidden')
    this.name = 'ForbiddenError'
  }
}

/** Deletion protection rule fired (#64) — 409 with the rule's own message. */
export class DeleteGuardError extends Error {
  statusCode = 409
  code = 'DELETE_GUARDED'
}

export class ItemNotFoundError extends Error {
  /** Picked up by Fastify's default error handler so re-thrown errors return 404. */
  statusCode = 404

  constructor() {
    super('Not found')
    this.name = 'ItemNotFoundError'
  }
}

type QB = Knex.QueryBuilder

// Per-process cache of actual DB columns per table. Schema is fixed at runtime.
const columnCache = new Map<string, Set<string>>()

export async function getActualColumns(table: string): Promise<Set<string>> {
  const cached = columnCache.get(table)
  if (cached) return cached
  const rows = rawRows<{ COLUMN_NAME: string }>(await db.raw(
    `SELECT COLUMN_NAME AS "COLUMN_NAME" FROM information_schema.columns WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    [table]
  ))
  const set = new Set(rows.map(r => r.COLUMN_NAME))
  columnCache.set(table, set)
  return set
}

function filterToActualColumns(payload: Record<string, unknown>, cols: Set<string>) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([k]) => cols.has(k))
      .map(([k, v]) => [
        k,
        Array.isArray(v) || (v !== null && typeof v === 'object' && !(v instanceof Date))
          ? JSON.stringify(v)
          : v
      ])
  )
}

// ─── Row-level workspace isolation ────────────────────────────────────────────

const WORKSPACE_COLUMN = 'workspace_id'

// 60s TTL cache — workspace_id columns can be added at runtime via the data model.
const wsColumnCache = new Map<string, { exists: boolean; at: number }>()
const WS_COLUMN_TTL_MS = 60_000

/** True when the collection's physical table has a `workspace_id` column. */
export async function workspaceColumnExists(collection: string): Promise<boolean> {
  const hit = wsColumnCache.get(collection)
  if (hit && Date.now() - hit.at < WS_COLUMN_TTL_MS) return hit.exists
  let exists = false
  try {
    const info = await db(collection).columnInfo()
    exists = WORKSPACE_COLUMN in info
  } catch {
    exists = false
  }
  wsColumnCache.set(collection, { exists, at: Date.now() })
  return exists
}

/**
 * Scope a query to the active workspace. No-op when no workspaceId is passed
 * (existing callers) or when the collection has no workspace_id column.
 * Rule: rows without a workspace value belong to the default workspace — so the
 * default workspace sees NULL rows plus its own; any other workspace sees only
 * rows explicitly tagged with its id.
 */
export async function applyWorkspaceScope(
  q: QB,
  collection: string,
  workspaceId: string | undefined
): Promise<void> {
  if (!workspaceId) return
  if (!(await workspaceColumnExists(collection))) return
  const defaultId = await fetchDefaultWorkspaceId()
  const col = `${collection}.${WORKSPACE_COLUMN}`
  if (workspaceId === defaultId) {
    q.where((w) => {
      w.whereNull(col).orWhere(col, workspaceId)
    })
  } else {
    q.where(col, workspaceId)
  }
}

// ─── JSON helper ─────────────────────────────────────────────────────────────

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

// ─── Computed field evaluation ────────────────────────────────────────────────

/**
 * Safely evaluate a formula string with the item object as context.
 * Returns null on any error.
 */
function evalFormula(formula: string, item: Record<string, unknown>): unknown {
  try {
    // expr-eval's Value type is narrower than Record<string,unknown> but handles nested objects fine at runtime
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = _exprParser.evaluate(formula, { item, ..._formulaSnapshot.constants } as any)
    // NaN means a field reference resolved to undefined (e.g. missing field in payload).
    // Treat as formula failure so we don't overwrite a valid client value with NaN,
    // which tedious rejects as "Invalid number" for numeric columns.
    if (typeof result === 'number' && isNaN(result)) return null
    return result
  } catch {
    return null
  }
}

interface ComputedFieldRow {
  field: string
  computed_formula: string | null
  computed_type: string | null
  computed_store: boolean | number
}

/**
 * Load computed fields for a collection from the DB.
 * Returns only rows that have a non-null computed_formula.
 */
async function getComputedFields(collection: string): Promise<ComputedFieldRow[]> {
  refreshFormulaSnapshot()
  try {
    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereNotNull('computed_formula')
      .select('field', 'computed_formula', 'computed_type', 'computed_store')) as ComputedFieldRow[]
    return rows
  } catch {
    // Column may not exist yet before migration runs — non-fatal.
    return []
  }
}

/**
 * Apply read-time computed fields to an array of item objects.
 * Mutates each item in place.
 */
async function applyReadComputedFields(
  collection: string,
  items: Record<string, unknown>[],
  requestedFields?: string[]
): Promise<void> {
  if (!items.length) return
  const fields = await getComputedFields(collection)
  // Explicit fields= requests only compute what was asked for — a virtual rollup
  // costs one aggregate query PER ROW, and pickers fetching `fields=id,<label>`
  // must not pay for rollups they never render (workflows list read was 14s).
  const wanted = (f: { field: string }) => !requestedFields || requestedFields.includes(f.field)
  const readFields = fields.filter((f) => f.computed_type === 'read' && f.computed_formula && wanted(f))
  const rollupFields = fields.filter(
    (f) => f.computed_type === 'rollup' && f.computed_formula && wanted(f)
  )
  if (!readFields.length && !rollupFields.length) return

  for (const item of items) {
    for (const f of readFields) {
      item[f.field] = evalFormula(f.computed_formula as string, item)
    }

    // Rollup fields aggregate related items. N+1 over items × rollup fields is
    // acceptable for now; each rollup runs its own query per item. Fields with
    // computed_store are written at write time and already sit on the row —
    // recomputing them here would be redundant and defeats the point of storing.
    for (const f of rollupFields) {
      if (f.computed_store === true || f.computed_store === 1) continue
      const cfg = parseRollupFormula(f.computed_formula as string)
      if (!cfg) {
        item[f.field] = null
        continue
      }
      item[f.field] = await computeRollupTotal(cfg, item.id, collection)
    }
  }
}

/**
 * Apply write-time computed fields.
 * Evaluates each formula with `context` (full merged record) and writes the result
 * directly into `payload` for stored fields (computed_store=true).
 * `context` should be the merged { ...previousData, ...payload } so formulas can
 * read existing field values even when they are not in the incoming payload.
 */
async function applyWriteComputedFields(
  collection: string,
  payload: Record<string, unknown>,
  context?: Record<string, unknown>
): Promise<void> {
  const fields = await getComputedFields(collection)
  const writeFields = fields.filter((f) => f.computed_type === 'write' && f.computed_formula)

  // Lookup fields (#349): computed_type 'lookup', computed_formula JSON
  // {fk_field, source_field} — when the FK is present in the write (set or
  // changed), copy the target record's source_field into this column. A
  // write-time snapshot, deliberately not live: the copied value records
  // what the target said WHEN the link was made (price-at-order semantics).
  // A null/cleared FK clears the copy. Failures never block the write.
  const lookupFields = fields.filter((f) => f.computed_type === 'lookup' && f.computed_formula)
  for (const f of lookupFields) {
    try {
      const cfg = JSON.parse(f.computed_formula as string) as {
        fk_field?: string
        source_field?: string
      }
      if (!cfg?.fk_field || !cfg?.source_field) continue
      if (!(cfg.fk_field in payload)) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.source_field)) continue
      const fkVal = payload[cfg.fk_field]
      if (fkVal === null || fkVal === undefined || fkVal === '') {
        payload[f.field] = null
        continue
      }
      const rel = (await getRelsForCollection(collection)).find(
        (r) => r.many_collection === collection && r.many_field === cfg.fk_field && r.one_collection
      )
      if (!rel?.one_collection) continue
      const target = await db(rel.one_collection)
        .where({ id: fkVal })
        .select(cfg.source_field)
        .first()
      if (target && cfg.source_field in target) payload[f.field] = target[cfg.source_field]
    } catch {
      // bad config or unreadable target — leave the column alone
    }
  }

  if (!writeFields.length) return

  const evalCtx = context ?? payload
  for (const f of writeFields) {
    const store = f.computed_store === true || f.computed_store === 1
    // Always evaluate the formula; only write to payload when computed_store=true.
    // Skip overwrite when result is null (formula failure) to preserve any client-provided value.
    const result = evalFormula(f.computed_formula as string, evalCtx)
    if (store && result !== null) {
      payload[f.field] = result
    }
  }
}

// ─── Rule evaluation ───────────────────────────────────────────────────────────

interface RuleCondition {
  field: string
  op: string
  value: unknown
}

interface RuleAction {
  type: string
  field?: string
  value?: unknown
}

function conditionsMatch(conditions: RuleCondition[], data: Record<string, unknown>): boolean {
  if (!conditions.length) return true
  return conditions.every((c) => {
    const val = data[c.field]
    switch (c.op) {
      case 'eq':
        // biome-ignore lint/suspicious/noDoubleEquals: loose compare intended for rule matching
        return val == c.value
      case 'ne':
        // biome-ignore lint/suspicious/noDoubleEquals: loose compare intended for rule matching
        return val != c.value
      case 'lt':
        return Number(val) < Number(c.value)
      case 'gt':
        return Number(val) > Number(c.value)
      case 'lte':
        return Number(val) <= Number(c.value)
      case 'gte':
        return Number(val) >= Number(c.value)
      case 'contains':
        return String(val).includes(String(c.value))
      case 'in':
        return Array.isArray(c.value) && (c.value as unknown[]).includes(val)
      default:
        return true
    }
  })
}

/**
 * Evaluate stored rules for a collection + trigger. `set_field` actions mutate
 * `payload` in place when the trigger is a "before" phase. Non-fatal on error.
 */
async function evaluateRules(
  collection: string,
  trigger: string,
  payload: Record<string, unknown>,
  previousData?: Record<string, unknown>
): Promise<void> {
  let rules: Array<{ conditions: string | null; actions: string | null }>
  try {
    rules = (await db('nivaro_rules')
      .where({ collection, trigger, enabled: true })
      .orderBy('sort')
      .select('*')) as Array<{ conditions: string | null; actions: string | null }>
  } catch {
    // Rules table may not exist yet — non-fatal.
    return
  }

  for (const rule of rules) {
    const conditions = parseJson<RuleCondition[]>(rule.conditions) ?? []
    const actions = parseJson<RuleAction[]>(rule.actions) ?? []

    const data = trigger.startsWith('before') ? payload : (previousData ?? payload)
    if (!conditionsMatch(conditions, data)) continue

    for (const action of actions) {
      if (action.type === 'set_field' && action.field && trigger.startsWith('before')) {
        payload[action.field] = action.value
      }
      // 'reject' and 'notify' handled separately
    }
  }
}

// ─── Field rules ───────────────────────────────────────────────────────────────

/**
 * Apply per-collection field rules to a payload. Lightweight inline field
 * defaults: when a trigger field matches a condition, set/clear a target field.
 * Mutates `payload` in place. Non-fatal on error.
 *
 * When `changedField` is provided, only rules triggered by that field are
 * evaluated (used for real-time evaluation in the item editor). When omitted,
 * all active rules whose trigger field is present in the payload are evaluated
 * (used on save).
 */
async function applyDatetimeAutoFields(
  collection: string,
  payload: Record<string, unknown>,
  event: 'on_create' | 'on_update'
): Promise<void> {
  const fields = (await db('nivaro_fields')
    .where({ collection })
    .whereNotNull('options')
    .select('field', 'options')) as Array<{ field: string; options: string | null }>

  const now = new Date().toISOString()
  for (const f of fields) {
    try {
      const opts = JSON.parse(f.options ?? '{}') as Record<string, unknown>
      if (opts[event] === 'now') payload[f.field] = now
    } catch { /* malformed options — skip */ }
  }
}

export async function applyFieldRules(
  collection: string,
  payload: Record<string, unknown>,
  changedField?: string
): Promise<void> {
  let triggerFields: string[]
  try {
    if (changedField) {
      triggerFields = [changedField]
    } else {
      triggerFields = ((await db('nivaro_field_rules')
        .where({ collection, is_active: true })
        .orderBy('sort')
        .distinct('trigger_field')
        .pluck('trigger_field')) as string[]).filter((f) => f in payload)
    }
  } catch {
    // Table may not exist yet before migration runs — non-fatal.
    return
  }

  // Delegates static set/clear matching and dynamic (set_lookup/set_from_trigger)
  // + only_when_empty resolution to the shared engine used by POST /field-rules/evaluate.
  for (const triggerField of triggerFields) {
    if (!(triggerField in payload)) continue
    const updates = await evaluateRulesForTrigger(db, collection, triggerField, payload[triggerField], payload)
    Object.assign(payload, updates)
  }
}

// ─── Inherited field values (tree collections) ───────────────────────────────

// 60s TTL cache of inheritable field names per collection — keeps the read
// path at zero extra queries for collections without inheritable fields.
const inheritableFieldsCache = new Map<string, { fields: string[]; at: number }>()
const INHERITABLE_TTL_MS = 60_000

async function getInheritableFields(collection: string): Promise<string[]> {
  const hit = inheritableFieldsCache.get(collection)
  if (hit && Date.now() - hit.at < INHERITABLE_TTL_MS) return hit.fields
  let fields: string[] = []
  try {
    fields = (await db('nivaro_fields')
      .where({ collection, is_inheritable: true })
      .pluck('field')) as string[]
  } catch {
    // Column may not exist before migration 059 — feature inactive.
    fields = []
  }
  inheritableFieldsCache.set(collection, { fields, at: Date.now() })
  return fields
}

function isEmptyValue(v: unknown): boolean {
  return v == null || v === ''
}

/**
 * Fill null/empty inheritable fields from the nearest ancestor in the
 * collection's tree. Runs after decryption and before computed fields so
 * formulas see the effective (inherited) values.
 *
 * Each row that inherits anything gets a sidecar `_inherited` map:
 *   `{ <field>: <ancestorId> }`
 * so the UI can render an "inherited from" / override indicator. Rows where
 * every inheritable field has its own value carry no sidecar.
 *
 * Ancestor resolution: when the tree config maintains a path column, ancestor
 * ids are parsed straight from `path` and all ancestor rows are fetched with
 * a single whereIn. Otherwise a per-row recursive CTE (depth-capped at 100)
 * is used. Zero cost when the collection has no inheritable fields or no
 * tree config.
 */
async function applyInheritedFields(
  collection: string,
  items: Record<string, unknown>[]
): Promise<void> {
  if (!items.length) return

  const fields = await getInheritableFields(collection)
  if (!fields.length) return

  let config: TreeConfig | null = null
  try {
    config = await getTreeConfig(collection)
  } catch {
    return
  }
  if (!config) return

  const needy = items.filter((it) => it.id != null && fields.some((f) => isEmptyValue(it[f])))
  if (!needy.length) return

  const usePath = isPathMaintained(config)

  // Per-item ancestor id chain, nearest ancestor first (self excluded)
  const chains = new Map<unknown, string[]>()
  // Ancestor rows keyed by String(id) — filled from whereIn batch and/or CTE rows
  const ancestorRows = new Map<string, Record<string, unknown>>()
  const pathAncestorIds = new Set<string>()

  for (const item of needy) {
    const p = item.path
    if (usePath && typeof p === 'string' && p.startsWith('/')) {
      const parts = p.split('/').filter(Boolean)
      parts.pop() // drop self
      parts.reverse() // nearest ancestor first
      chains.set(item.id, parts)
      for (const a of parts) pathAncestorIds.add(a)
    } else {
      // CTE fallback — getAncestors returns full ancestor rows (root-first,
      // self last) so no second fetch is needed for these.
      try {
        const ancestors = await getAncestors(config, item.id)
        const others = ancestors.filter((n) => String(n.id) !== String(item.id))
        chains.set(item.id, others.map((n) => String(n.id)).reverse())
        for (const row of others) {
          if (!ancestorRows.has(String(row.id))) {
            ancestorRows.set(String(row.id), await decryptItemFields(collection, { ...row }))
          }
        }
      } catch {
        chains.set(item.id, [])
      }
    }
  }

  // Single batched fetch for all path-derived ancestor ids
  if (pathAncestorIds.size) {
    const missing = [...pathAncestorIds].filter((id) => !ancestorRows.has(id))
    if (missing.length) {
      const rows = (await db(collection).whereIn('id', missing)) as Record<string, unknown>[]
      for (const row of rows) {
        ancestorRows.set(String(row.id), await decryptItemFields(collection, row))
      }
    }
  }

  for (const item of needy) {
    const chain = chains.get(item.id) ?? []
    if (!chain.length) continue

    let inherited: Record<string, unknown> | null = null
    for (const f of fields) {
      if (!isEmptyValue(item[f])) continue
      for (const ancestorId of chain) {
        const row = ancestorRows.get(ancestorId)
        if (!row) continue
        const v = row[f]
        if (!isEmptyValue(v)) {
          item[f] = v
          if (!inherited) inherited = {}
          inherited[f] = row.id ?? ancestorId
          break
        }
      }
    }
    if (inherited) item._inherited = inherited
  }
}

// ─── Relation helpers ─────────────────────────────────────────────────────────

/** Cache of relations per collection to avoid redundant DB calls within a request */
/** Per-process read-log throttle: one 'read' row per user/record/hour. */
const readLogThrottle = new Map<string, number>()
const relCache = new Map<string, CMSRelation[]>()

async function getRelsForCollection(collection: string): Promise<CMSRelation[]> {
  const cached = relCache.get(collection)
  if (cached) return cached
  const rels = await getRelations(collection)
  relCache.set(collection, rels)
  return rels
}

function clearRelCache() {
  relCache.clear()
}

/**
 * Split a fields array into direct column names and a nested expansion map.
 * e.g. ['id', 'name', 'category.name', 'category.id', 'project.*']
 *   → { direct: ['id', 'name', 'category', 'project'], nested: { category: ['name', 'id'], project: ['*'] } }
 * Wildcard parent '*' collects sub-fields for "expand all M2O relations".
 */
function parseFieldExpansion(fields: string[]): {
  direct: string[]
  nested: Record<string, string[]>
} {
  const direct = new Set<string>()
  const nested: Record<string, string[]> = {}
  for (const f of fields) {
    if (f === '*') { direct.add('*'); continue }
    const dot = f.indexOf('.')
    if (dot === -1) {
      direct.add(f)
    } else {
      const parent = f.slice(0, dot)
      const rest = f.slice(dot + 1)
      if (parent !== '*') direct.add(parent) // keep FK column in SELECT
      nested[parent] = nested[parent] ?? []
      nested[parent].push(rest)
    }
  }
  return { direct: [...direct], nested }
}

/**
 * Recursively expand M2O relations in-place on an items array.
 * Depth-capped at 5 to prevent runaway recursion.
 * Applies full authorization for each expanded collection:
 *   - collection-level can() check
 *   - column-level getAllowedFields() filtering
 *   - SYSTEM_SENSITIVE column stripping
 *   - workspace scope
 *   - row-level security (row_filter)
 */
async function expandRelations(
  user: User,
  items: Record<string, unknown>[],
  collection: string,
  nested: Record<string, string[]>,
  depth: number,
  workspaceId?: string
): Promise<void> {
  if (depth > 4 || items.length === 0 || Object.keys(nested).length === 0) return

  const rels = await getRelsForCollection(collection)

  // Resolve wildcard parent: expand ALL M2O relations for this collection
  let expandEntries = Object.entries(nested).filter(([k]) => k !== '*')
  if ('*' in nested) {
    const wildcardSubs = nested['*']
    for (const r of rels) {
      if (r.many_collection === collection && r.many_field && !r.junction_field) {
        const f = r.many_field
        if (!expandEntries.find(([k]) => k === f)) {
          expandEntries.push([f, wildcardSubs])
        }
      }
    }
  }

  const SYSTEM_SENSITIVE: Record<string, string[]> = {
    nivaro_users: ['password_hash', 'totp_secret', 'static_token', 'external_id']
  }

  for (const [fieldName, subFields] of expandEntries) {
    const rel = rels.find(
      (r) => r.many_collection === collection && r.many_field === fieldName && !r.junction_field
    )
    if (!rel?.one_collection) continue

    const relCollection = rel.one_collection

    // Collection-level permission check
    const [allowed, relAllowedFields, rowFilter] = await Promise.all([
      can(user, 'read', relCollection),
      getAllowedFields(user, 'read', relCollection),
      getRowFilter(user, 'read', relCollection)
    ])
    if (!allowed) continue

    // Collect unique FK values
    const fkSet = new Set<string>()
    for (const item of items) {
      const v = item[fieldName]
      if (v != null && v !== '') fkSet.add(String(v))
    }
    if (fkSet.size === 0) continue

    const { direct: subDirect, nested: subNested } = parseFieldExpansion(subFields)

    // Column-level permission filtering
    let selectCols: string[] =
      relAllowedFields === null
        ? subDirect[0] === '*'
          ? ['*']
          : [...new Set(['id', ...subDirect])]
        : subDirect[0] === '*'
          ? [...new Set(['id', ...relAllowedFields])]
          : [...new Set(['id', ...subDirect.filter((f) => relAllowedFields.includes(f))])]

    // Strip system-sensitive columns
    const sensitiveCols = SYSTEM_SENSITIVE[relCollection]
    if (sensitiveCols) {
      if (selectCols[0] === '*') {
        const allCols = await db(relCollection).columnInfo()
        selectCols = Object.keys(allCols).filter((c) => !sensitiveCols.includes(c))
      } else {
        selectCols = selectCols.filter((f) => !sensitiveCols.includes(f))
      }
    }

    // Batch fetch — cap at 1000 unique FKs
    const batchValues = [...fkSet].slice(0, 1000)
    const relQ = db(relCollection)
      .whereIn('id', batchValues)
      .select(selectCols as string[])
      .limit(1000)

    // Workspace scope and row-level security
    await applyWorkspaceScope(relQ, relCollection, workspaceId)
    if (rowFilter) applyRowFilter(relQ, rowFilter, user)

    let relItems = (await relQ) as Record<string, unknown>[]

    // Decrypt encrypted fields on expanded items
    relItems = await Promise.all(relItems.map((r) => decryptItemFields(relCollection, r)))

    // Recurse for deeper expansion
    if (Object.keys(subNested).length > 0) {
      await expandRelations(user, relItems, relCollection, subNested, depth + 1, workspaceId)
    }

    // Merge onto parent items — FK stays as-is if related item was filtered out by RLS
    const byId = new Map(relItems.map((r) => [String(r.id), r]))
    for (const item of items) {
      const fk = item[fieldName]
      if (fk != null) item[fieldName] = byId.get(String(fk)) ?? fk
    }
  }
}

/**
 * Find an M2O relation for a given key in the given collection.
 * Matches by exact many_field name OR by alias (many_field with _id stripped).
 * Returns { rel, fkField } or null.
 */
function findM2ORelation(
  key: string,
  collection: string,
  rels: CMSRelation[]
): { rel: CMSRelation; fkField: string } | null {
  for (const rel of rels) {
    if (rel.many_collection !== collection) continue
    if (rel.junction_field != null) continue // M2M junction — not M2O
    if (!rel.one_collection) continue

    const fk = rel.many_field
    if (fk === key) return { rel, fkField: fk }
    // alias: strip _id suffix (e.g. key="author" matches fk="author_id")
    const alias = fk.endsWith('_id') ? fk.slice(0, -3) : null
    if (alias && alias === key) return { rel, fkField: fk }
  }
  return null
}

/**
 * Find an O2M relation (no junction_field) for the given virtual field key.
 * The key matches one_field on a relation where one_collection=collection.
 */
function findO2MRelation(key: string, collection: string, rels: CMSRelation[]): CMSRelation | null {
  for (const rel of rels) {
    if (rel.one_collection !== collection) continue
    if (rel.junction_field != null) continue // M2M — skip
    if (rel.one_field === key) return rel
  }
  return null
}

/**
 * Find an M2M relation for the given virtual field key.
 * Key matches one_field on a relation where one_collection=collection and junction_field≠null.
 * Returns { junction, fkToParent, fkToOther, otherCollection } or null.
 */
export function findM2MRelation(
  key: string,
  collection: string,
  rels: CMSRelation[]
): { junction: string; fkToParent: string; fkToOther: string; otherCollection: string } | null {
  // Two passes: exact one_field match wins; then the junction-table-name fallback the
  // admin UI uses for legacy alias fields named after the junction. Without it, an
  // alias like 'workflows_files' renders in forms but silently fails to resolve here.
  for (const exact of [true, false]) {
    for (const rel of rels) {
      if (rel.one_collection !== collection) continue
      if (rel.junction_field == null) continue
      if (exact ? rel.one_field !== key : rel.many_collection !== key) continue

      // Find the other FK in the junction table
      const otherRel = rels.find(
        (r) => r.many_collection === rel.many_collection && r.many_field === rel.junction_field
      )
      if (!otherRel?.one_collection) continue

      return {
        junction: rel.many_collection,
        fkToParent: rel.many_field,
        fkToOther: rel.junction_field,
        otherCollection: otherRel.one_collection
      }
    }
  }
  return null
}

/**
 * When a row is written to a junction collection (M2M through-table), any auto_id
 * field on the parent side whose pattern draws a token from that junction
 * (e.g. `{funding_years[0] % 100}`) may now render a different prefix — the row
 * just inserted/deleted changes which value "wins" the ordered lookup. Recompute
 * and write those parent fields. Never throws — mirrors recalcAffectedRollups.
 */
async function recomputeJunctionAutoIds(
  junctionCollection: string,
  row: Record<string, unknown> | null | undefined
): Promise<void> {
  if (!row) return
  try {
    const targets = await autoIdJunctionTargets(db, junctionCollection)
    for (const target of targets) {
      const parentId = row[target.parentFkField]
      if (parentId == null) continue

      const currentRow = (await db(target.parentCollection)
        .where({ id: parentId })
        .first(target.field)) as Record<string, unknown> | undefined

      const newVal = await recomputeAutoIdPrefix(
        db,
        target.parentCollection,
        target.field,
        target.config,
        parentId,
        {}
      )
      if (newVal != null && newVal !== currentRow?.[target.field]) {
        await db(target.parentCollection)
          .where({ id: parentId })
          .update({ [target.field]: newVal })
      }
    }
  } catch {
    // Non-fatal — the primary create/delete already succeeded.
  }
}

// ─── Filter operators ─────────────────────────────────────────────────────────

function applyOneFilterOp(q: QB, key: string, op: string, val: unknown) {
  switch (op) {
    case '_eq':
      q.where(db.raw('??', [key]), '=', val as Knex.Value)
      break
    case '_neq':
      q.where(db.raw('??', [key]), '!=', val as Knex.Value)
      break
    case '_gt':
      q.where(db.raw('??', [key]), '>', val as Knex.Value)
      break
    case '_gte':
      q.where(db.raw('??', [key]), '>=', val as Knex.Value)
      break
    case '_lt':
      q.where(db.raw('??', [key]), '<', val as Knex.Value)
      break
    case '_lte':
      q.where(db.raw('??', [key]), '<=', val as Knex.Value)
      break
    case '_in':
      q.whereIn(db.raw('??', [key]) as unknown as string, val as Knex.Value[])
      break
    case '_nin':
      q.whereNotIn(db.raw('??', [key]) as unknown as string, val as Knex.Value[])
      break
    case '_null':
      q.whereNull(db.raw('??', [key]) as unknown as string)
      break
    case '_nnull':
      q.whereNotNull(db.raw('??', [key]) as unknown as string)
      break
    case '_contains':
      q.where(db.raw('??', [key]), 'like', `%${val}%`)
      break
    case '_ncontains':
      q.where(db.raw('??', [key]), 'not like', `%${val}%`)
      break
    case '_starts_with':
      q.where(db.raw('??', [key]), 'like', `${val}%`)
      break
    case '_ends_with':
      q.where(db.raw('??', [key]), 'like', `%${val}`)
      break
  }
}

/**
 * Apply a nested filter object onto query builder `q`.
 * Handles _and/_or logical combinators, M2O/O2M/M2M relation traversal, and scalar operators.
 * `collection` is the table `q` is currently querying.
 * `rels` are the relations for `collection` (pre-loaded by the caller).
 */
function applyFilters(
  q: QB,
  filter: Record<string, unknown>,
  collection: string,
  rels: CMSRelation[]
): void {
  for (const [key, value] of Object.entries(filter)) {
    // ── Logical combinators ──────────────────────────────────────────────────
    if (key === '_and' && Array.isArray(value)) {
      q.where((sub) => {
        for (const clause of value as Record<string, unknown>[]) {
          sub.where((inner) => applyFilters(inner, clause, collection, rels))
        }
      })
      continue
    }

    if (key === '_or' && Array.isArray(value)) {
      q.where((sub) => {
        for (const clause of value as Record<string, unknown>[]) {
          sub.orWhere((inner) => applyFilters(inner, clause, collection, rels))
        }
      })
      continue
    }

    // ── M2O relation ─────────────────────────────────────────────────────────
    const m2oMatch = findM2ORelation(key, collection, rels)
    if (m2oMatch && typeof value === 'object' && value !== null) {
      const { rel, fkField } = m2oMatch
      const relatedCollection = rel.one_collection as string
      const nestedFilter = value as Record<string, unknown>

      // Check if all keys are operator keys (start with _) → filter on the FK column itself
      const allOperators = Object.keys(nestedFilter).every((k) => k.startsWith('_'))
      if (allOperators) {
        // Treat as scalar filter on the FK column
        for (const [op, val] of Object.entries(nestedFilter)) {
          applyOneFilterOp(q, `${collection}.${fkField}`, op, val)
        }
      } else {
        // Nested relation filter → EXISTS subquery
        q.whereExists(function (this: QB) {
          this.select(db.raw('1'))
            .from(relatedCollection)
            .whereRaw('??.?? = ??.??', [relatedCollection, 'id', collection, fkField])

          // Load rels for the related collection synchronously from cache,
          // or fall back to applying filters without relation awareness if not cached.
          // We prime the cache before the query so nested relations work too.
          const relatedRels = relCache.get(relatedCollection) ?? []
          applyFilters(this, nestedFilter, relatedCollection, relatedRels)
        })
      }
      continue
    }

    // ── O2M relation ─────────────────────────────────────────────────────────
    const o2mMatch = findO2MRelation(key, collection, rels)
    if (o2mMatch && typeof value === 'object' && value !== null) {
      const nestedFilter = value as Record<string, unknown>
      const manyCollection = o2mMatch.many_collection
      const manyField = o2mMatch.many_field

      const hasSome = '_some' in nestedFilter
      const hasNone = '_none' in nestedFilter

      if (hasSome || hasNone) {
        const innerFilter = (nestedFilter['_some'] ?? nestedFilter['_none']) as Record<
          string,
          unknown
        >
        const manyRels = relCache.get(manyCollection) ?? []

        const subFn = function (this: QB) {
          this.select(db.raw('1'))
            .from(manyCollection)
            .whereRaw('??.?? = ??.??', [manyCollection, manyField, collection, 'id'])
          applyFilters(this, innerFilter, manyCollection, manyRels)
        }

        if (hasSome) {
          q.whereExists(subFn)
        } else {
          q.whereNotExists(subFn)
        }
      }
      continue
    }

    // ── M2M relation ─────────────────────────────────────────────────────────
    const m2mMatch = findM2MRelation(key, collection, rels)
    if (m2mMatch && typeof value === 'object' && value !== null) {
      const nestedFilter = value as Record<string, unknown>
      const { junction, fkToParent, fkToOther, otherCollection } = m2mMatch

      const hasSome = '_some' in nestedFilter
      const hasNone = '_none' in nestedFilter

      if (hasSome || hasNone) {
        const innerFilter = (nestedFilter['_some'] ?? nestedFilter['_none']) as Record<
          string,
          unknown
        >
        const otherRels = relCache.get(otherCollection) ?? []

        const subFn = function (this: QB) {
          this.select(db.raw('1'))
            .from(junction)
            .whereRaw('??.?? = ??.??', [junction, fkToParent, collection, 'id'])
            .whereExists(function (this: QB) {
              this.select(db.raw('1'))
                .from(otherCollection)
                .whereRaw('??.?? = ??.??', [otherCollection, 'id', junction, fkToOther])
              applyFilters(this, innerFilter, otherCollection, otherRels)
            })
        }

        if (hasSome) {
          q.whereExists(subFn)
        } else {
          q.whereNotExists(subFn)
        }
      }
      continue
    }

    // ── Junction existence filter (for cascade parent → O2M child M2O) ─────
    if (key === '_exists_junction') {
      const { table, self_fk, filter_fk, value: filterValue } = value as {
        table: string; self_fk: string; filter_fk: string; value: unknown
      }
      // Security: validate table/self_fk/filter_fk against the loaded relation
      // metadata for this collection. Accepts only identifiers that correspond to
      // a real M2M junction row in nivaro_relations — prevents table/column injection.
      const isValidJunction = rels.some(
        (r) => r.many_collection === table && r.many_field === self_fk && r.junction_field === filter_fk
      )
      if (!isValidJunction) {
        q.whereRaw('1=0') // deny — invalid junction identifier
        continue
      }
      q.whereExists(function (this: QB) {
        this.select(db.raw('1'))
          .from(table)
          .whereRaw('??.?? = ??.??', [table, self_fk, collection, 'id'])
          .where(db.raw('??', [`${table}.${filter_fk}`]), '=', filterValue as Knex.Value)
      })
      continue
    }

    // ── Scalar field ─────────────────────────────────────────────────────────
    if (typeof value === 'object' && value !== null) {
      const ops = value as Record<string, unknown>
      for (const [op, val] of Object.entries(ops)) {
        applyOneFilterOp(q, key, op, val)
      }
    } else {
      q.where(db.raw('??', [key]), '=', value as Knex.Value)
    }
  }
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

/**
 * Apply sort strings to query builder.
 * Supports dotted paths for relation traversal (M2O only) via LEFT JOIN.
 * Alias examples: `author.first_name`, `-status.label`, `author.org.name`
 */
async function applySorts(
  q: QB,
  sorts: string[],
  collection: string,
  rels: CMSRelation[]
): Promise<void> {
  let joinCounter = 0

  for (const s of sorts) {
    const desc = s.startsWith('-')
    const path = desc ? s.slice(1) : s
    const direction = desc ? 'desc' : 'asc'

    if (!path.includes('.')) {
      // Simple scalar sort
      q.orderBy(path, direction)
      continue
    }

    // Dotted path — walk M2O hops, LEFT JOIN each intermediate table
    const segments = path.split('.')
    let currentCollection = collection
    let currentRels = rels
    let currentAlias = collection // tracks the alias/table of the current hop
    let valid = true

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const m2oMatch = findM2ORelation(seg, currentCollection, currentRels)
      if (!m2oMatch) {
        valid = false
        break
      }

      const nextCollection = m2oMatch.rel.one_collection as string
      const fkField = m2oMatch.fkField
      const joinAlias = `_sort_${joinCounter++}`

      q.leftJoin(
        `${nextCollection} as ${joinAlias}`,
        `${joinAlias}.id`,
        `${currentAlias}.${fkField}`
      )

      currentCollection = nextCollection
      currentAlias = joinAlias
      // Load rels for next collection (from cache or DB)
      currentRels = await getRelsForCollection(currentCollection)
    }

    if (!valid) {
      // Fall back to raw column sort if path could not be resolved
      q.orderBy(path, direction)
      continue
    }

    const finalColumn = segments[segments.length - 1]
    q.orderBy(`${currentAlias}.${finalColumn}`, direction)
  }
}

// ─── Legacy path-based conditions (kept for backwards compat) ─────────────────

function applyOneFilter(q: QB, field: string, op: string, value: unknown): QB {
  switch (op) {
    case '_eq':
      return q.where(db.raw('??', [field]), '=', value as Knex.Value)
    case '_neq':
      return q.where(db.raw('??', [field]), '!=', value as Knex.Value)
    case '_gt':
      return q.where(db.raw('??', [field]), '>', value as Knex.Value)
    case '_gte':
      return q.where(db.raw('??', [field]), '>=', value as Knex.Value)
    case '_lt':
      return q.where(db.raw('??', [field]), '<', value as Knex.Value)
    case '_lte':
      return q.where(db.raw('??', [field]), '<=', value as Knex.Value)
    case '_contains':
      return q.where(db.raw('??', [field]), 'like', `%${value}%`)
    case '_ncontains':
      return q.where(db.raw('??', [field]), 'not like', `%${value}%`)
    case '_starts_with':
      return q.where(db.raw('??', [field]), 'like', `${value}%`)
    case '_ends_with':
      return q.where(db.raw('??', [field]), 'like', `%${value}`)
    case '_in':
      return q.whereIn(db.raw('??', [field]) as unknown as string, value as Knex.Value[])
    case '_nin':
      return q.whereNotIn(db.raw('??', [field]) as unknown as string, value as Knex.Value[])
    case '_null':
      return q.whereNull(db.raw('??', [field]) as unknown as string)
    case '_nnull':
      return q.whereNotNull(db.raw('??', [field]) as unknown as string)
    default:
      return q
  }
}

type FilterCondition = { path: string[]; op: string; value: unknown }

type PathHop =
  | { kind: 'm2o'; from: string; fk: string; to: string }
  | { kind: 'alias'; from: string; child: string; childFk: string }
type PathPlan = { hops: PathHop[]; leafTable: string; leafCol: string } | null

// Resolve a condition path into a hop plan. Each segment is either an M2O FK
// (many_collection=current, many_field=seg) or an alias — O2M/M2M — field
// (one_collection=current, one_field=seg). M2M alias hops implicitly continue
// through the junction's junction_field; a BARE alias as the final segment
// compares related ids (junction_field column, or the child's own id for O2M).
/**
 * User-scope restrictions (per-user dimensional row scoping — see
 * services/user-scopes.ts). Applied alongside row_filter RLS on every read.
 * The hop route compiles to nested EXISTS inside the service — junction
 * tables are joined explicitly, no alias fields required.
 */
async function applyUserScopes(q: QB, collection: string, user: User): Promise<void> {
  await applyUserScopesToQuery(q, collection, user)
}

async function planConditionPath(collection: string, path: string[]): Promise<PathPlan> {
  const hops: PathHop[] = []
  let current = collection
  let segs = [...path]
  let guard = 0
  while (segs.length > 0) {
    if (guard++ > 6) return null
    const seg = segs[0]
    const m2o = (await db('nivaro_relations')
      .where({ many_collection: current, many_field: seg })
      .first()) as { one_collection: string | null } | undefined
    const alias = m2o?.one_collection
      ? undefined
      : ((await db('nivaro_relations')
          .where({ one_collection: current, one_field: seg })
          .first()) as
          | { many_collection: string; many_field: string; junction_field: string | null }
          | undefined)
    if (segs.length === 1) {
      if (alias?.many_collection) {
        hops.push({ kind: 'alias', from: current, child: alias.many_collection, childFk: alias.many_field })
        return { hops, leafTable: alias.many_collection, leafCol: alias.junction_field ?? 'id' }
      }
      return { hops, leafTable: current, leafCol: seg }
    }
    if (m2o?.one_collection) {
      hops.push({ kind: 'm2o', from: current, fk: seg, to: m2o.one_collection })
      current = m2o.one_collection
      segs = segs.slice(1)
    } else if (alias?.many_collection) {
      hops.push({ kind: 'alias', from: current, child: alias.many_collection, childFk: alias.many_field })
      current = alias.many_collection
      // M2M: remaining segments live on the junction's target — route the walk
      // through the junction_field M2O next. O2M: the child IS the target.
      segs = alias.junction_field ? [alias.junction_field, ...segs.slice(1)] : segs.slice(1)
    } else {
      return null
    }
  }
  return null
}

function applyPlannedCondition(
  q: QB,
  collection: string,
  plan: NonNullable<PathPlan>,
  op: string,
  value: unknown
) {
  const build = (qb: Knex.QueryBuilder, idx: number, fromTable: string) => {
    if (idx >= plan.hops.length) {
      applyOneFilter(
        qb as QB,
        plan.hops.length === 0 ? plan.leafCol : `${plan.leafTable}.${plan.leafCol}`,
        op,
        value
      )
      return
    }
    const hop = plan.hops[idx]
    const target = hop.kind === 'm2o' ? hop.to : hop.child
    qb.whereExists(function () {
      this.select(db.raw('1')).from(target)
      if (hop.kind === 'm2o') this.whereRaw('??.?? = ??.??', [target, 'id', fromTable, hop.fk])
      else this.whereRaw('??.?? = ??.??', [target, hop.childFk, fromTable, 'id'])
      build(this, idx + 1, target)
    })
  }
  build(q as unknown as Knex.QueryBuilder, 0, collection)
}

type OrCondition = { or: FilterCondition[] }

async function applyConditions(
  q: QB,
  conditions: Array<FilterCondition | OrCondition>,
  collection: string
) {
  for (const cond of conditions) {
    // OR group: each branch is a normal path condition; the group ANDs with
    // the rest of the conditions (EFP project-type _or parity).
    if ('or' in cond && Array.isArray(cond.or)) {
      const branches: Array<{ plan: NonNullable<PathPlan>; op: string; value: unknown }> = []
      for (const sub of cond.or) {
        if (!Array.isArray(sub.path) || sub.path.length === 0) continue
        const plan = await planConditionPath(collection, sub.path)
        if (plan) branches.push({ plan, op: sub.op, value: sub.value })
      }
      if (branches.length === 0) continue
      q.where(function () {
        for (const b of branches) {
          this.orWhere(function () {
            applyPlannedCondition(this as QB, collection, b.plan, b.op, b.value)
          })
        }
      })
      continue
    }
    if (!('path' in cond) || !Array.isArray(cond.path) || cond.path.length === 0) continue
    // Virtual path: workflow/pipeline state by key — resolved against the
    // instance tables so state filters run server-side over the full set.
    if (cond.path[0] === '$state' && cond.path.length === 1) {
      const keys = (Array.isArray(cond.value) ? cond.value : [cond.value]).filter(
        (v) => typeof v === 'string' && v.length > 0
      )
      if (!keys.length) continue
      q.whereExists(function () {
        this.select(db.raw('1'))
          .from('nivaro_workflow_instances as wfi')
          .leftJoin('nivaro_workflow_states as wfs', 'wfi.current_state', 'wfs.id')
          .where('wfi.collection', collection)
          .whereRaw('wfi.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
          .whereIn('wfs.key', keys as string[])
      })
      continue
    }
    // Content-presence virtual paths (#397/#398): $has_comments / $has_tasks /
    // $has_failed_push / $missing_required. Value truthiness picks the side —
    // {_eq: true} = has, {_eq: false} = does not have.
    if (cond.path.length === 1 && cond.path[0].startsWith('$has_')) {
      const wantHas = cond.value !== false && cond.value !== 'false' && cond.value !== 0
      const kind = cond.path[0]
      const exists = (cb: (this: QB) => void) => (wantHas ? q.whereExists(cb) : q.whereNotExists(cb))
      if (kind === '$has_comments') {
        exists(function () {
          this.select(db.raw('1'))
            .from('nivaro_comments as cmt')
            .where('cmt.collection', collection)
            .whereRaw('cmt.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
        })
        continue
      }
      if (kind === '$has_tasks') {
        exists(function () {
          this.select(db.raw('1'))
            .from('nivaro_tasks as tsk')
            .where('tsk.collection', collection)
            .whereRaw('tsk.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
        })
        continue
      }
      if (kind === '$has_failed_push') {
        exists(function () {
          this.select(db.raw('1'))
            .from('nivaro_erp_submissions as erp')
            .where('erp.collection', collection)
            .where('erp.status', 'failed')
            .whereRaw('erp.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
        })
        continue
      }
      if (kind === '$has_files') {
        // Attachments live behind a per-collection junction to nivaro_files —
        // resolve the first registered file M2M (e.g. workflows_files).
        const rels2 = await getRelsForCollection(collection)
        const fileAlias = rels2.find(
          (r) =>
            r.one_collection === collection &&
            r.junction_field &&
            r.many_collection &&
            /_files$/.test(r.many_collection)
        )
        if (!fileAlias?.many_collection || !fileAlias.junction_field) continue
        const junction = fileAlias.many_collection
        const parentFk = fileAlias.many_field
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(junction) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parentFk))
          continue
        exists(function () {
          this.select(db.raw('1'))
            .from(`${junction} as jf`)
            .whereRaw(`jf.?? = ??.??`, [parentFk, collection, 'id'])
        })
        continue
      }
      continue
    }
    if (cond.path[0] === '$missing_required' && cond.path.length === 1) {
      // Records missing any required physical field (#398). Alias/computed
      // required fields are out of scope here — they have no column to test.
      try {
        const reqFields = (await db('nivaro_fields')
          .where({ collection, required: true })
          .select('field', 'type')) as Array<{ field: string; type: string }>
        const physical = new Set<string>(
          (
            (await db('information_schema.columns')
              .where({ table_name: collection })
              .select('column_name')) as Array<{ column_name: string }>
          ).map((c) => c.column_name.toLowerCase())
        )
        const cols = reqFields.filter(
          (f) => physical.has(f.field.toLowerCase()) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.field)
        )
        if (!cols.length) {
          // No testable required fields — "missing required" matches nothing.
          q.whereRaw('1 = 0')
          continue
        }
        q.where(function () {
          for (const c of cols) {
            this.orWhereNull(`${collection}.${c.field}`)
            // Empty-string only counts as missing on string columns — MSSQL
            // coerces '' to 0 against int columns, which would flag every 0.
            if (c.type === 'string' || c.type === 'text') {
              this.orWhere(`${collection}.${c.field}`, '')
            }
          }
        })
      } catch {
        q.whereRaw('1 = 0')
      }
      continue
    }
    const plan = await planConditionPath(collection, cond.path)
    if (!plan) continue
    applyPlannedCondition(q, collection, plan, cond.op, cond.value)
  }
}

// ─── Public item service API ──────────────────────────────────────────────────

export async function readItems(
  user: User,
  collection: string,
  query: ItemsQuery = {},
  req?: FastifyRequest,
  workspaceId?: string
) {
  assertNotRouteOnly(collection)

  // These five have no interdependency, but each is a separate round trip and
  // the SQL Server sits ~37ms away — run serially they were half the floor cost
  // of every list read. clearRelCache() must precede getRelsForCollection.
  clearRelCache()
  const [col, allowed, allowedFields, rels, rowFilter] = await span('permissions+metadata', () =>
    Promise.all([
      getCollection(collection),
      can(user, 'read', collection),
      getAllowedFields(user, 'read', collection),
      getRelsForCollection(collection),
      getRowFilter(user, 'read', collection)
    ])
  )

  // Errors surface in the original order — a caller must not learn that a
  // collection exists from a Forbidden instead of a NotFound.
  if (!col) throw new CollectionNotFoundError(collection)
  if (!allowed) throw new ForbiddenError()

  const rawConditions = (req?.query as Record<string, string>)?.conditions
  let conditions: Array<FilterCondition | OrCondition> | undefined
  if (rawConditions) {
    try {
      conditions = JSON.parse(rawConditions) as Array<FilterCondition | OrCondition>
    } catch {
      conditions = undefined
    }
  }

  const { fields = ['*'], filter = {}, sort = [], limit = 25, offset = 0, page, search } = query

  // Split dotted fields (e.g. 'category.name') into direct FK columns + expansion map
  const { direct: directFields, nested: nestedFieldMap } = parseFieldExpansion(fields)

  const effectiveOffset = page ? (page - 1) * limit : offset
  let selectFields =
    allowedFields === null
      ? directFields[0] === '*'
        ? ['*']
        : directFields
      : directFields.filter((f) => f === '*' || allowedFields.includes(f))

  // Strip sensitive columns from system tables not backed by nivaro_fields
  const SYSTEM_SENSITIVE: Record<string, string[]> = {
    nivaro_users: ['password_hash', 'totp_secret', 'static_token', 'external_id']
  }
  const sensitiveCols = SYSTEM_SENSITIVE[collection]
  if (sensitiveCols) {
    if (selectFields[0] === '*') {
      const allCols = await db(collection).columnInfo()
      selectFields = Object.keys(allCols).filter((c) => !sensitiveCols.includes(c))
    } else {
      selectFields = selectFields.filter((f) => !sensitiveCols.includes(f))
    }
  }

  // Strip O2M virtual field names — they have no physical column (e.g. 'report_widgets'
  // on report_definitions). Selecting them causes MSSQL "Invalid column name" errors.
  if (selectFields[0] !== '*') {
    const o2mVirtual = new Set(
      rels
        .filter((r) => r.one_collection === collection && r.one_field != null && !r.junction_field)
        .map((r) => r.one_field as string)
    )
    // 'id' is the PK, never an O2M alias — a corrupted relation row with
    // one_field='id' must not strip it from every select on the collection
    o2mVirtual.delete('id')
    if (o2mVirtual.size > 0) {
      selectFields = selectFields.filter((f) => !o2mVirtual.has(f))
    }
  }

  // For each related collection referenced in the filter or sort, pre-load their
  // relations into the cache so the synchronous applyFilters can access them.
  await primeRelCacheForFilter(filter, collection, rels)

  // limit=-1 is Directus convention for "all records". Passing -1 to Knex MSSQL
  // generates SELECT TOP(-1) which is invalid SQL — treat as 1000-row cap instead.
  const effectiveLimit = limit > 0 ? Math.min(limit, 1000) : 1000
  // #474 — list reads route to the read replica when DB_READ_HOST is set
  // (dbRead aliases db otherwise, so this is a no-op on single-DB deploys).
  // Writes and read-back-after-write stay on the primary.
  const q = dbRead(collection)
    .select(selectFields as string[])
    .limit(effectiveLimit)
    .offset(effectiveOffset)

  if (Object.keys(filter).length) applyFilters(q, filter, collection, rels)

  if (sort.length) {
    await applySorts(q, sort, collection, rels)
  } else {
    // MSSQL requires ORDER BY when OFFSET is used
    q.orderByRaw('(SELECT NULL)')
  }

  const countQ = dbRead(collection).count('* as count')
  if (Object.keys(filter).length) applyFilters(countQ, filter, collection, rels)

  // Row-level workspace isolation (no-op when no workspaceId passed or no column)
  await applyWorkspaceScope(q, collection, workspaceId)
  await applyWorkspaceScope(countQ, collection, workspaceId)

  // Row-level security — policy row_filter conditions (no-op when policy has none)
  if (rowFilter) {
    applyRowFilter(q, rowFilter, user)
    applyRowFilter(countQ, rowFilter, user)
  }
  // Per-user dimensional scoping (restrict-mode user scopes)
  await applyUserScopes(q, collection, user)
  await applyUserScopes(countQ, collection, user)

  if (conditions?.length) {
    await applyConditions(q, conditions, collection)
    await applyConditions(countQ, conditions, collection)
  }

  if (search) {
    // Escape MSSQL LIKE special characters to prevent wildcard injection.
    // Bracket is the MSSQL escape character for [ itself.
    const escapedSearch = search.replace(/[%_\[]/g, (c) => `[${c}]`)

    const [fieldMeta, actualCols] = await Promise.all([
      getFields(collection),
      db.raw(
        `SELECT COLUMN_NAME AS "COLUMN_NAME" FROM information_schema.columns WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
        [collection]
      ).then((res) => rawRows<{ COLUMN_NAME: string }>(res).map(r => r.COLUMN_NAME)) as Promise<string[]>
    ])
    const actualColSet = new Set(actualCols)
    let searchCols = fieldMeta
      .filter((f) => ['string', 'text'].includes(f.type) && actualColSet.has(f.field))
      .map((f) => f.field)

    // A collection with NO registered field metadata (nivaro_users is served
    // from virtual meta, so it has none) produced an empty searchable list and
    // the clause was skipped entirely — every row came back as though it had
    // matched, which reads as "search does nothing". Fall back to the table's
    // own text columns so an unregistered collection is still searchable.
    if (searchCols.length === 0) {
      const textCols = (await db
        .raw(
          `SELECT COLUMN_NAME AS "COLUMN_NAME" FROM information_schema.columns
             WHERE table_name = ?
               AND DATA_TYPE IN ('char','nchar','varchar','nvarchar','text','ntext')`,
          [collection]
        )
        .then((res) => rawRows<{ COLUMN_NAME: string }>(res).map((r) => r.COLUMN_NAME))) as string[]
      // Never search a secret: these are stripped from responses, and matching
      // on them would let a caller confirm a token by probing for it.
      searchCols = textCols.filter(
        (c) => !/password|token|secret|totp|external_id/i.test(c)
      )
    }

    if (searchCols.length) {
      const applySearch = (qb: QB) => {
        qb.where((inner) => {
          for (const f of searchCols) {
            inner.orWhere(db.raw('??', [f]), 'like', `%${escapedSearch}%`)
          }
        })
      }
      applySearch(q)
      applySearch(countQ)
    }
  }

  // Picker exclusions — when ?picker=1, hide excluded records from results
  if ((req?.query as Record<string, string>)?.picker === '1') {
    const excludeSub = db('nivaro_picker_exclusions').where({ collection }).select('item_id')
    q.whereNotIn('id', excludeSub)
    countQ.whereNotIn('id', excludeSub)
  }

  await span('hooks:before-read', () =>
    hooks.trigger('before', { collection, action: 'read', user, database: db, req })
  )

  const [rawData, countRows] = await span('query+count', () => Promise.all([q, countQ]))
  const total = Number((countRows[0] as { count: string | number }).count)

  // Decrypt configured encrypted fields before computed fields run
  let data = await span('decrypt', () =>
    Promise.all(
      (rawData as Record<string, unknown>[]).map((row) => decryptItemFields(collection, row))
    )
  )

  // Tree permissions on list reads — batched (one rules query + one ancestry
  // pass per page). Denied rows are dropped; `total` still reflects the
  // pre-filter count, which only differs when deny rules apply.
  data = await span('tree-permissions', () => filterRowsByTreePermissions(user, collection, data))

  // Inherited field values (tree collections) — before computed fields so
  // formulas see effective values. Adds `_inherited` sidecar per row.
  await span('inherited-fields', () => applyInheritedFields(collection, data))

  // Apply read-time computed fields (scoped to the explicit field selection when present)
  await span(
    'computed-fields',
    () =>
      applyReadComputedFields(
        collection,
        data,
        selectFields[0] === '*' ? undefined : (selectFields as string[])
      ),
    `${data.length} rows`
  )

  // Expand M2O relations for dotted fields (e.g. 'category.name', 'category.*')
  if (Object.keys(nestedFieldMap).length > 0 && data.length > 0) {
    await span('expand-relations', () =>
      expandRelations(user, data, collection, nestedFieldMap, 0, workspaceId)
    )
  }

  const result = { data, total, limit, offset: effectiveOffset }

  await span('hooks:after-read', () =>
    hooks.trigger('after', { collection, action: 'read', user, result, database: db, req })
  )

  return result
}

/**
 * Recursively walk a filter object and pre-load relations for all referenced
 * related collections into the relCache, so applyFilters (which is sync) can
 * look them up without awaiting.
 */
async function primeRelCacheForFilter(
  filter: Record<string, unknown>,
  collection: string,
  rels: CMSRelation[]
): Promise<void> {
  for (const [key, value] of Object.entries(filter)) {
    if ((key === '_and' || key === '_or') && Array.isArray(value)) {
      for (const clause of value as Record<string, unknown>[]) {
        await primeRelCacheForFilter(clause, collection, rels)
      }
      continue
    }

    if (typeof value !== 'object' || value === null) continue

    // M2O
    const m2oMatch = findM2ORelation(key, collection, rels)
    if (m2oMatch) {
      const relCol = m2oMatch.rel.one_collection as string
      if (!relCache.has(relCol)) {
        const relRels = await getRelations(relCol)
        relCache.set(relCol, relRels)
        await primeRelCacheForFilter(value as Record<string, unknown>, relCol, relRels)
      } else {
        const relRels = relCache.get(relCol) as CMSRelation[]
        await primeRelCacheForFilter(value as Record<string, unknown>, relCol, relRels)
      }
      continue
    }

    // O2M
    const o2mMatch = findO2MRelation(key, collection, rels)
    if (o2mMatch) {
      const manyCol = o2mMatch.many_collection
      if (!relCache.has(manyCol)) {
        const manyRels = await getRelations(manyCol)
        relCache.set(manyCol, manyRels)
      }
      const manyRels = relCache.get(manyCol) as CMSRelation[]
      // Recurse into _some/_none wrapper, or implicit-some (value IS the inner filter)
      const inner =
        (value as Record<string, unknown>)['_some'] ??
        (value as Record<string, unknown>)['_none'] ??
        value
      if (inner && typeof inner === 'object') {
        await primeRelCacheForFilter(inner as Record<string, unknown>, manyCol, manyRels)
      }
      continue
    }

    // M2M
    const m2mMatch = findM2MRelation(key, collection, rels)
    if (m2mMatch) {
      const otherCol = m2mMatch.otherCollection
      if (!relCache.has(otherCol)) {
        const otherRels = await getRelations(otherCol)
        relCache.set(otherCol, otherRels)
        const inner =
          (value as Record<string, unknown>)['_some'] ?? (value as Record<string, unknown>)['_none']
        if (inner && typeof inner === 'object') {
          await primeRelCacheForFilter(inner as Record<string, unknown>, otherCol, otherRels)
        }
      }
    }
  }
}


/** Column names are interpolated into a query, so they must be identifiers. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Turn a URL segment into a primary key when a collection is configured to be
 * addressed by something people recognise ("CM26-79826" instead of 371373).
 *
 * Returns the id, or null when the collection has no alias configured / the
 * segment does not resolve — callers keep their existing not-found behaviour.
 *
 * Two things this must not do:
 *  - Hand a non-numeric segment to an int primary key. MSSQL raises
 *    "Conversion failed" and the request 500s instead of 404ing, so the id
 *    lookup is skipped entirely when the segment cannot be one.
 *  - Silently pick among several matches. Alias columns carry no uniqueness
 *    guarantee (workflows.workflow_id has real duplicates), so the LOWEST id
 *    wins deterministically — the same URL always resolves to the same record,
 *    rather than shifting as rows are added.
 */
export async function resolveAliasId(
  collection: string,
  segment: string
): Promise<string | number | null> {
  const col = await getCollection(collection)
  const raw = (col as { url_alias_fields?: unknown } | null)?.url_alias_fields
  const fields = parseJson(typeof raw === 'string' ? raw : null)
  if (!Array.isArray(fields) || fields.length === 0) return null
  const names = fields.filter((f): f is string => typeof f === 'string' && IDENT_RE.test(f))
  if (names.length === 0) return null

  // A multi-field alias joins its parts with '-', so split from the LEFT by
  // field count and let the final field absorb any remaining separators —
  // values themselves routinely contain '-' ("CM26-79826").
  const parts =
    names.length === 1
      ? [segment]
      : (() => {
          const bits = segment.split('-')
          if (bits.length < names.length) return null
          const head = bits.slice(0, names.length - 1)
          return [...head, bits.slice(names.length - 1).join('-')]
        })()
  if (!parts) return null

  try {
    // Case-insensitive on both sides, with an explicit CAST so an int alias
    // column compares as text instead of raising a conversion error for
    // non-numeric segments. Lowest id still wins (determinism note above).
    const q = db(collection).select('id').orderBy('id', 'asc').limit(1)
    names.forEach(
      (f, i) => void q.whereRaw('LOWER(CAST(?? AS NVARCHAR(400))) = ?', [f, parts[i].toLowerCase()])
    )
    const row = (await q.first()) as { id?: string | number } | undefined
    return row?.id ?? null
  } catch {
    // A stale alias column (renamed/dropped) must not break record loading.
    return null
  }
}

export async function readOne(
  user: User,
  collection: string,
  id: string | number,
  workspaceId?: string,
  fields?: string[]
) {
  assertNotRouteOnly(collection)
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)

  // Run independent permission checks in parallel.
  const [allowed, treeAllow, allowedFields, rowFilter] = await Promise.all([
    can(user, 'read', collection),
    getTreePermission(user, 'read', collection, id),
    getAllowedFields(user, 'read', collection),
    getRowFilter(user, 'read', collection)
  ])

  if (!allowed) throw new ForbiddenError()
  // Tree permissions only further RESTRICT (never grant beyond policies) —
  // act only on an explicit deny. Enforced on single reads only; list reads
  // skip this check to avoid one ancestor walk per row (known limitation).
  if (treeAllow === false) throw new ForbiddenError()

  // Opt-in read-access logging: single-record reads only (list reads would
  // drown the log), throttled to one row per user/record/hour, and strictly
  // fire-and-forget — visibility must never slow the read it observes.
  if ((col as { read_logging?: boolean | number }).read_logging) {
    const throttleKey = `read:${collection}:${id}:${user?.id}`
    const now = Date.now()
    const seenUntil = readLogThrottle.get(throttleKey)
    if (!seenUntil || seenUntil < now) {
      readLogThrottle.set(throttleKey, now + 3_600_000)
      // Bounded: prune when the map grows past a sane ceiling.
      if (readLogThrottle.size > 20_000) {
        for (const [k, until] of readLogThrottle) {
          if (until < now) readLogThrottle.delete(k)
        }
      }
      void (async () => {
        try {
          const { logActivity } = await import('./activity.js')
          await logActivity({ action: 'read', user: user?.id, collection, item: String(id) })
        } catch {
          // never block or fail the read
        }
      })()
    }
  }

  const baseFields = allowedFields ?? ['*']
  const { direct: directFields, nested: nestedFieldMap } = parseFieldExpansion(fields ?? baseFields)

  const selectCols =
    allowedFields === null
      ? directFields[0] === '*'
        ? ['*']
        : directFields
      : directFields.filter((f) => f === '*' || allowedFields.includes(f))

  // An alias segment ("CM26-79826") is not a key. Resolve it first, and never
  // pass it to the id column: an int primary key raises a conversion error
  // rather than simply not matching.
  let key: string | number = id
  const numericLooking = /^\d+$/.test(String(id))
  const uuidLooking = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(id))
  if (!numericLooking && !uuidLooking) {
    const aliasId = await resolveAliasId(collection, String(id))
    // Nothing resolved: this is a not-found, not a query. Passing the segment
    // to an int primary key raises "Conversion failed" and 500s, which is how
    // a mistyped URL used to look like a broken server.
    if (aliasId === null) return null
    key = aliasId
  }

  const q = db(collection)
    .where({ id: key })
    .select(selectCols as string[])
  await applyWorkspaceScope(q, collection, workspaceId)

  if (rowFilter) applyRowFilter(q, rowFilter, user)
  await applyUserScopes(q, collection, user)

  let item = (await q.first()) as Record<string, unknown> | undefined

  if (item) {
    item = await decryptItemFields(collection, item)
    await applyInheritedFields(collection, [item])
    await applyReadComputedFields(collection, [item])
    if (Object.keys(nestedFieldMap).length > 0) {
      await expandRelations(user, [item], collection, nestedFieldMap, 0, workspaceId)
    }
  }

  return item ?? null
}

/**
 * Accepts the Directus-era nested shape for a foreign key — `{file: {id, ...}}`
 * — and reduces it to the id the column actually holds.
 *
 * Without this the object falls through to filterToActualColumns, which
 * JSON-stringifies it into a uuid/int column: a corrupt value or a type error,
 * for a payload that is perfectly clear about what it means. Scoped strictly to
 * fields that ARE many-to-one relations, so a genuine JSON column holding an
 * object with an `id` key is untouched.
 */
async function coerceRelationObjects(
  collection: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const candidates = Object.entries(data).filter(
    ([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
  )
  if (candidates.length === 0) return data
  let rels: Awaited<ReturnType<typeof getRelations>>
  try {
    rels = await getRelations(collection)
  } catch {
    return data
  }
  const out = { ...data }
  for (const [field, value] of candidates) {
    const isM2O = rels.some(
      (r) => r.many_collection === collection && r.many_field === field && !!r.one_collection
    )
    if (!isM2O) continue
    const id = (value as Record<string, unknown>).id
    if (id !== undefined && (typeof id === 'string' || typeof id === 'number')) out[field] = id
  }
  return out
}

interface AliasM2MWrite {
  field: string
  junction: string
  parentFk: string
  relatedFk: string
  ids: Array<string | number>
}

/**
 * Directus-era integrations write M2M relations as alias keys on the record
 * payload — `regions: {id: 9}`, `funding_years: [{funding_years_year: {id: 2026}}]`,
 * `files: [{directus_files_id: {id: "…"}}]`, or `{create: [...]}`. Nivaro's own
 * clients write junction rows directly, so these keys used to be silently
 * stripped and the links were lost.
 *
 * This normalizes each M2M alias value in the payload to a plain array of
 * related ids (so auto-id templates and field rules can read it as a draft
 * value), and returns the junction writes to apply AFTER the record write.
 * Semantics are ADDITIVE — links present are kept, new ones created, nothing
 * is ever detached (legacy callers delete junction rows explicitly). M2A
 * aliases are skipped: their junction needs a discriminator column this
 * shape cannot express.
 */
async function extractAliasM2MWrites(
  collection: string,
  payload: Record<string, unknown>
): Promise<AliasM2MWrite[]> {
  let rels: CMSRelation[]
  try {
    rels = await getRelsForCollection(collection)
  } catch {
    return []
  }
  const writes: AliasM2MWrite[] = []
  for (const r of rels) {
    if (r.one_collection !== collection || !r.one_field || r.junction_field == null) continue
    if ((r as { one_allowed_collections?: unknown }).one_allowed_collections) continue // M2A
    const key = r.one_field
    if (!(key in payload)) continue
    const raw = payload[key]
    if (raw == null) continue
    const jf = String(r.junction_field)

    let entries: unknown[]
    if (Array.isArray(raw)) entries = raw
    else if (typeof raw === 'object' && Array.isArray((raw as { create?: unknown }).create)) {
      entries = (raw as { create: unknown[] }).create
    } else entries = [raw]

    const ids = entries
      .map((e) => {
        if (e == null) return null
        if (typeof e !== 'object') return e as string | number
        const rec = e as Record<string, unknown>
        const inner = jf in rec ? rec[jf] : rec
        if (inner == null) return null
        if (typeof inner !== 'object') return inner as string | number
        const id = (inner as Record<string, unknown>).id
        return typeof id === 'string' || typeof id === 'number' ? id : null
      })
      .filter((v): v is string | number => v != null && v !== '')

    // Normalized draft value — auto-id `{regions[0].short_code}` tokens and
    // rule contexts read this; filterToActualColumns strips it before write.
    payload[key] = ids
    if (ids.length > 0) {
      writes.push({
        field: key,
        junction: r.many_collection,
        parentFk: r.many_field,
        relatedFk: jf,
        ids
      })
    }
  }
  return writes
}

/**
 * Create the junction rows an alias write asked for, through createOne so
 * every downstream contract holds — junction auto-id recompute (the record's
 * rendered name), stored rollups, activity, queue materialization. Additive:
 * pairs that already exist are skipped. Never throws — a failed link must not
 * fail the record write that carried it.
 */
async function applyAliasM2MWrites(
  user: User,
  recordId: string | number,
  writes: AliasM2MWrite[],
  req?: FastifyRequest
): Promise<void> {
  for (const w of writes) {
    try {
      const existing = (await db(w.junction)
        .where({ [w.parentFk]: recordId })
        .select(w.relatedFk)) as Array<Record<string, unknown>>
      const have = new Set(existing.map((row) => String(row[w.relatedFk])))
      for (const rid of w.ids) {
        if (have.has(String(rid))) continue
        await createOne(user, w.junction, { [w.parentFk]: recordId, [w.relatedFk]: rid }, req)
      }
    } catch (err) {
      console.warn(`alias m2m write failed for ${w.junction}.${w.field}:`, err)
    }
  }
}

export async function createOne(
  user: User,
  collection: string,
  data: Record<string, unknown>,
  req?: FastifyRequest,
  workspaceId?: string,
  opts?: { skipRollupRecalc?: boolean }
) {
  assertNotRouteOnly(collection)
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)
  // Contract check on the RAW caller payload, before rules/computed passes
  // reshape it — the contract judges what the integration actually sent.
  await enforceContracts(collection, user?.id, data, 'create')
  data = await coerceRelationObjects(collection, data)
  const aliasWrites = await extractAliasM2MWrites(collection, data)
  // The fields the CALLER explicitly sent, captured before any rule, autofill
  // or computed pass mutates the payload — explicit values always win over
  // layout autofill, and validation only ever judges what the caller wrote.
  const callerFields = new Set(Object.keys(data))

  const allowed = await can(user, 'create', collection)
  if (!allowed) throw new ForbiddenError()

  // Workspace item quota — checked against the active workspace (default when unscoped)
  const quotaWorkspace = workspaceId ?? (await fetchDefaultWorkspaceId())
  const quota = await checkQuota(quotaWorkspace, 'items')
  if (!quota.allowed) {
    throw new QuotaExceededError('items', quota.current, quota.limit as number)
  }

  const ctx = { collection, action: 'create' as const, payload: data, user, database: db, req }
  await hooks.trigger('before', ctx)

  // before_create rules — may mutate the payload (e.g. set_field)
  await evaluateRules(collection, 'before_create', ctx.payload)

  // Field rules — apply inline field defaults based on other field values
  await applyFieldRules(collection, ctx.payload)

  // Layout row-rule autofill — the grid rules the admin form runs per row
  // (oracle category from CIFA, task precedence chain, line_type from the
  // parent's workflow_type) now apply to API creates too. Fills only fields
  // the caller left out; never throws.
  await applyRowRulesOnCreate(collection, ctx.payload, callerFields)

  // Datetime auto-fields — on_create: 'now' sets the field to current timestamp
  await applyDatetimeAutoFields(collection, ctx.payload, 'on_create')

  // Auto-ID generation — fill any auto_id fields not explicitly provided
  await applyAutoIdsExt(db, collection, ctx.payload)

  // Write-time computed fields — evaluated after auto-IDs so formula can reference them
  // For create, the payload itself is the full context
  await applyWriteComputedFields(collection, ctx.payload, ctx.payload)

  // Field validation rules — 400 {code: VALIDATION_RULE_FAILED} on the first
  // caller-provided value that violates its field's rules. Runs after every
  // transform so it judges what will actually be written.
  await enforceValidationRules(collection, ctx.payload, callerFields)

  // Stamp the active workspace on the row when the table is workspace-aware.
  // Admins may override via an explicit workspace_id in the payload.
  if (workspaceId && (await workspaceColumnExists(collection))) {
    const isAdmin = req?.isAdmin ?? false
    if (ctx.payload[WORKSPACE_COLUMN] == null || !isAdmin) {
      ctx.payload[WORKSPACE_COLUMN] = workspaceId
    }
  }

  // Encrypt configured encrypted fields just before write
  const securedPayload = await encryptItemFields(collection, ctx.payload)

  const actualCols = await getActualColumns(collection)
  const rows = (await db(collection)
    .insert(filterToActualColumns(securedPayload, actualCols))
    .returning('id')) as unknown[]
  const id = rows[0] as { id: string | number } | string | number
  const returnedId = typeof id === 'object' && id !== null ? (id as { id: string | number }).id : id

  // Count the new item against the workspace quota (non-fatal)
  await incrementUsage(quotaWorkspace, 'items').catch(() => {})

  // Alias M2M links BEFORE the read-back — the junction creates recompute any
  // auto-id fields drawing on them, so the response already carries the
  // rendered name/prefix the caller asked for.
  await applyAliasM2MWrites(user, returnedId as string | number, aliasWrites, req)

  const result = await readOne(user, collection, returnedId as string | number)

  // Recalc any stored rollups this new row contributes to (never throws). Callers
  // that create many rows in one batch (e.g. import execute) can opt out and run
  // one deduped recalc pass of their own after the whole batch commits.
  if (!opts?.skipRollupRecalc) {
    await recalcAffectedRollups(collection, (result ?? ctx.payload) as Record<string, unknown>)
  }

  // If this collection is an M2M junction table, recompute any parent auto_id
  // fields whose pattern draws from it (never throws).
  await recomputeJunctionAutoIds(collection, (result ?? ctx.payload) as Record<string, unknown>)

  // after_create rules
  await evaluateRules(
    collection,
    'after_create',
    (result ?? ctx.payload) as Record<string, unknown>
  )

  await hooks.trigger('after', { ...ctx, keys: [returnedId as string | number], result })

  // Auto-watch (#400): creators subscribe to their own records when the
  // preference says so — fire-and-forget.
  void import('./auto-watch.js')
    .then(({ ensureAutoWatch }) =>
      ensureAutoWatch(user?.id, collection, returnedId as string | number, 'created')
    )
    .catch(() => {})

  broadcastCollectionUpdate(req?.server?.io, collection, returnedId as string | number, {
    action: 'create'
  })

  return result
}

export async function updateOne(
  user: User,
  collection: string,
  id: string | number,
  data: Record<string, unknown>,
  req?: FastifyRequest,
  workspaceId?: string
) {
  assertNotRouteOnly(collection)
  await enforceContracts(collection, user?.id, data, 'update')
  data = await coerceRelationObjects(collection, data)
  const aliasWrites = await extractAliasM2MWrites(collection, data)
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)

  const allowed = await can(user, 'update', collection)
  if (!allowed) throw new ForbiddenError()

  // The fields the caller explicitly sent — validation only judges these.
  const callerFields = new Set(Object.keys(data))
  callerFields.delete('_change_reason')
  callerFields.delete('_base_revision')

  // Change reason rides the payload as a virtual `_change_reason` key — strip
  // it before anything downstream sees it (it must never reach a column write)
  const changeReason =
    typeof (data as Record<string, unknown>)._change_reason === 'string'
      ? String((data as Record<string, unknown>)._change_reason).trim()
      : ''
  delete (data as Record<string, unknown>)._change_reason

  // Mid-air collision detection: the client says which revision its draft was
  // BASED on (_base_revision, a capability opt-in — callers that never send it
  // are unaffected). If someone else's save produced newer revisions touching
  // any of the SAME fields this payload writes, 409 with the conflicts named —
  // silent last-write-wins is data loss nobody notices. Per-collection
  // toggleable; edits to disjoint fields merge without complaint.
  const baseRevisionRaw = (data as Record<string, unknown>)._base_revision
  delete (data as Record<string, unknown>)._base_revision
  const baseRevision = Number(baseRevisionRaw)
  if (
    Number.isFinite(baseRevision) &&
    baseRevision > 0 &&
    (col as { collision_detection?: boolean | number }).collision_detection !== false &&
    (col as { collision_detection?: boolean | number }).collision_detection !== 0
  ) {
    const newer = (await db('nivaro_revisions')
      .where({ collection, item: String(id) })
      .where('id', '>', baseRevision)
      .orderBy('id', 'asc')
      .limit(50)
      .select('id', 'delta', 'data')) as Array<{ id: number; delta: string | null; data: string | null }>
    if (newer.length > 0) {
      const theirFields = new Set<string>()
      for (const r of newer) {
        try {
          const delta = r.delta ? (JSON.parse(r.delta) as Record<string, unknown>) : null
          for (const k of Object.keys(delta ?? {})) theirFields.add(k)
        } catch {
          // unparseable delta — treat conservatively as touching nothing
        }
      }
      const overlap = [...callerFields].filter((f) => theirFields.has(f))
      if (overlap.length > 0) {
        const currentRow = (await db(collection)
          .where({ id })
          .first()) as Record<string, unknown> | undefined
        const err = new Error(
          `Someone else changed ${overlap.join(', ')} since you loaded this record`
        ) as Error & {
          statusCode: number
          code: string
          conflicts: Array<{ field: string; current_value: unknown }>
          latest_revision: number
        }
        err.statusCode = 409
        err.code = 'MIDAIR_COLLISION'
        err.conflicts = overlap.map((f) => ({ field: f, current_value: currentRow?.[f] ?? null }))
        err.latest_revision = newer[newer.length - 1].id
        throw err
      }
    }
  }

  // Tree permissions — restriction only: an explicit deny on the item or its
  // nearest matching ancestor blocks the update; null/true changes nothing.
  const treeAllow = await getTreePermission(user, 'update', collection, id)
  if (treeAllow === false) throw new ForbiddenError()

  const ctx = {
    collection,
    action: 'update' as const,
    keys: [id],
    payload: data,
    user,
    database: db,
    req
  }
  await span('hooks:before-update', () => hooks.trigger('before', ctx))

  // Row-level security — filter applies to both the previousData fetch and the mutation
  const rowFilter = await getRowFilter(user, 'update', collection)

  const prevQ = db(collection).where({ id }).select('*')
  await applyWorkspaceScope(prevQ, collection, workspaceId)
  if (rowFilter) applyRowFilter(prevQ, rowFilter, user)
  const previousData = (await prevQ.first()) as Record<string, unknown> | undefined

  // Cross-workspace, row-filtered-out, or missing row → 404 when scoping is active
  if (!previousData) {
    if (rowFilter) throw new ItemNotFoundError()
    if (workspaceId && (await workspaceColumnExists(collection))) {
      throw new ItemNotFoundError()
    }
  }

  // Change-reason enforcement — judged on the CALLER's payload before rules or
  // computed fields mutate it, so machine-derived writes to flagged fields
  // never demand a justification, only fields the caller explicitly changed.
  const crConfig = parseChangeReasonConfig(
    (col as unknown as { change_reason_config?: string | null }).change_reason_config
  )
  if (crConfig && !changeReason && previousData) {
    const flaggedChanged = crConfig.fields.filter(
      (f) =>
        f in (data as Record<string, unknown>) &&
        String((data as Record<string, unknown>)[f] ?? '') !== String(previousData[f] ?? '')
    )
    if (flaggedChanged.length > 0) throw new ChangeReasonRequiredError(flaggedChanged, crConfig)
  }

  // before_update rules — may mutate the payload (e.g. set_field)
  await span('rules:before-update', () =>
    evaluateRules(collection, 'before_update', ctx.payload, previousData)
  )

  // Field rules — apply inline field defaults based on other field values
  await span('field-rules', () => applyFieldRules(collection, ctx.payload))

  // Datetime auto-fields — on_update: 'now' sets the field to current timestamp
  await applyDatetimeAutoFields(collection, ctx.payload, 'on_update')

  // Write-time computed fields — merge previous data as context so formula can read existing fields
  const writeCtx = { ...(previousData ?? {}), ...ctx.payload }
  await span('computed-fields:write', () =>
    applyWriteComputedFields(collection, ctx.payload, writeCtx)
  )

  // Field validation rules on the caller's fields (see createOne)
  await enforceValidationRules(collection, ctx.payload, callerFields)

  // Auto-ID prefix recompute — if a relation an auto_id pattern depends on
  // just changed (e.g. re-parenting to a different project), re-render the
  // prefix while preserving the existing sequence suffix. Skips fields the
  // caller explicitly set and fields whose relation inputs didn't change.
  for (const { field, config } of await autoIdFieldsFor(db, collection)) {
    if (field in ctx.payload) continue // explicit value provided — don't override

    let parsed: ReturnType<typeof parseAutoIdPattern> | null
    try {
      parsed = parseAutoIdPattern(config.pattern)
    } catch {
      continue
    }

    const firstSegs = parsed.tokens.filter((t) => t.kind === 'relation').map((t) => t.path[0])
    if (!firstSegs.some((seg) => seg in ctx.payload)) continue

    const newVal = await recomputeAutoIdPrefix(db, collection, field, config, id, writeCtx)
    if (newVal != null && newVal !== previousData?.[field]) {
      ctx.payload[field] = newVal
    }
  }

  // Encrypt configured encrypted fields just before write
  const securedPayload = await encryptItemFields(collection, ctx.payload)

  const actualCols = await getActualColumns(collection)
  const columnPayload = filterToActualColumns(securedPayload, actualCols)
  // A payload of only alias/virtual fields (e.g. an M2A alias like
  // internal_contact) leaves nothing to write — knex throws on an empty
  // .update(). Skip the UPDATE but still run the read-back + after hooks so
  // the call stays a graceful no-op instead of a 500.
  if (Object.keys(columnPayload).length > 0) {
    await span('update', async () => {
      const updQ = db(collection).where({ id })
      await applyWorkspaceScope(updQ, collection, workspaceId)
      if (rowFilter) applyRowFilter(updQ, rowFilter, user)
      await updQ.update(columnPayload)
    })
  }
  // Alias M2M links (additive) before the read-back — see extractAliasM2MWrites
  await applyAliasM2MWrites(user, id, aliasWrites, req)

  const result = await span('read-back', () => readOne(user, collection, id, workspaceId))

  // Recalc any stored rollups this row contributes to — both the previous and
  // new parent when an FK field changed (never throws)
  await span('rollup-recalc', () =>
    recalcAffectedRollups(collection, result as Record<string, unknown> | null, previousData)
  )

  // after_update rules
  await span('rules:after-update', () =>
    evaluateRules(
      collection,
      'after_update',
      (result ?? ctx.payload) as Record<string, unknown>,
      previousData
    )
  )

  await span('hooks:after-update', () =>
    hooks.trigger('after', {
      ...ctx,
      result,
      previousData,
      changeReason: changeReason || undefined
    })
  )

  broadcastCollectionUpdate(req?.server?.io, collection, id, {
    action: 'update',
    changed_fields: Object.keys(columnPayload ?? {})
  })

  return result
}

export async function deleteOne(
  user: User,
  collection: string,
  id: string | number,
  req?: FastifyRequest,
  workspaceId?: string
) {
  assertNotRouteOnly(collection)
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)

  const allowed = await can(user, 'delete', collection)
  if (!allowed) throw new ForbiddenError()

  // Tree permissions — restriction only: an explicit deny on the item or its
  // nearest matching ancestor blocks the delete; null/true changes nothing.
  const treeAllow = await getTreePermission(user, 'delete', collection, id)
  if (treeAllow === false) throw new ForbiddenError()

  // Row-level security — filter applies to both the previousData fetch and the mutation
  const rowFilter = await getRowFilter(user, 'delete', collection)

  const prevQ = db(collection).where({ id }).select('*')
  await applyWorkspaceScope(prevQ, collection, workspaceId)
  if (rowFilter) applyRowFilter(prevQ, rowFilter, user)
  const previousData = (await prevQ.first()) as Record<string, unknown> | undefined

  // Cross-workspace, row-filtered-out, or missing row → 404 when scoping is active
  if (!previousData) {
    if (rowFilter) throw new ItemNotFoundError()
    if (workspaceId && (await workspaceColumnExists(collection))) {
      throw new ItemNotFoundError()
    }
  }

  // Deletion protection rules (#64): per-collection guards from
  // nivaro_collections.delete_guard. A matching rule BLOCKS with its own
  // message ("never delete a workflow with linked POs"). Enforcement, not
  // advice — admins are NOT exempt (the rule exists because the delete is
  // wrong, not because the caller lacks rank). Broken guard config fails
  // OPEN with a warning: a typo must not make every record undeletable.
  try {
    const guardRaw = (col as { delete_guard?: string | null }).delete_guard
    const guards = guardRaw
      ? (JSON.parse(String(guardRaw)) as Array<Record<string, unknown>>)
      : []
    for (const g of Array.isArray(guards) ? guards : []) {
      if (g.type === 'children') {
        const child = String(g.collection ?? '')
        const fk = String(g.fk_field ?? '')
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(child) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fk)) continue
        const row = await db(child).where(fk, id).first('id').catch(() => undefined)
        if (row) {
          throw new DeleteGuardError(
            String(g.message ?? `This record has linked ${child.replace(/_/g, ' ')} and cannot be deleted`)
          )
        }
      } else if (g.type === 'condition' && previousData) {
        const v = previousData[String(g.field ?? '')]
        const want = g.value
        const hit = (() => {
          switch (String(g.op ?? 'eq')) {
            case 'eq':
              return String(v ?? '') === String(want ?? '')
            case 'neq':
              return String(v ?? '') !== String(want ?? '')
            case 'null':
              return v === null || v === undefined || v === ''
            case 'nnull':
              return !(v === null || v === undefined || v === '')
            case 'in':
              return String(want ?? '')
                .split(',')
                .map((x) => x.trim())
                .includes(String(v ?? ''))
            default:
              return false
          }
        })()
        if (hit) {
          throw new DeleteGuardError(
            String(g.message ?? 'A deletion protection rule blocks deleting this record')
          )
        }
      }
    }
  } catch (err) {
    if (err instanceof DeleteGuardError) throw err
    console.warn(`[delete-guard] broken guard config on ${collection} — failing open:`, err)
  }

  const ctx = { collection, action: 'delete' as const, keys: [id], user, database: db, req }
  await hooks.trigger('before', ctx)

  const delQ = db(collection).where({ id })
  await applyWorkspaceScope(delQ, collection, workspaceId)
  if (rowFilter) applyRowFilter(delQ, rowFilter, user)
  await delQ.delete()

  // Trash safety net — full-row snapshot, restorable for 30 days
  if (previousData) void writeTrashRow(collection, previousData, user.id)

  // Recalc any stored rollups the deleted row contributed to (never throws)
  await recalcAffectedRollups(collection, null, previousData)

  // If this collection is an M2M junction table, recompute any parent auto_id
  // fields whose pattern draws from it (never throws).
  await recomputeJunctionAutoIds(collection, previousData)

  await hooks.trigger('after', { ...ctx, previousData })

  broadcastCollectionUpdate(req?.server?.io, collection, id, { action: 'delete' })
}
