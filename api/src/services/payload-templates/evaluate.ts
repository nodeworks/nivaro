import { randomBytes } from 'node:crypto'
import type { Template } from 'liquidjs'
import { instanceTimezone } from '../liquid-dates.js'
import {
  addDays,
  atLeastDaysOut,
  calendarDay,
  editorText,
  isoDate,
  nextOpenDay,
  padStart,
  payloadLiquid
} from '../payload-filters.js'
import { type ConditionRule, evalConditionRule } from '../workflow-conditions.js'
import type { Field, MapSpec, Problem, Transform, ValueSpec } from './types.js'

export { validateSpec } from './validate.js'

// ─── Field-map evaluator ─────────────────────────────────────────────────────
// Walks a map-mode payload template (types.ts) and builds the request body as a
// JS object — never by concatenating strings — so the body is always valid
// JSON and record text is carried verbatim (Liquid never sees it unless a row
// is a formula). Every problem is collected, never thrown, so a preview shows
// them all at once.
//
// Paths: `a.b[0].c` and `a.b.0.c`. The first segment resolves lexically: a
// list alias or number alias (innermost list first), then a field of the list
// item (innermost first), then a top-level scope key, then a field of
// `scope.record`. So inside a list `line.quantity` and `quantity` read the
// same value — and an item column named `state` shadows `scope.state` — while
// outside a list `cost_type` reads `record.cost_type`. A string that holds JSON
// (an MSSQL JSON text column) is parsed when the path walks into it.
//
// Condition rules (`include.when`, `list.where`, `switch` cases) use the
// shared `evalConditionRule`: the rule's `field` is resolved with the same
// path rules and handed to the evaluator as a one-key record, so dotted paths
// work. Related-row ops (`child:fk` fields) read the pre-resolved counts on
// `scope.record`.
//
// Secrets: only the `secret` source may put a real placeholder in the body.
// While evaluating it emits a private token (a per-call random nonce, digits
// only so upper/lower leave it alone); a final pass over every leaf and key
// of the built body neutralizes any `⟦nvr-secret:` (record text, JSON text
// decoded on the way, fixed text, formula output) and only then swaps the
// tokens for the real placeholders.

/** The placeholder a body secret renders as; the sender swaps in the value. */
export const SECRET_PLACEHOLDER = (name: string): string => `⟦nvr-secret:${name}⟧`

const MARKER = '⟦nvr-secret:'
const NEUTRAL = '⟦nvr-secret\u200b:'

const neutralString = (s: string): string =>
  s.includes(MARKER) ? s.split(MARKER).join(NEUTRAL) : s

/** Deep copy with `fn` applied to every string — values and object keys. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  const seen = new WeakMap<object, unknown>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fn(v)
    if (v === null || typeof v !== 'object') return v
    if (v instanceof Date) return new Date(v.getTime())
    // Binary and keyed collections are opaque (JSON has no form for them).
    if (v instanceof Map || v instanceof Set || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      return v
    }
    const hit = seen.get(v)
    if (hit !== undefined) return hit
    if (Array.isArray(v)) {
      const out: unknown[] = []
      seen.set(v, out)
      for (const x of v) out.push(walk(x))
      return out
    }
    // Plain records and class instances alike: own enumerable keys.
    const out: Record<string, unknown> =
      Object.getPrototypeOf(v) === null ? Object.create(null) : {}
    seen.set(v, out)
    for (const k of Object.keys(v)) {
      const key = fn(k)
      const x = walk((v as Record<string, unknown>)[k])
      if (key === '__proto__') {
        Object.defineProperty(out, key, {
          value: x,
          enumerable: true,
          writable: true,
          configurable: true
        })
      } else out[key] = x
    }
    return out
  }
  return walk(value)
}

/**
 * A deep copy of `value` in which no string — value or object key — can pass
 * for a secret placeholder: every `⟦nvr-secret:` gets a zero-width space
 * before its colon. Pure (no imports), so the code-mode render and
 * body-secrets can share it.
 */
export function neutralizeSecretMarkers(value: unknown): unknown {
  return mapStrings(value, neutralString)
}

type Frame = { alias: string; numberAs: string; item: unknown; number: number }

