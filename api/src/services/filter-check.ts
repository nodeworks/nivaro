/**
 * Filter check (build_filter, #3211) — "is this filter right?" before an agent runs a query.
 *
 * The verdict comes from the server's OWN gates: every clause of the filter is run on its own
 * through `filterCheckerFor` (the exact sensitive-path, system-path, named-field and compiler
 * walk a list read runs), so every problem is named instead of the first, and the checker can
 * never accept a filter the read refuses or the other way round. On top of what the compiler
 * refuses, clauses that compile but cannot mean what was asked are named too: a text operator
 * on a number or date, a range on a yes/no field, a value outside a field's choices (a choice
 * LABEL where the stored value was meant is the usual mistake). Where a fix is clear — the
 * nearest field name, the operator spelled the way the API spells it, the stored choice value —
 * a corrected filter comes back, and it is only offered when it passes the same gates.
 *
 * Reads metadata only, never a row: a filter is judged, not run.
 */
import type { CMSField, User } from '../types.js'
import { getFields } from './collections.js'
import { FILTER_OPS, filterCheckerFor, resolveFilterPath } from './items.js'

export type Pointer = Array<string | number>

/** One clause of a filter: the smallest filter holding just it, and where it sits. */
export interface FilterClause {
  /** Keys from the filter root to the clause's operator (array indices for _and / _or). */
  ptr: Pointer
  filter: Record<string, unknown>
}

export interface FilterProblem {
  /** Dotted field path the problem is on ("owner.last_name"), "" for the whole filter. */
  path: string
  code: string
  message: string
  /** In words, when the problem has a clear fix. */
  fix?: string
}

export interface FilterCheckResult {
  ok: boolean
  collection: string
  errors: FilterProblem[]
  warnings: FilterProblem[]
  /** The filter with every fix applied — only when every error has one and it passes. */
  suggestion: Record<string, unknown> | null
  /** How many clauses were checked. */
  clauses: number
  /** More clauses than are checked one by one (the whole filter is still checked). */
  truncated?: boolean
}

/** Most clauses checked one by one. */
export const MAX_CLAUSES = 100

const STRUCTURAL = new Set(['_some', '_none', '_link'])
const GROUPS = new Set(['_and', '_or'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
}

/**
 * The filter cut into clauses: one per operator (or equality shorthand), each wrapped in the
 * relation path and the _and / _or group it sits in. A virtual key (`$state`) is one clause.
 */
export function splitFilter(filter: Record<string, unknown>): FilterClause[] {
  const out: FilterClause[] = []
  const walk = (
    node: Record<string, unknown>,
    ptr: Pointer,
    wrap: (inner: Record<string, unknown>) => Record<string, unknown>
  ) => {
    for (const [key, value] of Object.entries(node)) {
      if (GROUPS.has(key) && Array.isArray(value)) {
        value.forEach((el, i) => {
          if (isPlainObject(el)) walk(el, [...ptr, key, i], (inner) => wrap({ [key]: [inner] }))
          else out.push({ ptr: [...ptr, key, i], filter: wrap({ [key]: [el] }) })
        })
        continue
      }
      const descend =
        isPlainObject(value) &&
        Object.keys(value).length > 0 &&
        !key.startsWith('$') &&
        (!key.startsWith('_') || STRUCTURAL.has(key))
      if (descend) walk(value, [...ptr, key], (inner) => wrap({ [key]: inner }))
      else out.push({ ptr: [...ptr, key], filter: wrap({ [key]: value }) })
    }
  }
  walk(filter, [], (inner) => inner)
  return out
}

/** The clause's field segments (with where each sits in `ptr`), operator and value. */
export function clauseParts(c: FilterClause): {
  fields: Array<{ seg: string; at: number }>
  op: string
  value: unknown
  link: boolean
} {
  const fields: Array<{ seg: string; at: number }> = []
  let link = false
  c.ptr.forEach((k, at) => {
    if (typeof k === 'number' || GROUPS.has(k)) return
    if (k === '_link') link = true
    if (STRUCTURAL.has(k)) return
    if (k.startsWith('_') && at === c.ptr.length - 1) return
    fields.push({ seg: k, at })
  })
  const last = c.ptr[c.ptr.length - 1]
  const op = typeof last === 'string' && last.startsWith('_') ? last : '_eq'
  return { fields, op, value: valueAt(c.filter, c.ptr), link }
}

function valueAt(root: unknown, ptr: Pointer): unknown {
  let node: unknown = root
  for (const k of ptr) {
    if (Array.isArray(node)) node = node[typeof k === 'number' ? 0 : -1]
    else if (isPlainObject(node)) node = node[String(k)]
    else return undefined
  }
  return node
}

const displayPath = (fields: Array<{ seg: string }>) => fields.map((f) => f.seg).join('.')

// ── Spelling ─────────────────────────────────────────────────────────────────

/** Operators people (and models) reach for, as the API spells them. */
const OPERATOR_ALIASES: Record<string, string> = {
  _like: '_contains',
  _ilike: '_icontains',
  _contain: '_contains',
  _includes: '_contains',
  _not_contains: '_ncontains',
  _ne: '_neq',
  _not: '_neq',
  _not_eq: '_neq',
  _notequal: '_neq',
  _equals: '_eq',
  _equal: '_eq',
  _is: '_eq',
  _notin: '_nin',
  _not_in: '_nin',
  _isnull: '_null',
  _is_null: '_null',
  _notnull: '_nnull',
  _not_null: '_nnull',
  _isnotnull: '_nnull',
  _startswith: '_starts_with',
  _startsWith: '_starts_with',
  _endswith: '_ends_with',
  _endsWith: '_ends_with',
  _ge: '_gte',
  _le: '_lte',
  _range: '_between'
}

/** Edits between two words, a swapped pair of letters counting as one ("stauts" → "status"). */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[m][n]
}

