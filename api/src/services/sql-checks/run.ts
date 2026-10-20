// api/src/services/sql-checks/run.ts
/**
 * One SQL checks run (#2562): read every module's definition from the database (procedures,
 * functions, views, triggers — `sys.sql_modules`), plus the SQL bodies Nivaro keeps in its own
 * tables when they exist (import definitions' `procedure_body`, custom queries' `sql_text`), run
 * the pattern checks, add live data figures for MERGE keys on nullable columns, optionally lint
 * through the SQLFluff sidecar, and record the findings against the previous run:
 *
 *   new fingerprint            → open (event `opened`)
 *   seen again                 → last_seen_run / seen_count move; accepted stays accepted
 *   resolved, seen again       → open again (event `reopened`)
 *   open / accepted, not seen  → resolved (event `resolved`) — only for sources this run read
 *   resolved + object changed  → a `proc_fix` row in nivaro_sql_check_fixes
 *
 * SQL Server only (the checks read sys.* catalogs). One run at a time per database: a Redis lock
 * when Redis is there, plus a running row younger than two hours.
 */

import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { getApp } from '../io-holder.js'
import { withReadGate } from '../read-gate.js'
import { runLongSql } from '../run-long.js'
import {
  type Catalog,
  type ColumnInfo,
  checkObject,
  definitionHash,
  fingerprintOf,
  type ObjectType,
  type RawFinding,
  type Severity,
  type SqlObject
} from './checkers.js'
import { readSqlCheckSettings, type SqlCheckSettings } from './settings.js'
import { keepLintCode, lintConfig, lintSql } from './sqlfluff.js'
import { canonicalDefinition, splitName } from './tokenizer.js'

export const RUNS = 'nivaro_sql_check_runs'
export const FINDINGS = 'nivaro_sql_check_findings'
export const EVENTS = 'nivaro_sql_check_events'
export const FIXES = 'nivaro_sql_check_fixes'
export const SQL_CHECKS_JOB_ID = 'sql-checks'

const STALE_RUN_MS = 2 * 3600_000
const MODULE_TYPES: ObjectType[] = ['procedure', 'function', 'view', 'trigger']

export class SqlChecksBusyError extends Error {}

// ─── catalog ────────────────────────────────────────────────────────────────

const lc = (s: string | null | undefined) => (s ?? '').toLowerCase()

export interface LoadedCatalog extends Catalog {
  /** The real schema + name of a table (null when unknown). */
  resolve(schema: string | null, table: string): { schema: string; name: string } | null
  rowCount(schema: string, table: string): number | null
}

const WIDE_TYPES = new Set(['text', 'ntext', 'image', 'xml'])

/** Builds the catalog from rows (exported for tests). */
export function buildCatalog(
  columns: Array<{
    sch: string
    tbl: string
    col: string
    nullable: string
    type: string
    len: number | null
  }>,
  uniques: Array<{ sch: string; tbl: string; idx: number; col: string }>,
  rows: Array<{ sch: string; tbl: string; n: number | string }>
): LoadedCatalog {
  const tables = new Map<
    string,
    { schema: string; name: string; cols: Map<string, ColumnInfo>; wide: boolean }
  >()
  const byName = new Map<string, string[]>()
  for (const c of columns) {
    const key = `${lc(c.sch)}.${lc(c.tbl)}`
    let t = tables.get(key)
    if (!t) {
      t = { schema: c.sch, name: c.tbl, cols: new Map(), wide: false }
      tables.set(key, t)
      const list = byName.get(lc(c.tbl)) ?? []
      list.push(key)
      byName.set(lc(c.tbl), list)
    }
    const len = c.len == null ? null : Number(c.len)
    t.cols.set(lc(c.col), { nullable: c.nullable === 'YES', dataType: lc(c.type), maxLength: len })
    if (len === -1 || WIDE_TYPES.has(lc(c.type))) t.wide = true
  }
  const uniq = new Map<string, Map<number, string[]>>()
  for (const u of uniques) {
    const key = `${lc(u.sch)}.${lc(u.tbl)}`
    const m = uniq.get(key) ?? new Map<number, string[]>()
    const set = m.get(u.idx) ?? []
    set.push(lc(u.col))
    m.set(u.idx, set)
    uniq.set(key, m)
  }
  const counts = new Map(rows.map((r) => [`${lc(r.sch)}.${lc(r.tbl)}`, Number(r.n)]))
  const find = (schema: string | null, table: string) => {
    if (schema) return tables.get(`${lc(schema)}.${lc(table)}`) ?? null
    const keys = byName.get(lc(table)) ?? []
    const dbo = keys.find((k) => k.startsWith('dbo.'))
    return tables.get(dbo ?? keys[0] ?? '') ?? null
  }
  return {
    column: (s, t, c) => find(s, t)?.cols.get(lc(c)),
    hasTable: (s, t) => !!find(s, t),
    isWide: (s, t) => !!find(s, t)?.wide,
    uniqueSets: (s, t) => {
      const f = find(s, t)
      return f ? [...(uniq.get(`${lc(f.schema)}.${lc(f.name)}`)?.values() ?? [])] : []
    },
    resolve: (s, t) => {
      const f = find(s, t)
      return f ? { schema: f.schema, name: f.name } : null
    },
    rowCount: (s, t) => counts.get(`${lc(s)}.${lc(t)}`) ?? null
  }
}

