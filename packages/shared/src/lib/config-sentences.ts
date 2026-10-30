import { choiceLabel, titleCase } from './utils'
import { formulaInputs } from './write-formula'

/**
 * Configuration read back in plain English (#11, #10, #13).
 *
 * One pure module: every builder (field rules, cascade filters, alerts, flows,
 * owner groups, transitions, validation rules, show/lock conditions) and the
 * record form's "where does this come from?" turn their stored JSON into
 * sentences here, so a rule reads the same wherever it is shown.
 *
 * Rules:
 *   - Nothing is fetched. Field labels, choice labels, record labels, role
 *     names and collection names come in through `SentenceLabels`; a missing
 *     label falls back to the key in title case.
 *   - Sentences follow how the engines judge a rule: a "not" condition also
 *     matches empty values in every evaluator here, so it says "(or is empty)".
 *   - An unknown shape (an op, a type or a key this module does not know)
 *     gives NO sentence — null — never a guess.
 */

// ─── Labels ──────────────────────────────────────────────────────────────────

export interface SentenceLabels {
  /** field → label, for the collection the config belongs to. */
  fields?: Record<string, string>
  /** field → type ('integer', 'decimal', 'date', 'boolean', …). */
  types?: Record<string, string>
  /** field → stored value → choice label. */
  choices?: Record<string, Record<string, string>>
  /** field → record id → that record's label (relation values). */
  records?: Record<string, Record<string, string>>
  /** collection → label. */
  collections?: Record<string, string>
  /** collection → field → label, for fields of OTHER collections. */
  relatedFields?: Record<string, Record<string, string>>
  /** collection → field → value → choice label, for OTHER collections' fields. */
  relatedChoices?: Record<string, Record<string, Record<string, string>>>
  /** link field → the collection it points at (M2O / lookup sources). */
  links?: Record<string, string>
  /** role id → role name. */
  roles?: Record<string, string>
  /** state id or key → state label. */
  states?: Record<string, string>
  /** field → how numbers read. */
  formats?: Record<string, 'money' | 'percent' | 'number'>
}

const NUMERIC_TYPES = new Set(['integer', 'bigInteger', 'float', 'decimal', 'number'])
const DATE_TYPES = new Set(['date', 'dateTime', 'datetime', 'timestamp', 'time'])

export function fieldLabelOf(field: string, L: SentenceLabels = {}): string {
  const own = L.fields?.[field]
  if (own?.trim()) return own.trim()
  if (field.includes('.')) {
    const parts = field.split('.')
    const head = L.fields?.[parts[0]]?.trim() || titleCase(parts[0])
    return [head, ...parts.slice(1).map((p) => titleCase(p))].join('’s ')
  }
  return titleCase(field)
}

export function collectionLabelOf(collection: string, L: SentenceLabels = {}): string {
  const own = L.collections?.[collection]
  return own?.trim() ? own.trim() : titleCase(collection)
}

function relatedFieldLabel(collection: string, field: string, L: SentenceLabels): string {
  const own = L.relatedFields?.[collection]?.[field]
  return own?.trim() ? own.trim() : titleCase(field)
}

const isEmptyish = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

function formatNumber(n: number, fmt: 'money' | 'percent' | 'number' | undefined): string {
  if (fmt === 'money')
    return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  if (fmt === 'percent') return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

/** One stored value as a person reads it. */
export function valueTextOf(field: string, value: unknown, L: SentenceLabels = {}): string {
  if (isEmptyish(value)) return 'empty'
  const key = String(value)
  const choice = L.choices?.[field]?.[key]
  if (choice != null) return choiceLabel(choice)
  const rec = L.records?.[field]?.[key]
  if (rec != null) return rec
  if (typeof value === 'boolean' || L.types?.[field] === 'boolean') {
    if (value === true || key === 'true' || key === '1') return 'Yes'
    if (value === false || key === 'false' || key === '0') return 'No'
  }
  const fmt = L.formats?.[field]
  const numeric = typeof value === 'number' || /^\s*-?\d+(\.\d+)?\s*$/.test(key)
  if (numeric && (fmt || NUMERIC_TYPES.has(L.types?.[field] ?? ''))) {
    return formatNumber(Number(key), fmt)
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return choiceLabel(key)
}

/** "A", "A or B", "A, B or C". */
export function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** "A", "A and B", "A, B and C". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function listValues(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.map((v) => String(v))
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  if (s.startsWith('[')) {
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v.map((x) => String(x)) : null
    } catch {
      return null
    }
  }
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** "a sentence." → "A sentence." */
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const end = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

// ─── Conditions ──────────────────────────────────────────────────────────────

/**
 * One `{field, op, value}` condition as a clause ("Zone is East"). Known ops:
 * eq neq null nnull gt gte lt lte contains in. Anything else → null.
 */
export function describeCondition(
  field: string,
  op: string | null | undefined,
  value: unknown,
  L: SentenceLabels = {}
): string | null {
  if (!field) return null
  const label = fieldLabelOf(field, L)
  const o = op ?? 'eq'
  switch (o) {
    case 'null':
      return `${label} is empty`
    case 'nnull':
      return `${label} is set`
    case 'eq':
      return isEmptyish(value) ? `${label} is empty` : `${label} is ${valueTextOf(field, value, L)}`
    case 'neq':
      return isEmptyish(value)
        ? `${label} is set`
        : `${label} is not ${valueTextOf(field, value, L)} (or is empty)`
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (isEmptyish(value)) return null
      const word = { gt: 'is over', gte: 'is at least', lt: 'is under', lte: 'is at most' }[o]
      return `${label} ${word} ${valueTextOf(field, value, L)}`
    }
    case 'contains':
      return isEmptyish(value) ? null : `${label} contains “${String(value)}”`
    case 'in': {
      const list = listValues(value)
      if (!list?.length) return null
      return `${label} is ${orList(list.map((v) => valueTextOf(field, v, L)))}`
    }
    default:
      return null
  }
}

/** Every condition joined with "and"; null when any one is unknown or none are given. */
export function describeConditionList(
  rules: Array<{ field?: string; op?: string; value?: unknown }> | null | undefined,
  L: SentenceLabels = {}
): string | null {
  if (!Array.isArray(rules) || rules.length === 0) return null
  const parts: string[] = []
  for (const r of rules) {
    if (!r || typeof r !== 'object' || !r.field) continue
    const c = describeCondition(r.field, r.op, r.value, L)
    if (!c) return null
    parts.push(c)
  }
  return parts.length ? parts.join(' and ') : null
}

const FILTER_OPS: Record<string, string> = {
  _eq: 'eq',
  _neq: 'neq',
  _gt: 'gt',
  _gte: 'gte',
  _lt: 'lt',
  _lte: 'lte',
  _in: 'in',
  _contains: 'contains'
}

/**
 * An items-style filter object (`{status: {_neq: 'cancelled'}}`, a bare
 * literal = equals, `_and` / `_or` lists, nested relation keys) as a clause.
 * Any operator outside eq/neq/gt/gte/lt/lte/in/contains/null/nnull → null.
 */
export function describeFilterObject(
  filter: unknown,
  L: SentenceLabels = {},
  prefix = ''
): string | null {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null
  const parts: string[] = []
  for (const [key, raw] of Object.entries(filter as Record<string, unknown>)) {
    if (key === '_and' || key === '_or') {
      if (!Array.isArray(raw) || raw.length === 0) return null
      const subs = raw.map((s) => describeFilterObject(s, L, prefix))
      if (subs.some((s) => !s)) return null
      parts.push(
        key === '_and' ? (subs as string[]).join(' and ') : `either ${orList(subs as string[])}`
      )
      continue
    }
    if (key.startsWith('_')) return null
    const path = prefix ? `${prefix}.${key}` : key
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      const c = describeCondition(path, Array.isArray(raw) ? 'in' : 'eq', raw, L)
      if (!c) return null
      parts.push(c)
      continue
    }
    const entries = Object.entries(raw as Record<string, unknown>)
    if (entries.length === 0) return null
    const allOps = entries.every(([k]) => k.startsWith('_'))
    if (!allOps) {
      const nested = describeFilterObject(raw, L, path)
      if (!nested) return null
      parts.push(nested)
      continue
    }
    for (const [op, v] of entries) {
      let c: string | null
      if (op === '_null') c = describeCondition(path, v === false ? 'nnull' : 'null', null, L)
      else if (op === '_nnull') c = describeCondition(path, v === false ? 'null' : 'nnull', null, L)
      else if (FILTER_OPS[op]) c = describeCondition(path, FILTER_OPS[op], v, L)
      else c = null
      if (!c) return null
      parts.push(c)
    }
  }
  return parts.length ? parts.join(' and ') : null
}

