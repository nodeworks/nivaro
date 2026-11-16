/**
 * Support auto-assign rules (2026-11-16) — the PURE half: the rule shape, its
 * validation, matching one rule against a request's facts, and choosing one
 * person from a list. ONE evaluator: the record form's "Try a request" box asks
 * the server (POST /support/assign-rules/test), it never re-implements this.
 *
 * Rules are an ordered list; the first active rule whose conditions match wins.
 * Stored as JSON in nivaro_extension_settings ('nivaro-core',
 * 'support_assign_rules') — no migration. Facts are gathered by
 * services/support-assign.ts (reading the record as the system, only to
 * evaluate; reasons never quote a record's values).
 */

export const MAX_RULES = 100
export const MAX_CONDITIONS = 20
export const MAX_PEOPLE = 50

// ── Shape ────────────────────────────────────────────────────────────────────

export type SetOp = 'in' | 'not_in'
export type FieldOp =
  | 'is'
  | 'is_not'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'empty'
  | 'not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'

export const SOURCES = ['general', 'record', 'error', 'report_problem'] as const
export type RequestSource = (typeof SOURCES)[number]

export type Condition =
  | { kind: 'type'; op: SetOp; values: number[] }
  /** record_in: about a record in one of `collections` (empty = any record); general: about none. */
  | { kind: 'about'; op: 'record_in' | 'general'; collections: string[] }
  | { kind: 'field'; collection: string; field: string; op: FieldOp; values: string[] }
  | { kind: 'step'; op: SetOp; states: string[] }
  | { kind: 'requester'; op: SetOp; users: string[] }
  | { kind: 'requester_role'; op: SetOp; roles: string[] }
  | { kind: 'requester_team'; op: SetOp; teams: number[] }
  | { kind: 'priority'; op: SetOp; values: string[] }
  | { kind: 'text'; op: 'any' | 'all' | 'none'; words: string[] }
  | { kind: 'source'; op: SetOp; values: RequestSource[] }
  | { kind: 'hours'; op: 'inside' | 'outside' }

export const STRATEGIES = [
  'fewest_open',
  'least_recent',
  'fewest_today',
  'fewest_week',
  'fewest_urgent',
  'most_closed_type',
  'last_helped',
  'step_owner',
  'random'
] as const
export type Strategy = (typeof STRATEGIES)[number]

export interface SharePerson {
  id: string
  /** Skip them while they hold this many open requests. null = no cap. */
  cap: number | null
  /** always | only inside business hours | only while online now */
  when: 'always' | 'business_hours' | 'online'
}

export type RuleAction =
  | { kind: 'person'; user: string }
  | { kind: 'share'; people: SharePerson[]; strategy: Strategy; give_to_cover: boolean }
  | { kind: 'step_owner'; pick: 'first' | 'fewest_open' }
  | { kind: 'team'; team: number }

export type RuleFallback = { kind: 'desk' } | { kind: 'person'; user: string }

export interface AssignRule {
  id: string
  name: string
  active: boolean
  match: 'all' | 'any'
  conditions: Condition[]
  action: RuleAction
  fallback: RuleFallback
  /** Also run when a request's type changes, even if someone already has it. */
  on_type_change: boolean
  note: string | null
}

export interface BusinessHours {
  /** 'HH:MM', Eastern wall clock. */
  start: string
  end: string
  /** 0 = Sunday … 6 = Saturday. */
  days: number[]
}

export interface AssignRuleSet {
  rules: AssignRule[]
  hours: BusinessHours
}

export const DEFAULT_HOURS: BusinessHours = { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] }
export const EMPTY_RULE_SET: AssignRuleSet = { rules: [], hours: DEFAULT_HOURS }

// ── Validation ───────────────────────────────────────────────────────────────

export interface RuleError {
  /** Rule index (0-based) or -1 for the set. */
  rule: number
  message: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const SET_OPS = ['in', 'not_in']
const FIELD_OPS: FieldOp[] = [
  'is',
  'is_not',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'empty',
  'not_empty',
  'gt',
  'gte',
  'lt',
  'lte'
]
const PRIORITIES = ['low', 'normal', 'urgent']

const strList = (v: unknown, max = 200): string[] | null =>
  Array.isArray(v) &&
  v.length <= max &&
  v.every((x) => typeof x === 'string' || typeof x === 'number')
    ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))]
    : null
