import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { clearMetadataCache } from '../collections.js'
import { bustDefinitionCache } from '../definition-cache.js'
import { startJobRun } from '../job-runs.js'
import { bustFreshnessInference } from '../query-freshness.js'
import { isReplicatedArticle, isReplicatedProcedure } from '../replication.js'
import {
  bustRollupContributorCache,
  parseRollupFormula,
  recalcRollupsForParent
} from '../rollups.js'
import { runLongSql } from '../run-long.js'
import { indexDefinition, isMssqlDb, procedureBody } from './dmv.js'
import { getProposal } from './ledger.js'
import { readTuningSettings } from './settings.js'
import { bodyHash, renameProcHeader } from './twin.js'
import {
  type ApplySpec,
  IDENT,
  OPEN_STATUSES,
  type ProposalRow,
  type TuningStatus
} from './types.js'
import { captureBaseline } from './watch.js'

/**
 * Apply, roll back and dismiss — the only path in database tuning that writes a real index,
 * procedure, field config or query config. Nothing here takes a statement from a request: the
 * proposal row carries apply/undo (built from catalog names by its observer), and every name in
 * them is parsed into a fixed shape and re-checked against sys.* before it runs. SQL is never
 * executed as stored: an index statement runs as the canonical rendering of what was parsed.
 */

export class TuningRefusal extends Error {
  constructor(
    public code: 'TUNING_STALE' | 'TUNING_REPLICATED' | 'TUNING_NOT_APPLICABLE' | 'TUNING_INVALID',
    message: string,
    public status: 400 | 409 = 409,
    /** Extra fields for the response body (a replicated refusal carries target + statements). */
    public detail?: Record<string, unknown>
  ) {
    super(message)
  }
}

export interface LiveState {
  indexExists: boolean | null
  procHash: string | null
  fieldStore: boolean | null
  queryRow: { cache_ttl: number; warm_daily: boolean } | null
  /** index_create: the table and every key column are in sys.columns. */
  columnsExist?: boolean | null
  /** The live index rebuilt as a CREATE (dmv `indexDefinition`); null = absent or unrebuildable. */
  indexDefinition?: string | null
}

const T = 'nivaro_tuning_proposals'
const APPLY_FROM: readonly TuningStatus[] = ['proposed']
const ROLLBACK_FROM: readonly TuningStatus[] = ['watching', 'applied']
/** The transient status an apply or a rollback holds while it runs (the claim). */
const CLAIMED: readonly TuningStatus[] = ['applying']
const DISMISS_FROM: readonly TuningStatus[] = [...OPEN_STATUSES, 'failed']
/** WITH options an index_create may carry: build-time knobs and storage, never semantics. */
const CREATE_OPTIONS = new Set([
  'ONLINE',
  'SORT_IN_TEMPDB',
  'DATA_COMPRESSION',
  'FILLFACTOR',
  'MAXDOP'
])
const MAX_TTL_SECONDS = 86_400
const BACKFILL_PROGRESS_EVERY = 500

const rowsOf = (r: unknown) => (Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [])
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const truthy = (v: unknown) => v === true || v === 1 || v === '1'
const invalid = (message: string) => new TuningRefusal('TUNING_INVALID', message, 400)

// ─── Index statements: the only SQL shapes Apply runs ───────────────────────────────────

type Tok = { k: 'name' | 'word' | 'num' | 'str' | 'op'; v: string }

// `[ident]` · [N]'…' literal ('' escapes) · bare word · number · operator. Anything else — a
// dot, a comment, a variable, a stray bracket — fails the tokenizer and the statement with it.
const TOKEN =
  /\s*(?:\[([A-Za-z_][A-Za-z0-9_]*)\]|(N?'(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|(<>|!=|<=|>=|[=<>(),;]))/y

function tokenize(sql: string): Tok[] | null {
  const re = new RegExp(TOKEN.source, 'y')
  const out: Tok[] = []
  let at = 0
  while (!/^\s*$/.test(sql.slice(at))) {
    re.lastIndex = at
    const m = re.exec(sql)
    if (!m) return null
    at = re.lastIndex
    if (m[1]) out.push({ k: 'name', v: m[1] })
    else if (m[2]) out.push({ k: 'str', v: m[2] })
    else if (m[3]) out.push({ k: 'word', v: m[3] })
    else if (m[4]) out.push({ k: 'num', v: m[4] })
    else out.push({ k: 'op', v: m[5] })
  }
  return out
}

/** Bare words that are grammar, never a name. */
const RESERVED = new Set([
  'ASC',
  'CLUSTERED',
  'CREATE',
  'DESC',
  'DROP',
  'INCLUDE',
  'INDEX',
  'NONCLUSTERED',
  'ON',
  'UNIQUE',
  'WHERE',
  'WITH'
])
const FILTER_WORDS = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'IN'])
const FILTER_OPS = new Set(['=', '<>', '!=', '<', '<=', '>', '>='])
const ON_OFF = ['ON', 'OFF']
/** WITH options a rebuilt definition can carry; DROP_EXISTING (replaces an index) is not one. */
const INDEX_OPTIONS: Record<string, 'percent' | 'count' | string[]> = {
  FILLFACTOR: 'percent',
  PAD_INDEX: ON_OFF,
  IGNORE_DUP_KEY: ON_OFF,
  STATISTICS_NORECOMPUTE: ON_OFF,
  ALLOW_ROW_LOCKS: ON_OFF,
  ALLOW_PAGE_LOCKS: ON_OFF,
  SORT_IN_TEMPDB: ON_OFF,
  ONLINE: ON_OFF,
  DATA_COMPRESSION: ['NONE', 'ROW', 'PAGE'],
  MAXDOP: 'count'
}

