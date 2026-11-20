import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import type { Knex } from 'knex'
import * as XLSX from 'xlsx'
import { describeColumns } from '../db/dialect/catalog.js'
import { db } from '../db/index.js'
import { sqlDialect } from '../db/sql-dialect.js'
import { getImportProcessor, runImportProcessor } from './import-processors.js'
import { describeRollupRecalc, parseRecalcRollups, recalcRollupsFedBy } from './import-rollups.js'
import {
  type ImportRunItem,
  type ImportRunReport,
  recordRanVia,
  saveRunReport
} from './import-run-report.js'
import { makePacer, yieldToLoop } from './loop-pacer.js'
import { runLongSql as runLong } from './run-long.js'
import { parseServiceConfig, runServiceImport } from './staged-import-service.js'
import { parseStagingColumns, resolveHeaderMap } from './staged-import-validation.js'

const execFileAsync = promisify(execFile)

/**
 * Staged imports — load a cleaned file into a staging table, then optionally
 * run a stored procedure over it.
 *
 * Everything deployment-specific is DATA (`nivaro_import_definitions`): which
 * staging table receives the rows, which procedure runs afterwards, and how
 * the rows get loaded. A deployment with no procedures at all still works —
 * the load stage alone is a valid import.
 */

/** 'bulk' falls back to 'insert' when the share or BULK INSERT is unavailable
 *  (#803); 'bulk_only' pins the bulk loader and fails loudly instead. */
export type StagingLoader = 'bulk' | 'bulk_only' | 'insert'

export interface ImportDefinition {
  id: number
  key: string
  label: string | null
  staging_table: string | null
  procedure: string | null
  loader: StagingLoader | null
  is_active: boolean
  /** Declared staging schema (JSON) — when set, the staging table is built to
   *  match it and file headers map onto it, instead of deriving from the file. */
  staging_columns?: string | null
  /** App-managed procedure body; null = the procedure is managed outside. */
  procedure_body?: string | null
  procedure_hash?: string | null
  procedure_deployed_at?: string | Date | null
  /** Pre-flight validation config (JSON) — see staged-import-validation.ts. */
  validation?: string | null
  /** null/'proc' = staging table + stored procedure; 'service' = rows go
   *  through the items service (staged-import-service.ts) — revisions,
   *  activity, rules and computed fields apply, and only changed rows write;
   *  '<extension>:<name>' = a registered import processor
   *  (import-processors.ts) for files that span several collections. */
  processor?: string | null
  service_config?: string | null
  /** JSON array of nivaro_flows ids run in order after a successful run
   *  (migration 294). null/[] = nothing beyond the generic trigger. */
  post_run_flows?: string | null
  /** #802 — runs sharing a group never overlap; NULL = the staging table. */
  lock_group?: string | null
  /** #719 — JSON string[] of collections the procedure writes; their stored
   *  rollups are recomputed after a run. */
  recalc_rollups?: string | null
  /** #846 — empty the staging table this many days after the newest completed
   *  run. Opt-in: NULL or 0 = keep. */
  staging_purge_days?: number | null
  staging_purged_at?: string | Date | null
}

/** The group a definition's runs serialise within (#802). Procedures truncate
 *  a shared staging table, so the default group IS the staging table. */
export function lockGroupOf(
  def: Pick<ImportDefinition, 'lock_group' | 'staging_table' | 'key'>
): string {
  const g = def.lock_group?.trim()
  return (g || def.staging_table || `staging_${def.key}`).toLowerCase()
}

const FLOW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Normalize a post_run_flows value (JSON string or array) to a de-duplicated
 *  list of uuid-shaped flow ids; anything else is dropped. */
export function parsePostRunFlows(raw: unknown): string[] {
  let arr: unknown = raw
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  const out: string[] = []
  for (const v of arr) {
    const id = String(v ?? '')
      .trim()
      .toUpperCase()
    if (FLOW_ID_RE.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

export type ImportProgress = (
  stage: 'preparing' | 'importing' | 'row_count' | 'completed',
  data?: Record<string, unknown>
) => Promise<void> | void

/** MSSQL caps bound parameters at ~2100; batch size accounts for column count. */
const MAX_BOUND_PARAMS = 2000
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function listImportDefinitions(activeOnly = true): Promise<ImportDefinition[]> {
  const rows = await db('nivaro_import_definitions')
    .modify((qb) => {
      if (activeOnly) qb.where('is_active', true)
    })
    .orderBy('sort')
    .orderBy('key')
  return rows.map((r: Record<string, unknown>) => ({
    ...r,
    is_active: !!r.is_active
  })) as ImportDefinition[]
}

export async function getImportDefinition(key: string): Promise<ImportDefinition | null> {
  const r = await db('nivaro_import_definitions').where({ key }).first()
  return r ? ({ ...r, is_active: !!r.is_active } as ImportDefinition) : null
}

/** Row cleaning inherited from the legacy importer. These rules are
 *  load-bearing wherever a procedure consumes the staging table: the SQL is
 *  written against values that have already been through them. */
export function cleanRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawKey, rawVal] of Object.entries(row)) {
    let key = rawKey.trim()
    let val = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal ?? '')

    if (val === '$-') val = '0'
    else if (val === '(blank)') val = ''

    if (val.startsWith('$') && Number.isNaN(Number(val))) val = val.replace(/\$|,/g, '')

    if (key.includes('_formatted_text')) {
      key = key.replace('_formatted_text', '')
      const escaped = val.replace(/[\\$'"]/g, '\\$&')
      out[key] =
        `{"time":1639447000063,"blocks":[{"id":"PEzptbLvOU","type":"paragraph","data":{"text":"${escaped}"}}],"version":"2.22.2"}`
    } else {
      out[key] = val
    }
  }
  return out
}

/** `raw: false` keeps everything as strings — staging columns are all text,
 *  and letting the sheet reader coerce silently reformats dates and long ids. */
export function parseImportFile(buffer: Buffer): Array<Record<string, string>> {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return []
  return XLSX.utils
    .sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false })
    .map(cleanRow)
}