const intList = (v: unknown): number[] | null => {
  const s = strList(v)
  if (!s) return null
  const n = s.map(Number)
  return n.every((x) => Number.isSafeInteger(x) && x > 0) ? n : null
}

function readCondition(raw: unknown): Condition | string {
  const c = (raw ?? {}) as Record<string, unknown>
  const op = String(c.op ?? '')
  switch (c.kind) {
    case 'type': {
      const values = intList(c.values)
      if (!SET_OPS.includes(op)) return 'Request type: pick "is one of" or "is not one of"'
      if (!values?.length) return 'Request type: pick at least one type'
      return { kind: 'type', op: op as SetOp, values }
    }
    case 'about': {
      if (op === 'general') return { kind: 'about', op: 'general', collections: [] }
      if (op !== 'record_in') return 'About: pick "a record in" or "General Support"'
      const collections = strList(c.collections) ?? []
      if (collections.some((n) => !NAME.test(n))) return 'About: a collection name is not valid'
      return { kind: 'about', op: 'record_in', collections }
    }
    case 'field': {
      const collection = String(c.collection ?? '')
      const field = String(c.field ?? '')
      if (!NAME.test(collection)) return 'Record field: pick the kind of record'
      if (!NAME.test(field)) return 'Record field: pick a field'
      if (!FIELD_OPS.includes(op as FieldOp)) return 'Record field: pick how to compare'
      const values = strList(c.values) ?? []
      if (op !== 'empty' && op !== 'not_empty' && !values.length)
        return 'Record field: give a value to compare with'
      if (['gt', 'gte', 'lt', 'lte'].includes(op) && values.length !== 1)
        return 'Record field: "greater/less than" compares with one value'
      return { kind: 'field', collection, field, op: op as FieldOp, values }
    }
    case 'step': {
      const states = strList(c.states) ?? []
      if (!SET_OPS.includes(op) || !states.length) return 'Step: pick at least one step'
      return { kind: 'step', op: op as SetOp, states }
    }
    case 'requester': {
      const users = (strList(c.users) ?? []).map((u) => u.toUpperCase())
      if (!SET_OPS.includes(op) || !users.length) return 'Requester: pick at least one person'
      if (users.some((u) => !UUID.test(u))) return 'Requester: a person is not valid'
      return { kind: 'requester', op: op as SetOp, users }
    }
    case 'requester_role': {
      const roles = strList(c.roles) ?? []
      if (!SET_OPS.includes(op) || !roles.length) return 'Requester’s role: pick at least one role'
      return { kind: 'requester_role', op: op as SetOp, roles }
    }
    case 'requester_team': {
      const teams = intList(c.teams)
      if (!SET_OPS.includes(op) || !teams?.length) return 'Requester’s team: pick at least one team'
      return { kind: 'requester_team', op: op as SetOp, teams }
    }
    case 'priority': {
      const values = strList(c.values) ?? []
      if (!SET_OPS.includes(op) || !values.length || values.some((v) => !PRIORITIES.includes(v)))
        return 'Priority: pick at least one priority'
      return { kind: 'priority', op: op as SetOp, values }
    }
    case 'text': {
      const words = (strList(c.words, 50) ?? []).map((w) => w.slice(0, 80))
      if (!['any', 'all', 'none'].includes(op)) return 'Words: pick any / all / none'
      if (!words.length) return 'Words: give at least one word'
      return { kind: 'text', op: op as 'any' | 'all' | 'none', words }
    }
    case 'source': {
      const values = strList(c.values) ?? []
      if (!SET_OPS.includes(op) || !values.length) return 'Raised from: pick at least one place'
      if (values.some((v) => !(SOURCES as readonly string[]).includes(v)))
        return 'Raised from: unknown place'
      return { kind: 'source', op: op as SetOp, values: values as RequestSource[] }
    }
    case 'hours':
      if (op !== 'inside' && op !== 'outside')
        return 'When raised: pick inside or outside business hours'
      return { kind: 'hours', op }
    default:
      return 'A condition has no kind'
  }
}

