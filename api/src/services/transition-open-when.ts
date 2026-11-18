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
import type { db as Db } from '../db/index.js'
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
const NO_VALUE_OPS = new Set(['null', 'nnull', ...RELATED_OPS])
const STATE_OPS = new Set(['eq', 'neq', 'in'])
const PLAIN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The step keys a `$state` rule names, as the evaluator reads them: the
 *  whole value for eq / neq (compared exactly), the trimmed comma items for in. */
export function stateRuleKeys(r: Pick<ConditionRule, 'value' | 'op'>): string[] {
  const raw = r.value == null ? '' : String(r.value)
  if (r.op !== 'in') return raw === '' ? [] : [raw]
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

const CHILDREN_OPS = new Set(['children_in_state', 'children_not_in_state'])

/** Why a rule cannot be used in open_when, or null when it can. */
export function ruleProblem(r: unknown): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'a rule is not an object'
  const rule = r as Partial<ConditionRule>
  if (typeof rule.field !== 'string' || rule.field.trim() === '') return 'a rule has no field'
  // `$` names are the virtual facts, spelled exactly — `$State` is neither a
  // column nor the step, and must never be folded onto `$state`.
  if (
    rule.field.startsWith('$') &&
    rule.field !== STATE_FIELD &&
    rule.field !== ADDENDUM_ACTIVE_FIELD
  )
    return `"${rule.field}" is not a field (use $state or $addendum_active)`
  if (typeof rule.op !== 'string' || !CONDITION_RULE_OPS.has(rule.op))
    return `"${String(rule.op)}" is not a condition operator`
  // A child step key that is empty, misspelled or renamed matches no child,
  // and "none of the children are in it" would then hold for every record.
  if (CHILDREN_OPS.has(rule.op))
    return `${rule.op} cannot be used in "Anyone can make this move when…" — use linked rows instead`
  if (RELATED_OPS.has(rule.op)) {
    const m = RELATED_FIELD_RE.exec(rule.field)
    // A count over a system table always reads 0 — never a reason to open.
    if (!m) return `"${rule.field}" is not a linked table (<table>:<field>)`
    if (/^nivaro_/i.test(m[1])) return `linked rows of ${m[1]} cannot be counted`
    return null
  }
  // Every other op compares against a value: an empty one would make `neq`
  // true for every record (a renamed step, a half-typed rule) — unusable.
  if (!NO_VALUE_OPS.has(rule.op) && (rule.value == null || String(rule.value).trim() === ''))
    return `${rule.field} needs a value`
  if (rule.field === STATE_FIELD) {
    if (!STATE_OPS.has(rule.op)) return 'Current step takes is, is not or is one of'
    if (typeof rule.value !== 'string') return 'Current step needs a step key'
    // eq / neq compare the value as written: one exact key, no list.
    if (rule.op !== 'in' && (rule.value.includes(',') || rule.value !== rule.value.trim()))
      return 'Current step "is" / "is not" takes one step — use "is one of" for a list'
    if (stateRuleKeys(rule as ConditionRule).length === 0) return 'Current step needs a step key'
  }
  if (rule.field === ADDENDUM_ACTIVE_FIELD) {
    if (rule.op !== 'eq' && rule.op !== 'neq')
      return 'Addendum going through approval takes is / is not'
    if (!['true', 'false'].includes(String(rule.value)))
      return 'Addendum going through approval is true or false'
  }
  return null
}

