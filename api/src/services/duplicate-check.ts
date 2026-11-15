/**
 * Likely duplicates for a record being created (Rob 2026-11-13, criteria 2026-11-14).
 *
 * The new-record form asks here as the person types; the import preview asks for every
 * row it would create; the items service refuses exact copies where a collection says so.
 * WHAT counts as a duplicate is services/duplicate-rules.ts (setting, plan, predicates,
 * verdicts); this module reads the facts it needs and runs the statements.
 *
 * Default: ON for every registered non-system collection, comparing each text field of the
 * display template (exact, folded, typo) — `browser_config.duplicate_check` can turn it
 * off, pick fields, or give custom rules combined with AND (see duplicate-rules.ts).
 *
 * Matching is judged AS THE CALLER: candidate statements carry the caller's read gate
 * (searchAccessClause: row filter + User Scopes) and every candidate is read again through
 * the items service as the caller, so a record the person may not read never shows — and
 * a set of rules naming a field they may not read is never checked for them. Statements
 * run under one time budget (DUPLICATE_BUDGET_MS); a cut pass answers `partial`.
 *
 * Cost: on a big table (> CLOSE_ROW_LIMIT rows) a set runs only when one rule seeks an
 * index; nothing here scans a big table (plan statuses say what is skipped and why).
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { fuzzyStatement } from '../routes/global-search.js'
import type { ItemsQuery, User } from '../types.js'
import { tenantState } from './ai-tenant-state.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { resolveDisplayValue } from './display-value.js'
import {
  blockable,
  type ColumnFacts,
  type DuplicateCheckSetting,
  type DuplicatePlan,
  exactKey,
  filterPredicates,
  foldKey,
  foldSqlExpr,
  groupPredicate,
  groupStatement,
  idValue,
  liveRules,
  MAX_VALUE_LENGTH,
  type MatchKind,
  MIN_VALUE_LENGTH,
  numberValue,
  type PlanField,
  type PlannedGroup,
  type PlannedRule,
  type PlanRelation,
  parseDuplicateCheck,
  planDuplicateCheck,
  type Stmt,
  SYSTEM_COLLECTION,
  sqlFoldValue,
  templateFields,
  textValue,
  titleOf,
  verifyGroup
} from './duplicate-rules.js'
import { getAllowedFields } from './permissions.js'
import { tableFacts } from './picker-typo.js'
import { type AccessClause, onIdExpr, searchAccessClause } from './search-access.js'
import { SearchBudget } from './search-budget.js'
import { BINARY_COLLATION, onMssql, type TextKind } from './search-like.js'

export type { MatchKind } from './duplicate-rules.js'
export {
  CLOSE_ROW_LIMIT,
  classifyMatch,
  exactKey,
  foldKey,
  MAX_VALUE_LENGTH,
  MIN_VALUE_LENGTH,
  parseDuplicateCheck,
  sqlFoldValue,
  templateFields
} from './duplicate-rules.js'

/** Matches answered per set of rules. */
export const MAX_MATCHES = 5
/** Candidates each statement keeps. */
const CANDIDATES = 10
/** The whole lookup's time budget (the form asks while someone types). */
export const DUPLICATE_BUDGET_MS = 1500

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

// ─── Facts ─────────────────────────────────────────────────────────────────

const COLUMN_TTL_MS = 60_000
const columnCache = tenantState(() => new Map<string, { at: number; facts: ColumnFacts | null }>())

/** Every column (name → SQL type) and the columns leading an enabled index. Null off SQL
 *  Server or when the catalog cannot be read (then nothing counts as indexed). */
export async function columnFacts(collection: string): Promise<ColumnFacts | null> {
  if (!IDENT.test(collection) || !onMssql()) return null
  const cache = columnCache()
  const hit = cache.get(collection)
  if (hit && Date.now() - hit.at < COLUMN_TTL_MS) return hit.facts
  let facts: ColumnFacts | null = null
  try {
    const rows = (await db.raw(
      `SELECT c.name AS column_name, ty.name AS data_type,
         CASE WHEN EXISTS (
           SELECT 1 FROM sys.index_columns ic
           JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
           WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id
             AND ic.key_ordinal = 1 AND i.is_disabled = 0 AND i.is_hypothetical = 0
         ) THEN 1 ELSE 0 END AS leading
       FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       WHERE c.object_id = OBJECT_ID(?)`,
      [collection]
    )) as Array<{ column_name: string; data_type: string; leading: number | boolean }>
    if (rows?.length) {
      facts = { columns: new Map(), leading: new Set() }
      for (const r of rows) {
        facts.columns.set(r.column_name, String(r.data_type).toLowerCase())
        if (Number(r.leading) === 1 || r.leading === true) facts.leading.add(r.column_name)
      }
    }
  } catch {
    facts = null
  }
  if (cache.size > 2000) cache.clear()
  cache.set(collection, { at: Date.now(), facts })
  return facts
}