// ─── Field rules (nivaro_field_rules) ────────────────────────────────────────

export interface FieldRuleLike {
  trigger_field?: string | null
  trigger_op?: string | null
  trigger_value?: string | null
  target_field?: string | null
  target_type?: string | null
  target_value?: string | null
  only_when_empty?: boolean | number | null
  dynamic_config?: string | Record<string, unknown> | null
  is_active?: boolean | number | null
}

function parseObj(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** "When <trigger> changes to …" — field rules run when their trigger field changes. */
function triggerClause(
  field: string,
  op: string,
  value: unknown,
  L: SentenceLabels
): string | null {
  const label = fieldLabelOf(field, L)
  switch (op) {
    case 'eq':
      // The engine compares String(value) === trigger_value: '' never matches
      // a cleared (null) field, so an empty trigger has no honest sentence.
      return isEmptyish(value) ? null : `When ${label} changes to ${valueTextOf(field, value, L)}`
    case 'neq':
      return isEmptyish(value)
        ? null
        : `When ${label} changes to anything but ${valueTextOf(field, value, L)} (or is cleared)`
    case 'null':
      return `When ${label} is cleared`
    case 'nnull':
      return `When ${label} changes to any value`
    case 'in': {
      const list = listValues(value)
      if (!list?.length) return null
      return `When ${label} changes to ${orList(list.map((v) => valueTextOf(field, v, L)))}`
    }
    case 'contains':
      return isEmptyish(value) ? null : `When ${label} changes to something containing “${value}”`
    default:
      return null
  }
}

/** "When Zone changes to East, set Region to North (only if Region is empty)." */
export function describeFieldRule(rule: FieldRuleLike, L: SentenceLabels = {}): string | null {
  const trigger = rule.trigger_field?.trim()
  const target = rule.target_field?.trim()
  if (!trigger || !target) return null
  const when = triggerClause(trigger, rule.trigger_op ?? 'eq', rule.trigger_value, L)
  if (!when) return null
  const targetLabel = fieldLabelOf(target, L)
  let action: string
  switch (rule.target_type ?? 'set') {
    case 'set':
      if (rule.target_value == null) return null
      action = `set ${targetLabel} to ${valueTextOf(target, rule.target_value, L)}`
      break
    case 'clear':
      action = `clear ${targetLabel}`
      break
    case 'set_lookup': {
      const cfg = parseObj(rule.dynamic_config)
      const coll = typeof cfg?.collection === 'string' ? cfg.collection : null
      const by = typeof cfg?.filter_field === 'string' ? cfg.filter_field : null
      const sel = typeof cfg?.select === 'string' ? cfg.select : null
      if (!coll || !by || !sel) return null
      action = `set ${targetLabel} to the ${relatedFieldLabel(coll, sel, L)} of each ${collectionLabelOf(coll, L)} record whose ${relatedFieldLabel(coll, by, L)} is the new ${fieldLabelOf(trigger, L)}`
      break
    }
    case 'set_from_trigger': {
      const cfg = parseObj(rule.dynamic_config)
      const from = typeof cfg?.field === 'string' ? cfg.field : null
      if (!from) return null
      const linked = L.links?.[trigger]
      const fromLabel = linked ? relatedFieldLabel(linked, from, L) : titleCase(from)
      action = `copy the picked ${fieldLabelOf(trigger, L)}’s ${fromLabel} into ${targetLabel}`
      break
    }
    default:
      return null
  }
  const onlyEmpty =
    rule.only_when_empty === true || rule.only_when_empty === 1
      ? ` (only if ${targetLabel} is empty)`
      : ''
  return `${when}, ${action}${onlyEmpty}.`
}

// ─── Cascade filters (dependency_config.cascade_filters) ────────────────────

export interface CascadeRuleLike {
  parent_field?: string
  filter_column?: string
  filter_is_m2m?: boolean
  value_map?: Record<string, unknown>
  clear_on_parent_change?: boolean
  clear_on_unavailable?: boolean
  show_all_if_no_parent?: boolean
  upstream?: boolean
}

/**
 * "Vendor only offers Vendors whose Zone is this record's Zone. Changing Zone
 * clears Vendor. With no Zone picked, it offers every Vendor."
 */
export function describeCascadeFilter(
  rule: CascadeRuleLike,
  ctx: { field: string; relatedCollection?: string | null },
  L: SentenceLabels = {}
): string[] | null {
  const parent = rule.parent_field?.trim()
  const column = rule.filter_column?.trim()
  if (!parent || !column || !ctx.field) return null
  const field = fieldLabelOf(ctx.field, L)
  const parentLabel = fieldLabelOf(parent, L)
  const related = ctx.relatedCollection ?? null
  const things = related ? collectionLabelOf(related, L) : 'records'
  const colLabel = related
    ? column
        .split('.')
        .map((p, i) => (i === 0 ? relatedFieldLabel(related, p, L) : titleCase(p)))
        .join('’s ')
    : titleCase(column)
  const mapped = rule.value_map && Object.keys(rule.value_map).length > 0
  const match = mapped
    ? `whose ${colLabel} is mapped from this record’s ${parentLabel}`
    : rule.filter_is_m2m
      ? `whose ${colLabel} is one of this record’s ${parentLabel}`
      : `whose ${colLabel} is this record’s ${parentLabel}`
  const out = [`${field} only offers ${things} ${match}.`]
  if (rule.clear_on_parent_change !== false) out.push(`Changing ${parentLabel} clears ${field}.`)
  if (rule.clear_on_unavailable) out.push(`A ${field} that no longer fits is cleared.`)
  out.push(
    rule.show_all_if_no_parent === false
      ? `${field} stays locked until ${parentLabel} is picked.`
      : `With no ${parentLabel} picked, it offers every one.`
  )
  if (rule.upstream) out.push(`Picking a ${field} fills ${parentLabel} from it.`)
  return out
}

// ─── Alerts (nivaro_alert_definitions) ───────────────────────────────────────

export interface AlertLike {
  collection?: string | null
  field?: string | null
  operator?: string | null
  threshold?: number | string | null
  unit?: string | null
  cooldown_minutes?: number | null
  filters?: Record<string, unknown> | string | null
  detection_type?: string | null
  sensitivity?: number | null
}

function unitText(n: number, unit: string | null | undefined): string {
  if (unit === 'dollar') return formatNumber(n, 'money')
  if (unit === 'percent') return formatNumber(n, 'percent')
  if (unit === 'days') return `${formatNumber(n, 'number')} ${n === 1 ? 'day' : 'days'}`
  return formatNumber(n, 'number')
}

/** "Alert when a Workflow’s Amount is over $50,000 (only where Zone is East). Then wait 60 minutes before alerting on it again." */
export function describeAlert(def: AlertLike, L: SentenceLabels = {}): string[] | null {
  if (!def.collection || !def.field) return null
  const record = collectionLabelOf(def.collection, L)
  const field = fieldLabelOf(def.field, L)
  let filters: string | null = null
  const f = typeof def.filters === 'string' ? parseObj(def.filters) : def.filters
  if (f && Object.keys(f).length > 0) {
    filters = describeFilterObject(f, L)
    if (!filters) return null
  }
  let head: string
  if (def.detection_type === 'anomaly') {
    const s = Number(def.sensitivity ?? 2)
    if (!Number.isFinite(s)) return null
    head = `Alert when a ${record} record’s ${field} is more than ${formatNumber(s, 'number')} standard deviations from its 90-day average`
  } else {
    const t = Number(def.threshold)
    if (def.threshold == null || def.threshold === '' || !Number.isFinite(t)) return null
    const value = unitText(t, def.unit)
    const op = def.operator ?? 'gt'
    const words: Record<string, string> = {
      gt: `is over ${value}`,
      gte: `is ${value} or more`,
      lt: `is under ${value}`,
      lte: `is ${value} or less`,
      eq: `is exactly ${value}`,
      neq: `is anything but ${value}`,
      change_pct: `changes by ${formatNumber(t, 'number')}% or more`
    }
    if (!words[op]) return null
    head = `Alert when a ${record} record’s ${field} ${words[op]}`
  }
  const out = [`${head}${filters ? ` (only where ${filters})` : ''}.`]
  const cool = Number(def.cooldown_minutes)
  if (Number.isFinite(cool) && cool > 0)
    out.push(
      `Then wait ${formatNumber(cool, 'number')} ${cool === 1 ? 'minute' : 'minutes'} before alerting on the same record again.`
    )
  return out
}

// ─── Flows ───────────────────────────────────────────────────────────────────

export interface FlowLike {
  trigger?: string | null
  trigger_options?: Record<string, unknown> | string | null
  operations?: Array<{
    id: string
    name?: string | null
    type: string
    options?: Record<string, unknown> | null
    resolve?: string | null
    reject?: string | null
  }>
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A five-field cron in words, for the common shapes; anything else names the expression. */
export function cronInWords(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return `on the schedule “${cron.trim()}”`
  const [min, hour, dom, mon, dow] = parts
  const anyDate = dom === '*' && mon === '*'
  if (anyDate && dow === '*' && hour === '*') {
    if (min === '*') return 'every minute'
    const step = /^\*\/(\d+)$/.exec(min)
    if (step) return `every ${step[1]} minutes`
    if (/^\d+$/.test(min))
      return min === '0' ? 'every hour' : `every hour at :${min.padStart(2, '0')}`
  }
  if (anyDate && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const at = `${hour.padStart(2, '0')}:${min.padStart(2, '0')} UTC`
    if (dow === '*') return `every day at ${at}`
    if (dow === '1-5') return `every weekday at ${at}`
    if (/^[0-6]$/.test(dow)) return `every ${DAY_NAMES[Number(dow)]} at ${at}`
  }
  return `on the schedule “${cron.trim()}”`
}

const ACTION_WORDS: Record<string, string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted'
}

/** The trigger as a sentence ("After a Project is created or updated, …"); null when unknown. */
export function describeFlowTrigger(flow: FlowLike, L: SentenceLabels = {}): string | null {
  const opts = (
    typeof flow.trigger_options === 'string'
      ? parseObj(flow.trigger_options)
      : (flow.trigger_options ?? {})
  ) as Record<string, unknown> | null
  switch (flow.trigger) {
    case 'event': {
      const types = Array.isArray(opts?.types) ? (opts?.types as string[]) : []
      // login/logout are not item events; the hook registry ignores them, so
      // this module does not claim to know what such a flow listens for.
      if (types.some((t) => !ACTION_WORDS[t])) return null
      const actions = (types.length ? types : ['create', 'update', 'delete']).map(
        (t) => ACTION_WORDS[t]
      )
      const cols = Array.isArray(opts?.collections) ? (opts?.collections as string[]) : []
      const what = cols.length
        ? `a ${orList(cols.map((c) => collectionLabelOf(c, L)))} record`
        : 'a record in any collection'
      if (opts?.timing === 'before') {
        const shapes = opts?.return_payload ? ' (it can change what is saved)' : ''
        return `Runs just before ${what} is ${orList(actions)}${shapes}.`
      }
      return `Runs after ${what} is ${orList(actions)}.`
    }
    case 'schedule': {
      const cron = typeof opts?.cron === 'string' ? opts.cron : ''
      return cron.trim() ? `Runs ${cronInWords(cron)}.` : null
    }
    case 'manual':
      return 'Runs when someone starts it by hand.'
    case 'webhook': {
      const m = typeof opts?.method === 'string' ? opts.method.toUpperCase() : '*'
      return `Runs when ${m && m !== '*' ? `a ${m}` : 'a'} request reaches its webhook address.`
    }
    default:
      return null
  }
}

const OP_VERBS: Record<string, string> = {
  condition: 'checks a condition',
  'exec-script': 'runs a script',
  log: 'writes to the log',
  mail: 'sends an email',
  notification: 'sends a notification',
  webhook: 'calls a web address',
  transform: 'reshapes the data',
  'run-flow': 'runs another flow',
  'external-api': 'calls an external API',
  'item-read': 'reads a record',
  'item-write': 'writes a record',
  'workflow-auto-sweep': 'moves records along their pipeline',
  'chat-post': 'posts to chat',
  task: 'creates a task',
  'refresh-pages': 'tells open pages to refresh'
}

function opText(op: { name?: string | null; type: string }): string {
  const verb = OP_VERBS[op.type] ?? 'runs a step'
  const name = op.name?.trim()
  return name ? `${verb} (“${name}”)` : verb
}

/**
 * The trigger, then the main path step by step, then what happens when a
 * step fails. Steps nobody reaches are left out. Loops stop at the repeat.
 */
export function describeFlow(flow: FlowLike, L: SentenceLabels = {}): string[] | null {
  const trigger = describeFlowTrigger(flow, L)
  if (!trigger) return null
  const ops = flow.operations ?? []
  if (!ops.length) return [trigger, 'It has no steps yet.']
  const byId = new Map(ops.map((o) => [o.id, o]))
  const referenced = new Set(ops.flatMap((o) => [o.resolve, o.reject]).filter(Boolean) as string[])
  const root = ops.find((o) => !referenced.has(o.id))
  if (!root) return null
  const seen = new Set<string>()
  const main: string[] = []
  const failures: string[] = []
  let cur: (typeof ops)[number] | undefined = root
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    main.push(opText(cur))
    if (cur.reject) {
      const rej = byId.get(cur.reject)
      if (rej) {
        const path: string[] = []
        let r: (typeof ops)[number] | undefined = rej
        const local = new Set<string>()
        while (r && !local.has(r.id) && !seen.has(r.id)) {
          local.add(r.id)
          path.push(opText(r))
          r = r.resolve ? byId.get(r.resolve) : undefined
        }
        if (path.length) {
          const what =
            cur.type === 'condition' ? 'the condition is not met' : `step ${main.length} fails`
          failures.push(`If ${what}, it ${andList(path)} instead.`)
        }
      }
    }
    cur = cur.resolve ? byId.get(cur.resolve) : undefined
  }
  return [
    trigger,
    `Then it ${main.map((s, i) => (i === 0 ? s : `then ${s}`)).join(', ')}.`,
    ...failures
  ]
}