/** From this size a file is read off the event loop (parseImportFileAsync). */
export const OFF_THREAD_PARSE_MIN_BYTES = 256 * 1024
/** Rows per message from the reader thread. */
const PARSE_SLICE = 2000

// The reader thread: plain CommonJS (an eval worker loads no TypeScript), the same XLSX.read
// options as parseImportFile. Rows go back one slice at a time and the next slice only when
// the event loop asks for it ('next'): Node delivers every message waiting on a port in ONE
// turn of the loop, so slices sent all at once were all copied in at once (0.3 s for a
// 30 MB file, 2026-11-19) — one in flight keeps each copy small.
const PARSE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
try {
  const XLSX = require(workerData.xlsx)
  const wb = XLSX.read(workerData.buf, { type: 'buffer', raw: false, cellDates: false })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }) : []
  let i = 0
  const send = () => {
    if (i >= rows.length) return parentPort.postMessage({ done: rows.length })
    parentPort.postMessage({ rows: rows.slice(i, i + workerData.slice) })
    i += workerData.slice
  }
  parentPort.on('message', (m) => {
    if (m === 'next') send()
  })
  send()
} catch (err) {
  parentPort.postMessage({ error: String((err && err.message) || err) })
}
`

let xlsxEntry: string | null | undefined
function xlsxPath(): string | null {
  if (xlsxEntry === undefined) {
    try {
      xlsxEntry = createRequire(import.meta.url).resolve('xlsx')
    } catch {
      xlsxEntry = null
    }
  }
  return xlsxEntry
}

/** Let timers and sockets run between slices of CPU work on the event loop. */
export { yieldToLoop }

/**
 * parseImportFile without freezing the process (EFP prod 2026-11-16: a 30 MB invoices CSV
 * parsed inline on a web process stalled its event loop for up to 13.4 s). XLSX.read is one
 * synchronous call, so a file from OFF_THREAD_PARSE_MIN_BYTES is read on a worker thread and
 * its rows cleaned here a slice at a time, yielding whenever a slice of work has run its
 * budget. Same rows, same errors. When a thread cannot start, it reads inline as before.
 */
export async function parseImportFileAsync(
  buffer: Buffer,
  opts: { minBytes?: number } = {}
): Promise<Array<Record<string, string>>> {
  const entry = xlsxPath()
  if (buffer.length < (opts.minBytes ?? OFF_THREAD_PARSE_MIN_BYTES) || !entry) {
    return parseImportFile(buffer)
  }
  let worker: Worker
  try {
    worker = new Worker(PARSE_WORKER_SOURCE, {
      eval: true,
      workerData: { buf: buffer, xlsx: entry, slice: PARSE_SLICE }
    })
  } catch {
    return parseImportFile(buffer)
  }
  const out: Array<Record<string, string>> = []
  const pace = makePacer()
  try {
    await new Promise<void>((resolve, reject) => {
      let failed = false
      const fail = (err: unknown) => {
        failed = true
        reject(err)
      }
      // One slice at a time: clean it (yielding as it goes), then ask for the next.
      const clean = async (slice: Record<string, unknown>[]) => {
        for (const r of slice) {
          if (pace.due()) await pace.breathe()
          out.push(cleanRow(r))
        }
        if (!failed) worker.postMessage('next')
      }
      worker.on(
        'message',
        (m: { rows?: Record<string, unknown>[]; done?: number; error?: string }) => {
          if (m.rows) clean(m.rows).catch(fail)
          else if (m.error != null) fail(new Error(m.error))
          else if (m.done != null) resolve()
        }
      )
      worker.once('error', fail)
      worker.once('exit', (code) => {
        if (code !== 0) fail(new Error(`The file reader stopped (exit ${code})`))
      })
    })
  } finally {
    void worker.terminate().catch(() => {})
  }
  return out
}

/**
 * TSV in the dialect BULK INSERT expects below: `||` between fields, LF
 * terminated, header skipped via FIRSTROW=2.
 *
 * Deliberately UNQUOTED. BULK INSERT has no text qualifier — it splits purely
 * on the terminators — so a wrapping quote is not stripped, it is stored. That
 * matters because the procedures join staging straight against real data
 * (`LEFT JOIN regions r ON r.short_name = st.region`), and `'HRT'` matches no
 * region that `HRT` would. The legacy importer appeared to wrap every field but
 * its CSV library only wrapped values that actually contained a delimiter, so
 * in practice it wrote bare values too.
 *
 * With no qualifier available, a value containing the field delimiter or a line
 * break would split the row, so both are neutralised instead. A pipe at either
 * END of a value is neutralised too: `a|` next to the `||` delimiter reads as
 * `a|||b`, which BULK INSERT splits after `a` — shifting the text into the next
 * column (security audit 2026-10-27, Low). A single pipe inside a value stays.
 */
const tsvCell = (v: string) =>
  String(v ?? '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\|{2,}/g, ' ')
    .replace(/^\|/, ' ')
    .replace(/\|$/, ' ')

export function toTsv(rows: Array<Record<string, string>>, columns: string[]): string {
  const lines = [columns.map(tsvCell).join('||')]
  for (const r of rows) lines.push(columns.map((c) => tsvCell(r[c] ?? '')).join('||'))
  return `${lines.join('\n')}\n`
}

/** toTsv for a run: the same text, built with a yield whenever a slice of work has run its
 *  budget (200k rows took ~0.9 s of event loop in one piece). */
export async function toTsvAsync(
  rows: Array<Record<string, string>>,
  columns: string[]
): Promise<string> {
  const parts = [`${columns.map(tsvCell).join('||')}\n`]
  const pace = makePacer()
  let lines: string[] = []
  for (const r of rows) {
    lines.push(columns.map((c) => tsvCell(r[c] ?? '')).join('||'))
    if (pace.due()) {
      parts.push(`${lines.join('\n')}\n`)
      lines = []
      await pace.breathe()
    }
  }
  if (lines.length > 0) parts.push(`${lines.join('\n')}\n`)
  return parts.join('')
}

/** The distinct keys of every row, read with yields (a 250k-row file: ~0.1 s in one piece). */
export async function rowKeysAsync(rows: Array<Record<string, string>>): Promise<string[]> {
  const keys = new Set<string>()
  const pace = makePacer()
  for (const r of rows) {
    if (pace.due()) await pace.breathe()
    for (const k in r) keys.add(k)
  }
  return [...keys]
}

/** rows.map(fn) with a yield whenever a slice of work has run its budget. */
export async function mapRowsAsync<T, U>(rows: T[], fn: (row: T) => U): Promise<U[]> {
  const out: U[] = new Array(rows.length)
  const pace = makePacer()
  for (let j = 0; j < rows.length; j++) {
    if (pace.due()) await pace.breathe()
    out[j] = fn(rows[j])
  }
  return out
}

/** Redact secrets from text about to be persisted or shown. A failed
 *  smbclient run rejects with an Error embedding its whole argv, and that
 *  message reaches the run log and a user notification. */
export function scrubSecrets(text: string): string {
  let out = text
  for (const key of ['SAMBA_PASS', 'SAMBA_USER', 'SAMBA_IP']) {
    const value = process.env[key]
    if (value && value.length > 2) out = out.split(value).join(`<${key}>`)
  }
  return out
}

/**
 * Flatten a driver error into something a person can act on.
 *
 * knex's mssql dialect rejects with an AggregateError whose own `message` is
 * just `<sql> - ` — the actual SQL Server messages live in `.errors`. Persisting
 * `err.message` alone therefore logged the statement and nothing about why it
 * failed, which is how a bulk-load conversion error reached a user as a bare
 * BULK INSERT string.
 */
export function describeSqlError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const inner = (err as { errors?: unknown }).errors
  const parts = Array.isArray(inner)
    ? inner
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .filter(Boolean)
        // BULK INSERT reports one message per bad row; they are all the same
        // shape and the first few are enough to diagnose it.
        .slice(0, 5)
    : []
  const head = err.message.trim().replace(/ - $/, '')
  if (parts.length === 0) return head || String(err)
  const extra =
    Array.isArray(inner) && inner.length > parts.length
      ? ` (+${inner.length - parts.length} more)`
      : ''
  return `${head}\n${parts.join('\n')}${extra}`
}

/** Credentials go in a 0600 auth file, never argv: `--password` exposes the
 *  secret to `ps` and to the error message of any failed run. */
async function withShare<T>(fn: (target: string, authPath: string) => Promise<T>): Promise<T> {
  const user = process.env.SAMBA_USER
  const pass = process.env.SAMBA_PASS
  const ip = process.env.SAMBA_IP
  const share = process.env.SAMBA_SHARE ?? 'ImportFiles'
  if (!user || !pass || !ip) {
    throw new Error(
      'The bulk loader needs SAMBA_USER, SAMBA_PASS and SAMBA_IP (or set the definition loader to "insert")'
    )
  }

  const authPath = join(tmpdir(), `nivaro-smb-${randomUUID()}.auth`)
  await writeFile(
    authPath,
    `username = ${user}\npassword = ${pass}\ndomain = ${process.env.SAMBA_WORKGROUP ?? 'CABLE'}\n`,
    { mode: 0o600 }
  )
  try {
    return await fn(`\\\\${ip}\\${share}`, authPath)
  } finally {
    await unlink(authPath).catch(() => {})
  }
}

async function pushToShare(localPath: string, remoteName: string): Promise<void> {
  await withShare(async (target, authPath) => {
    try {
      await execFileAsync('smbclient', [
        target,
        '-A',
        authPath,
        '-c',
        `put ${localPath} ${remoteName}`
      ])
    } catch (err) {
      const e = err as { stderr?: string; code?: string; message?: string }
      // A missing binary is ENOENT with no stderr at all — the usual case on
      // a deployed image, which never carries smbclient.
      const reason =
        e?.code === 'ENOENT'
          ? 'smbclient is not installed on this host — set the definition loader to "insert" (the default) or install it'
          : String(e?.stderr || e?.message || 'unknown error')
      throw new Error(`smbclient upload failed: ${scrubSecrets(reason).trim()}`)
    }
  })
}

/** Remove the staged file once SQL Server has read it. The legacy importer
 *  always wrote `temp.txt` and so overwrote itself; unique names mean every run
 *  would otherwise leave a full-size file behind and slowly fill the share.
 *  Best-effort: a load that succeeded must not be reported as failed because
 *  the cleanup did not. */
async function deleteFromShare(remoteName: string): Promise<void> {
  await withShare(async (target, authPath) => {
    await execFileAsync('smbclient', [target, '-A', authPath, '-c', `del ${remoteName}`])
  })
}

/** Staging tables are all-text by design — the procedure does the casting.
 *  Existing tables are emptied rather than dropped so a shape a procedure
 *  depends on survives a column change in the source file.
 *
 *  With a DECLARED schema the table converges on the declaration instead of
 *  whatever the last file looked like: missing declared columns are ADDED
 *  (never dropped — dropping is an explicit admin act), so a re-exported
 *  sheet can't silently reshape the table under the procedure. */
async function ensureStagingTable(
  table: string,
  columns: string[],
  declared?: string[] | null
): Promise<void> {
  const wanted = declared && declared.length > 0 ? declared : columns
  if (await db.schema.hasTable(table)) {
    if (declared && declared.length > 0) {
      const existing = new Set(
        sqlDialect(db as unknown as Knex) === 'mssql'
          ? (
              (await db('information_schema.columns')
                .where('table_name', table)
                .pluck('column_name')) as string[]
            ).map((c) => c.toLowerCase())
          : // MySQL 8 labels information_schema columns in upper case, and both other
            // databases may hold the name in another schema: read this one's columns
            (await describeColumns(db as unknown as Knex, table)).map((c) => c.name.toLowerCase())
      )
      const missing = wanted.filter((c) => c !== 'id' && !existing.has(c.toLowerCase()))
      if (missing.length > 0) {
        await db.schema.alterTable(table, (t) => {
          for (const c of missing) t.text(c)
        })
      }
    }
    await db.raw('DELETE FROM ??', [table])
    return
  }
  await db.schema.createTable(table, (t) => {
    t.increments()
    for (const c of wanted) if (c !== 'id') t.text(c)
  })
}

/**
 * Run a statement with a request timeout of its own.
 *
 * tedious applies a connection-level 15s requestTimeout, which neither stage of
 * a staged import fits inside: a bulk load of 40k rows runs ~15s on its own, and
 * the procedures are the whole point — legacy order-import runs took
 * over three minutes. Past the timeout tedious sends an attention and the batch
 * is cancelled mid-flight, which for a procedure wrapped in BEGIN TRAN … COMMIT
 * means the work is thrown away (and, without SET XACT_ABORT ON, can leave the
 * transaction open on a pooled connection).
 *
 * Same per-request escape hatch the custom-query executor uses for heavy report
 * procs, rather than raising requestTimeout globally where one hung query would
 * hold a pool connection for an hour.
 */
const STATEMENT_TIMEOUT_MS = Math.max(
  15_000,
  Number(process.env.IMPORT_STATEMENT_TIMEOUT_MS ?? 3_600_000) || 3_600_000
)

async function runLongSql(sql: string): Promise<void> {
  await runLong(sql, { timeoutMs: STATEMENT_TIMEOUT_MS })
}

interface TargetColumn {
  name: string
  isIdentity: boolean
  isComputed: boolean
}

async function describeTable(table: string): Promise<TargetColumn[]> {
  if (sqlDialect(db as unknown as Knex) !== 'mssql')
    return describeColumns(db as unknown as Knex, table)
  const rows = (await db.raw(
    `SELECT c.name, c.is_identity, c.is_computed
       FROM sys.columns c
      WHERE c.object_id = OBJECT_ID(?)
      ORDER BY c.column_id`,
    [table]
  )) as Array<{ name: string; is_identity: number | boolean; is_computed: number | boolean }>
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    name: String(r.name),
    isIdentity: !!r.is_identity,
    isComputed: !!r.is_computed
  }))
}

/**
 * BULK INSERT maps the file's fields to the table's columns BY POSITION, and it
 * offers no column list. Two consequences that a staging table walks straight
 * into:
 *
 *   1. An IDENTITY column still counts as a position. Every legacy staging
 *      table leads with `id int IDENTITY`, so field 1 of the file is parsed
 *      into it and a text value fails with "Bulk load data conversion error …
 *      for row 2, column 1 (id)". Skipping it needs a format file or a view.
 *   2. If the file's columns are ordered differently from the table's — a
 *      re-exported sheet with two columns swapped — every row loads into the
 *      WRONG columns, silently, because the types are all text.
 *
 * A view fixes both at once: project the table's real columns in the FILE's
 * order and bulk-load into that, so alignment is correct by construction and
 * the identity column simply isn't in it.
 */
export function normalizeHeader(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Whether a definition's service_config asks for a copy of the file in the
 *  staging table. Only a follow-up that READS the table needs one (a post-run
 *  flow op, a procedure); the items-service paths work from the parsed rows. */
function keepsStaging(raw: unknown): boolean {
  if (!raw) return false
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return !!(v && typeof v === 'object' && (v as { keep_staging?: unknown }).keep_staging === true)
  } catch {
    return false
  }
}

/** Why a bulk load could not happen on THIS host — the share, smbclient or
 *  BULK INSERT itself — as opposed to a problem with the file (an unknown
 *  column, a conversion error), which the insert loader would hit too. */
export function bulkUnavailableReason(err: unknown): string | null {
  const msg = describeSqlError(err)
  const patterns: Array<[RegExp, string]> = [
    [/needs SAMBA_USER/i, 'the SMB share is not configured on this host'],
    [/smbclient is not installed/i, 'smbclient is not installed on this host'],
    [/smbclient upload failed/i, 'the SMB share could not be reached'],
    [
      /do(es)? not have permission to use the bulk load|bulkadmin|ADMINISTER BULK OPERATIONS/i,
      'this login may not run BULK INSERT'
    ],
    [
      /Cannot bulk load because the file|could not be opened|Operating system error/i,
      'SQL Server could not read the file on the share'
    ],
    [/BULK INSERT needs SQL Server/i, 'this database is not SQL Server']
  ]
  for (const [re, why] of patterns) if (re.test(msg)) return why
  return null
}

/** Fill the staging table and return how long it took. Batched inserts are
 *  the default — they need nothing outside the database. The bulk loader
 *  (a file on an SMB share + BULK INSERT) runs only when a definition or
 *  IMPORT_LOADER names it: it needs `smbclient` on the host and SAMBA_*
 *  credentials, neither of which a deployed image carries. When it cannot run
 *  here the load continues on batched inserts and `note` says so, unless the
 *  definition pins 'bulk_only'. */
async function loadStaging(
  definition: Pick<ImportDefinition, 'loader'>,
  table: string,
  rows: Array<Record<string, string>>,
  columns: string[],
  declaredNames: string[] | null
): Promise<{ ms: number; note: string | null }> {
  const began = Date.now()
  await ensureStagingTable(table, columns, declaredNames)
  const loader: StagingLoader =
    definition.loader ?? ((process.env.IMPORT_LOADER as StagingLoader) || 'insert')
  let note: string | null = null
  if (loader === 'bulk' || loader === 'bulk_only') {
    try {
      await loadViaShare(table, rows, columns)
    } catch (err) {
      const why = loader === 'bulk' ? bulkUnavailableReason(err) : null
      if (!why) throw err
      // BULK INSERT is one transaction, but start from an empty table anyway:
      // the insert loader must never append to a half-written load.
      await db(table).del()
      await loadChunked(table, rows, columns)
      note = `Bulk load unavailable (${why}) — loaded with batched inserts instead.`
    }
  } else {
    await loadChunked(table, rows, columns)
  }
  return { ms: Date.now() - began, note }
}

async function loadViaShare(
  table: string,
  rows: Array<Record<string, string>>,
  columns: string[]
): Promise<void> {
  // BULK INSERT from an SMB share is SQL Server's; 'bulk' falls back to batched inserts
  if (sqlDialect(db as unknown as Knex) !== 'mssql')
    throw new Error('BULK INSERT needs SQL Server — the bulk load is unavailable on this database')
  const target = await describeTable(table)
  if (target.length === 0) throw new Error(`Staging table ${table} not found`)

  // Match case-insensitively: SQL Server's default collation is, and a sheet
  // header rarely matches a column's casing exactly. Fallback: squash
  // non-alphanumerics to underscores so a "Base Invoice" / "Tax/Other" header
  // finds base_invoice / tax_other without demanding exact punctuation.
  const byLower = new Map(target.map((c) => [c.name.toLowerCase(), c]))
  const byNormalized = new Map(target.map((c) => [normalizeHeader(c.name), c]))
  const matchColumn = (col: string) =>
    byLower.get(col.toLowerCase()) ?? byNormalized.get(normalizeHeader(col))
  const loadable: string[] = []
  const unknown: string[] = []
  for (const col of columns) {
    const hit = matchColumn(col)
    if (!hit || hit.isIdentity || hit.isComputed) {
      // An identity/computed column named in the file is skipped, not an error:
      // legacy sheets carry an `id` column that the server assigns anyway.
      if (!hit) unknown.push(col)
      continue
    }
    loadable.push(hit.name)
  }
  if (unknown.length > 0) {
    throw new Error(
      `${table} has no column for ${unknown.join(', ')} — the file's columns must exist in the staging table. Drop the column from the file, or add it to the table.`
    )
  }
  if (loadable.length === 0) throw new Error(`No loadable columns for ${table}`)
  for (const c of loadable) {
    if (!IDENT.test(c)) throw new Error(`Unsafe column name in ${table}: ${c}`)
  }

  // The file mirrors the view: identity/computed columns are dropped from BOTH
  // sides, so field N always lines up with view column N.
  const fileColumns = columns.filter((c) => {
    const hit = matchColumn(c)
    return !!hit && !hit.isIdentity && !hit.isComputed
  })

  const remoteName = `nivaro_${table}_${randomUUID().slice(0, 8)}.txt`
  const localPath = join(tmpdir(), remoteName)
  await writeFile(localPath, await toTsvAsync(rows, fileColumns), 'utf8')
  try {
    await pushToShare(localPath, remoteName)
  } finally {
    await unlink(localPath).catch(() => {})
  }

  const view = `nivaro_bulk_${table}`.slice(0, 128)
  if (!IDENT.test(view)) throw new Error(`Unsafe view name: ${view}`)
  const select = loadable.map((c) => `[${c}]`).join(', ')
  const remoteDir = process.env.SAMBA_SERVER_PATH ?? 'T:\\ImportFiles'
  await db.raw(`CREATE OR ALTER VIEW ${view} AS SELECT ${select} FROM ${table}`)
  try {
    await runLongSql(
      `BULK INSERT ${view} FROM '${remoteDir}\\${remoteName}' WITH (FIRSTROW=2, FIELDTERMINATOR='||', ROWTERMINATOR='0x0a', KEEPNULLS, MAXERRORS = 10)`
    )
  } finally {
    // Never leave the loader's scaffolding behind — in the database or on the
    // share. Both are shared with the legacy Directus instance.
    await db.raw(`DROP VIEW IF EXISTS ${view}`).catch(() => {})
    await deleteFromShare(remoteName).catch(() => {})
  }
}

