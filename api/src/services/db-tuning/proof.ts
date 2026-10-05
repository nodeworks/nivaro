import { db } from '../../db/index.js'
import { withLongConnection } from '../run-long.js'
import { statementsTouching as dmvStatements, isMssqlDb, type StatementStat } from './dmv.js'
import { MIN_UPTIME_DAYS } from './observers/index-drop.js'
import { MIN_SAVING_MS } from './observers/query-cache.js'
import { codeOnly, provability, proveProcedureRewrite, twinName } from './twin.js'
import { type Candidate, IDENT, PROOF_ERROR_PREFIX, type ProofResult } from './types.js'

/**
 * Proof dispatch: every candidate is proven by the method its kind allows before it is proposed.
 * An index create is costed against a hypothetical index (estimated plans only, inside a
 * rolled-back transaction) or, when that path is unavailable, judged on the DMV / live-read
 * evidence; a drop on usage stats; a procedure rewrite by the twin harness, after the callee and
 * twin-name checks only a database can answer; a rollup store by its cost model; a query cache
 * by its resolved freshness. Nothing here writes a real object.
 */

/**
 * Per-statement estimated costs without and with the hypothetical index; null when the path is
 * unavailable (nothing planned, or SQL Server refused the hypothetical index) — the caller falls
 * back to the DMV estimate; `error` when it failed part-way, which fails the proof.
 */
export type HypotheticalCosts = Array<{ before: number; after: number }> | null | { error: string }

export interface ProofDeps {
  statementsTouching: (table: string, column: string, top?: number) => Promise<StatementStat[]>
  hypotheticalCosts: (
    table: string,
    columns: string[],
    statements: string[]
  ) => Promise<HypotheticalCosts>
  indexExists: (table: string, name: string) => Promise<boolean>
  twin: typeof proveProcedureRewrite
  /** Each callee's sys.sql_modules definition (null when not found), keyed `schema.name` as asked. */
  calleeBodies: (names: string[]) => Promise<Map<string, string | null>>
  /** A procedure of this name exists in [dbo]. */
  procExists: (name: string) => Promise<boolean>
}

