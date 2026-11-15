/**
 * Status badges in pickers (realtime round 6, item 12).
 *
 * A record offered by a dropdown — or already picked into a field or a chip — can carry one or
 * two short badges: "On hold", "Closed", "Over budget", "Inactive", "Hidden from pickers". What
 * means what is per-collection config, `nivaro_collections.browser_config.picker_badges`:
 *
 *   { mode: 'auto' }                     → derived defaults (absent = auto)
 *   { mode: 'custom', rules: [...] }     → the admin's own rules
 *   { mode: 'off' }                      → no badges
 *
 * Automatic rules come from the table itself: a pipeline binding gives "Closed" (final steps) and
 * "On hold" (a step whose key or name says hold / paused / suspended); yes/no columns named like
 * `is_active` / `archived` give "Inactive"; `over_budget` / `is_over_budget` gives "Over budget";
 * a record hidden from pickers says so (only ever seen on a value already picked — option lists
 * leave hidden records out).
 *
 * Badges are judged AS THE VIEWER: the rows are read through readItems with the caller's own
 * permissions (row filters, User Scopes), a rule naming a field the caller may not read is
 * skipped, and ids the caller cannot see answer nothing. Pure helpers live here; the read is the
 * route's (routes/picker-badges.ts).
 */

export type BadgeTone = 'neutral' | 'amber' | 'red' | 'muted'
export type BadgeOp = 'is_true' | 'is_false' | 'eq' | 'neq' | 'in' | 'gt' | 'lt' | 'gt_field'

export interface BadgeWhen {
  /** Pipeline step keys this badge names. */
  states?: string[]
  /** Any final pipeline step. */
  terminal?: boolean
  /** A step whose key or name says hold / paused / suspended. */
  hold?: boolean
  /** Hidden from pickers (nivaro_picker_exclusions). */
  hidden?: boolean
  /** A column test. */
  field?: string
  op?: BadgeOp
  value?: unknown
  /** gt_field: the column the field is compared with (spent > budget). */
  other?: string
}

export interface BadgeRule {
  key: string
  label: string
  tone: BadgeTone
  when: BadgeWhen
}

export type BadgeMode = 'auto' | 'custom' | 'off'

export interface PickerBadgeSetting {
  mode: BadgeMode
  rules: BadgeRule[]
}

export interface PickerBadge {
  key: string
  label: string
  tone: BadgeTone
}

/** Most badges one record shows (the first rules win). */
export const MAX_BADGES = 2
/** Most rules a collection may carry. */
export const MAX_RULES = 12
/** Most ids one request may ask about. */
export const MAX_BADGE_IDS = 200

const TONES = new Set<BadgeTone>(['neutral', 'amber', 'red', 'muted'])
const OPS = new Set<BadgeOp>(['is_true', 'is_false', 'eq', 'neq', 'in', 'gt', 'lt', 'gt_field'])
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseObject(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v) as unknown
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function normalizeWhen(raw: unknown): BadgeWhen | null {
  const w = parseObject(raw)
  if (!w) return null
  if (w.hidden === true) return { hidden: true }
  if (w.terminal === true) return { terminal: true }
  if (w.hold === true) return { hold: true }
  if (Array.isArray(w.states)) {
    const states = [
      ...new Set(w.states.filter((s): s is string => typeof s === 'string' && s.length > 0))
    ].slice(0, 50)
    return states.length ? { states } : null
  }
  if (typeof w.field === 'string' && PLAIN.test(w.field)) {
    const op = (OPS.has(w.op as BadgeOp) ? w.op : 'is_true') as BadgeOp
    const out: BadgeWhen = { field: w.field, op }
    if (op === 'gt_field') {
      if (typeof w.other !== 'string' || !PLAIN.test(w.other)) return null
      out.other = w.other
    } else if (op === 'in') {
      if (!Array.isArray(w.value)) return null
      out.value = w.value.filter((x) => typeof x === 'string' || typeof x === 'number').slice(0, 50)
    } else if (op === 'eq' || op === 'neq' || op === 'gt' || op === 'lt') {
      const v = w.value
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null
      out.value = v
    }
    return out
  }
  return null
}

