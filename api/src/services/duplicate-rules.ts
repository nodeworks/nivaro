/**
 * Duplicate warnings — the criteria (Rob 2026-11-14). Pure: the setting, the plan (which
 * rules run on this table and why some are skipped), the SQL predicates and the JS
 * verdicts. IO lives in services/duplicate-check.ts.
 *
 * `nivaro_collections.browser_config.duplicate_check`:
 *
 *   { mode?: 'on' | 'off',            missing = ON (every registered non-system collection)
 *     fields?: string[],              legacy: text fields, each checked on its own
 *     rules?: DuplicateRule[],        custom criteria, combined with AND (wins over fields)
 *     within_days?: number,           only records created in the last N days
 *     ignore_states?: string[],       pipeline state keys whose records never count
 *     block_exact?: boolean }         refuse a create that copies a record exactly
 *
 * Without `rules` the default criteria apply: every text field of the display template
 * (or the legacy `fields`) is its own check — exact, folded (case/spacing/punctuation) and
 * a typo pass — exactly what the 2026-11-13 version did.
 *
 * Big tables (more than CLOSE_ROW_LIMIT rows) never scan: a set of rules runs only when
 * one of them can seek an index (exact text, numbers, dates and links on an indexed
 * column; shared line values on an indexed line column). The others then filter only the
 * records that one finds. Folded/typo passes and Contains never drive a big table.
 */
import { type AccessClause, onIdExpr } from './search-access.js'
import { escapeLike } from './search-extra.js'
import { BINARY_COLLATION, fastLike, type TextKind, typedEquals } from './search-like.js'

/** The folded and typo passes scan; above this, rules need an index to run. */
export const CLOSE_ROW_LIMIT = 50_000
/** Text shorter than this (after trimming) is not looked up. */
export const MIN_VALUE_LENGTH = 2
/** Text longer than this is not a label. */
export const MAX_VALUE_LENGTH = 200
/** Line values compared at most. */
export const MAX_LINE_VALUES = 50
/** Rules in one custom set. */
export const MAX_RULES = 8

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
export const SYSTEM_COLLECTION = /^(nivaro_|directus_)/i
const NEVER = /password|token|secret|totp/i
const PLAIN_ASCII = /^[\x20-\x7e]*$/
const DAY = /^\d{4}-\d{2}-\d{2}/

// ─── Setting ────────────────────────────────────────────────────────────────

export type RuleMatch =
  | 'exact'
  | 'close'
  | 'contains'
  | 'equal'
  | 'percent'
  | 'within'
  | 'same_day'
  | 'days'
  | 'same'
  | 'shared'

export type RuleKind = 'text' | 'number' | 'date' | 'relation' | 'lines'

export const RULE_KIND: Record<RuleMatch, RuleKind> = {
  exact: 'text',
  close: 'text',
  contains: 'text',
  equal: 'number',
  percent: 'number',
  within: 'number',
  same_day: 'date',
  days: 'date',
  same: 'relation',
  shared: 'lines'
}

export interface DuplicateRule {
  field: string
  match: RuleMatch
  /** percent: ±X %; within: ±X; days: N days; shared: at least N shared values. */
  amount?: number
  /** shared: the line collection's field compared (e.g. the catalog item). */
  line_field?: string
}

export interface DuplicateCheckSetting {
  mode: 'on' | 'off'
  /** Legacy text fields (each its own check); null = the display template's. */
  fields: string[] | null
  /** Custom criteria (AND); null = the default criteria. */
  rules: DuplicateRule[] | null
  within_days: number | null
  ignore_states: string[] | null
  block_exact: boolean
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** One stored rule, or null when it cannot be read. Amounts are clamped to sane ranges. */
export function normalizeRule(raw: unknown): DuplicateRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const field = String(r.field ?? '').trim()
  const match = String(r.match ?? '') as RuleMatch
  if (!IDENT.test(field) || !(match in RULE_KIND)) return null
  const out: DuplicateRule = { field, match }
  const amount = num(r.amount)
  if (match === 'percent') out.amount = Math.min(100, Math.max(0, amount ?? 5))
  else if (match === 'within') out.amount = Math.max(0, amount ?? 0)
  else if (match === 'days') out.amount = Math.min(3650, Math.max(0, Math.round(amount ?? 1)))
  else if (match === 'shared') {
    const lf = String(r.line_field ?? '').trim()
    if (!IDENT.test(lf)) return null
    out.line_field = lf
    out.amount = Math.min(MAX_LINE_VALUES, Math.max(1, Math.round(amount ?? 1)))
  }
  return out
}

