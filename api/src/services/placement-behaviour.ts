/**
 * Placement behaviour — per-placement settings a layout stores in a
 * placement's `overrides` JSON that change how a field behaves on a live
 * record (#2703 #2704 #2705 #2706 #2709 #2712). Pure: the record page, the
 * read view and the layout editor (client) and the PDF renderer and the
 * field-config formatter (server) read the same rules from here.
 *
 * TWIN FILE: api/src/services/placement-behaviour.ts and
 * packages/shared/src/lib/placement-behaviour.ts must stay byte-identical
 * (the API cannot import packages/shared; an API test compares the two
 * files). No imports.
 *
 * Keys (all optional, all inside `overrides`):
 * - `text_rules` [{type: 'pipeline_state' | 'role', pipeline_id?, state_keys?,
 *   role_ids?, label?, note?}] — the label and help text change with the
 *   record's pipeline state or the viewer's role. The first matching rule
 *   that sets a label wins the label; the same for the help text.
 * - `recommended: true` — soft-required: an amber marker and a nudge on
 *   save, never a block. Ignored while the placement is required.
 * - `confirm_change: {state_keys?: string[]}` — changing the value of an
 *   existing record asks "Are you sure?" and a reason (stored with the
 *   revision). No state keys = in every state.
 * - `repeat_last: true` — a button that fills the value this person entered
 *   on their previous record of the collection.
 * - `counter: {unit: 'characters' | 'words', limit?: number}` — a counter
 *   under a long-text input; over the limit blocks the save.
 * - `display_formula: {expr, format?, currency?}` on a `__calc_<name>__`
 *   placement — a read-only value computed from the form's fields in the
 *   browser, never stored.
 */

export interface TextRule {
  type: 'pipeline_state' | 'role'
  pipeline_id?: string
  state_keys?: string[]
  role_ids?: string[]
  label?: string
  note?: string
}

/** Who is looking and where the record stands: the inputs text rules read. */
export interface TextContext {
  stateKey: string | null
  roleId: string | null
}

export interface CounterConfig {
  unit: 'characters' | 'words'
  /** null = no limit, the counter only counts. */
  limit: number | null
}

export type DisplayFormat = '' | 'integer' | 'number' | 'currency' | 'percent'

export interface DisplayFormula {
  expr: string
  format: DisplayFormat
  /** ISO code for format 'currency' (default USD). */
  currency: string | null
}

type Obj = Record<string, unknown>

/** The placement's overrides as an object, whether stored as JSON text or parsed. */
export function overridesObject(ov: unknown): Obj {
  if (typeof ov === 'string') {
    try {
      const parsed = JSON.parse(ov)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Obj) : {}
    } catch {
      return {}
    }
  }
  return ov && typeof ov === 'object' && !Array.isArray(ov) ? (ov as Obj) : {}
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

// ── #2703 labels and help by state or role ──────────────────────────────────

export function textRulesOf(ov: unknown): TextRule[] {
  const raw = overridesObject(ov).text_rules
  if (!Array.isArray(raw)) return []
  const out: TextRule[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Obj
    const type = o.type === 'role' ? 'role' : o.type === 'pipeline_state' ? 'pipeline_state' : null
    if (!type) continue
    const rule: TextRule = { type }
    if (typeof o.pipeline_id === 'string' && o.pipeline_id) rule.pipeline_id = o.pipeline_id
    if (type === 'pipeline_state') rule.state_keys = strList(o.state_keys)
    else rule.role_ids = strList(o.role_ids)
    const label = text(o.label)
    const note = text(o.note)
    if (label !== undefined) rule.label = label
    if (note !== undefined) rule.note = note
    out.push(rule)
  }
  return out
}

/** A rule applies when the record's state (or the viewer's role) is one it names. */
export function textRuleMatches(rule: TextRule, ctx: TextContext): boolean {
  if (rule.type === 'pipeline_state') {
    const keys = rule.state_keys ?? []
    return !!ctx.stateKey && keys.includes(ctx.stateKey)
  }
  const ids = (rule.role_ids ?? []).map((id) => id.toUpperCase())
  return !!ctx.roleId && ids.includes(ctx.roleId.toUpperCase())
}

/**
 * The label and help text the rules give this placement for `ctx`. A key is
 * present only when a rule supplies it; absent = the placement's own text.
 */
export function resolvePlacementText(
  ov: unknown,
  ctx: TextContext
): { label?: string; note?: string } {
  const out: { label?: string; note?: string } = {}
  for (const rule of textRulesOf(ov)) {
    if (!textRuleMatches(rule, ctx)) continue
    if (out.label === undefined && rule.label !== undefined) out.label = rule.label
    if (out.note === undefined && rule.note !== undefined) out.note = rule.note
    if (out.label !== undefined && out.note !== undefined) break
  }
  return out
}