export interface IndexStatement {
  op: 'create' | 'drop'
  name: string
  table: string
  unique: boolean
  keys: Array<{ column: string; desc: boolean }>
  include: string[]
  /** The filter predicate, re-rendered from validated tokens; null when unfiltered. */
  filter: string | null
  filterColumns: string[]
  options: string[]
  fileGroup: string | null
}

/**
 * Parse `CREATE [UNIQUE] NONCLUSTERED INDEX name ON table (col [ASC|DESC], …) [INCLUDE (…)]
 * [WHERE …] [WITH (…)] [ON filegroup]` or `DROP INDEX name ON table`; null for anything else.
 * Names are one IDENT, bracketed or bare (no schema prefix). A filter holds bracketed columns,
 * literals, comparisons, AND/OR/NOT/IS/NULL/IN and parentheses only.
 */
export function parseIndexStatement(sql: string): IndexStatement | null {
  const toks = tokenize(sql)
  if (!toks) return null
  let i = 0
  const word = (w: string) => {
    const t = toks[i]
    if (t?.k !== 'word' || t.v.toUpperCase() !== w) return false
    i++
    return true
  }
  const op = (o: string) => {
    const t = toks[i]
    if (t?.k !== 'op' || t.v !== o) return false
    i++
    return true
  }
  const ident = (): string | null => {
    const t = toks[i]
    if (!t || (t.k !== 'name' && t.k !== 'word') || !IDENT.test(t.v)) return null
    if (t.k === 'word' && RESERVED.has(t.v.toUpperCase())) return null
    i++
    return t.v
  }
  const list = <V>(item: () => V | null): V[] | null => {
    if (!op('(')) return null
    const out: V[] = []
    do {
      const v = item()
      if (v == null) return null
      out.push(v)
    } while (op(','))
    return op(')') ? out : null
  }
  const end = () => {
    op(';')
    return i === toks.length
  }
  const base = { unique: false, keys: [], include: [], filter: null, filterColumns: [] }

  if (word('DROP')) {
    if (!word('INDEX')) return null
    const name = ident()
    if (!name || !word('ON')) return null
    const table = ident()
    if (!table || !end()) return null
    return { ...base, op: 'drop', name, table, options: [], fileGroup: null }
  }

  if (!word('CREATE')) return null
  const unique = word('UNIQUE')
  if (!word('NONCLUSTERED') || !word('INDEX')) return null
  const name = ident()
  if (!name || !word('ON')) return null
  const table = ident()
  if (!table) return null
  const keys = list(() => {
    const column = ident()
    if (!column) return null
    const desc = word('DESC')
    if (!desc) word('ASC')
    return { column, desc }
  })
  if (!keys) return null
  let include: string[] = []
  if (word('INCLUDE')) {
    const l = list(ident)
    if (!l) return null
    include = l
  }
  let filter: string | null = null
  const filterColumns: string[] = []
  if (word('WHERE')) {
    const parts: string[] = []
    let depth = 0
    for (; i < toks.length; i++) {
      const t = toks[i]
      const upper = t.v.toUpperCase()
      if (depth === 0 && ((t.k === 'word' && (upper === 'WITH' || upper === 'ON')) || t.v === ';'))
        break
      if (t.k === 'name') {
        filterColumns.push(t.v)
        parts.push(`[${t.v}]`)
      } else if (t.k === 'word') {
        if (!FILTER_WORDS.has(upper)) return null
        parts.push(upper)
      } else if (t.k === 'num' || t.k === 'str') parts.push(t.v)
      else if (t.v === '(') {
        depth++
        parts.push('(')
      } else if (t.v === ')') {
        if (--depth < 0) return null
        parts.push(')')
      } else if (FILTER_OPS.has(t.v) || (t.v === ',' && depth > 0)) parts.push(t.v)
      else return null
    }
    if (depth !== 0 || !parts.length) return null
    filter = parts.join(' ')
  }
  let options: string[] = []
  if (word('WITH')) {
    const l = list(() => {
      const key = toks[i]?.k === 'word' ? toks[i].v.toUpperCase() : ''
      const allowed = INDEX_OPTIONS[key]
      if (!allowed) return null
      i++
      if (!op('=')) return null
      const v = toks[i]
      if (!v) return null
      if (allowed === 'percent' || allowed === 'count') {
        const n = Number(v.v)
        const max = allowed === 'percent' ? 100 : 64
        if (v.k !== 'num' || !/^\d+$/.test(v.v) || n > max || (allowed === 'percent' && n < 1))
          return null
      } else if (v.k !== 'word' || !allowed.includes(v.v.toUpperCase())) return null
      i++
      return `${key} = ${v.v.toUpperCase()}`
    })
    if (!l) return null
    options = l
  }
  let fileGroup: string | null = null
  if (word('ON')) {
    fileGroup = ident()
    if (!fileGroup) return null
  }
  if (!end()) return null
  return {
    op: 'create',
    name,
    table,
    unique,
    keys,
    include,
    filter,
    filterColumns,
    options,
    fileGroup
  }
}