/** One stored rule → a rule consumers can trust, or null. */
export function normalizeBadgeRule(raw: unknown): BadgeRule | null {
  const r = parseObject(raw)
  if (!r) return null
  const label = typeof r.label === 'string' ? r.label.trim().slice(0, 40) : ''
  if (!label) return null
  const when = normalizeWhen(r.when)
  if (!when) return null
  const key =
    typeof r.key === 'string' && /^[a-z0-9_]{1,40}$/.test(r.key)
      ? r.key
      : label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 40) || 'badge'
  const tone = TONES.has(r.tone as BadgeTone) ? (r.tone as BadgeTone) : 'neutral'
  return { key, label, tone, when }
}

/** `browser_config.picker_badges` (JSON text or object). Missing / malformed = automatic. */
export function parsePickerBadges(browserConfig: unknown): PickerBadgeSetting {
  const bc = parseObject(browserConfig)
  const raw = parseObject(bc?.picker_badges)
  if (!raw) return { mode: 'auto', rules: [] }
  const mode: BadgeMode = raw.mode === 'off' ? 'off' : raw.mode === 'custom' ? 'custom' : 'auto'
  const rules = Array.isArray(raw.rules)
    ? raw.rules
        .map(normalizeBadgeRule)
        .filter((r): r is BadgeRule => !!r)
        .slice(0, MAX_RULES)
    : []
  return { mode, rules: mode === 'custom' ? rules : [] }
}

/** What a stored value looks like (null = automatic, the default). */
export function pickerBadgesForStorage(s: PickerBadgeSetting): Record<string, unknown> | null {
  if (s.mode === 'auto') return null
  if (s.mode === 'off') return { mode: 'off' }
  return {
    mode: 'custom',
    rules: s.rules
      .map(normalizeBadgeRule)
      .filter((r): r is BadgeRule => !!r)
      .slice(0, MAX_RULES)
  }
}

export interface BadgeTableFacts {
  /** The collection is bound to a pipeline. */
  pipeline: boolean
  /** Its columns (name + type). */
  fields: Array<{ field: string; type?: string | null }>
}

const ACTIVE_TRUE = ['is_active', 'active', 'enabled', 'is_enabled']
const INACTIVE_TRUE = [
  'is_inactive',
  'inactive',
  'archived',
  'is_archived',
  'disabled',
  'is_disabled'
]
const OVER_BUDGET = ['over_budget', 'is_over_budget']

const isBoolField = (f: { type?: string | null }) =>
  /^(boolean|bool|bit)$/i.test(String(f.type ?? ''))

/** The badges a collection gets when nobody configured it. */
export function defaultBadgeRules(facts: BadgeTableFacts): BadgeRule[] {
  const rules: BadgeRule[] = [
    { key: 'hidden', label: 'Hidden from pickers', tone: 'muted', when: { hidden: true } }
  ]
  if (facts.pipeline) {
    // Closed first: a final step that also reads "hold" says Closed only.
    rules.push({ key: 'closed', label: 'Closed', tone: 'neutral', when: { terminal: true } })
    rules.push({ key: 'on_hold', label: 'On hold', tone: 'amber', when: { hold: true } })
  }
  const bools = new Map(
    facts.fields.filter(isBoolField).map((f) => [f.field.toLowerCase(), f.field])
  )
  const over = OVER_BUDGET.map((n) => bools.get(n)).find(Boolean)
  if (over) {
    rules.push({
      key: 'over_budget',
      label: 'Over budget',
      tone: 'red',
      when: { field: over, op: 'is_true' }
    })
  }
  const active = ACTIVE_TRUE.map((n) => bools.get(n)).find(Boolean)
  const inactive = INACTIVE_TRUE.map((n) => bools.get(n)).find(Boolean)
  if (active) {
    rules.push({
      key: 'inactive',
      label: 'Inactive',
      tone: 'neutral',
      when: { field: active, op: 'is_false' }
    })
  } else if (inactive) {
    rules.push({
      key: 'inactive',
      label: /archiv/i.test(inactive) ? 'Archived' : 'Inactive',
      tone: 'neutral',
      when: { field: inactive, op: 'is_true' }
    })
  }
  return rules
}