export interface DuplicateConfig extends DuplicatePlan {
  kinds: Record<string, TextKind>
  template: string | null
  label: string
  collection: string
  /** Field → its display name (notes and refusals). */
  fieldLabels: Record<string, string>
}

/** The collection's plan (metadata and table facts are cached). `setting` overrides the
 *  stored one (the settings card previews an unsaved draft). */
export async function duplicateConfig(
  collection: string,
  setting?: DuplicateCheckSetting
): Promise<DuplicateConfig | null> {
  if (!IDENT.test(collection)) return null
  const col = (await getCollection(collection).catch(() => null)) as
    | ({ browser_config?: unknown; display_template?: string | null } & Record<string, unknown>)
    | null
    | undefined
  if (!col) return null
  const [facts, fields, relations, columns] = await Promise.all([
    tableFacts(collection).catch(() => null),
    getFields(collection).catch(() => []),
    getRelations(collection).catch(() => []),
    columnFacts(collection)
  ])
  const s = setting ?? parseDuplicateCheck(col.browser_config)
  // Line collections named by shared-lines rules.
  const childFacts = new Map<string, { rows: number | null; columns: ColumnFacts | null }>()
  const children = new Set<string>()
  for (const r of s.rules ?? []) {
    if (r.match !== 'shared') continue
    const rel = (relations as PlanRelation[]).find(
      (x) => x.one_collection === collection && x.one_field === r.field && !x.junction_field
    )
    if (rel && IDENT.test(rel.many_collection)) children.add(rel.many_collection)
  }
  await Promise.all(
    [...children].map(async (c) => {
      const [tf, cf] = await Promise.all([tableFacts(c).catch(() => null), columnFacts(c)])
      childFacts.set(c, { rows: tf ? tf.rows : null, columns: cf })
    })
  )
  const plan = planDuplicateCheck({
    collection,
    setting: s,
    template: col.display_template ?? null,
    fields: fields as PlanField[],
    relations: relations as PlanRelation[],
    rows: facts ? facts.rows : null,
    kinds: facts?.kinds ?? {},
    columns,
    child: (c) => childFacts.get(c)
  })
  const label =
    String(col.singular ?? '').trim() ||
    String(col.display_name ?? '').trim() ||
    collection.replace(/_/g, ' ')
  const fieldLabels: Record<string, string> = {}
  for (const f of fields as PlanField[]) fieldLabels[f.field] = titleOf(f.field, f)
  return {
    ...plan,
    kinds: facts?.kinds ?? {},
    template: col.display_template ?? null,
    label,
    collection,
    fieldLabels
  }
}

// ─── The lookup ────────────────────────────────────────────────────────────

export interface DuplicateMatch {
  id: string
  /** The record's label (display template, else the compared value). */
  label: string
  /** The anchor field's stored value. */
  value: string
  match: MatchKind
  score: number
}

export interface DuplicateWatch {
  field: string
  kind: PlannedRule['kind']
  line_field?: string
  child?: string
  fk?: string
}

export interface DuplicateAnswer {
  enabled: boolean
  /** Every field the caller's sets compare (the form sends these). */
  fields: string[]
  /** What each compared field is (the form reads lines from its staged rows). */
  watch: DuplicateWatch[]
  /** The sets: anchor field (where the notice shows) and the fields it compares. */
  sets: Array<{ anchor: string; fields: string[] }>
  block_exact: boolean
  close: boolean
  label: string
  matches: Record<string, DuplicateMatch[]>
  /** A pass ran out of time: the answer may miss a match. */
  partial?: boolean
}

export interface DuplicateRunner {
  run(label: string, sql: string, bindings: readonly unknown[]): Promise<Array<{ id: unknown }>>
  finish(): void
  readonly partial: boolean
}

