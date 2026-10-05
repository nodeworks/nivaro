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
import { getProposal, updateProposal } from './ledger.js'
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
    public status: 400 | 409 = 409
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
  /** index_drop: the live index rebuilt as a CREATE (dmv `indexDefinition`); null = unrebuildable. */
  indexDefinition?: string | null
}

const T = 'nivaro_tuning_proposals'
const APPLY_FROM: readonly TuningStatus[] = ['proposed']
const ROLLBACK_FROM: readonly TuningStatus[] = ['watching', 'applied']
const MAX_TTL_SECONDS = 86_400
const BACKFILL_PROGRESS_EVERY = 500

const rowsOf = (r: unknown) => (Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [])
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const truthy = (v: unknown) => v === true || v === 1 || v === '1'
const invalid = (message: string) => new TuningRefusal('TUNING_INVALID', message, 400)

// ─── Index statements: the only SQL shapes Apply runs ───────────────────────────────────

type Tok = { k: 'name' | 'word' | 'num' | 'str' | 'op'; v: string }

// `[ident]` · bare word · number · '…' literal ('' escapes) · operator. Anything else — a dot,
// a comment, a variable, a stray bracket — fails the tokenizer and the statement with it.
const TOKEN =
  /\s*(?:\[([A-Za-z_][A-Za-z0-9_]*)\]|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|('(?:[^']|'')*')|(<>|!=|<=|>=|[=<>(),;]))/y

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
    else if (m[2]) out.push({ k: 'word', v: m[2] })
    else if (m[3]) out.push({ k: 'num', v: m[3] })
    else if (m[4]) out.push({ k: 'str', v: m[4] })
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

/** Case-folded canonical form, for comparing two definitions of one index. */
const canonIndex = (sql: string): string | null => {
  const s = parseIndexStatement(sql)
  return s ? renderIndexStatement(s).toLowerCase() : null
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
    case 'index_create':
      if (live.indexExists == null) return 'the live index catalog could not be read'
      return live.indexExists ? null : 'the index the apply created no longer exists'
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

/** The live state `revalidate` / `undoProblem` judge. Catalog read errors throw — nothing runs. */
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
      } else {
        live.indexDefinition = live.indexExists ? await indexDefinition(s.table, s.name) : null
      }
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

/** Recorded on the row, or a replication article now (the publication may postdate the proof). */
async function replicatedNow(row: ProposalRow): Promise<boolean> {
  if (row.replicated) return true
  if (row.kind === 'index_create' || row.kind === 'index_drop')
    return isReplicatedArticle(row.target.split('.')[0])
  if (row.kind === 'proc_rewrite') return isReplicatedProcedure(row.target)
  return false
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

/** Runs one spec; returns a one-line outcome. Refuses (TuningRefusal) before running anything. */
export async function executeSpec(
  spec: ApplySpec,
  ctx: { userId: string | null; progress?: (blob: Record<string, unknown>) => void }
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

/** Move a row only while it is still in one of `from` — two clicks cannot both win. */
async function transition(
  id: string,
  from: readonly TuningStatus[],
  patch: Record<string, unknown>
): Promise<boolean> {
  const n = await db(T)
    .where({ id })
    .whereIn('status', [...from])
    .update(patch)
  return Number(n) > 0
}

const numericOnly = (o: Record<string, unknown> | undefined): Record<string, number | null> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === 'number')) as Record<
    string,
    number | null
  >

