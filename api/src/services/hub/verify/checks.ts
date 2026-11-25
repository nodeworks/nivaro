import { randomBytes } from 'node:crypto'

/**
 * Post-deploy smoke checks, the pure part: what a suite may hold and how one check's facts are
 * judged. Three kinds:
 *
 *  - http   a GET of a path on the environment's own address (base_url + path; never another
 *           host), through safeFetch. Expect a status (default 200), optionally a text the body
 *           contains and a time limit.
 *  - read   a signed-in GET of an /api/ path, run by the APP as its smoke service identity over
 *           the hub link (never a person's token). Expect a status (default 200), optionally a
 *           row count range and a time limit.
 *  - query  a saved custom query (by slug) run the same way, with its parameters. Expect a row
 *           count range (and the status, default 200) and optionally a time limit.
 */

export type CheckKind = 'http' | 'read' | 'query'
export type OnFail = 'notify' | 'rollback'

export interface SmokeCheck {
  id: string
  name: string
  kind: CheckKind
  path?: string
  slug?: string
  params?: Record<string, string | number | boolean | null>
  expect_status: number
  contains?: string
  min_rows?: number
  max_rows?: number
  max_ms?: number
}

export interface SmokeSuiteInput {
  enabled: boolean
  on_fail: OnFail
  settle_seconds: number
  checks: SmokeCheck[]
}

/** What one check produced (the facts) and the verdict. */
export interface CheckResult {
  id: string
  name: string
  kind: CheckKind
  ok: boolean
  status: number | null
  ms: number | null
  rows: number | null
  code: string | null
  reason: string | null
}

export const MAX_CHECKS = 20
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const intIn = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : null
}

/** An http path: starts with one `/`, no scheme or host, no traversal, ≤ 300 characters. */
export function httpPathOk(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const p = v.trim()
  if (!p.startsWith('/') || p.startsWith('//') || p.length > 300) return null
  if (/[\s\\]|\/\.\.?(\/|$|\?)|%2e|%2f|%5c|@/i.test(p)) return null
  return p
}

/** A read path: under /api/ (the app refuses the links, sign-in, files, streams and MCP). */
export function readPathOk(v: unknown): string | null {
  const p = httpPathOk(v)
  return p?.startsWith('/api/') && p.length <= 500 ? p : null
}

export const newCheckId = () => randomBytes(4).toString('hex')

type Fail = { error: string }

function oneCheck(raw: unknown, i: number): SmokeCheck | Fail {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const at = `Check ${i + 1}`
  const kind = c.kind
  if (kind !== 'http' && kind !== 'read' && kind !== 'query')
    return { error: `${at}: the kind is http, read or query` }
  const name =
    typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 80) : `${kind} check`
  const id = typeof c.id === 'string' && /^[a-f0-9]{8}$/.test(c.id) ? c.id : newCheckId()
  const status =
    c.expect_status == null || c.expect_status === '' ? 200 : intIn(c.expect_status, 100, 599)
  if (status == null) return { error: `${at}: the expected status is 100 to 599` }
  const out: SmokeCheck = { id, name, kind, expect_status: status }
  if (c.max_ms != null && c.max_ms !== '') {
    const ms = intIn(c.max_ms, 50, 60_000)
    if (ms == null) return { error: `${at}: the time limit is 50 to 60000 ms` }
    out.max_ms = ms
  }
  if (kind === 'http') {
    const path = httpPathOk(c.path)
    if (!path) return { error: `${at}: the path starts with / and stays on the environment` }
    out.path = path
    if (c.contains != null && c.contains !== '') {
      if (typeof c.contains !== 'string' || c.contains.length > 200)
        return { error: `${at}: the expected text is at most 200 characters` }
      out.contains = c.contains
    }
    return out
  }
  if (kind === 'read') {
    const path = readPathOk(c.path)
    if (!path) return { error: `${at}: a signed-in read names a path under /api/` }
    out.path = path
  } else {
    if (typeof c.slug !== 'string' || !SLUG_RE.test(c.slug.trim()))
      return { error: `${at}: name the custom query by its slug` }
    out.slug = c.slug.trim()
    const params: Record<string, string | number | boolean | null> = {}
    const raw2 = c.params && typeof c.params === 'object' ? (c.params as object) : {}
    const entries = Object.entries(raw2)
    if (entries.length > 20) return { error: `${at}: at most 20 query parameters` }
    for (const [k, v] of entries) {
      if (!PARAM_RE.test(k)) return { error: `${at}: parameter "${k.slice(0, 40)}" is not a name` }
      if (v === null || typeof v === 'number' || typeof v === 'boolean') params[k] = v
      else if (typeof v === 'string' && v.length <= 200) params[k] = v
      else return { error: `${at}: parameter ${k} is short text, a number, true/false or empty` }
    }
    out.params = params
  }
  for (const f of ['min_rows', 'max_rows'] as const) {
    if (c[f] == null || c[f] === '') continue
    const v = intIn(c[f], 0, 10_000_000)
    if (v == null)
      return { error: `${at}: ${f === 'min_rows' ? 'at least' : 'at most'} rows is a whole number` }
    out[f] = v
  }
  if (out.min_rows != null && out.max_rows != null && out.min_rows > out.max_rows)
    return { error: `${at}: at least rows is more than at most rows` }
  if (kind === 'query' && out.min_rows == null && out.max_rows == null)
    return { error: `${at}: a query check expects a row count (at least, at most or both)` }
  return out
}

