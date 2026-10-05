import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { withLongConnection } from '../run-long.js'
import { canonRows, multisetDiff } from './canon.js'
import type { ProofResult } from './types.js'

/**
 * The twin proof for a procedure rewrite. The candidate body is deployed as
 * `<proc>__tune`, old and new run with every recorded parameter set in
 * A B B A order (old, new, new, old) so a database moving underneath cannot
 * favour one side, rows are canonicalised and multiset-compared, and timing
 * is judged: new median ≤ 75% of old AND no set slower. The twin is dropped in
 * `finally`; a boot sweep drops what a killed process left behind.
 */

export const TWIN_SUFFIX = '__tune'
export const twinName = (proc: string): string => `${proc}${TWIN_SUFFIX}`

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** String literals hold text, not statements: `N'update me'` is never a write. */
function stripLiterals(sql: string): string {
  return sql.replace(/N?'(?:[^']|'')*'/g, "''")
}

const TARGET = String.raw`([#@]?[\[\]\w.]+)`
const TOP = String.raw`(?:TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?`

/** Each pattern's LAST capture group is the object written. */
const WRITE_PATTERNS: RegExp[] = [
  // INSERT INTO / SELECT … INTO / MERGE INTO / OUTPUT … INTO
  new RegExp(String.raw`\bINTO\s+${TARGET}`, 'gi'),
  new RegExp(String.raw`\bINSERT\s+${TOP}(?!INTO\b)${TARGET}`, 'gi'),
  new RegExp(String.raw`(?<!\bFOR\s+)\bUPDATE\s+${TOP}${TARGET}`, 'gi'),
  new RegExp(String.raw`\bDELETE\s+${TOP}(?:FROM\s+)?${TARGET}`, 'gi'),
  new RegExp(String.raw`\bMERGE\s+${TOP}(?!INTO\b)${TARGET}`, 'gi'),
  new RegExp(String.raw`\bTRUNCATE\s+TABLE\s+${TARGET}`, 'gi'),
  new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TARGET}`, 'gi')
]

/** `OPTION (MERGE JOIN)` / `MERGE UNION` are join hints, not a MERGE statement. */
const HINT_WORDS = new Set(['JOIN', 'UNION'])

/** Why a body cannot be proven by the twin harness, or null when it can. */
export function provability(name: string, body: string): string | null {
  const s = stripLiterals(stripComments(body))
  for (const re of WRITE_PATTERNS) {
    for (const m of s.matchAll(re)) {
      const raw = m[m.length - 1] ?? ''
      if (/^[#@]/.test(raw)) continue
      const target = raw.replace(/[[\]]/g, '')
      if (!target || HINT_WORDS.has(target.toUpperCase())) continue
      return `writes ${target}`
    }
  }
  if (/\bsp_executesql\b|\bEXEC(?:UTE)?\s*\(|\bEXEC(?:UTE)?\s+@\w+\b(?!\s*=)/i.test(s))
    return 'uses dynamic SQL'
  const self = escapeRe(name)
  if (
    new RegExp(
      String.raw`\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?(?:\[?dbo\]?\.)?\[?${self}\]?(?![\w])`,
      'i'
    ).test(s)
  )
    return 'calls itself'
  const part = String.raw`\[?\w*\]?`
  if (new RegExp(String.raw`\b(?:FROM|JOIN)\s+${part}\.${part}\.${part}\.${part}`, 'i').test(s))
    return 'references a linked server'
  if (/\bOPEN(?:QUERY|ROWSET|DATASOURCE)\s*\(/i.test(s)) return 'references a linked server'
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
  return `N'${String(v).replace(/'/g, "''")}'`
}

/** `EXEC [dbo].[proc] @a = …` with every value bound as a literal; non-identifier keys dropped. */
export function execStatement(proc: string, params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([k]) => /^[A-Za-z_]\w*$/.test(k))
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

async function proveWith(
  run: Runner,
  proc: string,
  twin: string,
  twinBody: string,
  sets: Array<Record<string, unknown>>
): Promise<ProofResult> {
  const oldMs: number[][] = []
  const newMs: number[][] = []
  const diffs: NonNullable<ProofResult['rows_diff']> = []
  const timed = async (sql: string) => {
    const t0 = performance.now()
    const rows = await run(sql)
    return { rows, ms: performance.now() - t0 }
  }
  try {
    await run(twinBody)
    for (let i = 0; i < sets.length; i++) {
      const o = execStatement(proc, sets[i])
      const n = execStatement(twin, sets[i])
      const a1 = await timed(o) // A
      const b1 = await timed(n) // B
      const b2 = await timed(n) // B
      const a2 = await timed(o) // A
      oldMs.push([a1.ms, a2.ms])
      newMs.push([b1.ms, b2.ms])
      const d = multisetDiff(canonRows(a1.rows), canonRows(b1.rows))
      if (d.added.length || d.removed.length)
        diffs.push({ set: i + 1, added: d.added.slice(0, 20), removed: d.removed.slice(0, 20) })
    }
  } catch (err) {
    return {
      passed: false,
      method: 'twin',
      before: {},
      after: {},
      detail: `proof run failed: ${errText(err)}`
    }
  } finally {
    // A runner that throws synchronously must not skip the drop either.
    await Promise.resolve()
      .then(() => run(`DROP PROCEDURE IF EXISTS [dbo].[${twin}]`))
      .catch(() => undefined)
  }
  if (diffs.length)
    return {
      passed: false,
      method: 'twin',
      before: { sets: sets.length },
      after: { differing_sets: diffs.length },
      detail: `rows differ on ${diffs.length} of ${sets.length} parameter set(s)`,
      rows_diff: diffs
    }
  const t = judgeTiming(oldMs, newMs)
  return {
    passed: t.passed,
    method: 'twin',
    before: { median_ms: Math.round(t.old_median * 10) / 10, sets: sets.length },
    after: { median_ms: Math.round(t.new_median * 10) / 10 },
    detail: `identical rows on ${sets.length} set(s); ${t.reason}`
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.proc)) return refuse('not a plain procedure name')
  // The original runs too: a body that writes must never be EXECuted by a proof.
  const oldRefused = provability(args.proc, args.oldBody)
  if (oldRefused) return refuse(`current body ${oldRefused}`)
  const refused = provability(args.proc, args.newBody)
  if (refused) return refuse(`rewrite ${refused}`)
  const twin = twinName(args.proc)
  const twinBody = renameProcHeader(args.newBody, args.proc, twin)
  if (!twinBody) return refuse('no CREATE PROCEDURE header')
  const sets = args.paramSets.length ? args.paramSets : [{}]
  if (args.runner) return proveWith(args.runner, args.proc, twin, twinBody, sets)
  // One pinned connection for the whole proof: deploy, every run and the drop.
  return withLongConnection(
    (c) =>
      proveWith(
        (sql) => c.run<Record<string, unknown>>(sql, args.timeoutMs),
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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name) || !r.name.endsWith(TWIN_SUFFIX)) continue
    const ok = await db
      .raw(`DROP PROCEDURE IF EXISTS [dbo].[${r.name}]`)
      .then(() => true)
      .catch(() => false)
    if (ok) dropped.push(r.name)
  }
  return dropped
}
