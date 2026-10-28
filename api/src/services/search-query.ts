/**
 * The search box's little query language (search program 2026-10-28, items 2/3/16).
 *
 *   wf: canton            prefix scope — search one collection (config: search_scopes)
 *   @jane                 people only
 *   status:open           field filter (field key or its label slug), contains / equals
 *   amount:>=10k          field filter with a comparison
 *   $12,500  12.5k        an amount on the scoped collection's money field
 *   Oct 2026  2026-10     a date range on the scoped collection's date field
 *   last week  this month
 *
 * Pure: parsing never reads the database. `resolveQueryFilters` turns the
 * parsed tokens into items-service filter clauses against ONE collection's
 * readable fields (the route passes only fields the caller may read, so a
 * filter can never test a withheld column). Anything that does not resolve
 * stays search text — an unknown `foo:bar` is just words.
 */

export const PEOPLE_SCOPE = '__people__'

export type FilterOp = 'eq' | 'contains' | 'gte' | 'lte'

export interface FilterChip {
  field: string
  label: string
  op: FilterOp
  value: string
}

export interface FieldToken {
  raw: string
  key: string
  /** '>=' | '<=' | '>' | '<' | '=' | '' */
  cmp: string
  value: string
}

export interface MoneyToken {
  raw: string
  cmp: string
  /** Inclusive bounds; an exact amount has min === max. */
  min: number
  max: number
}

export interface DateToken {
  raw: string
  /** YYYY-MM-DD inclusive start. */
  start: string
  /** YYYY-MM-DD EXCLUSIVE end. */
  end: string
}

export interface ParsedQuery {
  /** Plain search words left after scopes/filters/amounts/dates. */
  text: string
  /** The prefix as typed (`wf`, `@`), or null. */
  scopeKey: string | null
  /** The collection it names, PEOPLE_SCOPE, or null. */
  scope: string | null
  fields: FieldToken[]
  money: MoneyToken[]
  dates: DateToken[]
}

export interface FieldMeta {
  field: string
  label?: string | null
  type: string
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

/** Whitespace-split, honouring double quotes (`status:"on hold"`). Quotes are kept
 *  off the token; a lone quote runs to the end. */
export function tokenize(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const SCOPE_KEY_RE = /^[a-z][a-z0-9_-]{0,15}$/
const FIELD_TOKEN_RE = /^([A-Za-z_][A-Za-z0-9_-]{0,63}):(.+)$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A scopes map as configured, cleaned: lower-case keys, identifier targets. */
export function normalizeScopes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  let obj = raw
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj)
    } catch {
      return out
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = String(k).trim().toLowerCase().replace(/:$/, '')
    const target = typeof v === 'string' ? v.trim() : ''
    if (!(key === '@' || SCOPE_KEY_RE.test(key))) continue
    if (target !== PEOPLE_SCOPE && !IDENT_RE.test(target)) continue
    out[key] = target
  }
  return out
}

// ─── Amounts ──────────────────────────────────────────────────────────────────

const MONEY_RE = /^(>=|<=|>|<|=)?(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([kKmM])?$/

/** `$12,500` → 12500 exact; `12.5k` → about 12,500 (±5%); `>$10k` → ≥ 10000.
 *  A bare number is NOT an amount (it is an id or a word): it needs `$` or k/m. */
export function parseMoney(token: string): MoneyToken | null {
  const m = MONEY_RE.exec(token.trim())
  if (!m) return null
  const [, cmp = '', dollar, whole, frac, suffix] = m
  if (!dollar && !suffix) return null
  const base = Number(`${whole.replace(/,/g, '')}${frac ? `.${frac}` : ''}`)
  if (!Number.isFinite(base)) return null
  const mult = !suffix ? 1 : suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000
  const v = Math.round(base * mult * 100) / 100
  if (cmp === '>' || cmp === '>=')
    return { raw: token, cmp: '>=', min: v, max: Number.POSITIVE_INFINITY }
  if (cmp === '<' || cmp === '<=')
    return { raw: token, cmp: '<=', min: Number.NEGATIVE_INFINITY, max: v }
  // A k/m amount is a rounded figure: match the neighbourhood, not the cent.
  if (suffix) {
    const slack = Math.round(v * 0.05 * 100) / 100
    return { raw: token, cmp: '', min: v - slack, max: v + slack }
  }
  return { raw: token, cmp: '', min: v, max: v }
}

/** A plain number for a numeric field filter: `500`, `12.5k`, `$1,200`. */
export function parseNumber(value: string): number | null {
  const m = /^(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([kKmM])?$/.exec(value.trim())
  if (!m) return null
  const base = Number(`${m[2].replace(/,/g, '')}${m[3] ? `.${m[3]}` : ''}`)
  const mult = !m[4] ? 1 : m[4].toLowerCase() === 'k' ? 1_000 : 1_000_000
  const v = base * mult
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}

// ─── Dates ────────────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d))

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, '')
  if (w.length < 3) return -1
  const i = MONTHS.indexOf(w.slice(0, 3))
  if (i < 0) return -1
  // "march" / "mar" / "sept" — never "marble".
  const full = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december'
  ][i]
  return full.startsWith(w) || (i === 8 && w === 'sept') ? i : -1
}

