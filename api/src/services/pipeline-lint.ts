/**
 * Template reachability lint (#1241) — a PURE check over a pipeline template's
 * states and transitions. No database: the route and the readiness check load
 * the rows and hand them in, so every rule is unit-testable on literals.
 *
 * What it reports:
 *  - states nothing enters (other than an initial state)
 *  - states only entered from states a record can never reach
 *  - transitions whose from-state is unreachable (they can never fire)
 *  - condition sets that can never pass (eq A and eq B on one field, eq X and
 *    neq X, an eq outside an `in` list, null and nnull, a numeric range with no
 *    room, related_some and related_none on the same relation …)
 *  - terminal states with exits (info — intentional for reopen / uncancel)
 *  - non-terminal states with no exit, or whose only exits can never pass
 *  - unconditioned AUTO transitions on a state that also has manual exits —
 *    the engine fires the auto on the first write, so the manual buttons are
 *    never reachable in practice
 *
 * Semantics the engine relies on and the lint therefore mirrors:
 *  - from_state NULL = "from any state": it enters its to_state from every
 *    reachable state and counts as an exit of every NON-terminal state (a
 *    completed instance only takes transitions whose from_state is its own
 *    terminal state — see the transition endpoint's escape hatch).
 *  - send-backs (to_state sorts before from_state) are ordinary edges for
 *    reachability; a state entered only by a send-back from a reachable state
 *    is reachable.
 *  - a transition whose conditions can never pass is not an edge at all.
 */

export interface LintState {
  id: string
  key?: string | null
  label: string
  is_initial: boolean | number | null
  is_terminal: boolean | number | null
  sort?: number | null
}

export interface LintTransition {
  id: string
  from_state: string | null
  to_state: string
  label: string
  condition_rules?: unknown
  auto_trigger?: boolean | number | null
}

export type LintCode =
  | 'no_initial'
  | 'never_entered'
  | 'unreachable'
  | 'dead_transition'
  | 'impossible_conditions'
  | 'terminal_exit'
  | 'dead_end'
  | 'auto_shadows_manual'
  | 'any_state_auto'

export interface LintFinding {
  code: LintCode
  severity: 'warn' | 'info'
  message: string
  state_id?: string
  transition_id?: string
}

export interface LintResult {
  states: number
  transitions: number
  reachable: number
  findings: LintFinding[]
  warnings: number
}