async function loadCatalog(): Promise<LoadedCatalog> {
  const [columns, uniques, rows] = await Promise.all([
    db.raw(`SELECT c.TABLE_SCHEMA AS sch, c.TABLE_NAME AS tbl, c.COLUMN_NAME AS col, c.IS_NULLABLE AS nullable,
              c.DATA_TYPE AS type, c.CHARACTER_MAXIMUM_LENGTH AS len
         FROM INFORMATION_SCHEMA.COLUMNS c
         JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE t.TABLE_TYPE = 'BASE TABLE'`),
    db.raw(`SELECT s.name AS sch, t.name AS tbl, i.index_id AS idx, c.name AS col
         FROM sys.indexes i
         JOIN sys.tables t ON t.object_id = i.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE (i.is_unique = 1 OR i.is_primary_key = 1) AND i.has_filter = 0`),
    db.raw(`SELECT s.name AS sch, t.name AS tbl, SUM(p.rows) AS n
         FROM sys.tables t
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
        GROUP BY s.name, t.name`)
  ])
  return buildCatalog(columns as never, uniques as never, rows as never)
}

// ─── objects ────────────────────────────────────────────────────────────────

const TYPE_OF: Record<string, ObjectType> = {
  P: 'procedure',
  PC: 'procedure',
  FN: 'function',
  IF: 'function',
  TF: 'function',
  FS: 'function',
  FT: 'function',
  V: 'view',
  TR: 'trigger'
}

interface LoadedObjects {
  modules: SqlObject[]
  stored: SqlObject[]
  drift: Array<{ obj: SqlObject; deployed: boolean }>
  sources: Set<ObjectType>
}