/** The statement Apply actually runs: every name bracketed, nothing the parser did not accept. */
export function renderIndexStatement(s: IndexStatement): string {
  if (s.op === 'drop') return `DROP INDEX [${s.name}] ON [${s.table}]`
  const keys = s.keys.map((k) => `[${k.column}]${k.desc ? ' DESC' : ''}`).join(', ')
  return [
    `CREATE ${s.unique ? 'UNIQUE ' : ''}NONCLUSTERED INDEX [${s.name}] ON [${s.table}] (${keys})`,
    s.include.length ? ` INCLUDE (${s.include.map((c) => `[${c}]`).join(', ')})` : '',
    s.filter ? ` WHERE ${s.filter}` : '',
    s.options.length ? ` WITH (${s.options.join(', ')})` : '',
    s.fileGroup ? ` ON [${s.fileGroup}]` : ''
  ].join('')
}

/** Canonical form for comparing two definitions of one index: names and keywords case-folded,
 *  string literals kept exactly. */
const canonIndex = (sql: string): string | null => {
  const s = parseIndexStatement(sql)
  if (!s) return null
  return renderIndexStatement(s).replace(/'(?:[^']|'')*'|[^']+/g, (part) =>
    part.startsWith("'") ? part : part.toLowerCase()
  )
}

/** Same index by shape — name, table, keys (with direction), includes, uniqueness, filter.
 *  Build-time options (ONLINE, MAXDOP …) are not stored, so they are not compared. */
const sameIndexShape = (a: IndexStatement, b: IndexStatement): boolean => {
  const fold = (s: string) => s.toLowerCase()
  const keys = (s: IndexStatement) => s.keys.map((k) => `${fold(k.column)}${k.desc ? ' desc' : ''}`)
  return (
    fold(a.name) === fold(b.name) &&
    fold(a.table) === fold(b.table) &&
    keys(a).join(',') === keys(b).join(',') &&
    a.include.map(fold).join(',') === b.include.map(fold).join(',') &&
    a.unique === b.unique &&
    (a.filter ?? '') === (b.filter ?? '')
  )
}

/** What a created index may be: plain, unfiltered, default filegroup, build/storage options. */
function createApplyProblem(s: IndexStatement): string | null {
  if (s.unique) return 'an index_create may not be UNIQUE (it would change what inserts accept)'
  if (s.filter) return 'an index_create may not be filtered'
  if (s.fileGroup) return 'an index_create may not name a filegroup'
  const bad = s.options.map((o) => o.split(' ')[0]).filter((k) => !CREATE_OPTIONS.has(k))
  if (bad.length) return `an index_create may not set ${bad.join(', ')}`
  return null
}

// ─── Shape checks (pure) ────────────────────────────────────────────────────────────────