const monthRange = (y: number, m: number) => ({
  start: ymd(utc(y, m, 1)),
  end: ymd(utc(y, m + 1, 1))
})

/**
 * A date phrase over 1–2 tokens at `i`: returns the range and how many tokens it
 * used, or null. `now` is the clock (UTC dates; weeks start Monday).
 */
export function parseDateAt(
  tokens: string[],
  i: number,
  now: Date
): { start: string; end: string; used: number } | null {
  const a = tokens[i]?.toLowerCase() ?? ''
  const b = tokens[i + 1]?.toLowerCase() ?? ''
  const today = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(a)
  if (m) {
    const d = utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (d.getUTCMonth() !== Number(m[2]) - 1) return null
    return { start: ymd(d), end: ymd(addDays(d, 1)), used: 1 }
  }
  m = /^(\d{4})-(\d{1,2})$/.exec(a)
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return { ...monthRange(Number(m[1]), Number(m[2]) - 1), used: 1 }
  }
  const mi = monthIndex(a)
  if (mi >= 0 && /^\d{4}$/.test(b)) return { ...monthRange(Number(b), mi), used: 2 }
  if (a === 'today') return { start: ymd(today), end: ymd(addDays(today, 1)), used: 1 }
  if (a === 'yesterday') return { start: ymd(addDays(today, -1)), end: ymd(today), used: 1 }
  if ((a === 'last' || a === 'this') && ['week', 'month', 'year'].includes(b)) {
    const back = a === 'last' ? 1 : 0
    if (b === 'week') {
      const monday = addDays(today, -((today.getUTCDay() + 6) % 7))
      const start = addDays(monday, -7 * back)
      return { start: ymd(start), end: ymd(addDays(start, 7)), used: 2 }
    }
    if (b === 'month') {
      return { ...monthRange(today.getUTCFullYear(), today.getUTCMonth() - back), used: 2 }
    }
    const y = today.getUTCFullYear() - back
    return { start: ymd(utc(y, 0, 1)), end: ymd(utc(y + 1, 0, 1)), used: 2 }
  }
  return null
}

/** A date value inside a field filter (`due:2026-10`, `due:last-week`, `due:"Oct 2026"`). */
export function parseDateValue(value: string, now: Date): { start: string; end: string } | null {
  const tokens = value
    .replace(/[-_](week|month|year)$/i, ' $1')
    .split(/\s+/)
    .filter(Boolean)
  const r = parseDateAt(tokens, 0, now)
  return r && r.used === tokens.length ? { start: r.start, end: r.end } : null
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Split a raw query into scope, field tokens, amounts, dates and text. One scope
 * at most (the first); `@word` as the FIRST token means people.
 */
export function parseSearchQuery(
  raw: string,
  scopes: Record<string, string>,
  now: Date = new Date()
): ParsedQuery {
  const tokens = tokenize(raw.trim())
  const out: ParsedQuery = {
    text: '',
    scopeKey: null,
    scope: null,
    fields: [],
    money: [],
    dates: []
  }
  const words: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (i === 0 && t.startsWith('@') && scopes['@']) {
      out.scopeKey = '@'
      out.scope = scopes['@']
      if (t.length > 1) words.push(t.slice(1))
      continue
    }
    const colon = t.indexOf(':')
    if (colon > 0 && !out.scope) {
      const key = t.slice(0, colon).toLowerCase()
      if (scopes[key] && key !== '@') {
        out.scopeKey = key
        out.scope = scopes[key]
        const rest = t.slice(colon + 1)
        if (rest) words.push(rest)
        continue
      }
    }
    const date = parseDateAt(tokens, i, now)
    if (date) {
      out.dates.push({
        raw: tokens.slice(i, i + date.used).join(' '),
        start: date.start,
        end: date.end
      })
      i += date.used - 1
      continue
    }
    const money = parseMoney(t)
    if (money) {
      out.money.push(money)
      continue
    }
    const f = FIELD_TOKEN_RE.exec(t)
    if (f && !/^\/\//.test(f[2])) {
      const cm = /^(>=|<=|>|<|=)?(.*)$/.exec(f[2]) as RegExpExecArray
      if (cm[2]) {
        out.fields.push({ raw: t, key: f[1], cmp: cm[1] ?? '', value: cm[2] })
        continue
      }
    }
    words.push(t)
  }
  out.text = words.join(' ').trim()
  return out
}