async function loadObjects(settings: SqlCheckSettings): Promise<LoadedObjects> {
  const rows =
    (await db.raw(`SELECT s.name AS sch, o.name AS name, RTRIM(o.type) AS type, m.definition AS def
       FROM sys.sql_modules m
       JOIN sys.objects o ON o.object_id = m.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.is_ms_shipped = 0 AND m.definition IS NOT NULL`)) as Array<{
      sch: string
      name: string
      type: string
      def: string
    }>
  const modules: SqlObject[] = []
  for (const r of rows) {
    const type = TYPE_OF[r.type]
    if (!type) continue
    modules.push({ schema: r.sch, name: r.name, type, definition: r.def })
  }
  const sources = new Set<ObjectType>(MODULE_TYPES)
  const stored: SqlObject[] = []
  const drift: LoadedObjects['drift'] = []
  const moduleByName = new Map(
    modules.filter((m) => m.type === 'procedure').map((m) => [`${lc(m.schema)}.${lc(m.name)}`, m])
  )
  if (
    settings.include_import_definitions &&
    (await db.schema.hasTable('nivaro_import_definitions')) &&
    (await db.schema.hasColumn('nivaro_import_definitions', 'procedure_body'))
  ) {
    sources.add('import_definition')
    const defs = (await db('nivaro_import_definitions')
      .whereNotNull('procedure_body')
      .select('id', 'key', 'procedure', 'procedure_body')) as Array<{
      id: number
      key: string
      procedure: string | null
      procedure_body: string | null
    }>
    for (const d of defs) {
      const body = d.procedure_body ?? ''
      if (!body.trim()) continue
      const procName = splitName(d.procedure ?? d.key)
      const deployed = moduleByName.get(`${lc(procName.schema ?? 'dbo')}.${lc(procName.name)}`)
      const obj: SqlObject = {
        schema: procName.schema,
        name: d.key,
        type: 'import_definition',
        ref: String(d.id),
        definition: body
      }
      if (!deployed) {
        drift.push({ obj, deployed: false })
        stored.push(obj)
      } else if (canonicalDefinition(deployed.definition) !== canonicalDefinition(body)) {
        drift.push({ obj, deployed: true })
        stored.push(obj)
      }
      // identical to the deployed module: its findings come from the module
    }
  }
  if (
    settings.include_custom_queries &&
    (await db.schema.hasTable('nivaro_custom_queries')) &&
    (await db.schema.hasColumn('nivaro_custom_queries', 'sql_text'))
  ) {
    sources.add('custom_query')
    const qs = (await db('nivaro_custom_queries').select('id', 'slug', 'sql_text')) as Array<{
      id: number
      slug: string
      sql_text: string | null
    }>
    for (const q of qs)
      if (q.sql_text?.trim())
        stored.push({
          schema: null,
          name: q.slug,
          type: 'custom_query',
          ref: String(q.id),
          definition: q.sql_text
        })
  }
  return { modules, stored, drift, sources }
}

// ─── data step ──────────────────────────────────────────────────────────────

const qid = (s: string) => `[${s.replace(/]/g, ']]')}]`

interface DataFigures {
  null_counts: Record<string, number>
  extra_rows: number
  null_key_rows: number
  table_rows: number | null
}

/**
 * NULL counts per nullable key column and the extra rows inside NULL-key groups (rows that a
 * NULL-safe MERGE would have updated instead of inserting again). One query per table and key.
 */
async function dataFigures(
  catalog: LoadedCatalog,
  findings: RawFinding[],
  settings: SqlCheckSettings,
  stats: RunStats
): Promise<Map<RawFinding, DataFigures | { skipped: string }>> {
  const out = new Map<RawFinding, DataFigures | { skipped: string }>()
  const memo = new Map<string, Promise<DataFigures | { skipped: string }>>()
  for (const f of findings) {
    if (f.check_key !== 'merge-null-key') continue
    const d = f.detail as {
      target_schema: string | null
      target_table: string
      key_columns: string[]
      nullable_columns: string[]
    }
    const t = catalog.resolve(d.target_schema, d.target_table)
    if (!t) continue
    const key = `${lc(t.schema)}.${lc(t.name)}|${d.key_columns.join(',')}|${d.nullable_columns.join(',')}`
    let p = memo.get(key)
    if (!p) {
      p = (async () => {
        const n = catalog.rowCount(t.schema, t.name)
        if (n != null && n > settings.row_cap) {
          stats.skipped_tables.push(`${t.schema}.${t.name} (${n.toLocaleString('en-US')} rows)`)
          return { skipped: `over the ${settings.row_cap.toLocaleString('en-US')}-row cap` }
        }
        const from = `${qid(t.schema)}.${qid(t.name)} WITH (NOLOCK)`
        const nullSel = d.nullable_columns
          .map((c, i) => `SUM(CASE WHEN ${qid(c)} IS NULL THEN 1 ELSE 0 END) AS n${i}`)
          .join(', ')
        const anyNull = d.nullable_columns.map((c) => `${qid(c)} IS NULL`).join(' OR ')
        const group = d.key_columns.map(qid).join(', ')
        const timeoutMs = settings.data_timeout_s * 1000
        try {
          return await withReadGate(
            'sql-checks',
            async () => {
              stats.data_queries += 2
              const [nulls] = await runLongSql<Record<string, number | string>>(
                `SELECT ${nullSel} FROM ${from}`,
                { timeoutMs }
              )
              const [dups] = await runLongSql<{ extra: number | string; rows_in: number | string }>(
                `SELECT ISNULL(SUM(n - 1), 0) AS extra, ISNULL(SUM(n), 0) AS rows_in FROM (SELECT COUNT_BIG(*) AS n FROM ${from} WHERE ${anyNull} GROUP BY ${group} HAVING COUNT_BIG(*) > 1) d`,
                { timeoutMs }
              )
              const null_counts: Record<string, number> = {}
              d.nullable_columns.forEach((c, i) => {
                null_counts[c] = Number(nulls?.[`n${i}`] ?? 0)
              })
              return {
                null_counts,
                extra_rows: Number(dups?.extra ?? 0),
                null_key_rows: Number(dups?.rows_in ?? 0),
                table_rows: n
              }
            },
            { label: `sql-checks:${t.name}` }
          )
        } catch (err) {
          stats.data_errors++
          return {
            skipped: `the count failed (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`
          }
        }
      })()
      memo.set(key, p)
    }
    out.set(f, await p)
  }
  return out
}

