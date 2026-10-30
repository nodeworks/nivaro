// One quiet line above a list or a queue that says, in words, what the person
// is looking at: "Showing Purchase Orders you own, where Zone is East and
// Amount is over $10,000, matching “pump” — about 128 of 4,210."
//
// Pure: every host (the collection browser, the queue worklist) turns its OWN
// filter state into clauses, using the field labels and option labels it has
// already loaded — this module never fetches and never sees an id it cannot
// name (a host that has no label for a pick passes `count` instead).

/** Words for a comparison on a number column. */
export type CompareOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'

/** Words for a date column. `last_days` = rolling window ending today. */
export type DateOp =
  | 'on'
  | 'before'
  | 'after'
  | 'onbefore'
  | 'onafter'
  | 'between'
  | 'today'
  | 'last_days'
  | 'this_year'

export type FilterClause =
  /** A pick from a list ("Zone is East or West"). `count` names picks with no label yet. */
  | { kind: 'is'; field: string; values: string[]; count?: number; not?: boolean }
  /** Free text on a column. */
  | {
      kind: 'text'
      field: string
      text: string
      mode?: 'contains' | 'equals' | 'starts' | 'ends'
      not?: boolean
    }
  | {
      kind: 'compare'
      field: string
      op: CompareOp
      a: number
      b?: number
      currency?: boolean
      /** Suffix after each figure ("h", "d"). */
      unit?: string
    }
  | {
      kind: 'date'
      field: string
      op: DateOp
      from?: string
      to?: string
      days?: number
      not?: boolean
    }
  | { kind: 'empty'; field: string; empty: boolean }
  /** Already worded by the host ("being amended", "with open tasks", "past SLA"). */
  | { kind: 'phrase'; text: string }

export interface FilterSentenceInput {
  /** What the rows are, as the reader calls them ("Purchase Orders", "items"). */
  noun: string
  /** The scope tab, worded to follow the noun ("you own", "with no owners"). */
  scope?: string | null
  /** The saved view in use. */
  viewName?: string | null
  /** The quick-search text. */
  search?: string | null
  clauses: FilterClause[]
  /** Rows matching now (the list's total). */
  shown?: number | null
  /** Rows with no filters at all, when the host already knows it. */
  of?: number | null
  /** The count came from a short-lived cache: say "about". */
  approx?: boolean
}

const fmt = (n: number) => n.toLocaleString('en-US')

function money(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2
  })
}

/** "A", "A or B", "A, B or C", "A, B, C or 2 more". */
function listWords(values: string[], joiner = 'or', max = 3): string {
  const vals = values.filter((v) => v !== '')
  if (vals.length === 0) return ''
  if (vals.length === 1) return vals[0]
  if (vals.length <= max)
    return `${vals.slice(0, -1).join(', ')} ${joiner} ${vals[vals.length - 1]}`
  return `${vals.slice(0, max).join(', ')} ${joiner} ${vals.length - max} more`
}