const validRule = (r: unknown): r is ConditionRule => ruleProblem(r) === null

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
 * rules, all of which must hold. With `stateKeys` (the template's step keys),
 * a `$state` rule naming a step the template does not have makes the whole
 * set unusable (a renamed or imported key never opens a move).
 */
export function openWhenRulesFor(
  raw: unknown,
  collection: string,
  stateKeys?: Set<string>
): ConditionRule[] | null {
  const v = parsed(raw)
  if (v == null) return null
  let rules: ConditionRule[] | null
  if (Array.isArray(v)) {
    rules = ruleList(v)
    // A plain empty list is "not set", never "anyone".
    if (!rules || rules.length === 0) return null
  } else {
    if (typeof v !== 'object') return null
    const want = String(collection).toLowerCase()
    const hits = Object.keys(v as Record<string, unknown>).filter((k) => k.toLowerCase() === want)
    // Two entries for one collection (differing only in case) — which one
    // was meant is unknown: the owner rule.
    if (hits.length !== 1) return null
    const key = hits[0]
    rules = ruleList((v as Record<string, unknown>)[key])
    if (!rules) return null
  }
  if (stateKeys && !stateRulesKnown(rules, stateKeys)) return null
  return rules
}

/** Every `$state` value is EXACTLY a step key of the template — the evaluator
 *  compares as written, so a key in another case, with spaces or a list on
 *  is / is not would never equal the record's step (and `neq` would hold). */
export function stateRulesKnown(rules: ConditionRule[], stateKeys: Set<string>): boolean {
  return rules.every(
    (r) => r.field !== STATE_FIELD || stateRuleKeys(r).every((k) => stateKeys.has(k))
  )
}

/** Each `$state` value rewritten to the template's exact key (trimmed,
 *  case-blind match); null for a value with no such step. `in` lists are
 *  re-joined without spaces. */
export function canonicalStateRules(
  rules: ConditionRule[],
  stateKeys: Set<string>
): { rules: ConditionRule[]; unknown: string[] } {
  const byLower = new Map<string, string>()
  for (const k of stateKeys) byLower.set(k.toLowerCase(), k)
  const unknown: string[] = []
  const out = rules.map((r) => {
    if (r.field !== STATE_FIELD) return r
    const items =
      r.op === 'in'
        ? String(r.value ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : [String(r.value ?? '').trim()]
    const exact = items.map((k) => {
      const hit = byLower.get(k.toLowerCase())
      if (!hit) unknown.push(k)
      return hit ?? k
    })
    return { ...r, value: exact.join(',') }
  })
  return { rules: out, unknown }
}

/** Does any rule set of the value name `$state`? */
function namesState(raw: unknown): boolean {
  const v = parsed(raw)
  const lists = Array.isArray(v) ? [v] : v && typeof v === 'object' ? Object.values(v) : []
  return lists.some(
    (l) => Array.isArray(l) && l.some((r) => (r as ConditionRule | null)?.field === STATE_FIELD)
  )
}

/** Does the transition carry an open_when at all (any collection)? */
export function hasOpenWhen(raw: unknown): boolean {
  const v = parsed(raw)
  if (Array.isArray(v)) return v.length > 0
  return !!v && typeof v === 'object' && Object.keys(v as object).length > 0
}

/** `$addendum_active` is stored as the strings 'true' / 'false' only. */
function canonicalRule(r: unknown): unknown {
  if (!r || typeof r !== 'object') return r
  const rule = r as ConditionRule
  if (rule.field === ADDENDUM_ACTIVE_FIELD && typeof rule.value === 'boolean')
    return { ...rule, value: rule.value ? 'true' : 'false' }
  if (rule.field === STATE_FIELD && Array.isArray(rule.value))
    return { ...rule, value: (rule.value as unknown[]).map(String).join(',') }
  // A step key typed with spaces is stored trimmed (settleOpenWhen then makes
  // it the template's exact key); at judging, an untrimmed value is unusable.
  if (rule.field === STATE_FIELD && typeof rule.value === 'string')
    return { ...rule, value: rule.value.trim() }
  return rule
}

// Nothing is dropped: a rule with no field is refused, never cleaned away — a
// list that lost its rules would read as "anyone, always" (round 3).
const cleanList = (list: unknown[]) => list.map(canonicalRule)

/**
 * Store shape: a non-empty rule array, an object keyed by collection (each
 * value a rule array — [] kept: "anyone"), or null. Anything else → null
 * (with `error` set) so a bad payload never stores a half-read rule. Every
 * rule needs a value unless its op takes none; `$state` takes eq/neq/in with
 * step keys; `$addendum_active` takes eq/neq with 'true' / 'false'.
 */
export function normalizeOpenWhen(raw: unknown): { value: string | null; error?: string } {
  const v = parsed(raw)
  if (v == null) {
    if (typeof raw === 'string' && raw.trim() !== '')
      return { value: null, error: 'open_when is not valid JSON' }
    return { value: null }
  }
  if (Array.isArray(v)) {
    const cleaned = cleanList(v)
    if (cleaned.length === 0) return { value: null }
    const problem = cleaned.map(ruleProblem).find((p) => p !== null)
    if (problem) return { value: null, error: `open_when: ${problem}` }
    return { value: JSON.stringify(cleaned) }
  }
  if (typeof v !== 'object') return { value: null, error: 'open_when must be a list or a map' }
  const out: Record<string, ConditionRule[]> = {}
  const seen = new Set<string>()
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (!PLAIN_RE.test(k))
      return { value: null, error: `open_when names an unknown collection "${k}"` }
    if (seen.has(k.toLowerCase()))
      return { value: null, error: `open_when names the collection "${k}" twice` }
    seen.add(k.toLowerCase())
    if (!Array.isArray(list)) return { value: null, error: `open_when.${k} must be a list` }
    const cleaned = cleanList(list)
    const problem = cleaned.map(ruleProblem).find((p) => p !== null)
    if (problem) return { value: null, error: `open_when.${k}: ${problem}` }
    out[k] = cleaned as ConditionRule[]
  }
  return { value: Object.keys(out).length > 0 ? JSON.stringify(out) : null }
}

/** `$state` values in a stored open_when that are not EXACTLY steps of the
 *  template (what the evaluator compares). */
export function unknownStateKeys(raw: unknown, stateKeys: Set<string>): string[] {
  const v = parsed(raw)
  const lists = Array.isArray(v) ? [v] : v && typeof v === 'object' ? Object.values(v) : []
  const bad = new Set<string>()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const r of list as ConditionRule[])
      if (r?.field === STATE_FIELD)
        for (const k of stateRuleKeys(r)) if (!stateKeys.has(k)) bad.add(k)
  }
  return [...bad]
}