/** Severity + message once the data figures are in (pure; exported for tests). */
export function applyFigures(
  f: RawFinding,
  fig: DataFigures | { skipped: string } | undefined
): RawFinding {
  if (!fig) return f
  if ('skipped' in fig)
    return { ...f, detail: { ...f.detail, data: 'skipped', data_note: fig.skipped } }
  const nulls = Object.values(fig.null_counts).reduce((a, b) => a + b, 0)
  const detail = { ...f.detail, ...fig }
  if (nulls === 0) return { ...f, severity: 'warning', detail }
  const extra =
    fig.extra_rows > 0
      ? `; ${fig.extra_rows.toLocaleString('en-US')} extra rows already sit in NULL-key groups`
      : ''
  return {
    ...f,
    severity: 'critical',
    detail,
    message:
      `${f.message} — ${nulls.toLocaleString('en-US')} rows hold NULL keys now${extra}`.slice(
        0,
        500
      )
  }
}

// ─── SQLFluff ───────────────────────────────────────────────────────────────

async function lintObjects(
  objects: SqlObject[],
  stats: RunStats
): Promise<{
  state: 'on' | 'off' | 'unavailable'
  findings: Array<{ obj: SqlObject; f: RawFinding }>
}> {
  if (!lintConfig()) return { state: 'off', findings: [] }
  const findings: Array<{ obj: SqlObject; f: RawFinding }> = []
  let state: 'on' | 'unavailable' = 'on'
  let stop = false
  let next = 0
  const worker = async () => {
    while (!stop && next < objects.length) {
      const obj = objects[next++]
      const r = await lintSql(obj.definition)
      if (!r.ok) {
        if (r.reason === 'timeout') {
          stats.sqlfluff.timeouts++
          continue
        }
        // unauthorized / busy past its retries / unreachable: no point asking for the rest
        state = 'unavailable'
        stats.sqlfluff.reason = r.reason
        stop = true
        return
      }
      stats.sqlfluff.linted++
      stats.sqlfluff.parse_errors += r.parseErrors
      const byCode = new Map<string, typeof r.violations>()
      for (const v of r.violations) {
        if (!keepLintCode(v.code)) continue
        const list = byCode.get(v.code) ?? []
        list.push(v)
        byCode.set(v.code, list)
      }
      for (const [code, vs] of byCode) {
        const lines = vs.map((v) => v.line).filter(Boolean)
        const snippetLine = lines[0] ?? 1
        const text = obj.definition.split('\n')[snippetLine - 1] ?? ''
        findings.push({
          obj,
          f: {
            check_key: 'sqlfluff',
            severity: 'info',
            line: snippetLine,
            snippet: text.slice(0, 500),
            anchor: `sqlfluff:${code}`,
            message: `${code}${vs.length > 1 ? ` ×${vs.length}` : ''}: ${vs[0].description}`.slice(
              0,
              500
            ),
            detail: { code, lines: lines.slice(0, 50), count: vs.length },
            suggested_fix: `SQLFluff rule ${code}. ${vs[0].description}`
          }
        })
      }
    }
  }
  await Promise.all([worker(), worker()])
  return { state, findings }
}

// ─── persistence ────────────────────────────────────────────────────────────