// ─── Pipelines: owner groups and transitions ─────────────────────────────────

export interface OwnerGroupLike {
  name?: string | null
  filters?: Array<{ field: string; op?: string; value: unknown }> | string | null
  is_default?: boolean
  users?: Array<{ first_name?: string | null; last_name?: string | null; email?: string }>
  teams?: Array<{ name?: string | null }>
}

function personName(u: { first_name?: string | null; last_name?: string | null; email?: string }) {
  const n = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return n || u.email || 'someone'
}

function parseList<T>(raw: T[] | string | null | undefined): T[] | null {
  if (raw == null || raw === '') return []
  if (Array.isArray(raw)) return raw
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

const OWNER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'])

/** "When Zone is East, Pat Lee and the Finance team own Approval." */
export function describeOwnerGroup(
  group: OwnerGroupLike,
  ctx: { stateLabel?: string | null },
  L: SentenceLabels = {}
): string | null {
  const filters = parseList(group.filters)
  if (!filters) return null
  const owners = [
    ...(group.users ?? []).map(personName),
    ...(group.teams ?? []).map((t) => (t.name ? `the ${t.name} team` : 'a team'))
  ]
  const who = owners.length
    ? owners.length > 4
      ? `${owners.slice(0, 3).join(', ')} and ${owners.length - 3} others`
      : andList(owners)
    : 'nobody'
  const verb = owners.length === 1 && !(group.teams ?? []).length ? 'owns' : 'own'
  const step = ctx.stateLabel ? `${ctx.stateLabel}` : 'this step'
  // prepareOwnerGroups: a default group answers when nothing else matches; a
  // group with no filters that is not the default never matches.
  if (group.is_default) return `When no other group matches, ${who} ${verb} ${step}.`
  if (filters.length === 0) return null
  // evalFilterOp knows eq/neq/lt/lte/gt/gte/in (and notin); null/nnull are false there.
  if (filters.some((f) => !OWNER_OPS.has(f.op ?? 'eq'))) return null
  const cond = describeConditionList(
    filters.map((f) => ({ field: f.field, op: f.op ?? 'eq', value: f.value })),
    L
  )
  if (!cond) return null
  return `When ${cond}, ${who} ${verb} ${step}.`
}

export interface TransitionLike {
  from_state?: string | null
  to_state?: string | null
  to_states?: string[] | null
  label?: string | null
  required_roles?: string[] | string | null
  condition_rules?: Array<{ field: string; op?: string; value?: unknown }> | string | null
  requirements?:
    | Array<{
        type?: string
        collection?: string
        fields?: string[]
        labels?: Record<string, string>
      }>
    | string
    | null
  auto_trigger?: boolean
  /** The target is the record's previous step; to_state(s) are only the fallback. */
  to_previous?: boolean
  require_owner?: boolean
  allow_creator?: boolean
  comment_mode?: string | null
}

/**
 * "When Zone is East and Amount is over $50,000, Finance can move it from
 * Review to Approved. A comment is required."
 */
export function describeTransition(tx: TransitionLike, L: SentenceLabels = {}): string[] | null {
  const targets = (tx.to_states?.length ? tx.to_states : tx.to_state ? [tx.to_state] : []).map(
    (s) => L.states?.[s] ?? s
  )
  if (!targets.length) return null
  const from = tx.from_state ? (L.states?.[tx.from_state] ?? tx.from_state) : null
  const roles = parseList(tx.required_roles as string[] | string | null)
  const rules = parseList(tx.condition_rules)
  const reqs = parseList(tx.requirements)
  if (!roles || !rules || !reqs) return null
  const cond = rules.length ? describeConditionList(rules, L) : null
  if (rules.length && !cond) return null

  let who: string
  if (roles.length) {
    const names = roles.map((r) => L.roles?.[r]).filter((n): n is string => !!n)
    who =
      names.length === roles.length
        ? orList(names)
        : `people in ${roles.length === 1 ? 'one chosen role' : `one of ${roles.length} chosen roles`}`
  } else who = 'anyone who can edit the record'
  if (tx.require_owner) {
    who = tx.allow_creator
      ? `the step’s owner or the record’s creator${roles.length ? ` (in ${who})` : ''}`
      : `the step’s owner${roles.length ? ` (in ${who})` : ''}`
  }
  const to = tx.to_previous
    ? `back to the step it came from (${orList(targets)} when that is not known)`
    : `to ${orList(targets)}`
  const move = `move it ${from ? `from ${from} ` : 'from any step '}${to}`
  const out: string[] = []
  if (tx.auto_trigger) {
    out.push(
      cap(`${cond ? `when ${cond}, ` : ''}it moves by itself ${from ? `from ${from} ` : ''}${to}.`)
    )
  } else {
    out.push(cap(`${cond ? `when ${cond}, ` : ''}${who} can ${move}.`))
  }
  for (const r of reqs) {
    if (r?.type !== 'child_fields' || !r.collection || !r.fields?.length) return null
    const names = r.fields.map(
      (f) => r.labels?.[f] ?? relatedFieldLabel(r.collection as string, f, L)
    )
    out.push(
      `Before it moves, every ${collectionLabelOf(r.collection, L)} line needs ${andList(names)}.`
    )
  }
  if (tx.comment_mode === 'required') out.push('A comment is required.')
  return out
}

// ─── Validation rules ────────────────────────────────────────────────────────

export interface ValidationRuleLike {
  type: string
  value?: unknown
  message?: string
  soft?: boolean
  field?: string
  op?: string
}

/**
 * One validation rule ("Amount must be at least 10"). Only the types the
 * shared evaluator (lib/validation-rules.ts) enforces get a sentence.
 */
export function describeValidationRule(
  rule: ValidationRuleLike,
  field: string,
  L: SentenceLabels = {}
): string | null {
  if (!rule?.type || !field) return null
  const label = fieldLabelOf(field, L)
  const type = L.types?.[field] ?? ''
  const isNum = NUMERIC_TYPES.has(type)
  const isText = !!type && !isNum && !DATE_TYPES.has(type) && type !== 'boolean'
  const n = Number(rule.value)
  let s: string | null
  switch (rule.type) {
    case 'required':
      s = `${label} is required`
      break
    case 'min':
    case 'max': {
      if (rule.value == null || rule.value === '' || !Number.isFinite(n)) return null
      const word = rule.type === 'min' ? 'at least' : 'at most'
      if (isNum) s = `${label} must be ${word} ${valueTextOf(field, n, L)}`
      else if (isText) s = `${label} must be ${word} ${n} characters long`
      else s = `${label} must be ${word} ${n} (characters, for text)`
      break
    }
    case 'regex':
      if (!rule.value) return null
      s = rule.message?.trim()
        ? `${label} must match a pattern (“${rule.message.trim()}”)`
        : `${label} must match the pattern ${String(rule.value)}`
      return end(rule.soft ? `${s} — a warning only` : s)
    case 'email':
      s = `${label} must be a valid email address`
      break
    case 'phone':
      s = `${label} must be a valid phone number`
      break
    case 'url':
      s = `${label} must be a full web address`
      break
    case 'min_days_from_today':
      if (!Number.isFinite(n) || rule.value === '' || rule.value == null) return null
      s = `${label} must be at least ${n} ${Math.abs(n) === 1 ? 'day' : 'days'} from today`
      break
    case 'max_days_from_today':
      if (!Number.isFinite(n) || rule.value === '' || rule.value == null) return null
      s = `${label} must be within ${n} ${Math.abs(n) === 1 ? 'day' : 'days'} of today`
      break
    case 'required_if': {
      if (!rule.field) return null
      // conditionMatches: eq compares String(v ?? ''), so '' means empty.
      const c = describeCondition(rule.field, rule.op ?? 'eq', rule.value, L)
      if (!c) return null
      s = `${label} is required when ${c}`
      break
    }
    case 'gte_field':
    case 'lte_field': {
      if (!rule.field) return null
      const other = fieldLabelOf(rule.field, L)
      const word = isNum
        ? rule.type === 'gte_field'
          ? 'at least'
          : 'at most'
        : rule.type === 'gte_field'
          ? 'on or after'
          : 'on or before'
      s = `${label} must be ${word} ${other}`
      break
    }
    default:
      return null
  }
  return end(rule.soft ? `${s} — a warning only, saving still works` : s)
}

export function describeValidationRules(
  rules: ValidationRuleLike[] | string | null | undefined,
  field: string,
  L: SentenceLabels = {}
): string[] {
  const list = parseList(rules as ValidationRuleLike[] | string | null)
  if (!list) return []
  return list.map((r) => describeValidationRule(r, field, L)).filter((s): s is string => !!s)
}

// ─── Show / lock conditions (field visibility_rules, lock_condition) ────────

export interface VisibilityRuleLike {
  when: string
  op: string
  value?: unknown
  action: 'show' | 'hide' | string
}

/**
 * Field visibility rules as isFieldVisible (hooks/useNivaroForm.ts) judges
 * them: any matching hide rule hides; with show rules present the field is
 * hidden unless one of them matches.
 */
export function describeVisibilityRules(
  rules: VisibilityRuleLike[] | string | null | undefined,
  field: string,
  L: SentenceLabels = {}
): string | null {
  const list = parseList(rules as VisibilityRuleLike[] | string | null)
  if (!list?.length) return null
  const show: string[] = []
  const hide: string[] = []
  for (const r of list) {
    if (!r?.when) return null
    const c = describeCondition(r.when, r.op, r.value, L)
    if (!c) return null
    if (r.action === 'show') show.push(c)
    else if (r.action === 'hide') hide.push(c)
    else return null
  }
  const label = fieldLabelOf(field, L)
  const parts: string[] = []
  if (show.length) parts.push(`${label} shows only when ${orList(show)}`)
  if (hide.length) parts.push(`${show.length ? 'it' : label} is hidden when ${orList(hide)}`)
  return parts.length ? end(parts.join('; ')) : null
}

export function describeLockCondition(
  cond: { when?: string; op?: string; value?: unknown } | string | null | undefined,
  field: string,
  L: SentenceLabels = {}
): string | null {
  const c = typeof cond === 'string' ? parseObj(cond) : cond
  if (!c?.when) return null
  const clause = describeCondition(String(c.when), c.op as string, c.value, L)
  if (!clause) return null
  return `${fieldLabelOf(field, L)} becomes read-only when ${clause}.`
}

/** A section's `visible_when` ([{field, op, value}], all must hold). */
export function describeSectionShowWhen(
  raw: unknown,
  sectionLabel: string,
  L: SentenceLabels = {}
): string | null {
  const list = parseList(raw as unknown[] | string | null) as Array<{
    field?: string
    op?: string
    value?: unknown
  }> | null
  if (!list?.length) return null
  const c = describeConditionList(list, L)
  return c ? `${sectionLabel} shows only when ${c}.` : null
}

// ─── Where does this field's value come from? (#10) ─────────────────────────

export interface FieldSourceInput {
  field: string
  computed_type?: string | null
  computed_formula?: string | null
  computed_store?: boolean | number | null
}

export interface FieldSource {
  /** The headline sentence ("Sum of Amount on Lines where …"). */
  sentence: string
  /** Extra lines (when it is recalculated, which records it applies to). */
  notes: string[]
  /** The inputs it reads, as labels. */
  inputs: string[]
}

const AGG_WORDS: Record<string, string> = {
  sum: 'Sum of',
  count: 'Number of',
  avg: 'Average of',
  min: 'Smallest',
  max: 'Largest',
  median: 'Median of',
  distinct_count: 'Number of different',
  weighted_avg: 'Weighted average of'
}

/** `{{price}} * {{qty}}` → "Price × Quantity". */
export function formulaInWords(formula: string, label: (field: string) => string): string {
  return formula
    .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_m, f: string) => label(f))
    .replace(/\bitem\.([A-Za-z_][A-Za-z0-9_]*)/g, (_m, f: string) => label(f))
    .replace(/\s*\*\s*/g, ' × ')
    .replace(/\s*\/\s*/g, ' ÷ ')
    .replace(/\s+/g, ' ')
    .trim()
}