type Ctx = {
  scope: Record<string, unknown>
  frames: Frame[]
  zone: string
  secretNames: Set<string> | null
  problems: Problem[]
  seen: Set<string>
  values: Record<string, unknown>
  skip: WeakSet<object>
  json: Map<string, unknown>
  /** Secret names behind the private tokens, by index. */
  secrets: string[]
  /** Per-call random digits: record data cannot guess a token. */
  nonce: string
}

type At = { fieldId: string; path: string }

/** A resolved value plus what the editor needs to explain an empty one. */
type Got = {
  value: unknown
  /** Source path whose parent object is missing (the value is null because of it). */
  missing: string | null
  /** Source path the value came from, when it was a path. */
  source: string | null
  /** The value is formula output (a `json` row parses it). */
  formula: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isEmpty = (v: unknown): boolean =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0)

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function addProblem(ctx: Ctx, at: At, message: string, severity: Problem['severity']): void {
  // One problem per row + message: a 2,000-line list reports a bad row once,
  // anchored at its first occurrence.
  const key = `${at.fieldId}\u0001${severity}\u0001${message}`
  if (ctx.seen.has(key)) return
  ctx.seen.add(key)
  ctx.problems.push({ field_id: at.fieldId, path: at.path, message, severity })
}

function setKey(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  } else out[key] = value
}

const joinPath = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key)

