import { db } from '../db/index.js'
import { withLongConnection } from './run-long.js'
import {
  describeSqlError,
  type ImportDefinition,
  lockGroupOf,
  mapRowsToDeclared,
  normalizeHeader
} from './staged-imports.js'

/**
 * #717 — rehearse a procedure-mode import: load the file into the staging
 * table and EXEC the procedure inside ONE transaction on one pinned
 * connection, count every table the procedure writes before and after, then
 * roll everything back. The admin sees "purchase_orders +12, line_items +340"
 * before queueing the real run.
 *
 * Refused up front when a rollback could not undo the run: a procedure (or
 * one it calls) that COMMITs more transactions than it opens would commit the
 * rehearsal's own transaction, and one that reaches outside the database
 * (mail, shell, linked servers) cannot be rolled back at all. Refused at run
 * time when the procedure ended the transaction anyway (@@TRANCOUNT moved) —
 * the counts are then not trustworthy, but nothing was committed.
 *
 * The rehearsal holds locks on every table the procedure touches for as long
 * as it runs; other writers wait. It is an explicit admin action, never part
 * of the automatic preview.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_DEPTH = 3
const INSERT_ROWS = 500
const EXEC_TIMEOUT_MS = 5 * 60_000

export interface RehearsalTable {
  table: string
  before: number
  after: number
  delta: number
}

export interface RehearsalResult {
  procedure: string
  staging_table: string
  rows_loaded: number
  procedures: string[]
  tables: RehearsalTable[]
  dynamic_sql: boolean
  duration_ms: number
  /** The procedure raised an error; everything was rolled back. */
  error?: string
  /** Why the rehearsal did not run (or its counts cannot be trusted). */
  refused?: string
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

const TARGET_RE =
  /\b(?:MERGE\s+(?:INTO\s+)?|INSERT\s+(?:INTO\s+)?|UPDATE\s+|DELETE\s+(?:FROM\s+)?|TRUNCATE\s+TABLE\s+)(?:\[?dbo\]?\s*\.\s*)?\[?([A-Za-z_][A-Za-z0-9_]*)\]?/gi
const DELETE_ALIAS_RE =
  /\bDELETE\s+\[?\w+\]?\s+FROM\s+(?:\[?dbo\]?\s*\.\s*)?\[?([A-Za-z_][A-Za-z0-9_]*)\]?/gi
const EXEC_RE =
  /\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(?:\[?dbo\]?\s*\.\s*)?\[?([A-Za-z_][A-Za-z0-9_]*)\]?/gi
const EXTERNAL_RE =
  /\b(sp_send_dbmail|xp_cmdshell|OPENQUERY|OPENROWSET|OPENDATASOURCE|sp_OACreate|sp_start_job)\b/i