/** The operator the caller most likely meant, or null. */
export function nearestOperator(op: string): string | null {
  const bare = op.startsWith('_') ? op : `_${op}`
  if (FILTER_OPS.has(bare)) return bare
  const alias = OPERATOR_ALIASES[bare] ?? OPERATOR_ALIASES[bare.toLowerCase()]
  if (alias) return alias
  const lower = bare.toLowerCase()
  if (FILTER_OPS.has(lower)) return lower
  let best: string | null = null
  let bestD = 3
  for (const known of FILTER_OPS) {
    const d = editDistance(lower, known)
    if (d < bestD) {
      bestD = d
      best = known
    }
  }
  return bestD <= 2 ? best : null
}

const snake = (s: string) =>
  s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

/** The field the caller most likely meant (name, label, spelling), or null when unsure. */
export function nearestField(
  name: string,
  candidates: Array<{ field: string; label?: string | null }>
): string | null {
  const want = snake(name)
  const exact = candidates.filter(
    (c) => snake(c.field) === want || (c.label && snake(c.label) === want)
  )
  if (exact.length === 1) return exact[0].field
  if (exact.length > 1) return null
  const max = Math.max(1, Math.floor(want.length / 3))
  let best: string | null = null
  let bestD = max + 1
  let tie = false
  for (const c of candidates) {
    const d = editDistance(want, snake(c.field))
    if (d < bestD) {
      bestD = d
      best = c.field
      tie = false
    } else if (d === bestD) tie = true
  }
  return best && !tie && bestD <= max ? best : null
}

// ── Types and choices ────────────────────────────────────────────────────────

const TEXT_OPS = new Set([
  '_contains',
  '_ncontains',
  '_icontains',
  '_starts_with',
  '_nstarts_with',
  '_ends_with',
  '_nends_with'
])
const RANGE_OPS = new Set(['_gt', '_gte', '_lt', '_lte', '_between', '_nbetween'])
const VALUE_OPS = new Set(['_eq', '_neq', '_in', '_nin'])
const PRESENCE_OPS = new Set(['_null', '_nnull', '_empty', '_nempty'])

type Kind = 'number' | 'boolean' | 'date' | 'uuid' | 'text' | 'other'

export function kindOf(type: string | null | undefined): Kind {
  const t = String(type ?? '').toLowerCase()
  if (['integer', 'biginteger', 'float', 'decimal', 'number', 'int', 'bigint'].includes(t))
    return 'number'
  if (t === 'boolean') return 'boolean'
  if (['date', 'datetime', 'timestamp', 'time'].includes(t)) return 'date'
  if (t === 'uuid') return 'uuid'
  if (['string', 'text', 'hash', 'csv'].includes(t)) return 'text'
  return 'other'
}

export interface Choice {
  value: string
  label: string
}