/** A yyyy-mm-dd day as "Sep 19, 2026" (calendar day, never shifted by a timezone). */
function dayWords(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  if (!m) return day
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

/** One clause in words, or '' when it says nothing. */
export function clauseWords(c: FilterClause): string {
  switch (c.kind) {
    case 'phrase':
      return c.text.trim()
    case 'is': {
      const named = listWords(c.values)
      const n = c.count ?? c.values.length
      if (!named) {
        if (!n) return ''
        if (n === 1) return `${c.field} is ${c.not ? 'not ' : ''}the one picked`
        return `${c.field} is ${c.not ? 'none' : 'one'} of ${fmt(n)} picked`
      }
      return `${c.field} is ${c.not ? 'not ' : ''}${named}`
    }
    case 'text': {
      const t = c.text.trim()
      if (!t) return ''
      const q = `“${t}”`
      switch (c.mode ?? 'contains') {
        case 'equals':
          return `${c.field} is${c.not ? ' not' : ''} ${q}`
        case 'starts':
          return `${c.field} ${c.not ? 'does not start' : 'starts'} with ${q}`
        case 'ends':
          return `${c.field} ${c.not ? 'does not end' : 'ends'} with ${q}`
        default:
          return `${c.field} ${c.not ? 'does not contain' : 'contains'} ${q}`
      }
    }
    case 'compare': {
      const n = (x: number) => (c.currency ? money(x) : `${fmt(x)}${c.unit ?? ''}`)
      switch (c.op) {
        case 'eq':
          return `${c.field} is ${n(c.a)}`
        case 'neq':
          return `${c.field} is not ${n(c.a)}`
        case 'gt':
          return `${c.field} is over ${n(c.a)}`
        case 'gte':
          return `${c.field} is at least ${n(c.a)}`
        case 'lt':
          return `${c.field} is under ${n(c.a)}`
        case 'lte':
          return `${c.field} is at most ${n(c.a)}`
        case 'between':
          return `${c.field} is between ${n(c.a)} and ${n(c.b ?? c.a)}`
      }
      return ''
    }
    case 'date': {
      const neg = c.not ? 'not ' : ''
      switch (c.op) {
        case 'today':
          return `${c.field} is ${neg}today`
        case 'this_year':
          return `${c.field} is ${neg}this year`
        case 'last_days':
          return c.days ? `${c.field} is ${neg}in the last ${fmt(c.days)} days` : ''
        case 'on':
          return c.from ? `${c.field} is ${neg}${dayWords(c.from)}` : ''
        case 'before':
          return c.from ? `${c.field} is ${neg}before ${dayWords(c.from)}` : ''
        case 'after':
          return c.from ? `${c.field} is ${neg}after ${dayWords(c.from)}` : ''
        case 'onbefore':
          return c.from ? `${c.field} is ${neg}on or before ${dayWords(c.from)}` : ''
        case 'onafter':
          return c.from ? `${c.field} is ${neg}on or after ${dayWords(c.from)}` : ''
        case 'between':
          if (c.from && c.to && c.from !== c.to)
            return `${c.field} is ${neg}between ${dayWords(c.from)} and ${dayWords(c.to)}`
          if (c.from) return `${c.field} is ${neg}${dayWords(c.from)}`
          if (c.to) return `${c.field} is ${neg}on or before ${dayWords(c.to)}`
          return ''
      }
      return ''
    }
    case 'empty':
      return `${c.field} is ${c.empty ? 'empty' : 'not empty'}`
  }
}

/**
 * The whole line, or null when nothing narrows the list (no clause, no
 * search, no saved view, no scope) — an unfiltered list needs no sentence.
 */
export function filterSentence(input: FilterSentenceInput): string | null {
  const phrases: string[] = []
  const where: string[] = []
  for (const c of input.clauses) {
    const w = clauseWords(c)
    if (!w) continue
    if (c.kind === 'phrase') phrases.push(w)
    else where.push(w)
  }
  const scope = input.scope?.trim() || ''
  const view = input.viewName?.trim() || ''
  const search = input.search?.trim() || ''
  if (!scope && !view && !search && phrases.length === 0 && where.length === 0) return null

  const noun = input.noun.trim() || 'records'
  const segments: string[] = [`Showing ${noun}${scope ? ` ${scope}` : ''}`]
  if (view) segments.push(`in the “${view}” view`)
  segments.push(...phrases)
  if (where.length > 0) segments.push(`where ${listWords(where, 'and', Number.POSITIVE_INFINITY)}`)
  if (search) segments.push(`matching “${search}”`)
  // The first qualifier follows the noun directly ("Showing POs where …");
  // later ones are listed with commas.
  let text =
    segments.length > 1
      ? `${segments[0]} ${segments[1]}${segments.length > 2 ? `, ${segments.slice(2).join(', ')}` : ''}`
      : segments[0]

  const shown = input.shown
  if (typeof shown === 'number' && Number.isFinite(shown) && shown >= 0) {
    const about = input.approx ? 'about ' : ''
    const of = input.of
    text +=
      typeof of === 'number' && Number.isFinite(of) && of > shown
        ? ` — ${about}${fmt(shown)} of ${fmt(of)}`
        : ` — ${about}${fmt(shown)}`
  }
  return `${text}.`
}

// ─── Adapters: the two filter dialects the hosts already speak ───────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}/

/**
 * A `{path, op, value}` condition in the items route's dialect (`_eq`,
 * `_contains`, `_gt`, `_between` "a..b", `_null`, `_preset` for the browser's
 * rolling windows) → a clause. `valueLabels` names relation picks; `kind`
 * says what the column holds so numbers and dates read as such.
 */
export function clauseFromCondition(opts: {
  field: string
  op: string
  value: unknown
  valueLabels?: string[]
  kind?: 'number' | 'currency' | 'date' | 'boolean' | 'text'
  not?: boolean
}): FilterClause | null {
  const { field, valueLabels } = opts
  let op = opts.op
  let value = opts.value
  // Boolean ops carry their value: `_eq:true`.
  let boolOp = false
  if (op.includes(':')) {
    const [o, v] = op.split(':')
    op = o
    value = v
    boolOp = v === 'true' || v === 'false'
  }
  const not = !!opts.not
  if (op === '_null' || op === '_nnull') {
    const empty = (op === '_null') !== not
    return { kind: 'empty', field, empty }
  }
  if (Array.isArray(value)) {
    const labels = valueLabels?.length === value.length ? valueLabels : undefined
    const isNot = (op === '_nin') !== not
    return labels
      ? { kind: 'is', field, values: labels, not: isNot }
      : { kind: 'is', field, values: [], count: value.length, not: isNot }
  }
  if (opts.kind === 'boolean' || boolOp || value === true || value === false) {
    const on = String(value) === 'true'
    const yes = (op === '_neq') !== not ? !on : on
    return { kind: 'is', field, values: [yes ? 'yes' : 'no'] }
  }
  if (op === '_preset') {
    const p = String(value ?? '')
    if (p === 'today') return { kind: 'date', field, op: 'today', not }
    if (p === 'year') return { kind: 'date', field, op: 'this_year', not }
    const m = /^(\d+)d$/.exec(p)
    if (m) return { kind: 'date', field, op: 'last_days', days: Number(m[1]), not }
    return null
  }
  const raw = value == null ? '' : String(value)
  const isDate = opts.kind === 'date' || (DAY_RE.test(raw) && opts.kind !== 'text')
  const isNum = opts.kind === 'number' || opts.kind === 'currency'
  if (op === '_between') {
    const [a, b] = raw.split('..')
    if (isDate)
      return { kind: 'date', field, op: 'between', from: a || undefined, to: b || undefined, not }
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb) && a !== '' && b !== '')
      return {
        kind: 'compare',
        field,
        op: 'between',
        a: na,
        b: nb,
        currency: opts.kind === 'currency'
      }
    return null
  }
  if (isDate && DAY_RE.test(raw)) {
    const day = raw.slice(0, 10)
    const dateOp: Record<string, DateOp> = {
      _eq: 'on',
      _lt: 'before',
      _gt: 'after',
      _lte: 'onbefore',
      _gte: 'onafter'
    }
    const negDate: Record<string, DateOp> = {
      _eq: 'on',
      _lt: 'onafter',
      _gt: 'onbefore',
      _lte: 'after',
      _gte: 'before'
    }
    if (op === '_neq') return { kind: 'date', field, op: 'on', from: day, not: !not }
    const d = (not ? negDate : dateOp)[op]
    if (d) return { kind: 'date', field, op: d, from: day, not: not && op === '_eq' }
  }
  const cmp: Record<string, CompareOp> = {
    _eq: 'eq',
    _neq: 'neq',
    _gt: 'gt',
    _gte: 'gte',
    _lt: 'lt',
    _lte: 'lte'
  }
  const flip: Record<CompareOp, CompareOp> = {
    eq: 'neq',
    neq: 'eq',
    gt: 'lte',
    gte: 'lt',
    lt: 'gte',
    lte: 'gt',
    between: 'between'
  }
  const n = Number(raw)
  if (cmp[op] && raw !== '' && Number.isFinite(n) && (isNum || op !== '_eq')) {
    const c = cmp[op]
    return {
      kind: 'compare',
      field,
      op: not ? flip[c] : c,
      a: n,
      currency: opts.kind === 'currency'
    }
  }
  if (!raw) return null
  const label = valueLabels?.[0] ?? raw
  switch (op) {
    case '_eq':
      return valueLabels?.length
        ? { kind: 'is', field, values: [label], not }
        : { kind: 'text', field, text: raw, mode: 'equals', not }
    case '_neq':
      return { kind: 'text', field, text: raw, mode: 'equals', not: !not }
    case '_contains':
      return { kind: 'text', field, text: raw, not }
    case '_ncontains':
      return { kind: 'text', field, text: raw, not: !not }
    case '_starts_with':
      return { kind: 'text', field, text: raw, mode: 'starts', not }
    case '_ends_with':
      return { kind: 'text', field, text: raw, mode: 'ends', not }
  }
  return { kind: 'text', field, text: raw, mode: 'equals', not }
}