export interface DuplicateDeps {
  config: (collection: string) => Promise<DuplicateConfig | null>
  allowed: (user: User, collection: string) => Promise<string[] | null>
  access: (user: User, collection: string) => Promise<AccessClause | null>
  runner: () => DuplicateRunner
  read: (
    user: User,
    collection: string,
    query: ItemsQuery,
    req?: FastifyRequest
  ) => Promise<Array<Record<string, unknown>>>
  mssql: () => boolean
}

function budgetRunner(): DuplicateRunner {
  const budget = new SearchBudget(DUPLICATE_BUDGET_MS, 3)
  let cut = false
  return {
    async run(label, sql, bindings) {
      try {
        return await budget.runQuery<{ id: unknown }>(label, sql, bindings)
      } catch {
        cut = true
        return []
      }
    },
    finish: () => {
      cut = cut || budget.timedOut.size > 0
      budget.finish()
    },
    get partial() {
      return cut || budget.timedOut.size > 0
    }
  }
}

export const defaultDuplicateDeps: DuplicateDeps = {
  config: (c) => duplicateConfig(c),
  allowed: (user, collection) => getAllowedFields(user, 'read', collection).catch(() => []),
  access: (user, collection) => searchAccessClause(user, collection).catch(() => null),
  runner: budgetRunner,
  read: async (user, collection, query, req) => {
    const { readItems } = await import('./items.js')
    const res = await readItems(user, collection, query, req)
    return (res?.data ?? []) as Array<Record<string, unknown>>
  },
  mssql: onMssql
}

const readableBy = (allowed: string[] | null) => (f: string) =>
  allowed == null || allowed.includes('*') || allowed.includes(f)

/** The sets `user` gets checked: running ones whose every field they may read. */
export function groupsFor(cfg: DuplicatePlan, allowed: string[] | null): PlannedGroup[] {
  if (!cfg.enabled) return []
  const can = readableBy(allowed)
  return cfg.groups.filter((g) => g.runs && liveRules(g).every((r) => can(r.field)))
}

/** The fields `user` gets compared (every live rule field of their sets). */
export function fieldsFor(cfg: DuplicatePlan, allowed: string[] | null): string[] {
  return [...new Set(groupsFor(cfg, allowed).flatMap((g) => liveRules(g).map((r) => r.field)))]
}

/** What the form watches, per field (the config answer). */
export function watchFor(groups: PlannedGroup[]): DuplicateWatch[] {
  const out = new Map<string, DuplicateWatch>()
  for (const g of groups)
    for (const r of liveRules(g))
      if (!out.has(r.field))
        out.set(r.field, {
          field: r.field,
          kind: r.kind,
          ...(r.kind === 'lines' ? { line_field: r.line_field, child: r.child, fk: r.fk } : {})
        })
  return [...out.values()]
}

const filtersOf = (cfg: DuplicatePlan & { collection: string }) =>
  filterPredicates({
    collection: cfg.collection,
    within_days: cfg.within_days,
    created_field: cfg.created_field,
    ignore_states: cfg.ignore_states
  })

/** The candidate statements of one set: the set itself, plus a typo pass per near text
 *  rule (small tables only) that keeps every other rule, the filters and the gate. */
export function groupStatements(
  cfg: DuplicateConfig,
  group: PlannedGroup,
  values: Record<string, unknown>,
  access: AccessClause | null,
  mssql: boolean
): Array<[string, Stmt]> {
  const filters = filtersOf(cfg)
  const opts = { mssql, kinds: cfg.kinds, filters, access }
  const main = groupStatement(cfg.collection, group, values, { ...opts, top: CANDIDATES })
  if (!main) return []
  const out: Array<[string, Stmt]> = [['dup-set', main]]
  if (!cfg.close) return out
  for (const r of liveRules(group)) {
    if (r.kind !== 'text' || r.match !== 'close') continue
    const v = textValue(values[r.field])
    if (!v || foldKey(v).length < 5) continue
    const rest = groupPredicate(group, values, { ...opts, access: null, skip: r })
    const gate = onIdExpr(access, 't.[id]')
    const where: AccessClause | null =
      rest && rest.sql !== '1 = 1'
        ? gate
          ? { sql: `${rest.sql} AND (${gate.sql})`, bindings: [...rest.bindings, ...gate.bindings] }
          : rest
        : gate
    const fz = fuzzyStatement(
      [{ collection: cfg.collection, cols: [r.field], kinds: cfg.kinds, access: where }],
      v,
      mssql,
      CANDIDATES
    )
    if (fz) out.push(['dup-typo', fz])
  }
  return out
}