function readAction(raw: unknown): RuleAction | string {
  const a = (raw ?? {}) as Record<string, unknown>
  switch (a.kind) {
    case 'person': {
      const user = String(a.user ?? '').toUpperCase()
      if (!UUID.test(user)) return 'Assign to: pick a person'
      return { kind: 'person', user }
    }
    case 'share': {
      if (!Array.isArray(a.people) || !a.people.length)
        return 'Share among: pick at least one person'
      if (a.people.length > MAX_PEOPLE) return `Share among: at most ${MAX_PEOPLE} people`
      const people: SharePerson[] = []
      for (const p of a.people as Array<Record<string, unknown>>) {
        const id = String(p?.id ?? '').toUpperCase()
        if (!UUID.test(id)) return 'Share among: a person is not valid'
        if (people.some((x) => x.id === id)) continue
        const capRaw = p.cap
        const cap =
          capRaw == null || capRaw === ''
            ? null
            : Number.isSafeInteger(Number(capRaw))
              ? Number(capRaw)
              : NaN
        if (cap != null && (Number.isNaN(cap) || cap < 1 || cap > 10_000))
          return 'Share among: a cap must be a whole number of 1 or more'
        const when = String(p.when ?? 'always')
        if (!['always', 'business_hours', 'online'].includes(when))
          return 'Share among: unknown availability'
        people.push({ id, cap, when: when as SharePerson['when'] })
      }
      const strategy = String(a.strategy ?? 'fewest_open')
      if (!(STRATEGIES as readonly string[]).includes(strategy))
        return 'Share among: pick how to choose'
      return {
        kind: 'share',
        people,
        strategy: strategy as Strategy,
        give_to_cover: !!a.give_to_cover
      }
    }
    case 'step_owner': {
      const pick = String(a.pick ?? 'fewest_open')
      if (pick !== 'first' && pick !== 'fewest_open') return 'Step owner: pick first or fewest open'
      return { kind: 'step_owner', pick }
    }
    case 'team': {
      const team = Number(a.team)
      if (!Number.isSafeInteger(team) || team <= 0) return 'Send to a team: pick a team'
      return { kind: 'team', team }
    }
    default:
      return 'Pick what the rule does'
  }
}