/** Pure: apply/undo fit the row's kind and target, and the undo reverses the apply. */
export function specsProblem(row: ProposalRow): string | null {
  const { apply, undo } = row
  const misfit = `the apply/undo type does not fit the proposal kind ${row.kind}`
  const dot = row.target.indexOf('.')
  const head = (dot < 0 ? row.target : row.target.slice(0, dot)).toLowerCase()
  const tail = dot < 0 ? '' : row.target.slice(dot + 1).toLowerCase()
  switch (row.kind) {
    case 'index_create':
    case 'index_drop': {
      if (apply.type !== 'sql' || undo.type !== 'sql') return misfit
      if (apply.statements.length !== 1) return 'an index proposal applies exactly one statement'
      if (undo.statements.length !== 1) return 'an index proposal undoes with exactly one statement'
      const a = parseIndexStatement(apply.statements[0])
      if (!a) return 'the apply statement is not an index create/drop over plain names'
      const u = parseIndexStatement(undo.statements[0])
      if (!u) return 'the undo statement is not an index create/drop over plain names'
      if (a.table.toLowerCase() !== head) return `the apply statement is not on the target table`
      const create = row.kind === 'index_create'
      if (a.op !== (create ? 'create' : 'drop'))
        return `a ${row.kind} applies a ${create ? 'CREATE' : 'DROP'} INDEX`
      if (
        u.op === a.op ||
        u.table.toLowerCase() !== head ||
        u.name.toLowerCase() !== a.name.toLowerCase()
      )
        return 'the undo does not reverse the apply on the same index'
      if (create && a.keys.map((k) => k.column.toLowerCase()).join(',') !== tail)
        return 'the index keys are not the target columns'
      // The full grammar is for restoring a recorded definition (an index_drop's undo) only.
      if (create) return createApplyProblem(a)
      if (!create && a.name.toLowerCase() !== tail) return 'the dropped index is not the target'
      return null
    }
    case 'proc_rewrite':
      if (apply.type !== 'proc_body' || undo.type !== 'proc_body') return misfit
      if (apply.proc !== row.target) return 'the apply procedure is not the target'
      if (undo.proc !== row.target) return 'the undo procedure is not the target'
      return null
    case 'rollup_store':
      if (apply.type !== 'field_patch' || undo.type !== 'field_patch') return misfit
      if (`${apply.collection}.${apply.field}` !== row.target) return 'the field is not the target'
      if (`${undo.collection}.${undo.field}` !== row.target)
        return 'the undo field is not the target'
      if (apply.patch.computed_store === undo.patch.computed_store)
        return 'the undo does not reverse the apply'
      return null
    case 'query_cache':
      if (apply.type !== 'query_patch' || undo.type !== 'query_patch') return misfit
      if (apply.slug !== row.target) return 'the query is not the target'
      if (undo.id !== apply.id || undo.slug !== apply.slug) return 'the undo is not the same query'
      return null
  }
}

/** Pure: why the live object no longer matches what the proposal was proved against, or null. */
export function revalidate(row: ProposalRow, live: LiveState): string | null {
  switch (row.kind) {
    case 'index_create':
      if (live.indexExists == null) return 'the live index catalog could not be read'
      if (live.indexExists) return 'the index already exists'
      if (live.columnsExist === false) return 'the table or a key column no longer exists'
      return null
    case 'index_drop': {
      if (live.indexExists == null) return 'the live index catalog could not be read'
      if (!live.indexExists) return 'the index no longer exists'
      const recorded = row.undo.type === 'sql' ? canonIndex(row.undo.statements[0] ?? '') : null
      const now = live.indexDefinition ? canonIndex(live.indexDefinition) : null
      return recorded && recorded === now ? null : 'the index definition changed since the proposal'
    }
    case 'proc_rewrite': {
      if (row.undo.type !== 'proc_body') return 'the undo is not a procedure body'
      if (!live.procHash) return 'the procedure no longer exists'
      return live.procHash === row.undo.hash
        ? null
        : 'the procedure body changed since the proof ran'
    }
    case 'rollup_store': {
      if (row.apply.type !== 'field_patch') return 'the apply is not a field patch'
      if (live.fieldStore == null) return 'the field is no longer a rollup'
      const want = row.apply.patch.computed_store
      return live.fieldStore === want ? `the field is already ${want ? 'stored' : 'virtual'}` : null
    }
    case 'query_cache': {
      if (row.undo.type !== 'query_patch') return 'the undo is not a query patch'
      if (!live.queryRow) return 'the query no longer exists'
      const from = row.undo.patch
      return live.queryRow.cache_ttl === from.cache_ttl &&
        live.queryRow.warm_daily === from.warm_daily
        ? null
        : 'the query settings changed since the proposal'
    }
  }
}

/** Pure: why running the undo now would clobber something other than our own change, or null. */
export function undoProblem(row: ProposalRow, live: LiveState): string | null {
  switch (row.kind) {
    case 'index_create': {
      if (live.indexExists == null) return 'the live index catalog could not be read'
      if (!live.indexExists) return 'the index the apply created no longer exists'
      // a same-named index someone rebuilt differently since is not ours to drop
      const created =
        row.apply.type === 'sql' ? parseIndexStatement(row.apply.statements[0] ?? '') : null
      const now = live.indexDefinition ? parseIndexStatement(live.indexDefinition) : null
      return created && now && sameIndexShape(created, now)
        ? null
        : 'the index changed since the apply'
    }
    case 'index_drop':
      if (live.indexExists == null) return 'the live index catalog could not be read'
      return live.indexExists ? 'an index of that name exists again' : null
    case 'proc_rewrite':
      if (row.apply.type !== 'proc_body') return 'the apply is not a procedure body'
      return live.procHash && live.procHash === row.apply.hash
        ? null
        : 'the procedure body changed since the apply'
    case 'rollup_store':
      return live.fieldStore === true ? null : 'the field is no longer a stored rollup'
    case 'query_cache': {
      if (row.apply.type !== 'query_patch') return 'the apply is not a query patch'
      const to = row.apply.patch
      return live.queryRow &&
        live.queryRow.cache_ttl === to.cache_ttl &&
        live.queryRow.warm_daily === to.warm_daily
        ? null
        : 'the query settings changed since the apply'
    }
  }
}

// ─── Live reads ─────────────────────────────────────────────────────────────────────────