/** A short, quoted rendering of a value for problem messages. */
function show(v: unknown): string {
  let s: string
  if (typeof v === 'string') s = v
  else {
    try {
      s = JSON.stringify(v) ?? String(v)
    } catch {
      s = String(v)
    }
  }
  return `'${s.length > 60 ? `${s.slice(0, 57)}...` : s}'`
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const pathCache = new Map<string, string[]>()
function segments(path: string): string[] {
  let segs = pathCache.get(path)
  if (!segs) {
    segs = path
      .replace(/\[\s*(\d+)\s*\]/g, '.$1')
      .split('.')
      .map((s) => s.trim())
      .filter(Boolean)
    if (pathCache.size > 5000) pathCache.clear()
    pathCache.set(path, segs)
  }
  return segs
}

function parseJsonText(ctx: Ctx, s: string): unknown {
  const t = s.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return s
  if (ctx.json.has(s)) return ctx.json.get(s)
  let parsed: unknown = s
  try {
    parsed = JSON.parse(t)
  } catch {
    parsed = s
  }
  if (ctx.json.size < 1000) ctx.json.set(s, parsed)
  return parsed
}

/** Walk `segs[from..]` down from `start`. */
function walk(
  ctx: Ctx,
  start: unknown,
  segs: string[],
  from: number
): { value: unknown; parentMissing: boolean } {
  let cur = start
  for (let i = from; i < segs.length; i++) {
    if (typeof cur === 'string') cur = parseJsonText(ctx, cur)
    if (cur == null || typeof cur !== 'object') return { value: null, parentMissing: true }
    const seg = segs[i]
    cur = Object.hasOwn(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined
  }
  return { value: cur === undefined ? null : cur, parentMissing: false }
}

function resolvePath(ctx: Ctx, path: string): { value: unknown; parentMissing: boolean } {
  const segs = segments(path)
  if (segs.length === 0) return { value: null, parentMissing: false }
  const root = segs[0]
  for (let i = ctx.frames.length - 1; i >= 0; i--) {
    const fr = ctx.frames[i]
    if (fr.alias === root) return walk(ctx, fr.item, segs, 1)
    if (fr.numberAs === root) return walk(ctx, fr.number, segs, 1)
  }
  // Lexical: the item's own columns before the top-level scope.
  for (let i = ctx.frames.length - 1; i >= 0; i--) {
    const item = ctx.frames[i].item
    if (isObj(item) && Object.hasOwn(item, root)) return walk(ctx, item, segs, 0)
  }
  if (Object.hasOwn(ctx.scope, root)) return walk(ctx, ctx.scope[root], segs, 1)
  const record = ctx.scope.record
  if (isObj(record) && Object.hasOwn(record, root)) return walk(ctx, record, segs, 0)
  // Nothing by that name: a one-segment path is just empty; a longer one is
  // missing its parent.
  return { value: null, parentMissing: segs.length > 1 }
}

// ─── Conditions ──────────────────────────────────────────────────────────────

function rulesPass(ctx: Ctx, rules: unknown, at: At): boolean {
  if (!Array.isArray(rules) || rules.length === 0) return true
  for (const r of rules as ConditionRule[]) {
    // Malformed rules are unconditioned, as evaluateConditionRules treats them.
    if (!isObj(r) || typeof r.field !== 'string' || !r.field) continue
    let pass: boolean
    try {
      if (r.field.includes(':')) {
        // related-row ops: counts are pre-resolved on the record
        pass = evalConditionRule(r, isObj(ctx.scope.record) ? ctx.scope.record : {})
      } else {
        pass = evalConditionRule(r, { [r.field]: resolvePath(ctx, r.field).value })
      }
    } catch (err) {
      addProblem(ctx, at, `Condition on ${r.field} failed: ${errMsg(err)}`, 'error')
      pass = false
    }
    if (!pass) return false
  }
  return true
}

// ─── Liquid (formula values, date transform) ─────────────────────────────────

const templateCache = new Map<string, Template[] | Error>()
function parsed(liquid: string): Template[] | Error {
  let hit = templateCache.get(liquid)
  if (!hit) {
    try {
      hit = payloadLiquid().parse(liquid)
    } catch (err) {
      hit = err instanceof Error ? err : new Error(String(err))
    }
    if (templateCache.size > 500) templateCache.clear()
    templateCache.set(liquid, hit)
  }
  return hit
}

function liquidScope(ctx: Ctx): Record<string, unknown> {
  const s: Record<string, unknown> = { ...ctx.scope }
  for (const fr of ctx.frames) {
    s[fr.alias] = fr.item
    s[fr.numberAs] = fr.number
  }
  return s
}

async function renderFormula(ctx: Ctx, liquid: string, at: At): Promise<unknown> {
  const tpl = parsed(String(liquid ?? ''))
  if (tpl instanceof Error) {
    addProblem(ctx, at, `Formula error: ${tpl.message}`, 'error')
    return null
  }
  try {
    return String(await payloadLiquid().render(tpl, liquidScope(ctx)))
  } catch (err) {
    addProblem(ctx, at, `Formula error: ${errMsg(err)}`, 'error')
    return null
  }
}

async function formatDate(v: unknown, format: string): Promise<unknown> {
  const tpl = parsed('{{ v | date: f }}') as Template[]
  const out = String(await payloadLiquid().render(tpl, { v, f: String(format ?? '') }))
  return out === '' ? null : out
}

// ─── Values ──────────────────────────────────────────────────────────────────

function builtin(ctx: Ctx, name: string, at: At): unknown {
  const user = isObj(ctx.scope.acting_user) ? ctx.scope.acting_user : null
  const state = isObj(ctx.scope.state) ? ctx.scope.state : null
  switch (name) {
    case 'today':
      return calendarDay(undefined, new Date(), ctx.zone)
    case 'now':
      return new Date().toISOString()
    case 'acting_user.email':
      return user?.email ?? null
    case 'acting_user.employee_id':
      return user?.employee_id ?? null
    case 'acting_user.name': {
      if (!user) return null
      if (user.name != null && user.name !== '') return user.name
      const full = [user.first_name, user.last_name].filter((x) => x != null && x !== '').join(' ')
      return full || null
    }
    case 'list.number':
      return ctx.frames.length ? ctx.frames[ctx.frames.length - 1].number : null
    case 'state.label':
      return state?.label ?? null
    case 'state.external_label':
      return state?.external_label ?? null
    default:
      addProblem(ctx, at, `Unknown built-in value '${name}'`, 'error')
      return null
  }
}

async function rawValue(ctx: Ctx, spec: ValueSpec, at: At): Promise<Got> {
  const got: Got = { value: null, missing: null, source: null, formula: false }
  switch (spec.source) {
    case 'fixed':
      got.value = spec.value ?? null
      return got
    case 'path': {
      const path = String(spec.path ?? '')
      const r = resolvePath(ctx, path)
      got.value = r.value
      got.source = path
      if (r.parentMissing) got.missing = path
      return got
    }
    case 'builtin':
      got.value = builtin(ctx, spec.name, at)
      return got
    case 'secret': {
      const name = String(spec.name ?? '').trim()
      if (!name) {
        addProblem(ctx, at, 'No secret chosen', 'error')
        return got
      }
      if (ctx.secretNames && !ctx.secretNames.has(name)) {
        addProblem(ctx, at, `${name} is not a body secret on this API`, 'error')
      }
      // A private token; finalize() swaps it for SECRET_PLACEHOLDER(name).
      ctx.secrets.push(name)
      got.value = `\u0001${ctx.nonce}:${ctx.secrets.length - 1}\u0001`
      return got
    }
    case 'switch': {
      for (const c of Array.isArray(spec.cases) ? spec.cases : []) {
        if (!isObj(c)) continue
        if (rulesPass(ctx, c.when, at)) return isObj(c.value) ? evalValue(ctx, c.value, at) : got
      }
      return isObj(spec.else) ? evalValue(ctx, spec.else, at) : got
    }
    case 'formula':
      got.value = await renderFormula(ctx, spec.liquid, at)
      got.formula = true
      return got
    default:
      addProblem(
        ctx,
        at,
        `Unknown value source '${String((spec as { source?: unknown }).source)}'`,
        'error'
      )
      return got
  }
}

async function evalValue(ctx: Ctx, spec: ValueSpec, at: At): Promise<Got> {
  const transforms =
    Array.isArray(spec.transforms) && spec.transforms.length ? spec.transforms : null
  const transformed = async (g: Got): Promise<Got> => {
    if (transforms) g.value = await applyTransforms(ctx, g.value, transforms, at)
    return g
  }
  // The row's transforms apply to each candidate, and the first candidate
  // non-empty AFTER them wins — so '   ' with trim falls through.
  let got = await transformed(await rawValue(ctx, spec, at))
  if (isEmpty(got.value) && Array.isArray(spec.fallbacks)) {
    for (const fb of spec.fallbacks) {
      if (!isObj(fb)) continue
      const next = await transformed(await evalValue(ctx, fb, at))
      if (!isEmpty(next.value)) {
        // The winner's path is the one that counts; the primary's empty
        // parent no longer matters.
        got = next
        break
      }
    }
  }
  return got
}

function text(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  if (typeof v === 'object' && v !== null) return JSON.stringify(v)
  return String(v)
}

/** First `n` characters, counting code points (an emoji is never split). */
function truncateChars(s: string, n: number): string {
  if (s.length <= n) return s
  return Array.from(s)
    .slice(0, Math.max(0, Math.trunc(n)))
    .join('')
}

async function applyTransforms(
  ctx: Ctx,
  value: unknown,
  list: Transform[],
  at: At
): Promise<unknown> {
  let v = value
  for (const t of list) {
    if (!isObj(t)) continue
    // Deliberate: a missing value skips the transforms and stays missing, so
    // `not_empty`, `required` and fallbacks still see it (pad_start would
    // otherwise turn null into '', prefix into 'US'). The one exception is
    // at_least_days_out, where a missing date means "none yet" → today + n.
    if (v == null && t.op !== 'at_least_days_out') continue
    switch (t.op) {
      case 'trim':
        v = text(v).trim()
        break
      case 'upper':
        v = text(v).toUpperCase()
        break
      case 'lower':
        v = text(v).toLowerCase()
        break
      case 'next_open_day':
        v = await nextOpenDay(v as string)
        break
      case 'editor_text':
        v = editorText(v)
        break
      case 'truncate': {
        const n = Number(t.n)
        if (Number.isFinite(n)) v = truncateChars(text(v), n)
        break
      }
      case 'prefix':
        v = String(t.text ?? '') + text(v)
        break
      case 'suffix':
        v = text(v) + String(t.text ?? '')
        break
      case 'pad_start':
        v = padStart(v, Number(t.n), String(t.char ?? '0'))
        break
      case 'replace': {
        const from = String(t.from ?? '')
        if (from)
          v = text(v)
            .split(from)
            .join(String(t.to ?? ''))
        break
      }
      case 'date':
        v = await formatDate(v, t.format)
        break
      case 'add_days':
        v = addDays(v as string, Number(t.n))
        break
      case 'at_least_days_out':
        v = atLeastDaysOut(v as string | null, Number(t.n))
        break
      case 'join':
        v = Array.isArray(v)
          ? v.map((x) => (x == null ? '' : text(x))).join(String(t.sep ?? ''))
          : text(v)
        break
      default:
        addProblem(ctx, at, `Unknown transform '${String((t as { op?: unknown }).op)}'`, 'error')
    }
  }
  return v
}

/** Coerce to the row's type. `failed` = a type problem was reported. */
function coerce(ctx: Ctx, type: string, got: Got, at: At): { value: unknown; failed: boolean } {
  const v = got.value === undefined ? null : got.value
  const fail = (message: string) => {
    addProblem(ctx, at, message, 'error')
    return { value: null, failed: true }
  }
  switch (type) {
    case 'text':
      if (v == null) return { value: null, failed: false }
      if (Array.isArray(v)) return fail('Text expected, got a list')
      if (typeof v === 'object' && !(v instanceof Date)) return fail('Text expected, got an object')
      return { value: text(v), failed: false }
    case 'number': {
      if (v == null) return { value: null, failed: false }
      if (typeof v === 'string' && v.trim() === '') return { value: null, failed: false }
      if (typeof v === 'object' || typeof v === 'symbol' || typeof v === 'function') {
        return fail(`Number expected, got ${show(v)}`)
      }
      const n = typeof v === 'string' ? Number(v.trim()) : Number(v)
      return Number.isFinite(n)
        ? { value: n, failed: false }
        : fail(`Number expected, got ${show(v)}`)
    }
    case 'boolean': {
      if (v == null || v === '') return { value: null, failed: false }
      if (typeof v === 'boolean') return { value: v, failed: false }
      if (v === 1 || v === 0) return { value: v === 1, failed: false }
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase()
        if (s === 'true' || s === '1') return { value: true, failed: false }
        if (s === 'false' || s === '0') return { value: false, failed: false }
      }
      return fail(`Boolean expected, got ${show(v)}`)
    }
    case 'date': {
      if (v == null || v === '') return { value: null, failed: false }
      if (typeof v !== 'string' && !(v instanceof Date))
        return fail(`Date expected, got ${show(v)}`)
      const day = isoDate(v)
      return day ? { value: day, failed: false } : fail(`Date expected, got ${show(v)}`)
    }
    case 'json': {
      if (!got.formula || typeof v !== 'string') return { value: v, failed: false }
      if (v.trim() === '') return { value: null, failed: false }
      try {
        return { value: JSON.parse(v), failed: false }
      } catch (err) {
        return fail(`Formula output is not valid JSON: ${errMsg(err)}`)
      }
    }
    default:
      return fail(`Unknown type '${type}'`)
  }
}

// ─── Fields ──────────────────────────────────────────────────────────────────

async function scalarValue(ctx: Ctx, field: Field, at: At, itemDefault: unknown): Promise<unknown> {
  const got: Got = isObj(field.value)
    ? await evalValue(ctx, field.value, at)
    : { value: itemDefault ?? null, missing: null, source: null, formula: false }
  const { value, failed } = coerce(ctx, field.type, got, at)
  if (!failed && isEmpty(value)) {
    if (field.rules?.required) {
      addProblem(
        ctx,
        at,
        `${got.missing ?? got.source ?? field.key} has no value on this record`,
        'error'
      )
    } else if (got.missing) {
      addProblem(ctx, at, `${got.missing} has no value on this record`, 'warning')
    }
  }
  return value
}

function sortItems(ctx: Ctx, items: unknown[], sort: string, alias: string): unknown[] {
  const desc = sort.startsWith('-')
  let key = (desc ? sort.slice(1) : sort).trim()
  if (key.startsWith(`${alias}.`)) key = key.slice(alias.length + 1)
  if (!key) return items
  const segs = segments(key)
  const keyed = items.map((item, i) => ({ item, i, k: walk(ctx, item, segs, 0).value }))
  const numeric = (x: unknown) =>
    typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x)))
  keyed.sort((a, b) => {
    // missing keys sort last either way
    const an = a.k == null || a.k === ''
    const bn = b.k == null || b.k === ''
    if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1
    let c: number
    if (numeric(a.k) && numeric(b.k)) c = Number(a.k) - Number(b.k)
    else {
      const as = text(a.k)
      const bs = text(b.k)
      c = as < bs ? -1 : as > bs ? 1 : 0
    }
    return (desc ? -c : c) || a.i - b.i
  })
  return keyed.map((x) => x.item)
}