/**
 * A queue filter control's stored value (DataTable FilterDef encodings:
 * `num:gte:1000`, `onafter:2026-09-01`, `bool:true`, a string list, plain
 * text) → a clause. `optionLabel` names a stored option value for select /
 * combobox controls.
 */
export function clauseFromControlValue(opts: {
  field: string
  type?: 'select' | 'text' | 'range' | 'combobox' | 'date' | 'number'
  value: string | string[]
  optionLabel?: (value: string) => string | undefined
  currency?: boolean
  rangeUnit?: string
}): FilterClause | null {
  const { field, value, optionLabel } = opts
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    const labels = value.map((v) => optionLabel?.(v) ?? v)
    return { kind: 'is', field, values: labels }
  }
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (raw.startsWith('num:')) {
    const rest = raw.slice(4)
    const i = rest.indexOf(':')
    const op = rest.slice(0, i) as CompareOp
    const v = rest.slice(i + 1)
    if (op === 'between') {
      const [a, b] = v.split('..').map(Number)
      if (Number.isFinite(a) && Number.isFinite(b))
        return {
          kind: 'compare',
          field,
          op,
          a: Math.min(a, b),
          b: Math.max(a, b),
          currency: opts.currency
        }
      return null
    }
    const a = Number(v)
    if (i > 0 && Number.isFinite(a))
      return { kind: 'compare', field, op, a, currency: opts.currency }
    return null
  }
  const dm = /^(on|before|after|onbefore|onafter|between|r):(.+)$/.exec(raw)
  if (dm && (opts.type === 'date' || DAY_RE.test(dm[2]))) {
    const op = dm[1] === 'r' ? 'between' : (dm[1] as DateOp)
    if (op === 'between') {
      const [from, to] = dm[2].split('..')
      return { kind: 'date', field, op, from, to: to || from }
    }
    return { kind: 'date', field, op, from: dm[2] }
  }
  if (opts.type === 'range') {
    const [min, max] = raw.split(':')
    const a = Number(min)
    const b = Number(max)
    const unit = opts.rangeUnit || undefined
    if (min && max && Number.isFinite(a) && Number.isFinite(b))
      return { kind: 'compare', field, op: 'between', a, b, unit }
    if (min && Number.isFinite(a)) return { kind: 'compare', field, op: 'gte', a, unit }
    if (max && Number.isFinite(b)) return { kind: 'compare', field, op: 'lte', a: b, unit }
    return null
  }
  const label = optionLabel?.(raw)
  if (opts.type === 'select' || opts.type === 'combobox' || label) {
    return { kind: 'is', field, values: [label ?? raw.replace(/^bool:/, '')] }
  }
  return { kind: 'text', field, text: raw }
}