/** A normalized open_when with every `$state` value rewritten to the
 *  template's exact key; `unknown` = values that match no step. */
export function canonicalizeOpenWhenStates(
  value: string,
  stateKeys: Set<string>
): { value: string; unknown: string[] } {
  const v = parsed(value)
  const unknown: string[] = []
  const fix = (list: unknown) => {
    if (!Array.isArray(list)) return list
    const c = canonicalStateRules(list as ConditionRule[], stateKeys)
    unknown.push(...c.unknown)
    return c.rules
  }
  const out = Array.isArray(v)
    ? fix(v)
    : Object.fromEntries(Object.entries((v ?? {}) as object).map(([k, l]) => [k, fix(l)]))
  return { value: JSON.stringify(out), unknown: [...new Set(unknown)] }
}

/** A step key renamed: the stored open_when with `$state` values rewritten
 *  (null when nothing named the old key). */
export function renameStateKeyInOpenWhen(
  raw: unknown,
  oldKey: string,
  newKey: string
): string | null {
  const v = parsed(raw)
  // Any change counts, a case-only rename too: values are compared exactly.
  if (v == null || oldKey === newKey) return null
  let changed = false
  const fix = (list: unknown) =>
    Array.isArray(list)
      ? list.map((r) => {
          const rule = r as ConditionRule
          if (rule?.field !== STATE_FIELD) return r
          if (rule.op !== 'in') {
            if (rule.value !== oldKey) return r
            changed = true
            return { ...rule, value: newKey }
          }
          const next = String(rule.value ?? '')
            .split(',')
            .map((k) => {
              if (k.trim() !== oldKey) return k.trim()
              changed = true
              return newKey
            })
          return { ...rule, value: next.join(',') }
        })
      : list
  const out = Array.isArray(v)
    ? fix(v)
    : typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as object).map(([k, l]) => [k, fix(l)]))
      : v
  return changed ? JSON.stringify(out) : null
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
    if (RELATED_OPS.has(r.op)) {
      if (!Object.hasOwn(record, relatedCountKey(r.field, r.value))) return false
      return evalConditionRule(r, record)
    }
    // Column names are case-blind (SQL Server): `select *` answers in the
    // database's casing, the page batch in the rule's — both judge the same.
    const key = recordKey(record, r.field)
    if (key === null) return false
    return evalConditionRule(key === r.field ? r : { ...r, field: key }, record)
  })
}

/** The record key a field names: exact, else the one key equal ignoring case
 *  (two such keys = ambiguous = unknown). */