/** The rules that apply to a collection. */
export function effectiveBadgeRules(setting: PickerBadgeSetting, facts: BadgeTableFacts) {
  if (setting.mode === 'off') return []
  if (setting.mode === 'custom') return setting.rules
  return defaultBadgeRules(facts)
}

/** Columns a rule reads (none for state / hidden rules). */
export function ruleColumns(rule: BadgeRule): string[] {
  const w = rule.when
  if (!w.field) return []
  return w.op === 'gt_field' && w.other ? [w.field, w.other] : [w.field]
}

/**
 * The rules the viewer may be judged by: a rule whose column the viewer cannot read — or the
 * table does not have — is dropped, so a badge never says something the viewer could not read
 * for themselves. `allowed` null = every column.
 */
export function rulesForViewer(
  rules: BadgeRule[],
  allowed: string[] | null,
  columns: Set<string>
): BadgeRule[] {
  const ok = (c: string) => columns.has(c) && (allowed === null || allowed.includes(c))
  return rules.filter((r) => ruleColumns(r).every(ok))
}

export interface BadgeNeeds {
  fields: string[]
  state: boolean
  hidden: boolean
}

export function badgeNeeds(rules: BadgeRule[]): BadgeNeeds {
  const fields = new Set<string>()
  let state = false
  let hidden = false
  for (const r of rules) {
    for (const c of ruleColumns(r)) fields.add(c)
    if (r.when.hidden) hidden = true
    if (r.when.terminal || r.when.hold || r.when.states) state = true
  }
  return { fields: [...fields], state, hidden }
}

/** What a client listens for: the columns and aspects that can move a badge. */
export function badgeWatch(needs: BadgeNeeds): string[] {
  return [...needs.fields, ...(needs.state ? ['$state'] : []), ...(needs.hidden ? ['$picker'] : [])]
}

const HOLD = /(^|[^a-z])(on[_\s-]?hold|hold|paused|suspended)([^a-z]|$)/i

export interface StateLike {
  key?: string | null
  label?: string | null
  is_terminal?: boolean | null
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
const falsy = (v: unknown) => v === false || v === 0 || v === '0' || v === 'false'
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

/** Does one rule hold for this row? */
export function ruleMatches(rule: BadgeRule, row: Record<string, unknown>, hidden: boolean) {
  const w = rule.when
  if (w.hidden) return hidden
  if (w.terminal || w.hold || w.states) {
    const st = row.$state as StateLike | null | undefined
    if (!st || typeof st !== 'object') return false
    if (w.terminal) return st.is_terminal === true
    if (w.hold) return HOLD.test(String(st.key ?? '')) || HOLD.test(String(st.label ?? ''))
    return !!st.key && (w.states ?? []).includes(String(st.key))
  }
  if (!w.field) return false
  const v = row[w.field]
  switch (w.op ?? 'is_true') {
    case 'is_true':
      return truthy(v)
    case 'is_false':
      // A blank yes/no is not "No": an unset is_active never says Inactive.
      return falsy(v)
    case 'eq':
      return same(v, w.value)
    case 'neq':
      return v != null && !same(v, w.value)
    case 'in':
      return Array.isArray(w.value) && w.value.some((x) => same(v, x))
    case 'gt': {
      const a = num(v)
      const b = num(w.value)
      return a !== null && b !== null && a > b
    }
    case 'lt': {
      const a = num(v)
      const b = num(w.value)
      return a !== null && b !== null && a < b
    }
    case 'gt_field': {
      const a = num(v)
      const b = num(w.other ? row[w.other] : null)
      return a !== null && b !== null && a > b
    }
  }
  return false
}

/** The badges one row carries, first rules first, at most MAX_BADGES, one per key. */
export function evaluateBadges(
  rules: BadgeRule[],
  row: Record<string, unknown>,
  hidden: boolean
): PickerBadge[] {
  const out: PickerBadge[] = []
  const keys = new Set<string>()
  for (const r of rules) {
    if (out.length >= MAX_BADGES) break
    if (keys.has(r.key)) continue
    // "Closed" already says more than "On hold" on a final step named "Closed - on hold".
    if (r.when.hold && keys.has('closed')) continue
    if (!ruleMatches(r, row, hidden)) continue
    keys.add(r.key)
    out.push({ key: r.key, label: r.label, tone: r.tone })
  }
  return out
}