/** A field's choices (value + label; a `$t:` key reads as words), or null when it has none. */
export function choicesOf(f: Pick<CMSField, 'options'>): Choice[] | null {
  let opts: unknown = f.options
  if (typeof opts === 'string') {
    try {
      opts = JSON.parse(opts)
    } catch {
      return null
    }
  }
  const raw = isPlainObject(opts) ? opts.choices : null
  if (!Array.isArray(raw)) return null
  const out: Choice[] = []
  for (const c of raw) {
    if (isPlainObject(c)) {
      if (c.value == null) continue
      const text = String(c.text ?? c.label ?? c.value)
      out.push({ value: String(c.value), label: text.startsWith('$t:') ? text.slice(3) : text })
    } else if (typeof c === 'string' || typeof c === 'number') {
      out.push({ value: String(c), label: String(c) })
    }
  }
  return out.length > 0 ? out : null
}

function allowsOther(f: Pick<CMSField, 'options'>): boolean {
  const o = (typeof f.options === 'string' ? safeJson(f.options) : f.options) as Record<
    string,
    unknown
  > | null
  return o?.allowOther === true || o?.allow_other === true
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

const isNumeric = (v: unknown) =>
  typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
const isDateLike = (v: unknown) =>
  v instanceof Date ||
  (typeof v === 'string' &&
    (/^\$(NOW|TODAY|CURRENT)/i.test(v) || Number.isFinite(new Date(v).getTime()))) ||
  typeof v === 'number'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isDynamic = (v: unknown) => typeof v === 'string' && v.startsWith('$')

export interface Lint {
  problem: FilterProblem
  severity: 'error' | 'warning'
  /** A fix the suggestion applies: the operator renamed, or the value replaced. */
  rename?: string
  value?: unknown
}

const valuesOf = (op: string, value: unknown): unknown[] =>
  op === '_in' || op === '_nin' || op === '_between' || op === '_nbetween'
    ? Array.isArray(value)
      ? value
      : []
    : [value]

/**
 * What a clause that compiles still gets wrong for its field: the operator for the type, the
 * value for the type, a value outside the field's choices. Pure (the field is handed in).
 */
export function lintClause(
  path: string,
  op: string,
  value: unknown,
  field: Pick<CMSField, 'type' | 'options'> & { field: string }
): Lint[] {
  const out: Lint[] = []
  const kind = kindOf(field.type)
  const at = path || field.field
  if (PRESENCE_OPS.has(op)) {
    if (value !== true && value !== false && value !== 'true' && value !== 'false')
      out.push({
        severity: 'warning',
        problem: { path: at, code: 'FILTER_VALUE_SHAPE', message: `"${op}" takes true` },
        value: true
      })
    return out
  }
  if ((op === '_in' || op === '_nin') && Array.isArray(value) && value.length === 0) {
    out.push({
      severity: 'warning',
      problem: {
        path: at,
        code: 'FILTER_VALUE_EMPTY',
        message: `"${op}" with an empty list ${op === '_in' ? 'matches nothing' : 'matches everything'}`
      }
    })
  }
  if (TEXT_OPS.has(op) && (kind === 'number' || kind === 'date' || kind === 'boolean')) {
    const to = kind === 'date' ? '_between' : '_eq'
    out.push({
      severity: 'error',
      problem: {
        path: at,
        code: 'FILTER_OPERATOR_TYPE',
        message: `"${op}" compares text, and "${at}" is a ${kind === 'date' ? 'date' : kind === 'boolean' ? 'yes/no field' : 'number'}`,
        fix:
          kind === 'date'
            ? 'use _between with a start and end date, or _gte / _lte'
            : `use ${to} with the exact value`
      },
      ...(kind === 'date' ? {} : { rename: to })
    })
    return out
  }
  if (RANGE_OPS.has(op) && (kind === 'boolean' || kind === 'uuid')) {
    out.push({
      severity: 'error',
      problem: {
        path: at,
        code: 'FILTER_OPERATOR_TYPE',
        message: `"${op}" compares order, and "${at}" is ${kind === 'boolean' ? 'a yes/no field' : 'an id'}`,
        fix: 'use _eq or _in'
      }
    })
    return out
  }
  if (TEXT_OPS.has(op) && kind === 'uuid') {
    out.push({
      severity: 'error',
      problem: {
        path: at,
        code: 'FILTER_OPERATOR_TYPE',
        message: `"${op}" compares text, and "${at}" is an id`,
        fix: 'use _eq or _in with the whole id'
      },
      rename: '_eq'
    })
    return out
  }
  const values = valuesOf(op, value).filter((v) => v !== null && v !== undefined && !isDynamic(v))
  if (VALUE_OPS.has(op) || RANGE_OPS.has(op)) {
    if (kind === 'number') {
      const bad = values.filter((v) => !isNumeric(v))
      if (bad.length > 0)
        out.push({
          severity: 'error',
          problem: {
            path: at,
            code: 'FILTER_VALUE_TYPE',
            message: `"${at}" is a number, so ${bad.map((v) => JSON.stringify(v)).join(', ')} matches nothing`
          }
        })
    } else if (kind === 'boolean') {
      const words = values.filter((v) => typeof v === 'string')
      if (words.length > 0 && words.every((v) => /^(true|false|yes|no|1|0)$/i.test(String(v)))) {
        const asBool = (v: unknown) =>
          typeof v === 'string' ? /^(true|yes|1)$/i.test(v) : (v as unknown)
        out.push({
          severity: 'warning',
          problem: {
            path: at,
            code: 'FILTER_VALUE_TYPE',
            message: `"${at}" is a yes/no field: send true or false, not text`
          },
          value: Array.isArray(value) ? value.map(asBool) : asBool(value)
        })
      }
    } else if (kind === 'date') {
      const bad = values.filter((v) => !isDateLike(v))
      if (bad.length > 0)
        out.push({
          severity: 'error',
          problem: {
            path: at,
            code: 'FILTER_VALUE_TYPE',
            message: `"${at}" is a date, and ${bad.map((v) => JSON.stringify(v)).join(', ')} is not one`,
            fix: 'use an ISO date like 2026-10-29'
          }
        })
    } else if (kind === 'uuid') {
      const bad = values.filter((v) => typeof v !== 'string' || !UUID_RE.test(v))
      if (bad.length > 0)
        out.push({
          severity: 'error',
          problem: {
            path: at,
            code: 'FILTER_VALUE_TYPE',
            message: `"${at}" holds ids, and ${bad.map((v) => JSON.stringify(v)).join(', ')} is not one — this matches nothing`,
            fix: 'find the id first (search or read_items), then filter by it'
          }
        })
    }
  }
  const choices = VALUE_OPS.has(op) ? choicesOf(field) : null
  if (choices && values.length > 0) {
    const byValue = new Set(choices.map((c) => c.value))
    const fixed: unknown[] = []
    const unknown: unknown[] = []
    let anyFix = false
    for (const v of valuesOf(op, value)) {
      if (v === null || v === undefined || isDynamic(v) || byValue.has(String(v))) {
        fixed.push(v)
        continue
      }
      const s = String(v).trim().toLowerCase()
      const hit =
        choices.find((c) => c.value.toLowerCase() === s) ??
        choices.find((c) => c.label.toLowerCase() === s)
      if (hit) {
        fixed.push(typeof v === 'number' && isNumeric(hit.value) ? Number(hit.value) : hit.value)
        anyFix = true
      } else {
        fixed.push(v)
        unknown.push(v)
      }
    }
    const list = choices
      .slice(0, 12)
      .map((c) => (c.label !== c.value ? `${c.value} (${c.label})` : c.value))
      .join(', ')
    const other = allowsOther(field)
    if (unknown.length > 0)
      out.push({
        severity: other ? 'warning' : 'error',
        problem: {
          path: at,
          code: 'FILTER_VALUE_NOT_A_CHOICE',
          message: `${unknown.map((v) => JSON.stringify(v)).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${other ? 'among the listed' : 'one of the'} choices for "${at}": ${list}${choices.length > 12 ? ', …' : ''}`
        }
      })
    else if (anyFix) {
      out.push({
        severity: 'error',
        problem: {
          path: at,
          code: 'FILTER_VALUE_IS_LABEL',
          message: `"${at}" stores the choice value, not its label or a different case`,
          fix: `use ${JSON.stringify(op === '_eq' || op === '_neq' ? fixed[0] : fixed)}`
        },
        value: op === '_eq' || op === '_neq' ? fixed[0] : fixed
      })
    }
  }
  return out
}

// ── Fixes ────────────────────────────────────────────────────────────────────

interface Fix {
  /** Pointer to the key renamed, or to the operator whose value is replaced. */
  ptr: Pointer
  rename?: string
  value?: unknown
  hasValue?: boolean
}

function cloneTree<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneTree(x)) as T
  if (isPlainObject(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneTree(x)])) as T
  return v
}

