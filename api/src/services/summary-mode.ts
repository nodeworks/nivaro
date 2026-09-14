/**
 * Summary Mode rules — server-side validation + parsing of
 * `nivaro_collections.summary_mode_rules` (migration 310). The client
 * evaluator lives in packages/shared/src/lib/summary-mode.ts; both must agree
 * on the shape.
 *
 *   { default: 'edit' | 'summary',
 *     rules: [{ roles?: uuid[], states?: key[], states_op?: 'in'|'not_in',
 *               mode: 'edit' | 'summary' }] }
 */

export type SummaryMode = 'summary' | 'edit'

export interface SummaryModeRule {
  roles: string[] | null
  states: string[] | null
  states_op: 'in' | 'not_in'
  mode: SummaryMode
}

export interface SummaryModeRules {
  default: SummaryMode
  rules: SummaryModeRule[]
}

export const NO_STATE = '__none__'
const MAX_RULES = 20
const MAX_LIST = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_KEY_RE = /^[A-Za-z0-9_\-:.]{1,100}$/

export const EMPTY_RULES: SummaryModeRules = { default: 'edit', rules: [] }

/** Lenient read: a stored column → config, never throws (bad JSON → empty). */
export function parseSummaryModeRules(raw: unknown): SummaryModeRules {
  if (raw == null || raw === '') return EMPTY_RULES
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return EMPTY_RULES
    }
  }
  if (!obj || typeof obj !== 'object') return EMPTY_RULES
  const o = obj as { default?: unknown; rules?: unknown }
  const rules: SummaryModeRule[] = []
  if (Array.isArray(o.rules)) {
    for (const r of o.rules) {
      if (!r || typeof r !== 'object') continue
      const rr = r as Partial<SummaryModeRule>
      rules.push({
        roles: Array.isArray(rr.roles) ? rr.roles.map(String) : null,
        states: Array.isArray(rr.states) ? rr.states.map(String) : null,
        states_op: rr.states_op === 'not_in' ? 'not_in' : 'in',
        mode: rr.mode === 'summary' ? 'summary' : 'edit'
      })
    }
  }
  return { default: o.default === 'summary' ? 'summary' : 'edit', rules }
}

/**
 * Strict write: the PATCH body → normalized config, or an error message.
 * Returns `{ value: null }` when the config is the empty default (nothing
 * worth storing).
 */
export function validateSummaryModeRules(
  raw: unknown
): { value: SummaryModeRules | null; error?: undefined } | { value?: undefined; error: string } {
  if (raw == null) return { value: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'summary_mode_rules must be an object' }
  }
  const o = raw as { default?: unknown; rules?: unknown }
  if (o.default !== undefined && o.default !== 'edit' && o.default !== 'summary') {
    return { error: "summary_mode_rules.default must be 'edit' or 'summary'" }
  }
  const def: SummaryMode = o.default === 'summary' ? 'summary' : 'edit'
  const rulesIn = o.rules === undefined ? [] : o.rules
  if (!Array.isArray(rulesIn)) return { error: 'summary_mode_rules.rules must be an array' }
  if (rulesIn.length > MAX_RULES) {
    return { error: `summary_mode_rules: at most ${MAX_RULES} rules` }
  }
  const rules: SummaryModeRule[] = []
  for (const [i, r] of rulesIn.entries()) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return { error: `summary_mode_rules.rules[${i}] must be an object` }
    }
    const rr = r as Record<string, unknown>
    if (rr.mode !== 'edit' && rr.mode !== 'summary') {
      return { error: `summary_mode_rules.rules[${i}].mode must be 'edit' or 'summary'` }
    }
    let roles: string[] | null = null
    if (rr.roles != null) {
      if (!Array.isArray(rr.roles)) {
        return { error: `summary_mode_rules.rules[${i}].roles must be an array` }
      }
      if (rr.roles.length > MAX_LIST) {
        return { error: `summary_mode_rules.rules[${i}].roles: at most ${MAX_LIST}` }
      }
      roles = []
      for (const v of rr.roles) {
        if (typeof v !== 'string' || !UUID_RE.test(v)) {
          return { error: `summary_mode_rules.rules[${i}].roles entries must be role ids (uuid)` }
        }
        const up = v.toUpperCase()
        if (!roles.includes(up)) roles.push(up)
      }
      if (roles.length === 0) roles = null
    }
    let states: string[] | null = null
    if (rr.states != null) {
      if (!Array.isArray(rr.states)) {
        return { error: `summary_mode_rules.rules[${i}].states must be an array` }
      }
      if (rr.states.length > MAX_LIST) {
        return { error: `summary_mode_rules.rules[${i}].states: at most ${MAX_LIST}` }
      }
      states = []
      for (const v of rr.states) {
        if (typeof v !== 'string' || (v !== NO_STATE && !STATE_KEY_RE.test(v))) {
          return { error: `summary_mode_rules.rules[${i}].states entries must be state keys` }
        }
        if (!states.includes(v)) states.push(v)
      }
      if (states.length === 0) states = null
    }
    const op = rr.states_op
    if (op !== undefined && op !== 'in' && op !== 'not_in') {
      return { error: `summary_mode_rules.rules[${i}].states_op must be 'in' or 'not_in'` }
    }
    rules.push({ roles, states, states_op: op === 'not_in' ? 'not_in' : 'in', mode: rr.mode })
  }
  if (def === 'edit' && rules.length === 0) return { value: null }
  return { value: { default: def, rules } }
}