async function tableColumns(table: string): Promise<Set<string>> {
  const rows = rowsOf(
    await db.raw(`SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID(?, 'U')`, [table])
  )
  return new Set(rows.map((r) => String(r.name).toLowerCase()))
}

async function indexRow(table: string, name: string): Promise<Record<string, unknown> | null> {
  const rows = rowsOf(
    await db.raw(
      `SELECT i.type_desc, i.is_primary_key, i.is_unique_constraint FROM sys.indexes i
        WHERE i.object_id = OBJECT_ID(?, 'U') AND i.name = ?`,
      [table, name]
    )
  )
  return rows[0] ?? null
}

/**
 * The live state `revalidate` / `undoProblem` judge. A sys.indexes / sys.columns read error
 * throws (nothing runs); the dmv readers (`indexDefinition`, `procedureBody`) answer null on an
 * error, which reads as "changed" — stale on apply, refused on rollback: the safe side.
 */
export async function readLiveState(row: ProposalRow): Promise<LiveState> {
  const live: LiveState = { indexExists: null, procHash: null, fieldStore: null, queryRow: null }
  switch (row.kind) {
    case 'index_create':
    case 'index_drop': {
      const s = row.apply.type === 'sql' ? parseIndexStatement(row.apply.statements[0] ?? '') : null
      if (!s || !isMssqlDb()) return live
      live.indexExists = (await indexRow(s.table, s.name)) != null
      if (row.kind === 'index_create') {
        const cols = await tableColumns(s.table)
        live.columnsExist = cols.size > 0 && s.keys.every((k) => cols.has(k.column.toLowerCase()))
      }
      live.indexDefinition = live.indexExists ? await indexDefinition(s.table, s.name) : null
      return live
    }
    case 'proc_rewrite': {
      const body = await procedureBody(row.target)
      live.procHash = body == null ? null : bodyHash(body)
      return live
    }
    case 'rollup_store': {
      if (row.apply.type !== 'field_patch') return live
      const { collection, field } = row.apply
      const f = (await db('nivaro_fields')
        .where({ collection, field })
        .first('computed_type', 'computed_formula', 'computed_store')) as
        | { computed_type: string | null; computed_formula: string | null; computed_store: unknown }
        | undefined
      const rollup = f?.computed_type === 'rollup' && parseRollupFormula(f.computed_formula ?? null)
      live.fieldStore = f && rollup ? truthy(f.computed_store) : null
      return live
    }
    case 'query_cache': {
      if (row.apply.type !== 'query_patch') return live
      const q = (await db('nivaro_custom_queries')
        .where({ id: row.apply.id })
        .first('slug', 'cache_ttl', 'warm_daily')) as
        | { slug: string; cache_ttl: number | null; warm_daily: unknown }
        | undefined
      // a renamed query is not the one the proposal measured
      live.queryRow =
        q && q.slug === row.apply.slug
          ? { cache_ttl: Number(q.cache_ttl ?? 0), warm_daily: truthy(q.warm_daily) }
          : null
      return live
    }
  }
}

/**
 * Recorded on the row, or a replication article now (the publication may postdate the proof).
 * A stored rollup counts: its column add is DDL on the collection's table.
 */
async function replicatedNow(row: ProposalRow): Promise<boolean> {
  if (row.replicated) return true
  if (row.kind === 'index_create' || row.kind === 'index_drop')
    return isReplicatedArticle(row.target.split('.')[0])
  if (row.kind === 'proc_rewrite') return isReplicatedProcedure(row.target)
  if (row.kind === 'rollup_store' && row.apply.type === 'field_patch')
    return isReplicatedArticle(row.apply.collection)
  return false
}

/** What the DBA is asked to let forward to subscribers — the replicated refusal carries it. */
function statementsOf(spec: ApplySpec): string[] {
  switch (spec.type) {
    case 'sql':
      return spec.statements.map((s) => {
        const p = parseIndexStatement(s)
        return p ? renderIndexStatement(p) : s
      })
    case 'proc_body':
      return [renameProcHeader(spec.body, spec.proc, spec.proc) ?? spec.body]
    case 'field_patch':
      return [`ALTER TABLE [${spec.collection}] ADD [${spec.field}] (stored rollup column)`]
    case 'query_patch':
      return []
  }
}

/** The catalog half of the statement check: every name exists (or, for a create, is free). */
async function catalogProblem(s: IndexStatement): Promise<string | null> {
  const cols = await tableColumns(s.table)
  if (!cols.size) return `table ${s.table} does not exist`
  const named = [...s.keys.map((k) => k.column), ...s.include, ...s.filterColumns]
  const missing = named.filter((c) => !cols.has(c.toLowerCase()))
  if (missing.length) return `column(s) ${missing.join(', ')} do not exist on ${s.table}`
  const ix = await indexRow(s.table, s.name)
  if (s.op === 'create') {
    if (ix) return `index ${s.name} already exists on ${s.table}`
    if (s.fileGroup) {
      const fg = rowsOf(
        await db.raw('SELECT 1 AS x FROM sys.data_spaces WHERE name = ?', [s.fileGroup])
      )
      if (!fg.length) return `filegroup ${s.fileGroup} does not exist`
    }
    return null
  }
  if (!ix) return `index ${s.name} does not exist on ${s.table}`
  if (
    ix.type_desc !== 'NONCLUSTERED' ||
    truthy(ix.is_primary_key) ||
    truthy(ix.is_unique_constraint)
  )
    return `${s.name} is not a plain nonclustered index`
  return null
}

