import { Parser } from 'expr-eval'
import type { FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { rawRows } from '../db/raw-rows.js'
import { db } from '../db/index.js'
import { hooks } from '../hooks/registry.js'
import { getAncestors, getTreeConfig, type TreeConfig } from '../lib/tree.js'
import { fetchDefaultWorkspaceId } from '../middleware/workspace.js'
import type { CMSRelation, ItemsQuery, User } from '../types.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { decryptItemFields, encryptItemFields } from './encryption.js'
import { applyRowFilter, can, getAllowedFields, getRowFilter } from './permissions.js'
import { checkQuota, incrementUsage, QuotaExceededError } from './quotas.js'
import { isPathMaintained } from './tree-path.js'
import { filterRowsByTreePermissions, getTreePermission } from './tree-permissions.js'

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

export class CollectionNotFoundError extends Error {
  constructor(collection: string) {
    super(`Collection "${collection}" not found in registry`)
    this.name = 'CollectionNotFoundError'
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('Forbidden')
    this.name = 'ForbiddenError'
  }
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

async function getActualColumns(table: string): Promise<Set<string>> {
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
  return Object.fromEntries(Object.entries(payload).filter(([k]) => cols.has(k)))
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
async function applyWorkspaceScope(
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

// ─── Auto-ID generation ────────────────────────────────────────────────────────

interface AutoIdConfig {
  pattern: string
  padding?: number
}

async function generateAutoId(
  collection: string,
  field: string,
  pattern: string,
  padding: number
): Promise<string> {
  const seqKey = `${collection}.${field}`

  // MSSQL atomic increment: UPDATE OUTPUT
  const rows = (await db.raw(
    `UPDATE nivaro_sequences SET next_val = next_val + 1 OUTPUT INSERTED.next_val WHERE id = ?`,
    [seqKey]
  )) as { recordset?: Array<{ next_val: number }> } | Array<{ next_val: number }>

  const recordset = Array.isArray(rows) ? rows : rows.recordset

  let seqVal: number
  if (!recordset?.[0]) {
    // First use — insert then use 1
    await db('nivaro_sequences')
      .insert({ id: seqKey, next_val: 2 })
      .catch(() => {})
    seqVal = 1
  } else {
    seqVal = recordset[0].next_val
  }

  const now = new Date()
  const YY = String(now.getFullYear()).slice(-2)
  const YYYY = String(now.getFullYear())
  const MM = String(now.getMonth() + 1).padStart(2, '0')
  const seq = padding > 0 ? String(seqVal).padStart(padding, '0') : String(seqVal)

  return pattern
    .replace('{YY}', YY)
    .replace('{YYYY}', YYYY)
    .replace('{MM}', MM)
    .replace('{seq}', seq)
    .replace('{seq4}', String(seqVal).padStart(4, '0'))
    .replace('{seq6}', String(seqVal).padStart(6, '0'))
}

/**
 * Apply auto-ID generation for any field on the collection whose options contain
 * an `auto_id` config. Mutates `payload` in place (only sets fields not already provided).
 */
async function applyAutoIds(collection: string, payload: Record<string, unknown>): Promise<void> {
  const fieldRows = (await db('nivaro_fields')
    .where({ collection })
    .andWhereRaw(`options LIKE '%"auto_id"%'`)
    .select('field', 'options')) as Array<{ field: string; options: string | null }>

  for (const f of fieldRows) {
    // Don't overwrite a value the caller explicitly provided.
    if (payload[f.field] != null && payload[f.field] !== '') continue

    const opts = parseJson<{ auto_id?: AutoIdConfig }>(f.options)
    const autoId = opts?.auto_id
    if (!autoId?.pattern) continue

    payload[f.field] = await generateAutoId(
      collection,
      f.field,
      autoId.pattern,
      autoId.padding ?? 0
    )
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
    return _exprParser.evaluate(formula, { item } as any)
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
 * Rollup computed field config — stored as JSON in `computed_formula` when
 * `computed_type === 'rollup'`. Aggregates related items in another collection.
 */
interface RollupFormula {
  related_collection: string // table to aggregate from
  fk_field: string // column on related_collection pointing to this item's id
  aggregate: 'sum' | 'count' | 'avg' | 'min' | 'max'
  value_field: string // column to aggregate (ignored for count)
  recursive?: boolean // if true: aggregate all descendants in same-collection tree
}

const ROLLUP_AGGREGATES = new Set(['sum', 'count', 'avg', 'min', 'max'])

/**
 * Compute a single rollup value for one item id.
 * Non-recursive: simple aggregate over related_collection where fk_field = id.
 * Recursive (same-collection tree): aggregate over all descendants via CTE.
 * Returns null on any error or invalid config.
 */
async function computeRollupValue(
  collection: string,
  cfg: RollupFormula,
  id: unknown
): Promise<number | null> {
  if (!cfg.related_collection || !cfg.fk_field || !ROLLUP_AGGREGATES.has(cfg.aggregate)) {
    return null
  }
  if (cfg.aggregate !== 'count' && !cfg.value_field) return null
  if (id == null) return null

  try {
    if (cfg.recursive && cfg.related_collection === collection) {
      // MSSQL recursive CTE — gather all descendant ids at any depth, then aggregate.
      // Identifiers are bound via ?? (escaped); the id value via ?.
      // MSSQL CTEs never use the RECURSIVE keyword; MAXRECURSION guards depth.
      const selectExpr =
        cfg.aggregate === 'count' ? 'COUNT(*)' : `${cfg.aggregate.toUpperCase()}(??)`

      const sql = `WITH descendants AS (
  SELECT id FROM ?? WHERE ?? = ?
  UNION ALL
  SELECT c.id FROM ?? c INNER JOIN descendants d ON c.?? = d.id
)
SELECT ${selectExpr} AS v FROM ?? WHERE id IN (SELECT id FROM descendants)
OPTION (MAXRECURSION 100)`

      // Binding order:
      //   ?? related_collection (anchor FROM)
      //   ?? fk_field           (anchor WHERE)
      //   ?  id
      //   ?? related_collection (recursive FROM)
      //   ?? fk_field           (recursive JOIN)
      //   [?? value_field — only when aggregate != count, inside selectExpr]
      //   ?? related_collection (final FROM)
      const binds: Knex.RawBinding[] =
        cfg.aggregate === 'count'
          ? [collection, cfg.fk_field, id as Knex.Value, collection, cfg.fk_field, collection]
          : [
              collection,
              cfg.fk_field,
              id as Knex.Value,
              collection,
              cfg.fk_field,
              cfg.value_field,
              collection
            ]

      const raw = (await db.raw(sql, binds)) as
        | { recordset?: Array<{ v: number | null }> }
        | Array<{ v: number | null }>
      const recordset = Array.isArray(raw) ? raw : raw.recordset
      const v = recordset?.[0]?.v
      if (v != null) return Number(v)
      return cfg.aggregate === 'count' ? 0 : null
    }

    if (cfg.aggregate === 'count') {
      const r = (await db(cfg.related_collection)
        .where(cfg.fk_field, id as Knex.Value)
        .count('* as v')
        .first()) as { v: number } | undefined
      return Number(r?.v ?? 0)
    }

    const r = (await db(cfg.related_collection)
      .where(cfg.fk_field, id as Knex.Value)
      [cfg.aggregate](`${cfg.value_field} as v`)
      .first()) as { v: number | null } | undefined
    return r?.v != null ? Number(r.v) : null
  } catch {
    return null
  }
}

/**
 * Load computed fields for a collection from the DB.
 * Returns only rows that have a non-null computed_formula.
 */
async function getComputedFields(collection: string): Promise<ComputedFieldRow[]> {
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
  items: Record<string, unknown>[]
): Promise<void> {
  if (!items.length) return
  const fields = await getComputedFields(collection)
  const readFields = fields.filter((f) => f.computed_type === 'read' && f.computed_formula)
  const rollupFields = fields.filter((f) => f.computed_type === 'rollup' && f.computed_formula)
  if (!readFields.length && !rollupFields.length) return

  for (const item of items) {
    for (const f of readFields) {
      item[f.field] = evalFormula(f.computed_formula as string, item)
    }

    // Rollup fields aggregate related items. N+1 over items × rollup fields is
    // acceptable for now; each rollup runs its own query per item.
    for (const f of rollupFields) {
      const cfg = parseJson<RollupFormula>(f.computed_formula as string)
      if (!cfg) {
        item[f.field] = null
        continue
      }
      item[f.field] = await computeRollupValue(collection, cfg, item.id)
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
  if (!writeFields.length) return

  const evalCtx = context ?? payload
  for (const f of writeFields) {
    const store = f.computed_store === true || f.computed_store === 1
    // Always evaluate the formula; only write to payload when computed_store=true.
    // Non-stored write formulas are evaluated but the result is not persisted.
    const result = evalFormula(f.computed_formula as string, evalCtx)
    if (store) {
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

interface FieldRuleRow {
  id: number
  collection: string
  trigger_field: string
  trigger_op: string
  trigger_value: string | null
  target_field: string
  target_type: string
  target_value: string | null
  sort: number
  is_active: boolean | number
}

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
  let rules: FieldRuleRow[]
  try {
    rules = (await db('nivaro_field_rules')
      .where({ collection, is_active: true })
      .orderBy('sort')
      .select('*')) as FieldRuleRow[]
  } catch {
    // Table may not exist yet before migration runs — non-fatal.
    return
  }

  for (const rule of rules) {
    // Only evaluate rules triggered by the changed field (or all if no changedField specified)
    if (changedField && rule.trigger_field !== changedField) continue
    if (!(rule.trigger_field in payload)) continue

    const val = payload[rule.trigger_field]
    let triggered = false
    switch (rule.trigger_op) {
      case 'eq':
        triggered = String(val) === String(rule.trigger_value)
        break
      case 'neq':
        triggered = String(val) !== String(rule.trigger_value)
        break
      case 'null':
        triggered = val == null
        break
      case 'nnull':
        triggered = val != null
        break
      case 'in': {
        const list = parseJson<unknown[]>(rule.trigger_value) ?? []
        triggered = list.map(String).includes(String(val))
        break
      }
      case 'contains':
        triggered = String(val).includes(String(rule.trigger_value ?? ''))
        break
    }
    if (!triggered) continue

    if (rule.target_type === 'clear') {
      payload[rule.target_field] = null
    } else if (rule.target_type === 'set' && rule.target_value !== null) {
      payload[rule.target_field] = rule.target_value
    }
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
function findM2MRelation(
  key: string,
  collection: string,
  rels: CMSRelation[]
): { junction: string; fkToParent: string; fkToOther: string; otherCollection: string } | null {
  for (const rel of rels) {
    if (rel.one_collection !== collection) continue
    if (rel.junction_field == null) continue
    if (rel.one_field !== key) continue

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
  return null
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

async function applyConditions(q: QB, conditions: FilterCondition[], collection: string) {
  for (const cond of conditions) {
    if (cond.path.length === 1) {
      applyOneFilter(q, cond.path[0], cond.op, cond.value)
    } else if (cond.path.length === 2) {
      const [fkField, targetField] = cond.path
      const rel = (await db('nivaro_relations')
        .where({ many_collection: collection, many_field: fkField })
        .first()) as { one_collection: string } | undefined
      if (!rel?.one_collection) continue
      const related = rel.one_collection
      q.whereExists(function () {
        this.select(db.raw('1'))
          .from(related)
          .whereRaw('??.?? = ??.??', [related, 'id', collection, fkField])
          .andWhere((inner) =>
            applyOneFilter(inner, `${related}.${targetField}`, cond.op, cond.value)
          )
      })
    } else if (cond.path.length === 3) {
      const [fk1, fk2, targetField] = cond.path
      const rel1 = (await db('nivaro_relations')
        .where({ many_collection: collection, many_field: fk1 })
        .first()) as { one_collection: string } | undefined
      if (!rel1?.one_collection) continue
      const mid = rel1.one_collection
      const rel2 = (await db('nivaro_relations')
        .where({ many_collection: mid, many_field: fk2 })
        .first()) as { one_collection: string } | undefined
      if (!rel2?.one_collection) continue
      const leaf = rel2.one_collection
      q.whereExists(function () {
        this.select(db.raw('1'))
          .from(mid)
          .whereRaw('??.?? = ??.??', [mid, 'id', collection, fk1])
          .whereExists(function () {
            this.select(db.raw('1'))
              .from(leaf)
              .whereRaw('??.?? = ??.??', [leaf, 'id', mid, fk2])
              .andWhere((inner) =>
                applyOneFilter(inner, `${leaf}.${targetField}`, cond.op, cond.value)
              )
          })
      })
    }
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
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)

  const allowed = await can(user, 'read', collection)
  if (!allowed) throw new ForbiddenError()

  const rawConditions = (req?.query as Record<string, string>)?.conditions
  const conditions: FilterCondition[] | undefined = rawConditions
    ? (JSON.parse(rawConditions) as FilterCondition[])
    : undefined

  const allowedFields = await getAllowedFields(user, 'read', collection)
  const { fields = ['*'], filter = {}, sort = [], limit = 25, offset = 0, page, search } = query

  const effectiveOffset = page ? (page - 1) * limit : offset
  const selectFields =
    allowedFields === null
      ? fields[0] === '*'
        ? ['*']
        : fields
      : fields.filter((f) => f === '*' || allowedFields.includes(f))

  // Pre-load relations for this collection (and prime cache for nested ones)
  clearRelCache()
  const rels = await getRelsForCollection(collection)

  // For each related collection referenced in the filter or sort, pre-load their
  // relations into the cache so the synchronous applyFilters can access them.
  await primeRelCacheForFilter(filter, collection, rels)

  const q = db(collection)
    .select(selectFields as string[])
    .limit(Math.min(limit, 1000))
    .offset(effectiveOffset)

  if (Object.keys(filter).length) applyFilters(q, filter, collection, rels)

  if (sort.length) {
    await applySorts(q, sort, collection, rels)
  } else {
    // MSSQL requires ORDER BY when OFFSET is used
    q.orderByRaw('(SELECT NULL)')
  }

  const countQ = db(collection).count('* as count')
  if (Object.keys(filter).length) applyFilters(countQ, filter, collection, rels)

  // Row-level workspace isolation (no-op when no workspaceId passed or no column)
  await applyWorkspaceScope(q, collection, workspaceId)
  await applyWorkspaceScope(countQ, collection, workspaceId)

  // Row-level security — policy row_filter conditions (no-op when policy has none)
  const rowFilter = await getRowFilter(user, 'read', collection)
  if (rowFilter) {
    applyRowFilter(q, rowFilter, user)
    applyRowFilter(countQ, rowFilter, user)
  }

  if (conditions?.length) {
    await applyConditions(q, conditions, collection)
    await applyConditions(countQ, conditions, collection)
  }

  if (search) {
    const [fieldMeta, actualCols] = await Promise.all([
      getFields(collection),
      db.raw(
        `SELECT COLUMN_NAME AS "COLUMN_NAME" FROM information_schema.columns WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
        [collection]
      ).then((res) => rawRows<{ COLUMN_NAME: string }>(res).map(r => r.COLUMN_NAME)) as Promise<string[]>
    ])
    const actualColSet = new Set(actualCols)
    const searchable = fieldMeta.filter(
      (f) => ['string', 'text'].includes(f.type) && actualColSet.has(f.field)
    )
    if (searchable.length) {
      const applySearch = (qb: QB) => {
        qb.where((inner) => {
          for (const f of searchable) {
            inner.orWhere(db.raw('??', [f.field]), 'like', `%${search}%`)
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

  await hooks.trigger('before', { collection, action: 'read', user, database: db, req })

  const [rawData, countRows] = await Promise.all([q, countQ])
  const total = Number((countRows[0] as { count: string | number }).count)

  // Decrypt configured encrypted fields before computed fields run
  let data = await Promise.all(
    (rawData as Record<string, unknown>[]).map((row) => decryptItemFields(collection, row))
  )

  // Tree permissions on list reads — batched (one rules query + one ancestry
  // pass per page). Denied rows are dropped; `total` still reflects the
  // pre-filter count, which only differs when deny rules apply.
  data = await filterRowsByTreePermissions(user, collection, data)

  // Inherited field values (tree collections) — before computed fields so
  // formulas see effective values. Adds `_inherited` sidecar per row.
  await applyInheritedFields(collection, data)

  // Apply read-time computed fields
  await applyReadComputedFields(collection, data)

  const result = { data, total, limit, offset: effectiveOffset }

  await hooks.trigger('after', { collection, action: 'read', user, result, database: db, req })

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
        const inner =
          (value as Record<string, unknown>)['_some'] ?? (value as Record<string, unknown>)['_none']
        if (inner && typeof inner === 'object') {
          await primeRelCacheForFilter(inner as Record<string, unknown>, manyCol, manyRels)
        }
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

export async function readOne(
  user: User,
  collection: string,
  id: string | number,
  workspaceId?: string
) {
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

  const fields = allowedFields ?? ['*']

  const q = db(collection)
    .where({ id })
    .select(fields as string[])
  await applyWorkspaceScope(q, collection, workspaceId)

  if (rowFilter) applyRowFilter(q, rowFilter, user)

  let item = (await q.first()) as Record<string, unknown> | undefined

  if (item) {
    item = await decryptItemFields(collection, item)
    await applyInheritedFields(collection, [item])
    await applyReadComputedFields(collection, [item])
  }

  return item ?? null
}

export async function createOne(
  user: User,
  collection: string,
  data: Record<string, unknown>,
  req?: FastifyRequest,
  workspaceId?: string
) {
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)

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

  // Datetime auto-fields — on_create: 'now' sets the field to current timestamp
  await applyDatetimeAutoFields(collection, ctx.payload, 'on_create')

  // Auto-ID generation — fill any auto_id fields not explicitly provided
  await applyAutoIds(collection, ctx.payload)

  // Write-time computed fields — evaluated after auto-IDs so formula can reference them
  // For create, the payload itself is the full context
  await applyWriteComputedFields(collection, ctx.payload, ctx.payload)

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

  const result = await readOne(user, collection, returnedId as string | number)

  // after_create rules
  await evaluateRules(
    collection,
    'after_create',
    (result ?? ctx.payload) as Record<string, unknown>
  )

  await hooks.trigger('after', { ...ctx, keys: [returnedId as string | number], result })

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
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)

  const allowed = await can(user, 'update', collection)
  if (!allowed) throw new ForbiddenError()

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
  await hooks.trigger('before', ctx)

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

  // before_update rules — may mutate the payload (e.g. set_field)
  await evaluateRules(collection, 'before_update', ctx.payload, previousData)

  // Field rules — apply inline field defaults based on other field values
  await applyFieldRules(collection, ctx.payload)

  // Datetime auto-fields — on_update: 'now' sets the field to current timestamp
  await applyDatetimeAutoFields(collection, ctx.payload, 'on_update')

  // Write-time computed fields — merge previous data as context so formula can read existing fields
  const writeCtx = { ...(previousData ?? {}), ...ctx.payload }
  await applyWriteComputedFields(collection, ctx.payload, writeCtx)

  // Encrypt configured encrypted fields just before write
  const securedPayload = await encryptItemFields(collection, ctx.payload)

  const actualCols = await getActualColumns(collection)
  const updQ = db(collection).where({ id })
  await applyWorkspaceScope(updQ, collection, workspaceId)
  if (rowFilter) applyRowFilter(updQ, rowFilter, user)
  await updQ.update(filterToActualColumns(securedPayload, actualCols))
  const result = await readOne(user, collection, id, workspaceId)

  // after_update rules
  await evaluateRules(
    collection,
    'after_update',
    (result ?? ctx.payload) as Record<string, unknown>,
    previousData
  )

  await hooks.trigger('after', { ...ctx, result, previousData })

  return result
}

export async function deleteOne(
  user: User,
  collection: string,
  id: string | number,
  req?: FastifyRequest,
  workspaceId?: string
) {
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

  const ctx = { collection, action: 'delete' as const, keys: [id], user, database: db, req }
  await hooks.trigger('before', ctx)

  const delQ = db(collection).where({ id })
  await applyWorkspaceScope(delQ, collection, workspaceId)
  if (rowFilter) applyRowFilter(delQ, rowFilter, user)
  await delQ.delete()

  await hooks.trigger('after', { ...ctx, previousData })
}