// ─── Resolution against one collection ────────────────────────────────────────

export const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const T_TEXT = new Set(['string', 'text', 'uuid', 'char', 'varchar', 'nvarchar'])
const T_NUM = new Set(['integer', 'biginteger', 'float', 'decimal', 'number', 'int', 'bigint'])
const T_MONEY = new Set(['decimal', 'float', 'number'])
const T_DATE = new Set(['date', 'datetime', 'timestamp', 'datetime2', 'datetimeoffset'])
const T_BOOL = new Set(['boolean', 'bool', 'bit'])

const kind = (type: string) => {
  const t = type.toLowerCase()
  if (T_DATE.has(t)) return 'date'
  if (T_NUM.has(t)) return 'number'
  if (T_BOOL.has(t)) return 'bool'
  if (T_TEXT.has(t)) return 'text'
  return 'other'
}

/** The field a `key:` names: its key (any case), else its label slug. */
export function findField(fields: FieldMeta[], key: string): FieldMeta | null {
  const k = key.toLowerCase()
  const slug = slugOf(key)
  return (
    fields.find((f) => f.field.toLowerCase() === k) ??
    fields.find((f) => f.label && slugOf(f.label) === slug) ??
    fields.find((f) => slugOf(f.field) === slug) ??
    null
  )
}

const MONEY_NAME = /(amount|total|cost|price|value|budget|spend|sum)/i
const CREATED_NAME = /^(date_created|created_at|created_on|created|date)$/i

/** The one money field an amount means, or null when there is none or it is ambiguous. */
export function moneyFieldOf(fields: FieldMeta[]): FieldMeta | null {
  const nums = fields.filter((f) => T_MONEY.has(f.type.toLowerCase()))
  const named = nums.filter((f) => MONEY_NAME.test(f.field))
  if (named.length === 1) return named[0]
  if (named.length > 1) {
    // "amount"/"total" beat "unit_price" — the column people mean by "the amount".
    const exact = named.filter((f) => /^(amount|total|total_amount|amount_total)$/i.test(f.field))
    return exact.length === 1 ? exact[0] : null
  }
  return nums.length === 1 ? nums[0] : null
}

/** The one date field a bare date phrase means: the created date, else the only date. */
export function dateFieldOf(fields: FieldMeta[]): FieldMeta | null {
  const dates = fields.filter((f) => kind(f.type) === 'date')
  const created = dates.filter((f) => CREATED_NAME.test(f.field))
  if (created.length >= 1) return created[0]
  return dates.length === 1 ? dates[0] : null
}

const labelOf = (f: FieldMeta) => (f.label && String(f.label).trim()) || f.field

export interface Resolution {
  chips: FilterChip[]
  /** Items-service filter clauses (AND-ed). */
  clauses: Array<Record<string, unknown>>
  /** Raw tokens that did not resolve on this collection (they go back to text). */
  unresolved: string[]
}

const fmt = (n: number) => String(Math.round(n * 100) / 100)