async function loadChunked(
  table: string,
  rows: Array<Record<string, string>>,
  columns: string[]
): Promise<void> {
  // Same header tolerance as the bulk loader: exact (case-insensitive) column
  // name first, then punctuation-squashed. Unmatched headers keep their raw
  // name so the insert still fails loudly instead of silently dropping data.
  const target = await describeTable(table)
  const byLower = new Map(target.map((c) => [c.name.toLowerCase(), c.name]))
  const byNormalized = new Map(target.map((c) => [normalizeHeader(c.name), c.name]))
  const colName = (c: string) =>
    byLower.get(c.toLowerCase()) ?? byNormalized.get(normalizeHeader(c)) ?? c
  const perBatch = Math.max(1, Math.floor(MAX_BOUND_PARAMS / Math.max(1, columns.length)))
  for (let i = 0; i < rows.length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch).map((r) => {
      const o: Record<string, string> = {}
      for (const c of columns) if (c !== 'id') o[colName(c)] = r[c] ?? ''
      return o
    })
    await db(table).insert(batch)
  }
}

/** File rows → declared staging columns, the way the worker maps them: header
 *  matching is punctuation-tolerant and only declared columns survive. No
 *  declared schema = rows pass through untouched. */
export function mapRowsToDeclared(
  definition: ImportDefinition,
  rows: Array<Record<string, string>>
): Array<Record<string, string>> {
  const declared = parseStagingColumns(definition.staging_columns)
  if (!declared) return rows
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'id')
  const { headerFor } = resolveHeaderMap(columns, declared)
  return rows.map((r) => {
    const o: Record<string, string> = {}
    for (const col of declared) {
      const h = headerFor.get(col.name)
      o[col.name] = h ? (r[h] ?? '') : ''
    }
    return o
  })
}