export interface RunStats {
  objects_by_type: Record<string, number>
  by_check: Record<string, number>
  skipped_tables: string[]
  data_queries: number
  data_errors: number
  sqlfluff: { linted: number; timeouts: number; parse_errors: number; reason?: string }
  fixes_recorded: number
}

interface Seen {
  fingerprint: string
  obj: SqlObject
  f: RawFinding
  hash: string
}

const idOf = (r: unknown): number =>
  Number(typeof r === 'object' && r ? (r as { id: unknown }).id : r)

/** Every finding of this run, fingerprinted (exported for tests). */
export function fingerprintAll(items: Array<{ obj: SqlObject; f: RawFinding }>): Seen[] {
  const count = new Map<string, number>()
  return items.map(({ obj, f }) => {
    const base = fingerprintOf(obj, f.check_key, f.anchor)
    const occ = count.get(base) ?? 0
    count.set(base, occ + 1)
    return {
      fingerprint: occ ? fingerprintOf(obj, f.check_key, f.anchor, occ) : base,
      obj,
      f,
      hash: definitionHash(obj.definition)
    }
  })
}

export interface StoredFinding {
  id: number
  fingerprint: string
  status: 'open' | 'resolved' | 'accepted'
  object_type: ObjectType
  object_schema: string | null
  object_name: string
  object_hash: string | null
  check_key: string
  message: string
}

/**
 * What changes against the stored findings (pure; exported for tests): which seen ones are new,
 * which come back, and which stored ones resolve. Only stored findings from a source this run
 * read (object types, and SQLFluff only when it answered) can resolve.
 */
export function diffFindings(
  stored: StoredFinding[],
  seen: Seen[],
  scope: { types: Set<ObjectType>; sqlfluffAnswered: boolean }
): {
  inserts: Seen[]
  updates: Array<{ row: StoredFinding; seen: Seen }>
  resolves: StoredFinding[]
} {
  const byFp = new Map(stored.map((s) => [s.fingerprint, s]))
  const seenFps = new Set(seen.map((s) => s.fingerprint))
  const inserts: Seen[] = []
  const updates: Array<{ row: StoredFinding; seen: Seen }> = []
  for (const s of seen) {
    const row = byFp.get(s.fingerprint)
    if (row) updates.push({ row, seen: s })
    else inserts.push(s)
  }
  const resolves = stored.filter(
    (s) =>
      s.status !== 'resolved' &&
      !seenFps.has(s.fingerprint) &&
      scope.types.has(s.object_type) &&
      (s.check_key !== 'sqlfluff' || scope.sqlfluffAnswered)
  )
  return { inserts, updates, resolves }
}

function rowFor(s: Seen, runId: number) {
  return {
    fingerprint: s.fingerprint,
    check_key: s.f.check_key,
    severity: s.f.severity,
    object_schema: s.obj.schema,
    object_name: s.obj.name.slice(0, 256),
    object_type: s.obj.type,
    object_ref: s.obj.ref ?? null,
    object_hash: s.hash,
    line: s.f.line,
    snippet: s.f.snippet.slice(0, 500),
    message: s.f.message.slice(0, 500),
    detail: JSON.stringify(s.f.detail),
    suggested_fix: s.f.suggested_fix,
    last_seen_run: runId
  }
}