function dateClauses(f: FieldMeta, r: { start: string; end: string }, cmp: string): Resolution {
  const label = labelOf(f)
  const last = ymdMinusOne(r.end)
  if (cmp === '>' || cmp === '>=')
    return {
      chips: [{ field: f.field, label, op: 'gte', value: r.start }],
      clauses: [{ [f.field]: { _gte: r.start } }],
      unresolved: []
    }
  if (cmp === '<' || cmp === '<=')
    return {
      chips: [{ field: f.field, label, op: 'lte', value: last }],
      clauses: [{ [f.field]: { _lt: r.end } }],
      unresolved: []
    }
  return {
    chips: [
      { field: f.field, label, op: 'gte', value: r.start },
      { field: f.field, label, op: 'lte', value: last }
    ],
    clauses: [{ [f.field]: { _gte: r.start } }, { [f.field]: { _lt: r.end } }],
    unresolved: []
  }
}

function ymdMinusOne(d: string): string {
  const t = new Date(`${d}T00:00:00Z`).getTime() - 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

function moneyClauses(f: FieldMeta, m: MoneyToken): Resolution {
  const label = labelOf(f)
  const chips: FilterChip[] = []
  const clauses: Array<Record<string, unknown>> = []
  if (m.min === m.max) {
    chips.push({ field: f.field, label, op: 'eq', value: fmt(m.min) })
    clauses.push({ [f.field]: { _eq: m.min } })
    return { chips, clauses, unresolved: [] }
  }
  if (Number.isFinite(m.min)) {
    chips.push({ field: f.field, label, op: 'gte', value: fmt(m.min) })
    clauses.push({ [f.field]: { _gte: m.min } })
  }
  if (Number.isFinite(m.max)) {
    chips.push({ field: f.field, label, op: 'lte', value: fmt(m.max) })
    clauses.push({ [f.field]: { _lte: m.max } })
  }
  return { chips, clauses, unresolved: [] }
}

/** One `key:value` against one field, or null when the value does not fit the field. */
export function fieldTokenClauses(f: FieldMeta, t: FieldToken, now: Date): Resolution | null {
  const label = labelOf(f)
  const k = kind(f.type)
  if (k === 'date') {
    const r = parseDateValue(t.value, now)
    return r ? dateClauses(f, r, t.cmp) : null
  }
  if (k === 'number') {
    const n = parseNumber(t.value)
    if (n == null) return null
    if (t.cmp === '>' || t.cmp === '>=')
      return {
        chips: [{ field: f.field, label, op: 'gte', value: fmt(n) }],
        clauses: [{ [f.field]: { [t.cmp === '>' ? '_gt' : '_gte']: n } }],
        unresolved: []
      }
    if (t.cmp === '<' || t.cmp === '<=')
      return {
        chips: [{ field: f.field, label, op: 'lte', value: fmt(n) }],
        clauses: [{ [f.field]: { [t.cmp === '<' ? '_lt' : '_lte']: n } }],
        unresolved: []
      }
    return {
      chips: [{ field: f.field, label, op: 'eq', value: fmt(n) }],
      clauses: [{ [f.field]: { _eq: n } }],
      unresolved: []
    }
  }
  if (k === 'bool') {
    const v = t.value.toLowerCase()
    const b = ['true', 'yes', 'y', '1', 'on'].includes(v)
      ? true
      : ['false', 'no', 'n', '0', 'off'].includes(v)
        ? false
        : null
    if (b == null) return null
    return {
      chips: [{ field: f.field, label, op: 'eq', value: String(b) }],
      clauses: [{ [f.field]: { _eq: b } }],
      unresolved: []
    }
  }
  if (t.cmp && t.cmp !== '=') return null
  if (k === 'text' && t.cmp !== '=' && f.type.toLowerCase() !== 'uuid') {
    return {
      chips: [{ field: f.field, label, op: 'contains', value: t.value }],
      clauses: [{ [f.field]: { _contains: t.value } }],
      unresolved: []
    }
  }
  return {
    chips: [{ field: f.field, label, op: 'eq', value: t.value }],
    clauses: [{ [f.field]: { _eq: t.value } }],
    unresolved: []
  }
}

/**
 * Field tokens, amounts and dates against one collection's READABLE fields.
 * `bare` = also place bare amounts/dates (only when the search is scoped to this
 * collection: unscoped, "$12,500" means nothing in particular).
 */
export function resolveQueryFilters(
  parsed: Pick<ParsedQuery, 'fields' | 'money' | 'dates'>,
  fields: FieldMeta[],
  opts: { bare: boolean; now?: Date }
): Resolution {
  const now = opts.now ?? new Date()
  const out: Resolution = { chips: [], clauses: [], unresolved: [] }
  const add = (r: Resolution) => {
    out.chips.push(...r.chips)
    out.clauses.push(...r.clauses)
  }
  for (const t of parsed.fields) {
    const f = findField(fields, t.key)
    const r = f ? fieldTokenClauses(f, t, now) : null
    if (r) add(r)
    else out.unresolved.push(t.raw)
  }
  const money = opts.bare ? moneyFieldOf(fields) : null
  for (const m of parsed.money) {
    if (money) add(moneyClauses(money, m))
    else out.unresolved.push(m.raw)
  }
  const date = opts.bare ? dateFieldOf(fields) : null
  for (const d of parsed.dates) {
    if (date) add(dateClauses(date, d, ''))
    else out.unresolved.push(d.raw)
  }
  return out
}

/** Is there anything to filter by at all? */
export const hasFilterTokens = (p: Pick<ParsedQuery, 'fields' | 'money' | 'dates'>) =>
  p.fields.length + p.money.length + p.dates.length > 0

const joinText = (...parts: Array<string | string[]>) =>
  parts
    .flat()
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')

export interface FilterPlan {
  /** The words still searched as text (unresolved tokens rejoin them). */
  text: string
  chips: FilterChip[]
  /** collection → AND-ed clauses; null = no filtering (search as usual). A
   *  collection missing from a non-null map is out of this search. */
  targets: Map<string, Array<Record<string, unknown>>> | null
}

/**
 * The filters of one search across the candidate collections (`metas`: each
 * collection's READABLE fields). Scoped: everything resolves against the scope,
 * bare amounts and dates included. Unscoped: a `field:value` applies in every
 * collection that has that field (all such tokens at once), collections without
 * it drop out; bare amounts/dates are ambiguous there and stay text, as does a
 * token no collection understands.
 */
export function planFilters(
  parsed: Pick<ParsedQuery, 'text' | 'fields' | 'money' | 'dates'>,
  metas: Map<string, FieldMeta[]>,
  opts: { scope: string | null; now?: Date }
): FilterPlan {
  if (!hasFilterTokens(parsed)) return { text: parsed.text, chips: [], targets: null }
  const now = opts.now ?? new Date()
  if (opts.scope) {
    const r = resolveQueryFilters(parsed, metas.get(opts.scope) ?? [], { bare: true, now })
    return {
      text: joinText(parsed.text, r.unresolved),
      chips: r.chips,
      targets: r.clauses.length ? new Map([[opts.scope, r.clauses]]) : null
    }
  }
  const per = new Map<string, Resolution>()
  const resolvedSomewhere = new Set<number>()
  for (const [collection, fields] of metas) {
    const r = resolveQueryFilters({ fields: parsed.fields, money: [], dates: [] }, fields, {
      bare: false,
      now
    })
    per.set(collection, r)
    parsed.fields.forEach((t, i) => {
      if (!r.unresolved.includes(t.raw)) resolvedSomewhere.add(i)
    })
  }
  const nowhere = parsed.fields.filter((_, i) => !resolvedSomewhere.has(i)).map((t) => t.raw)
  const text = joinText(
    parsed.text,
    nowhere,
    parsed.money.map((m) => m.raw),
    parsed.dates.map((d) => d.raw)
  )
  if (resolvedSomewhere.size === 0) return { text, chips: [], targets: null }
  const needed = parsed.fields.filter((_, i) => resolvedSomewhere.has(i)).map((t) => t.raw)
  const targets = new Map<string, Array<Record<string, unknown>>>()
  const chips: FilterChip[] = []
  const seen = new Set<string>()
  for (const [collection, r] of per) {
    if (needed.some((raw) => r.unresolved.includes(raw))) continue
    targets.set(collection, r.clauses)
    for (const c of r.chips) {
      const k = `${c.field}\u0000${c.op}\u0000${c.value}`
      if (!seen.has(k)) {
        seen.add(k)
        chips.push(c)
      }
    }
  }
  return { text, chips, targets }
}