/** Validates a PUT body. */
export function validateSuite(b: Record<string, unknown>): SmokeSuiteInput | Fail {
  const onFail = b.on_fail == null || b.on_fail === '' ? 'notify' : b.on_fail
  if (onFail !== 'notify' && onFail !== 'rollback')
    return { error: 'on_fail is notify or rollback' }
  const settle =
    b.settle_seconds == null || b.settle_seconds === '' ? 30 : intIn(b.settle_seconds, 0, 600)
  if (settle == null) return { error: 'settle_seconds is 0 to 600' }
  const list = b.checks
  if (!Array.isArray(list) || list.length === 0) return { error: 'Add at least one check' }
  if (list.length > MAX_CHECKS) return { error: `A suite holds at most ${MAX_CHECKS} checks` }
  const checks: SmokeCheck[] = []
  const ids = new Set<string>()
  for (const [i, raw] of list.entries()) {
    const c = oneCheck(raw, i)
    if ('error' in c) return c
    if (ids.has(c.id)) c.id = newCheckId()
    ids.add(c.id)
    checks.push(c)
  }
  return { enabled: b.enabled !== false, on_fail: onFail, settle_seconds: settle, checks }
}

/** Parses stored checks; anything malformed is dropped (the suite's save validated them). */
export function checksFromJson(raw: unknown): SmokeCheck[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(v)) return []
    const out: SmokeCheck[] = []
    for (const [i, c] of v.entries()) {
      const ok = oneCheck(c, i)
      if (!('error' in ok)) out.push(ok)
    }
    return out
  } catch {
    return []
  }
}

export interface CheckFacts {
  status: number | null
  ms: number | null
  rows?: number | null
  /** http: whether the body held `contains` (null = not asked or not read). */
  contains?: boolean | null
  code?: string | null
  /** Set when the check could not run at all (unreachable, no link, refused…). */
  error?: string | null
}

/** The verdict for one check (pure). */
export function judgeCheck(c: SmokeCheck, f: CheckFacts): CheckResult {
  const base = {
    id: c.id,
    name: c.name,
    kind: c.kind,
    status: f.status ?? null,
    ms: f.ms ?? null,
    rows: f.rows ?? null,
    code: f.code ?? null
  }
  const failed = (reason: string): CheckResult => ({ ...base, ok: false, reason })
  if (f.error) return failed(f.error)
  if (f.status !== c.expect_status)
    return failed(
      `answered ${f.status ?? 'nothing'}${f.code ? ` (${f.code})` : ''}, expected ${c.expect_status}`
    )
  if (c.max_ms != null && f.ms != null && f.ms > c.max_ms)
    return failed(`took ${f.ms} ms, the limit is ${c.max_ms} ms`)
  if (c.kind === 'http' && c.contains != null && f.contains === false)
    return failed(`the page does not contain "${c.contains.slice(0, 60)}"`)
  if (c.kind !== 'http' && (c.min_rows != null || c.max_rows != null)) {
    if (f.rows == null) return failed('the answer had no rows to count')
    if (c.min_rows != null && f.rows < c.min_rows)
      return failed(`${f.rows} rows, expected at least ${c.min_rows}`)
    if (c.max_rows != null && f.rows > c.max_rows)
      return failed(`${f.rows} rows, expected at most ${c.max_rows}`)
  }
  return { ...base, ok: true, reason: null }
}

/** One line for a run: "3 of 4 checks passed — Home page: answered 502, expected 200". */
export function runSummary(results: CheckResult[]): string {
  const bad = results.filter((r) => !r.ok)
  const head = `${results.length - bad.length} of ${results.length} checks passed`
  if (!bad.length) return head
  return `${head} — ${bad
    .slice(0, 3)
    .map((r) => `${r.name}: ${r.reason}`)
    .join('; ')}${bad.length > 3 ? `; and ${bad.length - 3} more` : ''}`.slice(0, 1000)
}