/**
 * Likely duplicates of `values` (field → typed value) in `collection`, as `user` sees the
 * collection. `excludeId` drops the record being edited.
 */
export async function findDuplicates(
  user: User,
  collection: string,
  values: Record<string, unknown>,
  opts: { excludeId?: string | number | null; limit?: number; req?: FastifyRequest } = {},
  deps: DuplicateDeps = defaultDuplicateDeps
): Promise<DuplicateAnswer> {
  const cfg = await deps.config(collection)
  const none: DuplicateAnswer = {
    enabled: false,
    fields: [],
    watch: [],
    sets: [],
    block_exact: false,
    close: false,
    label: cfg?.label ?? collection,
    matches: {}
  }
  if (!cfg?.enabled) return none
  const allowed = await deps.allowed(user, collection)
  const groups = groupsFor(cfg, allowed)
  const answer: DuplicateAnswer = {
    enabled: groups.length > 0,
    fields: fieldsFor(cfg, allowed),
    watch: watchFor(groups),
    sets: groups.map((g) => ({ anchor: g.anchor, fields: liveRules(g).map((r) => r.field) })),
    block_exact: cfg.block_exact,
    close: cfg.close,
    label: cfg.label,
    matches: {}
  }
  if (groups.length === 0) return answer

  const access = await deps.access(user, collection)
  const mssql = deps.mssql()
  const planned = groups
    .map((g) => ({ g, stmts: groupStatements(cfg, g, values, access, mssql) }))
    .filter((x) => x.stmts.length > 0)
  if (planned.length === 0) return answer
  const runner = deps.runner()
  const candidates = new Map<PlannedGroup, Set<string>>()
  try {
    await Promise.all(
      planned.map(async ({ g, stmts }) => {
        const ids = new Set<string>()
        candidates.set(g, ids)
        const results = await Promise.all(
          stmts.map(([label, s]) => runner.run(label, s.sql, s.bindings))
        )
        for (const rows of results) for (const r of rows) if (r?.id != null) ids.add(String(r.id))
      })
    )
  } finally {
    runner.finish()
  }
  if (runner.partial) answer.partial = true

  const exclude = opts.excludeId == null ? null : String(opts.excludeId)
  const allIds = [...new Set([...candidates.values()].flatMap((s) => [...s]))].filter(
    (id) => id !== exclude
  )
  if (allIds.length === 0) return answer

  // Read again AS THE CALLER: only records (and fields) they may read survive.
  const can = readableBy(allowed)
  const labelFields = templateFields(cfg.template).filter((f) => IDENT.test(f) && can(f))
  const compared = [
    ...new Set(
      planned.flatMap(({ g }) =>
        liveRules(g)
          .filter((r) => r.kind !== 'lines')
          .map((r) => r.field)
      )
    )
  ]
  let rows: Array<Record<string, unknown>> = []
  try {
    rows = await deps.read(
      user,
      collection,
      {
        filter: { id: { _in: allIds } },
        fields: [...new Set(['id', ...compared, ...labelFields])],
        limit: allIds.length,
        count: false
      } as ItemsQuery,
      opts.req
    )
  } catch {
    return answer
  }
  const limit = Math.max(1, Math.min(MAX_MATCHES, opts.limit ?? MAX_MATCHES))
  for (const { g } of planned) {
    const ids = candidates.get(g) ?? new Set<string>()
    const out: DuplicateMatch[] = []
    for (const row of rows) {
      const id = String(row.id)
      if (!ids.has(id) || id === exclude) continue
      const verdict = verifyGroup(g, values, row)
      if (!verdict) continue
      const stored = row[g.anchor]
      const value =
        stored == null ? '' : typeof stored === 'object' ? (idValue(stored) ?? '') : String(stored)
      const label = cfg.template ? resolveDisplayValue(row, cfg.template) : ''
      out.push({ id, label: label || value || `#${id}`, value, ...verdict })
    }
    out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    if (out.length) {
      const prior = answer.matches[g.anchor] ?? []
      const merged = [...prior, ...out.filter((m) => !prior.some((p) => p.id === m.id))]
      answer.matches[g.anchor] = merged.slice(0, limit)
    }
  }
  return answer
}