function recordKey(record: Record<string, unknown>, field: string): string | null {
  if (Object.hasOwn(record, field)) return field
  // Virtual facts and linked-row counts are exact names, never folded.
  if (field.startsWith('$') || field.includes(':')) return null
  const lower = field.toLowerCase()
  const hits = Object.keys(record).filter((k) => k.toLowerCase() === lower)
  return hits.length === 1 ? hits[0] : null
}

export type ConditionReader = typeof fetchRecordForConditions

export interface OpenWhenMove {
  id: unknown
  require_owner?: unknown
  open_when?: unknown
}

/** The options every open_when read uses: fail closed on everything unknown. */
export const OPEN_WHEN_READ = {
  strict: true,
  absentUnknown: true,
  strictFilters: true,
  noOverlay: true
} as const

/** State keys (lower-cased) of an instance's template; empty on failure. */
async function stateKeysOfInstance(instanceId: string | null | undefined): Promise<Set<string>> {
  if (!instanceId) return new Set()
  return new Set((await stateLabelsOfInstance(instanceId)).keys())
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
  /** The template's step keys (else read from the instance when a rule names `$state`). */
  stateKeys?: Set<string>
  database?: typeof Db
}): Promise<Set<string>> {
  const open = new Set<string>()
  const owner = opts.transitions.filter((t) => on(t.require_owner))
  if (owner.length === 0) return open
  const keys =
    opts.stateKeys ??
    (owner.some((t) => namesState(t.open_when))
      ? await stateKeysOfInstance(opts.instanceId)
      : undefined)
  const judged: Array<{ id: string; rules: ConditionRule[] }> = []
  for (const t of owner) {
    const rules = openWhenRulesFor(t.open_when, opts.collection, keys)
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
      {
        ...OPEN_WHEN_READ,
        instanceId: opts.instanceId ?? undefined,
        ...(opts.database ? { database: opts.database } : {})
      }
    )
  } catch {
    return open
  }
  // A record that could not be found has no id — nothing opens on it (the
  // virtual fields are added even then, so a key count cannot tell).
  if (!record || record.id == null) return open
  // The step read must be one of the instance template's steps (as the page
  // batch checks): a step from elsewhere is unknown, never "not at X".
  if (Object.hasOwn(record, STATE_FIELD)) {
    const at = record[STATE_FIELD]
    if (typeof at !== 'string' || !keys || !keys.has(at)) {
      record = { ...record }
      delete record[STATE_FIELD]
    }
  }
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
  stateKeys?: Set<string>
}): Promise<boolean> {
  const ids = await openTransitionIds({
    collection: opts.collection,
    item: opts.item,
    instanceId: opts.instanceId,
    transitions: [{ id: 'x', require_owner: true, open_when: opts.openWhen }],
    read: opts.read,
    stateKeys: opts.stateKeys
  })
  return ids.has('X')
}

/**
 * The steps `$state` rules are judged against: the INSTANCE's template (the
 * gate reads that one), reusing `loaded` when it is the same template as the
 * binding's, else one read. A failed read = no steps = `$state` rules unusable.
 */
export async function stepsOfInstanceTemplate(
  instanceTemplate: string,
  loadedTemplate: string,
  loaded: Array<{ key: string; label?: string | null }>,
  database?: typeof Db
): Promise<Array<{ key: string; label: string | null }>> {
  if (instanceTemplate.toUpperCase() === loadedTemplate.toUpperCase())
    return loaded.map((s) => ({ key: s.key, label: s.label ?? null }))
  const q = database ?? (await import('../db/index.js')).db
  return (await Promise.resolve()
    .then(() =>
      q('nivaro_workflow_states').where({ template: instanceTemplate }).select('key', 'label')
    )
    .catch(() => [])) as Array<{ key: string; label: string | null }>
}

// ── Saving ──────────────────────────────────────────────────────────────────

/**
 * The open_when to store for a transition: none unless the move is owner-only
 * (turning "Only the step's owner" off clears it, so turning it back on never
 * brings old rules back), a usable rule set (normalizeOpenWhen), and every
 * `$state` value a step of this template — a key that is not one would make
 * `neq` true for every record.
 */