/** The filter with the fixes applied (renames keep key order). Pure. */
export function applyFixes(filter: Record<string, unknown>, fixes: Fix[]): Record<string, unknown> {
  const root = cloneTree(filter)
  // Values first (their pointers use the original key names), then renames deepest first.
  const ordered = [
    ...fixes.filter((f) => f.hasValue),
    ...fixes.filter((f) => f.rename).sort((a, b) => b.ptr.length - a.ptr.length)
  ]
  for (const f of ordered) {
    let node: unknown = root
    for (const k of f.ptr.slice(0, -1)) {
      node = Array.isArray(node) ? node[k as number] : isPlainObject(node) ? node[k] : undefined
    }
    const key = f.ptr[f.ptr.length - 1]
    if (!isPlainObject(node) || typeof key !== 'string' || !(key in node)) continue
    if (f.hasValue) node[key] = f.value
    if (f.rename && f.rename !== key) {
      const entries = Object.entries(node).map(([k, v]) => [k === key ? f.rename : k, v] as const)
      for (const k of Object.keys(node)) delete node[k]
      for (const [k, v] of entries) node[k as string] = v
    }
  }
  return root
}

// ── The check ────────────────────────────────────────────────────────────────

const coded = (err: unknown) => {
  const e = err as { statusCode?: unknown; code?: unknown; message?: string }
  return (e?.statusCode === 400 || e?.statusCode === 403) && typeof e.code === 'string'
    ? (e as { statusCode: number; code: string; message: string } & Record<string, unknown>)
    : null
}