// ─── Block exact duplicates on create (items service) ─────────────────────

/**
 * Refuses a create that copies an existing record exactly on one of the collection's sets
 * of rules, when the collection says `block_exact`. Judged against EVERY record (a copy is
 * a copy whoever can see it); the refusal names the existing record only when the caller
 * may read it. One statement per set (exact predicates only), only on collections that
 * block — every other create pays nothing beyond the (cached) metadata read. A set that
 * cannot seek a big table, or compares lines, never blocks. A failing check never blocks.
 */
export async function enforceDuplicateBlock(
  user: User,
  collection: string,
  payload: Record<string, unknown>,
  browserConfig: unknown
): Promise<void> {
  if (SYSTEM_COLLECTION.test(collection)) return
  const setting = parseDuplicateCheck(browserConfig)
  if (setting.mode === 'off' || !setting.block_exact) return
  const cfg = await duplicateConfig(collection).catch(() => null)
  if (!cfg?.enabled || !cfg.block_exact) return
  const filters = filtersOf(cfg)
  for (const g of cfg.groups) {
    if (!blockable(g)) continue
    const fields = liveRules(g).map((r) => r.field)
    let hit: Record<string, unknown> | null = null
    try {
      const stmt = groupStatement(collection, g, payload, {
        mssql: onMssql(),
        kinds: cfg.kinds,
        filters,
        access: null,
        top: 5,
        exactOnly: true,
        columns: fields
      })
      if (!stmt) continue
      const rows = (await db.raw(stmt.sql, stmt.bindings as never)) as Array<
        Record<string, unknown>
      >
      hit = (rows ?? []).find((r) => verifyGroup(g, payload, r, true)) ?? null
    } catch {
      hit = null
    }
    if (!hit) continue
    const id = String(hit.id)
    let readable = false
    try {
      const { readOne } = await import('./items.js')
      readable = (await readOne(user, collection, id, undefined, ['id'])) != null
    } catch {
      readable = false
    }
    const anchor = g.anchor
    const typed = payload[anchor]
    // An unreadable record is named by the caller's own text, never its stored spelling.
    const shown = String(
      readable && hit[anchor] != null ? hit[anchor] : typeof typed === 'object' ? '' : (typed ?? '')
    ).trim()
    const single = fields.length === 1 && g.rules[0].kind === 'text'
    const names = fields.map((f) => cfg.fieldLabels[f] ?? titleOf(f)).join(', ')
    const what = single ? `named "${shown}"` : `with the same ${names}`
    throw Object.assign(
      new Error(
        `A ${cfg.label} ${what} already exists${readable ? ' — open it instead of creating a copy' : ''}.`
      ),
      {
        statusCode: 400,
        code: 'DUPLICATE_RECORD',
        field: anchor,
        value: shown,
        ...(readable ? { existing_id: id } : {})
      }
    )
  }
}

// ─── Import preview: rows that would create a copy ────────────────────────

export interface ImportDuplicateRow {
  /** The file's row number (header = 1). */
  row: number
  /** The set's anchor field. */
  field: string
  value: string
  match: MatchKind
  /** The existing record it copies (absent for a repeat inside the file). */
  existing_id?: string
  existing_value?: string
  /** An earlier row of the same file with the same values. */
  first_row?: number
}

export interface ImportDuplicateSummary {
  fields: string[]
  /** Rows that copy an existing record exactly (case and spacing ignored). */
  exact_rows: number
  /** Rows that nearly copy one. */
  close_rows: number
  /** Rows that repeat an earlier row of the same file. */
  in_file_rows: number
  /** Whether the near-copy pass ran (tables up to CLOSE_ROW_LIMIT rows). */
  close: boolean
  rows: ImportDuplicateRow[]
  /** Sets of rules the import preview could not check, in plain words. */
  skipped?: string[]
}

/** Existing rows whose `driver` matches one of `keys` (exact, or folded for text), with
 *  `columns`, under the set's filters. */