export async function settleOpenWhen(
  templateId: string,
  raw: unknown,
  requireOwner: boolean,
  database?: typeof Db
): Promise<{ value: string | null; error?: string }> {
  if (!requireOwner) return { value: null }
  const normalized = normalizeOpenWhen(raw)
  if (normalized.error || !normalized.value) return normalized
  if (!namesState(normalized.value)) return normalized
  const q = database ?? (await import('../db/index.js')).db
  const keys = (await q('nivaro_workflow_states')
    .where({ template: templateId })
    .select('key')) as Array<{ key: string }>
  // Stored as the template's EXACT keys (the evaluator compares as written).
  const canon = canonicalizeOpenWhenStates(
    normalized.value,
    new Set(keys.map((k) => String(k.key)))
  )
  if (canon.unknown.length > 0)
    return {
      value: null,
      error: `open_when names a step that is not on this pipeline: ${canon.unknown.join(', ')}`
    }
  return { value: canon.value }
}

/**
 * What a transition PATCH writes to open_when: null (leave it) when neither
 * require_owner nor open_when is sent; cleared when require_owner is turned
 * off (the same write — re-enabling it never brings old rules back); else the
 * settled value of what was sent.
 */
export async function openWhenForPatch(
  opts: {
    templateId: string
    storedRequireOwner: unknown
    bodyRequireOwner: unknown
    bodyOpenWhen: unknown
  },
  database?: typeof Db
): Promise<{ value: string | null; error?: string } | null> {
  const requireOwner =
    opts.bodyRequireOwner !== undefined ? on(opts.bodyRequireOwner) : on(opts.storedRequireOwner)
  if (opts.bodyRequireOwner !== undefined && !requireOwner) return { value: null }
  if (opts.bodyOpenWhen === undefined) return null
  return settleOpenWhen(opts.templateId, opts.bodyOpenWhen, requireOwner, database)
}

/**
 * A step key renamed: rewrite `$state` values naming the old key in every
 * open_when of the template (run inside the rename's transaction). Returns how
 * many transitions changed. Rewriting, not refusing the rename: the rules
 * keep meaning the same step.
 */
export async function rewriteOpenWhenStateKey(
  trx: (table: string) => import('knex').Knex.QueryBuilder,
  templateId: string,
  oldKey: string,
  newKey: string
): Promise<number> {
  const { hasColumn } = await import('../lib/column-probe.js')
  if (!(await hasColumn('nivaro_workflow_transitions', 'open_when'))) return 0
  const rows = (await trx('nivaro_workflow_transitions')
    .where({ template: templateId })
    .whereNotNull('open_when')
    .select('id', 'open_when')) as Array<{ id: string; open_when: string | null }>
  let changed = 0
  for (const r of rows) {
    // Compare-and-set on the text read: a transition PATCH that lands between
    // the read and the write is never overwritten — the row is read again
    // and rewritten from what it holds now (a few tries, then left as is: a
    // key that no longer matches keeps that move owner-only, never opens it).
    let current: string | null = r.open_when
    for (let attempt = 0; attempt < 3 && current != null; attempt++) {
      const next = renameStateKeyInOpenWhen(current, oldKey, newKey)
      if (next === null) break
      const n = Number(
        await trx('nivaro_workflow_transitions')
          .where({ id: r.id, template: templateId, open_when: current })
          .update({ open_when: next })
      )
      if (n > 0) {
        changed++
        break
      }
      const fresh = (await trx('nivaro_workflow_transitions')
        .where({ id: r.id, template: templateId })
        .first('open_when')) as { open_when: string | null } | undefined
      current = fresh?.open_when ?? null
    }
  }
  return changed
}

// ── Pages of records ($workflow_instance lists) ─────────────────────────────

export interface OpenBatchEntry {
  /** The caller's key for the answer (an instance id). */
  key: string
  collection: string
  item: string
  instanceId: string
  /** The key of the step the instance sits in. */
  stateKey: string | null
  /** Every step key of the instance's template. */
  stateKeys: Set<string>
  moves: OpenWhenMove[]
}

const PER_ROW_AT_ONCE = 4

/**
 * openTransitionIds for a page of records, in a fixed number of reads: one
 * read of the plain columns the rules name (by id), one for addendums going
 * through approval, one count per linked table named without a filter, and
 * `$state` from the instance the caller already has. Only rules that need a
 * record of their own (a dotted path, a filtered count, an addendum's parent)
 * read per record, a few at a time. Reads go to `database` (dbRead); a read
 * that fails opens nothing for the records it covers.
 */