/** Read a rule set from a request body or storage. Errors are plain sentences per rule. */
export function validateRuleSet(
  raw: unknown
): { ok: true; set: AssignRuleSet } | { ok: false; errors: RuleError[] } {
  const body = (raw ?? {}) as Record<string, unknown>
  const errors: RuleError[] = []
  const rulesRaw = body.rules
  if (!Array.isArray(rulesRaw))
    return { ok: false, errors: [{ rule: -1, message: 'rules must be a list' }] }
  if (rulesRaw.length > MAX_RULES)
    return { ok: false, errors: [{ rule: -1, message: `At most ${MAX_RULES} rules` }] }
  const h = (body.hours ?? DEFAULT_HOURS) as Record<string, unknown>
  const days = Array.isArray(h.days)
    ? [...new Set(h.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
    : DEFAULT_HOURS.days
  const hours: BusinessHours = {
    start: String(h.start ?? DEFAULT_HOURS.start),
    end: String(h.end ?? DEFAULT_HOURS.end),
    days
  }
  if (!HHMM.test(hours.start) || !HHMM.test(hours.end))
    errors.push({ rule: -1, message: 'Business hours: use a time like 08:00' })
  else if (hours.start >= hours.end)
    errors.push({ rule: -1, message: 'Business hours: the end must be after the start' })
  if (!hours.days.length)
    errors.push({ rule: -1, message: 'Business hours: pick at least one day' })
  const rules: AssignRule[] = []
  const ids = new Set<string>()
  rulesRaw.forEach((r0, i) => {
    const r = (r0 ?? {}) as Record<string, unknown>
    const name = String(r.name ?? '').trim()
    if (!name) errors.push({ rule: i, message: 'Give the rule a name' })
    let id = String(r.id ?? '').trim()
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || ids.has(id))
      id = `r${i + 1}-${Date.now().toString(36)}`
    ids.add(id)
    const conditions: Condition[] = []
    const condRaw = Array.isArray(r.conditions) ? r.conditions : []
    if (condRaw.length > MAX_CONDITIONS)
      errors.push({ rule: i, message: `At most ${MAX_CONDITIONS} conditions in one rule` })
    for (const c of condRaw.slice(0, MAX_CONDITIONS)) {
      const read = readCondition(c)
      if (typeof read === 'string') errors.push({ rule: i, message: read })
      else conditions.push(read)
    }
    const action = readAction(r.action)
    if (typeof action === 'string') errors.push({ rule: i, message: action })
    const f = (r.fallback ?? { kind: 'desk' }) as Record<string, unknown>
    let fallback: RuleFallback = { kind: 'desk' }
    if (f.kind === 'person') {
      const user = String(f.user ?? '').toUpperCase()
      if (!UUID.test(user))
        errors.push({ rule: i, message: 'If nobody can take it: pick a person' })
      else fallback = { kind: 'person', user }
    }
    if (typeof action !== 'string')
      rules.push({
        id,
        name: name.slice(0, 120),
        active: r.active !== false,
        match: r.match === 'any' ? 'any' : 'all',
        conditions,
        action,
        fallback,
        on_type_change: !!r.on_type_change,
        note: r.note ? String(r.note).slice(0, 500) : null
      })
  })
  return errors.length ? { ok: false, errors } : { ok: true, set: { rules, hours } }
}

/** Stored JSON → a rule set; junk reads as no rules (never an error at create time). */
export function parseStoredRuleSet(value: unknown): AssignRuleSet {
  if (typeof value !== 'string' || !value) return EMPTY_RULE_SET
  try {
    const v = validateRuleSet(JSON.parse(value))
    return v.ok ? v.set : EMPTY_RULE_SET
  } catch {
    return EMPTY_RULE_SET
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** What is known about one request when the rules run. */
export interface RequestFacts {
  category_id: number | null
  collection: string | null
  item: string | null
  /** `${collection}.${field}` → the record's stored value (system read; never shown). */
  fields: Record<string, unknown>
  /** The record's current pipeline step id, if any. */
  state: string | null
  requester: string | null
  requester_role: string | null
  requester_teams: number[]
  priority: string
  title: string
  description: string
  source: RequestSource
  at: Date
}

/** Eastern wall clock: day of week and minutes after midnight. */
export function easternClock(at: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

export function insideHours(at: Date, h: BusinessHours): boolean {
  const { day, minutes } = easternClock(at)
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))
  return h.days.includes(day) && minutes >= toMin(h.start) && minutes < toMin(h.end)
}

const norm = (v: unknown) => (v == null ? '' : String(v).trim().toLowerCase())
const isEmpty = (v: unknown) =>
  v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
const num = (v: unknown) => {
  if (v instanceof Date) return v.getTime()
  const n = Number(v)
  if (Number.isFinite(n) && String(v).trim() !== '') return n
  const d = Date.parse(String(v))
  return Number.isNaN(d) ? null : d
}
/** A stored value as the list of things it is (M2M / JSON arrays → each). */
function valuesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(norm)
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const p = JSON.parse(v)
      if (Array.isArray(p)) return p.map(norm)
    } catch {
      // not JSON: one value
    }
  }
  return [norm(v)]
}

export function fieldMatches(op: FieldOp, stored: unknown, wanted: string[]): boolean {
  const have = valuesOf(stored)
  const want = wanted.map(norm)
  switch (op) {
    case 'empty':
      return isEmpty(stored)
    case 'not_empty':
      return !isEmpty(stored)
    case 'is':
    case 'in':
      return !isEmpty(stored) && have.some((h) => want.includes(h))
    case 'is_not':
    case 'not_in':
      return isEmpty(stored) || !have.some((h) => want.includes(h))
    case 'contains':
      return !isEmpty(stored) && want.some((w) => have.some((h) => h.includes(w)))
    case 'not_contains':
      return isEmpty(stored) || !want.some((w) => have.some((h) => h.includes(w)))
    default: {
      const a = num(stored)
      const b = num(wanted[0])
      if (a == null || b == null) return false
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
    }
  }
}