export type ImportDuplicateFetch = (args: {
  driver: PlannedRule
  pass: 'exact' | 'fold'
  keys: string[]
  columns: string[]
  filters: Stmt[]
}) => Promise<Array<Record<string, unknown>>>

/** Rows fetched per chunk of keys at most (a link shared by many records stays bounded). */
const IMPORT_FETCH_TOP = 5000

/** Raw reads: the import preview is administrators only and compares against every record,
 *  like the import itself. */
export function dbImportFetch(collection: string): ImportDuplicateFetch {
  return async ({ driver, pass, keys, columns, filters }) => {
    const { selectInChunks } = await import('./db-batch.js')
    const cols = [...new Set(['id', ...columns])].filter((c) => IDENT.test(c))
    const select = cols.map((c) => (c === 'id' ? 'CAST(t.[id] AS nvarchar(64)) AS id' : `t.[${c}]`))
    const extra = filters.map((f) => ` AND (${f.sql})`).join('')
    const extraBindings = filters.flatMap((f) => f.bindings)
    const col = `t.[${driver.field}]`
    const cmp =
      pass === 'fold'
        ? `UPPER(${foldSqlExpr(col)}) COLLATE ${BINARY_COLLATION} IN (SELECT [value] COLLATE ${BINARY_COLLATION} FROM OPENJSON(?))`
        : `${col} IN (SELECT [value] FROM OPENJSON(?))`
    return (await selectInChunks(keys, 1000, async (chunk) => {
      const rows = await db.raw(
        `SELECT TOP ${IMPORT_FETCH_TOP} ${select.join(', ')} FROM [${collection}] AS t WHERE ${cmp}${extra}`,
        [JSON.stringify(chunk), ...extraBindings] as never
      )
      return (rows ?? []) as Array<Record<string, unknown>>
    })) as Array<Record<string, unknown>>
  }
}

/** The rule an import reads existing rows by (bulk key lookups), or why there is none. */
export function importDriver(g: PlannedGroup): PlannedRule | string {
  if (!g.runs) return 'skipped on this table'
  const live = liveRules(g)
  if (live.some((r) => r.kind === 'lines')) return 'compares lines, which an import does not carry'
  const seekable = (r: PlannedRule) => r.status === 'ok' || r.status === 'limited'
  const pick =
    live.find((r) => r.kind === 'text' && seekable(r)) ??
    live.find((r) => r.kind === 'number' && r.match === 'equal' && seekable(r)) ??
    live.find((r) => r.kind === 'relation' && seekable(r))
  return pick ?? 'has no exact text, number or link rule to look records up by'
}

const keyOf = (r: PlannedRule, v: unknown, pass: 'exact' | 'fold'): string | null => {
  if (r.kind === 'text') {
    const t = textValue(v)
    if (!t) return null
    return pass === 'fold' ? sqlFoldValue(t) : t
  }
  if (r.kind === 'number') {
    const n = numberValue(v)
    return n == null ? null : String(n)
  }
  const id = idValue(v)
  return id
}

const bucketOf = (r: PlannedRule, v: unknown): string | null => {
  if (r.kind === 'text') {
    const t = textValue(v)
    if (!t) return null
    return r.match === 'exact' ? exactKey(t) : foldKey(t) || exactKey(t)
  }
  const k = keyOf(r, v, 'exact')
  return k == null ? null : k.toLowerCase()
}

/**
 * The rows of an import that would create a copy of an existing record (or of an earlier
 * row of the same file), by the collection's sets of rules. `rows` are the rows the import
 * would CREATE (row number + mapped values). Null when the collection does not check
 * duplicates or no set's fields are all mapped. The typo pass does not run here.
 */