async function persist(
  runId: number,
  seen: Seen[],
  scope: { types: Set<ObjectType>; sqlfluffAnswered: boolean },
  current: Map<string, string>,
  stats: RunStats
) {
  const stored = (await db(FINDINGS).select(
    'id',
    'fingerprint',
    'status',
    'object_type',
    'object_schema',
    'object_name',
    'object_hash',
    'check_key',
    'message'
  )) as StoredFinding[]
  const { inserts, updates, resolves } = diffFindings(stored, seen, scope)
  const now = new Date()
  let added = 0
  for (const s of inserts) {
    const [r] = await db(FINDINGS)
      .insert({
        ...rowFor(s, runId),
        first_seen_run: runId,
        seen_count: 1,
        status: 'open',
        first_seen_at: now
      })
      .returning('id')
    await db(EVENTS).insert({ finding_id: idOf(r), run_id: runId, event: 'opened', at: now })
    added++
  }
  for (const { row, seen: s } of updates) {
    const reopen = row.status === 'resolved'
    await db(FINDINGS)
      .where('id', row.id)
      .update({
        ...rowFor(s, runId),
        seen_count: db.raw('seen_count + 1'),
        ...(reopen ? { status: 'open', resolved_at: null } : {})
      })
    if (reopen) {
      await db(EVENTS).insert({ finding_id: row.id, run_id: runId, event: 'reopened', at: now })
      added++
    }
  }
  const changedObjects = new Map<string, StoredFinding[]>()
  for (const r of resolves) {
    await db(FINDINGS).where('id', r.id).update({ status: 'resolved', resolved_at: now })
    await db(EVENTS).insert({ finding_id: r.id, run_id: runId, event: 'resolved', at: now })
    const key = objectKey(r.object_type, r.object_schema, r.object_name)
    const hash = current.get(key)
    if (hash && r.object_hash && hash !== r.object_hash) {
      const list = changedObjects.get(key) ?? []
      list.push(r)
      changedObjects.set(key, list)
    }
  }
  for (const list of changedObjects.values()) {
    const first = list[0]
    await db(FIXES).insert({
      check_key: list.length === 1 ? first.check_key : null,
      target_object:
        `${first.object_schema ? `${first.object_schema}.` : ''}${first.object_name}`.slice(0, 256),
      action: 'proc_fix',
      rows_affected: null,
      detail: JSON.stringify({
        run_id: runId,
        object_type: first.object_type,
        resolved: list.map((r) => ({ id: r.id, check_key: r.check_key, message: r.message }))
      }),
      run_by: 'sql-checks',
      created_at: now
    })
    stats.fixes_recorded++
  }
  return { added, resolved: resolves.length }
}

const objectKey = (type: string, schema: string | null, name: string) =>
  `${type}|${lc(schema)}|${lc(name)}`

// ─── the run ────────────────────────────────────────────────────────────────

export interface RunReport {
  run_id: number | null
  status: 'ok' | 'failed' | 'skipped'
  skipped?: string
  objects: number
  findings: number
  new: number
  resolved: number
  sqlfluff: 'on' | 'off' | 'unavailable'
  ms: number
  error?: string
}

let running = false
const lockKey = () => `nvr:sqlchecks:lock:${getTenantId() ?? ''}`

export function isSqlChecksRunning(): boolean {
  return running
}

/** A running row younger than two hours anywhere on this database. */
export async function sqlChecksInFlight(): Promise<boolean> {
  try {
    const row = (await db(RUNS)
      .where('status', 'running')
      .where('started_at', '>', new Date(Date.now() - STALE_RUN_MS))
      .first('id')) as { id?: number } | undefined
    return !!row
  } catch {
    return false
  }
}

/**
 * Starts a run (throws SqlChecksBusyError when one is already going) and resolves with its
 * report. `onStarted` fires with the run id once the running row exists.
 */