const inSet = <T>(op: SetOp, set: T[], v: T | null) =>
  op === 'in' ? v != null && set.includes(v) : v == null || !set.includes(v)

/** Labels the reasons may use (names, never record values). */
export interface MatchLabels {
  type?: (id: number) => string
  field?: (collection: string, field: string) => string
}

/** One condition: whether it holds, and a plain sentence saying why not. */
export function conditionHolds(
  c: Condition,
  f: RequestFacts,
  hours: BusinessHours,
  labels: MatchLabels = {}
): { ok: boolean; why: string } {
  switch (c.kind) {
    case 'type': {
      const ok = inSet(c.op, c.values, f.category_id)
      return {
        ok,
        why: ok
          ? ''
          : c.op === 'in'
            ? 'the request type is not one of those'
            : 'the request type is one it excludes'
      }
    }
    case 'about': {
      if (c.op === 'general') {
        const ok = !f.collection
        return { ok, why: ok ? '' : 'it is about a record, not General Support' }
      }
      const ok = !!f.collection && (!c.collections.length || c.collections.includes(f.collection))
      return {
        ok,
        why: ok
          ? ''
          : f.collection
            ? 'it is about a different kind of record'
            : 'it is not about a record'
      }
    }
    case 'field': {
      const label = labels.field?.(c.collection, c.field) ?? c.field
      if (f.collection !== c.collection)
        return { ok: false, why: `it is not about a record that has ${label}` }
      const ok = fieldMatches(c.op, f.fields[`${c.collection}.${c.field}`], c.values)
      return { ok, why: ok ? '' : `the record’s ${label} does not match` }
    }
    case 'step': {
      if (!f.state)
        return {
          ok: c.op === 'not_in',
          why: c.op === 'not_in' ? '' : 'the record is not at a pipeline step'
        }
      const ok = inSet(c.op, c.states, f.state)
      return { ok, why: ok ? '' : 'the record is at a different step' }
    }
    case 'requester': {
      const ok = inSet(c.op, c.users, f.requester ? f.requester.toUpperCase() : null)
      return { ok, why: ok ? '' : 'a different person raised it' }
    }
    case 'requester_role': {
      const roles = c.roles.map((r) => r.toUpperCase())
      const ok = inSet(c.op, roles, f.requester_role ? f.requester_role.toUpperCase() : null)
      return { ok, why: ok ? '' : 'the requester’s role does not match' }
    }
    case 'requester_team': {
      const member = f.requester_teams.some((t) => c.teams.includes(t))
      const ok = c.op === 'in' ? member : !member
      return {
        ok,
        why: ok
          ? ''
          : c.op === 'in'
            ? 'the requester is not in those teams'
            : 'the requester is in an excluded team'
      }
    }
    case 'priority': {
      const ok = inSet(c.op, c.values, f.priority)
      return { ok, why: ok ? '' : 'the priority does not match' }
    }
    case 'text': {
      const hay = `${f.title}\n${f.description}`.toLowerCase()
      const hits = c.words.filter((w) => hay.includes(w.toLowerCase()))
      const ok =
        c.op === 'any'
          ? hits.length > 0
          : c.op === 'all'
            ? hits.length === c.words.length
            : hits.length === 0
      return {
        ok,
        why: ok
          ? ''
          : c.op === 'none'
            ? `the words include “${hits[0]}”`
            : c.op === 'all'
              ? 'not every word is in the title or description'
              : 'none of the words are in the title or description'
      }
    }
    case 'source': {
      const ok = inSet(c.op, c.values, f.source)
      return { ok, why: ok ? '' : 'it was raised from somewhere else' }
    }
    case 'hours': {
      const inside = insideHours(f.at, hours)
      const ok = c.op === 'inside' ? inside : !inside
      return {
        ok,
        why: ok
          ? ''
          : inside
            ? 'it was raised during business hours'
            : 'it was raised outside business hours'
      }
    }
  }
}

