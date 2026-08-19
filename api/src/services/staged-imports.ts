import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as XLSX from 'xlsx'
import { db } from '../db/index.js'
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

export type StagingLoader = 'bulk' | 'insert'

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
}

export interface ImportProgress {
  (
    stage: 'preparing' | 'importing' | 'row_count' | 'completed',
    data?: Record<string, unknown>
  ): Promise<void> | void
}

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

/** Row cleaning inherited from the legacy EFP importer. These rules are
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
 * break would split the row, so both are neutralised instead.
 */
export function toTsv(rows: Array<Record<string, string>>, columns: string[]): string {
  const cell = (v: string) =>
    (v ?? '')
      .replace(/\r?\n/g, ' ')
      .split('||')
      .join(' ')
  const lines = [columns.map(cell).join('||')]
  for (const r of rows) lines.push(columns.map((c) => cell(r[c] ?? '')).join('||'))
  return `${lines.join('\n')}\n`
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
  const extra = Array.isArray(inner) && inner.length > parts.length ? ` (+${inner.length - parts.length} more)` : ''
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
      await execFileAsync('smbclient', [target, '-A', authPath, '-c', `put ${localPath} ${remoteName}`])
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr
      throw new Error(
        `smbclient upload failed: ${scrubSecrets(String(stderr || 'unknown error')).trim()}`
      )
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
        ((await db('information_schema.columns')
          .where('table_name', table)
          .pluck('column_name')) as string[]).map((c) => c.toLowerCase())
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
 * the procedures are the whole point — the legacy `purchase_orders` runs took
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
  // biome-ignore lint/suspicious/noExplicitAny: internal Knex/tedious plumbing
  const knexClient = (db as any).client
  const Driver = knexClient._driver() as {
    Request: new (sql: string, cb: (err: Error | null) => void) => unknown
  }
  const conn = (await knexClient.acquireConnection()) as { execSqlBatch(r: unknown): void }
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      const req = new Driver.Request(sql, (err: Error | null) => {
        if (err) done(() => reject(err))
      }) as {
        on(ev: 'error', h: (e: Error) => void): unknown
        once(ev: 'requestCompleted', h: () => void): unknown
        setTimeout?: (ms: number) => void
      }
      req.setTimeout?.(STATEMENT_TIMEOUT_MS)
      req.once('requestCompleted', () => done(() => resolve()))
      req.on('error', (e) => done(() => reject(e)))
      conn.execSqlBatch(req)
    })
  } finally {
    await knexClient.releaseConnection(conn)
  }
}

interface TargetColumn {
  name: string
  isIdentity: boolean
  isComputed: boolean
}

async function describeTable(table: string): Promise<TargetColumn[]> {
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
function normalizeHeader(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

async function loadViaShare(
  table: string,
  rows: Array<Record<string, string>>,
  columns: string[]
): Promise<void> {
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
  await writeFile(localPath, toTsv(rows, fileColumns), 'utf8')
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
  const colName = (c: string) => byLower.get(c.toLowerCase()) ?? byNormalized.get(normalizeHeader(c)) ?? c
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

export interface RunImportOptions {
  definition: ImportDefinition
  buffer: Buffer
  onProgress?: ImportProgress
}

export async function runStagedImport({
  definition,
  buffer,
  onProgress
}: RunImportOptions): Promise<{ rowCount: number; durationSeconds: number }> {
  const began = Date.now()

  const table = definition.staging_table || `staging_${definition.key}`
  // Both reach SQL by interpolation (BULK INSERT and EXEC take no bindings for
  // an object name), so they must be plain identifiers. They come from an
  // admin-managed definition row, not from the uploader — but validate anyway.
  if (!IDENT.test(table)) throw new Error(`Unsafe staging table name: ${table}`)
  if (definition.procedure && !IDENT.test(definition.procedure)) {
    throw new Error(`Unsafe procedure name: ${definition.procedure}`)
  }

  let rows = parseImportFile(buffer)
  if (rows.length === 0) throw new Error('File contained no rows')
  await onProgress?.('row_count', { row_count: rows.length })

  // Derived from ALL rows: keying the schema off row 1 (as the legacy importer
  // did) silently drops columns that only appear later in the file.
  let columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'id')

  // Declared schema: file headers map onto the declared columns (same
  // punctuation-tolerant matching the validator uses) and ONLY declared
  // columns load — an extra sheet column can't invent a staging column, and
  // the procedure reads the names it was written against.
  const declared = parseStagingColumns(definition.staging_columns)
  let declaredNames: string[] | null = null
  if (declared) {
    const { headerFor } = resolveHeaderMap(columns, declared)
    rows = rows.map((r) => {
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

  await onProgress?.('preparing')
  await ensureStagingTable(table, columns, declaredNames)

  const loader: StagingLoader =
    definition.loader ?? ((process.env.IMPORT_LOADER as StagingLoader) || 'bulk')
  if (loader === 'insert') await loadChunked(table, rows, columns)
  else await loadViaShare(table, rows, columns)

  if (definition.procedure) {
    await onProgress?.('importing')
    await runLongSql(`EXEC ${definition.procedure}`)
  }

  const durationSeconds = Math.round((Date.now() - began) / 1000)
  await onProgress?.('completed', { row_count: rows.length, duration: durationSeconds })
  return { rowCount: rows.length, durationSeconds }
}