export async function openTransitionIdsBatch(
  entries: OpenBatchEntry[],
  database?: typeof Db
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const { ADDENDUM_COLLECTION } = await import('./pipeline-subject.js')
  type Judged = { e: OpenBatchEntry; rules: Array<{ id: string; rules: ConditionRule[] }> }
  const simple = new Map<string, Judged[]>()
  const perRow: OpenBatchEntry[] = []
  for (const e of entries) {
    const open = new Set<string>()
    out.set(e.key, open)
    const judged: Judged['rules'] = []
    for (const t of e.moves) {
      if (!on(t.require_owner)) continue
      const rules = openWhenRulesFor(t.open_when, e.collection, e.stateKeys)
      if (!rules) continue
      if (rules.length === 0) open.add(String(t.id).toUpperCase())
      else judged.push({ id: String(t.id).toUpperCase(), rules })
    }
    if (judged.length === 0) continue
    const own = (r: ConditionRule) =>
      r.field === STATE_FIELD ||
      r.field === ADDENDUM_ACTIVE_FIELD ||
      (e.collection !== ADDENDUM_COLLECTION &&
        (RELATED_OPS.has(r.op)
          ? (r.op === 'related_some' || r.op === 'related_none') &&
            (r.value == null || r.value === '')
          : PLAIN_RE.test(r.field)))
    if (judged.every((j) => j.rules.every(own))) {
      const list = simple.get(e.collection) ?? []
      list.push({ e, rules: judged })
      simple.set(e.collection, list)
    } else perRow.push(e)
  }

  const [{ db, dbRead }, { selectInChunks, whereInList }, { getPhysicalColumns }] =
    await Promise.all([
      import('../db/index.js'),
      import('./db-batch.js'),
      import('./collections.js')
    ])
  const q = database ?? dbRead ?? db

  for (const [collection, list] of simple) {
    try {
      const ids = [...new Set(list.map((j) => String(j.e.item)))]
      const all = list.flatMap((j) => j.rules.flatMap((r) => r.rules))
      const physical = await getPhysicalColumns(collection)
      const cols = [
        ...new Set(
          all
            .filter((r) => !RELATED_OPS.has(r.op) && PLAIN_RE.test(r.field) && r.field !== 'id')
            .map((r) => r.field)
            .filter((f) => physical?.has(f.toLowerCase()))
        )
      ]
      const rows = (await selectInChunks(ids, 2000, (chunk) =>
        whereInList(
          q(collection).select({ id: 'id', ...Object.fromEntries(cols.map((c) => [c, c])) }),
          'id',
          chunk
        )
      )) as Array<Record<string, unknown>>
      const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]))
      let active = new Set<string>()
      if (all.some((r) => r.field === ADDENDUM_ACTIVE_FIELD)) {
        const { addendumsInProgressFor } = await import('./addendum-summary.js')
        active = new Set(
          [...(await addendumsInProgressFor(collection, ids, q))].map((i) => i.toLowerCase())
        )
      }
      const counts = new Map<string, Map<string, number>>()
      for (const field of new Set(all.filter((r) => RELATED_OPS.has(r.op)).map((r) => r.field))) {
        const m = RELATED_FIELD_RE.exec(field)
        if (!m) continue
        const [, child, fk] = m
        const found = (await selectInChunks(ids, 2000, (chunk) =>
          whereInList(q(child), fk, chunk).groupBy(fk).select({ k: fk }).count({ c: '*' })
        )) as Array<{ k: unknown; c: unknown }>
        counts.set(field, new Map(found.map((f) => [String(f.k).toLowerCase(), Number(f.c)])))
      }
      for (const { e, rules } of list) {
        const row = byId.get(String(e.item).toLowerCase())
        if (!row) continue // no such record: nothing opens
        const record: Record<string, unknown> = { ...row }
        // A step the template does not list (or none) is unknown — left off.
        if (e.stateKey != null && e.stateKeys.has(e.stateKey)) record[STATE_FIELD] = e.stateKey
        record[ADDENDUM_ACTIVE_FIELD] = active.has(String(e.item).toLowerCase())
        for (const [field, m] of counts)
          record[relatedCountKey(field, null)] = m.get(String(e.item).toLowerCase()) ?? 0
        const open = out.get(e.key) as Set<string>
        for (const j of rules) if (openWhenHolds(j.rules, record)) open.add(j.id)
      }
    } catch {
      // A read that failed opens nothing beyond the moves open to anyone.
    }
  }

  for (let i = 0; i < perRow.length; i += PER_ROW_AT_ONCE) {
    await Promise.all(
      perRow.slice(i, i + PER_ROW_AT_ONCE).map(async (e) => {
        const ids = await openTransitionIds({
          collection: e.collection,
          item: e.item,
          instanceId: e.instanceId,
          transitions: e.moves,
          stateKeys: e.stateKeys,
          database: q
        }).catch(() => new Set<string>())
        const open = out.get(e.key) as Set<string>
        for (const id of ids) open.add(id)
      })
    )
  }
  return out
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