/** What a procedure body says about itself — pure, unit-tested. */
export function scanProcedureBody(body: string): {
  targets: string[]
  calls: string[]
  begins: number
  commits: number
  external: string | null
  dynamic: boolean
} {
  const sql = stripComments(body)
  const targets = new Set<string>()
  for (const m of sql.matchAll(TARGET_RE)) targets.add(m[1])
  for (const m of sql.matchAll(DELETE_ALIAS_RE)) targets.add(m[1])
  const calls = new Set<string>()
  for (const m of sql.matchAll(EXEC_RE)) {
    const name = m[1]
    if (/^sp_executesql$/i.test(name)) continue
    calls.add(name)
  }
  const begins = (sql.match(/\bBEGIN\s+TRAN(?:SACTION)?\b/gi) ?? []).length
  const commits = (sql.match(/\bCOMMIT(?:\s+(?:TRAN(?:SACTION)?|WORK))?\b/gi) ?? []).length
  const ext = sql.match(EXTERNAL_RE)
  // A four-part name reaches a linked server.
  const linked = sql.match(/\[?\w+\]?\.\[?\w+\]?\.\[?\w+\]?\.\[?\w+\]?/)
  return {
    targets: [...targets],
    calls: [...calls],
    begins,
    commits,
    external: ext ? ext[1] : linked ? `linked server (${linked[0]})` : null,
    dynamic: /\bsp_executesql\b|\bEXEC(?:UTE)?\s*\(/i.test(sql)
  }
}

async function procBody(name: string): Promise<string | null> {
  const r = (await db.raw('SELECT OBJECT_DEFINITION(OBJECT_ID(?)) AS body', [name])) as Array<{
    body: string | null
  }>
  return r[0]?.body ?? null
}

interface Plan {
  procedures: string[]
  targets: Set<string>
  dynamic: boolean
  refused: string | null
}

async function planProcedure(root: string): Promise<Plan> {
  const plan: Plan = { procedures: [], targets: new Set(), dynamic: false, refused: null }
  const walk = async (name: string, depth: number) => {
    if (plan.refused || plan.procedures.some((p) => p.toLowerCase() === name.toLowerCase())) return
    const body = await procBody(name)
    if (body == null) return // not a procedure (a table name after EXEC? a system proc)
    plan.procedures.push(name)
    const scan = scanProcedureBody(body)
    if (scan.commits > scan.begins) {
      plan.refused = `${name} commits ${scan.commits} transaction(s) but opens ${scan.begins} — it would commit the rehearsal's own transaction.`
      return
    }
    if (scan.external) {
      plan.refused = `${name} reaches outside the database (${scan.external}); a rollback cannot undo that.`
      return
    }
    if (scan.dynamic) plan.dynamic = true
    for (const t of scan.targets) plan.targets.add(t)
    if (depth < MAX_DEPTH) for (const c of scan.calls) await walk(c, depth + 1)
  }
  await walk(root, 0)
  return plan
}

const lit = (v: unknown): string =>
  v == null || v === '' ? "N''" : `N'${String(v).replace(/'/g, "''")}'`

export async function rehearseProcedureImport(
  definition: ImportDefinition,
  fileRows: Array<Record<string, string>>
): Promise<RehearsalResult> {
  const began = Date.now()
  const proc = definition.procedure ?? ''
  const table = definition.staging_table || `staging_${definition.key}`
  const base: RehearsalResult = {
    procedure: proc,
    staging_table: table,
    rows_loaded: 0,
    procedures: [],
    tables: [],
    dynamic_sql: false,
    duration_ms: 0
  }
  const done = (r: Partial<RehearsalResult>): RehearsalResult => ({
    ...base,
    ...r,
    duration_ms: Date.now() - began
  })
  if (!proc || !IDENT.test(proc)) return done({ refused: 'This import runs no procedure.' })
  if (!IDENT.test(table)) return done({ refused: `Unsafe staging table name: ${table}` })

  // The staging table is shared by every run of this lock group.
  const group = lockGroupOf(definition)
  const active = (await db('nivaro_import_queue as q')
    .join('nivaro_import_definitions as d', 'd.key', 'q.import_key')
    .whereIn('q.status', ['queued', 'running'])
    .select('d.key', 'd.lock_group', 'd.staging_table')) as Array<
    Pick<ImportDefinition, 'key' | 'lock_group' | 'staging_table'>
  >
  if (active.some((a) => lockGroupOf(a) === group)) {
    return done({ refused: `A run of ${table} is queued or running — rehearse once it finishes.` })
  }

  const plan = await planProcedure(proc)
  base.procedures = plan.procedures
  base.dynamic_sql = plan.dynamic
  if (plan.procedures.length === 0) return done({ refused: `Procedure ${proc} was not found.` })
  if (plan.refused) return done({ refused: plan.refused })

  // Staging columns: the table must exist (the first real run creates it).
  const tableCols = (await db('information_schema.columns')
    .where('table_name', table)
    .select('column_name')) as Array<{ column_name: string }>
  if (tableCols.length === 0) {
    return done({ refused: `${table} does not exist yet — the first real run creates it.` })
  }
  const identity = new Set(
    (
      (await db.raw(
        'SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?) AND (is_identity = 1 OR is_computed = 1)',
        [table]
      )) as Array<{ name: string }>
    ).map((r) => r.name.toLowerCase())
  )
  const byLower = new Map(tableCols.map((c) => [c.column_name.toLowerCase(), c.column_name]))
  const byNorm = new Map(tableCols.map((c) => [normalizeHeader(c.column_name), c.column_name]))
  const rows = mapRowsToDeclared(definition, fileRows)
  const fileCols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'id')
  const mapped: Array<{ from: string; to: string }> = []
  const unknown: string[] = []
  for (const c of fileCols) {
    const to = byLower.get(c.toLowerCase()) ?? byNorm.get(normalizeHeader(c))
    if (!to) unknown.push(c)
    else if (!identity.has(to.toLowerCase())) mapped.push({ from: c, to })
  }
  if (unknown.length > 0) {
    return done({ refused: `${table} has no column for ${unknown.join(', ')}.` })
  }

  const targets = [...plan.targets]
  const realTables = new Set(
    (
      (await db('sys.tables')
        .whereIn('name', targets.length ? targets : ['__none__'])
        .select('name')) as Array<{
        name: string
      }>
    ).map((r) => r.name)
  )
  const counted = targets.filter((t) => realTables.has(t) && IDENT.test(t)).sort()
  const countSql = counted.length
    ? counted.map((t) => `SELECT '${t}' AS t, COUNT_BIG(*) AS n FROM [${t}]`).join(' UNION ALL ')
    : null

  return withLongConnection(
    async (conn) => {
      // IMPLICIT_TRANSACTIONS: the first write opens the rehearsal's
      // transaction, and if the procedure rolls it back and then keeps
      // writing (an error log after a CATCH ROLLBACK), those writes open a
      // NEW implicit transaction instead of committing on their own — the
      // final rollback takes them too. The transaction id tells the two apart.
      await conn.run('SET XACT_ABORT OFF; SET IMPLICIT_TRANSACTIONS ON')
      try {
        await conn.run(`DELETE FROM [${table}]`)
        const colList = mapped.map((m) => `[${m.to}]`).join(', ')
        for (let i = 0; mapped.length > 0 && i < rows.length; i += INSERT_ROWS) {
          const values = rows
            .slice(i, i + INSERT_ROWS)
            .map((r) => `(${mapped.map((m) => lit(r[m.from])).join(', ')})`)
            .join(',\n')
          await conn.run(`INSERT INTO [${table}] (${colList}) VALUES ${values}`)
        }
        base.rows_loaded = rows.length
        const txSql =
          'SELECT @@TRANCOUNT AS tc, (SELECT transaction_id FROM sys.dm_tran_current_transaction) AS tx'
        const [start] = await conn.run<{ tc: number; tx: string | number }>(txSql)
        const before = countSql ? await conn.run<{ t: string; n: number }>(countSql) : []

        let error: string | undefined
        try {
          await conn.run(`EXEC [${proc}]`, EXEC_TIMEOUT_MS)
        } catch (err) {
          error = describeSqlError(err).slice(0, 2000)
        }
        const [end] = await conn.run<{ tc: number; tx: string | number }>(txSql)
        if (Number(end.tc) !== Number(start.tc) || String(end.tx) !== String(start.tx)) {
          return done({
            ...(error ? { error } : {}),
            refused:
              Number(end.tc) < Number(start.tc) || String(end.tx) !== String(start.tx)
                ? 'The procedure ended the rehearsal transaction itself (an inner ROLLBACK) — its counts cannot be read, and nothing was kept.'
                : 'The procedure left a transaction open — its counts cannot be trusted; everything was rolled back.'
          })
        }
        const after = countSql ? await conn.run<{ t: string; n: number }>(countSql) : []
        const b = new Map(before.map((r) => [r.t, Number(r.n)]))
        const tables = after.map((r) => {
          const pre = b.get(r.t) ?? 0
          return { table: r.t, before: pre, after: Number(r.n), delta: Number(r.n) - pre }
        })
        return done({ tables, ...(error ? { error } : {}) })
      } finally {
        // Everything goes, and the pooled connection must not keep the mode.
        await conn.run('WHILE @@TRANCOUNT > 0 ROLLBACK TRANSACTION; SET IMPLICIT_TRANSACTIONS OFF')
      }
    },
    { timeoutMs: EXEC_TIMEOUT_MS }
  )
}