function rollupSource(
  src: Record<string, unknown>,
  L: SentenceLabels
): { text: string; inputs: string[] } | null {
  const coll = typeof src.related_collection === 'string' ? src.related_collection : null
  const agg = typeof src.aggregate === 'string' ? src.aggregate : null
  if (!coll || !agg || !AGG_WORDS[agg]) return null
  const rows = collectionLabelOf(coll, L)
  const lbl = (f: string) => relatedFieldLabel(coll, f, L)
  const inputs: string[] = []
  let what: string
  if (agg === 'count') {
    what = `${rows} records`
  } else {
    const formula = typeof src.value_formula === 'string' ? src.value_formula.trim() : ''
    const vf = typeof src.value_field === 'string' ? src.value_field : ''
    if (formula) {
      what = `(${formulaInWords(formula, lbl)})`
      inputs.push(...formulaInputs(formula).map(lbl))
    } else if (vf) {
      what = lbl(vf)
      inputs.push(what)
    } else return null
    if (agg === 'weighted_avg') {
      const w = typeof src.weight_field === 'string' ? src.weight_field : ''
      if (!w) return null
      what = `${what} weighted by ${lbl(w)}`
      inputs.push(lbl(w))
    }
    what = `${what} on ${rows}`
  }
  const head = agg === 'distinct_count' ? `${AGG_WORDS[agg]} ${what}` : `${AGG_WORDS[agg]} ${what}`
  let filter = ''
  if (src.filter && typeof src.filter === 'object' && Object.keys(src.filter).length > 0) {
    // Only labels of the SOURCE collection apply here: this record's choice
    // and type maps are keyed by field name and would mislabel a same-named column.
    const relL: SentenceLabels = {
      fields: L.relatedFields?.[coll] ?? {},
      choices: L.relatedChoices?.[coll] ?? {},
      collections: L.collections,
      relatedFields: L.relatedFields
    }
    const f = describeFilterObject(src.filter, relL)
    if (!f) return null
    filter = ` where ${f}`
  }
  const deep = src.recursive ? ', counting every level below' : ''
  return { text: `${head}${filter}${deep}`, inputs }
}