/** `browser_config.duplicate_check` (JSON text or an object). Anything malformed reads as
 *  the default: ON with the default criteria. */
export function parseDuplicateCheck(browserConfig: unknown): DuplicateCheckSetting {
  let bc: unknown = browserConfig
  if (typeof bc === 'string') {
    try {
      bc = JSON.parse(bc)
    } catch {
      bc = null
    }
  }
  const raw =
    bc && typeof bc === 'object' ? (bc as { duplicate_check?: unknown }).duplicate_check : null
  const none: DuplicateCheckSetting = {
    mode: 'on',
    fields: null,
    rules: null,
    within_days: null,
    ignore_states: null,
    block_exact: false
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return none
  const r = raw as Record<string, unknown>
  const fields = Array.isArray(r.fields)
    ? [...new Set(r.fields.map((f) => String(f ?? '').trim()).filter((f) => IDENT.test(f)))]
    : []
  const rules = Array.isArray(r.rules)
    ? (r.rules.map(normalizeRule).filter(Boolean) as DuplicateRule[]).slice(0, MAX_RULES)
    : []
  const days = num(r.within_days)
  const states = Array.isArray(r.ignore_states)
    ? [
        ...new Set(
          r.ignore_states
            .map((s) => String(s ?? '').trim())
            .filter((s) => s.length > 0 && s.length <= 100)
        )
      ]
    : []
  return {
    mode: r.mode === 'off' ? 'off' : 'on',
    fields: fields.length ? fields : null,
    rules: rules.length ? rules : null,
    within_days: days != null && days >= 1 ? Math.min(3650, Math.round(days)) : null,
    ignore_states: states.length ? states : null,
    block_exact: r.block_exact === true
  }
}

export function templateFields(template: string | null | undefined): string[] {
  const out: string[] = []
  for (const m of String(template ?? '').matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g))
    if (!out.includes(m[1])) out.push(m[1])
  return out
}

// ─── Plan ──────────────────────────────────────────────────────────────────

export interface PlanField {
  field: string
  type?: string | null
  special?: string | null
  computed_type?: string | null
  options?: Record<string, unknown> | null
  name?: string | null
}

