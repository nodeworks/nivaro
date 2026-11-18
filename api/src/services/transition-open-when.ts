/**
 * "Anyone can make this move when…" — a transition's `open_when`
 * (migration 533). An owner-only move (`require_owner`) is open to anyone who
 * passes the other gates (role, record access, requirements, condition rules)
 * while its open_when holds for the record right now; otherwise the owner rule
 * applies exactly as before. Administrators are exempt either way.
 *
 * ONE rule, every path: the gates (manual-transition-gate, workflow-mutations,
 * bulk-actions) ask record-access `checkTransitionOwner({openWhen})`; the
 * lists that offer moves (pipeline instance route, `$workflow_instance`,
 * Command Center peek) ask `openTransitionIds` and pass it to
 * `offeredToActor`; the explanations (blocked-moves, denied-explain) say the
 * same sentence (`ownerOnlyMessage({openWhenWords})`).
 *
 * Stored shape (JSON text, the condition_rules format):
 *   - a rule array — applies to every collection bound to the template
 *   - an object keyed by collection — `{"workflows": [...], "nivaro_addendums": [...]}`
 *     (addendums can run the same template as their parent). A collection with
 *     no entry → the owner rule; an EMPTY list for a collection → anyone,
 *     always, on that collection.
 * A plain empty array is "not set" (normalizeOpenWhen stores null).
 *
 * FAIL CLOSED: unparsable JSON, a rule with no field or an unknown op, a rule
 * naming a field the moved record does not carry, a read that fails, a
 * related count on a system table — the move stays owner-only.
 */
import type { ConditionRule } from './workflow-conditions.js'
import {
  ADDENDUM_ACTIVE_FIELD,
  CONDITION_RULE_OPS,
  evalConditionRule,
  fetchRecordForConditions,
  RELATED_FIELD_RE,
  RELATED_OPS,
  relatedCountKey,
  STATE_FIELD
} from './workflow-conditions.js'

export { ADDENDUM_ACTIVE_FIELD, STATE_FIELD }

const on = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

function validRule(r: unknown): r is ConditionRule {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  const rule = r as Partial<ConditionRule>
  if (typeof rule.field !== 'string' || rule.field.trim() === '') return false
  if (typeof rule.op !== 'string' || !CONDITION_RULE_OPS.has(rule.op)) return false
  if (RELATED_OPS.has(rule.op)) {
    const m = RELATED_FIELD_RE.exec(rule.field)
    // A count over a system table always reads 0 — never a reason to open.
    if (!m || /^nivaro_/i.test(m[1])) return false
  }
  return true
}

/** A rule list, or null when it is not one or any rule is unusable. */
function ruleList(v: unknown): ConditionRule[] | null {
  if (!Array.isArray(v)) return null
  return v.every(validRule) ? (v as ConditionRule[]) : null
}

function parsed(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  if (raw.trim() === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * The open_when rules that apply to a record of `collection`:
 * null = the owner rule applies (not set, unusable, or no entry for this
 * collection); [] = anyone may make the move on this collection; else the
 * rules, all of which must hold.
 */
export function openWhenRulesFor(raw: unknown, collection: string): ConditionRule[] | null {
  const v = parsed(raw)
  if (v == null) return null
  if (Array.isArray(v)) {
    const rules = ruleList(v)
    // A plain empty list is "not set", never "anyone".
    return rules && rules.length > 0 ? rules : null
  }
  if (typeof v !== 'object') return null
  const want = String(collection).toLowerCase()
  const key = Object.keys(v as Record<string, unknown>).find((k) => k.toLowerCase() === want)
  if (key === undefined) return null
  return ruleList((v as Record<string, unknown>)[key])
}

/** Does the transition carry an open_when at all (any collection)? */
export function hasOpenWhen(raw: unknown): boolean {
  const v = parsed(raw)
  if (Array.isArray(v)) return v.length > 0
  return !!v && typeof v === 'object' && Object.keys(v as object).length > 0
}

/**
 * Store shape: a non-empty rule array, an object keyed by collection (each
 * value a rule array — [] kept: "anyone"), or null. Anything else → null
 * (with `error` set) so a bad payload never stores a half-read rule.
 */
export function normalizeOpenWhen(raw: unknown): { value: string | null; error?: string } {
  const v = parsed(raw)
  if (v == null) {
    if (typeof raw === 'string' && raw.trim() !== '')
      return { value: null, error: 'open_when is not valid JSON' }
    return { value: null }
  }
  if (Array.isArray(v)) {
    const cleaned = v.filter(
      (r) => !(r && typeof r === 'object' && String((r as ConditionRule).field ?? '').trim() === '')
    )
    if (cleaned.length === 0) return { value: null }
    if (!ruleList(cleaned))
      return { value: null, error: 'open_when has a rule that cannot be used' }
    return { value: JSON.stringify(cleaned) }
  }
  if (typeof v !== 'object') return { value: null, error: 'open_when must be a list or a map' }
  const out: Record<string, ConditionRule[]> = {}
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      return { value: null, error: `open_when names an unknown collection "${k}"` }
    if (!Array.isArray(list)) return { value: null, error: `open_when.${k} must be a list` }
    const cleaned = list.filter(
      (r) => !(r && typeof r === 'object' && String((r as ConditionRule).field ?? '').trim() === '')
    )
    if (!ruleList(cleaned))
      return { value: null, error: `open_when.${k} has a rule that cannot be used` }
    out[k] = cleaned as ConditionRule[]
  }
  return { value: Object.keys(out).length > 0 ? JSON.stringify(out) : null }
}

/**
 * Pure: do the rules hold for this resolved record (fetchRecordForConditions
 * with `absentUnknown`)? [] holds. A rule naming a field the record does not
 * carry fails — an unknown field never opens a move.
 */
export function openWhenHolds(rules: ConditionRule[], record: Record<string, unknown>): boolean {
  if (!record || typeof record !== 'object') return false
  return rules.every((r) => {
    if (!validRule(r)) return false
    const key = RELATED_OPS.has(r.op) ? relatedCountKey(r.field, r.value) : r.field
    if (!Object.hasOwn(record, key)) return false
    return evalConditionRule(r, record)
  })
}

export type ConditionReader = typeof fetchRecordForConditions

export interface OpenWhenMove {
  id: unknown
  require_owner?: unknown
  open_when?: unknown
}

/**
 * The owner-only moves (by upper-cased id) that are open to anyone on this
 * record right now. ONE record read for every move that has rules; a move
 * whose list for the collection is [] needs none. Any failure → none open.
 */
export async function openTransitionIds(opts: {
  collection: string
  item: string
  instanceId?: string | null
  transitions: OpenWhenMove[]
  read?: ConditionReader
}): Promise<Set<string>> {
  const open = new Set<string>()
  const judged: Array<{ id: string; rules: ConditionRule[] }> = []
  for (const t of opts.transitions) {
    if (!on(t.require_owner)) continue
    const rules = openWhenRulesFor(t.open_when, opts.collection)
    if (!rules) continue
    if (rules.length === 0) open.add(String(t.id).toUpperCase())
    else judged.push({ id: String(t.id).toUpperCase(), rules })
  }
  if (judged.length === 0) return open
  let record: Record<string, unknown>
  try {
    record = await (opts.read ?? fetchRecordForConditions)(
      opts.collection,
      String(opts.item),
      judged.map((j) => JSON.stringify(j.rules)),
      { strict: true, absentUnknown: true, instanceId: opts.instanceId ?? undefined }
    )
  } catch {
    return open
  }
  // A record that could not be found reads as {} — nothing opens on it.
  if (!record || Object.keys(record).length === 0) return open
  for (const j of judged) {
    try {
      if (openWhenHolds(j.rules, record)) open.add(j.id)
    } catch {
      // A rule that cannot be judged keeps the owner rule.
    }
  }
  return open
}

/** One move's open_when on one record. */
export async function openWhenHoldsOn(opts: {
  collection: string
  item: string
  instanceId?: string | null
  openWhen: unknown
  read?: ConditionReader
}): Promise<boolean> {
  const ids = await openTransitionIds({
    collection: opts.collection,
    item: opts.item,
    instanceId: opts.instanceId,
    transitions: [{ id: 'x', require_owner: true, open_when: opts.openWhen }],
    read: opts.read
  })
  return ids.has('X')
}

// ── Words ───────────────────────────────────────────────────────────────────

const words = (s: string) =>
  s
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())