/** Does this rule match? With every failing condition's reason (for the test box). */
export function matchRule(
  rule: AssignRule,
  f: RequestFacts,
  hours: BusinessHours,
  labels: MatchLabels = {}
): { matched: boolean; reasons: string[] } {
  if (!rule.active) return { matched: false, reasons: ['the rule is switched off'] }
  if (!rule.conditions.length) return { matched: true, reasons: [] }
  const results = rule.conditions.map((c) => conditionHolds(c, f, hours, labels))
  const matched = rule.match === 'all' ? results.every((r) => r.ok) : results.some((r) => r.ok)
  return { matched, reasons: matched ? [] : results.filter((r) => !r.ok).map((r) => r.why) }
}

// ── Choosing one person ──────────────────────────────────────────────────────

/** One person a rule may give the request to, with everything a strategy reads. */
export interface Candidate {
  id: string
  name: string
  /** suspended / not active / redacted */
  inactive: boolean
  out_of_office: boolean
  /** Their working cover while out (already checked active and not out), with the cover's
   *  own numbers when known. */
  cover: { id: string; name: string; stats?: Candidate } | null
  online: boolean
  open: number
  urgent_open: number
  /** ms epoch of their last assignment; null = never. */
  last_assigned: number | null
  assigned_today: number
  assigned_week: number
  /** Requests of this type (or this kind of record) they closed. */
  closed_same: number
  /** ms epoch they last had a request from this requester; null = never. */
  last_helped: number | null
  step_owner: boolean
}

export interface RankRow {
  id: string
  name: string
  /** The number that decided it, in words ("3 open", "assigned 2 today"). */
  measure: string
  /** Covered for `for` (out of office). */
  for?: string
}

export interface Pick {
  winner: { id: string; name: string } | null
  ranking: RankRow[]
  skipped: Array<{ id: string; name: string; reason: string }>
  /** The strategy that actually ordered them (a fallback names fewest_open). */
  used: Strategy
}

export const STRATEGY_TEXT: Record<Strategy, string> = {
  fewest_open: 'whoever has the fewest open requests',
  least_recent: 'whoever was assigned least recently',
  fewest_today: 'whoever was assigned the fewest today',
  fewest_week: 'whoever was assigned the fewest this week',
  fewest_urgent: 'whoever has the fewest urgent open requests',
  most_closed_type: 'whoever has closed the most of this kind',
  last_helped: 'whoever last helped this requester',
  step_owner: 'the record’s step owner if listed',
  random: 'anyone, at random'
}

const ago = (ms: number | null, now: number) => {
  if (ms == null) return 'never assigned'
  const h = Math.floor((now - ms) / 3_600_000)
  return h < 1
    ? 'assigned under an hour ago'
    : h < 48
      ? `assigned ${h}h ago`
      : `assigned ${Math.floor(h / 24)}d ago`
}

/**
 * Choose one of `people` (already narrowed to the rule's list, in the rule's order) by the
 * strategy. Skips: not active, out of office (their cover takes their place when the rule says
 * so), at their cap, outside business hours / not online when that person is limited so.
 * Ties: fewest open, then least recently assigned, then the list's order. `rand` is injected
 * for tests.
 */