/** Most rounds of fixing a suggestion goes through (a renamed operator may then need a
 *  type fix of its own). */
const FIX_ROUNDS = 3

/**
 * Check a filter for `user` on `collection`. A collection the caller cannot read is refused
 * exactly as a list read refuses it (thrown); everything wrong with the filter is answered.
 */
export async function checkFilter(
  user: User,
  collection: string,
  filter: unknown
): Promise<FilterCheckResult> {
  const check = await filterCheckerFor(user, collection)
  if (!isPlainObject(filter)) {
    return {
      ok: false,
      collection,
      errors: [
        {
          path: '',
          code: 'FILTER_NOT_AN_OBJECT',
          message: 'A filter is an object: { "field": { "_eq": value } }'
        }
      ],
      warnings: [],
      suggestion: null,
      clauses: 0
    }
  }
  const fieldsOf = memo((c: string) => getFields(c).catch(() => [] as CMSField[]))
  const first = await analyze(check, collection, filter, fieldsOf)
  const result: FilterCheckResult = {
    ok: first.errors.length === 0,
    collection,
    errors: first.errors,
    warnings: first.warnings,
    suggestion: null,
    clauses: first.clauses,
    ...(first.truncated ? { truncated: true } : {})
  }
  // The suggestion: every fix applied, re-checked by the same gates and checks, until it is
  // clean — or no suggestion at all when a problem has no clear fix.
  let round = first
  let current = filter
  for (let i = 0; i < FIX_ROUNDS && round.fixes.length > 0 && round.unfixed === 0; i++) {
    current = applyFixes(current, round.fixes)
    round = await analyze(check, collection, current, fieldsOf)
    if (round.errors.length === 0) {
      result.suggestion = current
      break
    }
  }
  return result
}

interface Analysis {
  errors: FilterProblem[]
  warnings: FilterProblem[]
  fixes: Fix[]
  /** Errors without a clear fix. */
  unfixed: number
  clauses: number
  truncated: boolean
}