/** mapRowsToDeclared for a web process: the same rows, read and mapped with yields (a
 *  250k-row file took ~0.3 s of event loop in one piece). */
export async function mapRowsToDeclaredAsync(
  definition: Pick<ImportDefinition, 'staging_columns'>,
  rows: Array<Record<string, string>>
): Promise<Array<Record<string, string>>> {
  const declared = parseStagingColumns(definition.staging_columns)
  if (!declared) return rows
  const columns = (await rowKeysAsync(rows)).filter((c) => c !== 'id')
  const { headerFor } = resolveHeaderMap(columns, declared)
  const pairs = declared.map((col) => [col.name, headerFor.get(col.name)] as const)
  return mapRowsAsync(rows, (r) => {
    const o: Record<string, string> = {}
    for (const [name, h] of pairs) o[name] = h ? (r[h] ?? '') : ''
    return o
  })
}

export interface RunImportOptions {
  definition: ImportDefinition
  buffer: Buffer
  /** Queuing user — service-mode writes run as them (RBAC applies). */
  createdBy?: string | null
  onProgress?: ImportProgress
  /** The nivaro_import_queue row — service-mode writes carry it as their
   *  change reason so a record's Notes thread names the run (#60). */
  runId?: number | null
  /** The file's rows when the caller already read them (the worker validates first). */
  rows?: Array<Record<string, string>>
}