export async function runSqlChecks(opts: {
  trigger: 'cron' | 'manual'
  userId?: string | null
  onStarted?: (runId: number) => void
}): Promise<RunReport> {
  const t0 = Date.now()
  if (!isMssql(db))
    return {
      run_id: null,
      status: 'skipped',
      skipped: 'SQL checks need SQL Server',
      objects: 0,
      findings: 0,
      new: 0,
      resolved: 0,
      sqlfluff: 'off',
      ms: 0
    }
  if (running || (await sqlChecksInFlight()))
    throw new SqlChecksBusyError('A SQL checks run is already in progress')
  const redis = getApp()?.redis as import('ioredis').Redis | undefined
  if (redis) {
    const ok = await redis
      .set(lockKey(), String(process.pid), 'EX', 2 * 3600, 'NX')
      .catch(() => 'OK')
    if (ok !== 'OK') throw new SqlChecksBusyError('A SQL checks run is already in progress')
  }
  running = true
  const [created] = await db(RUNS)
    .insert({
      status: 'running',
      trigger: opts.trigger,
      run_by: opts.userId ?? null,
      started_at: new Date()
    })
    .returning('id')
  const runId = idOf(created)
  opts.onStarted?.(runId)
  const stats: RunStats = {
    objects_by_type: {},
    by_check: {},
    skipped_tables: [],
    data_queries: 0,
    data_errors: 0,
    sqlfluff: { linted: 0, timeouts: 0, parse_errors: 0 },
    fixes_recorded: 0
  }
  try {
    const settings = await readSqlCheckSettings()
    const [catalog, objects] = await Promise.all([loadCatalog(), loadObjects(settings)])
    const all = [...objects.modules, ...objects.stored]
    for (const o of all) stats.objects_by_type[o.type] = (stats.objects_by_type[o.type] ?? 0) + 1
    const items: Array<{ obj: SqlObject; f: RawFinding }> = []
    for (const obj of all) for (const f of checkObject(obj, catalog)) items.push({ obj, f })
    for (const d of objects.drift)
      items.push({
        obj: d.obj,
        f: {
          check_key: 'import-body-drift',
          severity: d.deployed ? 'warning' : 'info',
          line: 1,
          snippet: d.obj.definition.slice(0, 500),
          anchor: d.deployed ? 'drift' : 'not-deployed',
          message: d.deployed
            ? `Import definition ${d.obj.name}: the stored procedure body differs from the deployed procedure`
            : `Import definition ${d.obj.name}: the stored procedure body is not deployed`,
          detail: { deployed: d.deployed },
          suggested_fix: d.deployed
            ? 'The import runs the deployed procedure, not this stored body. Deploy the stored body from the import definition, or save the deployed version back into the definition, so the two agree.'
            : 'The definition names a procedure the database does not have. Deploy it from the import definition before the next run.'
        }
      })
    if (settings.data_checks) {
      const figs = await dataFigures(
        catalog,
        items.map((i) => i.f),
        settings,
        stats
      )
      for (const it of items) if (figs.has(it.f)) it.f = applyFigures(it.f, figs.get(it.f))
    }
    const lint = await lintObjects(
      all.filter((o) => o.type !== 'custom_query'),
      stats
    )
    items.push(...lint.findings)
    for (const it of items)
      stats.by_check[it.f.check_key] = (stats.by_check[it.f.check_key] ?? 0) + 1
    const seen = fingerprintAll(items)
    const current = new Map(
      all.map((o) => [objectKey(o.type, o.schema, o.name), definitionHash(o.definition)])
    )
    const { added, resolved } = await persist(
      runId,
      seen,
      { types: objects.sources, sqlfluffAnswered: lint.state === 'on' },
      current,
      stats
    )
    const open = (await db(FINDINGS)
      .where('status', 'open')
      .select('severity')
      .count({ n: '*' })
      .groupBy('severity')) as Array<{ severity: Severity; n: number | string }>
    const sev = (s: Severity) => Number(open.find((o) => o.severity === s)?.n ?? 0)
    const ms = Date.now() - t0
    await db(RUNS)
      .where('id', runId)
      .update({
        status: 'ok',
        finished_at: new Date(),
        objects_scanned: all.length,
        findings_total: seen.length,
        findings_new: added,
        findings_resolved: resolved,
        critical_open: sev('critical'),
        warning_open: sev('warning'),
        info_open: sev('info'),
        duration_ms: ms,
        sqlfluff: lint.state,
        stats: JSON.stringify(stats)
      })
    return {
      run_id: runId,
      status: 'ok',
      objects: all.length,
      findings: seen.length,
      new: added,
      resolved,
      sqlfluff: lint.state,
      ms
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db(RUNS)
      .where('id', runId)
      .update({
        status: 'failed',
        finished_at: new Date(),
        duration_ms: Date.now() - t0,
        error: message.slice(0, 4000),
        stats: JSON.stringify(stats)
      })
      .catch(() => {})
    return {
      run_id: runId,
      status: 'failed',
      objects: 0,
      findings: 0,
      new: 0,
      resolved: 0,
      sqlfluff: 'off',
      ms: Date.now() - t0,
      error: message
    }
  } finally {
    running = false
    if (redis) await redis.del(lockKey()).catch(() => {})
  }
}

export function runSummary(r: RunReport): string {
  if (r.status === 'skipped') return `skipped: ${r.skipped}`
  if (r.status === 'failed') return `failed: ${r.error}`
  return `${r.objects} objects, ${r.findings} findings (${r.new} new, ${r.resolved} resolved), SQLFluff ${r.sqlfluff}, ${r.ms} ms`
}