/**
 * How a computed, rollup or lookup field gets its value. `crossDefaults` are
 * the OTHER fields' `cross_record_defaults` configs, so a field filled when a
 * link is picked says so. Null when the field is typed in by hand.
 */
export function describeFieldSource(
  field: FieldSourceInput,
  L: SentenceLabels = {},
  crossDefaults: Array<{ field: string; config: unknown }> = []
): FieldSource | null {
  const own = (f: string) => fieldLabelOf(f, L)
  const stored = field.computed_store === true || field.computed_store === 1
  switch (field.computed_type) {
    case 'rollup': {
      const raw = parseObj(field.computed_formula)
      if (!raw) return null
      const sources = Array.isArray(raw.sources)
        ? (raw.sources as Record<string, unknown>[])
        : [raw]
      const parts = sources.map((s) => rollupSource(s, L))
      if (!parts.length || parts.some((p) => !p)) return null
      const ok = parts as Array<{ text: string; inputs: string[] }>
      const notes: string[] = []
      if (ok.length > 1) notes.push('The figures above are added together.')
      const pf = raw.parent_filter
      if (pf && typeof pf === 'object' && Object.keys(pf).length > 0) {
        const c = describeFilterObject(pf, L)
        if (!c) return null
        notes.push(`Only for records where ${c}; on other records it is typed in by hand.`)
      }
      // computed_store unknown (the form's field rows do not carry it): say nothing.
      if (field.computed_store != null)
        notes.push(
          stored
            ? 'Saved on the record and recalculated when one of those records changes.'
            : 'Worked out each time the record is read.'
        )
      return {
        sentence: `${ok.map((p) => p.text).join(', plus ')}.`,
        notes,
        inputs: [...new Set(ok.flatMap((p) => p.inputs))]
      }
    }
    case 'lookup': {
      const cfg = parseObj(field.computed_formula)
      const fk = typeof cfg?.fk_field === 'string' ? cfg.fk_field : null
      const src = typeof cfg?.source_field === 'string' ? cfg.source_field : null
      if (!fk || !src) return null
      const target = L.links?.[fk]
      const srcLabel = target ? relatedFieldLabel(target, src, L) : titleCase(src)
      return {
        sentence: `Copied from the ${own(fk)}’s ${srcLabel} when ${own(fk)} is set.`,
        notes: [
          `It keeps the value it copied, even if the ${own(fk)} changes later; clearing ${own(fk)} clears it.`
        ],
        inputs: [own(fk)]
      }
    }
    case 'read':
    case 'write': {
      const f = String(field.computed_formula ?? '').trim()
      if (!f) return null
      const inputs = formulaInputs(f).map(own)
      return {
        sentence: `Worked out as ${formulaInWords(f, own)}.`,
        notes: [
          field.computed_type === 'read'
            ? 'Worked out each time the record is read; it is never saved.'
            : `Saved on the record; worked out again when ${inputs.length ? orList(inputs) : 'an input'} changes.`
        ],
        inputs
      }
    }
    default:
      break
  }
  for (const { field: link, config } of crossDefaults) {
    const cfg = parseObj(config)
    const map = parseObj(cfg?.field_map)
    const srcColl = typeof cfg?.source_collection === 'string' ? cfg.source_collection : null
    if (!map || !srcColl) continue
    const from = map[field.field]
    if (typeof from !== 'string' || !from.trim()) continue
    const linkField = typeof cfg?.source_fk_field === 'string' ? cfg.source_fk_field : link
    const choices = from
      .split('||')
      .map((s) => s.trim())
      .filter(Boolean)
    const names = choices.map((c) =>
      c === 'id' ? `the picked ${own(linkField)} itself` : relatedFieldLabel(srcColl, c, L)
    )
    const what =
      names.length === 1
        ? choices[0] === 'id'
          ? names[0]
          : `the ${own(linkField)}’s ${names[0]}`
        : `the ${own(linkField)}’s ${names[0]} (or ${orList(names.slice(1))} when that is empty)`
    const whenPicked =
      cfg?.on_write === false ? 'picked on the form' : 'set, on the form or through the API'
    return {
      sentence: `Filled from ${what} when ${own(linkField)} is ${whenPicked}.`,
      notes: ['You can change it afterwards; a value someone typed is never overwritten.'],
      inputs: [own(linkField)]
    }
  }
  return null
}