export async function importDuplicateScan(
  collection: string,
  rows: Array<{ row: number; values: Record<string, unknown> }>,
  deps: {
    config?: (collection: string) => Promise<DuplicateConfig | null>
    fetch?: ImportDuplicateFetch
  } = {}
): Promise<ImportDuplicateSummary | null> {
  const cfg = await (deps.config ?? ((c: string) => duplicateConfig(c)))(collection).catch(
    () => null
  )
  if (!cfg?.enabled) return null
  const mapped = cfg.groups.filter(
    (g) => g.runs && liveRules(g).every((r) => rows.some((x) => r.field in x.values))
  )
  if (mapped.length === 0) return null
  const fetch = deps.fetch ?? dbImportFetch(collection)
  const filters = filtersOf(cfg)
  const summary: ImportDuplicateSummary = {
    fields: mapped.map((g) => g.anchor),
    exact_rows: 0,
    close_rows: 0,
    in_file_rows: 0,
    close: cfg.close,
    rows: []
  }
  const skipped: string[] = []
  const name = (g: PlannedGroup) =>
    liveRules(g)
      .map((r) => cfg.fieldLabels[r.field] ?? titleOf(r.field))
      .join(' + ')
  const textOf = (v: unknown) =>
    v == null
      ? ''
      : typeof v === 'object'
        ? (idValue(v) ?? '')
        : String(v).trim().slice(0, MAX_VALUE_LENGTH)

  // Per set: existing rows found by the driver's key (exact, and folded for near text).
  const found = new Map<
    PlannedGroup,
    { driver: PlannedRule; byKey: Map<string, Array<Record<string, unknown>>> }
  >()
  for (const g of mapped) {
    const driver = importDriver(g)
    if (typeof driver === 'string') {
      skipped.push(`${name(g)}: ${driver}`)
      continue
    }
    const byKey = new Map<string, Array<Record<string, unknown>>>()
    found.set(g, { driver, byKey })
    const columns = liveRules(g).map((r) => r.field)
    const add = (rs: Array<Record<string, unknown>>) => {
      for (const r of rs) {
        const k = bucketOf(driver, r[driver.field])
        if (k == null) continue
        const list = byKey.get(k) ?? []
        if (list.length < 20 && !list.some((x) => String(x.id) === String(r.id))) list.push(r)
        byKey.set(k, list)
      }
    }
    const exactKeys = [
      ...new Set(rows.map((r) => keyOf(driver, r.values[driver.field], 'exact')).filter(Boolean))
    ] as string[]
    try {
      if (exactKeys.length)
        add(await fetch({ driver, pass: 'exact', keys: exactKeys, columns, filters }))
      if (driver.kind === 'text' && driver.match !== 'exact' && driver.near) {
        const foldKeys = [
          ...new Set(
            rows
              .map((r) => keyOf(driver, r.values[driver.field], 'fold'))
              .filter((k): k is string => !!k && k.length >= MIN_VALUE_LENGTH)
          )
        ]
        if (foldKeys.length)
          add(await fetch({ driver, pass: 'fold', keys: foldKeys, columns, filters }))
      }
    } catch {
      // The preview still answers; this set just is not checked.
      skipped.push(`${name(g)}: the lookup failed`)
    }
  }

  const seen = new Map<
    PlannedGroup,
    Map<string, Array<{ row: number; values: Record<string, unknown> }>>
  >()
  for (const g of found.keys()) seen.set(g, new Map())
  for (const r of rows) {
    let hit: ImportDuplicateRow | null = null
    for (const [g, { driver, byKey }] of found) {
      const bucket = bucketOf(driver, r.values[driver.field])
      if (bucket == null) continue
      const value = textOf(r.values[g.anchor])
      let best: { row: Record<string, unknown>; match: MatchKind; score: number } | null = null
      for (const existing of byKey.get(bucket) ?? []) {
        const v = verifyGroup(g, r.values, existing)
        if (v && (!best || v.score > best.score)) best = { row: existing, ...v }
      }
      if (best) {
        hit = {
          row: r.row,
          field: g.anchor,
          value,
          match: best.match,
          existing_id: String(best.row.id),
          existing_value: textOf(best.row[g.anchor])
        }
      } else {
        for (const earlier of seen.get(g)?.get(bucket) ?? []) {
          const v = verifyGroup(g, r.values, earlier.values)
          if (v) {
            hit = { row: r.row, field: g.anchor, value, match: v.match, first_row: earlier.row }
            break
          }
        }
      }
      const prior = seen.get(g)?.get(bucket) ?? []
      if (prior.length < 20) prior.push(r)
      seen.get(g)?.set(bucket, prior)
      if (hit) break
    }
    if (!hit) continue
    if (hit.first_row != null) summary.in_file_rows++
    else if (hit.match === 'exact') summary.exact_rows++
    else summary.close_rows++
    if (summary.rows.length < 50) summary.rows.push(hit)
  }
  if (skipped.length) summary.skipped = skipped
  return summary
}
