import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { withLongConnection } from '../run-long.js'
import { canonRows, multisetDiff } from './canon.js'
import { IDENT, type ProofResult } from './types.js'

/**
 * The twin proof for a procedure rewrite. The candidate body is deployed as
 * `<proc>__tune`, old and new run with every recorded parameter set in
 * A B B A order (old, new, new, old) so a database moving underneath cannot
 * favour one side, rows are canonicalised and multiset-compared, and timing
 * is judged: new median ≤ 75% of old AND no set slower. Every EXEC runs inside
 * a transaction that is rolled back, so a side effect the refusal list missed
 * never persists. The twin is dropped in `finally`; a boot sweep drops what a
 * killed process left behind.
 */

export const TWIN_SUFFIX = '__tune'
export const twinName = (proc: string): string => `${proc}${TWIN_SUFFIX}`

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * One left-to-right pass over T-SQL that leaves only code: `--` and (nested)
 * `/* *\/` comments become a space, `'…'` literals (with `''` escapes) become
 * `''`, and `[…]` (with `]]`) / `"…"` identifiers become `[name]` with every
 * character outside `\w#@$` replaced by `_`. A regex over the result cannot be
 * fooled by a quote inside a comment, a comment marker inside a string, or an
 * apostrophe inside a bracketed name.
 */
function codeOnly(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
    } else if (c === '/' && next === '*') {
      let depth = 0
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
          if (depth === 0) break
        } else i++
      }
      out += ' '
    } else if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i++] === "'") break
      }
      out += "''"
    } else if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"'
      let raw = ''
      i++
      while (i < n) {
        if (sql[i] === close && sql[i + 1] === close) {
          raw += close
          i += 2
        } else if (sql[i] === close) {
          i++
          break
        } else raw += sql[i++]
      }
      out += `[${raw.replace(/[^\w#@$]/g, '_')}]`
    } else {
      out += c
      i++
    }
  }
  return out
}

/** A keyword as a whole word, never part of a `[name]`, `a.name`, `@var` or `#temp`. */
const kw = (word: string): string => String.raw`(?<![\[\].@#$\w])${word}\b(?!\])`
/** Whitespace, or straight into a bracketed name: `UPDATE[invoices]`. */
const SEP = String.raw`(?:\s+|(?=\[))`
const NAME = String.raw`[#@]?[\[\]\w#@$.]+`
const TARGET = `(${NAME})`
const TOP = String.raw`(?:TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?`
const EXEC = kw('EXEC(?:UTE)?')

/** Each pattern's LAST capture group is the object written. */
const WRITE_PATTERNS: RegExp[] = [
  // INSERT INTO / SELECT … INTO / MERGE INTO / OUTPUT … INTO
  new RegExp(`${kw('INTO')}${SEP}${TARGET}`, 'gi'),
  new RegExp(`${kw('INSERT')}${SEP}${TOP}(?!INTO\\b)${TARGET}`, 'gi'),
  new RegExp(String.raw`(?<!\bFOR\s+)${kw('UPDATE')}${SEP}${TOP}${TARGET}`, 'gi'),
  new RegExp(`${kw('DELETE')}${SEP}${TOP}(?:FROM${SEP})?${TARGET}`, 'gi'),
  new RegExp(`${kw('MERGE')}${SEP}${TOP}(?!INTO\\b)${TARGET}`, 'gi'),
  new RegExp(String.raw`${kw('TRUNCATE')}\s+TABLE${SEP}${TARGET}`, 'gi'),
  new RegExp(String.raw`${kw('BULK')}\s+INSERT${SEP}${TARGET}`, 'gi')
]

/** `OPTION (MERGE JOIN)` / `MERGE UNION` are join hints, not a MERGE statement. */
const HINT_WORDS = new Set(['JOIN', 'UNION'])