async function listValue(ctx: Ctx, field: Field, at: At): Promise<unknown[]> {
  const ls = field.list
  if (!isObj(ls) || typeof ls.source !== 'string' || !ls.source.trim()) {
    addProblem(ctx, at, 'This list has no source', 'error')
    return []
  }
  const alias = (typeof ls.item === 'string' && ls.item.trim()) || 'line'
  const numberAs = (typeof ls.number_as === 'string' && ls.number_as.trim()) || 'number'
  const r = resolvePath(ctx, ls.source)
  let src = typeof r.value === 'string' ? parseJsonText(ctx, r.value) : r.value
  if (src != null && !Array.isArray(src)) {
    addProblem(ctx, at, `${ls.source} is not a list`, 'error')
    src = null
  }
  let items = (src as unknown[] | null) ?? []
  if (items.length === 0) {
    if (field.rules?.required) {
      addProblem(ctx, at, `${ls.source} has no value on this record`, 'error')
    } else if (r.parentMissing) {
      addProblem(ctx, at, `${ls.source} has no value on this record`, 'warning')
    }
    return []
  }

  const frame: Frame = { alias, numberAs, item: null, number: 0 }
  ctx.frames.push(frame)
  try {
    if (Array.isArray(ls.where) && ls.where.length) {
      items = items.filter((item) => {
        frame.item = item
        return rulesPass(ctx, ls.where, at)
      })
    }
    if (typeof ls.sort === 'string' && ls.sort.trim()) items = sortItems(ctx, items, ls.sort, alias)

    const children = Array.isArray(field.children) ? field.children : []
    const out: unknown[] = []
    for (let i = 0; i < items.length; i++) {
      frame.item = items[i]
      frame.number = i + 1
      const itemPath = `${at.path}[${i}]`
      if (ls.scalar) {
        const child = children.find((c) => isObj(c) && !ctx.skip.has(c))
        if (!child) {
          out.push(items[i] ?? null)
          continue
        }
        const res = await fieldValue(
          ctx,
          child,
          { fieldId: String(child.id ?? ''), path: itemPath },
          items[i]
        )
        if (!res.drop) out.push(res.value)
      } else {
        out.push(await objectValue(ctx, children, itemPath))
      }
    }
    if (out.length === 0 && field.rules?.required) {
      addProblem(ctx, at, `${ls.source} has no value on this record`, 'error')
    }
    return out
  } finally {
    ctx.frames.pop()
  }
}

