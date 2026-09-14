/**
 * Summary Mode rules — which mode the record form opens in.
 *
 * Config lives on `nivaro_collections.summary_mode_rules` (migration 310):
 *
 *   { default: 'edit' | 'summary',
 *     rules: [{ roles?: uuid[] | null, states?: key[] | null,
 *               states_op?: 'in' | 'not_in', mode: 'edit' | 'summary' }] }
 *
 * Rules are evaluated in order, first match wins, `default` when none match.
 * A null/empty `roles` or `states` list means "any". `states` may contain
 * NO_STATE ('__none__') to match a record that has no pipeline instance.
 * New records ALWAYS open in Edit — there is nothing to summarise yet.
 *
 * The server validates the same shape (api/src/services/summary-mode.ts);
 * this module is the CLIENT evaluator and the Table Editor's type source.
 */

export type SummaryMode = 'summary' | 'edit'
export type SummaryStatesOp = 'in' | 'not_in'

export interface SummaryModeRule {
  roles?: string[] | null
  states?: string[] | null
  states_op?: SummaryStatesOp
  mode: SummaryMode
}

export interface SummaryModeRules {
  default: SummaryMode
  rules: SummaryModeRule[]
}

export const NO_STATE = '__none__'

export const EMPTY_SUMMARY_RULES: SummaryModeRules = { default: 'edit', rules: [] }

export function normalizeSummaryModeRules(raw: unknown): SummaryModeRules {
  if (!raw || typeof raw !== 'object') return EMPTY_SUMMARY_RULES
  const o = raw as { default?: unknown; rules?: unknown }
  const def: SummaryMode = o.default === 'summary' ? 'summary' : 'edit'
  const rules: SummaryModeRule[] = []
  if (Array.isArray(o.rules)) {
    for (const r of o.rules) {
      if (!r || typeof r !== 'object') continue
      const rr = r as SummaryModeRule
      rules.push({
        roles: Array.isArray(rr.roles) ? rr.roles.map(String) : null,
        states: Array.isArray(rr.states) ? rr.states.map(String) : null,
        states_op: rr.states_op === 'not_in' ? 'not_in' : 'in',
        mode: rr.mode === 'summary' ? 'summary' : 'edit'
      })
    }
  }
  return { default: def, rules }
}

/** True when any rule mentions roles — the evaluator then needs the viewer's role. */
export const summaryRulesNeedRole = (cfg: SummaryModeRules | null | undefined) =>
  !!cfg?.rules.some((r) => (r.roles?.length ?? 0) > 0)

/** True when any rule mentions states — the evaluator then needs the pipeline state. */
export const summaryRulesNeedState = (cfg: SummaryModeRules | null | undefined) =>
  !!cfg?.rules.some((r) => (r.states?.length ?? 0) > 0)

export function resolveSummaryMode(
  cfg: SummaryModeRules | null | undefined,
  ctx: { role: string | null; stateKey: string | null; isNew: boolean }
): SummaryMode {
  if (ctx.isNew || !cfg) return 'edit'
  const role = ctx.role ? ctx.role.toLowerCase() : null
  const stateVal = ctx.stateKey ?? NO_STATE
  for (const rule of cfg.rules) {
    const roles = rule.roles ?? []
    if (roles.length > 0 && (!role || !roles.some((r) => r.toLowerCase() === role))) continue
    const states = rule.states ?? []
    if (states.length > 0) {
      const inSet = states.includes(stateVal)
      const ok = rule.states_op === 'not_in' ? !inSet : inSet
      if (!ok) continue
    }
    return rule.mode
  }
  return cfg.default
}
