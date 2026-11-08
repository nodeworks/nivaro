/**
 * Summary Mode rules — which mode the record form opens in.
 *
 * Config lives on `nivaro_collections.summary_mode_rules` (migration 310):
 *
 *   { default: 'edit' | 'summary',
 *     rules: [{ roles?: uuid[] | null, states?: key[] | null,
 *               states_op?: 'in' | 'not_in',
 *               conditions?: [{field, op, value}] | null,   // #737
 *               mode: 'edit' | 'summary' }] }
 *
 * Rules are evaluated in order, first match wins, `default` when none match.
 * A null/empty `roles` or `states` list means "any"; `conditions` judge the
 * record's own values (ALL must hold — the at-risk rule ops, see
 * record-conditions.ts): "on hold → Summary", "requisition over X → Summary". `states` may contain
 * NO_STATE ('__none__') to match a record that has no pipeline instance.
 * New records ALWAYS open in Edit — there is nothing to summarise yet.
 *
 * The server validates the same shape (api/src/services/summary-mode.ts);
 * this module is the CLIENT evaluator and the Table Editor's type source.
 */

import {
  normalizeRecordConditions,
  type RecordCondition,
  recordMatchesAll
} from './record-conditions'

export type SummaryMode = 'summary' | 'edit'
export type SummaryStatesOp = 'in' | 'not_in'

export interface SummaryModeRule {
  roles?: string[] | null
  states?: string[] | null
  states_op?: SummaryStatesOp
  conditions?: RecordCondition[] | null
  mode: SummaryMode
}

export interface SummaryModeRules {
  default: SummaryMode
  rules: SummaryModeRule[]
  /** Server-enforced edit lock (api services/edit-lock.ts) — not an opening
   *  mode; carried through so a Form UX save never drops it. */
  edit_lock?: {
    states: string[]
    children: string[]
    /** Post-approval states: only administrators change the record, except
     *  the fields / child collections listed as open. */
    admin_only?: {
      states: string[]
      transitions: string[]
      open_fields: string[]
      open_children: string[]
    }
  }
}

export const NO_STATE = '__none__'

export const EMPTY_SUMMARY_RULES: SummaryModeRules = { default: 'edit', rules: [] }

export function normalizeSummaryModeRules(raw: unknown): SummaryModeRules {
  if (!raw || typeof raw !== 'object') return EMPTY_SUMMARY_RULES
  const o = raw as { default?: unknown; rules?: unknown; edit_lock?: SummaryModeRules['edit_lock'] }
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
        conditions: normalizeRecordConditions(rr.conditions),
        mode: rr.mode === 'summary' ? 'summary' : 'edit'
      })
    }
  }
  return { default: def, rules, ...(o.edit_lock ? { edit_lock: o.edit_lock } : {}) }
}

/** True when any rule mentions roles — the evaluator then needs the viewer's role. */
export const summaryRulesNeedRole = (cfg: SummaryModeRules | null | undefined) =>
  !!cfg?.rules.some((r) => (r.roles?.length ?? 0) > 0)

/** True when any rule mentions states — the evaluator then needs the pipeline state. */
export const summaryRulesNeedState = (cfg: SummaryModeRules | null | undefined) =>
  !!cfg?.rules.some((r) => (r.states?.length ?? 0) > 0)

/** True when any rule judges the record's values — the evaluator then needs the record. */
export const summaryRulesNeedRecord = (cfg: SummaryModeRules | null | undefined) =>
  !!cfg?.rules.some((r) => (r.conditions?.length ?? 0) > 0)

export function resolveSummaryMode(
  cfg: SummaryModeRules | null | undefined,
  ctx: {
    role: string | null
    stateKey: string | null
    isNew: boolean
    record?: Record<string, unknown> | null
  }
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
    if ((rule.conditions?.length ?? 0) > 0) {
      // A rule about the record's values never matches a record not read yet.
      if (!ctx.record || !recordMatchesAll(ctx.record, rule.conditions)) continue
    }
    return rule.mode
  }
  return cfg.default
}

/** What the opening mode was resolved for: the record, its pipeline state and
 *  the viewer's role. A change of state (Submit, Send Back) or role (View-as)
 *  resolves it again (army 11 a2 F5). */
export function summaryResolveSignature(
  recordKey: string,
  stateKey: string | null,
  role: string | null
): string {
  return JSON.stringify([recordKey, stateKey ?? null, role ? role.toLowerCase() : null])
}

/** Whether a stored signature was made for this record (vs. another one, or none yet). */
export function sameSummaryRecord(signature: string | null, recordKey: string): boolean {
  if (!signature) return false
  try {
    const parsed = JSON.parse(signature) as unknown
    return Array.isArray(parsed) && parsed[0] === recordKey
  } catch {
    return false
  }
}

/** A later re-resolve (state / role changed) waits while the person has any
 *  unsaved work — a dirty field, staged lines or a line editor holding typed
 *  text (army 11 review #4: a flip to Summary unmounted the editor and its
 *  text was lost). The first resolve of a record never waits. */
export function holdSummaryReresolve(a: {
  first: boolean
  unsaved: boolean
  lineDrafts: number
}): boolean {
  return !a.first && (a.unsaved || a.lineDrafts > 0)
}