async function fieldValue(
  ctx: Ctx,
  field: Field,
  at: At,
  itemDefault?: unknown
): Promise<{ value?: unknown; drop: boolean }> {
  const include = field.include
  if (isObj(include) && !rulesPass(ctx, include.when, at)) return { drop: true }
  let value: unknown
  if (field.type === 'object') {
    value = await objectValue(ctx, Array.isArray(field.children) ? field.children : [], at.path)
  } else if (field.type === 'list') {
    value = await listValue(ctx, field, at)
  } else {
    value = await scalarValue(ctx, field, at, itemDefault)
  }
  if (!Object.hasOwn(ctx.values, at.fieldId)) ctx.values[at.fieldId] = value
  if (include === 'not_empty' && isEmpty(value)) return { drop: true }
  return { value, drop: false }
}

async function objectValue(
  ctx: Ctx,
  fields: Field[],
  prefix: string
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (!isObj(field) || ctx.skip.has(field)) continue
    const at = { fieldId: String(field.id ?? ''), path: joinPath(prefix, field.key) }
    try {
      const res = await fieldValue(ctx, field, at)
      if (!res.drop) setKey(out, field.key, res.value)
    } catch (err) {
      addProblem(ctx, at, `Could not evaluate: ${errMsg(err)}`, 'error')
      setKey(out, field.key, null)
    }
  }
  return out
}