export interface PlanRelation {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

/** The table's columns (name → SQL type) and the columns that lead an index. */
export interface ColumnFacts {
  columns: Map<string, string>
  leading: Set<string>
}

export interface PlanInput {
  collection: string
  setting: DuplicateCheckSetting
  template: string | null | undefined
  fields: PlanField[]
  relations: PlanRelation[]
  rows: number | null
  kinds: Record<string, TextKind>
  /** Null when unknown (no SQL Server, unit tests): nothing is treated as indexed. */
  columns: ColumnFacts | null
  /** Facts of a line collection (shared-lines rules). */
  child?: (collection: string) => { rows: number | null; columns: ColumnFacts | null } | undefined
}

export type RuleStatus = 'ok' | 'limited' | 'residual' | 'skipped'

export interface PlannedRule extends DuplicateRule {
  kind: RuleKind
  status: RuleStatus
  /** Plain words for the settings card (why limited / residual / skipped). */
  note?: string
  /** The column leads an index. */
  indexed: boolean
  /** Folded comparison allowed (small table, or filtering what another rule found). */
  near: boolean
  /** shared: the line collection and its link back to this record. */
  child?: string
  fk?: string
}

export interface PlannedGroup {
  /** The field the notice shows under (the first rule's). */
  anchor: string
  rules: PlannedRule[]
  /** At least one rule runs. */
  runs: boolean
  /** A rule of this set was skipped: matches are never called exact. */
  trimmed: boolean
  note?: string
}

export interface DuplicatePlan {
  enabled: boolean
  source: 'default' | 'configured' | 'off'
  reason?: string
  rows: number | null
  /** More than CLOSE_ROW_LIMIT rows (or unknown): rules need an index. */
  big: boolean
  /** The near-match passes (folded + typo) run for text rules. */
  close: boolean
  groups: PlannedGroup[]
  /** Rules that cannot apply to this collection (missing field, wrong kind). */
  invalid: Array<{ rule: DuplicateRule; note: string }>
  within_days: number | null
  created_field: string | null
  within_note?: string
  ignore_states: string[]
  block_exact: boolean
}

const NUMBER_SQL = new Set([
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'decimal',
  'numeric',
  'float',
  'real',
  'money',
  'smallmoney'
])
const DATE_SQL = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'])
const NUMBER_TYPES = new Set(['integer', 'bigInteger', 'float', 'decimal'])
const DATE_TYPES = new Set(['date', 'dateTime', 'timestamp'])

export const titleOf = (f: string, meta?: PlanField) =>
  String(meta?.name ?? '').trim() ||
  f
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bId\b/g, 'ID')

const isGenerated = (f: PlanField | undefined) =>
  !!f &&
  (!!f.computed_type ||
    !!(f.options && typeof f.options === 'object' && 'auto_id' in f.options && f.options.auto_id))

export interface FieldKindInfo {
  kind: RuleKind | null
  child?: string
  fk?: string
}

/** What kind of comparison a field supports here. */
export function fieldKindOf(
  input: Pick<PlanInput, 'collection' | 'relations' | 'kinds' | 'columns' | 'fields'>,
  field: string
): FieldKindInfo {
  if (!IDENT.test(field) || NEVER.test(field)) return { kind: null }
  const o2m = input.relations.find(
    (r) => r.one_collection === input.collection && r.one_field === field && !r.junction_field
  )
  if (o2m && IDENT.test(o2m.many_collection) && IDENT.test(o2m.many_field))
    return { kind: 'lines', child: o2m.many_collection, fk: o2m.many_field }
  const m2o = input.relations.find(
    (r) => r.many_collection === input.collection && r.many_field === field && r.one_collection
  )
  const sqlType = input.columns?.columns.get(field)
  const meta = input.fields.find((f) => f.field === field)
  // A field with no column (alias, computed) never compares in SQL.
  if (input.columns && sqlType == null) return { kind: null }
  if (!input.columns && (!meta || meta.type === 'alias')) return { kind: null }
  if (m2o) return { kind: 'relation' }
  if (field === 'id') return { kind: null }
  if (input.kinds[field] === 'unicode' || input.kinds[field] === 'ansi') return { kind: 'text' }
  if (sqlType ? NUMBER_SQL.has(sqlType) : NUMBER_TYPES.has(String(meta?.type)))
    return { kind: 'number' }
  if (sqlType ? DATE_SQL.has(sqlType) : DATE_TYPES.has(String(meta?.type))) return { kind: 'date' }
  return { kind: null }
}

/** The created-date column (`special` date-created, else a conventional name). */
export function createdFieldOf(
  input: Pick<PlanInput, 'collection' | 'relations' | 'kinds' | 'columns' | 'fields'>
): string | null {
  const isDate = (f: string) => fieldKindOf(input, f).kind === 'date'
  const special = input.fields.find(
    (f) => String(f.special ?? '').includes('date-created') && isDate(f.field)
  )
  if (special) return special.field
  for (const f of ['date_created', 'created_at', 'created_on', 'date_added', 'created'])
    if (isDate(f)) return f
  return null
}