// ─── Execute ────────────────────────────────────────────────────────────────────────────

const NUMERIC_COLUMN_TYPES = new Set(['integer', 'bigInteger', 'decimal', 'float'])

/** The stored rollup's column, as the Table Editor's Store toggle provisions it. */
function addRollupColumn(t: Knex.AlterTableBuilder, field: string, type: string): void {
  const col =
    type === 'integer'
      ? t.integer(field)
      : type === 'bigInteger'
        ? t.bigInteger(field)
        : type === 'float'
          ? t.float(field, 8)
          : t.decimal(field, 10, 2)
  col.nullable()
}

/**
 * Runs one spec; returns a one-line outcome. Every refusal (TuningRefusal) comes before the
 * first write; `ctx.began` fires immediately before that first write, so a caller knows
 * whether anything may need undoing.
 */
export async function executeSpec(
  spec: ApplySpec,
  ctx: {
    userId: string | null
    progress?: (blob: Record<string, unknown>) => void
    began?: () => void
  }
): Promise<string> {
  switch (spec.type) {
    case 'sql': {
      if (!isMssqlDb())
        throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'index changes run on SQL Server only')
      const parsed = spec.statements.map(parseIndexStatement)
      if (!parsed.length || parsed.some((s) => !s))
        throw invalid('a statement is not an index create/drop over plain names')
      const ran: string[] = []
      for (const s of parsed as IndexStatement[]) {
        const problem = await catalogProblem(s)
        if (problem) throw invalid(problem)
        const sql = renderIndexStatement(s)
        ctx.began?.()
        await runLongSql(sql)
        ran.push(sql)
      }
      return ran.join('; ')
    }
    case 'proc_body': {
      if (!isMssqlDb())
        throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'procedure changes run on SQL Server only')
      if (!IDENT.test(spec.proc) || bodyHash(spec.body) !== spec.hash)
        throw invalid('procedure body does not match its hash')
      // the header must name this procedure; it becomes CREATE OR ALTER PROCEDURE [dbo].[proc]
      const sql = renameProcHeader(spec.body, spec.proc, spec.proc)
      if (!sql) throw invalid(`the body is not a CREATE/ALTER PROCEDURE of ${spec.proc}`)
      if ((await procedureBody(spec.proc)) == null)
        throw invalid(`procedure ${spec.proc} does not exist`)
      ctx.began?.()
      await runLongSql(sql)
      return `CREATE OR ALTER PROCEDURE [dbo].[${spec.proc}] (body ${spec.hash.slice(0, 8)})`
    }
    case 'field_patch': {
      const { collection, field, patch } = spec
      if (!IDENT.test(collection) || !IDENT.test(field) || /^(nivaro|directus)_/i.test(collection))
        throw invalid('bad field identifier')
      const where = { collection, field }
      const f = (await db('nivaro_fields')
        .where(where)
        .first('type', 'computed_type', 'computed_formula')) as
        | { type: string | null; computed_type: string | null; computed_formula: string | null }
        | undefined
      const cfg = f?.computed_type === 'rollup' ? parseRollupFormula(f.computed_formula) : null
      if (!cfg) throw invalid(`${collection}.${field} is not a rollup field`)
      ctx.began?.()
      if (!patch.computed_store) {
        await db('nivaro_fields').where(where).update({ computed_store: 0 })
        clearMetadataCache(collection)
        bustRollupContributorCache()
        return `${collection}.${field} is virtual again (its stored column is kept)`
      }
      // The Store toggle's three steps: a numeric column, the flag, then the backfill.
      const type = NUMERIC_COLUMN_TYPES.has(String(f?.type)) ? String(f?.type) : 'decimal'
      if (!(await db.schema.hasColumn(collection, field)))
        await db.schema.table(collection, (t) => addRollupColumn(t, field, type))
      await db('nivaro_fields').where(where).update({ computed_store: 1, type })
      clearMetadataCache(collection)
      bustRollupContributorCache()
      const entry = {
        parentCollection: collection,
        parentFk: '',
        rollupField: field,
        sources: cfg.sources,
        parentFilter: cfg.parent_filter
      }
      const ids = (await db(collection).select('id')) as Array<{ id: unknown }>
      let done = 0
      for (const r of ids) {
        await recalcRollupsForParent(entry, r.id)
        if (++done % BACKFILL_PROGRESS_EVERY === 0)
          ctx.progress?.({ recalculated: done, total: ids.length })
      }
      return `stored ${collection}.${field} and backfilled ${ids.length} row(s)`
    }
    case 'query_patch': {
      const { id, slug, patch } = spec
      const ttl = patch.cache_ttl
      if (!Number.isInteger(id) || !Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL_SECONDS)
        throw invalid('bad query patch')
      ctx.began?.()
      const n = await db('nivaro_custom_queries')
        .where({ id, slug })
        .update({ cache_ttl: ttl, warm_daily: patch.warm_daily === true, updated_at: new Date() })
      if (!Number(n)) throw invalid(`query ${slug} no longer exists`)
      bustDefinitionCache(`custom-query:${id}`)
      bustFreshnessInference()
      return `${slug}: cache_ttl ${ttl}, warm_daily ${patch.warm_daily === true}`
    }
  }
}