/** Static key checks, once per sibling set (not once per list item). */
function checkKeys(ctx: Ctx, fields: unknown, prefix: string): void {
  if (!Array.isArray(fields)) return
  const keys = new Set<string>()
  for (const field of fields) {
    if (!isObj(field)) {
      addProblem(ctx, { fieldId: '', path: prefix }, 'A row is not a field', 'error')
      continue
    }
    const at: At = { fieldId: String(field.id ?? ''), path: prefix }
    const key = typeof field.key === 'string' ? field.key : ''
    if (!key.trim()) {
      addProblem(ctx, at, 'Empty key', 'error')
      ctx.skip.add(field)
      continue
    }
    at.path = joinPath(prefix, key)
    if (keys.has(key)) {
      addProblem(ctx, at, `Duplicate key '${key}'`, 'error')
      ctx.skip.add(field)
      continue
    }
    keys.add(key)
    if (/^(0|[1-9]\d*)$/.test(key) && Number(key) <= 4294967294) {
      addProblem(
        ctx,
        at,
        `Key '${key}' is a number: JSON objects put number keys first, so it will not keep its place`,
        'warning'
      )
    }
    if (field.type === 'object') checkKeys(ctx, field.children, at.path)
    else if (field.type === 'list') checkKeys(ctx, field.children, `${at.path}[]`)
  }
}

