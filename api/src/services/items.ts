import { AsyncLocalStorage } from 'node:async_hooks'
import { Parser } from 'expr-eval'
import type { FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { db, dbRead, isMssql } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { getTenantId } from '../db/tenant-context.js'
import { hooks } from '../hooks/registry.js'
import { describeDbRefusal, describeValueRefusal } from '../lib/db-refusal.js'
import {
  likeContains,
  likeEndsWith,
  likeEscape,
  likeStartsWith,
  varcharSafePattern
} from '../lib/filter-like.js'
import {
  decodeCursor,
  encodeCursor,
  type KeysetSort,
  keysetBranches,
  keysetSorts
} from '../lib/keyset.js'
import {
  type ColumnShape,
  fitFilterOps,
  numberProblem,
  valueFitsSqlType
} from '../lib/sql-value-fit.js'
import { getAncestors, getTreeConfig, type TreeConfig } from '../lib/tree.js'
import { shouldRecomputeWriteField } from '../lib/write-formula.js'
import { fetchDefaultWorkspaceId } from '../middleware/workspace.js'
import { deferEffect, withUnitOfWork } from '../services/unit-of-work.js'
import type { CMSField, CMSRelation, ItemsQuery, User } from '../types.js'
import {
  applyAutoIdsExt,
  autoIdFieldsFor,
  autoIdJunctionTargets,
  autoIdVariantFields,
  parseAutoIdPattern,
  recomputeAutoIdPrefix,
  resolveAutoIdPattern
} from './auto-ids.js'
import { isPresencePageChange } from './collection-live-mode.js'
import { getCollection, getFields, getRelations as getRegisteredRelations } from './collections.js'
import { applyCrossRecordDefaults } from './cross-record-defaults.js'
import { assertNotEditLocked } from './edit-lock.js'
import { decryptItemFields, encryptItemFields, getEncryptedFields } from './encryption.js'
import { evaluateRulesForTrigger } from './field-rules.js'
import { getFormulaContext, networkdaysBetween } from './formula-context.js'
import {
  helpVideoFileColumnsReady,
  isFilesCollection,
  whereNotHelpVideoFile
} from './help-video-files.js'
import { enforceContracts } from './integration-contracts.js'
import { type AggregateRow, type AggregateSpec, runAggregate } from './item-aggregates.js'
import { keysetSecret } from './keyset-secret.js'
import {
  aliasReadable,
  m2aIdKey,
  m2aItemFields,
  m2aReadCollection,
  parseAllowedList,
  peopleFields,
  peopleReadable
} from './m2a-expand.js'
import { orderByPeopleRelevance } from './people-search-rank.js'
import { applyRowFilter, can, getAllowedFields, getRowFilter, isAdminRole } from './permissions.js'
import { liveRelations, tableIsMissing } from './physical-tables.js'
import { enforcePickerRules } from './picker-rules.js'
import { notePresencePageChange } from './presence-page-notes.js'
import { checkQuota, incrementUsage, QuotaExceededError } from './quotas.js'
import {
  gateIsSelfContained,
  getCachedRows,
  getCachedTotal,
  labelLookupIds,
  listTotalPlan,
  putCachedRows,
  putCachedTotal,
  readEpoch,
  statementHash
} from './read-caches.js'
import { broadcastCollectionUpdate } from './realtime.js'
import { attachRecordInstance, splitInstanceField } from './record-instance.js'
import {
  applyAgingFilter,
  applyStateFilter,
  attachRecordState,
  STATE_FIELD,
  splitStateField
} from './record-state.js'
import { enforceRelationLimits } from './relation-limits.js'
import { isStatementTimeout, noteReadShape, span, timeAccessSync } from './request-trace.js'
import {
  computeRollupTotal,
  computeRollupTotalBatch,
  matchesParentFilter,
  type NormalizedRollup,
  parseRollupFormula,
  type RollupSource,
  recalcAffectedRollups
} from './rollups.js'
import {
  applyRowLocksOnWrite,
  applyRowRulesOnCreate,
  applyRowRulesOnUpdate
} from './row-rules-autofill.js'
import { fallbackSearchColumns, narrowSearchColumns, parseSearchFields } from './search-fields.js'
import { fitExpansion, searchVariants } from './search-synonyms.js'
import { applySectionLocks } from './section-locks.js'
import {
  isSecretColumn,
  isSystemCollection,
  sensitiveColumns,
  systemReadableColumns
} from './system-collections.js'
import { writeTrashRow } from './trash.js'
import { isPathMaintained } from './tree-path.js'
import { filterRowsByTreePermissions, getTreePermission } from './tree-permissions.js'
import { withTriggerSafeReturning } from './trigger-safe.js'
import { applyDirectoryListingRules } from './user-directory-cols.js'
import {
  applyScopeEnforcement,
  applyUserScopesToQuery,
  getUserScopeEnforcement
} from './user-scopes.js'
import { enforceValidationRules, FieldValidationError } from './validation-rules.js'
import {
  ADDENDUMS_FIELD,
  AT_RISK_FIELD,
  applyAddendumsFilter,
  applyOriginFilter,
  applyRiskFilter,
  ORIGIN_FIELD,
  parseOriginFilter,
  primeOriginColumn,
  primeVirtualFilters
} from './virtual-filters.js'
import {
  cachedVirtualSql,
  compileFormulaToSql,
  compileRollupToSql,
  peekVirtualSql,
  storeVirtualSql,
  type VirtualSql
} from './virtual-sql.js'

export type { NormalizedRollup, RollupSource }
// Re-exported for compatibility with existing importers/tests — canonical
// definitions and the recalc engine live in ./rollups.js.
export { computeRollupTotal, parseRollupFormula }

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

/** A registered collection with no table behind it: still a not-found to the
 *  caller (404, never a 500 "Invalid object name"), with its own code. */
export class CollectionTableMissingError extends CollectionNotFoundError {
  statusCode = 404
  code = 'COLLECTION_TABLE_MISSING'
  constructor(collection: string) {
    super(collection)
    this.message = `Collection "${collection}" has no table in the database`
    this.name = 'CollectionTableMissingError'
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

/** An update or delete with a blank id touches nothing and must say so. */
function assertRecordId(id: unknown): void {
  if (id === null || id === undefined || String(id).trim() === '') {
    throw Object.assign(new Error('A record id is required'), { statusCode: 400 })
  }
}

function assertNotRouteOnly(collection: string): void {
  const route = ROUTE_ONLY_COLLECTIONS.get(collection)
  if (route) throw new RouteOnlyCollectionError(collection, route)
}

/**
 * Whether the generic items API serves this collection to this caller at all.
 * A system table is an administrator's, except a listed one a non-admin may
 * read (see system-collections.ts) — independent of can(), so registering a
 * system table later never opens it. An unlisted one answers as unknown.
 */
async function assertServable(
  user: User,
  collection: string,
  action: 'create' | 'read' | 'update' | 'delete'
): Promise<void> {
  assertNotRouteOnly(collection)
  if (!isSystemCollection(collection) || (await isAdminRole(user))) return
  if (!systemReadableColumns(collection)) throw new CollectionNotFoundError(collection)
  if (action !== 'read') throw new ForbiddenError()
}

/** `*` and the sensitive columns in a projection over a system table: a
 *  narrowed caller's `*` names its readable columns, never the whole row, and
 *  a credential column is never selected, whoever asks. */
async function systemProjection(
  collection: string,
  cols: string[],
  allowedFields: string[] | null
): Promise<string[]> {
  if (!isSystemCollection(collection)) return cols
  let out = cols
  if (allowedFields !== null && out.includes('*'))
    out = [...new Set([...out.filter((c) => c !== '*'), ...allowedFields])]
  const sensitive = sensitiveColumns(collection)
  if (sensitive.length === 0) return out
  const keep = (c: string) => !sensitive.includes(c.toLowerCase())
  if (!out.includes('*')) return out.filter(keep)
  const all = Object.keys(await db(collection).columnInfo()).filter(keep)
  return [...new Set([...out.filter((c) => c !== '*'), ...all])].filter(keep)
}

/**
 * The last word on a projection, after every fallback and just before the
 * SELECT: a field-limited caller's `*` becomes the columns their policy lists
 * (the table's own columns only — never an alias or a virtual name), and a
 * system table's credentials never reach the query. Without it a request for
 * only hidden fields (`fields=static_token`) narrowed to nothing and then fell
 * back to `*`, returning every column.
 */
async function finalProjection(
  collection: string,
  cols: string[],
  allowedFields: string[] | null
): Promise<string[]> {
  let out = cols
  if (allowedFields !== null && out.includes('*')) {
    const have = await tableColumns(collection)
    const listed = allowedFields.filter((f) => have.has(f.toLowerCase()))
    out = [...new Set([...out.filter((c) => c !== '*'), ...listed])]
  }
  // Rows are keyed by id everywhere (row keys, expansions, $state, to-many):
  // a field list that leaves it out still reads it.
  if (!out.includes('*') && !out.includes('id')) out = ['id', ...out]
  return systemProjection(collection, out, allowedFields)
}

const tableColumnsCache = new Map<string, { at: number; cols: Set<string> }>()

/** A table's physical column names (lower-cased), cached a minute per table. */
async function tableColumns(collection: string): Promise<Set<string>> {
  const hit = tableColumnsCache.get(collection)
  if (hit && Date.now() - hit.at < 60_000) return hit.cols
  const info = await db(collection).columnInfo()
  const cols = new Set(Object.keys(info ?? {}).map((c) => c.toLowerCase()))
  tableColumnsCache.set(collection, { at: Date.now(), cols })
  return cols
}

const columnShapesCache = new Map<string, { at: number; shapes: Map<string, ColumnShape> }>()

/** A table's column types (+ decimal precision/scale) by lower-cased name,
 *  cached a minute per tenant + table. Empty for what is not a table. */
export async function columnShapes(collection: string): Promise<Map<string, ColumnShape>> {
  const key = `${getTenantId() ?? ''}:${collection}`
  const hit = columnShapesCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.shapes
  const shapes = new Map<string, ColumnShape>()
  try {
    if (isMssql()) {
      // The table this connection resolves the name to: `schema.table` as
      // given, else the bare name's schema (below) — a same-named table in
      // another schema never mixes its column types in.
      const dot = collection.indexOf('.')
      const [schema, table] =
        dot > 0 ? [collection.slice(0, dot), collection.slice(dot + 1)] : [null, collection]
      // A bare name resolves like SQL Server does: the login's default schema
      // first, then dbo — only the winning schema's columns are read.
      const rows = rawRows<{
        c: string
        t: string
        p: number | null
        s: number | null
        l: number | null
        k: number | null
      }>(
        await db.raw(
          `SELECT COLUMN_NAME AS c, DATA_TYPE AS t, NUMERIC_PRECISION AS p, NUMERIC_SCALE AS s,
                  CHARACTER_MAXIMUM_LENGTH AS l,
                  COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)),
                                 COLUMN_NAME, 'IsComputed') AS k
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_NAME = ? AND TABLE_SCHEMA = COALESCE(?, (
             SELECT TOP 1 TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_NAME = ? AND TABLE_SCHEMA IN (SCHEMA_NAME(), 'dbo')
              ORDER BY CASE WHEN TABLE_SCHEMA = SCHEMA_NAME() THEN 0 ELSE 1 END
           ))`,
          [
            table.replace(/[[\]]/g, ''),
            schema ? schema.replace(/[[\]]/g, '') : null,
            table.replace(/[[\]]/g, '')
          ]
        )
      )
      for (const r of rows) {
        shapes.set(String(r.c).toLowerCase(), {
          type: String(r.t),
          precision: r.p,
          scale: r.s,
          length: r.l,
          computed: r.k === 1
        } as ColumnShape)
      }
    } else {
      const info = (await db(collection).columnInfo()) as Record<string, { type?: string }>
      for (const [c, v] of Object.entries(info ?? {})) {
        shapes.set(c.toLowerCase(), { type: String(v?.type ?? '') })
      }
    }
  } catch {
    // nothing this can describe: nothing is judged
  }
  columnShapesCache.set(key, { at: Date.now(), shapes })
  return shapes
}

/**
 * Whether `id` can be the collection's primary key at all — `abc` against an
 * int key or `999999` against a uniqueidentifier is a conversion error in SQL
 * Server, not a miss. Callers answer such an id as not found.
 */
export async function idFitsCollection(collection: string, id: unknown): Promise<boolean> {
  return valueFitsSqlType(id, (await columnShapes(collection)).get('id')?.type)
}

/**
 * Refuse a number its column cannot hold before the write reaches the driver
 * (lib/sql-value-fit.ts numberProblem): a 400 naming the field, where 1e308
 * used to come back as "Bigint must be safe integer…" with a 500.
 */
/**
 * A text value longer than its column holds is refused naming the field —
 * SQL Server's own refusal ("String or binary data would be truncated") does
 * not say which column on this stack, so the form could not point at it.
 * `max` columns (length -1) take anything.
 */
/**
 * SQL computed columns belong to the database: a write naming one (a
 * duplicated record's child rows copying them) was a 500 carrying the
 * statement (error 271). They are never written.
 */
export async function dropComputedColumns(
  collection: string,
  payload: Record<string, unknown>
): Promise<void> {
  const shapes = await columnShapes(collection)
  for (const field of Object.keys(payload)) {
    if ((shapes.get(field.toLowerCase()) as { computed?: boolean } | undefined)?.computed)
      delete payload[field]
  }
}

/**
 * A non-admin links only a file they may read (file-access.ts): naming the id
 * of a file attached to a record they cannot open — in a file field or a files
 * junction row — would hand them its bytes through their own record.
 */
export async function assertLinkedFilesReadable(
  collection: string,
  payload: Record<string, unknown>,
  callerFields: Set<string>,
  req: FastifyRequest | undefined,
  previous?: Record<string, unknown> | null
): Promise<void> {
  if (!req?.user || req.isAdmin || isSystemCollection(collection)) return
  const { getFileRefColumns } = await import('./file-usage.js')
  const sites = await getFileRefColumns().catch(() => [])
  const ids: Array<{ field: string; id: string }> = []
  for (const site of sites) {
    if (site.table.toLowerCase() !== collection.toLowerCase()) continue
    const field = [...callerFields].find((f) => f.toLowerCase() === site.column.toLowerCase())
    const v = field ? payload[field] : null
    if (!field || v == null || v === '' || typeof v === 'object') continue
    if (previous && String(previous[field] ?? '').toLowerCase() === String(v).toLowerCase())
      continue
    ids.push({ field, id: String(v) })
  }
  if (ids.length === 0) return
  const { readableFileIdList } = await import('./file-access.js')
  const ok = await readableFileIdList(
    ids.map((x) => x.id),
    req
  )
  const bad = ids.find((x) => !ok.has(x.id.toLowerCase()))
  if (bad)
    throw Object.assign(
      new Error('That file belongs to a record you cannot open, so it cannot be linked here'),
      { statusCode: 403, code: 'FILE_NOT_READABLE', field: bad.field }
    )
}

export async function assertStringsFit(
  collection: string,
  payload: Record<string, unknown>
): Promise<void> {
  const shapes = await columnShapes(collection)
  if (shapes.size === 0) return
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value !== 'string') continue
    const max = (shapes.get(field.toLowerCase()) as { length?: number | null } | undefined)?.length
    if (typeof max !== 'number' || max <= 0 || value.length <= max) continue
    const label = field.replace(/_/g, ' ')
    throw new FieldValidationError(
      `${label.charAt(0).toUpperCase()}${label.slice(1)} is too long — at most ${max} characters (this has ${value.length})`,
      field,
      'max_length'
    )
  }
}

async function assertNumbersFit(
  collection: string,
  payload: Record<string, unknown>
): Promise<void> {
  const shapes = await columnShapes(collection)
  if (shapes.size === 0) return
  for (const [field, value] of Object.entries(payload)) {
    const problem = numberProblem(value, shapes.get(field.toLowerCase()))
    if (problem) {
      const label = field.replace(/_/g, ' ')
      throw new FieldValidationError(
        `${label.charAt(0).toUpperCase()}${label.slice(1)} ${problem}`,
        field,
        'number_range'
      )
    }
  }
}

/**
 * People pickers (`nivaro_users?picker=1`) offer people who can act — never a
 * suspended, redacted, anonymised or legacy-import placeholder account (the
 * rows /api/users hides: services/users.ts applyHiddenAccountFilter +
 * applySuspendedFilter; inactive-user-links.ts INACTIVE_SQL). A stored value
 * still displays: single reads never come through here.
 */
export function applyPeoplePickerFilter(qb: QB): void {
  qb.where((w) => w.where('is_redacted', false).orWhereNull('is_redacted'))
    .whereRaw(`email not like 'legacy-%'`)
    .whereRaw(`email not like 'Redacted\\_%' escape '\\'`)
    .whereRaw(`email not like '%@invalid.local'`)
    .where((w) => w.whereNull('account_kind').orWhereNot('account_kind', 'placeholder'))
    .where((w) => w.where('status', '!=', 'suspended').orWhereNull('status'))
}

/** A filter's plain objects and arrays copied (values by reference) — the
 *  compiler fits values to column types in place, and the caller's filter
 *  (the Traffic Map read shape, a cached config filter) must stay as sent. */
function cloneFilterTree<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneFilterTree(x)) as T
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cloneFilterTree(x)])
    ) as T
  }
  return v
}

/**
 * Fit a field's filter operators to its column type before they compile
 * (lib/sql-value-fit.ts): a value the column cannot hold matches nothing
 * rather than reaching SQL as a conversion error; a range operator with such
 * a value is refused in plain words.
 */
async function fitFilterValues(
  ops: Record<string, unknown>,
  collection: string,
  column: string,
  path: string[]
): Promise<void> {
  if (peekVirtualSql(collection)?.has(column)) return
  const type = (await columnShapes(collection)).get(column.toLowerCase())?.type
  const refused = fitFilterOps(ops, type)
  if (refused) {
    throw filterRefusal(
      'FILTER_VALUE_INVALID',
      `"${refused}" on "${[...path, column].join('.')}" needs ${type === 'uniqueidentifier' ? 'an id' : 'a number'}`,
      { path: [...path, column], operator: refused }
    )
  }
}

/**
 * A credential named anywhere in a filter, sort or condition path is refused
 * (a relation path reaches nivaro_users from any record); on the system table
 * itself, every sensitive column is. Admins included: a filter is an oracle.
 */
function assertNoSensitivePaths(
  collection: string,
  filter: Record<string, unknown>,
  sort: string[],
  conditions: Array<FilterCondition | OrCondition> | undefined
): void {
  const own = sensitiveColumns(collection)
  const bad: string[] = []
  const check = (path: string, atRoot: boolean) => {
    const segs = path.split('.')
    segs.forEach((seg, i) => {
      if (isSecretColumn(seg) || (atRoot && i === 0 && own.includes(seg.toLowerCase())))
        bad.push(seg)
    })
  }
  const walk = (f: unknown, atRoot: boolean) => {
    if (Array.isArray(f)) {
      for (const c of f) walk(c, atRoot)
      return
    }
    if (!f || typeof f !== 'object') return
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (k === '_and' || k === '_or') walk(v, atRoot)
      else if (k.startsWith('_') || k.startsWith('$')) walk(v, false)
      else {
        check(k, atRoot)
        walk(v, false)
      }
    }
  }
  walk(filter, true)
  for (const s of sort) check(s.startsWith('-') ? s.slice(1) : s, true)
  for (const c of conditions ?? []) {
    const list = 'or' in c ? c.or : [c]
    for (const one of list)
      if (Array.isArray(one?.path)) check(one.path.map(String).join('.'), true)
  }
  if (bad.length === 0) return
  throw Object.assign(
    new Error(`${[...new Set(bad)].map((f) => `"${f}"`).join(', ')} cannot be filtered or sorted`),
    { statusCode: 400, code: 'FIELD_NOT_FILTERABLE', fields: [...new Set(bad)] }
  )
}

/**
 * Every filter, sort and condition path that reaches a system table may name
 * only columns the caller can read there — on the table itself and through a
 * relation hop into it (`created_by.role`). A filter is an oracle: matching on
 * a column reveals it as surely as selecting it. Business collections keep
 * their existing behaviour here.
 */
async function assertReadableSystemPaths(
  user: User,
  collection: string,
  filter: Record<string, unknown>,
  sort: string[],
  conditions: Array<FilterCondition | OrCondition> | undefined
): Promise<void> {
  const paths: string[][] = []
  const walk = (f: unknown, prefix: string[]) => {
    if (Array.isArray(f)) {
      for (const c of f) walk(c, prefix)
      return
    }
    if (!f || typeof f !== 'object') return
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (k === '_and' || k === '_or' || k === '_some' || k === '_none') walk(v, prefix)
      else if (k.startsWith('_') || k.startsWith('$')) continue
      else {
        // A dotted key (`{"created_by.role": …}`) is a path too.
        const path = [...prefix, ...k.split('.')]
        paths.push(path)
        walk(v, path)
      }
    }
  }
  walk(filter, [])
  for (const s of sort) paths.push((s.startsWith('-') ? s.slice(1) : s).split('.'))
  for (const c of conditions ?? []) {
    const list = 'or' in c ? c.or : [c]
    for (const one of list) {
      const p = (one as { path?: unknown })?.path
      if (Array.isArray(p)) paths.push(p.map(String))
      else if (typeof p === 'string') paths.push(p.split('.'))
    }
  }
  if (paths.length === 0) return

  // Administrators read every column; credentials are refused for them by
  // assertNoSensitivePaths.
  if (await isAdminRole(user)) return

  const fieldsFor = new Map<string, Promise<string[] | null>>()
  const allowedIn = (c: string) => {
    let hit = fieldsFor.get(c)
    if (!hit) {
      hit = getAllowedFields(user, 'read', c)
      fieldsFor.set(c, hit)
    }
    return hit
  }
  const readable = (allowed: string[] | null, col: string) =>
    allowed === null ||
    col.toLowerCase() === 'id' ||
    allowed.some((f) => f.toLowerCase() === col.toLowerCase())
  const bad = new Set<string>()
  for (const segs of paths) {
    let current = collection
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const last = i === segs.length - 1
      // The hop the compilers would take from here (case-insensitive like the
      // database, the `_id`-less FK alias, M2M through the junction).
      const hop = last ? null : resolveFilterHop(seg, current, await getRelsForCollection(current))
      if (isSystemCollection(current)) {
        const allowed = await allowedIn(current)
        if (!readable(allowed, hop?.column ?? seg)) {
          bad.add(segs.slice(0, i + 1).join('.'))
          break
        }
      }
      if (last) break
      // A middle segment the checker cannot follow is refused: the compiler
      // either errors on it or joins something this check never saw.
      if (!hop) {
        bad.add(segs.slice(0, i + 1).join('.'))
        break
      }
      current = hop.next
    }
  }
  if (bad.size === 0) return
  throw Object.assign(
    new Error(`${[...bad].map((f) => `"${f}"`).join(', ')} cannot be filtered or sorted`),
    { statusCode: 403, code: 'FIELD_NOT_READABLE', fields: [...bad] }
  )
}

/**
 * The relation hop a filter, sort or condition compiler takes from `current`
 * on `seg` — matched case-insensitively (the database is), accepting the FK
 * name with or without `_id`, and following an M2M alias through its junction
 * to the target. `column` is the field on `current` the hop reads.
 */
function resolveFilterHop(
  seg: string,
  current: string,
  rels: CMSRelation[]
): { next: string; column: string } | null {
  const k = seg.toLowerCase()
  const cur = current.toLowerCase()
  const eq = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b
  for (const r of rels) {
    // A relation whose FK column is on `current` is an M2O from here — a
    // junction's own legs too (junction_field only marks the pairing).
    if (!eq(r.many_collection, cur) || !r.one_collection) continue
    const fk = r.many_field.toLowerCase()
    if (fk === k || (fk.endsWith('_id') && fk.slice(0, -3) === k))
      return { next: r.one_collection, column: r.many_field }
  }
  for (const exact of [true, false]) {
    for (const r of rels) {
      if (!eq(r.one_collection, cur) || r.junction_field == null) continue
      if (exact ? !eq(r.one_field, k) : !eq(r.many_collection, k)) continue
      const other = rels.find(
        (o) =>
          eq(o.many_collection, r.many_collection.toLowerCase()) &&
          eq(o.many_field, (r.junction_field ?? '').toLowerCase())
      )
      if (other?.one_collection) return { next: other.one_collection, column: r.one_field ?? seg }
    }
  }
  for (const r of rels) {
    if (!eq(r.one_collection, cur) || r.junction_field != null) continue
    if (eq(r.one_field, k)) return { next: r.many_collection, column: r.one_field ?? seg }
  }
  return null
}

// ─── Change-reason requirement ───────────────────────────────────────────────
// nivaro_collections.change_reason_config: { fields, reasons?, allow_free_text? }
// When a listed field actually changes in an update, the caller must supply
// `_change_reason` (stripped from the payload; stored on the activity row).
export interface ChangeReasonConfig {
  fields: string[]
  reasons?: string[]
  allow_free_text?: boolean
  /** Identity fields echoed back in the challenge so the prompt can say
   *  WHICH record is changing ("Year 2026" for a forecast whose months are
   *  the flagged fields). Read from the stored row (or the payload on create). */
  context_fields?: string[]
  /** Also demand a reason on CREATE when any flagged field arrives non-empty
   *  — a new forecast year is as much a forecast change as an edited month. */
  on_create?: boolean
}