// ─── Apply / roll back / dismiss ────────────────────────────────────────────────────────

/**
 * Move a row only while it is still in one of `from` — two clicks (or a click and the watcher)
 * cannot both win. Objects are JSON-encoded as `updateProposal` does.
 */
async function transition(
  id: string,
  from: readonly TuningStatus[],
  patch: Record<string, unknown>
): Promise<boolean> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch))
    out[k] = v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v
  const n = await db(T)
    .where({ id })
    .whereIn('status', [...from])
    .update(out)
  return Number(n) > 0
}

const numericOnly = (o: Record<string, unknown> | undefined): Record<string, number | null> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === 'number')) as Record<
    string,
    number | null
  >

/**
 * Claim the row for one apply or rollback: a job run first, then one conditional UPDATE that
 * sets `applying` + `run_id` together. A stuck claim is found by `run_id` → the job run's
 * `started_at`. The loser's run completes as skipped.
 */
async function claim(
  row: ProposalRow,
  from: readonly TuningStatus[],
  job: 'apply' | 'rollback',
  userId: string | null
) {
  const run = await startJobRun('tuning', `tuning:${job}:${row.id}`, {
    label: `Tuning ${job === 'apply' ? '' : 'rollback '}— ${row.title}`.slice(0, 200),
    triggeredBy: userId
  })
  if (!(await transition(row.id, from, { status: 'applying', run_id: run.id }))) {
    await run.complete('skipped — another apply or rollback holds this proposal')
    throw new TuningRefusal(
      'TUNING_NOT_APPLICABLE',
      'another apply or rollback holds this proposal'
    )
  }
  return run
}

const undoOutcome = (row: ProposalRow, userId: string | null): Promise<string> =>
  executeSpec(row.undo, { userId }).then(
    (o) => `undo ran: ${o}`,
    (e: unknown) =>
      e instanceof TuningRefusal ? `undo not run: ${e.message}` : `undo failed: ${errText(e)}`
  )

export async function applyProposal(
  id: string,
  opts: { userId: string | null; dbaOk: boolean; app: FastifyInstance }
): Promise<ProposalRow> {
  const row = await getProposal(id)
  if (!row) throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'proposal not found', 400)
  if (!APPLY_FROM.includes(row.status)) {
    const reprove = row.status === 'stale' || row.status === 'rejected_by_proof'
    throw new TuningRefusal(
      'TUNING_NOT_APPLICABLE',
      `proposal is ${row.status}${reprove ? ' — reprove first' : ''}`
    )
  }
  // belt and braces: a rewrite ships only on a passed twin proof, whatever set the status
  if (row.kind === 'proc_rewrite' && !(row.proof?.passed && row.proof.method === 'twin'))
    throw new TuningRefusal(
      'TUNING_NOT_APPLICABLE',
      'a procedure rewrite needs a passed twin proof'
    )
  const shape = specsProblem(row)
  if (shape) throw invalid(shape)
  if (!opts.dbaOk && (await replicatedNow(row)))
    throw new TuningRefusal(
      'TUNING_REPLICATED',
      "target is a replication article — the statement forwards to subscribers; apply only with the DBA's go",
      409,
      { target: row.target, statements: statementsOf(row.apply) }
    )
  const problem = revalidate(row, await readLiveState(row))
  if (problem) {
    await transition(id, APPLY_FROM, { status: 'stale' })
    throw new TuningRefusal('TUNING_STALE', problem)
  }
  const settings = await readTuningSettings()
  const run = await claim(row, APPLY_FROM, 'apply', opts.userId)

  // From the claim on, the row always ends terminal: watching, or failed with the reason.
  let executed = false
  let outcome: string
  try {
    // Before the change: CREATE INDEX recompiles the table's plans and CREATE OR ALTER resets
    // the procedure's stats, so a figure read afterwards is mostly empty.
    const baseline = await captureBaseline(row).catch(() => ({ metric: null }))
    outcome = await executeSpec(row.apply, {
      userId: opts.userId,
      progress: (blob) => run.progress(blob),
      began: () => {
        executed = true
      }
    })
    const now = new Date()
    const moved = await transition(id, CLAIMED, {
      status: 'watching',
      applied_at: now,
      applied_by: opts.userId,
      watch_until: new Date(now.getTime() + settings.watch_days * 86_400_000),
      watch_baseline: { before: baseline, after: numericOnly(row.proof?.after) }
    })
    if (!moved) throw new Error('the proposal left the applying state while the change ran')
  } catch (err) {
    // A refusal before the first write changed nothing: no undo (it could drop a stranger's
    // index). Otherwise whatever part of the change landed comes off at once — unless the row
    // left the claim meanwhile (a watching write that landed before it threw, or the watch
    // ending a claim it judged dead): the row then speaks for the change, not this catch.
    const held = executed
      ? await getProposal(id).then(
          (r) => r?.status ?? null,
          () => null
        )
      : null
    const undo = !executed
      ? 'nothing ran, no undo'
      : held === 'applying'
        ? await undoOutcome(row, opts.userId)
        : `the row is ${held ?? 'unreadable'}, no undo`
    const reason = `apply failed: ${errText(err)}; ${undo}`
    await transition(id, CLAIMED, {
      status: 'failed',
      rollback_reason: reason.slice(0, 500)
    }).catch(() => false)
    await run.fail(err)
    await logActivity({
      action: 'tuning-apply-failed',
      user: opts.userId,
      collection: T,
      item: id,
      comment: `Apply failed: ${row.title} — ${reason}`.slice(0, 1000)
    })
    throw err
  }
  await run.complete(outcome)
  await logActivity({
    action: 'tuning-apply',
    user: opts.userId,
    collection: T,
    item: id,
    comment:
      `Applied: ${row.title} (est. ${Math.round(row.estimate_ms_per_day / 1000)} s/day)`.slice(
        0,
        1000
      )
  })
  return (await getProposal(id)) as ProposalRow
}