// The same reading as the evaluator and the editor's sentence (config-sentences
// describeOpenWhenRule): only 'true' (or true) is yes — normalizeOpenWhen stores no other form.
const yes = (v: unknown) => String(v) === 'true'

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

export const UNREADABLE_CONDITION = 'a condition this record doesn’t meet'

/** The rules in words ("the record is not at Waiting on PO and it has no …
 *  rows"); null for none. `stateLabels`: state key (any case) → label.
 *  `canRead`: a rule the viewer may not read (ruleReadJudge) is said as "a
 *  condition this record doesn't meet" — never its field or value. */
export function describeOpenWhen(
  rules: ConditionRule[] | null,
  stateLabels: Map<string, string> = new Map(),
  canRead: (r: ConditionRule) => boolean = () => true
): string | null {
  if (!rules || rules.length === 0) return null
  const lower = new Map([...stateLabels].map(([k, l]) => [k.toLowerCase(), l]))
  const label = (key: string) => stateLabels.get(key) ?? lower.get(key.toLowerCase()) ?? key
  const parts: string[] = []
  let hidden = false
  for (const r of rules) {
    if (canRead(r)) parts.push(ruleWords(r, label))
    else hidden = true
  }
  if (hidden) parts.push(UNREADABLE_CONDITION)
  return andList(parts)
}

/**
 * Which rules a viewer may see named in a refusal: administrators all; anyone
 * the step and addendum facts (they see the pipeline); a plain field only
 * when their read policy lists it; a linked-rows count only when they may
 * read that table; a dotted path, or a field read on an addendum's parent,
 * never (it reaches records the sentence cannot vouch for).
 */
export async function ruleReadJudge(
  viewer: { user?: { id?: unknown; role?: unknown } | null; isAdmin: boolean } | null | undefined,
  collection: string,
  rules: ConditionRule[]
): Promise<(r: ConditionRule) => boolean> {
  if (viewer?.isAdmin) return () => true
  const virtual = (r: ConditionRule) => r.field === STATE_FIELD || r.field === ADDENDUM_ACTIVE_FIELD
  const user = viewer?.user
  if (!user) return virtual
  const { can, getAllowedFields } = await import('./permissions.js')
  type U = Parameters<typeof getAllowedFields>[0]
  let fields: string[] | null = []
  try {
    fields = await getAllowedFields(user as U, 'read', collection)
  } catch {
    fields = []
  }
  const allFields = fields === null || fields.includes('*')
  const children = [
    ...new Set(rules.filter((r) => RELATED_OPS.has(r.op)).map((r) => r.field.split(':')[0]))
  ]
  const readableChild = new Set<string>()
  for (const c of children) {
    const ok = await can(user as U, 'read', c).catch(() => false)
    if (ok) readableChild.add(c)
  }
  const { ADDENDUM_COLLECTION } = await import('./pipeline-subject.js')
  return (r) => {
    if (virtual(r)) return true
    if (RELATED_OPS.has(r.op)) return readableChild.has(r.field.split(':')[0])
    if (r.field.includes('.') || collection === ADDENDUM_COLLECTION) return false
    return allFields || (fields ?? []).includes(r.field)
  }
}

/** EXACT state key → label for an instance's template (the keys are what
 *  `$state` rules must name); empty on failure. */
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
    for (const r of rows) if (r.key) out.set(String(r.key), r.label || r.key)
  } catch {
    // Words fall back to the keys.
  }
  return out
}