async function analyze(
  check: (filter: Record<string, unknown>) => Promise<void>,
  collection: string,
  filter: Record<string, unknown>,
  fieldsOf: (c: string) => Promise<CMSField[]>
): Promise<Analysis> {
  const all = splitFilter(filter)
  const clauses = all.slice(0, MAX_CLAUSES)
  const out: Analysis = {
    errors: [],
    warnings: [],
    fixes: [],
    unfixed: 0,
    clauses: clauses.length,
    truncated: all.length > clauses.length
  }
  const fixes = new Map<string, Fix>()
  const seen = new Set<string>()
  const add = (sev: 'error' | 'warning', p: FilterProblem, fix?: Fix) => {
    const key = `${sev}|${p.path}|${p.code}|${p.message}`
    if (seen.has(key)) return
    seen.add(key)
    ;(sev === 'error' ? out.errors : out.warnings).push(p)
    if (fix) fixes.set(JSON.stringify(fix.ptr) + (fix.rename ? '|r' : '|v'), fix)
    else if (sev === 'error') out.unfixed++
  }

  for (const clause of clauses) {
    const parts = clauseParts(clause)
    const path = displayPath(parts.fields)
    try {
      await check(clause.filter)
    } catch (err) {
      const e = coded(err)
      if (!e) throw err
      const fix = await fixFor(e, clause, parts, collection, fieldsOf)
      add(
        'error',
        { path, code: e.code, message: e.message, ...(fix?.words ? { fix: fix.words } : {}) },
        fix?.fix
      )
      continue
    }
    // Compiled: does it mean what was asked?
    if (parts.link || parts.fields.length === 0 || parts.fields[0].seg.startsWith('$')) continue
    const target = await resolveFilterPath(
      collection,
      parts.fields.map((f) => f.seg)
    ).catch(() => null)
    if (!target || target.link) continue
    const meta = (await fieldsOf(target.collection)).find((f) => f.field === target.field)
    if (!meta) continue
    const opIsKey = clause.ptr[clause.ptr.length - 1] === parts.op
    for (const lint of lintClause(path, parts.op, parts.value, meta)) {
      // A rename names the operator key; a shorthand clause (`{status: "open"}`) has none.
      const fix: Fix | undefined =
        lint.rename !== undefined && opIsKey
          ? { ptr: clause.ptr, rename: lint.rename }
          : 'value' in lint
            ? { ptr: clause.ptr, value: lint.value, hasValue: true }
            : undefined
      add(lint.severity, lint.problem, fix)
    }
  }

  // Clause by clause passed: the filter as a whole (depth, the shape of a group).
  if (out.errors.length === 0) {
    try {
      await check(filter)
    } catch (err) {
      const e = coded(err)
      if (!e) throw err
      add('error', { path: '', code: e.code, message: e.message })
    }
  }
  out.fixes = [...fixes.values()]
  return out
}

function memo<T>(fn: (k: string) => Promise<T>): (k: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>()
  return (k) => {
    let hit = cache.get(k)
    if (!hit) {
      hit = fn(k)
      cache.set(k, hit)
    }
    return hit
  }
}

/** The fix for a refusal the compiler gave, when one is clear. */
async function fixFor(
  e: { code: string } & Record<string, unknown>,
  clause: FilterClause,
  parts: ReturnType<typeof clauseParts>,
  collection: string,
  fieldsOf: (c: string) => Promise<CMSField[]>
): Promise<{ fix: Fix; words: string } | null> {
  const opIndex = clause.ptr.length - 1
  const opKey = clause.ptr[opIndex]
  if (e.code === 'UNKNOWN_FIELD') {
    const bad = Array.isArray(e.fields) ? String(e.fields[0] ?? '') : ''
    const idx = parts.fields.findIndex((f) => f.seg === bad)
    if (idx < 0) return null
    const prefix = parts.fields.slice(0, idx).map((f) => f.seg)
    const where = prefix.length
      ? (await resolveFilterPath(collection, [...prefix, bad]).catch(() => null))?.collection
      : collection
    if (!where) return null
    const fields = await fieldsOf(where)
    const best = nearestField(
      bad,
      fields.map((f) => ({
        field: f.field,
        label: (f as unknown as { label?: string | null }).label ?? null
      }))
    )
    if (!best) return null
    return {
      fix: { ptr: clause.ptr.slice(0, parts.fields[idx].at + 1), rename: best },
      words: `did you mean "${best}"?`
    }
  }
  if (e.code === 'FILTER_OPERATOR_UNKNOWN' || e.code === 'FILTER_PATH_UNSUPPORTED') {
    if (typeof opKey !== 'string') return null
    const best = nearestOperator(opKey)
    if (!best) return null
    return { fix: { ptr: clause.ptr, rename: best }, words: `use "${best}"` }
  }
  if (e.code === 'FILTER_VALUE_INVALID' && (opKey === '_in' || opKey === '_nin')) {
    if (Array.isArray(parts.value)) return null
    const list =
      typeof parts.value === 'string' && parts.value.includes(',')
        ? parts.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [parts.value]
    return {
      fix: { ptr: clause.ptr, value: list, hasValue: true },
      words: `use a list: ${JSON.stringify(list)}`
    }
  }
  return null
}