interface Rule {
  field: string
  op: string
  value: unknown
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** condition_rules arrives as a JSON string (the column) or an already-parsed array. */
export function parseRules(raw: unknown): Rule[] {
  let v = raw
  if (typeof v === 'string') {
    if (!v.trim()) return []
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  if (!Array.isArray(v)) return []
  return v.filter(
    (r): r is Rule =>
      !!r && typeof r === 'object' && typeof (r as Rule).field === 'string' && !!(r as Rule).field
  )
}

const isNumericish = (v: unknown) =>
  v !== null && v !== '' && v !== undefined && typeof v !== 'boolean' && Number.isFinite(Number(v))

/** The evaluator compares numerically when both sides look numeric, else as strings. */
const norm = (v: unknown) => (isNumericish(v) ? String(Number(v)) : String(v ?? ''))

const listOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : String(v ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean)
    .map(norm)

const RELATED_PAIRS: Array<[string, string]> = [
  ['related_some', 'related_none'],
  ['children_in_state', 'children_not_in_state']
]

/**
 * Why a rule set can never pass, or null when some record could satisfy it.
 * Only rules on the SAME field are compared — rules on different fields never
 * contradict each other.
 */
export function impossibleReason(raw: unknown): string | null {
  const rules = parseRules(raw)
  if (rules.length < 2) return null

  // Relation counts: some + none on the same relation (and filter) cannot both hold.
  for (const [a, b] of RELATED_PAIRS) {
    for (const r of rules.filter((x) => x.op === a)) {
      const twin = rules.find(
        (x) => x.op === b && x.field === r.field && String(x.value ?? '') === String(r.value ?? '')
      )
      if (twin) return `${r.field}: requires both "${a}" and "${b}"`
    }
  }

  const byField = new Map<string, Rule[]>()
  for (const r of rules) {
    if (RELATED_PAIRS.some(([a, b]) => r.op === a || r.op === b)) continue
    byField.set(r.field, [...(byField.get(r.field) ?? []), r])
  }

  for (const [field, rs] of byField) {
    const eqs = [...new Set(rs.filter((r) => r.op === 'eq').map((r) => norm(r.value)))]
    if (eqs.length > 1) return `${field} must equal both ${eqs.map((e) => `"${e}"`).join(' and ')}`
    const eq = eqs[0]

    for (const r of rs.filter((x) => x.op === 'neq')) {
      if (eq !== undefined && norm(r.value) === eq)
        return `${field} must equal "${eq}" and also not equal it`
    }

    const ins = rs.filter((r) => r.op === 'in').map((r) => new Set(listOf(r.value)))
    if (eq !== undefined) {
      for (const set of ins)
        if (!set.has(eq)) return `${field} must equal "${eq}", which is not in its "in" list`
    }
    if (ins.length > 1) {
      const meet = [...ins[0]].filter((v) => ins.every((s) => s.has(v)))
      if (meet.length === 0) return `${field}: its "in" lists share no value`
    }

    const hasNull = rs.some((r) => r.op === 'null')
    if (hasNull) {
      if (rs.some((r) => r.op === 'nnull')) return `${field} must be both empty and filled`
      if (eq !== undefined && eq !== '') return `${field} must be empty and equal "${eq}"`
      const needsValue = rs.find((r) =>
        ['in', 'contains', 'gt', 'gte', 'lt', 'lte', 'within_days', 'beyond_days'].includes(r.op)
      )
      if (needsValue) return `${field} must be empty, but "${needsValue.op}" needs a value`
    }

    // Numeric bounds — only when every bound value is numeric.
    let lo = Number.NEGATIVE_INFINITY
    let loStrict = false
    let hi = Number.POSITIVE_INFINITY
    let hiStrict = false
    let numeric = true
    for (const r of rs) {
      if (!['gt', 'gte', 'lt', 'lte'].includes(r.op) && !(r.op === 'eq' && isNumericish(r.value)))
        continue
      if (!isNumericish(r.value)) {
        numeric = false
        break
      }
      const n = Number(r.value)
      if (r.op === 'gt' || r.op === 'gte' || r.op === 'eq') {
        const strict = r.op === 'gt'
        if (n > lo || (n === lo && strict)) {
          lo = n
          loStrict = strict
        }
      }
      if (r.op === 'lt' || r.op === 'lte' || r.op === 'eq') {
        const strict = r.op === 'lt'
        if (n < hi || (n === hi && strict)) {
          hi = n
          hiStrict = strict
        }
      }
    }
    if (numeric && (lo > hi || (lo === hi && (loStrict || hiStrict))))
      return `${field} has no value between its lower bound (${lo}) and upper bound (${hi})`

    // within_days N (diff ≤ N) and beyond_days M (diff > M) need M < N.
    const within = rs.filter((r) => r.op === 'within_days' && isNumericish(r.value))
    const beyond = rs.filter((r) => r.op === 'beyond_days' && isNumericish(r.value))
    if (within.length && beyond.length) {
      const n = Math.min(...within.map((r) => Number(r.value)))
      const m = Math.max(...beyond.map((r) => Number(r.value)))
      if (m >= n) return `${field} must be within ${n} days and beyond ${m} days`
    }
  }
  return null
}

export function lintTemplate(states: LintState[], transitions: LintTransition[]): LintResult {
  const findings: LintFinding[] = []
  const byId = new Map(states.map((s) => [String(s.id), s]))
  const label = (id: string | null) => (id ? (byId.get(String(id))?.label ?? id) : 'any state')
  const terminal = (id: string) => truthy(byId.get(id)?.is_terminal)
  const sortOf = (id: string) => Number(byId.get(id)?.sort ?? 0)

  // Only transitions between known states count; an orphan row (state deleted
  // under it) is noise the editor already refuses to show.
  const known = transitions.filter(
    (t) => byId.has(String(t.to_state)) && (t.from_state == null || byId.has(String(t.from_state)))
  )

  const impossible = new Map<string, string>()
  for (const t of known) {
    const why = impossibleReason(t.condition_rules)
    if (why) {
      impossible.set(String(t.id), why)
      findings.push({
        code: 'impossible_conditions',
        severity: 'warn',
        transition_id: String(t.id),
        message: `"${t.label}" (${label(t.from_state)} → ${label(t.to_state)}) can never fire — ${why}.`
      })
    }
  }
  const live = known.filter((t) => !impossible.has(String(t.id)))

  // Reachability: BFS from initial states over live edges; from_state NULL
  // edges fire from any reached state, so their target is reached as soon as
  // anything is (and the initial state always is).
  const initials = states.filter((s) => truthy(s.is_initial)).map((s) => String(s.id))
  if (states.length > 0 && initials.length === 0) {
    findings.push({
      code: 'no_initial',
      severity: 'warn',
      message: 'No state is marked initial — a new record has nowhere to start.'
    })
  }
  const reach = new Set<string>()
  const queue = [...initials]
  const anyEdges = live.filter((t) => t.from_state == null)
  while (queue.length) {
    const id = queue.shift() as string
    if (reach.has(id)) continue
    reach.add(id)
    for (const t of live) {
      if (t.from_state != null && String(t.from_state) === id) queue.push(String(t.to_state))
    }
    // An any-state transition is not available from a terminal state.
    if (!terminal(id)) for (const t of anyEdges) queue.push(String(t.to_state))
  }

  for (const s of states) {
    const id = String(s.id)
    if (truthy(s.is_initial) || reach.has(id)) continue
    const inbound = known.filter(
      (t) => String(t.to_state) === id && (t.from_state == null || String(t.from_state) !== id)
    )
    if (inbound.length === 0) {
      findings.push({
        code: 'never_entered',
        severity: 'warn',
        state_id: id,
        message: `Nothing enters "${s.label}" — no transition leads to it.`
      })
    } else {
      const froms = [...new Set(inbound.map((t) => label(t.from_state)))]
      findings.push({
        code: 'unreachable',
        severity: 'warn',
        state_id: id,
        message: `"${s.label}" is only entered from ${froms.map((f) => `"${f}"`).join(', ')}, which a record can never reach${inbound.every((t) => impossible.has(String(t.id))) ? ' (or by transitions that can never fire)' : ''}.`
      })
    }
  }

  for (const t of known) {
    if (t.from_state == null || reach.has(String(t.from_state))) continue
    if (impossible.has(String(t.id))) continue
    findings.push({
      code: 'dead_transition',
      severity: 'warn',
      transition_id: String(t.id),
      state_id: String(t.from_state),
      message: `"${t.label}" leaves "${label(t.from_state)}", which a record can never reach — it can never fire.`
    })
  }

  for (const s of states) {
    const id = String(s.id)
    const own = known.filter((t) => t.from_state != null && String(t.from_state) === id)
    const ownExits = own.filter((t) => String(t.to_state) !== id)
    if (truthy(s.is_terminal)) {
      if (ownExits.length > 0) {
        findings.push({
          code: 'terminal_exit',
          severity: 'info',
          state_id: id,
          message: `Terminal state "${s.label}" has ${ownExits.length} exit${ownExits.length === 1 ? '' : 's'} (${ownExits.map((t) => `"${t.label}"`).join(', ')}) — fine for a reopen or uncancel path, otherwise a finished record can be moved again.`
        })
      }
      continue
    }
    if (!reach.has(id) && !truthy(s.is_initial)) continue // already reported as unreachable
    const exits = [
      ...ownExits,
      ...known.filter((t) => t.from_state == null && String(t.to_state) !== id)
    ]
    const liveExits = exits.filter((t) => !impossible.has(String(t.id)))
    if (exits.length === 0) {
      findings.push({
        code: 'dead_end',
        severity: 'warn',
        state_id: id,
        message: `"${s.label}" is not terminal but has no way out — a record that lands there is stuck.`
      })
    } else if (liveExits.length === 0) {
      findings.push({
        code: 'dead_end',
        severity: 'warn',
        state_id: id,
        message: `"${s.label}" is not terminal and every way out can never fire — a record that lands there is stuck.`
      })
    }

    const liveOwn = ownExits.filter((t) => !impossible.has(String(t.id)))
    const unconditionedAuto = liveOwn.filter(
      (t) => truthy(t.auto_trigger) && parseRules(t.condition_rules).length === 0
    )
    const manual = liveOwn.filter((t) => !truthy(t.auto_trigger))
    if (unconditionedAuto.length > 0 && manual.length > 0) {
      findings.push({
        code: 'auto_shadows_manual',
        severity: 'warn',
        state_id: id,
        transition_id: String(unconditionedAuto[0].id),
        message: `"${s.label}" has an automatic transition with no conditions ("${unconditionedAuto[0].label}" → "${label(unconditionedAuto[0].to_state)}") — it fires on the first write, so ${manual.length === 1 ? `the manual exit "${manual[0].label}" is` : `its ${manual.length} manual exits are`} never really offered.`
      })
    }
  }

  for (const t of live) {
    if (t.from_state != null || !truthy(t.auto_trigger)) continue
    if (parseRules(t.condition_rules).length > 0) continue
    findings.push({
      code: 'any_state_auto',
      severity: 'warn',
      transition_id: String(t.id),
      message: `"${t.label}" is automatic, unconditioned and allowed from any state — every record jumps to "${label(t.to_state)}" on its next write.`
    })
  }

  // Keep findings in a stable, readable order: by state sort, then code.
  const order: LintCode[] = [
    'no_initial',
    'any_state_auto',
    'never_entered',
    'unreachable',
    'dead_end',
    'auto_shadows_manual',
    'impossible_conditions',
    'dead_transition',
    'terminal_exit'
  ]
  findings.sort(
    (a, b) =>
      order.indexOf(a.code) - order.indexOf(b.code) ||
      (a.state_id ? sortOf(a.state_id) : 0) - (b.state_id ? sortOf(b.state_id) : 0)
  )
  return {
    states: states.length,
    transitions: known.length,
    reachable: reach.size,
    findings,
    warnings: findings.filter((f) => f.severity === 'warn').length
  }
}