export function parseChangeReasonConfig(raw: unknown): ChangeReasonConfig | null {
  if (!raw) return null
  try {
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!cfg || !Array.isArray(cfg.fields) || cfg.fields.length === 0) return null
    return {
      fields: cfg.fields.map(String),
      reasons: Array.isArray(cfg.reasons) ? cfg.reasons.map(String).filter(Boolean) : [],
      allow_free_text: cfg.allow_free_text !== false,
      context_fields: Array.isArray(cfg.context_fields)
        ? cfg.context_fields.map(String).filter((f: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f))
        : [],
      on_create: cfg.on_create === true
    }
  } catch {
    return null
  }
}

export class ChangeReasonRequiredError extends Error {
  statusCode = 422
  code = 'CHANGE_REASON_REQUIRED'
  violations: {
    fields_changed: string[]
    reasons: string[]
    allow_free_text: boolean
    context: Array<{ field: string; value: unknown }>
  }
  constructor(
    fieldsChanged: string[],
    cfg: ChangeReasonConfig,
    row?: Record<string, unknown> | null
  ) {
    super(`A reason is required when changing: ${fieldsChanged.join(', ')}`)
    this.name = 'ChangeReasonRequiredError'
    this.violations = {
      fields_changed: fieldsChanged,
      reasons: cfg.reasons ?? [],
      allow_free_text: cfg.allow_free_text !== false,
      context: (cfg.context_fields ?? [])
        .filter((f) => row && row[f] != null && row[f] !== '')
        .map((f) => ({ field: f, value: row?.[f] }))
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

/** A list read the database gave up on (statement timeout): 503, try again or narrow it. */
export class ListTimeoutError extends Error {
  statusCode = 503
  code = 'LIST_TIMEOUT'

  constructor(search: boolean) {
    super(
      search
        ? 'This search took too long to finish. Try again, or search for something more specific.'
        : 'This list took too long to load. Try again, or narrow the filters.'
    )
    this.name = 'ListTimeoutError'
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
/** Most rows one list read returns; a larger (or -1) limit is cut to it and the answer says so. */
export const LIST_READ_MAX = 1000
/** LIKE patterns × searched columns one search may bind (SQL Server caps a statement near 2100). */
const SEARCH_PATTERN_BUDGET = 1200

const INTEGRATIONS_FIELD = '$integrations'

// Per-process cache of actual DB columns per table, per tenant (cloud: one process serves many
// databases). Columns do change at run time (the schema editor adds fields): every reader that
// meets an unknown name forgets the entry and looks once more, and an entry is at most
// COLUMN_CACHE_TTL_MS old. Capped so a stream of made-up table names cannot grow it unbounded.
const COLUMN_CACHE_TTL_MS = 5 * 60_000
const COLUMN_CACHE_MAX = 5_000
const columnCache = new Map<string, { at: number; set: Set<string> }>()
const columnCacheKey = (table: string) => `${getTenantId() ?? ''}:${table}`

/** Forget one table's cached columns (this tenant) — a column added since it was read. */
export function forgetActualColumns(table: string): void {
  columnCache.delete(columnCacheKey(table))
}

export async function getActualColumns(table: string): Promise<Set<string>> {
  const key = columnCacheKey(table)
  const cached = columnCache.get(key)
  if (cached && Date.now() - cached.at < COLUMN_CACHE_TTL_MS) return cached.set
  const rows = rawRows<{ COLUMN_NAME: string }>(
    await db.raw(
      `SELECT COLUMN_NAME AS "COLUMN_NAME" FROM information_schema.columns WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      [table]
    )
  )
  const set = new Set(rows.map((r) => r.COLUMN_NAME))
  columnCache.delete(key)
  while (columnCache.size >= COLUMN_CACHE_MAX) {
    const oldest = columnCache.keys().next().value
    if (oldest === undefined) break
    columnCache.delete(oldest)
  }
  columnCache.set(key, { at: Date.now(), set })
  return set
}

/** The table's physical column named `column` (any case), through the column cache: looked up
 *  once more on a miss when the cached copy is older than 5 s (a column added since). Null when
 *  the table has no such column. */
export async function actualColumnName(table: string, column: string): Promise<string | null> {
  const want = column.toLowerCase()
  const find = (set: Set<string>) => [...set].find((c) => c.toLowerCase() === want) ?? null
  const hit = find(await getActualColumns(table))
  if (hit) return hit
  const entry = columnCache.get(columnCacheKey(table))
  if (entry && Date.now() - entry.at < 5_000) return null
  forgetActualColumns(table)
  return find(await getActualColumns(table))
}

const NON_UNICODE_TYPES = new Set(['varchar', 'char', 'text'])
const COLUMN_TYPE_TTL_MS = 60_000
const columnTypeCache = new Map<string, { at: number; types: Map<string, string> }>()

/** Column name → lower-case DATA_TYPE, per tenant; a minute old at most, so a
 *  field added in the schema editor becomes searchable without a restart. */
async function getColumnTypes(table: string): Promise<Map<string, string>> {
  const key = `${getTenantId() ?? ''}:${table}`
  const hit = columnTypeCache.get(key)
  if (hit && Date.now() - hit.at < COLUMN_TYPE_TTL_MS) return hit.types
  const rows = rawRows<{ COLUMN_NAME: string; DATA_TYPE: string }>(
    await db.raw(
      `SELECT COLUMN_NAME AS "COLUMN_NAME", DATA_TYPE AS "DATA_TYPE" FROM information_schema.columns WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      [table]
    )
  )
  const map = new Map(rows.map((r) => [r.COLUMN_NAME, String(r.DATA_TYPE ?? '').toLowerCase()]))
  if (map.size > 0) {
    if (columnTypeCache.size >= COLUMN_CACHE_MAX) columnTypeCache.clear()
    columnTypeCache.set(key, { at: Date.now(), types: map })
  }
  return map
}

/**
 * A projection that names a column the table does not have used to reach the
 * database and come back as a 500 carrying the statement. The caller is told
 * which names are unknown instead. A name missing from the cached column set
 * is looked up once more before it is refused (a column added since).
 */
async function assertKnownFields(collection: string, fields: string[]): Promise<void> {
  if (fields.length === 0 || fields[0] === '*') return
  const lookup = async () =>
    new Set([...(await getActualColumns(collection))].map((c) => c.toLowerCase()))
  let cols = await lookup()
  // No columns at all: not a table this check can judge (a view-backed collection).
  if (cols.size === 0) return
  const missing = () =>
    fields.filter((f) => typeof f === 'string' && f !== '*' && !cols.has(f.toLowerCase()))
  if (missing().length === 0) return
  forgetActualColumns(collection)
  cols = await lookup()
  const unknown = missing()
  if (unknown.length === 0) return
  const names = unknown.map((f) => `"${f}"`).join(', ')
  throw Object.assign(
    new Error(
      `${collection} has no field ${names}${unknown.length === 1 ? '' : ' (none of these exist)'}`
    ),
    { statusCode: 400, code: 'UNKNOWN_FIELD', fields: unknown }
  )
}

/**
 * Stamp the audit `special`s a collection declares on its fields
 * (`user-created` / `date-created` on create, `user-updated` / `date-updated`
 * on update) — the same contract the schema's origin platform honoured, so an
 * imported collection's creator/created columns are populated by every write
 * path (form, REST, GraphQL, extensions) instead of staying NULL. A value the
 * caller sent explicitly wins; a field with no physical column is skipped.
 */
async function applyAuditSpecials(
  collection: string,
  payload: Record<string, unknown>,
  user: User,
  phase: 'create' | 'update',
  callerFields: Set<string>,
  actualCols?: Set<string>
): Promise<void> {
  let fields: CMSField[]
  try {
    fields = await getFields(collection)
  } catch {
    return
  }
  const wantUser = phase === 'create' ? 'user-created' : 'user-updated'
  const wantDate = phase === 'create' ? 'date-created' : 'date-updated'
  let now: Date | null = null
  for (const f of fields) {
    const specials = f.special ?? []
    if (specials.length === 0) continue
    if (callerFields.has(f.field)) continue
    if (actualCols && !actualCols.has(f.field)) continue
    if (specials.includes(wantUser)) {
      if (phase === 'create' && payload[f.field] != null) continue
      payload[f.field] = user.id
    } else if (specials.includes(wantDate)) {
      if (phase === 'create' && payload[f.field] != null) continue
      now ??= new Date()
      payload[f.field] = now
    }
  }
}

const AUDIT_SPECIALS = ['user-created', 'date-created', 'user-updated', 'date-updated']

/**
 * Fields a non-admin never sets (create or update): the audit specials
 * (creator, created/changed stamps — creator decides who may change a record
 * in approval and who may make owner-or-creator moves), fields outside the
 * role's create/update field list and, for the caller's own payload
 * (`callerPayload`), fields the data model marks read-only (pipeline-state
 * mirrors, rollup totals). Dropped before anything reads the payload, so the
 * audit pass stamps the real values. Admins and server code without a request
 * keep them; server code that writes a read-only field on someone's behalf
 * (bulk actions, extensions) does not pass `callerPayload`.
 */
export async function dropServerSetFields(
  user: User,
  collection: string,
  payload: Record<string, unknown>,
  phase: 'create' | 'update',
  req: FastifyRequest | undefined,
  callerPayload: boolean
): Promise<string[]> {
  if (!req || req.isAdmin) return []
  let fields: CMSField[]
  try {
    fields = await getFields(collection)
  } catch {
    return []
  }
  const byName = new Map(fields.map((f) => [f.field, f]))
  const allowed = await getAllowedFields(user, phase, collection)
  const listed = allowed && !allowed.includes('*') ? new Set(allowed) : null
  const dropped: string[] = []
  for (const key of Object.keys(payload)) {
    if (key.startsWith('_') || key === 'id') continue
    const f = byName.get(key)
    const audit = (f?.special ?? []).some((s) => AUDIT_SPECIALS.includes(s))
    const readonly = callerPayload && f?.readonly === true
    if (audit || readonly || (listed && !listed.has(key))) {
      delete payload[key]
      dropped.push(key)
    }
  }
  return dropped
}

/**
 * Leading/trailing spaces typed or pasted into a single-line text input are
 * never part of the value (they leaked into record names built from it) —
 * trimmed on the caller's own payload. Multi-line, rich-text and code fields,
 * and system tables, keep what was sent.
 */
export async function trimSingleLineInputs(
  collection: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (isSystemCollection(collection)) return
  let fields: CMSField[]
  try {
    fields = await getFields(collection)
  } catch {
    return
  }
  for (const f of fields) {
    const v = payload[f.field]
    if (typeof v !== 'string' || f.interface !== 'input') continue
    if (f.type !== 'string' && f.type !== 'text') continue
    const trimmed = v.trim()
    if (trimmed !== v) payload[f.field] = trimmed
  }
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

// 60s TTL cache — workspace_id columns can be added at runtime via the data model. Per tenant,
// and capped (a collection name comes from the request path).
const wsColumnCache = new Map<string, { exists: boolean; at: number }>()
const WS_COLUMN_TTL_MS = 60_000
const WS_COLUMN_MAX = 5_000

/** True when the collection's physical table has a `workspace_id` column. */
export async function workspaceColumnExists(collection: string): Promise<boolean> {
  const key = `${getTenantId() ?? ''}:${collection}`
  const hit = wsColumnCache.get(key)
  if (hit && Date.now() - hit.at < WS_COLUMN_TTL_MS) return hit.exists
  let exists = false
  try {
    const info = await db(collection).columnInfo()
    exists = WORKSPACE_COLUMN in info
  } catch {
    exists = false
  }
  wsColumnCache.delete(key)
  while (wsColumnCache.size >= WS_COLUMN_MAX) {
    const oldest = wsColumnCache.keys().next().value
    if (oldest === undefined) break
    wsColumnCache.delete(oldest)
  }
  wsColumnCache.set(key, { exists, at: Date.now() })
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
 * Mutates each item in place. Exported for readers that fetch rows
 * outside readItems (the mail record card) and still owe virtual fields
 * their value.
 */
export async function applyReadComputedFields(
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
  const readFields = fields.filter(
    (f) => f.computed_type === 'read' && f.computed_formula && wanted(f)
  )
  const rollupFields = fields.filter(
    (f) => f.computed_type === 'rollup' && f.computed_formula && wanted(f)
  )
  if (!readFields.length && !rollupFields.length) return

  for (const item of items) {
    for (const f of readFields) {
      item[f.field] = evalFormula(f.computed_formula as string, item)
    }
  }

  // Virtual rollups aggregate related rows — batched per FIELD across the
  // page (one grouped read per source), not per item. Fields with
  // computed_store are written at write time and already sit on the row —
  // recomputing them here would be redundant and defeats the point of storing.
  for (const f of rollupFields) {
    if (f.computed_store === true || f.computed_store === 1) continue
    const cfg = parseRollupFormula(f.computed_formula as string)
    if (!cfg) {
      for (const item of items) item[f.field] = null
      continue
    }
    // A parent the rollup does not apply to keeps whatever the row holds.
    const targets = cfg.parent_filter
      ? items.filter((item) => matchesParentFilter(item, cfg.parent_filter))
      : items
    if (targets.length === 0) continue
    const totals = await computeRollupTotalBatch(
      cfg,
      targets.map((item) => item.id),
      collection
    )
    for (const item of targets) item[f.field] = totals.get(String(item.id)) ?? null
  }
}

/**
 * Virtual fields in an explicit projection.
 *
 * A read-computed formula or a virtual rollup has no column. Named in
 * `fields=` it used to reach the SELECT and fail with "Invalid column name" —
 * on list reads, on single reads, and for any role whose policy field list
 * names one. Here the virtual names leave the SELECT, the columns their
 * formulas read join it, and the caller computes them after the read exactly
 * as a `*` read does. `extras` are the inputs that were added only for the
 * computation; they are removed from the rows before they are returned.
 */
async function splitVirtualFields(
  collection: string,
  select: string[]
): Promise<{ select: string[]; requested: string[] | undefined; extras: string[] }> {
  if (select[0] === '*' || select.length === 0) {
    return { select, requested: undefined, extras: [] }
  }
  const computed = (await getComputedFields(collection)).filter(
    (f) =>
      (f.computed_type === 'read' || f.computed_type === 'rollup') &&
      !(f.computed_store === true || f.computed_store === 1)
  )
  if (computed.length === 0) return { select, requested: select, extras: [] }
  const byName = new Map(computed.map((f) => [f.field, f]))
  if (!select.some((f) => byName.has(f))) return { select, requested: select, extras: [] }
  const physical = await getActualColumns(collection)
  const virtual = select.filter((f) => byName.has(f) && !physical.has(f))
  if (virtual.length === 0) return { select, requested: select, extras: [] }

  const kept = select.filter((f) => !virtual.includes(f))
  const have = new Set(kept)
  const extras: string[] = []
  const need = (col: string) => {
    if (!physical.has(col) || have.has(col)) return
    have.add(col)
    extras.push(col)
  }
  for (const name of virtual) {
    const f = byName.get(name) as ComputedFieldRow
    const formula = String(f.computed_formula ?? '')
    if (f.computed_type === 'read') {
      for (const m of formula.matchAll(/\bitem\.([A-Za-z_][A-Za-z0-9_]*)/g)) need(m[1])
    } else {
      need('id')
      const cfg = parseRollupFormula(formula)
      for (const k of Object.keys(cfg?.parent_filter ?? {})) need(k)
    }
  }
  return { select: [...kept, ...extras], requested: select, extras }
}

function dropExtras(rows: Record<string, unknown>[], extras: string[]): void {
  if (extras.length === 0) return
  for (const row of rows) for (const k of extras) delete row[k]
}

/**
 * Apply write-time computed fields.
 * Evaluates each formula with `context` (full merged record) and writes the result
 * directly into `payload` for stored fields (computed_store=true).
 * `context` should be the merged { ...previousData, ...payload } so formulas can
 * read existing field values even when they are not in the incoming payload.
 */
export async function applyWriteComputedFields(
  collection: string,
  payload: Record<string, unknown>,
  context?: Record<string, unknown>,
  opts?: { previous?: Record<string, unknown> | null }
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
    // On an update, a formula re-derives only when the payload CHANGES one of
    // its inputs (lib/write-formula.ts). A stored value that does not equal
    // the formula — a legacy line loaded as production holds it — survives
    // unrelated edits (Rob, 2026-10-12, reinstating 9a713028).
    if (
      opts?.previous &&
      !shouldRecomputeWriteField(f.computed_formula as string, payload, opts.previous)
    ) {
      // The STORED value holds — never a caller-supplied one. A write-computed
      // column is not directly writable; before this rule the formula always
      // overwrote what the caller sent, so drop it rather than let it land.
      delete payload[f.field]
      continue
    }
    // Only write to payload when computed_store=true.
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
    } catch {
      /* malformed options — skip */
    }
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
      // NOT .distinct().pluck(): on mssql that compiles to
      // `SELECT DISTINCT x, x … ORDER BY sort`, which SQL Server rejects
      // ("ORDER BY items must appear in the select list") — and the catch below
      // then silently disabled every server-side field rule. Dedupe in JS.
      const rows = (await db('nivaro_field_rules')
        .where({ collection, is_active: true })
        .orderBy('sort')
        .select('trigger_field')) as Array<{ trigger_field: string }>
      triggerFields = [...new Set(rows.map((r) => String(r.trigger_field)))].filter(
        (f) => f in payload
      )
    }
  } catch {
    // Table may not exist yet before migration runs — non-fatal.
    return
  }

  // Delegates static set/clear matching and dynamic (set_lookup/set_from_trigger)
  // + only_when_empty resolution to the shared engine used by POST /field-rules/evaluate.
  for (const triggerField of triggerFields) {
    if (!(triggerField in payload)) continue
    const updates = await evaluateRulesForTrigger(
      db,
      collection,
      triggerField,
      payload[triggerField],
      payload
    )
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

/** A collection's relations, minus any whose table (a junction, a related
 *  collection) does not exist — nivaro_relations is a claim, not truth. A
 *  deep field or M2M expansion through a missing junction is left out instead
 *  of failing the whole read with "Invalid object name". */
async function getRelations(collection: string): Promise<CMSRelation[]> {
  const registered = await getRegisteredRelations(collection)
  const live = await liveRelations(registered)
  const key = `${getTenantId() ?? ''}:${collection}`
  if (live.length === registered.length) unbuiltAliases.delete(key)
  else {
    const kept = new Set(live)
    const gone = registered
      .filter((r) => !kept.has(r) && r.one_collection === collection && r.one_field)
      .map((r) => String(r.one_field))
    if (unbuiltAliases.size >= 2000) unbuiltAliases.clear()
    unbuiltAliases.set(key, new Set(gone))
  }
  return live
}

/** `<tenant>:<collection>` → to-many alias fields whose relation runs through
 *  a table that does not exist (getRelations dropped it). */
const unbuiltAliases = new Map<string, Set<string>>()

/** A requested field list minus aliases whose relation has no table: such a
 *  field reads as absent rather than refusing the read as an unknown field. */
async function withoutUnbuiltAliases(
  collection: string,
  split: { direct: string[]; nested: Record<string, string[]> }
): Promise<{ direct: string[]; nested: Record<string, string[]> }> {
  await getRelsForCollection(collection)
  const gone = unbuiltAliases.get(`${getTenantId() ?? ''}:${collection}`)
  if (!gone || gone.size === 0) return split
  return {
    direct: split.direct.filter((f) => !gone.has(f)),
    nested: Object.fromEntries(Object.entries(split.nested).filter(([k]) => !gone.has(k)))
  }
}

async function getRelsForCollection(collection: string): Promise<CMSRelation[]> {
  const cached = relCache.get(collection)
  if (cached) return cached
  const rels = await getRelations(collection)
  relCache.set(collection, rels)
  return rels
}

/**
 * A junction row's write is a change of its PARENT's many-to-many field
 * (a workflow's Zones, Funding Years, Files): an open parent record hears
 * only its own collection's events, so it is told too — the alias name as
 * the changed field, ids only (army v3: a Zone change by someone else never
 * reached an open record, and Duplicate copied the stale Zone).
 */
async function broadcastJunctionParents(
  req: FastifyRequest | undefined,
  collection: string,
  rows: Array<Record<string, unknown> | null | undefined>
): Promise<void> {
  const rels = await getRelsForCollection(collection).catch(() => [] as CMSRelation[])
  const legs = rels.filter(
    (r) => r.many_collection === collection && r.junction_field && r.one_collection && r.one_field
  )
  if (legs.length === 0) return
  const sent = new Set<string>()
  for (const leg of legs) {
    for (const row of rows) {
      const parent = row?.[leg.many_field]
      if (parent == null || parent === '' || typeof parent === 'object') continue
      const key = `${leg.one_collection}\u0001${String(parent)}\u0001${leg.one_field}`
      if (sent.has(key)) continue
      sent.add(key)
      broadcastCollectionUpdate(req?.server?.io, leg.one_collection as string, String(parent), {
        action: 'update',
        changed_fields: [leg.one_field as string]
      })
    }
  }
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
    if (f === '*') {
      direct.add('*')
      continue
    }
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
  workspaceId?: string,
  /** #2444 — a list page: flat M2O expansions may reuse cached display-label rows. */
  listRead = false
): Promise<void> {
  if (depth > 4 || items.length === 0 || Object.keys(nested).length === 0) return

  const rels = await getRelsForCollection(collection)

  // Resolve wildcard parent: expand ALL M2O relations for this collection
  const expandEntries = Object.entries(nested).filter(([k]) => k !== '*')
  if ('*' in nested) {
    const wildcardSubs = nested['*']
    for (const r of rels) {
      // A junction's own legs are M2O from the junction (junction_field only
      // marks the pairing — gotchas: never filter it out for M2O legs).
      if (r.many_collection === collection && r.many_field) {
        const f = r.many_field
        if (!expandEntries.find(([k]) => k === f)) {
          expandEntries.push([f, wildcardSubs])
        }
      }
    }
  }

  for (const [fieldName, subFields] of expandEntries) {
    const rel = rels.find((r) => r.many_collection === collection && r.many_field === fieldName)
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

    const { direct: subDirect0, nested: subNested } = await withoutUnbuiltAliases(
      relCollection,
      parseFieldExpansion(subFields)
    )

    // `related.$state` — a projection, not a column. Out before selectCols is
    // built; 'id' is always selected below, which is all the attach needs.
    const subState = splitStateField(subDirect0)
    const subInstance = splitInstanceField(subState.fields, subNested)
    let subDirect = subInstance.fields
    delete subNested[STATE_FIELD]

    // To-many aliases on the related record (`project.lines.amount`,
    // `request.internal_contact.*`) — read after the batch, as the caller.
    const subPlanned = await planToMany(
      relCollection,
      await getRelsForCollection(relCollection),
      subNested
    )
    for (const plan of subPlanned) {
      delete subNested[plan.alias]
      subDirect = subDirect.filter((f) => f !== plan.alias)
    }
    if (subPlanned.length > 0 && subDirect.length === 0) subDirect = ['id']
    // The relation name is a field of the related collection: a read policy
    // whose field list leaves it out reads none of its rows.
    const subToMany = subPlanned.filter((p) => aliasReadable(p.alias, relAllowedFields))

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
    selectCols = await systemProjection(relCollection, selectCols, relAllowedFields)

    // Batch fetch — cap at 1000 unique FKs
    const batchValues = [...fkSet].slice(0, 1000)
    const relQ = db(relCollection)
      .select(selectCols as string[])
      .limit(1000)
    // A record pointing at a help-video recording never expands it.
    if (isFilesCollection(relCollection)) {
      await helpVideoFileColumnsReady()
      whereNotHelpVideoFile(relQ, `${relCollection}.id`)
    }

    // Workspace scope and row-level security
    await applyWorkspaceScope(relQ, relCollection, workspaceId)
    if (rowFilter) applyRowFilter(relQ, rowFilter, user)

    // #2444 — a list page's flat expansion (display labels): the statement without its id
    // list keys the row cache, so only ids not seen within the last seconds are read. Rows
    // still pass decryption below for this caller.
    const flat =
      listRead &&
      Object.keys(subNested).length === 0 &&
      !subState.wantsState &&
      !subInstance.instance &&
      subToMany.length === 0
    let relItems: Record<string, unknown>[]
    // A gate that reads another table (a sub-select) is never cached: its writes bust nothing.
    const sig = flat ? relQ.toSQL() : null
    if (sig && gateIsSelfContained(sig.sql)) {
      const signature = statementHash(sig.sql, sig.bindings ?? [])
      const epoch = readEpoch(relCollection)
      const cached = getCachedRows(relCollection, signature, batchValues)
      const fetched = cached.missing.length
        ? ((await relQ.clone().whereIn('id', cached.missing)) as Record<string, unknown>[])
        : []
      putCachedRows(relCollection, signature, cached.missing, fetched, epoch)
      relItems = [...cached.hits.values()].filter((r): r is Record<string, unknown> => r != null)
      relItems.push(...fetched)
    } else {
      relItems = (await relQ.clone().whereIn('id', batchValues)) as Record<string, unknown>[]
    }

    // Decrypt encrypted fields on expanded items
    relItems = await Promise.all(relItems.map((r) => decryptItemFields(relCollection, r)))

    if (subState.wantsState) await attachRecordState(relCollection, relItems)
    if (subInstance.instance)
      await attachRecordInstance(relCollection, relItems, user, subInstance.instance)

    // Recurse for deeper expansion
    if (Object.keys(subNested).length > 0) {
      await expandRelations(user, relItems, relCollection, subNested, depth + 1, workspaceId)
    }
    if (subToMany.length > 0) {
      await expandToMany(user, relItems, subToMany, workspaceId, toManyDepth.getStore() ?? 0)
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
    // The FK column is on this collection, so this is M2O from here — a
    // junction's own legs included (their junction_field marks the pairing).
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
 * (e.g. `{years[0] % 100}`) may now render a different prefix — the row
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

// ─── Calculated fields that compile to SQL ──────────────────────────────────
// A read-computed field made of arithmetic / coalesce over the record's own
// columns can be filtered and sorted in the database (services/virtual-sql.ts).
// The compiled expressions are cached per collection; the synchronous filter
// builders read the cache, so every async entry point primes it first.
export async function primeVirtualSql(collection: string): Promise<Map<string, VirtualSql>> {
  const hit = cachedVirtualSql(collection)
  if (hit) return hit
  const fields = new Map<string, VirtualSql>()
  try {
    const computed = (await getComputedFields(collection)).filter(
      (f) =>
        f.computed_type === 'read' &&
        f.computed_formula &&
        !(f.computed_store === true || f.computed_store === 1)
    )
    if (computed.length > 0) {
      const physical = await getActualColumns(collection)
      for (const f of computed) {
        if (physical.has(f.field)) continue
        const compiled = compileFormulaToSql(String(f.computed_formula), collection, physical)
        if (compiled) fields.set(f.field, compiled)
      }
    }
    // Virtual rollups that translate into a correlated subquery (see
    // compileRollupToSql) filter and sort too.
    const rollups = (await getComputedFields(collection)).filter(
      (f) =>
        f.computed_type === 'rollup' &&
        f.computed_formula &&
        !(f.computed_store === true || f.computed_store === 1)
    )
    if (rollups.length > 0) {
      const physical = await getActualColumns(collection)
      const colsCache = new Map<string, Set<string>>()
      const relsCache = new Map<string, Awaited<ReturnType<typeof getRelations>>>()
      const configs = rollups
        .filter((f) => !physical.has(f.field))
        .map((f) => ({ f, cfg: parseRollupFormula(String(f.computed_formula)) }))
      for (const { cfg } of configs) {
        for (const src of cfg?.sources ?? []) {
          const c = src.related_collection
          if (!colsCache.has(c))
            colsCache.set(c, await getActualColumns(c).catch(() => new Set<string>()))
          if (!relsCache.has(c)) relsCache.set(c, await getRelations(c).catch(() => []))
        }
      }
      // Link targets of the related rows, and those targets' columns.
      for (const [c, rels] of relsCache) {
        for (const r of rels as Array<{ many_collection: string; one_collection: string | null }>) {
          if (r.many_collection === c && r.one_collection && !colsCache.has(r.one_collection))
            colsCache.set(
              r.one_collection,
              await getActualColumns(r.one_collection).catch(() => new Set<string>())
            )
        }
      }
      for (const { f, cfg } of configs) {
        if (!cfg) continue
        const compiled = compileRollupToSql(cfg, collection, {
          columnsOf: (c) => colsCache.get(c),
          linkTarget: (c, field) => {
            const r = (
              (relsCache.get(c) ?? []) as Array<{
                many_collection: string
                many_field: string
                one_collection: string | null
              }>
            ).find((x) => x.many_collection === c && x.many_field === field)
            return r?.one_collection ?? null
          }
        })
        if (compiled) fields.set(f.field, compiled)
      }
    }
  } catch {
    // no calculated fields known — plain columns only
  }
  storeVirtualSql(collection, fields)
  return fields
}

/** The names of a collection's calculated fields that filter and sort in SQL. */
export async function sqlFilterableVirtualFields(
  collection: string
): Promise<Array<{ field: string; kind: 'number' | 'value' }>> {
  const fields = await primeVirtualSql(collection)
  return [...fields.entries()].map(([field, v]) => ({ field, kind: v.kind }))
}

/** Column reference for a filter or sort: the compiled expression when the
 *  name is a calculated field of `collection`, the column otherwise. */
function columnRef(collection: string | null, key: string): Knex.Raw {
  if (collection) {
    const bare = key.startsWith(`${collection}.`) ? key.slice(collection.length + 1) : key
    const v = peekVirtualSql(collection)?.get(bare)
    if (v) return db.raw(`(${v.sql})`, v.bindings)
  }
  return db.raw('??', [key])
}

function applyOneFilterOp(
  q: QB,
  key: string,
  op: string,
  val: unknown,
  collection: string | null = null
) {
  const ref = columnRef(collection, key)
  switch (op) {
    case '_eq':
      q.where(ref, '=', val as Knex.Value)
      break
    case '_neq':
      q.where(ref, '!=', val as Knex.Value)
      break
    case '_gt':
      q.where(ref, '>', val as Knex.Value)
      break
    case '_gte':
      q.where(ref, '>=', val as Knex.Value)
      break
    case '_lt':
      q.where(ref, '<', val as Knex.Value)
      break
    case '_lte':
      q.where(ref, '<=', val as Knex.Value)
      break
    case '_in':
      q.whereIn(ref as unknown as string, val as Knex.Value[])
      break
    case '_nin':
      q.whereNotIn(ref as unknown as string, val as Knex.Value[])
      break
    case '_null':
      q.whereNull(ref as unknown as string)
      break
    case '_nnull':
      q.whereNotNull(ref as unknown as string)
      break
    // The value is text to find, never a pattern (lib/filter-like.ts).
    case '_contains':
      q.where(ref, 'like', likeContains(val))
      break
    case '_ncontains':
      q.where(ref, 'not like', likeContains(val))
      break
    case '_starts_with':
      q.where(ref, 'like', likeStartsWith(val))
      break
    case '_ends_with':
      q.where(ref, 'like', likeEndsWith(val))
      break
    case '_icontains':
      q.where(ref, 'like', likeContains(val))
      break
    case '_nstarts_with':
      q.where(ref, 'not like', likeStartsWith(val))
      break
    case '_nends_with':
      q.where(ref, 'not like', likeEndsWith(val))
      break
    case '_empty':
      q.where((w) => w.whereNull(ref as unknown as string).orWhere(ref, '=', ''))
      break
    case '_nempty':
      q.where((w) => w.whereNotNull(ref as unknown as string).where(ref, '!=', ''))
      break
    case '_between': {
      const [lo, hi] = Array.isArray(val) ? val : []
      q.where(ref, '>=', lo as Knex.Value).where(ref, '<=', hi as Knex.Value)
      break
    }
    case '_nbetween': {
      const [lo, hi] = Array.isArray(val) ? val : []
      q.where((w) => w.where(ref, '<', lo as Knex.Value).orWhere(ref, '>', hi as Knex.Value))
      break
    }
  }
}

/** Every operator applyOneFilterOp compiles. */
const FILTER_OPS = new Set([
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_in',
  '_nin',
  '_null',
  '_nnull',
  '_contains',
  '_ncontains',
  '_icontains',
  '_starts_with',
  '_nstarts_with',
  '_ends_with',
  '_nends_with',
  '_empty',
  '_nempty',
  '_between',
  '_nbetween'
])

function filterRefusal(code: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { statusCode: 400, code, ...extra })
}

function assertOps(
  ops: Record<string, unknown>,
  collection: string,
  key: string,
  path: string[]
): void {
  const at = [...path, key].join('.')
  for (const [op, val] of Object.entries(ops)) {
    if (!op.startsWith('_')) {
      throw filterRefusal(
        'FILTER_PATH_UNSUPPORTED',
        `"${key}" on ${collection} does not link to another record, so "${at}.${op}" cannot be filtered`,
        { path: [...path, key, op], collection }
      )
    }
    if (!FILTER_OPS.has(op)) {
      throw filterRefusal(
        'FILTER_OPERATOR_UNKNOWN',
        `"${op}" is not a filter operator (at "${at}")`,
        { path: [...path, key], operator: op }
      )
    }
    if ((op === '_in' || op === '_nin') && !Array.isArray(val)) {
      throw filterRefusal('FILTER_VALUE_INVALID', `"${op}" takes a list (at "${at}")`, {
        path: [...path, key],
        operator: op
      })
    }
    if ((op === '_between' || op === '_nbetween') && !(Array.isArray(val) && val.length === 2)) {
      throw filterRefusal('FILTER_VALUE_INVALID', `"${op}" takes two values (at "${at}")`, {
        path: [...path, key],
        operator: op
      })
    }
  }
}

const FILTER_DEPTH = 8

/** An M2O value made only of comparison operators (`{_eq: 5}`) compares the FK
 *  column. `_and`/`_or` filter the RELATED record (`{_or: [{state: …}, …]}`),
 *  so their presence makes it a nested filter. */
function isOperatorOnly(nested: Record<string, unknown>): boolean {
  return Object.keys(nested).every((k) => k.startsWith('_') && k !== '_and' && k !== '_or')
}

/**
 * Walk a filter the way applyFilters will and refuse what it cannot compile:
 * a nested key under a field that links to nothing, an operator that does not
 * exist, a field the collection does not have. Before this, each of those was
 * dropped without a word and the read answered MORE rows than asked for.
 *
 * It loads the relations of every collection the filter reaches on the way,
 * so the synchronous compiler finds them whatever the nesting.
 */
async function assertFilterCompiles(
  filter: Record<string, unknown>,
  collection: string,
  rels: CMSRelation[],
  path: string[] = []
): Promise<void> {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return
  if (path.length > FILTER_DEPTH) {
    throw filterRefusal('FILTER_TOO_DEEP', `A filter may nest ${FILTER_DEPTH} levels at most`, {
      path
    })
  }
  const relsOf = async (c: string) => {
    const hit = relCache.get(c)
    if (hit) return hit
    const loaded = await getRelations(c)
    relCache.set(c, loaded)
    return loaded
  }
  for (const [key, value] of Object.entries(filter)) {
    if (
      key === STATE_FIELD ||
      key === INTEGRATIONS_FIELD ||
      key === ORIGIN_FIELD ||
      key === ADDENDUMS_FIELD ||
      key === AT_RISK_FIELD ||
      key === '_exists_junction'
    )
      continue
    if (key === '_and' || key === '_or') {
      if (!Array.isArray(value)) {
        throw filterRefusal('FILTER_VALUE_INVALID', `"${key}" takes a list of filters`, { path })
      }
      for (const clause of value)
        await assertFilterCompiles(clause as Record<string, unknown>, collection, rels, path)
      continue
    }
    const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)

    const m2o = findM2ORelation(key, collection, rels)
    if (m2o && isObject) {
      const nested = value as Record<string, unknown>
      if (isOperatorOnly(nested)) {
        assertOps(nested, collection, key, path)
        await fitFilterValues(nested, collection, m2o.fkField, path)
      } else {
        const target = m2o.rel.one_collection as string
        await primeVirtualSql(target)
        await assertFilterCompiles(nested, target, await relsOf(target), [...path, key])
      }
      continue
    }

    const o2m = findO2MRelation(key, collection, rels)
    if (o2m && isObject) {
      const nested = implicitSome(value as Record<string, unknown>)
      const inner = (nested._some ?? nested._none) as Record<string, unknown> | undefined
      if (inner === undefined) assertOps(nested, collection, key, path)
      else if (inner && typeof inner === 'object') {
        await primeVirtualSql(o2m.many_collection)
        await assertFilterCompiles(inner, o2m.many_collection, await relsOf(o2m.many_collection), [
          ...path,
          key
        ])
      }
      continue
    }

    const m2m = findM2MRelation(key, collection, rels)
    if (m2m && isObject) {
      const nested = implicitSome(value as Record<string, unknown>)
      const inner = (nested._some ?? nested._none) as Record<string, unknown> | undefined
      if (inner === undefined) {
        assertOps(nested, collection, key, path)
      } else if (inner && typeof inner === 'object') {
        const otherRels = await relsOf(m2m.otherCollection)
        const { _link: link, ...rawTarget } = inner
        const legIsOwnField = otherRels.some(
          (r) => r.many_collection === m2m.otherCollection && r.many_field === m2m.fkToOther
        )
        const target = legIsOwnField ? rawTarget : unwrapJunctionLeg(rawTarget, m2m.fkToOther)
        await primeVirtualSql(m2m.otherCollection)
        await assertFilterCompiles(target, m2m.otherCollection, otherRels, [...path, key])
        if (link && typeof link === 'object') {
          await assertFilterCompiles(
            link as Record<string, unknown>,
            m2m.junction,
            await relsOf(m2m.junction),
            [...path, key, '_link']
          )
        }
      }
      continue
    }

    // A plain field.
    if (key.startsWith('_')) {
      throw filterRefusal(
        'FILTER_OPERATOR_UNKNOWN',
        `"${key}" is not a filter operator${path.length ? ` (at "${path.join('.')}")` : ''}`,
        { path, operator: key }
      )
    }
    if (isObject) assertOps(value as Record<string, unknown>, collection, key, path)
    if (isObject && IDENT_RE.test(key)) {
      await fitFilterValues(value as Record<string, unknown>, collection, key, path)
    }
    if (IDENT_RE.test(key)) {
      const cols = await getActualColumns(collection)
      if (cols.size > 0) {
        const has = (set: Set<string>) =>
          [...set].some((c) => c.toLowerCase() === key.toLowerCase())
        const virtual = peekVirtualSql(collection)?.has(key) ?? false
        if (!virtual && !has(cols)) {
          forgetActualColumns(collection)
          if (!has(await getActualColumns(collection))) {
            throw filterRefusal(
              'UNKNOWN_FIELD',
              `${collection} has no field "${key}"${path.length ? ` (at "${[...path, key].join('.')}")` : ''}`,
              { fields: [key], path: [...path, key], collection }
            )
          }
        }
      }
    }
  }
}

/**
 * Apply a nested filter object onto query builder `q`.
 * Handles _and/_or logical combinators, M2O/O2M/M2M relation traversal, and scalar operators.
 * `collection` is the table `q` is currently querying.
 * `rels` are the relations for `collection` (pre-loaded by the caller).
 */
/** Directus shape: a to-many alias filtered by the related collection's own
 *  fields (`purchase_orders: {number: {_in: [...]}}`) means "at least one
 *  related row matches" — the same as `_some`. Operator-only objects
 *  (`{_null: true}`) and explicit `_some`/`_none` pass through untouched. */
function implicitSome(nested: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(nested)
  if (keys.length === 0) return nested
  if ('_some' in nested || '_none' in nested) return nested
  // `_link` filters the junction row of a link, so it names a link too.
  if (keys.every((k) => k.startsWith('_') && k !== '_and' && k !== '_or' && k !== '_link'))
    return nested
  return { _some: nested }
}

/** The legacy API filtered a to-many alias through its JUNCTION row:
 *  `purchase_orders: {purchase_order: {number: {_in: [...]}}}`, where
 *  `purchase_order` is the junction's FK to the related record. That key names
 *  the related record itself, so its contents fold into the target filter; an
 *  operator-only value (`{_eq: 5}`) compares the related record's id. */
function unwrapJunctionLeg(
  filter: Record<string, unknown>,
  fkToOther: string
): Record<string, unknown> {
  const leg = filter[fkToOther]
  if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return filter
  const { [fkToOther]: _drop, ...rest } = filter
  const legObj = leg as Record<string, unknown>
  const keys = Object.keys(legObj)
  const opsOnly =
    keys.length > 0 && keys.every((k) => k.startsWith('_') && k !== '_and' && k !== '_or')
  const folded = opsOnly ? { id: legObj } : legObj
  return Object.keys(rest).length === 0 ? folded : { _and: [rest, folded] }
}

/** Compile a Directus-style filter onto an existing knex query for
 *  `collection` — the same compiler readItems uses, for callers that build
 *  their own base query (the GraphQL nested-list resolvers). */
export async function applyFilterToQuery(
  q: QB,
  filter: Record<string, unknown>,
  collection: string
): Promise<void> {
  const rels = await getRelsForCollection(collection)
  await primeRelCacheForFilter(filter, collection, rels)
  await primeVirtualSql(collection)
  await primeVirtualFilters(filter)
  const fitted = cloneFilterTree(filter)
  await assertFilterCompiles(fitted, collection, rels)
  applyFilters(q, fitted, collection, rels)
}

function applyFilters(
  q: QB,
  filter: Record<string, unknown>,
  collection: string,
  rels: CMSRelation[]
): void {
  for (const [key, value] of Object.entries(filter)) {
    // ── Pipeline state ───────────────────────────────────────────────────────
    // filter={"$state":{"_in":["started"]}} — the same EXISTS the conditions
    // path compiles, so a reader never needs a mirrored state column. The key
    // alone claims the branch: every other value shape (a bare string, an
    // array, null) is this filter too, and letting one fall through would hand
    // `$state` to the column machinery as an "Invalid column name" 500.
    if (key === STATE_FIELD) {
      applyStateFilter(q, collection, value)
      continue
    }

    // ── Integration obligations ──────────────────────────────────────────────
    // filter={"$integrations":"danger"} — same EXISTS shape as $state, mirrored
    // into the conditions path below so a caller cannot tell which surface it
    // used. See applyIntegrationsFilter.
    if (key === INTEGRATIONS_FIELD) {
      applyIntegrationsFilter(q, collection, value)
      continue
    }

    // ── Who wrote to it, addendums in flight, highlight rules ────────────────
    // filter={"$origin":{"_in":["integration"],"days":7}} and friends — the
    // same compilers the conditions path uses (services/virtual-filters.ts).
    if (key === ORIGIN_FIELD) {
      applyOriginFilter(q, collection, parseOriginFilter(value))
      continue
    }
    if (key === ADDENDUMS_FIELD) {
      applyAddendumsFilter(q, collection, value)
      continue
    }
    if (key === AT_RISK_FIELD) {
      applyRiskFilter(q, collection, value)
      continue
    }

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

      // Only operator keys → filter on the FK column itself
      if (isOperatorOnly(nestedFilter)) {
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
      const nestedFilter = implicitSome(value as Record<string, unknown>)
      const manyCollection = o2mMatch.many_collection
      const manyField = o2mMatch.many_field

      const hasSome = '_some' in nestedFilter
      const hasNone = '_none' in nestedFilter

      // Bare operator object on the alias ({projects: {_eq: 7581}}) compares
      // against CHILD row ids — the same semantics the conditions param's
      // bare-alias leaf already has. This shape used to be silently DROPPED
      // (the project → project-type cascade "list never narrows" bug).
      const o2mKeys = Object.keys(nestedFilter)
      if (!hasSome && !hasNone && o2mKeys.length > 0 && o2mKeys.every((k) => k.startsWith('_'))) {
        for (const [op, val] of Object.entries(nestedFilter)) {
          const childMatch = (idOp: string | null, idVal: unknown) =>
            function (this: QB) {
              this.select(db.raw('1'))
                .from(manyCollection)
                .whereRaw('??.?? = ??.??', [manyCollection, manyField, collection, 'id'])
              if (idOp) applyOneFilterOp(this, `${manyCollection}.id`, idOp, idVal)
            }
          if (op === '_null') {
            if (val) q.whereNotExists(childMatch(null, null))
            else q.whereExists(childMatch(null, null))
          } else if (op === '_nnull') {
            if (val) q.whereExists(childMatch(null, null))
            else q.whereNotExists(childMatch(null, null))
          } else if (op === '_neq' || op === '_nin') {
            q.whereNotExists(childMatch(op === '_neq' ? '_eq' : '_in', val))
          } else {
            q.whereExists(childMatch(op, val))
          }
        }
        continue
      }

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
      const nestedFilter = implicitSome(value as Record<string, unknown>)
      const { junction, fkToParent, fkToOther, otherCollection } = m2mMatch

      const hasSome = '_some' in nestedFilter
      const hasNone = '_none' in nestedFilter

      // Bare operator object on an M2M alias ({regions: {_eq: 9}}) compares
      // the junction's related-id column — same rationale as the O2M branch.
      const m2mKeys = Object.keys(nestedFilter)
      if (!hasSome && !hasNone && m2mKeys.length > 0 && m2mKeys.every((k) => k.startsWith('_'))) {
        for (const [op, val] of Object.entries(nestedFilter)) {
          const linkMatch = (idOp: string | null, idVal: unknown) =>
            function (this: QB) {
              this.select(db.raw('1'))
                .from(junction)
                .whereRaw('??.?? = ??.??', [junction, fkToParent, collection, 'id'])
              if (idOp) applyOneFilterOp(this, `${junction}.${fkToOther}`, idOp, idVal)
            }
          if (op === '_null') {
            if (val) q.whereNotExists(linkMatch(null, null))
            else q.whereExists(linkMatch(null, null))
          } else if (op === '_nnull') {
            if (val) q.whereExists(linkMatch(null, null))
            else q.whereNotExists(linkMatch(null, null))
          } else if (op === '_neq' || op === '_nin') {
            q.whereNotExists(linkMatch(op === '_neq' ? '_eq' : '_in', val))
          } else {
            q.whereExists(linkMatch(op, val))
          }
        }
        continue
      }

      if (hasSome || hasNone) {
        const innerFilter = (nestedFilter['_some'] ?? nestedFilter['_none']) as Record<
          string,
          unknown
        >
        const otherRels = relCache.get(otherCollection) ?? []
        // `_link` filters the JUNCTION row itself (a membership that carries
        // its own columns — a scope, a role, a date); every other key filters
        // the related record. Both must hold on the SAME link.
        const { _link: linkFilter, ...rawTargetFilter } = innerFilter as Record<string, unknown> & {
          _link?: unknown
        }
        // A related collection that has its OWN relation of that name keeps it.
        const legIsOwnField = otherRels.some(
          (r) => r.many_collection === otherCollection && r.many_field === fkToOther
        )
        const targetFilter = legIsOwnField
          ? rawTargetFilter
          : unwrapJunctionLeg(rawTargetFilter, fkToOther)
        const junctionRels = relCache.get(junction) ?? []

        const subFn = function (this: QB) {
          this.select(db.raw('1'))
            .from(junction)
            .whereRaw('??.?? = ??.??', [junction, fkToParent, collection, 'id'])
            .whereExists(function (this: QB) {
              this.select(db.raw('1'))
                .from(otherCollection)
                .whereRaw('??.?? = ??.??', [otherCollection, 'id', junction, fkToOther])
              applyFilters(this, targetFilter, otherCollection, otherRels)
            })
          if (linkFilter && typeof linkFilter === 'object')
            applyFilters(this, linkFilter as Record<string, unknown>, junction, junctionRels)
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
      const {
        table,
        self_fk,
        filter_fk,
        value: filterValue
      } = value as {
        table: string
        self_fk: string
        filter_fk: string
        value: unknown
      }
      // Security: validate table/self_fk/filter_fk against the loaded relation
      // metadata for this collection. Accepts only identifiers that correspond to
      // a real M2M junction row in nivaro_relations — prevents table/column injection.
      const isValidJunction = rels.some(
        (r) =>
          r.many_collection === table && r.many_field === self_fk && r.junction_field === filter_fk
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
        applyOneFilterOp(q, key, op, val, collection)
      }
    } else {
      q.where(columnRef(collection, key), '=', value as Knex.Value)
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
      // Simple scalar sort — a calculated field orders by its expression
      const virtual = (await primeVirtualSql(collection)).get(path)
      if (virtual) q.orderByRaw(`(${virtual.sql}) ${direction}`, virtual.bindings)
      else q.orderBy(path, direction)
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

function applyOneFilter(
  q: QB,
  field: string,
  op: string,
  value: unknown,
  collection: string | null = null
): QB {
  const ref = columnRef(collection, field)
  switch (op) {
    case '_eq':
      return q.where(ref, '=', value as Knex.Value)
    case '_neq':
      return q.where(ref, '!=', value as Knex.Value)
    case '_gt':
      return q.where(ref, '>', value as Knex.Value)
    case '_gte':
      return q.where(ref, '>=', value as Knex.Value)
    case '_lt':
      return q.where(ref, '<', value as Knex.Value)
    case '_lte':
      return q.where(ref, '<=', value as Knex.Value)
    case '_contains':
      return q.where(ref, 'like', likeContains(value))
    case '_ncontains':
      return q.where(ref, 'not like', likeContains(value))
    case '_starts_with':
      return q.where(ref, 'like', likeStartsWith(value))
    case '_ends_with':
      return q.where(ref, 'like', likeEndsWith(value))
    case '_in':
      return q.whereIn(ref as unknown as string, value as Knex.Value[])
    case '_nin':
      return q.whereNotIn(ref as unknown as string, value as Knex.Value[])
    case '_null':
      return q.whereNull(ref as unknown as string)
    case '_nnull':
      return q.whereNotNull(ref as unknown as string)
    default:
      return q
  }
}

export type FilterCondition = { path: string[]; op: string; value: unknown }

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

/**
 * Writes answer to the same User Scopes reads do: an update or delete of a
 * record outside the caller's scope (another Zone) is a not-found, never a
 * silent success. `restricts` false = no restriction for this person (admins,
 * unscoped people), so the gate costs no query.
 */
async function writeScopeFor(
  user: User,
  collection: string
): Promise<{ restricts: boolean; apply: (q: QB) => void }> {
  const enforcement = await getUserScopeEnforcement(user, collection)
  return {
    restricts: enforcement.deny || enforcement.filters.length > 0,
    apply: (q) => applyScopeEnforcement(q, collection, enforcement)
  }
}

/**
 * Before any hook runs: the record must exist inside the caller's workspace,
 * row filter and User Scopes, or the write is a 404. Only queries when one of
 * them restricts this person.
 */
async function assertWritableRow(
  collection: string,
  id: string | number,
  user: User,
  scope: { restricts: boolean; apply: (q: QB) => void },
  rowFilter: Awaited<ReturnType<typeof getRowFilter>>,
  workspaceId?: string
): Promise<void> {
  const wsScoped = !!workspaceId && (await workspaceColumnExists(collection))
  if (!scope.restricts && !rowFilter && !wsScoped) return
  const q = db(collection).where({ id }).select('id')
  await applyWorkspaceScope(q, collection, workspaceId)
  if (rowFilter) applyRowFilter(q, rowFilter, user)
  scope.apply(q)
  if (!(await q.first())) throw new ItemNotFoundError()
}

export async function planConditionPath(collection: string, path: string[]): Promise<PathPlan> {
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
        hops.push({
          kind: 'alias',
          from: current,
          child: alias.many_collection,
          childFk: alias.many_field
        })
        return { hops, leafTable: alias.many_collection, leafCol: alias.junction_field ?? 'id' }
      }
      await primeVirtualSql(current)
      return { hops, leafTable: current, leafCol: seg }
    }
    if (m2o?.one_collection) {
      hops.push({ kind: 'm2o', from: current, fk: seg, to: m2o.one_collection })
      current = m2o.one_collection
      segs = segs.slice(1)
    } else if (alias?.many_collection) {
      hops.push({
        kind: 'alias',
        from: current,
        child: alias.many_collection,
        childFk: alias.many_field
      })
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
        value,
        plan.leafTable
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

export type OrCondition = { or: FilterCondition[] }

/**
 * A calculated field that does NOT compile to SQL cannot narrow or order a
 * list. Naming one used to reach the database as a column and come back as a
 * 500; the caller is told which field and why instead.
 */
async function assertFilterableFields(
  collection: string,
  filter: Record<string, unknown>,
  sort: string[],
  conditions: Array<FilterCondition | OrCondition> | undefined,
  rels: CMSRelation[]
): Promise<void> {
  const named = new Set<string>()
  const walk = (f: unknown) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if ((k === '_and' || k === '_or') && Array.isArray(v)) for (const c of v) walk(c)
      else if (!k.startsWith('_') && !k.startsWith('$')) named.add(k)
    }
  }
  walk(filter)
  for (const s of sort) {
    const path = s.startsWith('-') ? s.slice(1) : s
    if (!path.includes('.')) named.add(path)
  }
  for (const c of conditions ?? []) {
    const list = 'or' in c ? c.or : [c]
    for (const one of list) {
      // `$state`, `$aging`, `$at_risk`… are virtual paths with their own compilers.
      if (one?.path?.length === 1 && !String(one.path[0]).startsWith('$'))
        named.add(String(one.path[0]))
    }
  }
  if (named.size === 0) return
  await assertNamedFieldsExist(collection, named, rels)
  const computed = (await getComputedFields(collection)).filter(
    (f) =>
      named.has(f.field) &&
      (f.computed_type === 'read' || f.computed_type === 'rollup') &&
      !(f.computed_store === true || f.computed_store === 1)
  )
  if (computed.length === 0) return
  const [physical, compiled] = await Promise.all([
    getActualColumns(collection),
    primeVirtualSql(collection)
  ])
  const blocked = computed.filter((f) => !physical.has(f.field) && !compiled.has(f.field))
  if (blocked.length === 0) return
  const names = blocked.map((f) => `"${f.field}"`).join(', ')
  throw Object.assign(
    new Error(
      `${names} ${blocked.length === 1 ? 'is' : 'are'} calculated when the record is read and cannot be filtered or sorted`
    ),
    { statusCode: 400, code: 'FIELD_NOT_FILTERABLE', fields: blocked.map((f) => f.field) }
  )
}

/**
 * A filter, sort or condition naming a field the collection does not have
 * (a saved link that outlived a rename: `ctx=[{"path":["nope"]…}]`) reached
 * the database and came back as a 500 "Invalid column name 'nope'", which a
 * list showed as an empty result. It is a 400 naming the field instead.
 * Anything the compilers resolve without a column — a relation alias, a
 * registered field, a calculated field, a `collection.column` name — passes.
 */
async function assertNamedFieldsExist(
  collection: string,
  named: Set<string>,
  rels: CMSRelation[]
): Promise<void> {
  const lookup = async () =>
    new Set([...(await getActualColumns(collection))].map((c) => c.toLowerCase()))
  let cols = await lookup()
  // No columns at all: not a table this check can judge (a view-backed collection).
  if (cols.size === 0) return
  const candidates = [...named]
    .map((n) => (n.startsWith(`${collection}.`) ? n.slice(collection.length + 1) : n))
    .filter(
      (n) =>
        !n.includes('.') &&
        !n.startsWith('$') &&
        !findM2ORelation(n, collection, rels) &&
        !findO2MRelation(n, collection, rels) &&
        !findM2MRelation(n, collection, rels)
    )
  const missing = () => candidates.filter((n) => !cols.has(n.toLowerCase()))
  if (missing().length === 0) return
  const [fields, virtual] = await Promise.all([
    getFields(collection).catch(() => [] as CMSField[]),
    primeVirtualSql(collection)
  ])
  const registered = new Set(fields.map((f) => f.field.toLowerCase()))
  const unresolved = () =>
    missing().filter((n) => !registered.has(n.toLowerCase()) && !virtual.has(n))
  if (unresolved().length === 0) return
  // Looked up once more before refusing: a column added since the cache filled.
  forgetActualColumns(collection)
  cols = await lookup()
  const unknown = unresolved()
  if (unknown.length === 0) return
  const names = unknown.map((f) => `"${f}"`).join(', ')
  throw Object.assign(
    new Error(
      `This list's filter or sort names ${unknown.length === 1 ? 'a field' : 'fields'} ${collection} does not have: ${names}`
    ),
    { statusCode: 400, code: 'UNKNOWN_FIELD', fields: unknown }
  )
}

/** Active at-risk rules named by a `$at_risk` condition value (id / ids / 'any'). */
async function loadRiskRules(collection: string, value: unknown) {
  const raw = Array.isArray(value) ? value : [value]
  const wantAll = raw.some((v) => v === 'any' || v === '*')
  const ids = raw.map((v) => Number(v)).filter((n) => Number.isFinite(n))
  const { parseActiveRules } = await import('../routes/at-risk.js')
  const ruleRows = (await db('nivaro_at_risk_rules')
    .where({ collection, is_active: true })
    .modify((b) => {
      if (!wantAll) void b.whereIn('id', ids.length ? ids : [-1])
    })
    .orderBy('id')) as Parameters<typeof parseActiveRules>[0]
  return parseActiveRules(ruleRows)
}

/** Sync WHERE for pre-loaded rules: OR across rules, AND inside each; none = match nothing. */
function applyRiskRules(
  q: QB,
  collection: string,
  rules: Awaited<ReturnType<typeof loadRiskRules>>,
  applyRule: typeof import('../routes/at-risk.js')['applyRuleConditions']
) {
  if (rules.length === 0) {
    q.whereRaw('1 = 0')
    return
  }
  for (const rule of rules) {
    q.orWhere(function (this: QB) {
      if (!applyRule(this as never, collection, rule.conditions)) this.whereRaw('1 = 0')
    })
  }
}

/**
 * filter={"$integrations": "danger"} / conditions path $integrations — how
 * far behind a record's integration partners are, aggregated across every
 * partner. Mirrors $addendums: an EXISTS/NOT EXISTS subquery over
 * `nivaro_integration_obligations` keyed on (collection, item). Exported so
 * both `applyFilters` (the `filter=` surface) and `applyConditions` (the
 * collection browser's `conditions[]` surface) compile it identically — one
 * implementation, both callers, the same precedent as `applyStateFilter`.
 *
 * A 'superseded' row was replaced by a newer one and never counts, in every
 * bucket including 'none' — a record whose only rows are superseded reads
 * the same as a record with no ledger rows at all.
 *
 *   'danger'   — a partner is overdue, failed, or never got word at all
 *   'warning'  — a partner is still pending, or was deliberately skipped
 *   'positive' — every non-superseded row for this record is a clean send
 *   'none'     — no integration has ever opened an obligation for it
 *
 * An unrecognised value narrows to nothing rather than widening — the
 * `applyStateFilter` rule: a filter that fails to read must never silently
 * answer with every row in the collection.
 */
export function applyIntegrationsFilter(q: QB, collection: string, rawValue: unknown): void {
  const want = String(Array.isArray(rawValue) ? rawValue[0] : (rawValue ?? ''))
  const outcomesByBucket: Record<string, string[]> = {
    danger: ['overdue', 'failed', 'missing'],
    warning: ['pending', 'skipped'],
    positive: ['sent']
  }
  if (want !== 'none' && !outcomesByBucket[want]) {
    q.whereRaw('1 = 0')
    return
  }
  const exists = function (this: QB) {
    this.select(db.raw('1'))
      .from('nivaro_integration_obligations as io')
      .where('io.collection', collection)
      .whereRaw('io.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
      .whereNot('io.outcome', 'superseded')
    if (want !== 'none') this.whereIn('io.outcome', outcomesByBucket[want])
  }
  if (want === 'none') q.whereNotExists(exists)
  else q.whereExists(exists)
}

export async function applyConditions(
  q: QB,
  conditions: Array<FilterCondition | OrCondition>,
  collection: string,
  /** The reader — only the `$unseen` path needs it (their own watermarks). */
  userId?: string | null
) {
  for (const cond of conditions) {
    // OR group: each branch is a normal path condition; the group ANDs with
    // the rest of the conditions.
    if ('or' in cond && Array.isArray(cond.or)) {
      type Branch =
        | { kind: 'path'; plan: NonNullable<PathPlan>; op: string; value: unknown }
        | { kind: 'risk'; rules: Awaited<ReturnType<typeof loadRiskRules>> }
      const branches: Branch[] = []
      for (const sub of cond.or) {
        if (!Array.isArray(sub.path) || sub.path.length === 0) continue
        // `$at_risk` is the one virtual path an OR group understands (the
        // highlight-rule pills OR their picks); other `$` paths are skipped.
        if (sub.path[0] === '$at_risk' && sub.path.length === 1) {
          branches.push({ kind: 'risk', rules: await loadRiskRules(collection, sub.value) })
          continue
        }
        if (sub.path[0].startsWith('$')) continue
        const plan = await planConditionPath(collection, sub.path)
        if (plan) branches.push({ kind: 'path', plan, op: sub.op, value: sub.value })
      }
      if (branches.length === 0) continue
      const { applyRuleConditions } = await import('../routes/at-risk.js')
      q.where(function () {
        for (const b of branches) {
          this.orWhere(function () {
            if (b.kind === 'risk')
              applyRiskRules(this as QB, collection, b.rules, applyRuleConditions)
            else applyPlannedCondition(this as QB, collection, b.plan, b.op, b.value)
          })
        }
      })
      continue
    }
    if (!('path' in cond) || !Array.isArray(cond.path) || cond.path.length === 0) continue
    // Virtual path: workflow/pipeline state by key — resolved against the
    // instance tables so state filters run server-side over the full set.
    if (cond.path[0] === '$state' && cond.path.length === 1) {
      // The SAME compiler `filter={"$state":…}` uses, handed this condition's
      // own operator: `_in`/`_eq` include, `_nin`/`_neq` exclude (NOT EXISTS,
      // which keeps a record running no pipeline at all — the SQL-natural
      // reading, and the one the filter surface already had). The op used to
      // be ignored here, so every $state condition compiled as an include and
      // exclude could not be expressed on this surface at all; a caller that
      // wanted "anything but completed" had to send the complement of the
      // state list and keep it in step with the template by hand.
      //
      // An operator neither surface knows narrows to nothing rather than
      // quietly widening — see applyStateFilter. That is deliberately unlike
      // applyOneFilter's unknown-op no-op: a plain column filter that fails to
      // narrow is a wrong list, a state filter that fails to narrow is every
      // record in the collection.
      applyStateFilter(q, collection, { [cond.op || '_in']: cond.value })
      continue
    }
    // Virtual path: hours in the current pipeline state — see applyAgingFilter.
    if (cond.path[0] === '$aging' && cond.path.length === 1) {
      applyAgingFilter(q, collection, cond.op, cond.value)
      continue
    }
    // Virtual path: addendum presence — 'active' = an addendum still in flight
    // (draft/submitted/review), 'none' = no active addendum, 'any' = ever had one.
    if (cond.path[0] === ADDENDUMS_FIELD && cond.path.length === 1) {
      applyAddendumsFilter(q, collection, cond.value)
      continue
    }
    // Virtual path: who wrote to the record — "touched by an integration
    // since Monday", "never edited by a person". See parseOriginFilter.
    if (cond.path[0] === ORIGIN_FIELD && cond.path.length === 1) {
      await primeOriginColumn()
      applyOriginFilter(q, collection, parseOriginFilter(cond.value, cond.op))
      continue
    }
    // Virtual path: integration obligations — see applyIntegrationsFilter.
    if (cond.path[0] === INTEGRATIONS_FIELD && cond.path.length === 1) {
      applyIntegrationsFilter(q, collection, cond.value)
      continue
    }
    // Virtual path: at-risk highlight rules — value = rule id (or an array of
    // ids, OR'd; 'any' = every active rule). The rule's conditions compile to
    // SQL through applyRuleConditions, so the same rule that TINTS a row can
    // FILTER the list ("on hold" pill). A rule that cannot compile (unknown
    // op) matches nothing rather than everything.
    if (cond.path[0] === '$at_risk' && cond.path.length === 1) {
      const rules = await loadRiskRules(collection, cond.value)
      const { applyRuleConditions } = await import('../routes/at-risk.js')
      q.where(function (this: QB) {
        applyRiskRules(this, collection, rules, applyRuleConditions)
      })
      continue
    }
    // Virtual path: changed since the reader last opened it (#643) — edited,
    // moved or commented on by someone else after their newest open. A record
    // the reader never opened never matches; without a reader nothing does.
    if (cond.path[0] === '$unseen' && cond.path.length === 1) {
      const wantUnseen = cond.value !== false && cond.value !== 'false' && cond.value !== 0
      if (!userId) {
        if (wantUnseen) q.whereRaw('1 = 0')
        continue
      }
      const { whereUnseen } = await import('./record-unseen.js')
      if (wantUnseen) whereUnseen(q as never, collection, collection, userId)
      else
        q.whereNot(function (this: QB) {
          whereUnseen(this as never, collection, collection, userId)
        })
      continue
    }
    // Content-presence virtual paths (#397/#398): $has_comments / $has_tasks /
    // $has_failed_push / $missing_required. Value truthiness picks the side —
    // {_eq: true} = has, {_eq: false} = does not have.
    if (cond.path.length === 1 && cond.path[0].startsWith('$has_')) {
      const wantHas = cond.value !== false && cond.value !== 'false' && cond.value !== 0
      const kind = cond.path[0]
      const exists = (cb: (this: QB) => void) =>
        wantHas ? q.whereExists(cb) : q.whereNotExists(cb)
      if (kind === '$has_comments') {
        exists(function () {
          this.select(db.raw('1'))
            .from('nivaro_comments as cmt')
            .where('cmt.collection', collection)
            .whereNull('cmt.deleted_at')
            .whereRaw('cmt.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
        })
        continue
      }
      if (kind === '$has_tasks') {
        exists(function () {
          this.select(db.raw('1'))
            .from('nivaro_tasks as tsk')
            .where('tsk.collection', collection)
            // Open tasks only (#1017): a record whose tasks are all done has
            // nothing left to do.
            .whereIn('tsk.status', ['open', 'in_progress'])
            .whereRaw('tsk.item = CAST(??.?? AS NVARCHAR(255))', [collection, 'id'])
          // 'overdue' narrows to a task past its due date.
          if (cond.value === 'overdue')
            this.whereRaw('CAST(tsk.due_date AS date) < CAST(GETUTCDATE() AS date)')
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
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(junction) ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parentFk)
        )
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

// ── To-many aliases in `fields=` ─────────────────────────────────────────────
// `fields=id,lines.amount,tags.name` — the related rows of each record on the
// page, read AS THE CALLER through readItems (permission, field list, row
// filter and user scopes of the related collection all apply). One read per
// alias per page, never per record.
const TO_MANY_PER_PARENT = Math.max(1, Number(process.env.TO_MANY_PER_PARENT) || 200)
const TO_MANY_TOTAL = 5000
const TO_MANY_DEPTH = 2

type ToManyPlan =
  | { kind: 'o2m'; alias: string; child: string; fk: string; fields: string[] }
  | {
      kind: 'm2m'
      alias: string
      junction: string
      fkToParent: string
      fkToOther: string
      other: string
      fields: string[]
    }
  | {
      kind: 'm2a'
      alias: string
      junction: string
      fkToParent: string
      itemField: string
      discriminator: string
      allowed: string[]
      fields: string[]
    }

async function planToMany(
  collection: string,
  rels: CMSRelation[],
  nested: Record<string, string[]>
): Promise<ToManyPlan[]> {
  const plans: ToManyPlan[] = []
  for (const [alias, fields] of Object.entries(nested)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) continue
    const o2m =
      findO2MRelation(alias, collection, rels) ??
      // The child-table-name form of an alias (`workflow_line_items`).
      rels.find(
        (r) =>
          r.one_collection === collection &&
          r.junction_field == null &&
          r.many_collection === alias &&
          r.one_field != null
      ) ??
      null
    if (o2m?.many_collection && o2m.many_field) {
      plans.push({ kind: 'o2m', alias, child: o2m.many_collection, fk: o2m.many_field, fields })
      continue
    }
    const leg = rels.find(
      (r) =>
        r.one_collection === collection &&
        r.junction_field != null &&
        (r.one_field === alias || r.many_collection === alias)
    )
    if (!leg?.many_collection || !leg.junction_field) continue
    const junctionRels = await getRelations(leg.many_collection)
    const other = junctionRels.find(
      (r) => r.many_collection === leg.many_collection && r.many_field === leg.junction_field
    )
    if (!other) continue
    // A link to several collections names its target per row (#1220).
    if (!other.one_collection) {
      const allowed = parseAllowedList(other.one_allowed_collections)
      if (allowed.length === 0) continue
      plans.push({
        kind: 'm2a',
        alias,
        junction: leg.many_collection,
        fkToParent: leg.many_field,
        itemField: leg.junction_field,
        discriminator:
          (other as { one_collection_field?: string | null }).one_collection_field || 'collection',
        allowed,
        fields
      })
      continue
    }
    plans.push({
      kind: 'm2m',
      alias,
      junction: leg.many_collection,
      fkToParent: leg.many_field,
      fkToOther: leg.junction_field,
      other: other.one_collection,
      fields
    })
  }
  return plans
}

async function readAllAsCaller(
  user: User,
  collection: string,
  fields: string[],
  filter: Record<string, unknown>,
  workspaceId: string | undefined,
  depth: number
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let offset = 0; offset < TO_MANY_TOTAL; offset += 1000) {
    const page = (await readItemsAtDepth(
      user,
      collection,
      { fields, filter, sort: ['id'], limit: 1000, offset },
      workspaceId,
      depth
    )) as { data: Record<string, unknown>[] }
    out.push(...page.data)
    if (page.data.length < 1000) break
  }
  return out
}

/** Attach `row[alias] = [related rows]` for every planned alias. A caller who
 *  may not read the related collection gets empty lists, not an error. */
async function expandToMany(
  user: User,
  items: Record<string, unknown>[],
  plans: ToManyPlan[],
  workspaceId: string | undefined,
  depth: number
): Promise<string[]> {
  const truncated: string[] = []
  const ids = [...new Set(items.map((i) => i.id).filter((v) => v != null))] as Array<
    string | number
  >
  for (const plan of plans) {
    for (const it of items) it[plan.alias] = []
    if (ids.length === 0 || depth >= TO_MANY_DEPTH) continue
    const byParent = new Map<string, Record<string, unknown>[]>()
    const push = (parent: unknown, row: Record<string, unknown>) => {
      const k = String(parent)
      const list = byParent.get(k) ?? []
      if (list.length >= TO_MANY_PER_PARENT) {
        if (!truncated.includes(plan.alias)) truncated.push(plan.alias)
        return
      }
      list.push(row)
      byParent.set(k, list)
    }
    const wantsAll = plan.fields.includes('*')
    try {
      if (plan.kind === 'o2m') {
        const fields = wantsAll ? ['*'] : [...new Set(['id', plan.fk, ...plan.fields])]
        for (let i = 0; i < ids.length; i += 500) {
          const rows = await readAllAsCaller(
            user,
            plan.child,
            fields,
            { [plan.fk]: { _in: ids.slice(i, i + 500) } },
            workspaceId,
            depth + 1
          )
          for (const r of rows) {
            // An expanded FK comes back as the related record.
            const raw = r[plan.fk]
            const parent =
              raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : raw
            push(parent, r)
          }
        }
      } else if (plan.kind === 'm2a') {
        await expandM2A(user, ids, plan, workspaceId, depth, push)
      } else {
        const links: Array<{ parent: unknown; other: unknown }> = []
        for (let i = 0; i < ids.length; i += 1000) {
          const rows = (await db(plan.junction)
            .whereIn(plan.fkToParent, ids.slice(i, i + 1000))
            .whereNotNull(plan.fkToOther)
            .orderBy('id')
            .select({ parent: plan.fkToParent, other: plan.fkToOther })) as Array<{
            parent: unknown
            other: unknown
          }>
          links.push(...rows)
        }
        const otherIds = [...new Set(links.map((l) => String(l.other)))]
        const fields = wantsAll ? ['*'] : [...new Set(['id', ...plan.fields])]
        const found = new Map<string, Record<string, unknown>>()
        for (let i = 0; i < otherIds.length && found.size < TO_MANY_TOTAL; i += 500) {
          const rows = await readAllAsCaller(
            user,
            plan.other,
            fields,
            { id: { _in: otherIds.slice(i, i + 500) } },
            workspaceId,
            depth + 1
          )
          for (const r of rows) found.set(String(r.id), r)
        }
        for (const l of links) {
          const row = found.get(String(l.other))
          if (row) push(l.parent, { ...row })
        }
      }
    } catch (err) {
      // No read permission on the related collection: the lists stay empty.
      if (!(err instanceof ForbiddenError) && !(err instanceof CollectionNotFoundError)) throw err
    }
    for (const it of items) it[plan.alias] = byParent.get(String(it.id)) ?? []
  }
  return truncated
}

/**
 * One link row per junction row (#1220), the linked record read per the
 * discriminator — one read per named collection, never per row. People
 * (`directus_users` / `nivaro_users`) answer directory columns only and never
 * a redacted account; business collections are read AS THE CALLER, so their
 * permission, field list, row filter and scopes apply. A collection the
 * relation does not allow, or the caller may not read, leaves `item: null`.
 */
async function expandM2A(
  user: User,
  parentIds: Array<string | number>,
  plan: Extract<ToManyPlan, { kind: 'm2a' }>,
  workspaceId: string | undefined,
  depth: number,
  push: (parent: unknown, row: Record<string, unknown>) => void
): Promise<void> {
  const links: Array<Record<string, unknown>> = []
  for (let i = 0; i < parentIds.length; i += 1000) {
    const rows = (await db(plan.junction)
      .whereIn(plan.fkToParent, parentIds.slice(i, i + 1000))
      .orderBy('id')
      .select({
        id: 'id',
        parent: plan.fkToParent,
        item: plan.itemField,
        coll: plan.discriminator
      })) as Array<Record<string, unknown>>
    links.push(...rows)
    if (links.length >= TO_MANY_TOTAL) break
  }
  const itemFields = m2aItemFields(plan.fields, plan.discriminator)
  const found = new Map<string, Map<string, Record<string, unknown>>>()
  if (itemFields.length > 0) {
    const byCollection = new Map<string, Set<string>>()
    for (const l of links) {
      const c = m2aReadCollection(l.coll, plan.allowed)
      if (!c || l.item == null || l.item === '') continue
      byCollection.set(c, (byCollection.get(c) ?? new Set()).add(String(l.item)))
    }
    for (const [c, idSet] of byCollection) {
      const rows = new Map<string, Record<string, unknown>>()
      const ids = [...idSet]
      try {
        if (c === 'nivaro_users') {
          // What GET /users gives this caller and nothing more: the directory
          // projection, the directory's listing rules, and never through a key
          // whose scopes leave nivaro_users out.
          if (!peopleReadable(user.api_key_scopes)) continue
          const cols = peopleFields(itemFields)
          for (let i = 0; i < ids.length; i += 1000) {
            const q = db('nivaro_users')
              .whereIn('id', ids.slice(i, i + 1000))
              .select(cols)
            applyDirectoryListingRules(q)
            const us = (await q) as Array<Record<string, unknown>>
            for (const u of us) rows.set(m2aIdKey(u.id), u)
          }
        } else {
          if (!(await getCollection(c))) continue
          const fields = itemFields[0] === '*' ? ['*'] : [...new Set(['id', ...itemFields])]
          for (let i = 0; i < ids.length; i += 500) {
            const rs = await readAllAsCaller(
              user,
              c,
              fields,
              { id: { _in: ids.slice(i, i + 500) } },
              workspaceId,
              depth + 1
            )
            for (const r of rs) rows.set(m2aIdKey(r.id), r)
          }
        }
      } catch (err) {
        // Unreadable (or no longer present) — its links read `item: null`.
        if (!(err instanceof ForbiddenError) && !(err instanceof CollectionNotFoundError)) throw err
        continue
      }
      found.set(c, rows)
    }
  }
  for (const l of links) {
    const c = m2aReadCollection(l.coll, plan.allowed)
    const row: Record<string, unknown> = {
      id: l.id,
      [plan.discriminator]: l.coll ?? null,
      item_id: l.item ?? null
    }
    if (itemFields.length > 0) {
      row.item = c && l.item != null ? (found.get(c)?.get(m2aIdKey(l.item)) ?? null) : null
    }
    push(l.parent, row)
  }
}

// ── Keyset paging (`after=<cursor>`) ─────────────────────────────────────────
interface KeysetPlan {
  sorts: KeysetSort[]
  values: unknown[] | null
  /** SQL type of each sort column that holds a date or time, else null. */
  dateTypes: Array<string | null>
}

const KEYSET_DATE_TYPES = new Set([
  'date',
  'datetime',
  'datetime2',
  'smalldatetime',
  'datetimeoffset',
  'time'
])

async function planKeyset(
  collection: string,
  sort: string[],
  after: string,
  allowedFields: string[] | null
): Promise<KeysetPlan> {
  const sorts = keysetSorts(sort)
  const physical = await getActualColumns(collection)
  const byLower = new Map([...physical].map((c) => [c.toLowerCase(), c]))
  for (const s of sorts) {
    const real = byLower.get(s.column.toLowerCase())
    if (!real) {
      throw Object.assign(
        new Error(`"${s.column}" is not stored on ${collection}, so a cursor cannot walk by it`),
        { statusCode: 400, code: 'CURSOR_SORT_UNSUPPORTED' }
      )
    }
    // The cursor carries the sort values: never those of a field the caller cannot read.
    if (allowedFields && real !== 'id' && !allowedFields.includes(real)) {
      throw Object.assign(new Error(`"${s.column}" cannot be sorted with a cursor`), {
        statusCode: 400,
        code: 'CURSOR_SORT_UNSUPPORTED'
      })
    }
    s.column = real
  }
  let dateTypes: Array<string | null> = sorts.map(() => null)
  if (isMssql()) {
    const rows = rawRows<{ c: string; t: string }>(
      await db.raw(
        `SELECT COLUMN_NAME AS c, DATA_TYPE AS t FROM information_schema.columns WHERE table_name = ?`,
        [collection]
      )
    )
    const typeOf = new Map(rows.map((r) => [String(r.c).toLowerCase(), String(r.t).toLowerCase()]))
    dateTypes = sorts.map((s) => {
      const t = typeOf.get(s.column.toLowerCase())
      return t && KEYSET_DATE_TYPES.has(t) ? t : null
    })
  }
  return { sorts, values: decodeCursor(after, collection, sorts, keysetSecret()), dateTypes }
}

/** Every row that sorts after the cursor's row. */
function applyKeyset(q: QB, collection: string, plan: KeysetPlan): void {
  if (!plan.values) return
  const values = plan.values
  const col = (i: number) => db.raw('??.??', [collection, plan.sorts[i].column])
  // A date travels as the text SQL Server itself printed, and is read back
  // into the column's own type: a JavaScript date holds milliseconds, the
  // column holds more, and a rounded value would repeat or skip a row.
  const val = (i: number): Knex.Value =>
    plan.dateTypes[i] && typeof values[i] === 'string'
      ? (db.raw(`CONVERT(${plan.dateTypes[i]}, ?, 126)`, [values[i] as string]) as never)
      : (values[i] as Knex.Value)
  const branches = keysetBranches(plan.sorts, values, isMssql())
  if (branches.length === 0) {
    q.whereRaw('1 = 0')
    return
  }
  q.where((outer) => {
    for (const terms of branches) {
      outer.orWhere((branch) => {
        for (const t of terms) {
          const c = col(t.column)
          if (t.test === 'eq') branch.where(c, '=', val(t.column))
          else if (t.test === 'null') branch.whereNull(c as unknown as string)
          else if (t.test === 'not_null') branch.whereNotNull(c as unknown as string)
          else if (t.test === 'gt') branch.where(c, '>', val(t.column))
          else if (t.test === 'lt') branch.where(c, '<', val(t.column))
          else if (t.test === 'gt_or_null')
            branch.where((w) => w.where(c, '>', val(t.column)).orWhereNull(c as unknown as string))
          else if (t.test === 'lt_or_null')
            branch.where((w) => w.where(c, '<', val(t.column)).orWhereNull(c as unknown as string))
        }
      })
    }
  })
}

const KEYSET_COL = (i: number) => `__ks_${i}`

/**
 * Grouped aggregates over the rows a list read would match — same filter,
 * search, conditions, row filter and scopes, read as the caller.
 */
export async function aggregateItems(
  user: User,
  collection: string,
  query: Omit<ItemsQuery, 'aggregate'> & { aggregate: AggregateSpec },
  req?: FastifyRequest,
  workspaceId?: string
): Promise<{
  data: AggregateRow[]
  total: number
  limit: number
  offset: number
  truncated?: boolean
}> {
  const { fields: _f, sort: _s, after: _a, ...rest } = query
  return (await readItems(user, collection, { ...rest, fields: ['id'] }, req, workspaceId)) as never
}

/** readItems for a nested read: no request, a depth that stops the recursion. */
async function readItemsAtDepth(
  user: User,
  collection: string,
  query: ItemsQuery,
  workspaceId: string | undefined,
  depth: number
) {
  return toManyDepth.run(depth, () => readItems(user, collection, query, undefined, workspaceId))
}

const toManyDepth = new AsyncLocalStorage<number>()

/** #2443 — the count statement carries no gate at all: the whole table is the answer. */
function isUngatedCount(collection: string, sql: { sql: string; bindings?: readonly unknown[] }) {
  if (!isMssql() || (sql.bindings?.length ?? 0) > 0) return false
  return sql.sql === dbRead(collection).count('* as count').toSQL().sql
}

/** SQL Server's own row count of a table (heap or clustered index); null when unknown. */
async function partitionRowCount(collection: string): Promise<number | null> {
  try {
    const rows = rawRows<{ n: number | string | null }>(
      await dbRead.raw(
        `SELECT SUM(p.rows) AS n FROM sys.partitions p
          WHERE p.object_id = OBJECT_ID(?) AND p.index_id IN (0, 1)`,
        [collection]
      )
    )
    const n = rows[0]?.n
    return n == null ? null : Number(n)
  } catch {
    return null
  }
}

export async function readItems(
  user: User,
  collection: string,
  query: ItemsQuery = {},
  req?: FastifyRequest,
  workspaceId?: string
) {
  await assertServable(user, collection, 'read')

  // These five have no interdependency, but each is a separate round trip and
  // the SQL Server sits ~37ms away — run serially they were half the floor cost
  // of every list read. clearRelCache() must precede getRelsForCollection.
  clearRelCache()
  const [col, allowed, allowedFields, rels, rowFilter, noTable] = await span(
    'permissions+metadata',
    () =>
      Promise.all([
        getCollection(collection),
        can(user, 'read', collection),
        getAllowedFields(user, 'read', collection),
        getRelsForCollection(collection),
        getRowFilter(user, 'read', collection),
        tableIsMissing(collection)
      ])
  )

  // Errors surface in the original order — a caller must not learn that a
  // collection exists from a Forbidden instead of a NotFound.
  if (!col) throw new CollectionNotFoundError(collection)
  if (!allowed) throw new ForbiddenError()
  if (noTable) throw new CollectionTableMissingError(collection)

  const rawConditions = (req?.query as Record<string, string>)?.conditions
  let conditions: Array<FilterCondition | OrCondition> | undefined
  if (rawConditions) {
    try {
      conditions = JSON.parse(rawConditions) as Array<FilterCondition | OrCondition>
    } catch {
      conditions = undefined
    }
  }

  const { fields = ['*'], filter = {}, limit = 25, offset = 0, page, search } = query
  // #2444 — a relation cell's `id _in` lookup: the id list is applied after the cache is asked
  // (below), every other gate exactly as for any list read.
  const labelIds = labelLookupIds(query, {
    conditions,
    agg: (req?.query as Record<string, string> | undefined)?.agg
  })
  // Before the cursor plan: a keyset over a credential is an oracle too.
  assertNoSensitivePaths(collection, filter, query.sort ?? [], conditions)
  await assertReadableSystemPaths(user, collection, filter, query.sort ?? [], conditions)
  // A cursor walk sorts by the caller's columns and then by id; everything
  // below reads `sort`, so it is settled here.
  const keyset =
    query.after !== undefined
      ? await planKeyset(collection, query.sort ?? [], String(query.after), allowedFields)
      : null
  const sort = keyset
    ? keyset.sorts.map((k) => `${k.desc ? '-' : ''}${k.column}`)
    : (query.sort ?? [])
  // Traffic Map (#1135): the request's first list read leaves its filter / sort inputs by
  // reference; the shape (paths + operators, never values) is derived after the response.
  noteReadShape(collection, filter, sort, conditions, fields)

  // Split dotted fields (e.g. 'category.name') into direct FK columns + expansion map
  const { direct: directFields0, nested: nestedFieldMap } = await withoutUnbuiltAliases(
    collection,
    parseFieldExpansion(fields)
  )

  // `$state` is a projection over the pipeline tables, not a column: take it out
  // before the column machinery (narrowing, alias strip, SELECT) ever sees it.
  // Split here rather than after field narrowing so a role with an explicit
  // policy field list — which can never name a virtual field — still gets it.
  const stateSplit = splitStateField(directFields0)
  // `$workflow_instance` — same kind of projection: the record's instance.
  const instanceSplit = splitInstanceField(stateSplit.fields, nestedFieldMap)
  const directFields = instanceSplit.fields
  delete nestedFieldMap[STATE_FIELD]
  if ((stateSplit.wantsState || instanceSplit.instance) && directFields.length === 0)
    directFields.push('id')
  // The instance read is keyed by the record id — carry it in an explicit
  // projection that left it out (`fields=name,$workflow_instance`).
  if (instanceSplit.instance && directFields[0] !== '*' && !directFields.includes('id'))
    directFields.push('id')

  // A negative or fractional page/offset reads from the start, never a driver
  // error ("A non-negative integer must be provided to offset" was a 500).
  const effectiveOffset = keyset
    ? 0
    : page && Number.isFinite(page)
      ? (Math.max(1, Math.floor(page)) - 1) * limit
      : Number.isFinite(offset)
        ? Math.max(0, Math.floor(offset))
        : 0
  let selectFields =
    allowedFields === null
      ? directFields[0] === '*'
        ? ['*']
        : directFields
      : directFields.filter((f) => f === '*' || allowedFields.includes(f))

  // Strip sensitive columns from system tables not backed by nivaro_fields
  selectFields = await systemProjection(collection, selectFields, allowedFields)

  // `$state` is keyed by the record id, so an explicit projection that asks for
  // it must carry one — `fields=name,$state` would otherwise match nothing.
  if (stateSplit.wantsState && selectFields[0] !== '*' && !selectFields.includes('id')) {
    selectFields = ['id', ...selectFields]
  }

  // To-many aliases named with a dotted path (`lines.amount`) are read after
  // the page, as the caller. Planned here, before the alias names are stripped.
  const plannedToMany = await planToMany(collection, rels, nestedFieldMap)
  for (const plan of plannedToMany) {
    delete nestedFieldMap[plan.alias]
    selectFields = selectFields.filter((f) => f !== plan.alias)
  }
  // A relation outside the caller's field list for this collection reads nothing.
  const toMany = plannedToMany.filter((p) => aliasReadable(p.alias, allowedFields))
  if (plannedToMany.length > 0) {
    if (selectFields.length === 0) selectFields = ['id']
    else if (selectFields[0] !== '*' && !selectFields.includes('id'))
      selectFields = ['id', ...selectFields]
  }

  // Strip alias field names (O2M AND M2M) — they have no physical column
  // (e.g. 'report_widgets' on report_definitions, or an M2M alias a client
  // names with a dotted path). Selecting them causes MSSQL "Invalid column
  // name" errors; readOne strips both kinds too.
  if (selectFields[0] !== '*') {
    const o2mVirtual = new Set(
      rels
        .filter((r) => r.one_collection === collection && r.one_field != null)
        .map((r) => r.one_field as string)
    )
    // 'id' is the PK, never an O2M alias — a corrupted relation row with
    // one_field='id' must not strip it from every select on the collection
    o2mVirtual.delete('id')
    if (o2mVirtual.size > 0) {
      selectFields = selectFields.filter((f) => !o2mVirtual.has(f))
      for (const k of Object.keys(nestedFieldMap)) if (o2mVirtual.has(k)) delete nestedFieldMap[k]
    }
    if (selectFields.length === 0) selectFields = ['id']
  }

  // Virtual computed fields named in the projection: out of the SELECT, their
  // inputs in, computed after the read.
  const virtualSplit = await splitVirtualFields(collection, selectFields as string[])
  selectFields = virtualSplit.select
  if (selectFields.length === 0) selectFields = ['id']
  selectFields = await finalProjection(collection, selectFields as string[], allowedFields)
  await assertKnownFields(collection, selectFields as string[])

  // The cursor of the next page is made from the last row's sort values.
  const keysetAdded: string[] = []
  if (keyset && selectFields[0] !== '*') {
    const have = new Set((selectFields as string[]).map((f) => f.toLowerCase()))
    for (const k of keyset.sorts) {
      if (have.has(k.column.toLowerCase())) continue
      keysetAdded.push(k.column)
      selectFields = [...(selectFields as string[]), k.column]
    }
  }

  // For each related collection referenced in the filter or sort, pre-load their
  // relations into the cache so the synchronous applyFilters can access them.
  await primeRelCacheForFilter(filter, collection, rels)
  await primeVirtualSql(collection)
  await primeVirtualFilters(filter)
  await assertFilterableFields(collection, filter, sort, conditions, rels)
  // Compiled from a copy: fitting values to column types rewrites operators.
  const fittedFilter = cloneFilterTree(filter)
  await assertFilterCompiles(fittedFilter, collection, rels)

  // limit=-1 is Directus convention for "all records". Passing -1 to Knex MSSQL
  // generates SELECT TOP(-1) which is invalid SQL — treat as 1000-row cap instead.
  const effectiveLimit = limit > 0 ? Math.min(limit, LIST_READ_MAX) : LIST_READ_MAX
  // Asked for more than one read returns: the answer says so (`limit_capped`,
  // `applied_limit`), so a client pages on with offset instead of stopping at
  // a "short" first page (Exports cut every file at 1,000 rows).
  const limitCapped = !(limit > 0 && limit <= LIST_READ_MAX)
  // #474 — list reads route to the read replica when DB_READ_HOST is set
  // (dbRead aliases db otherwise, so this is a no-op on single-DB deploys).
  // Writes and read-back-after-write stay on the primary.
  const q = dbRead(collection)
    .select(selectFields as string[])
    .limit(effectiveLimit)
    .offset(effectiveOffset)
  if (keyset) {
    keyset.dateTypes.forEach((t, i) => {
      if (t)
        q.select(
          db.raw(`CONVERT(varchar(40), ??.??, 126) as ??`, [
            collection,
            keyset.sorts[i].column,
            KEYSET_COL(i)
          ])
        )
    })
  }

  if (Object.keys(fittedFilter).length && !labelIds) applyFilters(q, fittedFilter, collection, rels)

  if (sort.length) {
    await applySorts(q, sort, collection, rels)
  } else if (!(collection === 'nivaro_users' && search && orderByPeopleRelevance(q, search))) {
    // A people search with no sort of its own ranks by name (services/people-search-rank.ts);
    // anything else: MSSQL requires ORDER BY when OFFSET is used.
    q.orderByRaw('(SELECT NULL)')
  }

  const countQ = dbRead(collection).count('* as count')
  // Help-video recordings, renders and posters never read as file rows.
  if (isFilesCollection(collection)) {
    await helpVideoFileColumnsReady()
    whereNotHelpVideoFile(q, `${collection}.id`)
    whereNotHelpVideoFile(countQ, `${collection}.id`)
  }
  if (Object.keys(fittedFilter).length && !labelIds)
    applyFilters(countQ, fittedFilter, collection, rels)

  // Row-level workspace isolation (no-op when no workspaceId passed or no column)
  await applyWorkspaceScope(q, collection, workspaceId)
  await applyWorkspaceScope(countQ, collection, workspaceId)

  // Row-level security — policy row_filter conditions (no-op when policy has none)
  if (rowFilter) {
    timeAccessSync(() => {
      applyRowFilter(q, rowFilter, user)
      applyRowFilter(countQ, rowFilter, user)
    })
  }
  // Per-user dimensional scoping (restrict-mode user scopes)
  await applyUserScopes(q, collection, user)
  await applyUserScopes(countQ, collection, user)

  if (conditions?.length) {
    await applyConditions(q, conditions, collection, user?.id)
    await applyConditions(countQ, conditions, collection, user?.id)
  }
  // Rows after the cursor — the page only; the count is of the whole set.
  if (keyset) applyKeyset(q, collection, keyset)

  if (search) {
    const [fieldMeta, columnTypes, collectionMeta] = await Promise.all([
      getFields(collection),
      getColumnTypes(collection),
      getCollection(collection) as Promise<{ browser_config?: unknown } | null>
    ])
    const actualColSet = new Set(columnTypes.keys())
    // browser_config.search_fields narrows the columns (services/search-fields.ts).
    // Never a column outside the caller's field list: a match is a read, so
    // searching a hidden field would answer what it holds (and `search_fields`
    // could aim at one). null / '*' = every field.
    const readable = (c: string) =>
      !allowedFields || allowedFields.includes('*') || allowedFields.includes(c)
    // A request may narrow further (`search_fields`, e.g. a catalog picker searching
    // only what its rows show); like the collection's list, it never widens.
    let searchCols = narrowSearchColumns(
      narrowSearchColumns(
        fieldMeta
          .filter(
            (f) =>
              ['string', 'text'].includes(f.type) && actualColSet.has(f.field) && readable(f.field)
          )
          .map((f) => f.field),
        parseSearchFields(collectionMeta?.browser_config)
      ),
      query.search_fields?.length ? query.search_fields.filter(readable) : null
    )
    const hadTextFields = fieldMeta.some(
      (f) => ['string', 'text'].includes(f.type) && actualColSet.has(f.field)
    )

    // A collection with NO registered field metadata (nivaro_users is served
    // from virtual meta, so it has none) produced an empty searchable list and
    // the clause was skipped entirely — every row came back as though it had
    // matched, which reads as "search does nothing". Fall back to the table's
    // own text columns so an unregistered collection is still searchable.
    if (searchCols.length === 0 && !hadTextFields) {
      const textCols = (await db
        .raw(
          `SELECT COLUMN_NAME AS "COLUMN_NAME" FROM information_schema.columns
             WHERE table_name = ?
               AND DATA_TYPE IN ('char','nchar','varchar','nvarchar','text','ntext')`,
          [collection]
        )
        .then((res) => rawRows<{ COLUMN_NAME: string }>(res).map((r) => r.COLUMN_NAME))) as string[]
      searchCols = fallbackSearchColumns(collection, textCols)
      // Never a column outside the caller's field list (a match is a read).
      searchCols = searchCols.filter(readable)
    }
    // Nothing the caller may read to search in: nothing matches (no clause would
    // answer every row as a match).
    if (searchCols.length === 0) {
      q.whereRaw('1 = 0')
      countQ.whereRaw('1 = 0')
    }

    if (searchCols.length) {
      // Tokenized: EVERY word must match at least one column. A single
      // per-column LIKE of the whole phrase made "Robert Lee" match nothing —
      // first_name has Robert, last_name has Lee, no one column has both —
      // which read as "search doesn't work" on any picker whose display label
      // concatenates columns.
      //
      // Search synonyms (#1581): each word also matches the other words of its
      // synonym groups, and a multi-word term ("purchase order") adds a second
      // reading where it is one slot ("purchase order" | "po"). Only the LIKE
      // patterns widen — the columns and every access rule stay as they are.
      // No synonyms = one reading of one-word slots, the search as before.
      // LIKE special characters are escaped (lib/filter-like.ts). A varchar
      // column is matched with a varchar pattern when the text allows it, so
      // the column is not converted to nvarchar row by row.
      const mssql = isMssql()
      const expanded = await searchVariants(search, collection).catch(() => [])
      const variants = fitExpansion(
        expanded.length ? expanded : [[[search]]],
        searchCols.length,
        SEARCH_PATTERN_BUDGET
      )
      const slotWhere = (w: Knex.QueryBuilder, slot: string[]) => {
        for (const alt of slot) {
          const pattern = `%${likeEscape(alt)}%`
          const narrow = mssql && varcharSafePattern(pattern)
          for (const f of searchCols) {
            if (narrow && NON_UNICODE_TYPES.has(columnTypes.get(f) ?? ''))
              w.orWhereRaw('?? LIKE CAST(? AS varchar(4000))', [f, pattern])
            else w.orWhere(db.raw('??', [f]), 'like', pattern)
          }
        }
      }
      const applySearch = (qb: QB) => {
        qb.where((any) => {
          for (const v of variants) {
            any.orWhere((all) => {
              for (const slot of v) all.andWhere((inner) => slotWhere(inner, slot))
            })
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
    if (collection === 'nivaro_users') {
      applyPeoplePickerFilter(q)
      applyPeoplePickerFilter(countQ)
    }
  }

  await span('hooks:before-read', () =>
    hooks.trigger('before', { collection, action: 'read', user, database: db, req })
  )

  // Optional footer aggregates (?agg=field1,field2): SUMs computed on a clone
  // of the fully-gated count query — identical filters/RLS/scopes/search, so
  // the totals always describe exactly the rows the listing matches. Columns
  // are validated against the table's real numeric columns; invalid names are
  // dropped rather than failing the read.
  let sumQ: Promise<unknown[]> | null = null
  let sumFields: string[] = []
  const aggRaw = (req?.query as Record<string, string> | undefined)?.agg
  if (aggRaw) {
    const wanted = String(aggRaw)
      .split(',')
      .map((f) => f.trim())
      .filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f))
      .slice(0, 12)
    if (wanted.length) {
      const numericCols = new Set(
        (
          (await db.raw(
            `SELECT COLUMN_NAME AS c FROM information_schema.columns
             WHERE table_name = ? AND DATA_TYPE IN ('int','bigint','smallint','tinyint','decimal','numeric','float','real','money')`,
            [collection]
          )) as Array<{ c: string }>
        ).map((r) => r.c.toLowerCase())
      )
      // Readable fields only: a footer sum over a hidden field would show it in aggregate.
      sumFields = wanted.filter(
        (f) =>
          numericCols.has(f.toLowerCase()) &&
          (allowedFields === null || allowedFields.includes('*') || allowedFields.includes(f))
      )
      if (sumFields.length) {
        const sq = countQ.clone().clearSelect()
        for (const f of sumFields) sq.sum(`${f} as ${f}`)
        sumQ = sq as unknown as Promise<unknown[]>
      }
    }
  }

  // Aggregates instead of rows: the count query already carries every gate
  // of this read, so the figures describe exactly the rows a list would hold.
  if (query.aggregate) {
    const spec = query.aggregate
    const agg = await span('aggregate', async () =>
      runAggregate(countQ, collection, spec, {
        allowedFields,
        encrypted: await getEncryptedFields(collection),
        sensitive: sensitiveColumns(collection)
      })
    )
    return {
      data: agg.data,
      total: agg.data.length,
      limit: agg.limit,
      offset: agg.offset,
      ...(agg.truncated ? { truncated: true } : {})
    } as never
  }

  const skipCount = query.count === false
  let rawData: unknown[]
  let total: number | null
  let totalApprox = false
  let totalTimedOut = false
  let sumRows: unknown[] | null
  if (labelIds) {
    // #2444 — countQ carries every gate of this read and no id list: with the projection it
    // names exactly which rows any id can come back as, so it keys the row cache. A gate that
    // reads another table (sub-select on memberships, scopes, owners…) is never cached.
    const sigSql = countQ.toSQL()
    const cacheable = gateIsSelfContained(sigSql.sql)
    const signature = statementHash(
      `${sigSql.sql}|${JSON.stringify(selectFields)}`,
      sigSql.bindings ?? []
    )
    const epoch = readEpoch(collection)
    const cached = cacheable
      ? getCachedRows(collection, signature, labelIds)
      : { hits: new Map<string, Record<string, unknown> | null>(), missing: labelIds }
    const fetched = cached.missing.length
      ? ((await span('query', () =>
          q.clone().whereIn(`${collection}.id`, cached.missing)
        )) as Record<string, unknown>[])
      : []
    if (cacheable) putCachedRows(collection, signature, cached.missing, fetched, epoch)
    const byId = new Map(fetched.map((r) => [String(r.id).toLowerCase(), r]))
    rawData = labelIds
      .map((id) =>
        cached.hits.has(id) ? cached.hits.get(id) : (byId.get(id.toLowerCase()) ?? null)
      )
      .filter((r): r is Record<string, unknown> => r != null)
    total = skipCount ? null : rawData.length
    sumRows = null
  } else {
    // #2443 — `count=approx`: a total up to a few seconds old may stand in for the COUNT(*).
    // A gate that reads another table counts on every first page; only that caller's own
    // cursor pages reuse it (listTotalPlan in read-caches.ts).
    const countSql = query.count === 'approx' && !skipCount ? countQ.toSQL() : null
    const plan = countSql ? listTotalPlan(countSql, user?.id, keyset?.values != null) : null
    const epoch = plan?.store ? readEpoch(collection) : ''
    const cachedTotal = plan?.reuse ? getCachedTotal(collection, plan.statement) : null
    const countPromise: Promise<number | null> = skipCount
      ? Promise.resolve(null)
      : cachedTotal != null
        ? Promise.resolve(cachedTotal)
        : (async () => {
            // An unfiltered list of a big table: the row count SQL Server keeps per partition.
            const estimate =
              plan?.selfContained && countSql && isUngatedCount(collection, countSql)
                ? await partitionRowCount(collection)
                : null
            if (estimate != null && plan) {
              totalApprox = true
              putCachedTotal(collection, plan.statement, estimate, epoch)
              return estimate
            }
            let counted: Array<{ count: string | number }>
            try {
              counted = (await countQ) as Array<{ count: string | number }>
            } catch (err) {
              // A count that outlived the statement timeout costs the total, not the page.
              if (!isStatementTimeout(err)) throw err
              totalTimedOut = true
              return null
            }
            const n = Number(counted[0]?.count)
            if (plan?.store) putCachedTotal(collection, plan.statement, n, epoch)
            return n
          })()
    if (cachedTotal != null) totalApprox = true
    let settled: [unknown, number | null, unknown]
    try {
      settled = await span('query+count', () =>
        Promise.all([q, countPromise, sumQ ?? Promise.resolve(null)])
      )
    } catch (err) {
      // A list read the database gave up on used to come back as a 500 with the
      // driver's text, which a list showed as "0 items". It is a clear 503 instead.
      if (isStatementTimeout(err)) throw new ListTimeoutError(Boolean(search))
      throw err
    }
    const [rows, n, sums] = settled
    rawData = rows as unknown[]
    total = n
    sumRows = sums as unknown[] | null
  }

  let nextCursor: string | null = null
  if (keyset) {
    const rows = rawData as Record<string, unknown>[]
    const last = rows.length >= effectiveLimit ? rows[rows.length - 1] : null
    if (last) {
      nextCursor = encodeCursor(
        collection,
        keyset.sorts,
        keyset.sorts.map((k, i) =>
          keyset.dateTypes[i] ? (last[KEYSET_COL(i)] ?? null) : last[k.column]
        ),
        keysetSecret()
      )
    }
    for (const r of rows) {
      for (let i = 0; i < keyset.sorts.length; i++) delete r[KEYSET_COL(i)]
      for (const c of keysetAdded) delete r[c]
    }
  }
  const aggregates: Record<string, number> | undefined = sumRows
    ? Object.fromEntries(
        sumFields.map((f) => [f, Number((sumRows as Array<Record<string, unknown>>)[0]?.[f] ?? 0)])
      )
    : undefined

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
    () => applyReadComputedFields(collection, data, virtualSplit.requested),
    `${data.length} rows`
  )
  dropExtras(data, virtualSplit.extras)

  // `$state` — one instance ⨝ states read for the whole page, opt-in only.
  if (stateSplit.wantsState && data.length > 0) {
    await span('record-state', () => attachRecordState(collection, data), `${data.length} rows`)
  }
  if (instanceSplit.instance && data.length > 0) {
    const opts = instanceSplit.instance
    await span(
      'record-instance',
      () => attachRecordInstance(collection, data, user, opts),
      `${data.length} rows`
    )
  }

  // Expand M2O relations for dotted fields (e.g. 'category.name', 'category.*')
  if (Object.keys(nestedFieldMap).length > 0 && data.length > 0) {
    await span('expand-relations', () =>
      expandRelations(user, data, collection, nestedFieldMap, 0, workspaceId, true)
    )
  }

  // Related rows for the to-many aliases the projection named.
  let truncatedRelations: string[] = []
  if (toMany.length > 0 && data.length > 0) {
    truncatedRelations = await span(
      'expand-to-many',
      () =>
        expandToMany(
          user,
          data as Record<string, unknown>[],
          toMany,
          workspaceId,
          toManyDepth.getStore() ?? 0
        ),
      toMany.map((t) => t.alias).join(',')
    )
  }

  const result = {
    data,
    total,
    limit,
    offset: effectiveOffset,
    ...(aggregates ? { aggregates } : {}),
    // #2443 — the total came from the list-total cache or the partition row count.
    ...(totalApprox ? { total_approx: true } : {}),
    // The count ran out of time: `total` is null, the page is complete.
    ...(totalTimedOut ? { total_timed_out: true } : {}),
    ...(limitCapped ? { limit_capped: true, applied_limit: effectiveLimit } : {}),
    ...(keyset ? { next_cursor: nextCursor } : {}),
    // Aliases whose lists were cut at the per-record limit.
    ...(truncatedRelations.length ? { truncated_relations: truncatedRelations } : {})
  }

  await span('hooks:after-read', () =>
    hooks.trigger('after', { collection, action: 'read', user, result, database: db, req })
  )

  // Traffic Map data egress (#1179): rows this request handed back.
  if (req) {
    const r = req as unknown as { __nvrRows?: number }
    r.__nvrRows = (r.__nvrRows ?? 0) + data.length
  }

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
      // `_link` filters the junction row itself — its relations get primed too.
      const wrapped = ((value as Record<string, unknown>)['_some'] ??
        (value as Record<string, unknown>)['_none']) as Record<string, unknown> | undefined
      const link = wrapped?.['_link']
      if (link && typeof link === 'object') {
        if (!relCache.has(m2mMatch.junction))
          relCache.set(m2mMatch.junction, await getRelations(m2mMatch.junction))
        await primeRelCacheForFilter(
          link as Record<string, unknown>,
          m2mMatch.junction,
          relCache.get(m2mMatch.junction) as CMSRelation[]
        )
      }
    }
  }
}

/** Column names are interpolated into a query, so they must be identifiers. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Turn a URL segment into a primary key when a collection is configured to be
 * addressed by something people recognise ("REQ-1234" instead of 98765).
 *
 * Returns the id, or null when the collection has no alias configured / the
 * segment does not resolve — callers keep their existing not-found behaviour.
 *
 * Two things this must not do:
 *  - Hand a non-numeric segment to an int primary key. MSSQL raises
 *    "Conversion failed" and the request 500s instead of 404ing, so the id
 *    lookup is skipped entirely when the segment cannot be one.
 *  - Silently pick among several matches. Alias columns carry no uniqueness
 *    guarantee (legacy business ids have real duplicates), so the LOWEST id
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
  let names = Array.isArray(fields)
    ? fields.filter((f): f is string => typeof f === 'string' && IDENT_RE.test(f))
    : []
  // #776: the human id field is an alias too — a collection that names one
  // and lists no URL alias resolves /collections/<c>/<friendly id> through it.
  const friendly = (col as { friendly_id_field?: unknown } | null)?.friendly_id_field
  if (
    names.length === 0 &&
    typeof friendly === 'string' &&
    IDENT_RE.test(friendly) &&
    friendly !== 'id'
  ) {
    names = [friendly]
  }
  if (names.length === 0) return null

  // A multi-field alias joins its parts with '-', so split from the LEFT by
  // field count and let the final field absorb any remaining separators —
  // values themselves routinely contain '-' ("REQ-1234").
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
  await assertServable(user, collection, 'read')
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
  if (await tableIsMissing(collection)) throw new CollectionTableMissingError(collection)
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
  const { direct: directFields0, nested: nestedFieldMap } = await withoutUnbuiltAliases(
    collection,
    parseFieldExpansion(fields ?? baseFields)
  )

  // `$state` — see readItems: split before the column machinery runs.
  const oneState = splitStateField(directFields0)
  const oneInstance = splitInstanceField(oneState.fields, nestedFieldMap)
  const directFields = oneInstance.fields
  delete nestedFieldMap[STATE_FIELD]

  let selectCols =
    allowedFields === null
      ? directFields[0] === '*'
        ? ['*']
        : directFields
      : directFields.filter((f) => f === '*' || allowedFields.includes(f))
  selectCols = await systemProjection(collection, selectCols, allowedFields)

  // The state read is keyed by the record id — an explicit projection that asks
  // for `$state` must carry one.
  if (
    (oneState.wantsState || oneInstance.instance) &&
    selectCols[0] !== '*' &&
    !selectCols.includes('id')
  ) {
    selectCols = ['id', ...selectCols]
  }

  // To-many aliases named with a dotted path — see readItems.
  const oneRels = await getRelsForCollection(collection)
  const plannedToMany = await planToMany(collection, oneRels, nestedFieldMap)
  for (const plan of plannedToMany) {
    delete nestedFieldMap[plan.alias]
    selectCols = selectCols.filter((f) => f !== plan.alias)
  }
  // A relation outside the caller's field list for this collection reads nothing.
  const toMany = plannedToMany.filter((p) => aliasReadable(p.alias, allowedFields))
  if (plannedToMany.length > 0) {
    if (selectCols.length === 0) selectCols = ['id']
    else if (selectCols[0] !== '*' && !selectCols.includes('id')) selectCols = ['id', ...selectCols]
  }

  // Strip O2M/M2M alias names from explicit selects — readItems has done this
  // for years, readOne didn't, so `?fields=id,<alias>` 500'd with "Invalid
  // column name" here while working on the list route.
  if (selectCols[0] !== '*') {
    const rels = oneRels
    const aliasNames = new Set(
      rels
        .filter((r) => r.one_collection === collection && r.one_field != null)
        .map((r) => r.one_field as string)
    )
    aliasNames.delete('id')
    if (aliasNames.size > 0) selectCols = selectCols.filter((f) => !aliasNames.has(f))
    if (selectCols.length === 0) selectCols = ['id']
  }

  // Virtual computed fields — see splitVirtualFields.
  const virtualSplit = await splitVirtualFields(collection, selectCols as string[])
  selectCols = virtualSplit.select
  if (selectCols.length === 0) selectCols = ['id']
  selectCols = await finalProjection(collection, selectCols as string[], allowedFields)
  await assertKnownFields(collection, selectCols as string[])

  // An alias segment ("REQ-1234") is not a key. Resolve it first, and never
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
  // Digits past the key's range, or a uuid-looking segment on an int key, are
  // the same not-found.
  if (!(await idFitsCollection(collection, key))) return null

  const q = db(collection)
    .where({ id: key })
    .select(selectCols as string[])
  await applyWorkspaceScope(q, collection, workspaceId)

  if (rowFilter) timeAccessSync(() => applyRowFilter(q, rowFilter, user))
  await applyUserScopes(q, collection, user)

  let item = (await q.first()) as Record<string, unknown> | undefined

  if (item) {
    item = await decryptItemFields(collection, item)
    await applyInheritedFields(collection, [item])
    await applyReadComputedFields(collection, [item], virtualSplit.requested)
    dropExtras([item], virtualSplit.extras)
    if (oneState.wantsState) await attachRecordState(collection, [item])
    if (oneInstance.instance)
      await attachRecordInstance(collection, [item], user, oneInstance.instance)
    if (Object.keys(nestedFieldMap).length > 0) {
      await expandRelations(user, [item], collection, nestedFieldMap, 0, workspaceId)
    }
    if (toMany.length > 0) {
      await expandToMany(user, [item], toMany, workspaceId, toManyDepth.getStore() ?? 0)
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

const ALIAS_WRITES = Symbol('aliasWrites')

interface AliasLink {
  id: string | number
  /** Polymorphic link: the collection the id belongs to (the junction's discriminator value). */
  collection?: string
}

interface AliasM2MWrite {
  field: string
  junction: string
  parentFk: string
  relatedFk: string
  /** Polymorphic junction: the column that names the linked collection. */
  discriminator?: string
  /** Links to add (or, with `set`, the whole set the record should hold). */
  links: AliasLink[]
  /** Links to remove. */
  removals: AliasLink[]
  /** True: the junction set becomes exactly `links`. */
  set: boolean
  /** The related ids, for callers that read the draft (auto-id tokens, rules). */
  ids: Array<string | number>
}

/** The spelling of a linked collection the junction stores: the allowed list
 *  wins (legacy rows say `directus_users`), and a modern name is mapped onto
 *  its legacy twin when only that is allowed. */
function allowedCollectionName(name: string, allowed: string[]): string | null {
  if (allowed.length === 0) return name
  const hit = allowed.find((a) => a.toLowerCase() === name.toLowerCase())
  if (hit) return hit
  const legacy: Record<string, string> = {
    nivaro_users: 'directus_users',
    nivaro_files: 'directus_files'
  }
  const twin = legacy[name.toLowerCase()]
  if (twin) return allowed.find((a) => a.toLowerCase() === twin) ?? null
  return null
}

/** The collection a bare id on a polymorphic alias is taken to name: what the
 *  record form writes — the legacy users spelling when allowed, else the first
 *  allowed collection. */
function defaultM2ACollection(allowed: string[]): string | null {
  if (allowed.length === 0) return null
  return (
    allowed.find((a) => a.toLowerCase() === 'directus_users') ??
    allowed.find((a) => a.toLowerCase() === 'nivaro_users') ??
    allowed[0]
  )
}

function linkOf(
  e: unknown,
  jf: string,
  m2a: { discriminator: string; allowed: string[] } | null
): AliasLink | null {
  if (e == null) return null
  if (typeof e !== 'object') {
    if (!m2a) return { id: e as string | number }
    const collection = defaultM2ACollection(m2a.allowed)
    return collection ? { id: e as string | number, collection } : null
  }
  const rec = e as Record<string, unknown>
  if (m2a) {
    // `{collection, id}`, `{collection, item}`, `{item: {id}, collection}`,
    // or the junction's own column names.
    const rawCollection = rec.collection ?? rec[m2a.discriminator]
    const inner = jf in rec ? rec[jf] : 'item' in rec ? rec.item : rec.id
    const id =
      inner != null && typeof inner === 'object' ? (inner as Record<string, unknown>).id : inner
    if (typeof id !== 'string' && typeof id !== 'number') return null
    const collection =
      typeof rawCollection === 'string'
        ? allowedCollectionName(rawCollection, m2a.allowed)
        : defaultM2ACollection(m2a.allowed)
    if (!collection) return null
    return { id, collection }
  }
  const inner = jf in rec ? rec[jf] : rec
  if (inner == null) return null
  if (typeof inner !== 'object') return { id: inner as string | number }
  const id = (inner as Record<string, unknown>).id
  return typeof id === 'string' || typeof id === 'number' ? { id } : null
}

/**
 * Directus-era integrations write M2M relations as alias keys on the record
 * payload — `regions: {id: 9}`, `years: [{years_year: {id: 2026}}]`,
 * `files: [{directus_files_id: {id: "…"}}]`, or `{create: [...]}`. Nivaro's own
 * clients write junction rows directly, so these keys used to be silently
 * stripped and the links were lost.
 *
 * This normalizes each alias value in the payload to a plain array of related
 * ids (so auto-id templates and field rules can read it as a draft value),
 * and returns the junction writes to apply AFTER the record write.
 *
 * Shapes:
 *   [ids]              add these links (plain arrays stay ADDITIVE)
 *   {create: [...]}    the same
 *   {delete: [...]}    remove these links
 *   {set: [...]}       the record's links become exactly these
 * A polymorphic (M2A) alias takes `[{collection, id}]` entries; the junction's
 * discriminator column is written from `collection`, spelled the way the
 * relation's allowed list spells it.
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
  const stash =
    ((payload as Record<PropertyKey, unknown>)[ALIAS_WRITES] as
      | Map<string, { value: unknown; write: AliasM2MWrite | null }>
      | undefined) ?? new Map<string, { value: unknown; write: AliasM2MWrite | null }>()
  Object.defineProperty(payload, ALIAS_WRITES, { value: stash, enumerable: false })
  for (const r of rels) {
    if (r.one_collection !== collection || !r.one_field || r.junction_field == null) continue
    const key = r.one_field
    if (!(key in payload)) continue
    const raw = payload[key]
    if (raw == null) continue
    // Already read on this write and untouched since (the normalized draft
    // value is the same array): keep the intent — a `set` or `delete` must
    // not turn into an additive write on the second reading.
    const prior = stash.get(key)
    if (prior && prior.value === raw) {
      if (prior.write) writes.push(prior.write)
      continue
    }
    const jf = String(r.junction_field)
    // A polymorphic alias declares its allowed collections and discriminator
    // on the junction's OTHER leg (the one that points at "anything").
    const companion = rels.find(
      (c) => c.many_collection === r.many_collection && c.many_field === jf && c !== r
    )
    const allowedRaw =
      (r as { one_allowed_collections?: unknown }).one_allowed_collections ??
      (companion as { one_allowed_collections?: unknown } | undefined)?.one_allowed_collections
    const allowed = Array.isArray(allowedRaw)
      ? allowedRaw.map(String)
      : typeof allowedRaw === 'string'
        ? allowedRaw
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : []
    const m2a = allowedRaw
      ? {
          discriminator: String(
            (r as { one_collection_field?: string | null }).one_collection_field ||
              (companion as { one_collection_field?: string | null } | undefined)
                ?.one_collection_field ||
              'collection'
          ),
          allowed
        }
      : null

    let adds: unknown[] = []
    let removes: unknown[] = []
    let set = false
    if (Array.isArray(raw)) adds = raw
    else if (typeof raw === 'object') {
      const o = raw as Record<string, unknown>
      if (Array.isArray(o.set)) {
        adds = o.set
        set = true
      } else if (Array.isArray(o.create) || Array.isArray(o.delete)) {
        adds = Array.isArray(o.create) ? o.create : []
        removes = Array.isArray(o.delete) ? o.delete : []
      } else adds = [raw]
    } else adds = [raw]

    const links = adds
      .map((e) => linkOf(e, jf, m2a))
      .filter((l): l is AliasLink => !!l && l.id !== '')
    const removals = removes
      .map((e) => linkOf(e, jf, m2a))
      .filter((l): l is AliasLink => !!l && l.id !== '')

    // Normalized draft value — auto-id `{regions[0].short_code}` tokens and
    // rule contexts read this; filterToActualColumns strips it before write.
    const normalized: unknown = m2a
      ? links.map((l) => ({ collection: l.collection, id: l.id }))
      : links.map((l) => l.id)
    payload[key] = normalized
    let write: AliasM2MWrite | null = null
    if (links.length > 0 || removals.length > 0 || set) {
      write = {
        field: key,
        junction: r.many_collection,
        parentFk: r.many_field,
        relatedFk: jf,
        ...(m2a ? { discriminator: m2a.discriminator } : {}),
        links,
        removals,
        set,
        ids: links.map((l) => l.id)
      }
      writes.push(write)
    }
    stash.set(key, { value: normalized, write })
  }
  return writes
}

// A stored link with no discriminator (rows written before it was set)
// matches any collection: it must never be duplicated beside itself.
const sameLink = (a: AliasLink, b: AliasLink) =>
  String(a.id) === String(b.id) &&
  (!a.collection || !b.collection || a.collection.toLowerCase() === b.collection.toLowerCase())

/**
 * Write the junction rows an alias write asked for, through createOne and
 * deleteOne so every downstream contract holds — junction auto-id recompute
 * (the record's rendered name), stored rollups, activity, queue
 * materialization. Adds skip pairs that exist; removals and `set` delete
 * through deleteOne (trash, history). Never throws — a failed link must not
 * fail the record write that carried it; each failure is named in `failures`
 * (when given) so the caller can say which links did not land.
 */
async function applyAliasM2MWrites(
  user: User,
  recordId: string | number,
  writes: AliasM2MWrite[],
  req?: FastifyRequest,
  failures?: string[]
): Promise<void> {
  for (const w of writes) {
    try {
      const cols = [w.relatedFk, ...(w.discriminator ? [w.discriminator] : [])]
      const existing = (await db(w.junction)
        .where({ [w.parentFk]: recordId })
        .select('id', ...cols)) as Array<Record<string, unknown>>
      const have = existing.map((row) => ({
        junctionId: row.id as string | number,
        link: {
          id: row[w.relatedFk] as string | number,
          ...(w.discriminator ? { collection: String(row[w.discriminator] ?? '') } : {})
        } as AliasLink
      }))
      for (const link of w.links) {
        if (have.some((h) => sameLink(h.link, link))) continue
        await createOne(
          user,
          w.junction,
          {
            [w.parentFk]: recordId,
            [w.relatedFk]: link.id,
            ...(w.discriminator && link.collection ? { [w.discriminator]: link.collection } : {})
          },
          req
        )
      }
      const gone = w.set
        ? have.filter((h) => !w.links.some((l) => sameLink(l, h.link)))
        : have.filter((h) => w.removals.some((l) => sameLink(l, h.link)))
      for (const h of gone) await deleteOne(user, w.junction, h.junctionId, req)
    } catch (err) {
      console.warn(`alias m2m write failed for ${w.junction}.${w.field}:`, err)
      failures?.push(`${w.field}: ${(err as Error)?.message ?? 'could not be linked'}`)
    }
  }
}

interface AliasO2MWrite {
  field: string
  collection: string
  fk: string
  /** Rows to create (no id). */
  rows: Array<Record<string, unknown>>
  /** Rows to change in place (id + the fields to write). */
  updates: Array<{ id: string | number; patch: Record<string, unknown> }>
  /** Rows to remove. */
  deletes: Array<string | number>
  /** True: the parent's child set becomes exactly `rows` + `updates`. */
  set: boolean
}

const NESTED_O2M_ROW_CAP = 500

function idOf(e: unknown): string | number | null {
  if (typeof e === 'string' || typeof e === 'number') return e === '' ? null : e
  if (e && typeof e === 'object') {
    const id = (e as Record<string, unknown>).id
    if (typeof id === 'string' || typeof id === 'number') return id === '' ? null : id
  }
  return null
}

/**
 * Nested ONE-TO-MANY writes — the other half of the Directus payload shape:
 * `workflow_lines: [{…}, {…}]`, `forecasts: {create: [{…}]}` on the parent's
 * create or update. An integration that had to create the record, read its id
 * back and then post each child set in its own call sends ONE payload.
 *
 * Shapes:
 *   [rows]                          rows without an id are created; rows WITH
 *                                   an id are changed in place (on an update
 *                                   of the parent — ignored on its create)
 *   {create: [...], update: [...],  the same, spelled out; `delete` takes
 *    delete: [ids]}                 ids or `{id}` objects
 *   {set: [...]}                    the child set becomes exactly these rows:
 *                                   rows with an id are changed, rows without
 *                                   one created, every other child removed
 * Bare ids in a plain array are ignored: a client echoing the children it
 * just read must never turn into a wave of child updates.
 *
 * The alias key is REMOVED from the payload (it is not a column, and rules or
 * validation must not judge an array as a field value).
 */
async function extractAliasO2MWrites(
  collection: string,
  payload: Record<string, unknown>
): Promise<AliasO2MWrite[]> {
  let rels: CMSRelation[]
  try {
    rels = await getRelsForCollection(collection)
  } catch {
    return []
  }
  // Sets are written in the order the caller listed them: a later set may
  // depend on an earlier one (a cap on one set reads a rollup over another).
  const order = Object.keys(payload)
  const writes: AliasO2MWrite[] = []
  for (const r of rels) {
    if (r.one_collection !== collection || !r.one_field || r.junction_field != null) continue
    const key = r.one_field
    if (key === 'id' || !(key in payload)) continue
    if (!r.many_collection || !r.many_field) continue
    if (/^nivaro_|^directus_/i.test(r.many_collection)) continue
    if (!/^[A-Za-z0-9_]+$/.test(r.many_collection) || !/^[A-Za-z0-9_]+$/.test(r.many_field))
      continue
    const raw = payload[key]
    let entries: unknown[] = []
    let explicitUpdates: unknown[] = []
    let deleteEntries: unknown[] = []
    let set = false
    if (Array.isArray(raw)) entries = raw
    else if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>
      if (Array.isArray(o.set)) {
        entries = o.set
        set = true
      } else if (Array.isArray(o.create) || Array.isArray(o.update) || Array.isArray(o.delete)) {
        entries = Array.isArray(o.create) ? o.create : []
        explicitUpdates = Array.isArray(o.update) ? o.update : []
        deleteEntries = Array.isArray(o.delete) ? o.delete : []
      } else if (!('id' in o)) entries = [raw]
    }
    const isRow = (e: unknown): e is Record<string, unknown> =>
      !!e && typeof e === 'object' && !Array.isArray(e)
    const rows = entries.filter((e): e is Record<string, unknown> => isRow(e) && idOf(e) == null)
    const updates = [...entries, ...explicitUpdates]
      .filter((e): e is Record<string, unknown> => isRow(e) && idOf(e) != null)
      .map((e) => {
        const { id, ...patch } = e
        return { id: id as string | number, patch }
      })
    const deletes = deleteEntries.map(idOf).filter((v): v is string | number => v != null)
    delete payload[key]
    if (rows.length === 0 && updates.length === 0 && deletes.length === 0 && !set) continue
    if (rows.length + updates.length + deletes.length > NESTED_O2M_ROW_CAP) {
      throw Object.assign(
        new Error(
          `"${key}" carries ${rows.length + updates.length + deletes.length} rows — at most ${NESTED_O2M_ROW_CAP} per write`
        ),
        { statusCode: 400, code: 'NESTED_ROWS_LIMIT' }
      )
    }
    writes.push({
      field: key,
      collection: r.many_collection,
      fk: r.many_field,
      rows,
      updates,
      deletes,
      set
    })
  }
  return writes.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field))
}

function mergeO2MWrites(a: AliasO2MWrite[], b: AliasO2MWrite[]): AliasO2MWrite[] {
  if (b.length === 0) return a
  const out = [...a]
  for (const w of b) {
    const hit = out.find((x) => x.field === w.field)
    if (hit) {
      hit.rows.push(...w.rows)
      hit.updates.push(...w.updates)
      hit.deletes.push(...w.deletes)
      hit.set = hit.set || w.set
    } else out.push(w)
  }
  return out
}

type NestedCreated = Array<{ collection: string; id: string | number }>

/**
 * Create the child rows a nested write asked for, each through createOne as
 * the SAME caller — permissions, before/after hooks, row rules, validation,
 * natural-key upsert and activity all apply per row, exactly as if the caller
 * had posted it. Sequential (line rows read earlier rows) with the per-row
 * rollup recalc skipped; ONE recalc per child set afterwards.
 *
 * All or nothing: the first failing row stops the write, every child created
 * so far is removed, and the error names the set and the row. `preExisting`
 * guards the update path — a child create that the natural key routed onto a
 * row that was already there is never deleted by the compensation.
 */
async function applyAliasO2MWrites(
  user: User,
  parentId: string | number,
  writes: AliasO2MWrite[],
  req: FastifyRequest | undefined,
  workspaceId: string | undefined,
  isNewParent: boolean,
  callerPayload = false
): Promise<NestedCreated> {
  const created: NestedCreated = []
  // Rows changed in place, with what they held before, for the undo.
  const changed: Array<{
    collection: string
    id: string | number
    prior: Record<string, unknown>
  }> = []
  const nestedError = (err: unknown, w: AliasO2MWrite, where: string) => {
    const e = err as Error & { nested?: unknown }
    e.message = `${where}: ${nestedReason(e)}`
    e.nested = { field: w.field, collection: w.collection }
    return e
  }
  const undo = async (): Promise<string> => {
    const stuck = await undoNestedCreates(user, created, req)
    const stuckUpdates: string[] = []
    for (const c of changed.reverse()) {
      if (Object.keys(c.prior).length === 0) continue
      try {
        await updateOne(
          user,
          c.collection,
          c.id,
          { ...c.prior, _change_reason: 'Nested write undone: a later row was refused' },
          req,
          workspaceId
        )
      } catch {
        stuckUpdates.push(`${c.collection} ${c.id}`)
      }
    }
    const left = [...stuck.map((x) => `${x.collection} ${x.id}`), ...stuckUpdates]
    return left.length ? ` (could not put back: ${left.join(', ')})` : ''
  }
  try {
    for (const w of writes) {
      const preExisting = new Set<string>()
      const owned = (await db(w.collection)
        .where({ [w.fk]: parentId })
        .select('id')) as Array<{ id: string | number }>
      for (const r of owned) preExisting.add(String(r.id))
      const ownedOrRefuse = (id: string | number, what: string) => {
        if (isNewParent || !preExisting.has(String(id))) {
          throw Object.assign(new Error(`${w.field}: ${what} ${id} is not a row of this record`), {
            statusCode: 422,
            code: 'NESTED_ROW_NOT_OWNED',
            nested: { field: w.field, id }
          })
        }
      }
      // Changes first (a create that reads a sibling sees the change), then
      // creates, then removals last — a refusal before them removes nothing.
      const updates = isNewParent ? [] : w.updates
      for (let i = 0; i < updates.length; i++) {
        const u = updates[i]
        ownedOrRefuse(u.id, 'row')
        try {
          const { [w.fk]: _fk, ...patch } = u.patch
          if (Object.keys(patch).length === 0) continue
          const before = (await db(w.collection).where({ id: u.id }).first()) as
            | Record<string, unknown>
            | undefined
          const prior: Record<string, unknown> = {}
          for (const k of Object.keys(patch))
            if (before && !k.startsWith('_') && k in before) prior[k] = before[k]
          await updateOne(user, w.collection, u.id, patch, req, workspaceId, { callerPayload })
          changed.push({ collection: w.collection, id: u.id, prior })
        } catch (err) {
          throw nestedError(err, w, `${w.field}[${u.id}]`)
        }
      }
      let last: Record<string, unknown> | null = null
      for (let i = 0; i < w.rows.length; i++) {
        try {
          // The outcome carries the id even when the writer cannot read the
          // row back — an undo must still find every row this set made.
          const outcome: CreateOutcome = {}
          const row = (await createOne(
            user,
            w.collection,
            { ...w.rows[i], [w.fk]: parentId },
            req,
            workspaceId,
            { skipRollupRecalc: true, outcome, callerPayload }
          )) as Record<string, unknown> | null
          const rid = (row?.id as string | number | undefined) ?? outcome.id
          if (rid != null && !preExisting.has(String(rid)))
            created.push({ collection: w.collection, id: rid })
          if (row) last = row
        } catch (err) {
          throw nestedError(err, w, `${w.field}[${i}]`)
        }
      }
      if (!isNewParent) {
        const keep = new Set([
          ...updates.map((u) => String(u.id)),
          ...created.filter((c) => c.collection === w.collection).map((c) => String(c.id))
        ])
        const removals = w.set
          ? [...preExisting].filter((id) => !keep.has(id))
          : w.deletes.map(String)
        for (const id of removals) {
          ownedOrRefuse(id, 'row')
          try {
            await deleteOne(user, w.collection, id, req, workspaceId)
          } catch (err) {
            throw nestedError(err, w, `${w.field} delete ${id}`)
          }
        }
      }
      // One recalc for the whole set: every row shares the parent.
      if (last) await recalcAffectedRollups(w.collection, last)
      else if (updates.length > 0 || (w.deletes.length > 0 && !isNewParent)) {
        const any = (await db(w.collection)
          .where({ [w.fk]: parentId })
          .first()) as Record<string, unknown> | undefined
        if (any) await recalcAffectedRollups(w.collection, any)
      }
    }
  } catch (err) {
    const e = err as Error
    const note = await undo()
    e.message = `${e.message} — nothing was changed${note}`
    throw e
  }
  return created
}

/** What went wrong, without the statement: a driver error reads
 *  "<sql> - <reason>" and the caller of a nested write needs only the reason. */
function nestedReason(err: Error): string {
  const inner = (err as { errors?: unknown }).errors
  const first = Array.isArray(inner) ? inner.find((x) => x instanceof Error && x.message) : null
  if (first instanceof Error) return first.message.trim()
  const m = /^\s*(?:insert|update|delete|select|merge|exec)\b[\s\S]*? - ([\s\S]+)$/i.exec(
    err.message
  )
  return (m ? m[1] : err.message).trim()
}

/** Remove rows a failed nested write created, newest first. deleteOne so
 *  rollups and history follow; a caller allowed to create but not delete
 *  still gets a clean result through the raw fallback. */
async function undoNestedCreates(
  user: User,
  created: NestedCreated,
  req?: FastifyRequest
): Promise<NestedCreated> {
  const stuck: NestedCreated = []
  for (const c of [...created].reverse()) {
    try {
      await deleteOne(user, c.collection, c.id, req)
    } catch {
      try {
        await db(c.collection).where({ id: c.id }).del()
      } catch {
        stuck.push(c)
      }
    }
  }
  return stuck
}

/** A parent whose nested children failed never existed as far as the caller
 *  is concerned: its after-hooks have not fired yet, so the row and the
 *  junction links made for it are removed directly. */
async function undoNewParent(
  collection: string,
  id: string | number,
  aliasWrites: AliasM2MWrite[]
): Promise<void> {
  for (const w of aliasWrites) {
    await db(w.junction)
      .where({ [w.parentFk]: id })
      .del()
      .catch(() => {})
  }
  await db(collection)
    .where({ id })
    .del()
    .catch((err) => console.warn(`nested write: could not remove ${collection} ${id}:`, err))
}

/**
 * Resolve a collection's `upsert_keys` (JSON array of column names) against a
 * create payload: returns the id of the row that already holds this natural
 * key, or null when the collection has no keys, the payload does not carry
 * all of them, or no row matches. Null-valued keys never match (a key with no
 * value is not an identity) — unless the key is declared OPTIONAL with a
 * trailing `?` (`"category?"`): an absent or empty optional key matches rows
 * where that column IS NULL, so one natural key can cover both a plain record
 * and its optional sub-divisions.
 */
/** A create that the natural key routed to an update — read by the API
 *  layers to say so in the response. Keyed by the returned record object. */
export interface UpsertInfo {
  matched_id: string | number
  keys: string[]
}
const upsertMarks = new WeakMap<object, UpsertInfo>()
export function upsertInfoOf(item: unknown): UpsertInfo | null {
  return item && typeof item === 'object' ? (upsertMarks.get(item) ?? null) : null
}

/** A collection's natural-key fields (`?` = optional key). */
export function upsertKeysOf(col: { upsert_keys?: string | null } | null): string[] {
  try {
    const parsed = JSON.parse(String(col?.upsert_keys ?? ''))
    return Array.isArray(parsed)
      ? parsed.map(String).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*\??$/.test(k))
      : []
  } catch {
    return []
  }
}

async function findUpsertTarget(
  collection: string,
  col: { upsert_keys?: string | null } | null,
  data: Record<string, unknown>
): Promise<string | number | null> {
  const raw = col?.upsert_keys
  if (!raw) return null
  let keys: string[]
  try {
    const parsed = JSON.parse(String(raw))
    keys = Array.isArray(parsed)
      ? parsed.map(String).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*\??$/.test(k))
      : []
  } catch {
    return null
  }
  if (keys.length === 0) return null
  const where: Record<string, unknown> = {}
  const nullKeys: string[] = []
  let required = 0
  for (const raw of keys) {
    const optional = raw.endsWith('?')
    const k = optional ? raw.slice(0, -1) : raw
    const v = data[k]
    if (v === undefined || v === null || v === '') {
      if (!optional) return null
      nullKeys.push(k)
      continue
    }
    if (!optional) required++
    where[k] =
      typeof v === 'object' && v !== null && 'id' in (v as object) ? (v as { id: unknown }).id : v
  }
  // Optional keys alone are not an identity.
  if (required === 0) return null
  try {
    const q = db(collection).where(where)
    for (const k of nullKeys) q.whereNull(k)
    const row = (await q.orderBy('id').first('id')) as { id: string | number } | undefined
    return row?.id ?? null
  } catch {
    return null
  }
}

// ── Rehearsed creates (`dry_run`) ────────────────────────────────────────────

export interface DryRunNestedRow {
  index: number
  ok: boolean
  data?: Record<string, unknown> | null
  status?: number
  error?: string
  code?: string
}

/** What a create WOULD do. Nothing is stored and no number is taken. */
export interface DryRunReport {
  dry_run: true
  ok: boolean
  /** The status the real request would answer. */
  status: number
  would: 'create' | 'update' | null
  /** The record as it would be stored (`id` is not reserved, so it is null). */
  data: Record<string, unknown> | null
  /** The record a natural key matched, and the keys that matched it. */
  matched_id?: string | number
  keys?: string[]
  /** would = update: the stored fields the payload would change. */
  changes?: Array<{ field: string; from: unknown; to: unknown }>
  /** Fields the server set that the caller did not send. */
  filled: string[]
  /** Keys of the payload that are stored nowhere. */
  ignored: string[]
  /** Many-to-many links the payload would add, per alias. */
  links: Record<string, Array<string | number>>
  /** Child rows the payload would create, per alias. */
  nested: Record<string, DryRunNestedRow[]>
  notes: string[]
  error?: string
  code?: string
  violations?: unknown
  fields?: unknown
}

const dryReports = new WeakSet<object>()

function sameStored(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === ''
  if (empty(a) && empty(b)) return true
  if (empty(a) || empty(b)) return false
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(String(a)).getTime()
    const tb = b instanceof Date ? b.getTime() : new Date(String(b)).getTime()
    return ta === tb
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const t = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
    return t(a) === t(b)
  }
  const na = Number(a)
  const nb = Number(b)
  if (String(a).trim() !== '' && String(b).trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb))
    return na === nb
  return String(a) === String(b)
}

/** What an error would have answered, without the statement. */
export function describeWriteRefusal(err: unknown): {
  status: number
  error: string
  code?: string
  violations?: unknown
  [detail: string]: unknown
} {
  const refusal = describeDbRefusal(err) ?? describeValueRefusal(err)
  if (refusal) return { status: refusal.status, error: refusal.message, code: refusal.code }
  const e = err as {
    statusCode?: number
    message?: string
    code?: unknown
    violations?: unknown
    fields?: unknown
  }
  const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
  const code = typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code) ? e.code : undefined
  const details: Record<string, unknown> = {}
  if (code && status < 500) {
    for (const k of REFUSAL_DETAIL_KEYS) {
      const v = (err as Record<string, unknown>)[k]
      if (v !== undefined && typeof v !== 'function') details[k] = v
    }
  }
  return {
    status,
    error: status >= 500 ? nestedReason(err as Error) : String(e?.message ?? 'failed'),
    ...(code && status < 500 ? { code } : {}),
    ...(e?.violations !== undefined ? { violations: e.violations } : {}),
    ...details
  }
}

/** The details a coded refusal may carry onto the wire (the global error
 *  handler forwards the same set on a real request). */
const REFUSAL_DETAIL_KEYS = [
  'rule',
  'field',
  'fields',
  'parents',
  'value',
  'target',
  'existing_id',
  'max',
  'current',
  'nested',
  'first',
  'scope',
  'keys',
  'meta'
] as const

/**
 * Rehearse a create: contracts, the natural-key match, hooks (told it is a
 * rehearsal), rules, row rules, generated ids, computed fields and validation
 * all run; the insert is tried inside a transaction that is rolled back, so
 * the database's own refusals (a missing linked record, a duplicate, a value
 * too long) are found too. Nothing is stored, no sequence number is taken, no
 * after-hook, notification, webhook or rollup runs.
 *
 * A caller who may not create in the collection, and a collection that does
 * not exist, are refused as they would be for a real create.
 */
export async function rehearseCreate(
  user: User,
  collection: string,
  data: Record<string, unknown>,
  req?: FastifyRequest,
  workspaceId?: string,
  opts?: { insert?: boolean; callerPayload?: boolean }
): Promise<DryRunReport> {
  try {
    const out = await createOne(user, collection, structuredClone(data ?? {}), req, workspaceId, {
      dryRun: { insert: opts?.insert !== false },
      callerPayload: opts?.callerPayload === true
    })
    if (out && typeof out === 'object' && dryReports.has(out)) return out as DryRunReport
    throw new Error('The rehearsal produced no report')
  } catch (err) {
    if (err instanceof CollectionNotFoundError || err instanceof ForbiddenError) throw err
    return {
      dry_run: true,
      ok: false,
      would: null,
      data: null,
      filled: [],
      ignored: [],
      links: {},
      nested: {},
      notes: [],
      ...describeWriteRefusal(err)
    }
  }
}

/**
 * What a create leaves behind that its return value cannot say: the new id
 * when the creator's own read-back hides the record (a User Scope or row
 * filter excludes it, so createOne returns null), and the alias links that did
 * not land. Pass an empty object as `opts.outcome` and createOne fills it in.
 */
export interface CreateOutcome {
  id?: string | number
  readable?: boolean
  linkFailures?: string[]
  /** The natural key matched an existing record: this "create" updated it. */
  upserted?: boolean
}

const outOfView = new WeakSet<object>()

/**
 * createOne never answers null: a record its writer cannot read back (a User
 * Scope or row filter hides it as written) comes back as `{ id }` alone,
 * marked here. Every caller that reads `.id` off a create — routes, imports,
 * inbound mappings, GraphQL, flows — therefore gets the id of the row it made
 * instead of crashing or reporting "failed" for a row that exists (a retry
 * then made it twice). `isOutOfView` tells the two apart.
 */
function markOutOfView(id: string | number): Record<string, unknown> {
  const stub = { id }
  outOfView.add(stub)
  return stub
}

/** True for createOne's `{ id }` stand-in for a row its writer cannot read. */
export function isOutOfView(item: unknown): boolean {
  return !!item && typeof item === 'object' && outOfView.has(item as object)
}

/** createOne, plus the new record's id even when the creator cannot read it
 *  back, and the links that did not land — for every route that answers a
 *  create (a null read-back must never turn into "failed" or a crash). */
export async function createOneReported(
  user: User,
  collection: string,
  data: Record<string, unknown>,
  req?: FastifyRequest,
  workspaceId?: string
): Promise<{
  item: Record<string, unknown> | null
  id: string | number | null
  readable: boolean
  linkFailures: string[]
  upserted: boolean
}> {
  const outcome: CreateOutcome = {}
  const item = (await createOne(user, collection, data, req, workspaceId, {
    outcome,
    scopeGuard: true,
    callerPayload: true
  })) as Record<string, unknown> | null
  const hidden = item == null || isOutOfView(item)
  const id = (item?.id as string | number | undefined) ?? outcome.id ?? null
  return {
    item: hidden ? null : item,
    id,
    readable: !hidden,
    linkFailures: outcome.linkFailures ?? [],
    upserted: outcome.upserted === true
  }
}

export async function createOne(
  user: User,
  collection: string,
  data: Record<string, unknown>,
  req?: FastifyRequest,
  workspaceId?: string,
  opts?: {
    skipRollupRecalc?: boolean
    dryRun?: { insert: boolean }
    outcome?: CreateOutcome
    /** Judge this create with the create scope guard (create-scope-guard.ts). */
    scopeGuard?: boolean
    /** The payload is the caller's own (write routes): read-only fields are dropped too. */
    callerPayload?: boolean
  }
) {
  await assertServable(user, collection, 'create')
  const dry = opts?.dryRun ?? null
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)
  // Contract check on the RAW caller payload, before rules/computed passes
  // reshape it — the contract judges what the integration actually sent.
  await enforceContracts(collection, user?.id, data, 'create')
  // Creator, stamps, read-only and unlisted fields are the server's — dropped
  // before the nested sets and the caller's field list are read off the payload.
  await dropServerSetFields(user, collection, data, 'create', req, opts?.callerPayload === true)
  if (opts?.callerPayload) await trimSingleLineInputs(collection, data)
  // Nested child sets leave the payload BEFORE anything reads it as columns.
  let nestedWrites = await extractAliasO2MWrites(collection, data)
  data = await coerceRelationObjects(collection, data)
  let aliasWrites = await extractAliasM2MWrites(collection, data)
  // The fields the CALLER explicitly sent, captured before any rule, autofill
  // or computed pass mutates the payload — explicit values always win over
  // layout autofill, and validation only ever judges what the caller wrote.
  const callerFields = new Set(Object.keys(data))
  callerFields.delete('_change_reason')
  // A create may carry a provenance note the same way an update carries a
  // change reason ("import:Bid Import:<file>") — stripped before any column
  // write, stored on the activity row so history can say where a line came from.
  let createReason =
    typeof (data as Record<string, unknown>)._change_reason === 'string'
      ? String((data as Record<string, unknown>)._change_reason).trim()
      : ''
  delete (data as Record<string, unknown>)._change_reason

  const allowed = await can(user, 'create', collection)
  if (!allowed) throw new ForbiddenError()
  // A new child row of a record waiting on someone else (edit-lock.ts).
  if (!dry) await assertNotEditLocked(user, collection, { payload: data }, req)

  // Natural-key upsert: when the collection declares upsert_keys and a row
  // already matches every key in this payload, the create becomes an update
  // of that row — the collection stays one-row-per-key no matter which client
  // writes (form grid, REST, GraphQL integration). Judged on the caller's raw
  // payload; the update path applies its own permission/RLS/hook contract.
  const upsertTarget = await findUpsertTarget(
    collection,
    col as { upsert_keys?: string | null },
    data
  )
  if (upsertTarget != null && dry) {
    if (!(await can(user, 'update', collection))) throw new ForbiddenError()
    // A rehearsal echoes the matched row only as the caller reads it — a
    // natural key never reaches past a User Scope, row filter or field list.
    // (The real path's updateOne applies the same gates to the write.)
    const current = (await readOne(user, collection, upsertTarget, workspaceId)) as Record<
      string,
      unknown
    > | null
    if (!current) throw new ItemNotFoundError()
    const cols = await getActualColumns(collection)
    const sent = filterToActualColumns(data, cols)
    const changes = Object.entries(sent)
      .filter(([k, v]) => k !== 'id' && !sameStored(current[k], v))
      .map(([field, to]) => ({ field, from: current[field] ?? null, to }))
    const report: DryRunReport = {
      dry_run: true,
      ok: true,
      status: 201,
      would: 'update',
      data: { ...current, ...Object.fromEntries(changes.map((c) => [c.field, c.to])) },
      matched_id: upsertTarget,
      keys: upsertKeysOf(col as { upsert_keys?: string | null }),
      changes,
      filled: [],
      ignored: Object.keys(data).filter((k) => !cols.has(k) && k !== '_change_reason'),
      links: Object.fromEntries(aliasWrites.map((w) => [w.field, w.ids])),
      nested: {},
      notes: [
        'The natural key matched an existing record, so the create would update it. The update was not rehearsed: rules and validation of the update did not run.'
      ]
    }
    dryReports.add(report)
    return report
  }
  if (upsertTarget != null) {
    // A create-shaped write cannot carry a human change reason (the caller
    // did not know it was editing), so the change-reason requirement takes a
    // stated default rather than rejecting the write with a 422.
    const patch =
      '_change_reason' in data
        ? data
        : { ...data, _change_reason: 'Natural-key upsert (create matched an existing record)' }
    const updated = await updateOne(user, collection, upsertTarget, patch, req, workspaceId)
    if (opts?.outcome) {
      opts.outcome.id = upsertTarget
      opts.outcome.readable = updated != null
      opts.outcome.upserted = true
    }
    const answer = (updated as Record<string, unknown> | null) ?? markOutOfView(upsertTarget)
    upsertMarks.set(answer, {
      matched_id: upsertTarget,
      keys: upsertKeysOf(col as { upsert_keys?: string | null })
    })
    return answer
  }

  // Change reason on CREATE (config on_create): judged on the caller's raw
  // payload, same as the update path — only fields the caller wrote count.
  const crCreateConfig = parseChangeReasonConfig(
    (col as unknown as { change_reason_config?: string | null }).change_reason_config
  )
  // The throw waits until the before hooks have run: an extension hook may
  // supply the reason on the caller's behalf (an integration that cannot
  // send one — e.g. a GraphQL integration's creates), which is a stated provenance, not a
  // bypass. Flagged fields are still judged on what the CALLER wrote.
  const createFlagged =
    crCreateConfig?.on_create && !createReason
      ? crCreateConfig.fields.filter(
          (f) =>
            callerFields.has(f) &&
            (data as Record<string, unknown>)[f] != null &&
            (data as Record<string, unknown>)[f] !== ''
        )
      : []

  // Workspace item quota — checked against the active workspace (default when unscoped)
  const quotaWorkspace = workspaceId ?? (await fetchDefaultWorkspaceId())
  const quota = await checkQuota(quotaWorkspace, 'items')
  if (!quota.allowed) {
    throw new QuotaExceededError('items', quota.current, quota.limit as number)
  }

  const ctx = {
    collection,
    action: 'create' as const,
    payload: data,
    user,
    database: db,
    req,
    ...(dry ? { dryRun: true } : {})
  }
  await hooks.trigger('before', ctx)
  // Values the linked records supply (the form copies them when the link is
  // picked). After the hooks, which may set the link; before the rules, which
  // may read what was copied.
  await applyCrossRecordDefaults({
    collection,
    payload: ctx.payload as Record<string, unknown>,
    callerFields,
    user
  })
  // A before-hook may ADD or change alias M2M links (an extension deriving a
  // record's regions from its location) — re-read them off the hooked
  // payload; the first pass already normalised the caller's own to id arrays,
  // so this is idempotent for everything the caller sent.
  aliasWrites = await extractAliasM2MWrites(collection, ctx.payload as Record<string, unknown>)
  nestedWrites = mergeO2MWrites(
    nestedWrites,
    await extractAliasO2MWrites(collection, ctx.payload as Record<string, unknown>)
  )

  if (typeof (ctx.payload as Record<string, unknown>)._change_reason === 'string') {
    if (!createReason)
      createReason = String((ctx.payload as Record<string, unknown>)._change_reason).trim()
    delete (ctx.payload as Record<string, unknown>)._change_reason
  }
  if (crCreateConfig && createFlagged.length > 0 && !createReason)
    throw new ChangeReasonRequiredError(
      createFlagged,
      crCreateConfig,
      data as Record<string, unknown>
    )

  // before_create rules — may mutate the payload (e.g. set_field)
  await evaluateRules(collection, 'before_create', ctx.payload)

  // Field rules — apply inline field defaults based on other field values
  await applyFieldRules(collection, ctx.payload)

  // Layout row-rule autofill — the grid rules the admin form runs per row
  // (derived category from the picked item, task precedence chain, line type
  // from the parent's type) now apply to API creates too. Fills only fields
  // the caller left out; never throws.
  // Locked child-row fields (layout 'lock' row rules) are never caller-set —
  // drop them first so the autofill below owns their value.
  await applyRowLocksOnWrite(collection, ctx.payload, callerFields, null, req?.isAdmin ?? false)
  await applyRowRulesOnCreate(collection, ctx.payload, callerFields)

  // Datetime auto-fields — on_create: 'now' sets the field to current timestamp
  await applyDatetimeAutoFields(collection, ctx.payload, 'on_create')

  // Audit specials — fields declared `user-created` / `date-created` get the
  // acting user and the current time unless the caller set them explicitly.
  await applyAuditSpecials(collection, ctx.payload, user, 'create', callerFields)

  // Auto-ID generation — fill any auto_id fields not explicitly provided
  await applyAutoIdsExt(db, collection, ctx.payload, dry ? { peek: true } : undefined)

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

  // Limits of the relation this row belongs to (unique rows per parent, links
  // per record), where the relation says they bind every writer.
  await enforceRelationLimits(collection, ctx.payload as Record<string, unknown>)
  // Values the field's picker would not offer for this record, where the
  // field says its picker rules bind every writer.
  await enforcePickerRules({
    collection,
    row: ctx.payload as Record<string, unknown>,
    callerFields
  })

  // Encrypt configured encrypted fields just before write
  const securedPayload = await encryptItemFields(collection, ctx.payload)

  const actualCols = await getActualColumns(collection)
  await dropComputedColumns(collection, securedPayload)
  await assertNumbersFit(collection, securedPayload)
  await assertStringsFit(collection, securedPayload)
  await assertLinkedFilesReadable(collection, securedPayload, callerFields, req)
  await (await import('./file-access.js')).assertEmbeddedFilesReadable(
    collection,
    ctx.payload as Record<string, unknown>,
    req
  )
  if (dry) {
    const writable = filterToActualColumns(securedPayload, actualCols)
    const notes: string[] = []
    let storedRow: Record<string, unknown> | null = null
    if (dry.insert && !/^nivaro_|^directus_/i.test(collection)) {
      // The database's own word on the row: tried, read back, rolled back.
      const trx = await db.transaction()
      try {
        const back = (await withTriggerSafeReturning(collection, (opts) =>
          trx(collection).insert(writable).returning('*', opts)
        )) as unknown[]
        storedRow = (back[0] ?? null) as Record<string, unknown> | null
      } finally {
        await trx.rollback().catch(() => {})
      }
    } else {
      notes.push('The insert itself was not tried, so refusals of the database are not covered.')
    }
    const plain = ctx.payload as Record<string, unknown>
    const would: Record<string, unknown> = { ...(storedRow ?? {}) }
    for (const k of Object.keys(writable)) would[k] = plain[k]
    if (!callerFields.has('id')) would.id = null
    const nested: Record<string, DryRunNestedRow[]> = {}
    for (const w of nestedWrites) {
      const list: DryRunNestedRow[] = []
      for (let i = 0; i < w.rows.length; i++) {
        const { [w.fk]: _parent, ...row } = w.rows[i]
        try {
          const r = await rehearseCreate(user, w.collection, row, req, workspaceId, {
            insert: false,
            callerPayload: opts?.callerPayload === true
          })
          list.push({
            index: i,
            ok: r.ok,
            data: r.data,
            ...(r.ok ? {} : { status: r.status, error: r.error, code: r.code })
          })
        } catch (err) {
          const d = describeWriteRefusal(err)
          list.push({
            index: i,
            ok: false,
            status: err instanceof ForbiddenError ? 403 : d.status,
            error: err instanceof ForbiddenError ? 'Forbidden' : d.error,
            code: d.code
          })
        }
      }
      nested[w.field] = list
    }
    if (nestedWrites.length > 0)
      notes.push(
        'Child rows were checked without their parent, which does not exist: rules that read the parent record did not run for them.'
      )
    const childFailed = Object.values(nested).some((l) => l.some((r) => !r.ok))
    const filled = Object.keys(writable).filter(
      (k) => !callerFields.has(k) && plain[k] !== null && plain[k] !== undefined
    )
    const known = new Set([
      ...actualCols,
      ...aliasWrites.map((w) => w.field),
      ...nestedWrites.map((w) => w.field)
    ])
    const report: DryRunReport = {
      dry_run: true,
      ok: !childFailed,
      status: childFailed ? 422 : 201,
      would: 'create',
      data: would,
      filled,
      ignored: [...callerFields].filter((k) => !known.has(k)),
      links: Object.fromEntries(aliasWrites.map((w) => [w.field, w.ids])),
      nested,
      notes,
      ...(childFailed
        ? {
            error: 'A child row would be refused, so nothing would be created',
            code: 'NESTED_ROW_REFUSED'
          }
        : {})
    }
    dryReports.add(report)
    return report
  }
  // Everything from the insert on is one unit of work (#793): the outbound
  // effects of this row AND of the child rows it creates wait until the whole
  // create has landed, and are dropped when a child is refused and the parent
  // undone.
  return withUnitOfWork(`create:${collection}`, async () => {
    // A table with a trigger refuses the plain OUTPUT knex compiles `.returning` to.
    const rows = (await withTriggerSafeReturning(collection, (opts) =>
      db(collection).insert(filterToActualColumns(securedPayload, actualCols)).returning('id', opts)
    )) as unknown[]
    const id = rows[0] as { id: string | number } | string | number
    const returnedId =
      typeof id === 'object' && id !== null ? (id as { id: string | number }).id : id

    // Count the new item against the workspace quota (non-fatal)
    await incrementUsage(quotaWorkspace, 'items').catch(() => {})

    // Alias M2M links BEFORE the read-back — the junction creates recompute any
    // auto-id fields drawing on them, so the response already carries the
    // rendered name/prefix the caller asked for.
    const linkFailures: string[] = []
    await applyAliasM2MWrites(user, returnedId as string | number, aliasWrites, req, linkFailures)

    // Create scope guard (CREATE_SCOPE_GUARD=on, default off): a User-Scoped
    // creator whose new record would be outside their own scope is refused
    // and the row taken back out — checked once the links that usually place
    // it in a scope exist, before child sets, hooks and outbound effects.
    // Only the caller's own record (opts.scopeGuard, set by the write routes):
    // the junction and child rows a create makes on the way are never judged
    // alone — a link written before the Zone link would read as out of scope.
    {
      const guard = await import('./create-scope-guard.js')
      if (opts?.scopeGuard && guard.createScopeGuardOn()) {
        const refusal = await guard.outOfScopeRefusal(
          user,
          !!req?.isAdmin,
          collection,
          returnedId as string | number
        )
        if (refusal) {
          await undoNewParent(collection, returnedId as string | number, aliasWrites)
          throw refusal
        }
      }
    }

    // Nested child sets (lines, forecasts…) — before the read-back so stored
    // rollups over them are already in the response, and before the after-hooks
    // so a failed child set leaves no trace of the parent either.
    if (nestedWrites.length > 0) {
      try {
        await applyAliasO2MWrites(
          user,
          returnedId as string | number,
          nestedWrites,
          req,
          workspaceId,
          true,
          opts?.callerPayload === true
        )
      } catch (err) {
        await undoNewParent(collection, returnedId as string | number, aliasWrites)
        throw err
      }
    }

    const result = await readOne(user, collection, returnedId as string | number)
    if (opts?.outcome) {
      opts.outcome.id = returnedId as string | number
      opts.outcome.readable = result != null
      opts.outcome.linkFailures = linkFailures
    }

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

    await hooks.trigger('after', {
      ...ctx,
      keys: [returnedId as string | number],
      result,
      changeReason: createReason || undefined
    })

    // Auto-watch (#400): creators subscribe to their own records when the
    // preference says so — fire-and-forget.
    void deferEffect('auto-watch', () =>
      import('./auto-watch.js')
        .then(({ ensureAutoWatch }) =>
          ensureAutoWatch(user?.id, collection, returnedId as string | number, 'created')
        )
        .catch(() => {})
    )

    void deferEffect('realtime:create', async () => {
      broadcastCollectionUpdate(req?.server?.io, collection, returnedId as string | number, {
        action: 'create'
      })
      await broadcastJunctionParents(req, collection, [
        (result ?? ctx.payload) as Record<string, unknown>
      ])
    })

    // Hidden from its own writer: the id, never null (see markOutOfView).
    return result ?? markOutOfView(returnedId as string | number)
  })
}

/**
 * May this person update THIS record — the gates updateOne applies before it
 * writes: servable, can(update), the tree permission on the item and the
 * update policy's row filter within the workspace. Visibility (readOne) and
 * field-level rules are not judged here. For routes that change something
 * about a record without writing its row (picker exclusions).
 */
export async function canUpdateItem(
  user: User,
  collection: string,
  id: string | number,
  workspaceId?: string
): Promise<boolean> {
  try {
    await assertServable(user, collection, 'update')
    assertRecordId(id)
  } catch {
    return false
  }
  if (!(await can(user, 'update', collection))) return false
  if ((await getTreePermission(user, 'update', collection, id)) === false) return false
  const rowFilter = await getRowFilter(user, 'update', collection)
  const q = db(collection).where({ id }).select('id')
  await applyWorkspaceScope(q, collection, workspaceId)
  if (rowFilter) applyRowFilter(q, rowFilter, user)
  ;(await writeScopeFor(user, collection)).apply(q)
  return !!(await q.first())
}

export async function updateOne(
  user: User,
  collection: string,
  id: string | number,
  data: Record<string, unknown>,
  req?: FastifyRequest,
  workspaceId?: string,
  opts?: {
    outcome?: CreateOutcome
    /** The payload is the caller's own (write routes): read-only fields are dropped too. */
    callerPayload?: boolean
  }
) {
  await assertServable(user, collection, 'update')
  assertRecordId(id)
  if (!(await idFitsCollection(collection, id))) throw new ItemNotFoundError()
  await enforceContracts(collection, user?.id, data, 'update')
  // Creator, stamps, read-only and unlisted fields are the server's (see createOne).
  await dropServerSetFields(user, collection, data, 'update', req, opts?.callerPayload === true)
  if (opts?.callerPayload) await trimSingleLineInputs(collection, data)
  let nestedWrites = await extractAliasO2MWrites(collection, data)
  data = await coerceRelationObjects(collection, data)
  let aliasWrites = await extractAliasM2MWrites(collection, data)
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)

  const allowed = await can(user, 'update', collection)
  if (!allowed) throw new ForbiddenError()
  // Row-level security + User Scopes — a record the caller cannot reach is a
  // 404 before anything reads it or any hook runs; both also bind the
  // previousData read and the UPDATE itself below.
  const rowFilter = await getRowFilter(user, 'update', collection)
  const writeScope = await writeScopeFor(user, collection)
  await assertWritableRow(collection, id, user, writeScope, rowFilter, workspaceId)

  // The fields the caller explicitly sent — validation only judges these.
  const callerFields = new Set(Object.keys(data))
  callerFields.delete('_change_reason')
  callerFields.delete('_base_revision')

  // Change reason rides the payload as a virtual `_change_reason` key — strip
  // it before anything downstream sees it (it must never reach a column write)
  let changeReason =
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
      .select('id', 'delta', 'data')) as Array<{
      id: number
      delta: string | null
      data: string | null
    }>
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
        const currentRow = (await db(collection).where({ id }).first()) as
          | Record<string, unknown>
          | undefined
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
  // While the record (or its parent) waits on someone, only its creator, the
  // step's owners and admins may change it (edit-lock.ts).
  await assertNotEditLocked(user, collection, { ids: [id], payload: data }, req)

  const ctx = {
    collection,
    action: 'update' as const,
    keys: [id],
    payload: data,
    user,
    database: db,
    req
  }
  // Before-hooks see the change reason the caller (or the natural-key upsert
  // branch) supplied and may REPLACE it — an extension speaking for an
  // integration names the real writer instead of a generic default — or
  // supply one where the caller could not. Re-injected for the hooks only;
  // stripped again right after so it never reaches a column write.
  if (changeReason) (ctx.payload as Record<string, unknown>)._change_reason = changeReason
  await span('hooks:before-update', () => hooks.trigger('before', ctx))
  // Same as createOne: a before-hook may add alias M2M links.
  aliasWrites = await extractAliasM2MWrites(collection, ctx.payload as Record<string, unknown>)
  nestedWrites = mergeO2MWrites(
    nestedWrites,
    await extractAliasO2MWrites(collection, ctx.payload as Record<string, unknown>)
  )
  if (typeof (ctx.payload as Record<string, unknown>)._change_reason === 'string') {
    changeReason = String((ctx.payload as Record<string, unknown>)._change_reason).trim()
  }
  delete (ctx.payload as Record<string, unknown>)._change_reason

  const prevQ = db(collection).where({ id }).select('*')
  await applyWorkspaceScope(prevQ, collection, workspaceId)
  if (rowFilter) applyRowFilter(prevQ, rowFilter, user)
  writeScope.apply(prevQ)
  const previousData = (await prevQ.first()) as Record<string, unknown> | undefined

  // Cross-workspace, row-filtered-out, out-of-scope or missing row → 404 when scoping is active
  if (!previousData) {
    if (rowFilter || writeScope.restricts) throw new ItemNotFoundError()
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
    if (flaggedChanged.length > 0)
      throw new ChangeReasonRequiredError(flaggedChanged, crConfig, previousData)
  }

  // Values the linked records supply, when the write changes the link.
  if (previousData) {
    const filledByLink = await span('cross-record-defaults', () =>
      applyCrossRecordDefaults({
        collection,
        payload: ctx.payload as Record<string, unknown>,
        callerFields,
        user,
        previous: previousData,
        id
      })
    )
    if (filledByLink.length > 0) {
      aliasWrites = await extractAliasM2MWrites(collection, ctx.payload as Record<string, unknown>)
    }
  }

  // before_update rules — may mutate the payload (e.g. set_field)
  await span('rules:before-update', () =>
    evaluateRules(collection, 'before_update', ctx.payload, previousData)
  )

  // Field rules — apply inline field defaults based on other field values
  await span('field-rules', () => applyFieldRules(collection, ctx.payload))
  await span('row-locks', () =>
    applyRowLocksOnWrite(
      collection,
      ctx.payload,
      callerFields,
      previousData ?? null,
      req?.isAdmin ?? false
    )
  )
  // #25 — a layout section locked for the caller's role: its fields are
  // read-only on the form and dropped here (admins exempt).
  if (!req?.isAdmin) {
    await span('section-locks', () =>
      applySectionLocks(collection, ctx.payload, user.role ?? null, false)
    )
  }
  // Layout row rules flagged on_update re-derive their targets when the PATCH
  // changed one of their triggers (caller-sent targets still win).
  await span('row-rules:update', () =>
    applyRowRulesOnUpdate(collection, ctx.payload, callerFields, previousData ?? null)
  )

  // Datetime auto-fields — on_update: 'now' sets the field to current timestamp
  await applyDatetimeAutoFields(collection, ctx.payload, 'on_update')

  // Write-time computed fields — merge previous data as context so formula can read existing fields
  const writeCtx = { ...(previousData ?? {}), ...ctx.payload }
  await span('computed-fields:write', () =>
    applyWriteComputedFields(collection, ctx.payload, writeCtx, { previous: previousData ?? null })
  )

  // Field validation rules on the caller's fields (see createOne), judged on
  // the row as it will be stored — a cross-field rule reads the stored other.
  await enforceValidationRules(collection, ctx.payload, callerFields, previousData ?? null)

  // Limits of the relation this row belongs to, judged on the row as it
  // would be stored and only when the write touches what the limit reads.
  if (previousData) {
    const touched = new Set(
      Object.keys(ctx.payload).filter(
        (k) => String(previousData[k] ?? '') !== String(ctx.payload[k] ?? '')
      )
    )
    if (touched.size > 0) await enforceRelationLimits(collection, writeCtx, id, touched)
    await enforcePickerRules({ collection, row: writeCtx, callerFields, id })
  }

  // Auto-ID prefix recompute — if a relation an auto_id pattern depends on
  // just changed (e.g. re-parenting to a different project), re-render the
  // prefix while preserving the existing sequence suffix. Skips fields the
  // caller explicitly set and fields whose relation inputs didn't change.
  for (const { field, config } of await autoIdFieldsFor(db, collection)) {
    if (field in ctx.payload) continue // explicit value provided — don't override

    let parsed: ReturnType<typeof parseAutoIdPattern> | null
    try {
      parsed = parseAutoIdPattern(resolveAutoIdPattern(config, writeCtx))
    } catch {
      continue
    }

    const firstSegs = parsed.tokens.filter((t) => t.kind === 'relation').map((t) => t.path[0])
    const variantFlip = autoIdVariantFields(config).some((f) => f in ctx.payload)
    if (!variantFlip && !firstSegs.some((seg) => seg in ctx.payload)) continue

    const newVal = await recomputeAutoIdPrefix(db, collection, field, config, id, writeCtx)
    if (newVal != null && newVal !== previousData?.[field]) {
      ctx.payload[field] = newVal
    }
  }

  // Encrypt configured encrypted fields just before write
  const securedPayload = await encryptItemFields(collection, ctx.payload)

  const actualCols = await getActualColumns(collection)
  await dropComputedColumns(collection, securedPayload)
  await assertNumbersFit(collection, securedPayload)
  await assertStringsFit(collection, securedPayload)
  await assertLinkedFilesReadable(collection, securedPayload, callerFields, req, previousData)
  await (await import('./file-access.js')).assertEmbeddedFilesReadable(
    collection,
    ctx.payload as Record<string, unknown>,
    req,
    previousData
  )
  const columnPayload = filterToActualColumns(securedPayload, actualCols)
  // A payload of only alias/virtual fields (e.g. an M2A alias like
  // internal_contact) leaves nothing to write — knex throws on an empty
  // .update(). Skip the UPDATE but still run the read-back + after hooks so
  // the call stays a graceful no-op instead of a 500.
  if (Object.keys(columnPayload).length > 0) {
    // Audit specials — `user-updated` / `date-updated` fields follow every
    // real column write (never a no-op update, so they cannot manufacture one).
    await applyAuditSpecials(collection, columnPayload, user, 'update', callerFields, actualCols)
    await span('update', async () => {
      const updQ = db(collection).where({ id })
      await applyWorkspaceScope(updQ, collection, workspaceId)
      if (rowFilter) applyRowFilter(updQ, rowFilter, user)
      writeScope.apply(updQ)
      await updQ.update(columnPayload)
    })
  }
  // Alias M2M links (additive) before the read-back — see extractAliasM2MWrites
  const linkFailures: string[] = []
  await applyAliasM2MWrites(user, id, aliasWrites, req, linkFailures)
  if (opts?.outcome) opts.outcome.linkFailures = linkFailures
  // Nested child sets are ADDED to the record (rows without an id only).
  if (nestedWrites.length > 0)
    await applyAliasO2MWrites(
      user,
      id,
      nestedWrites,
      req,
      workspaceId,
      false,
      opts?.callerPayload === true
    )

  const result = await span('read-back', () => readOne(user, collection, id, workspaceId))
  if (opts?.outcome) {
    opts.outcome.id = id
    opts.outcome.readable = result != null
  }

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

  // A presence heartbeat sends no collection:update, but a move to another page still
  // reaches open Online lists through the coalesced presence:changed.
  if (isPresencePageChange(collection, columnPayload, previousData))
    notePresencePageChange(String(id))

  void deferEffect('realtime:update', async () => {
    broadcastCollectionUpdate(req?.server?.io, collection, id, {
      action: 'update',
      changed_fields: Object.keys(columnPayload ?? {})
    })
    // Both parents when the row moved from one record to another.
    if (Object.keys(columnPayload ?? {}).length > 0)
      await broadcastJunctionParents(req, collection, [
        previousData,
        { ...(previousData ?? {}), ...columnPayload }
      ])
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
  await assertServable(user, collection, 'delete')
  assertRecordId(id)
  if (!(await idFitsCollection(collection, id))) throw new ItemNotFoundError()
  const col = await getCollection(collection)
  if (!col) throw new CollectionNotFoundError(collection)

  const allowed = await can(user, 'delete', collection)
  if (!allowed) throw new ForbiddenError()

  // Tree permissions — restriction only: an explicit deny on the item or its
  // nearest matching ancestor blocks the delete; null/true changes nothing.
  const treeAllow = await getTreePermission(user, 'delete', collection, id)
  if (treeAllow === false) throw new ForbiddenError()
  // Row-level security + User Scopes bind the previousData fetch and the
  // mutation; a record outside them is a 404 (see updateOne).
  const rowFilter = await getRowFilter(user, 'delete', collection)
  const writeScope = await writeScopeFor(user, collection)
  await assertWritableRow(collection, id, user, writeScope, rowFilter, workspaceId)
  await assertNotEditLocked(user, collection, { ids: [id] }, req)

  const prevQ = db(collection).where({ id }).select('*')
  await applyWorkspaceScope(prevQ, collection, workspaceId)
  if (rowFilter) applyRowFilter(prevQ, rowFilter, user)
  writeScope.apply(prevQ)
  const previousData = (await prevQ.first()) as Record<string, unknown> | undefined

  // Cross-workspace, row-filtered-out, out-of-scope or missing row → 404 when scoping is active
  if (!previousData) {
    if (rowFilter || writeScope.restricts) throw new ItemNotFoundError()
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
    const guards = guardRaw ? (JSON.parse(String(guardRaw)) as Array<Record<string, unknown>>) : []
    for (const g of Array.isArray(guards) ? guards : []) {
      if (g.type === 'children') {
        const child = String(g.collection ?? '')
        const fk = String(g.fk_field ?? '')
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(child) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fk))
          continue
        const row = await db(child)
          .where(fk, id)
          .first('id')
          .catch(() => undefined)
        if (row) {
          throw new DeleteGuardError(
            String(
              g.message ??
                `This record has linked ${child.replace(/_/g, ' ')} and cannot be deleted`
            )
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
  writeScope.apply(delQ)
  await delQ.delete()

  // Trash safety net — full-row snapshot, restorable for 30 days
  if (previousData) void writeTrashRow(collection, previousData, user.id)

  // The record's open tasks are cancelled with it, and reopen on restore
  // (#1006). Deferred, so a unit of work that rolls back touches nothing.
  if (previousData)
    void deferEffect('tasks:record-deleted', async () => {
      const { onRecordDeleted } = await import('./tasks.js')
      await onRecordDeleted(collection, id, user.id).catch(() => 0)
    })

  // Recalc any stored rollups the deleted row contributed to (never throws)
  await recalcAffectedRollups(collection, null, previousData)

  // If this collection is an M2M junction table, recompute any parent auto_id
  // fields whose pattern draws from it (never throws).
  await recomputeJunctionAutoIds(collection, previousData)

  await hooks.trigger('after', { ...ctx, previousData })

  void deferEffect('realtime:delete', async () => {
    broadcastCollectionUpdate(req?.server?.io, collection, id, { action: 'delete' })
    await broadcastJunctionParents(req, collection, [previousData])
  })
}