// ─── Change impact in words (#13) ────────────────────────────────────────────

export type FieldChange =
  | { kind: 'hide' }
  | { kind: 'require' }
  | { kind: 'readonly' }
  | { kind: 'rename'; to: string }
  | { kind: 'type'; from: string; to: string }

export interface FieldImpactInput {
  fieldLabel: string
  changes: FieldChange[]
  /** Names of the forms (layouts) that show the field. */
  forms: string[]
  /** Other settings that name the field (rules, queues, reports …). */
  otherRefs?: number
  /** Record counts; null/undefined = not counted. */
  records?: { total: number; with_value: number } | null
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

function formsText(forms: string[]): string {
  if (forms.length === 0) return ''
  const shown = forms.slice(0, 3).map((f) => `“${f}”`)
  const rest = forms.length - shown.length
  return `${plural(forms.length, 'form')} (${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''})`
}

/**
 * "This will hide Vendor on 3 forms (“Default”, “Intake”, “Phone”) and affect
 * 1,240 records that have a Vendor." `nonZero` = something is touched, so the
 * save should ask first.
 */
export function describeFieldChangeImpact(input: FieldImpactInput): {
  sentences: string[]
  nonZero: boolean
} {
  const { fieldLabel: f, changes, forms } = input
  const rec = input.records ?? null
  const withValue = rec ? Math.max(0, rec.with_value) : 0
  const empty = rec ? Math.max(0, rec.total - rec.with_value) : 0
  const on = forms.length ? ` on ${formsText(forms)}` : ''
  const out: string[] = []
  let touched = false
  for (const c of changes) {
    switch (c.kind) {
      case 'hide': {
        const recs =
          rec && withValue > 0 ? ` and affect ${plural(withValue, 'record')} that have a ${f}` : ''
        out.push(`This will hide ${f}${on || ' everywhere it shows'}${recs}.`)
        touched ||= forms.length > 0 || withValue > 0
        break
      }
      case 'require': {
        const recs =
          rec && empty > 0
            ? `; ${plural(empty, 'record')} of ${rec.total.toLocaleString('en-US')} have no ${f} yet`
            : ''
        out.push(`This will make ${f} required${on}${recs}.`)
        touched ||= forms.length > 0 || empty > 0
        break
      }
      case 'readonly': {
        const recs =
          rec && withValue > 0
            ? `; people can no longer change it on ${plural(withValue, 'record')}`
            : ''
        out.push(`This will make ${f} read-only${on}${recs}.`)
        touched ||= forms.length > 0 || withValue > 0
        break
      }
      case 'rename':
        out.push(`This will rename ${f} to ${c.to}${on}.`)
        touched ||= forms.length > 0
        break
      case 'type': {
        const recs =
          rec && withValue > 0
            ? ` for ${plural(withValue, 'record')} that have a value; values that do not fit ${c.to} may not convert`
            : ''
        out.push(`This will change ${f} from ${c.from} to ${c.to}${recs}.`)
        touched ||= withValue > 0 || forms.length > 0
        break
      }
    }
  }
  const others = input.otherRefs ?? 0
  if (out.length && others > 0) {
    out.push(`${plural(others, 'other setting')} also ${others === 1 ? 'names' : 'name'} ${f}.`)
    touched = true
  }
  return { sentences: out, nonZero: touched }
}

// ─── Labels from field rows ──────────────────────────────────────────────────

/**
 * The labels a builder already has (its collection's field rows and
 * relations) as SentenceLabels: field labels, types, choice labels
 * (`options.choices` or a bare choices array) and M2O link targets.
 */
export function sentenceLabelsFromFields(
  fields: Array<{ field: string; label?: string | null; type?: string | null; options?: unknown }>,
  relations: Array<{
    many_collection?: string | null
    many_field?: string | null
    one_collection?: string | null
    junction_field?: string | null
  }> = [],
  collection?: string | null,
  extra: SentenceLabels = {}
): SentenceLabels {
  const out: SentenceLabels = {
    ...extra,
    fields: { ...(extra.fields ?? {}) },
    types: { ...(extra.types ?? {}) },
    choices: { ...(extra.choices ?? {}) },
    links: { ...(extra.links ?? {}) }
  }
  for (const f of fields) {
    if (f.label?.trim()) (out.fields as Record<string, string>)[f.field] = f.label.trim()
    if (f.type) (out.types as Record<string, string>)[f.field] = f.type
    let opts: unknown = f.options
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts)
      } catch {
        opts = null
      }
    }
    const list = Array.isArray(opts)
      ? opts
      : opts && typeof opts === 'object'
        ? (opts as { choices?: unknown }).choices
        : null
    if (!Array.isArray(list)) continue
    const map: Record<string, string> = {}
    for (const c of list) {
      if (!c || typeof c !== 'object') continue
      const { value, text } = c as { value?: unknown; text?: unknown }
      if (value == null) continue
      map[String(value)] = choiceLabel(text == null ? String(value) : String(text))
    }
    if (Object.keys(map).length)
      (out.choices as Record<string, Record<string, string>>)[f.field] = map
  }
  for (const r of relations) {
    if (
      (!collection || r.many_collection === collection) &&
      r.many_field &&
      r.one_collection &&
      !r.junction_field
    )
      (out.links as Record<string, string>)[r.many_field] = r.one_collection
  }
  return out
}

/**
 * A field-wide change with no single kind (choices, cascade, validation):
 * "It is on 4 forms (“Default”, …) and 1,240 records have a Vendor." Null
 * when nothing was counted.
 */
export function describeFieldReach(input: {
  fieldLabel: string
  forms: string[]
  records?: { total: number; with_value: number } | null
}): string | null {
  const parts: string[] = []
  if (input.forms.length) parts.push(`It is on ${formsText(input.forms)}`)
  const n = input.records?.with_value ?? 0
  if (input.records && n > 0)
    parts.push(`${plural(n, 'record')} ${n === 1 ? 'has' : 'have'} a ${input.fieldLabel}`)
  if (!parts.length) return null
  return `${parts.join(' and ')}.`
}