// ── #2704 soft-required ─────────────────────────────────────────────────────

export function isRecommended(ov: unknown): boolean {
  const o = overridesObject(ov)
  return o.recommended === true && o.required !== true
}

/** Empty the way a required check reads it (false counts as unanswered there too). */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  return typeof v === 'string' && v.trim() === ''
}

// ── #2705 confirm and give a reason on change ───────────────────────────────

export function confirmChangeOf(ov: unknown): { state_keys: string[] } | null {
  const raw = overridesObject(ov).confirm_change
  if (raw === true) return { state_keys: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return { state_keys: strList((raw as Obj).state_keys) }
}

/** Does a change to this placement's value need a confirm + reason in `stateKey`? */
export function confirmChangeApplies(ov: unknown, stateKey: string | null): boolean {
  const cfg = confirmChangeOf(ov)
  if (!cfg) return false
  if (cfg.state_keys.length === 0) return true
  return !!stateKey && cfg.state_keys.includes(stateKey)
}

// ── #2706 repeat last value ─────────────────────────────────────────────────

export function repeatLastOf(ov: unknown): boolean {
  return overridesObject(ov).repeat_last === true
}

// ── #2709 character and word counters ───────────────────────────────────────

export const COUNTER_LIMIT_MAX = 1_000_000

export function counterOf(ov: unknown): CounterConfig | null {
  const raw = overridesObject(ov).counter
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Obj
  const n = Number(o.limit)
  return {
    unit: o.unit === 'words' ? 'words' : 'characters',
    limit:
      o.limit != null && o.limit !== '' && Number.isFinite(n) && n > 0
        ? Math.min(COUNTER_LIMIT_MAX, Math.floor(n))
        : null
  }
}

/** Rich text counts its words, not its markup. */
function plainText(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (!/<[a-z!/][^>]*>/i.test(s)) return s
  return s
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, 'x')
}

export function countValue(v: unknown, unit: CounterConfig['unit']): number {
  const s = plainText(v)
  if (unit === 'words') {
    const t = s.trim()
    return t ? t.split(/\s+/).length : 0
  }
  return s.length
}

/** near = 90% of the limit or more; over = past it. */
export function counterState(n: number, limit: number | null): 'ok' | 'near' | 'over' {
  if (limit == null) return 'ok'
  if (n > limit) return 'over'
  return n >= limit * 0.9 ? 'near' : 'ok'
}

/** The save-blocking message for a value over its limit, or null. */
export function counterError(v: unknown, ov: unknown, label: string): string | null {
  const cfg = counterOf(ov)
  if (!cfg || cfg.limit == null) return null
  const n = countValue(v, cfg.unit)
  if (n <= cfg.limit) return null
  return `${label} is over its limit of ${cfg.limit.toLocaleString('en-US')} ${cfg.unit} (${n.toLocaleString('en-US')})`
}

// ── #2712 layout-only display formulas ──────────────────────────────────────

const DISPLAY_FIELD_RE = /^__calc_[a-z0-9_]{1,40}__$/

/** A `__calc_<name>__` placement: a display formula, not a column. */
export function isDisplayFormulaField(field: string): boolean {
  return DISPLAY_FIELD_RE.test(field)
}

/** A free `__calc_<n>__` name for a new display formula on this layout. */
export function nextDisplayFormulaField(existing: Iterable<string>): string {
  const taken = new Set(existing)
  for (let i = 1; ; i++) {
    const name = `__calc_${i}__`
    if (!taken.has(name)) return name
  }
}

const FORMATS: DisplayFormat[] = ['', 'integer', 'number', 'currency', 'percent']

export function displayFormulaOf(ov: unknown): DisplayFormula | null {
  const raw = overridesObject(ov).display_formula
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Obj
  const format = FORMATS.includes(o.format as DisplayFormat) ? (o.format as DisplayFormat) : ''
  const currency =
    typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency) ? o.currency : null
  return { expr: typeof o.expr === 'string' ? o.expr : '', format, currency }
}

/** How a display formula's number reads. null (no value) is a dash. */
export function formatDisplayValue(
  n: number | null,
  df: Pick<DisplayFormula, 'format' | 'currency'>
): string {
  if (n == null || !Number.isFinite(n)) return '—'
  switch (df.format) {
    case 'integer':
      return Math.round(n).toLocaleString('en-US')
    case 'currency':
      try {
        return n.toLocaleString('en-US', { style: 'currency', currency: df.currency || 'USD' })
      } catch {
        return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      }
    case 'percent':
      return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
    case 'number':
      return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    default:
      return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  }
}