export async function applyProposal(
  id: string,
  opts: { userId: string | null; dbaOk: boolean; app: FastifyInstance }
): Promise<ProposalRow> {
  const row = await getProposal(id)
  if (!row) throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'proposal not found', 400)
  if (!APPLY_FROM.includes(row.status))
    throw new TuningRefusal(
      'TUNING_NOT_APPLICABLE',
      `proposal is ${row.status}${row.status === 'stale' ? ' — re-prove it first' : ''}`
    )
  const shape = specsProblem(row)
  if (shape) throw invalid(shape)
  if (!opts.dbaOk && (await replicatedNow(row)))
    throw new TuningRefusal(
      'TUNING_REPLICATED',
      "target is a replication article — the statement forwards to subscribers; apply only with the DBA's go"
    )
  const problem = revalidate(row, await readLiveState(row))
  if (problem) {
    await transition(id, APPLY_FROM, { status: 'stale' })
    throw new TuningRefusal('TUNING_STALE', problem)
  }
  const settings = await readTuningSettings()
  if (!(await transition(id, APPLY_FROM, { status: 'applying' })))
    throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'proposal is already being applied')
  const run = await startJobRun('tuning', `tuning:apply:${id}`, {
    label: `Tuning — ${row.title}`.slice(0, 200),
    triggeredBy: opts.userId
  })
  await updateProposal(id, { run_id: run.id })

  let outcome: string
  try {
    outcome = await executeSpec(row.apply, {
      userId: opts.userId,
      progress: (blob) => run.progress(blob)
    })
  } catch (err) {
    // Whatever part of the change landed comes off at once; the row says what the undo did.
    const undo = await executeSpec(row.undo, { userId: opts.userId }).then(
      (o) => `undo ran: ${o}`,
      (e: unknown) =>
        e instanceof TuningRefusal ? `undo not run: ${e.message}` : `undo failed: ${errText(e)}`
    )
    const reason = `apply failed: ${errText(err)}; ${undo}`
    await updateProposal(id, { status: 'failed', rollback_reason: reason.slice(0, 500) })
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

  // The watch judges later samples against the figure measured once the change is live.
  const baseline = await captureBaseline(row).catch(() => ({ metric: null }))
  const now = new Date()
  await updateProposal(id, {
    status: 'watching',
    applied_at: now,
    applied_by: opts.userId,
    watch_until: new Date(now.getTime() + settings.watch_days * 86_400_000),
    watch_baseline: { before: baseline, after: numericOnly(row.proof?.after) }
  })
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
 * Run the undo of a watching/applied row. `app` is the watcher's handle for the applier's
 * notice; a rollback the live object no longer allows (a proc edited since, an index gone)
 * is refused and left `failed` for a person.
 */
export async function rollbackProposal(
  id: string,
  opts: { userId: string | null; reason: string; app: FastifyInstance | null }
): Promise<ProposalRow> {
  const row = await getProposal(id)
  if (!row) throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'proposal not found', 400)
  if (!ROLLBACK_FROM.includes(row.status))
    throw new TuningRefusal('TUNING_NOT_APPLICABLE', `proposal is ${row.status}`)
  const refuse = async (refusal: TuningRefusal): Promise<never> => {
    await transition(id, ROLLBACK_FROM, {
      status: 'failed',
      rollback_reason: `rollback refused: ${refusal.message}`.slice(0, 500)
    })
    await logActivity({
      action: 'tuning-rollback-failed',
      user: opts.userId,
      collection: T,
      item: id,
      comment: `Rollback refused: ${row.title} — ${refusal.message}`.slice(0, 1000)
    })
    throw refusal
  }
  const shape = specsProblem(row)
  if (shape) return refuse(invalid(shape))
  const problem = undoProblem(row, await readLiveState(row))
  if (problem) return refuse(new TuningRefusal('TUNING_STALE', problem))

  const run = await startJobRun('tuning', `tuning:rollback:${id}`, {
    label: `Tuning rollback — ${row.title}`.slice(0, 200),
    triggeredBy: opts.userId
  })
  let outcome: string
  try {
    outcome = await executeSpec(row.undo, {
      userId: opts.userId,
      progress: (blob) => run.progress(blob)
    })
  } catch (err) {
    const reason = `rollback failed: ${errText(err)}`
    await transition(id, ROLLBACK_FROM, { status: 'failed', rollback_reason: reason.slice(0, 500) })
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
  await transition(id, ROLLBACK_FROM, {
    status: 'rolled_back',
    rolled_back_at: new Date(),
    rollback_reason: opts.reason.slice(0, 500)
  })
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

export async function dismissProposal(
  id: string,
  opts: { userId: string | null; note: string }
): Promise<void> {
  const row = await getProposal(id)
  if (!row) throw new TuningRefusal('TUNING_NOT_APPLICABLE', 'proposal not found', 400)
  if (!OPEN_STATUSES.includes(row.status))
    throw new TuningRefusal('TUNING_NOT_APPLICABLE', `proposal is ${row.status}`)
  const note = opts.note.trim().slice(0, 500)
  const moved = await transition(id, OPEN_STATUSES, {
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