const orList = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
const andList = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

const yes = (v: unknown) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'

function ruleWords(r: ConditionRule, stateLabel: (key: string) => string): string {
  const value = r.value == null ? '' : String(r.value)
  if (r.field === STATE_FIELD) {
    const list = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(stateLabel)
    if (r.op === 'eq') return `the record is at ${list[0] ?? 'that step'}`
    if (r.op === 'neq') return `the record is not at ${list[0] ?? 'that step'}`
    if (r.op === 'in') return `the record is at ${orList(list)}`
  }
  if (r.field === ADDENDUM_ACTIVE_FIELD && (r.op === 'eq' || r.op === 'neq')) {
    const active = r.op === 'eq' ? yes(r.value) : !yes(r.value)
    return active
      ? 'an addendum is going through approval'
      : 'no addendum is going through approval'
  }
  if (r.op === 'related_some' || r.op === 'related_none') {
    const child = words(r.field.split(':')[0] ?? r.field)
    const matching = r.value ? 'matching ' : ''
    return r.op === 'related_some'
      ? `it has ${matching}${child} rows`
      : `it has no ${matching}${child} rows`
  }
  const f = words(r.field.split('.').join(' '))
  switch (r.op) {
    case 'null':
      return `${f} is empty`
    case 'nnull':
      return `${f} is set`
    case 'eq':
      return `${f} is ${value}`
    case 'neq':
      return `${f} is not ${value}`
    case 'in':
      return `${f} is ${orList(value.split(',').map((s) => s.trim()))}`
    case 'gt':
      return `${f} is over ${value}`
    case 'gte':
      return `${f} is at least ${value}`
    case 'lt':
      return `${f} is under ${value}`
    case 'lte':
      return `${f} is at most ${value}`
    case 'contains':
      return `${f} contains “${value}”`
    default:
      return `${f} ${r.op.replace(/_/g, ' ')} ${value}`.trim()
  }
}

/** The rules in words ("the record is not at Waiting on PO and it has no …
 *  rows"); null for none. `stateLabels`: state key (any case) → label. */
export function describeOpenWhen(
  rules: ConditionRule[] | null,
  stateLabels: Map<string, string> = new Map()
): string | null {
  if (!rules || rules.length === 0) return null
  const label = (key: string) => stateLabels.get(key.toLowerCase()) ?? key
  return andList(rules.map((r) => ruleWords(r, label)))
}

/** State key (lower-cased) → label for an instance's template; empty on failure. */
export async function stateLabelsOfInstance(instanceId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const { db } = await import('../db/index.js')
    const inst = (await db('nivaro_workflow_instances')
      .where({ id: instanceId })
      .first('template')) as { template?: string } | undefined
    if (!inst?.template) return out
    const rows = (await db('nivaro_workflow_states')
      .where({ template: inst.template })
      .select('key', 'label')) as Array<{ key: string; label: string | null }>
    for (const r of rows) if (r.key) out.set(String(r.key).toLowerCase(), r.label || r.key)
  } catch {
    // Words fall back to the keys.
  }
  return out
}