/** What a run reports, whichever importer produced it. */
interface RunOutcome {
  created: number
  updated: number
  unchanged: number
  skipped: Record<string, number>
  failed: number
  report?: {
    phases?: ImportRunReport['phases']
    unmatched?: ImportRunReport['unmatched']
    notes?: string[]
    other?: Array<{ label: string; count: number }>
  }
  items?: ImportRunItem[]
}

async function storeRunReport(
  runId: number,
  result: RunOutcome,
  rowCount: number,
  parseMs: number,
  loadMs: number | null
): Promise<void> {
  const skippedTotal = Object.values(result.skipped).reduce((a, b) => a + b, 0)
  const collections: Record<string, { created: number; updated: number }> = {}
  for (const it of result.items ?? []) {
    if (!it.collection || (it.kind !== 'created' && it.kind !== 'updated')) continue
    const c = collections[it.collection] ?? { created: 0, updated: 0 }
    collections[it.collection] = c
    if (it.kind === 'created') c.created++
    else c.updated++
  }
  const report: ImportRunReport = {
    counts: {
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      skipped: skippedTotal,
      failed: result.failed,
      ...(result.report?.other?.length ? { other: result.report.other } : {})
    },
    skipped: result.skipped,
    phases: [
      { key: 'read-file', label: 'Read the file', ms: parseMs, count: rowCount },
      ...(loadMs != null
        ? [{ key: 'staging', label: 'Kept a copy of the file', ms: loadMs, count: rowCount }]
        : []),
      ...(result.report?.phases ?? [])
    ],
    unmatched: result.report?.unmatched ?? [],
    notes: result.report?.notes ?? [],
    collections
  }
  await saveRunReport(runId, report, result.items ?? [])
}