/**
 * Run the undo of a watching/applied row under the same claim as Apply. `app` is the watcher's
 * handle for the applier's notice. A rollback the live object no longer allows (a proc edited
 * since, an index gone or rebuilt) is refused and the row left `failed` for a person.
 */
export async function rollbackProposal(
  id: string,
  opts: { userId: string | null; reason: string; app: FastifyInstance | null }
): Promise<ProposalRow> {
  const row = await getProposal(id)
  if (!row) throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'proposal not found', 400)
  if (!ROLLBACK_FROM.includes(row.status))
    throw new TuningRefusal('TUNING_NOT_APPLICABLE', `proposal is ${row.status}`)
  const run = await claim(row, ROLLBACK_FROM, 'rollback', opts.userId)

  let executed = false
  let outcome: string
  try {
    const shape = specsProblem(row)
    if (shape) throw invalid(shape)
    const problem = undoProblem(row, await readLiveState(row))
    if (problem) throw new TuningRefusal('TUNING_STALE', problem)
    outcome = await executeSpec(row.undo, {
      userId: opts.userId,
      progress: (blob) => run.progress(blob),
      began: () => {
        executed = true
      }
    })
    const moved = await transition(id, CLAIMED, {
      status: 'rolled_back',
      rolled_back_at: new Date(),
      rollback_reason: opts.reason.slice(0, 500)
    })
    if (!moved) throw new Error('the proposal left the applying state while the undo ran')
  } catch (err) {
    const what = executed || !(err instanceof TuningRefusal) ? 'failed' : 'refused'
    const reason = `rollback ${what}: ${errText(err)}`
    await transition(id, CLAIMED, {
      status: 'failed',
      rollback_reason: reason.slice(0, 500)
    }).catch(() => false)
    await run.fail(err)
    await logActivity({
      action: 'tuning-rollback-failed',
      user: opts.userId,
      collection: T,
      item: id,
      comment: `${row.title} — ${reason}`.slice(0, 1000)
    })
    throw err
  }
  await run.complete(outcome)
  await logActivity({
    action: 'tuning-rollback',
    user: opts.userId,
    collection: T,
    item: id,
    comment: `Rolled back: ${row.title} — ${opts.reason}`.slice(0, 1000)
  })
  return (await getProposal(id)) as ProposalRow
}

/** Dismiss an open row — or a failed one, once a person has looked at it. */
export async function dismissProposal(
  id: string,
  opts: { userId: string | null; note: string }
): Promise<void> {
  const row = await getProposal(id)
  if (!row) throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'proposal not found', 400)
  if (!DISMISS_FROM.includes(row.status))
    throw new TuningRefusal('TUNING_NOT_APPLICABLE', `proposal is ${row.status}`)
  const note = opts.note.trim().slice(0, 500)
  const moved = await transition(id, DISMISS_FROM, {
    status: 'dismissed',
    dismissed_at: new Date(),
    dismissed_by: opts.userId,
    dismiss_note: note || null
  })
  if (!moved) throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'proposal changed meanwhile')
  await logActivity({
    action: 'tuning-dismiss',
    user: opts.userId,
    collection: T,
    item: id,
    comment: (note ? `Dismissed: ${row.title} — ${note}` : `Dismissed: ${row.title}`).slice(0, 1000)
  })
}