const isTemp = (target: string): boolean => /^\[?[#@]/.test(target)
const bare = (target: string): string => target.replace(/[[\]]/g, '')

/** Statements that change the server, permissions or the database, whatever they name. */
const ADMIN_WORDS = [
  'GRANT',
  'DENY',
  'REVOKE',
  'DBCC',
  'BACKUP',
  'RESTORE',
  'KILL',
  'SHUTDOWN',
  'RECONFIGURE'
]

const DDL = new RegExp(kw('(CREATE|ALTER|DROP)'), 'gi')
const DDL_TABLE = new RegExp(
  String.raw`^${SEP}TABLE${SEP}(?:IF\s+EXISTS${SEP})?(${NAME}(?:\s*,\s*${NAME})*)`,
  'i'
)
const DDL_INDEX = new RegExp(
  String.raw`^\s+(?:UNIQUE\s+)?(?:(?:NON)?CLUSTERED\s+)?INDEX${SEP}[\[\]\w#@$]+\s+ON${SEP}${TARGET}`,
  'i'
)

/** CREATE / ALTER / DROP of anything but a #temp table (or an index on one). */
function ddlRefusal(code: string): string | null {
  for (const m of code.matchAll(DDL)) {
    const rest = code.slice((m.index ?? 0) + m[0].length)
    const table = DDL_TABLE.exec(rest)
    if (table) {
      const targets = table[1].split(',').map((t) => t.trim())
      const real = targets.find((t) => !isTemp(t))
      if (!real) continue
      return `writes ${bare(real)}`
    }
    const index = DDL_INDEX.exec(rest)
    if (index && isTemp(index[1])) continue
    const what = /^\s+(\w+)/.exec(rest)?.[1]?.toUpperCase()
    return `runs DDL (${m[1].toUpperCase()}${what ? ` ${what}` : ''})`
  }
  return null
}

/** server.database.schema.object, anywhere (FROM, JOIN, a comma join, an EXEC). */
const PART = String.raw`(?:\[[\w#@$]*\]|[A-Za-z_][\w#@$]*)`
const FOUR_PART = new RegExp(String.raw`(?<![\w\].#@$])${PART}\.${PART}?\.${PART}?\.${PART}`, 'i')

/** The header `CREATE [OR ALTER] PROC name` is not a DDL statement inside the body. */
const HEADER = /^\s*(?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\s+PROC(?:EDURE)?\b/i

/** Why a body cannot be proven by the twin harness, or null when it can. */
export function provability(name: string, body: string): string | null {
  const code = codeOnly(body).replace(HEADER, ' ')
  for (const re of WRITE_PATTERNS) {
    for (const m of code.matchAll(re)) {
      const raw = m[m.length - 1] ?? ''
      if (isTemp(raw)) continue
      const target = bare(raw)
      if (!target || HINT_WORDS.has(target.toUpperCase())) continue
      return `writes ${target}`
    }
  }
  const ddl = ddlRefusal(code)
  if (ddl) return ddl
  for (const word of ADMIN_WORDS) if (new RegExp(kw(word), 'i').test(code)) return `runs ${word}`
  if (
    /\bsp_executesql\b/i.test(code) ||
    new RegExp(String.raw`${EXEC}\s*\(`, 'i').test(code) ||
    new RegExp(String.raw`${EXEC}\s+(?:@\w+\s*=\s*)?@\w+\b(?!\s*=)`, 'i').test(code)
  )
    return 'uses dynamic SQL'
  if (FOUR_PART.test(code)) return 'references a linked server'
  if (/\bOPEN(?:QUERY|ROWSET|DATASOURCE)\s*\(/i.test(code)) return 'references a linked server'
  const callee = String.raw`${EXEC}\s+(?:@\w+\s*=\s*)?(?:\[?\w+\]?\.)?\[?`
  if (new RegExp(`${callee}${escapeRe(name)}\\]?(?![\\w])`, 'i').test(code)) return 'calls itself'
  const sys = new RegExp(String.raw`${callee}((?:sp|xp)_\w+)`, 'i').exec(code)
  if (sys) return `calls system procedure ${sys[1]}`
  return null
}

/** Rewrite the CREATE/ALTER header to CREATE OR ALTER PROCEDURE [dbo].[to]; null when no header. */
export function renameProcHeader(body: string, from: string, to: string): string | null {
  const re = new RegExp(
    String.raw`^((?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*)(?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\s+PROC(?:EDURE)?\s+(?:\[?dbo\]?\.)?\[?${escapeRe(from)}\]?(?=[\s(;])`,
    'i'
  )
  if (!re.test(body)) return null
  return body.replace(re, `$1CREATE OR ALTER PROCEDURE [dbo].[${to}]`)
}

function literal(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return String(v)
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return 'NULL'
    return `N'${v.toISOString()}'`
  }
  if (typeof v === 'object') throw new Error('cannot bind an object or array as a parameter')
  return `N'${String(v).replace(/'/g, "''")}'`
}

/** `EXEC [dbo].[proc] @a = …` with every value bound as a literal; non-identifier keys dropped. */
export function execStatement(proc: string, params: Record<string, unknown>): string {
  if (!IDENT.test(proc)) throw new Error(`not a plain procedure name: ${proc}`)
  const parts = Object.entries(params)
    .filter(([k]) => IDENT.test(k))
    .map(([k, v]) => `@${k} = ${literal(v)}`)
  return `EXEC [dbo].[${proc}]${parts.length ? ` ${parts.join(', ')}` : ''}`
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return 0
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const fmt = (ms: number): string => String(Math.round(ms * 10) / 10)

/**
 * oldMs/newMs: per parameter set, the timings of that side's runs. A set is
 * slower when every run of the rewrite took longer than every run of the
 * original — one noisy run never fails a proof, a consistently slower set does,
 * even when the overall median improved.
 */
export function judgeTiming(
  oldMs: number[][],
  newMs: number[][]
): { passed: boolean; old_median: number; new_median: number; reason: string } {
  const om = median(oldMs.flat())
  const nm = median(newMs.flat())
  if (!oldMs.length || oldMs.length !== newMs.length)
    return { passed: false, old_median: om, new_median: nm, reason: 'no comparable timings' }
  for (let i = 0; i < oldMs.length; i++) {
    const slowestOld = Math.max(...oldMs[i])
    const fastestNew = Math.min(...newMs[i])
    if (fastestNew > slowestOld)
      return {
        passed: false,
        old_median: om,
        new_median: nm,
        reason: `set ${i + 1} was slower on the rewrite (${fmt(fastestNew)} ms vs ${fmt(slowestOld)} ms)`
      }
  }
  if (nm > om * 0.75)
    return {
      passed: false,
      old_median: om,
      new_median: nm,
      reason: `median only moved ${fmt(om)} → ${fmt(nm)} ms (needs ≤ 75%)`
    }
  return {
    passed: true,
    old_median: om,
    new_median: nm,
    reason: `median ${fmt(om)} → ${fmt(nm)} ms`
  }
}

/** Whitespace-insensitive identity of a body. */
export const bodyHash = (body: string): string =>
  createHash('sha1').update(body.replace(/\s+/g, ' ').trim()).digest('hex')

type Runner = (sql: string) => Promise<Array<Record<string, unknown>>>

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Even a runner that throws synchronously reports through the promise. */
const attempt = (run: Runner, sql: string) => Promise.resolve().then(() => run(sql))

/** A body that opens a transaction and never closes it cannot leave a write behind. */
const rolledBack = (stmt: string): string => `BEGIN TRAN;\n${stmt};\nIF @@TRANCOUNT > 0 ROLLBACK`

const mergeDiffs = (
  ...ds: Array<{ added: string[]; removed: string[] }>
): { added: string[]; removed: string[] } => ({
  added: [...new Set(ds.flatMap((d) => d.added))].slice(0, 20),
  removed: [...new Set(ds.flatMap((d) => d.removed))].slice(0, 20)
})

async function proveWith(
  run: Runner,
  retryDrop: Runner,
  proc: string,
  twin: string,
  twinBody: string,
  sets: Array<Record<string, unknown>>
): Promise<ProofResult> {
  const oldMs: number[][] = []
  const newMs: number[][] = []
  const diffs: NonNullable<ProofResult['rows_diff']> = []
  let unstable: { set: number; added: string[]; removed: string[] } | null = null
  let failure: string | null = null
  let dropError: string | null = null
  const timed = async (sql: string) => {
    const t0 = performance.now()
    const rows = await attempt(run, rolledBack(sql))
    return { rows, ms: performance.now() - t0 }
  }
  try {
    await attempt(run, twinBody)
    for (let i = 0; i < sets.length; i++) {
      const o = execStatement(proc, sets[i])
      const n = execStatement(twin, sets[i])
      const a1 = await timed(o) // A
      const b1 = await timed(n) // B
      const b2 = await timed(n) // B
      const a2 = await timed(o) // A
      const [ca1, cb1, cb2, ca2] = [a1, b1, b2, a2].map((r) => canonRows(r.rows))
      const own = multisetDiff(ca1, ca2)
      if (own.added.length || own.removed.length) {
        unstable = { set: i + 1, ...mergeDiffs(own) }
        break
      }
      oldMs.push([a1.ms, a2.ms])
      newMs.push([b1.ms, b2.ms])
      const d = mergeDiffs(multisetDiff(ca1, cb1), multisetDiff(ca2, cb2))
      if (d.added.length || d.removed.length) diffs.push({ set: i + 1, ...d })
    }
  } catch (err) {
    failure = errText(err)
  } finally {
    // An open transaction would swallow the DROP when the connection rolls back on release.
    const drop = `IF @@TRANCOUNT > 0 ROLLBACK;\nDROP PROCEDURE IF EXISTS [dbo].[${twin}]`
    try {
      await attempt(run, drop)
    } catch {
      // The pinned connection may be dead: once more on a fresh one.
      await attempt(retryDrop, drop).catch((err) => {
        dropError = errText(err)
      })
    }
  }
  const withDrop = (detail: string) =>
    dropError
      ? `${detail}; twin drop failed (${dropError}) — [dbo].[${twin}] is left for the boot sweep`
      : detail
  if (failure !== null)
    return {
      passed: false,
      method: 'twin',
      before: {},
      after: {},
      detail: withDrop(`proof run failed: ${failure}`)
    }
  if (unstable)
    return {
      passed: false,
      method: 'refused',
      before: { sets: sets.length },
      after: {},
      detail: withDrop(
        `nondeterministic: results differ between identical runs (set ${unstable.set})`
      ),
      rows_diff: [unstable]
    }
  if (diffs.length)
    return {
      passed: false,
      method: 'twin',
      before: { sets: sets.length },
      after: { differing_sets: diffs.length },
      detail: withDrop(`rows differ on ${diffs.length} of ${sets.length} parameter set(s)`),
      rows_diff: diffs
    }
  const t = judgeTiming(oldMs, newMs)
  return {
    passed: t.passed,
    method: 'twin',
    before: { median_ms: Math.round(t.old_median * 10) / 10, sets: sets.length },
    after: { median_ms: Math.round(t.new_median * 10) / 10 },
    detail: withDrop(`identical rows on ${sets.length} set(s); ${t.reason}`)
  }
}

export async function proveProcedureRewrite(args: {
  proc: string
  oldBody: string
  newBody: string
  paramSets: Array<Record<string, unknown>>
  timeoutMs: number
  runner?: Runner
}): Promise<ProofResult> {
  const refuse = (detail: string): ProofResult => ({
    passed: false,
    method: 'refused',
    before: {},
    after: {},
    detail
  })
  if (!IDENT.test(args.proc)) return refuse('not a plain procedure name')
  // 0 = no timeout to the driver: a hung EXEC would never reach the drop.
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)
    return refuse('a proof needs a positive timeout')
  // The original runs too: a body that writes must never be EXECuted by a proof.
  const oldRefused = provability(args.proc, args.oldBody)
  if (oldRefused) return refuse(`current body ${oldRefused}`)
  const refused = provability(args.proc, args.newBody)
  if (refused) return refuse(`rewrite ${refused}`)
  const twin = twinName(args.proc)
  const twinBody = renameProcHeader(args.newBody, args.proc, twin)
  if (!twinBody) return refuse('no CREATE PROCEDURE header')
  const sets = args.paramSets.length ? args.paramSets : [{}]
  // An injected runner (tests, scripts) retries its own drop; the pinned connection retries
  // on a fresh pooled one.
  if (args.runner) return proveWith(args.runner, args.runner, args.proc, twin, twinBody, sets)
  const pooled: Runner = async (sql) => {
    await db.raw(sql)
    return []
  }
  // One pinned connection for the whole proof: deploy, every run and the drop.
  return withLongConnection(
    (c) =>
      proveWith(
        (sql) => c.run<Record<string, unknown>>(sql, args.timeoutMs),
        pooled,
        args.proc,
        twin,
        twinBody,
        sets
      ),
    { timeoutMs: args.timeoutMs }
  ).catch((err) => ({
    passed: false,
    method: 'twin' as const,
    before: {},
    after: {},
    detail: `proof run failed: ${errText(err)}`
  }))
}

/** Boot sweep: a killed proof leaves its twin behind. */
export async function sweepTwinLeftovers(): Promise<string[]> {
  if (!isMssql(db)) return []
  // `_` is a LIKE wildcard: '%__tune' would also match a real `retune` procedure.
  const rows = (await db
    .raw(
      `SELECT p.name FROM sys.procedures p
       WHERE p.name LIKE '%[_][_]tune' AND p.is_ms_shipped = 0 AND SCHEMA_NAME(p.schema_id) = 'dbo'`
    )
    .catch(() => [])) as Array<{ name: string }>
  const dropped: string[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!IDENT.test(r.name) || !r.name.endsWith(TWIN_SUFFIX)) continue
    const ok = await db
      .raw(`DROP PROCEDURE IF EXISTS [dbo].[${r.name}]`)
      .then(() => true)
      .catch(() => false)
    if (ok) dropped.push(r.name)
  }
  return dropped
}