export function subtreeCost(planXml: string): number | null {
  const m = planXml.match(/StatementSubTreeCost="(\d*\.?\d+(?:[Ee][+-]?\d+)?)"/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** The first StatementSubTreeCost in any value of any row: a plan arrives as one XML column. */
function costOf(rows: Array<Record<string, unknown>>): number | null {
  for (const r of rows)
    for (const v of Object.values(r)) {
      const c = subtreeCost(String(v ?? ''))
      if (c != null) return c
    }
  return null
}

const READS = /^\s*(?:SELECT|WITH)\b/i

/** The hypothetical CREATE holds a schema lock on the table while it samples statistics. */
const HYPOTHETICAL_CREATE_MS = 15_000

/**
 * Hypothetical index on ONE pinned connection. Each statement's estimated plan is read first
 * (SHOWPLAN_XML, which executes nothing); then, inside a transaction, the index is created with
 * STATISTICS_ONLY, DBCC AUTOPILOT points the optimizer at it, SET AUTOPILOT ON plans each
 * statement again, and everything is rolled back. SET SHOWPLAN_XML / AUTOPILOT must be alone in
 * their batch, hence the separate `run` calls; AUTOPILOT is switched off before the ROLLBACK,
 * which it would otherwise only plan. Only plain reads are planned.
 *
 * A session left in a plan mode would answer the next pool caller with plans instead of rows,
 * and an open transaction would hold the schema lock: so any failure while a mode is on, of a
 * mode's OFF, of the ROLLBACK, or a closing `SELECT @@TRANCOUNT` that does not read 0 discards
 * the connection and returns `error`. SQL Server refusing the hypothetical index itself (CREATE
 * or DBCC, cleanly rolled back) is "unavailable" → null.
 */
export async function hypotheticalCosts(
  table: string,
  columns: string[],
  statements: string[]
): Promise<HypotheticalCosts> {
  if (!isMssqlDb() || !IDENT.test(table)) return null
  if (!columns.length || !columns.every((c) => IDENT.test(c))) return null
  // SHOWPLAN and AUTOPILOT execute nothing; a statement that cannot write needs no such trust.
  const reads = statements.filter((s) => READS.test(s) && provability(table, s) === null)
  if (!reads.length) return null
  const name = `hyp_${table}_${columns.join('_')}`.slice(0, 120)
  const cols = columns.map((c) => `[${c}]`).join(', ')
  try {
    return await withLongConnection(
      async (conn) => {
        /** `body` under SET <mode> ON; anything that throws here leaves the mode unknown. */
        const inMode = async <T>(mode: string, body: () => Promise<T>): Promise<T> => {
          await conn.run(`SET ${mode} ON`)
          try {
            return await body()
          } finally {
            await conn.run(`SET ${mode} OFF`)
          }
        }
        const plan = async (sql: string) => costOf(await conn.run<Record<string, unknown>>(sql))

        const planned = async (): Promise<Array<{ before: number; after: number }> | null> => {
          const before: Array<number | null> = []
          for (const s of reads)
            before.push(
              // a parameterised statement (@p0 undeclared) does not compile: that one is skipped
              await inMode('SHOWPLAN_XML', () => plan(s).catch(() => null))
            )
          if (!before.some((b) => b != null)) return null
          // CREATE INDEX takes a schema lock: never queue behind a long reader, holding others up.
          await conn.run('SET LOCK_TIMEOUT 5000')
          let failure: unknown = null
          let out: Array<{ before: number; after: number }> | null = null
          try {
            await conn.run('BEGIN TRAN')
            const created = await conn
              .run(
                `CREATE NONCLUSTERED INDEX [${name}] ON [${table}] (${cols}) WITH STATISTICS_ONLY = -1`,
                HYPOTHETICAL_CREATE_MS
              )
              .then(() =>
                conn.run(
                  `DECLARE @d int = DB_ID(), @o int = OBJECT_ID('[${table}]');
                   DECLARE @i int = (SELECT index_id FROM sys.indexes WHERE object_id = @o AND name = '${name}');
                   DBCC AUTOPILOT(0, @d, @o, @i) WITH NO_INFOMSGS`
                )
              )
              .then(
                () => true,
                () => false
              )
            if (created)
              out = await inMode('AUTOPILOT', async () => {
                const pairs: Array<{ before: number; after: number }> = []
                for (let i = 0; i < reads.length; i++) {
                  const b = before[i]
                  if (b == null) continue
                  const a = await plan(reads[i])
                  if (a == null) throw new Error('an estimated plan came back without a cost')
                  pairs.push({ before: b, after: a })
                }
                return pairs
              })
          } catch (err) {
            failure = err
          }
          for (const sql of ['IF @@TRANCOUNT > 0 ROLLBACK', 'SET LOCK_TIMEOUT -1'])
            await conn.run(sql).catch((err) => {
              failure ??= err
            })
          if (failure != null) throw failure
          return out?.length ? out : null
        }

        let result: Array<{ before: number; after: number }> | null = null
        try {
          result = await planned()
          // in a plan mode this comes back as a plan, not n; with a transaction open, n > 0
          const check = await conn.run<{ n: unknown }>('SELECT @@TRANCOUNT AS n')
          if (check.length !== 1 || Number(check[0].n) !== 0)
            throw new Error('the session did not come back clean after the hypothetical plan')
        } catch (err) {
          conn.discard()
          return { error: errText(err) }
        }
        return result
      },
      { timeoutMs: 60_000 }
    )
  } catch {
    // no connection at all: nothing ran
    return null
  }
}

const rowsOf = (r: unknown) => (Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [])

async function indexExists(table: string, name: string): Promise<boolean> {
  const rows = rowsOf(
    await db
      .raw('SELECT 1 AS x FROM sys.indexes WHERE object_id = OBJECT_ID(?) AND name = ?', [
        table,
        name
      ])
      .catch(() => [])
  )
  return rows.length > 0
}

/** Throws on a catalog error: the caller refuses rather than guess. */
async function calleeBodies(names: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  for (const key of names) {
    const [schema, proc] = key.split('.')
    const rows = isMssqlDb()
      ? rowsOf(
          await db.raw(
            `SELECT m.definition FROM sys.procedures p JOIN sys.sql_modules m ON m.object_id = p.object_id
             WHERE p.name = ? AND SCHEMA_NAME(p.schema_id) = ? AND p.is_ms_shipped = 0`,
            [proc, schema]
          )
        )
      : []
    const def = rows[0]?.definition
    out.set(key, typeof def === 'string' && def ? def : null)
  }
  return out
}

/** Throws on a catalog error: the caller refuses rather than guess. */
async function procExists(name: string): Promise<boolean> {
  if (!isMssqlDb()) return false
  const rows = rowsOf(
    await db.raw(
      `SELECT 1 AS x FROM sys.procedures WHERE name = ? AND SCHEMA_NAME(schema_id) = 'dbo'`,
      [name]
    )
  )
  return rows.length > 0
}

const defaultDeps: ProofDeps = {
  statementsTouching: dmvStatements,
  hypotheticalCosts,
  indexExists,
  twin: proveProcedureRewrite,
  calleeBodies,
  procExists
}

const EXEC_KW = /(?<![[\].@#$\w])EXEC(?:UTE)?\b(?!\])/gi
const PART = String.raw`(?:\[[\w#@$]*\]|[A-Za-z_][\w#@$]*)`
const CALLEE = new RegExp(String.raw`^\s*(?:@\w+\s*=\s*)?(${PART}(?:\s*\.\s*${PART}?)*)`)

/**
 * Every procedure a body EXECs, as `schema.name` (a one-part name resolves in dbo, as the twin
 * does). `EXECUTE AS` is a context switch, not a call. Null when an EXEC names something this
 * cannot read (dynamic SQL, three or more parts): the caller refuses.
 */
export function procCallees(body: string): string[] | null {
  const code = codeOnly(body)
  const out = new Set<string>()
  for (const m of code.matchAll(EXEC_KW)) {
    const rest = code.slice((m.index ?? 0) + m[0].length)
    if (/^\s+AS\b/i.test(rest)) continue
    const target = CALLEE.exec(rest)
    if (!target) return null
    const parts = target[1].split('.').map((p) => p.trim().replace(/^\[|\]$/g, ''))
    if (parts.length > 2 || parts.some((p) => !IDENT.test(p))) return null
    const [schema, proc] = parts.length === 2 ? parts : ['dbo', parts[0]]
    out.add(`${schema}.${proc}`)
  }
  return [...out]
}

const refused = (detail: string): ProofResult => ({
  passed: false,
  method: 'refused',
  before: {},
  after: {},
  detail
})

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A read that threw: the proof judged nothing, so the ledger keeps a proposed row as it is. */
const errorRefusal = (what: string, err: unknown): ProofResult =>
  refused(`${PROOF_ERROR_PREFIX}${what}: ${errText(err)}`)

const JUNCTION_NOTE =
  'the original multiplies rows through a junction; a correctness question for a person, not a tuning change'

/**
 * What the pure `provability` cannot judge: a callee's body (one level — a callee that calls
 * further is refused, not followed), and a real procedure already holding the twin's name, which
 * the twin's CREATE OR ALTER would overwrite. Null when the twin may run.
 */
async function procPreflight(
  proc: string,
  twin: string,
  oldBody: string,
  newBody: string,
  deps: ProofDeps
): Promise<ProofResult | null> {
  if (!IDENT.test(proc)) return refused('not a plain procedure name')
  // The twin repeats these; refusing here first spares the catalog reads below.
  const oldRefused = provability(proc, oldBody)
  if (oldRefused) return refused(`current body ${oldRefused}`)
  const newRefused = provability(proc, newBody)
  if (newRefused) return refused(`rewrite ${newRefused}`)
  // The original runs in the proof too: its callees are checked like the rewrite's.
  const sides = [
    { label: '', callees: procCallees(newBody) },
    { label: 'current body ', callees: procCallees(oldBody) }
  ]
  for (const s of sides)
    if (!s.callees) return refused(`${s.label}calls a procedure the proof cannot name`)
  const all = [...new Set(sides.flatMap((s) => s.callees ?? []))]
  let bodies: Map<string, string | null>
  try {
    bodies = all.length ? await deps.calleeBodies(all) : new Map()
  } catch (err) {
    return errorRefusal('could not read the procedures it calls', err)
  }
  for (const s of sides)
    for (const callee of s.callees ?? []) {
      const body = bodies.get(callee) ?? null
      const why = (reason: string) => refused(`${s.label}calls ${callee}, which ${reason}`)
      if (!body) return why('cannot be found')
      const reason = provability(callee.split('.')[1], body)
      if (reason) return why(reason)
      const deeper = procCallees(body)
      if (!deeper) return why('calls a procedure the proof cannot name')
      if (deeper.length) return why(`calls ${deeper[0]} (only one level of callees is checked)`)
    }
  try {
    if (await deps.procExists(twin)) return refused(`a procedure named ${twin} already exists`)
  } catch (err) {
    return errorRefusal(`could not check for an existing ${twin}`, err)
  }
  return null
}

/** SQL Server's improvement_measure below this is noise (the conventional floor). */
export const MIN_DMV_IMPROVEMENT = 10

/**
 * The index proof when no hypothetical plan could be read. A candidate SQL Server asked for
 * stands on its improvement_measure; one it never asked for needs observed read traffic on the
 * column (live read shapes, or a captured slow plan that wanted it). Config alone (an FK nobody
 * was seen reading by) proves nothing.
 */
function dmvEstimate(ev: Record<string, unknown>): ProofResult {
  const result = (passed: boolean, detail: string): ProofResult => ({
    passed,
    method: 'dmv-estimate',
    before: {},
    after: {},
    detail
  })
  const improvement = ev.dmv_improvement
  if (typeof improvement === 'number' && Number.isFinite(improvement)) {
    const passed = improvement >= MIN_DMV_IMPROVEMENT
    return result(
      passed,
      `hypothetical plan unavailable; SQL Server's improvement measure is ${improvement}${passed ? '' : ` (needs ≥ ${MIN_DMV_IMPROVEMENT})`}`
    )
  }
  const live = ev.live as { filter?: number; sort?: number } | null | undefined
  const liveReads = (live?.filter ?? 0) + (live?.sort ?? 0)
  const sources = Array.isArray(ev.sources) ? (ev.sources as string[]) : []
  if (liveReads > 0)
    return result(
      true,
      `hypothetical plan unavailable; ${liveReads} live reads filter or sort by it`
    )
  if (sources.includes('plan'))
    return result(true, 'hypothetical plan unavailable; a captured slow plan asked for this index')
  return result(false, 'no observed traffic')
}

export async function prove(
  c: Candidate,
  opts: { procTimeoutMs: number; deps?: Partial<ProofDeps> }
): Promise<ProofResult> {
  const deps: ProofDeps = { ...defaultDeps, ...opts.deps }
  try {
    return await proveKind(c, opts.procTimeoutMs, deps)
  } catch (err) {
    // an evidence read that throws proves nothing
    return errorRefusal('proof could not run', err)
  }
}

async function proveKind(
  c: Candidate,
  procTimeoutMs: number,
  deps: ProofDeps
): Promise<ProofResult> {
  switch (c.kind) {
    case 'index_create': {
      const [table, colList] = c.target.split('.')
      const columns = (colList ?? '').split(',')
      if (!IDENT.test(table ?? '') || !columns.every((col) => IDENT.test(col)))
        return refused('not a plain table and column list')
      const stmt = c.apply.type === 'sql' ? c.apply.statements[0] : undefined
      const m = stmt?.match(/INDEX\s+\[?(\w+)\]?\s+ON\b/i)
      if (!m) return refused('cannot read the index name from the CREATE statement')
      if (await deps.indexExists(table, m[1]))
        return {
          passed: false,
          method: 'usage-stats',
          before: {},
          after: {},
          detail: 'index already exists'
        }
      const stmts = await deps.statementsTouching(table, columns[0], 5)
      const costs = stmts.length
        ? await deps.hypotheticalCosts(
            table,
            columns,
            stmts.map((s) => s.text)
          )
        : null
      if (costs && 'error' in costs)
        return {
          passed: false,
          method: 'hypothetical',
          before: {},
          after: {},
          detail: `hypothetical plan failed: ${costs.error}`
        }
      if (costs?.length) {
        const best = costs.reduce(
          (a, x) => Math.max(a, x.before > 0 ? 1 - x.after / x.before : 0),
          0
        )
        const worse = costs.some((x) => x.after > x.before * 1.01)
        return {
          passed: best >= 0.2 && !worse,
          method: 'hypothetical',
          before: { cost: costs.reduce((a, x) => a + x.before, 0), statements: costs.length },
          after: { cost: costs.reduce((a, x) => a + x.after, 0) },
          detail: `best statement −${Math.round(best * 100)}% estimated cost over ${costs.length} statement(s)${worse ? '; one got worse' : ''}`
        }
      }
      return dmvEstimate(c.evidence)
    }
    case 'index_drop': {
      const [table, index] = c.target.split('.')
      if (!IDENT.test(table ?? '') || !IDENT.test(index ?? ''))
        return refused('not a plain table and index name')
      if (!(await deps.indexExists(table, index)))
        return {
          passed: false,
          method: 'usage-stats',
          before: {},
          after: {},
          detail: 'index no longer exists'
        }
      const ev = c.evidence as { reads?: number; uptime_days?: number; covered_by?: string | null }
      const passed =
        Boolean(ev.covered_by) ||
        ((ev.reads ?? 1) === 0 && (ev.uptime_days ?? 0) >= MIN_UPTIME_DAYS)
      return {
        passed,
        method: 'usage-stats',
        before: { reads: ev.reads ?? null, uptime_days: ev.uptime_days ?? null },
        after: {},
        detail: ev.covered_by
          ? `strict prefix of ${ev.covered_by}`
          : `${ev.reads ?? 'unknown'} reads over ${ev.uptime_days ?? 'unknown'} days of uptime${passed ? '' : ` (needs 0 reads over ≥ ${MIN_UPTIME_DAYS} days)`}`
      }
    }
    case 'proc_rewrite': {
      if (c.apply.type !== 'proc_body' || c.undo.type !== 'proc_body')
        return refused('not a procedure body change')
      const { proc, body: newBody } = c.apply
      const oldBody = c.undo.body
      // one name per proof, checked free here and handed to the twin
      const twin = twinName(proc)
      const pre = await procPreflight(proc, twin, oldBody, newBody, deps)
      if (pre) return pre
      const sets =
        (c.evidence.parameter_set_values as Array<Record<string, unknown>> | undefined) ?? []
      const r = await deps.twin({
        proc,
        oldBody,
        newBody,
        paramSets: sets,
        timeoutMs: procTimeoutMs,
        twin
      })
      // A junction rewrite that changes rows means the original fans out: not ours to fix.
      const applied = [c.evidence.transformers, c.evidence.applied].flatMap((x) =>
        Array.isArray(x) ? x : []
      )
      if (
        !r.passed &&
        r.method === 'twin' &&
        r.rows_diff?.length &&
        applied.includes('junction-exists')
      )
        return { ...r, detail: `${JUNCTION_NOTE}; ${r.detail}` }
      return r
    }
    case 'rollup_store': {
      const ev = c.evidence as {
        reads_per_day: number
        writes_per_day: number
        per_read_ms: number
        per_recalc_ms: number
      }
      const reads = ev.reads_per_day * ev.per_read_ms
      const upkeep = ev.writes_per_day * ev.per_recalc_ms
      return {
        passed: reads >= 3 * upkeep,
        method: 'cost-model',
        before: { read_ms_per_day: Math.round(reads) },
        after: { upkeep_ms_per_day: Math.round(upkeep) },
        detail: `reads cost ${Math.round(reads)} ms/day, upkeep ${Math.round(upkeep)} ms/day`
      }
    }
    case 'query_cache': {
      const ev = c.evidence as { freshness: { sources: number } | null }
      const passed =
        Boolean(ev.freshness && ev.freshness.sources > 0) && c.estimate_ms_per_day >= MIN_SAVING_MS
      return {
        passed,
        method: 'freshness',
        before: {},
        after: { estimate_ms_per_day: c.estimate_ms_per_day },
        detail: passed
          ? `freshness resolves from ${ev.freshness?.sources} source table(s)`
          : 'freshness sources unresolved or saving below 5 s/day'
      }
    }
  }
}