/** The settings and the table facts → which rules run, and why the others do not. */
export function planDuplicateCheck(input: PlanInput): DuplicatePlan {
  const { setting, rows } = input
  const big = rows == null || rows > CLOSE_ROW_LIMIT
  const meta = new Map(input.fields.map((f) => [f.field, f]))
  const label = (f: string) => titleOf(f, meta.get(f))
  const base: DuplicatePlan = {
    enabled: false,
    source: 'off',
    rows,
    big,
    close: !big,
    groups: [],
    invalid: [],
    within_days: setting.within_days,
    created_field: null,
    ignore_states: setting.ignore_states ?? [],
    block_exact: setting.block_exact
  }
  if (SYSTEM_COLLECTION.test(input.collection))
    return { ...base, reason: 'System tables are never checked' }
  if (setting.mode === 'off') return { ...base, reason: 'Turned off for this collection' }

  const custom = !!setting.rules?.length
  const source: DuplicatePlan['source'] = custom || setting.fields ? 'configured' : 'default'
  const invalid: DuplicatePlan['invalid'] = []
  let sets: DuplicateRule[][]
  if (custom) {
    const ok: DuplicateRule[] = []
    for (const r of setting.rules ?? []) {
      const info = fieldKindOf(input, r.field)
      if (info.kind == null) {
        invalid.push({ rule: r, note: `${label(r.field)} cannot be compared` })
        continue
      }
      if (info.kind !== RULE_KIND[r.match]) {
        invalid.push({ rule: r, note: `${label(r.field)} is not a ${RULE_KIND[r.match]} field` })
        continue
      }
      ok.push(r)
    }
    sets = ok.length ? [ok] : []
  } else {
    // Default criteria: each text field of the label (or the legacy list) on its own.
    const from = setting.fields ?? templateFields(input.template)
    sets = from
      .filter(
        (f) =>
          fieldKindOf(input, f).kind === 'text' &&
          (setting.fields != null || !isGenerated(meta.get(f)))
      )
      .map((f) => [{ field: f, match: 'close' as const }])
  }

  const groups = sets.map((set) => planGroup(input, set, big, label))
  const created = setting.within_days ? createdFieldOf(input) : null
  const plan: DuplicatePlan = {
    ...base,
    source,
    groups,
    invalid,
    created_field: created,
    ...(setting.within_days && !created
      ? { within_note: 'No created-date field — the time limit is not applied' }
      : {}),
    enabled: groups.some((g) => g.runs)
  }
  if (!plan.enabled)
    plan.reason = groups.length
      ? 'Every rule is skipped on this table'
      : custom
        ? 'None of the rules can be compared here'
        : 'The label has no text field to compare — add rules'
  return plan
}

function planGroup(
  input: PlanInput,
  set: DuplicateRule[],
  big: boolean,
  label: (f: string) => string
): PlannedGroup {
  const indexed = (f: string) => !!input.columns?.leading.has(f)
  const planned: PlannedRule[] = set.map((r) => {
    const info = fieldKindOf(input, r.field)
    const kind = RULE_KIND[r.match]
    const p: PlannedRule = {
      ...r,
      kind,
      status: 'ok',
      indexed: indexed(r.field),
      near: !big,
      ...(info.child ? { child: info.child, fk: info.fk } : {})
    }
    if (kind === 'lines' && r.line_field) {
      const facts = info.child ? input.child?.(info.child) : undefined
      const lineCol = facts?.columns?.columns.get(r.line_field)
      if (facts?.columns && lineCol == null) {
        p.status = 'skipped'
        p.note = `The lines have no ${titleOf(r.line_field)} column`
        return p
      }
      const childBig = facts?.rows == null || facts.rows > CLOSE_ROW_LIMIT
      p.indexed = !!facts?.columns?.leading.has(r.line_field)
      if (childBig && !p.indexed) {
        p.status = 'skipped'
        p.note = `No index on ${titleOf(r.line_field)} in the lines — skipped`
      }
    }
    return p
  })
  if (!big) return finishGroup(planned)
  // Big table: a rule that seeks an index drives; the rest filter what it finds.
  const seeks = (p: PlannedRule) =>
    p.status !== 'skipped' &&
    (p.kind === 'lines' || (p.indexed && (p.kind !== 'text' || p.match !== 'contains')))
  const driver = planned.some(seeks)
  for (const p of planned) {
    if (p.status === 'skipped') continue
    if (seeks(p)) {
      if (p.kind === 'text' && p.match === 'close') {
        p.status = 'limited'
        p.note = 'Exact match only — near matches are skipped above 50,000 records'
      }
      continue
    }
    if (driver) {
      p.status = 'residual'
      p.near = true
      p.note = p.indexed
        ? 'Checked among the records the other rules find'
        : `No index on ${label(p.field)} — checked only among the records the other rules find`
      continue
    }
    p.status = 'skipped'
    p.note =
      p.kind === 'text' && p.match === 'contains'
        ? 'Contains is skipped on tables over 50,000 records'
        : p.kind === 'text'
          ? `No index on ${label(p.field)} — exact match skipped`
          : `No index on ${label(p.field)} — skipped`
  }
  return finishGroup(planned)
}