export async function runStagedImport({
  definition,
  buffer,
  createdBy,
  onProgress,
  runId = null,
  rows: preparsed
}: RunImportOptions): Promise<{
  rowCount: number
  durationSeconds: number
  summary?: string
  /** Records a processor run changed, per collection — for the post-run flows. */
  affected?: Record<string, Array<string | number>>
  /** Every stored record the file named, changed or not, per collection. */
  matched?: Record<string, Array<string | number>>
  /** The parsed, header-mapped rows — the worker keeps them for the post-run flows. */
  rows?: Array<Record<string, string>>
}> {
  const began = Date.now()

  const table = definition.staging_table || `staging_${definition.key}`
  // Both reach SQL by interpolation (BULK INSERT and EXEC take no bindings for
  // an object name), so they must be plain identifiers. They come from an
  // admin-managed definition row, not from the uploader — but validate anyway.
  if (!IDENT.test(table)) throw new Error(`Unsafe staging table name: ${table}`)
  if (definition.procedure && !IDENT.test(definition.procedure)) {
    throw new Error(`Unsafe procedure name: ${definition.procedure}`)
  }

  let rows = preparsed ?? (await parseImportFileAsync(buffer))
  if (rows.length === 0) throw new Error('File contained no rows')
  const parseMs = Date.now() - began
  await onProgress?.('row_count', { row_count: rows.length })

  // Derived from ALL rows: keying the schema off row 1 (as the legacy importer
  // did) silently drops columns that only appear later in the file.
  let columns = (await rowKeysAsync(rows)).filter((c) => c !== 'id')

  // Declared schema: file headers map onto the declared columns (same
  // punctuation-tolerant matching the validator uses) and ONLY declared
  // columns load — an extra sheet column can't invent a staging column, and
  // the procedure reads the names it was written against.
  const declared = parseStagingColumns(definition.staging_columns)
  let declaredNames: string[] | null = null
  if (declared) {
    const { headerFor } = resolveHeaderMap(columns, declared)
    rows = await mapRowsAsync(rows, (r) => {
      const o: Record<string, string> = {}
      for (const col of declared) {
        const h = headerFor.get(col.name)
        o[col.name] = h ? (r[h] ?? '') : ''
      }
      return o
    })
    declaredNames = declared.map((c) => c.name).filter((c) => c !== 'id')
    columns = declaredNames
  }

  // Service mode: the parsed, header-mapped rows are compared with the stored
  // records and only what differs is written. No procedure runs over a
  // staging table; the table is loaded only when the definition asks for a
  // copy of the file there (a follow-up procedure or flow reads it).
  let loadNote: string | null = null
  const withNote = (log: string | undefined) =>
    loadNote ? [loadNote, log].filter(Boolean).join('\n') : log

  if (definition.processor === 'service') {
    const cfg = parseServiceConfig(definition.service_config)
    if (!cfg)
      throw new Error(`Import "${definition.key}" is service-mode but has no valid service_config`)
    let loadMs: number | null = null
    if (cfg.keep_staging) {
      await onProgress?.('preparing')
      const loaded = await loadStaging(definition, table, rows, columns, declaredNames)
      loadMs = loaded.ms
      loadNote = loaded.note
    }
    if (runId != null) await recordRanVia(runId, 'service')
    await onProgress?.('importing')
    const summary = await runServiceImport({
      config: cfg,
      rows,
      createdBy: createdBy ?? null,
      onProgress: (written, total) => onProgress?.('importing', { written, total }),
      stamp: runId != null ? `import:${definition.label || definition.key}:run-${runId}` : null
    })
    if (runId != null) await storeRunReport(runId, summary, rows.length, parseMs, loadMs)
    if (summary.failed > 0 && summary.created + summary.updated + (summary.removed ?? 0) === 0) {
      // Nothing landed — surface as a failed run, not a quiet "completed".
      throw new Error(`Import wrote nothing:\n${summary.log}`)
    }
    const durationSeconds = Math.round((Date.now() - began) / 1000)
    await onProgress?.('completed', { row_count: rows.length, duration: durationSeconds })
    return {
      rowCount: rows.length,
      durationSeconds,
      summary: withNote(summary.log),
      affected: summary.affected,
      matched: summary.matched,
      rows
    }
  }

  // A registered processor: the rows are classified against live data and
  // only real changes are written, through the items service. The processor
  // reads the parsed rows, never the staging table, so the table is loaded
  // only when the definition asks for a copy (`keep_staging` — a post-run
  // flow reads it). A procedure, by contrast, has nothing else to read.
  const wantsProcessor =
    !!definition.processor && definition.processor !== 'service' && definition.processor !== 'proc'
  const processor = wantsProcessor ? getImportProcessor(definition.processor) : null
  if (wantsProcessor && !processor && !definition.procedure) {
    throw new Error(
      `Import "${definition.key}" names the processor "${definition.processor}", which is not registered on this instance, and has no procedure to fall back to`
    )
  }

  let loadMs: number | null = null
  if (!processor || keepsStaging(definition.service_config)) {
    await onProgress?.('preparing')
    const loaded = await loadStaging(definition, table, rows, columns, declaredNames)
    loadMs = loaded.ms
    loadNote = loaded.note
  }

  if (runId != null) {
    await recordRanVia(
      runId,
      processor
        ? String(definition.processor)
        : definition.procedure
          ? `procedure:${definition.procedure}`
          : 'load'
    )
  }

  if (processor) {
    await onProgress?.('importing')
    const result = await runImportProcessor({
      processor,
      definition,
      rows,
      createdBy: createdBy ?? null,
      onProgress: (written, total) => onProgress?.('importing', { written, total }),
      stamp: runId != null ? `import:${definition.label || definition.key}:run-${runId}` : null
    })
    if (runId != null) await storeRunReport(runId, result, rows.length, parseMs, loadMs)
    if (result.failed > 0 && result.created + result.updated === 0) {
      throw new Error(`Import wrote nothing:\n${result.log}`)
    }
    const durationSeconds = Math.round((Date.now() - began) / 1000)
    await onProgress?.('completed', { row_count: rows.length, duration: durationSeconds })
    return {
      rowCount: rows.length,
      durationSeconds,
      summary: withNote(result.log),
      affected: result.affected,
      rows
    }
  }

  if (definition.procedure) {
    await onProgress?.('importing')
    // SQL Server EXECs the procedure; Postgres and MySQL CALL it (a procedure the customer
    // created on their own database — no arguments, the name already checked against IDENT)
    await runLongSql(
      sqlDialect(db as unknown as Knex) === 'mssql'
        ? `EXEC ${definition.procedure}`
        : `CALL ${definition.procedure}()`
    )
  }

  const notes: string[] = []
  if (loadNote) notes.push(loadNote)
  // The extension that owns the processor did not load here: the procedure
  // ran instead, and the run says so.
  if (wantsProcessor) {
    notes.push(
      `Ran the procedure ${definition.procedure}: the processor "${definition.processor}" is not registered on this instance.`
    )
  }
  // #719 — the procedure wrote raw rows; recompute the stored rollups they feed.
  const rollupCollections = definition.procedure
    ? parseRecalcRollups(definition.recalc_rollups)
    : []
  if (rollupCollections.length > 0) {
    await onProgress?.('importing', { phase: 'rollups' })
    notes.push(describeRollupRecalc(await recalcRollupsFedBy(rollupCollections)))
    // #1875 — the procedure wrote set-based: tell open pages on those collections.
    await import('./raw-write-announcer.js')
      .then(async ({ announceRawWrites }) => {
        for (const c of rollupCollections) {
          await announceRawWrites(c, null, { action: 'update', source: `import:${definition.key}` })
        }
      })
      .catch(() => {})
  }
  // rt-fix C (M2): the procedure's own write targets — read from its definition — so open lists,
  // queues, widgets and records of every table it wrote refresh, not only the rollup ones.
  // A notice only: the import never started flows, webhooks or alerts and still does not.
  if (definition.procedure) {
    const { announceProcedureWrites } = await import('./import-proc-targets.js')
    await announceProcedureWrites(definition.procedure, {
      source: `import:${definition.key}`,
      storedBody: definition.procedure_body,
      skip: rollupCollections
    })
  }

  const durationSeconds = Math.round((Date.now() - began) / 1000)
  await onProgress?.('completed', { row_count: rows.length, duration: durationSeconds })
  return {
    rowCount: rows.length,
    durationSeconds,
    ...(notes.length > 0
      ? { summary: [`Imported ${rows.length} rows.`, ...notes].join('\n') }
      : {}),
    rows
  }
}