/**
 * Build the request body for a map-mode template. Never throws: everything
 * wrong is in `problems`. `values` holds each row's value by field id (rows
 * inside a list: the first rendered item's).
 */
export async function evaluateMap(
  spec: MapSpec,
  scope: Record<string, unknown>,
  opts: { secretNames?: string[] } = {}
): Promise<{
  body: Record<string, unknown>
  problems: Problem[]
  values: Record<string, unknown>
}> {
  let zone = 'America/New_York'
  try {
    // warms the cached zone the sync day helpers (addDays, atLeastDaysOut) read
    zone = await instanceTimezone()
  } catch {
    /* fallback zone */
  }
  const ctx: Ctx = {
    scope: isObj(scope) ? scope : {},
    frames: [],
    zone,
    secretNames: Array.isArray(opts.secretNames) ? new Set(opts.secretNames) : null,
    problems: [],
    seen: new Set(),
    values: {},
    skip: new WeakSet(),
    json: new Map(),
    secrets: [],
    nonce: BigInt(`0x${randomBytes(16).toString('hex')}`).toString()
  }
  const fields = isObj(spec) && Array.isArray(spec.fields) ? spec.fields : null
  if (!fields) {
    addProblem(ctx, { fieldId: '', path: '' }, 'The field map has no fields list', 'error')
    return { body: {}, problems: ctx.problems, values: ctx.values }
  }
  checkKeys(ctx, fields, '')
  let body: Record<string, unknown> = {}
  try {
    body = await objectValue(ctx, fields, '')
  } catch (err) {
    addProblem(ctx, { fieldId: '', path: '' }, `Could not evaluate: ${errMsg(err)}`, 'error')
  }
  const fin = finalizer(ctx)
  for (const p of ctx.problems) p.message = fin(p.message)
  return {
    body: mapStrings(body, fin) as Record<string, unknown>,
    problems: ctx.problems,
    values: mapStrings(ctx.values, fin) as Record<string, unknown>
  }
}

/**
 * The one final pass over every leaf and key: neutralize any placeholder the
 * data spelled (including JSON text decoded along the way), then swap this
 * call's private tokens for the real placeholders.
 */
function finalizer(ctx: Ctx): (s: string) => string {
  const token = new RegExp(`\\u0001${ctx.nonce}:(\\d+)\\u0001`, 'g')
  return (s) => {
    const safe = neutralString(s)
    if (!safe.includes('\u0001')) return safe
    return safe.replace(token, (m, i: string) => {
      const name = ctx.secrets[Number(i)]
      return name === undefined ? m : SECRET_PLACEHOLDER(name)
    })
  }
}