function finishGroup(planned: PlannedRule[]): PlannedGroup {
  const live = planned.filter((p) => p.status !== 'skipped')
  // A set whose only live rules filter (never seek) cannot run either.
  const runs = live.length > 0 && live.some((p) => p.status !== 'residual')
  const anchor = (planned.find((p) => p.kind !== 'lines') ?? planned[0]).field
  return {
    anchor,
    rules: planned,
    runs,
    trimmed: runs && live.length < planned.length,
    ...(!runs ? { note: 'Skipped on this table' } : {})
  }
}

/** The rules that run in a set. */
export const liveRules = (g: PlannedGroup) => g.rules.filter((r) => r.status !== 'skipped')

/** A set can refuse exact copies: it runs and has no lines rule. */
export const blockable = (g: PlannedGroup) =>
  g.runs && !g.trimmed && !g.rules.some((r) => r.kind === 'lines')

// ─── Values ────────────────────────────────────────────────────────────────

export function textValue(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s.length >= MIN_VALUE_LENGTH && s.length <= MAX_VALUE_LENGTH ? s : null
}

export const numberValue = (v: unknown): number | null =>
  typeof v === 'boolean' || v == null || typeof v === 'object' ? null : num(v)

/** 'YYYY-MM-DD' of a date value (string as entered, or a Date in UTC). */
export function dayValue(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  if (typeof v !== 'string') return null
  const s = v.trim()
  return DAY.test(s) ? s.slice(0, 10) : null
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000)

/** A link's id (a scalar, or an object carrying `id`). */
export function idValue(v: unknown): string | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return idValue((v as { id?: unknown }).id)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.trim() && v.length <= 64) return v.trim()
  return null
}

/** The distinct line values (ids or scalars), at most MAX_LINE_VALUES. */
export function lineValues(v: unknown, lineField?: string): string[] {
  if (!Array.isArray(v)) return []
  const out = new Set<string>()
  for (const item of v) {
    const raw =
      item && typeof item === 'object' && !Array.isArray(item) && lineField
        ? (item as Record<string, unknown>)[lineField]
        : item
    const id = idValue(raw)
    if (id) out.add(id.toLowerCase())
    if (out.size >= MAX_LINE_VALUES) break
  }
  return [...out]
}

// ─── Matching (pure) ───────────────────────────────────────────────────────