export function pickPerson(
  people: Array<Candidate & { cap: number | null; when: SharePerson['when'] }>,
  strategy: Strategy,
  opts: {
    giveToCover: boolean
    insideHours: boolean
    now: number
    rand?: () => number
    /** The first one left after the skips, in list order (a step's "first owner"). */
    keepOrder?: boolean
  }
): Pick {
  const skipped: Pick['skipped'] = []
  const pool: Array<Candidate & { order: number; for?: string }> = []
  for (const [order, p] of people.entries()) {
    if (p.inactive) {
      skipped.push({ id: p.id, name: p.name, reason: 'account is not active' })
      continue
    }
    if (p.out_of_office) {
      if (opts.giveToCover && p.cover) {
        if (!pool.some((x) => x.id === p.cover!.id)) {
          const coverRow = people.find((x) => x.id === p.cover!.id)
          // Their cover stands in, at the out person's place in the list, with the cover's own
          // numbers (listed row, else the stats the gatherer attached).
          const stats = coverRow ?? p.cover.stats
          pool.push({
            ...p,
            ...(stats ?? {}),
            out_of_office: false,
            inactive: false,
            id: p.cover.id,
            name: p.cover.name,
            order,
            for: p.name
          })
        }
        skipped.push({
          id: p.id,
          name: p.name,
          reason: `out of office — ${p.cover.name} covers`
        })
        continue
      }
      skipped.push({
        id: p.id,
        name: p.name,
        reason: p.cover ? 'out of office (cover not used by this rule)' : 'out of office'
      })
      continue
    }
    if (p.cap != null && p.open >= p.cap) {
      skipped.push({
        id: p.id,
        name: p.name,
        reason: `at their cap (${p.open} of ${p.cap} open)`
      })
      continue
    }
    if (p.when === 'business_hours' && !opts.insideHours) {
      skipped.push({
        id: p.id,
        name: p.name,
        reason: 'only takes requests in business hours'
      })
      continue
    }
    if (p.when === 'online' && !p.online) {
      skipped.push({
        id: p.id,
        name: p.name,
        reason: 'only takes requests while online, and is not'
      })
      continue
    }
    if (!pool.some((x) => x.id === p.id)) pool.push({ ...p, order })
  }
  if (!pool.length) return { winner: null, ranking: [], skipped, used: strategy }

  let used: Strategy = strategy
  // A strategy with nothing to go on falls back to fewest open (said in `used`).
  if (strategy === 'step_owner' && !pool.some((p) => p.step_owner)) used = 'fewest_open'
  if (strategy === 'last_helped' && !pool.some((p) => p.last_helped != null)) used = 'fewest_open'
  if (strategy === 'most_closed_type' && !pool.some((p) => p.closed_same > 0)) used = 'fewest_open'

  const key = (p: Candidate): number => {
    switch (used) {
      case 'least_recent':
        return p.last_assigned ?? Number.NEGATIVE_INFINITY
      case 'fewest_today':
        return p.assigned_today
      case 'fewest_week':
        return p.assigned_week
      case 'fewest_urgent':
        return p.urgent_open
      case 'most_closed_type':
        return -p.closed_same
      case 'last_helped':
        return -(p.last_helped ?? Number.NEGATIVE_INFINITY)
      case 'step_owner':
        return p.step_owner ? 0 : 1
      default:
        return p.open
    }
  }
  const measure = (p: Candidate): string => {
    switch (used) {
      case 'least_recent':
        return ago(p.last_assigned, opts.now)
      case 'fewest_today':
        return `${p.assigned_today} assigned today`
      case 'fewest_week':
        return `${p.assigned_week} assigned this week`
      case 'fewest_urgent':
        return `${p.urgent_open} urgent open`
      case 'most_closed_type':
        return `${p.closed_same} closed of this kind`
      case 'last_helped':
        return p.last_helped == null
          ? 'has not helped them'
          : `helped them ${ago(p.last_helped, opts.now).replace('assigned ', '')}`
      case 'step_owner':
        return p.step_owner ? 'owns the record’s step' : 'not a step owner'
      case 'random':
        return 'random draw'
      default:
        return `${p.open} open`
    }
  }
  let ordered: typeof pool
  if (opts.keepOrder) {
    ordered = [...pool].sort((a, b) => a.order - b.order)
  } else if (used === 'random') {
    const rand = opts.rand ?? Math.random
    ordered = pool
      .map((p) => ({ p, r: rand() }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.p)
  } else {
    ordered = [...pool].sort(
      (a, b) =>
        key(a) - key(b) ||
        a.open - b.open ||
        (a.last_assigned ?? Number.NEGATIVE_INFINITY) -
          (b.last_assigned ?? Number.NEGATIVE_INFINITY) ||
        a.order - b.order
    )
  }
  const ranking = ordered.map((p) => ({
    id: p.id,
    name: p.name,
    measure: measure(p),
    ...(p.for ? { for: p.for } : {})
  }))
  return { winner: { id: ordered[0].id, name: ordered[0].name }, ranking, skipped, used }
}