/** Exact identity: case, outer spaces and repeated inner spaces ignored. */
export function exactKey(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Folded identity: accents, case, spaces and punctuation removed ("MX-480 " = "mx480"). */
export function foldKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

export type MatchKind = 'exact' | 'close'
export interface Verdict {
  match: MatchKind
  score: number
}

/**
 * How `existing` compares to the typed `draft`; null = not a likely duplicate.
 * - exact: same text ignoring case and spacing.
 * - close: same letters and digits ignoring punctuation/accents ("MX-480" vs "MX480"),
 *   one is the start of the other ("Acme Corp" vs "Acme Corporation"), or one or two
 *   typos in a longer value (edit similarity ≥ 0.85 on 6+ characters).
 */
export function classifyMatch(draft: string, existing: string): Verdict | null {
  if (!draft.trim() || !existing.trim()) return null
  if (exactKey(draft) === exactKey(existing)) return { match: 'exact', score: 1 }
  const a = foldKey(draft)
  const b = foldKey(existing)
  if (!a || !b) return null
  if (a === b) return { match: 'close', score: 0.95 }
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (short.length >= 4 && long.startsWith(short) && short.length / long.length >= 0.5)
    return {
      match: 'close',
      score: Math.round((0.6 + 0.3 * (short.length / long.length)) * 100) / 100
    }
  if (long.length >= 6) {
    const ratio = 1 - levenshtein(a, b) / long.length
    if (ratio >= 0.85) return { match: 'close', score: Math.round(ratio * 90) / 100 }
  }
  return null
}

/**
 * One rule's verdict for a stored value. 'neutral' = judged in SQL only (shared lines).
 * `exactOnly` (refusing copies) accepts only an exact verdict.
 */
export function verifyRule(
  rule: DuplicateRule,
  draft: unknown,
  stored: unknown,
  exactOnly = false
): Verdict | 'neutral' | null {
  const kind = RULE_KIND[rule.match]
  if (kind === 'lines') return exactOnly ? null : 'neutral'
  let v: Verdict | null = null
  if (kind === 'text') {
    const d = textValue(draft)
    if (d == null || stored == null || typeof stored === 'object') return null
    const s = String(stored)
    if (exactKey(d) === exactKey(s)) v = { match: 'exact', score: 1 }
    else if (exactOnly || rule.match === 'exact') v = null
    else if (rule.match === 'close') v = classifyMatch(d, s)
    else {
      const needle = foldKey(d)
      v = needle && foldKey(s).includes(needle) ? { match: 'close', score: 0.7 } : null
    }
  } else if (kind === 'number') {
    const d = numberValue(draft)
    const s = numberValue(stored)
    if (d == null || s == null) return null
    const diff = Math.abs(s - d)
    if (diff < 1e-9) v = { match: 'exact', score: 1 }
    else if (exactOnly || rule.match === 'equal') v = null
    else {
      const tol =
        rule.match === 'percent' ? (Math.abs(d) * (rule.amount ?? 0)) / 100 : (rule.amount ?? 0)
      v = diff <= tol + 1e-9 ? { match: 'close', score: tol ? 1 - (diff / tol) * 0.3 : 0.7 } : null
    }
  } else if (kind === 'date') {
    const d = dayValue(draft)
    const s = dayValue(stored)
    if (!d || !s) return null
    const diff = Math.abs(dayNumber(s) - dayNumber(d))
    if (diff === 0) v = { match: 'exact', score: 1 }
    else if (exactOnly || rule.match === 'same_day') v = null
    else v = diff <= (rule.amount ?? 0) ? { match: 'close', score: 0.8 } : null
  } else {
    const d = idValue(draft)
    const s = idValue(stored)
    v = d && s && d.toLowerCase() === s.toLowerCase() ? { match: 'exact', score: 1 } : null
  }
  return v
}

/** A whole set's verdict: every live rule holds; exact only when every one is exact. */
export function verifyGroup(
  group: PlannedGroup,
  draft: Record<string, unknown>,
  row: Record<string, unknown>,
  exactOnly = false
): Verdict | null {
  let exact = !group.trimmed
  let score = 1
  let judged = 0
  for (const r of liveRules(group)) {
    const v = verifyRule(r, draft[r.field], row[r.field], exactOnly)
    if (v == null) return null
    if (v === 'neutral') continue
    judged++
    if (v.match !== 'exact') exact = false
    score = Math.min(score, v.score)
  }
  if (judged === 0 && !exactOnly) return { match: 'close', score: 0.6 }
  if (!exact) {
    if (exactOnly) return null
    return { match: 'close', score: Math.min(score, 0.95) }
  }
  return { match: 'exact', score: 1 }
}

// ─── SQL (pure) ────────────────────────────────────────────────────────────

/** Characters the folded SQL pass removes (the JS foldKey removes these and more). */
const FOLD_CHARS = [' ', '-', '_', '.', ',', '/', '\\', '(', ')', "'", '"', '&', '+', '#', ':', ';']

/** `col` with FOLD_CHARS removed (nested REPLACE; tabs too). */
export function foldSqlExpr(colSql: string): string {
  let e = `REPLACE(${colSql}, CHAR(9), '')`
  for (const ch of FOLD_CHARS) e = `REPLACE(${e}, N'${ch === "'" ? "''" : ch}', '')`
  return e
}

/** The bound side of the folded pass: the same characters removed, upper-cased. */
export function sqlFoldValue(s: string): string {
  let out = s.replace(/\t/g, '')
  for (const ch of FOLD_CHARS) out = out.split(ch).join('')
  return out.toUpperCase()
}

export interface Stmt {
  sql: string
  bindings: unknown[]
}

export interface PredicateOpts {
  mssql: boolean
  kinds: Record<string, TextKind>
  /** Refusing copies: exact predicates only. */
  exactOnly?: boolean
  /** The caller's read gate per line collection (shared-lines rules); null = nothing
   *  restricts them there. A line collection missing here = the rule answers nothing. */
  childAccess?: ReadonlyMap<string, AccessClause | null>
}

/** The folded comparison (`col` and the value both folded). */
export function foldPredicate(colSql: string, value: string): Stmt | null {
  const folded = sqlFoldValue(value.trim())
  if (folded.length < MIN_VALUE_LENGTH) return null
  const expr = foldSqlExpr(colSql)
  return PLAIN_ASCII.test(folded)
    ? { sql: `UPPER(${expr}) COLLATE ${BINARY_COLLATION} = ?`, bindings: [folded] }
    : { sql: `${expr} = ?`, bindings: [folded] }
}

/** One rule as a predicate on `t`; null = the draft gives it nothing to compare. */
export function rulePredicate(rule: PlannedRule, draft: unknown, opts: PredicateOpts): Stmt | null {
  const col = `t.[${rule.field}]`
  const kind = opts.kinds[rule.field] ?? 'other'
  switch (rule.kind) {
    case 'text': {
      const v = textValue(draft)
      if (v == null) return null
      const eq = typedEquals(col, v, kind, { mssql: opts.mssql, indexed: rule.indexed })
      if (opts.exactOnly || rule.match === 'exact') return eq
      if (rule.match === 'contains')
        return fastLike(col, `%${escapeLike(v)}%`, kind, { escape: '\\', mssql: opts.mssql })
      if (!rule.near) return eq
      const fold = foldPredicate(col, v)
      return fold
        ? { sql: `(${eq.sql} OR ${fold.sql})`, bindings: [...eq.bindings, ...fold.bindings] }
        : eq
    }
    case 'number': {
      const n = numberValue(draft)
      if (n == null) return null
      if (opts.exactOnly || rule.match === 'equal') return { sql: `${col} = ?`, bindings: [n] }
      const tol =
        rule.match === 'percent' ? (Math.abs(n) * (rule.amount ?? 0)) / 100 : (rule.amount ?? 0)
      return { sql: `${col} BETWEEN ? AND ?`, bindings: [n - tol, n + tol] }
    }
    case 'date': {
      const d = dayValue(draft)
      if (!d) return null
      const n = opts.exactOnly || rule.match === 'same_day' ? 0 : (rule.amount ?? 0)
      return { sql: `${col} >= ? AND ${col} < ?`, bindings: [addDays(d, -n), addDays(d, n + 1)] }
    }
    case 'relation': {
      const id = idValue(draft)
      return id ? { sql: `${col} = ?`, bindings: [id] } : null
    }
    case 'lines': {
      if (opts.exactOnly || !rule.child || !rule.fk || !rule.line_field) return null
      const values = lineValues(draft, rule.line_field)
      const need = rule.amount ?? 1
      if (values.length < need) return null
      // Only lines the caller may read count (security review 2026-11-14): a match must
      // never tell them which records have lines they cannot see.
      if (!opts.childAccess?.has(rule.child)) return null
      const gate = onIdExpr(opts.childAccess.get(rule.child) ?? null, 'l.[id]')
      return {
        sql: `t.[id] IN (SELECT l.[${rule.fk}] FROM [${rule.child}] AS l WHERE l.[${rule.line_field}] IN (SELECT [value] FROM OPENJSON(?))${gate ? ` AND (${gate.sql})` : ''} GROUP BY l.[${rule.fk}] HAVING COUNT(DISTINCT l.[${rule.line_field}]) >= ?)`,
        bindings: [JSON.stringify(values), ...(gate?.bindings ?? []), need]
      }
    }
  }
  return null
}

export interface FilterOpts {
  collection: string
  within_days: number | null
  created_field: string | null
  ignore_states: string[]
  now?: Date
}

/** "Only records created in the last N days" and "ignore records in these states". */
export function filterPredicates(f: FilterOpts): Stmt[] {
  const out: Stmt[] = []
  if (f.within_days && f.created_field && IDENT.test(f.created_field)) {
    const since = new Date((f.now ?? new Date()).getTime() - f.within_days * 86_400_000)
    out.push({ sql: `t.[${f.created_field}] >= ?`, bindings: [since] })
  }
  if (f.ignore_states.length)
    out.push({
      sql: `NOT EXISTS (SELECT 1 FROM [nivaro_workflow_instances] AS wfi JOIN [nivaro_workflow_states] AS wfs ON wfs.[id] = wfi.[current_state] WHERE wfi.[collection] = ? AND wfi.[item] = CAST(t.[id] AS nvarchar(255)) AND wfs.[key] IN (SELECT [value] FROM OPENJSON(?)))`,
      bindings: [f.collection, JSON.stringify(f.ignore_states)]
    })
  return out
}

const joinAnd = (parts: Stmt[]): Stmt => ({
  sql: parts.map((p) => `(${p.sql})`).join(' AND '),
  bindings: parts.flatMap((p) => p.bindings)
})

/**
 * One set of rules as one candidate statement: every live rule, the filters and the
 * caller's read gate, AND-ed. Null when the draft leaves a rule without a value.
 * `skip` leaves one rule out (the typo pass compares that one itself).
 */
export function groupPredicate(
  group: PlannedGroup,
  draft: Record<string, unknown>,
  opts: PredicateOpts & { filters: Stmt[]; access: AccessClause | null; skip?: PlannedRule }
): Stmt | null {
  const parts: Stmt[] = []
  for (const r of liveRules(group)) {
    if (r === opts.skip) continue
    const p = rulePredicate(r, draft[r.field], opts)
    if (!p) return null
    parts.push(p)
  }
  parts.push(...opts.filters)
  const gate = onIdExpr(opts.access, 't.[id]')
  if (gate) parts.push(gate)
  return parts.length ? joinAnd(parts) : { sql: '1 = 1', bindings: [] }
}

export function groupStatement(
  collection: string,
  group: PlannedGroup,
  draft: Record<string, unknown>,
  opts: PredicateOpts & {
    filters: Stmt[]
    access: AccessClause | null
    top: number
    columns?: string[]
  }
): Stmt | null {
  const where = groupPredicate(group, draft, opts)
  if (!where) return null
  const extra = (opts.columns ?? [])
    .filter((c) => IDENT.test(c) && c !== 'id')
    .map((c) => `, t.[${c}]`)
    .join('')
  return {
    sql: `SELECT TOP ${opts.top} CAST(t.[id] AS nvarchar(64)) AS id${extra} FROM [${collection}] AS t WHERE ${where.sql}`,
    bindings: where.bindings
  }
}
