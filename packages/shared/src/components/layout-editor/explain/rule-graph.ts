import { parseVisibleWhen } from '../../../lib/visible-when'
import type { ActiveLayoutData } from '../../item-edit/types'

/**
 * Which field values drive which parts of a form (#2641, #2642). Pure: the
 * caller passes the canvas layout, the collection's field rows and its field
 * rules. One dependency list feeds both the hover highlight ("what does this
 * field control?") and the loop check ("rules that depend on each other").
 *
 * A dependency is `driver` (a field of this record) → a section or a field
 * whose visibility, options or value follow the driver's value:
 *
 * - visibility: a section's `visible_when` names the driver;
 * - skip: a step's `skip_if_filled` names the driver;
 * - cascade: a picker's cascade filter has the driver as its parent
 *   (`dependency_config.cascade_filters`, every form or this form's override);
 *   only one that empties the picker when the driver changes counts for loops;
 * - field_rule: an active field rule triggers on the driver;
 * - parent_cascade / row_rule: a grid's parent cascades or row rules read the
 *   driver from the parent record (`$parent.<field>`).
 */

export type RuleDepKind =
  | 'visibility'
  | 'skip'
  | 'cascade'
  | 'field_rule'
  | 'parent_cascade'
  | 'row_rule'

export type RuleDepTarget = { kind: 'group'; key: string } | { kind: 'field'; field: string }

export interface RuleDep {
  driver: string
  kind: RuleDepKind
  target: RuleDepTarget
  /** A cascade that only narrows the picker's options and never empties the
   *  value (clear_on_parent_change off): shown on hover, never part of a loop. */
  filterOnly?: true
}

export interface RuleGroup {
  key: string
  label?: string | null
  parent_key?: string | null
  visible_when?: unknown
  skip_if_filled?: unknown
  hidden_for_roles?: unknown
  locked_for_roles?: unknown
}

export interface RulePlacement {
  field: string
  group_key: string | null
  is_visible?: unknown
  lock_conditions?: unknown
  overrides?: unknown
}

export interface RuleLayout {
  groups: RuleGroup[]
  placements: RulePlacement[]
}

/** The parts of a field row (GET /collections/:c) the graph reads. */
export interface RuleFieldRow {
  field: string
  dependency_config?: unknown
  options?: unknown
}

/** A stored field rule (GET /field-rules?collection=). */
export interface RuleFieldRule {
  id?: number
  trigger_field: string
  trigger_op?: string | null
  trigger_value?: string | null
  target_field: string
  target_type?: string | null
  target_value?: string | null
  is_active?: boolean | number | null
}

type Obj = Record<string, unknown>

function parsed(v: unknown): unknown {
  let cur = v
  for (let i = 0; i < 3 && typeof cur === 'string'; i++) {
    const t = cur.trim()
    if (!t) return null
    try {
      cur = JSON.parse(t)
    } catch {
      return null
    }
  }
  return cur ?? null
}

export function asObj(v: unknown): Obj {
  const p = parsed(v)
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : {}
}

export function asList<T = unknown>(v: unknown): T[] {
  const p = parsed(v)
  if (Array.isArray(p)) return p as T[]
  // skip_if_filled may be a bare comma list.
  if (typeof v === 'string' && v.trim() && !v.trim().startsWith('['))
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as T[]
  return []
}

/** The canvas layout (GET /active shape) as the graph's input: containers by key. */
export function ruleLayoutFromActive(active: ActiveLayoutData): RuleLayout {
  const keyOfId = new Map<number, string>()
  for (const g of active.groups) keyOfId.set(Number(g.id), g.key)
  return {
    groups: active.groups.map((g) => {
      const row = g as typeof g & Obj
      return {
        key: g.key,
        label: g.label,
        parent_key: g.container_id == null ? null : (keyOfId.get(Number(g.container_id)) ?? null),
        visible_when: row.visible_when,
        skip_if_filled: g.skip_if_filled,
        hidden_for_roles: row.hidden_for_roles,
        locked_for_roles: row.locked_for_roles
      }
    }),
    placements: active.assignments.map((a) => ({
      field: a.field,
      group_key: a.group_key ?? null,
      is_visible: a.is_visible,
      lock_conditions: a.lock_conditions,
      overrides: a.overrides
    }))
  }
}

const isRealField = (f: string) => !!f && !f.startsWith('__') && !f.startsWith('$')

/** `$parent.x` → `x` (a grid rule reading the record it sits on); else null. */
function parentRef(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('$parent.')) return null
  const f = v.slice('$parent.'.length).split('.')[0]
  return f ? f : null
}

/** Cascade filters of one placed field: this form's override, else the field's own.
 *  `clears`: the form empties the field when the parent changes (clear_on_parent_change). */
function cascadeParents(
  p: RulePlacement,
  row: RuleFieldRow | undefined
): Array<{ field: string; clears: boolean }> {
  const ov = asObj(p.overrides)
  const dep =
    ov.dependency_config !== undefined ? asObj(ov.dependency_config) : asObj(row?.dependency_config)
  const out: Array<{ field: string; clears: boolean }> = []
  for (const r of asList<{ parent_field?: unknown; clear_on_parent_change?: unknown }>(
    dep.cascade_filters
  )) {
    const f = typeof r?.parent_field === 'string' ? r.parent_field : ''
    if (isRealField(f)) out.push({ field: f, clears: r.clear_on_parent_change === true })
  }
  return out
}

/** A grid placement's options: this form's override options over the field's own. */
function gridOptions(p: RulePlacement, row: RuleFieldRow | undefined): Obj {
  return { ...asObj(row?.options), ...asObj(asObj(p.overrides).options) }
}

const depKey = (d: RuleDep) =>
  `${d.driver}|${d.kind}|${d.target.kind}:${d.target.kind === 'group' ? d.target.key : d.target.field}`

export function ruleDependencies(
  layout: RuleLayout,
  fields: RuleFieldRow[] = [],
  fieldRules: RuleFieldRule[] = []
): RuleDep[] {
  const byField = new Map(fields.map((f) => [f.field, f]))
  const out = new Map<string, RuleDep>()
  const add = (d: RuleDep) => {
    if (!isRealField(d.driver)) return
    out.set(depKey(d), d)
  }

  for (const g of layout.groups) {
    for (const r of parseVisibleWhen(g.visible_when))
      if (r.field)
        add({ driver: r.field, kind: 'visibility', target: { kind: 'group', key: g.key } })
    for (const f of asList<string>(g.skip_if_filled))
      if (typeof f === 'string')
        add({ driver: f, kind: 'skip', target: { kind: 'group', key: g.key } })
  }

  for (const p of layout.placements) {
    if (!isRealField(p.field)) continue
    const row = byField.get(p.field)
    for (const parent of cascadeParents(p, row))
      if (parent.field !== p.field)
        add({
          driver: parent.field,
          kind: 'cascade',
          target: { kind: 'field', field: p.field },
          ...(parent.clears ? {} : { filterOnly: true as const })
        })
    const opts = gridOptions(p, row)
    for (const c of asList<{ parent_field?: unknown }>(opts.parent_cascades)) {
      const f = typeof c?.parent_field === 'string' ? c.parent_field : ''
      if (isRealField(f))
        add({ driver: f, kind: 'parent_cascade', target: { kind: 'field', field: p.field } })
    }
    for (const r of asList<{ trigger_field?: unknown; trigger_fields?: unknown }>(opts.row_rules)) {
      const triggers = [
        r?.trigger_field,
        ...(Array.isArray(r?.trigger_fields) ? r.trigger_fields : [])
      ]
      for (const t of triggers) {
        const f = parentRef(t)
        if (f) add({ driver: f, kind: 'row_rule', target: { kind: 'field', field: p.field } })
      }
    }
  }

  // Field rules fill fields whether they are placed or not: loops count every active rule.
  for (const r of fieldRules) {
    if (!(r.is_active === true || r.is_active === 1 || r.is_active == null)) continue
    if (!r.trigger_field || !r.target_field || r.trigger_field === r.target_field) continue
    add({
      driver: r.trigger_field,
      kind: 'field_rule',
      target: { kind: 'field', field: r.target_field }
    })
  }
  return [...out.values()]
}

/** Everything `field`'s value controls. */
export function dependentsOf(deps: RuleDep[], field: string): RuleDep[] {
  return deps.filter((d) => d.driver === field)
}

/** Group key → its own key and every group nested under it. */
function subtrees(layout: RuleLayout): Map<string, Set<string>> {
  const children = new Map<string, string[]>()
  for (const g of layout.groups)
    if (g.parent_key) children.set(g.parent_key, [...(children.get(g.parent_key) ?? []), g.key])
  const out = new Map<string, Set<string>>()
  for (const g of layout.groups) {
    const seen = new Set<string>()
    const stack = [g.key]
    while (stack.length) {
      const k = stack.pop() as string
      if (seen.has(k)) continue
      seen.add(k)
      stack.push(...(children.get(k) ?? []))
    }
    out.set(g.key, seen)
  }
  return out
}

/** Fields placed in a group or anything nested under it. */
export function fieldsUnder(layout: RuleLayout, groupKey: string): string[] {
  const keys = subtrees(layout).get(groupKey) ?? new Set([groupKey])
  return [
    ...new Set(
      layout.placements
        .filter((p) => p.group_key != null && keys.has(p.group_key) && isRealField(p.field))
        .map((p) => p.field)
    )
  ]
}

export interface RuleLoop {
  /** 'self': a driver hidden (or skipped) by the very rule it drives. */
  kind: 'self' | 'cycle'
  /** The fields around the loop, in order (a self loop: the one field). */
  fields: string[]
  /** The section a self loop hides the driver in. */
  group?: string
  /** The dependency kinds the loop runs through. */
  kinds: RuleDepKind[]
}

/**
 * Rules that depend on each other in a loop (#2642): field A's value decides
 * B (a rule fills it, a cascade filters it, a section holding B shows on A)
 * and B decides A again. Plus the self loop: a section that shows (or a step
 * that is skipped) on a field placed inside that very section — once hidden,
 * nobody can change the field back.
 */
export function findRuleLoops(deps: RuleDep[], layout: RuleLayout): RuleLoop[] {
  const loops: RuleLoop[] = []
  const under = new Map<string, string[]>()
  const fieldsOf = (key: string) => {
    let v = under.get(key)
    if (!v) {
      v = fieldsUnder(layout, key)
      under.set(key, v)
    }
    return v
  }

  // Field → field edges, with the kind of the first rule joining them.
  const edges = new Map<string, Map<string, RuleDepKind>>()
  const edge = (a: string, b: string, kind: RuleDepKind) => {
    const m = edges.get(a) ?? new Map<string, RuleDepKind>()
    if (!m.has(b)) m.set(b, kind)
    edges.set(a, m)
  }
  const selfSeen = new Set<string>()
  for (const d of deps) {
    // A skipped step can still be stepped back into, and a filter that never
    // empties a value cannot undo it: neither is part of a loop.
    if (d.kind === 'skip' || d.filterOnly) continue
    if (d.target.kind === 'field') {
      edge(d.driver, d.target.field, d.kind)
      continue
    }
    for (const f of fieldsOf(d.target.key)) {
      if (f === d.driver) {
        const k = `${f}|${d.target.key}`
        if (!selfSeen.has(k)) {
          selfSeen.add(k)
          loops.push({ kind: 'self', fields: [f], group: d.target.key, kinds: [d.kind] })
        }
        continue
      }
      edge(d.driver, f, d.kind)
    }
  }

  // Strongly connected components (Tarjan); each with more than one field is a loop.
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let next = 0
  const nodes = [
    ...new Set([...edges.keys(), ...[...edges.values()].flatMap((m) => [...m.keys()])])
  ].sort()
  const strong = (v: string) => {
    index.set(v, next)
    low.set(v, next)
    next++
    stack.push(v)
    onStack.add(v)
    for (const w of [...(edges.get(v)?.keys() ?? [])].sort()) {
      if (!index.has(w)) {
        strong(w)
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number))
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, index.get(w) as number))
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = stack.pop() as string
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      if (comp.length > 1) loops.push(cycleIn(new Set(comp), edges))
    }
  }
  for (const n of nodes) if (!index.has(n)) strong(n)
  return loops
}

/** One walk around a strongly connected set: from its first field back to it. */
function cycleIn(comp: Set<string>, edges: Map<string, Map<string, RuleDepKind>>): RuleLoop {
  const start = [...comp].sort()[0]
  // Breadth-first from start to any field with an edge back to start.
  const prev = new Map<string, string>()
  const queue = [start]
  const seen = new Set([start])
  let end: string | null = null
  while (queue.length && !end) {
    const v = queue.shift() as string
    for (const w of [...(edges.get(v)?.keys() ?? [])].sort()) {
      if (!comp.has(w)) continue
      if (w === start) {
        end = v
        break
      }
      if (seen.has(w)) continue
      seen.add(w)
      prev.set(w, v)
      queue.push(w)
    }
  }
  const path: string[] = []
  for (let v: string | undefined = end ?? start; v && v !== start; v = prev.get(v)) path.unshift(v)
  const fields = [start, ...path]
  const kinds = fields.map(
    (f, i) => edges.get(f)?.get(fields[(i + 1) % fields.length]) as RuleDepKind
  )
  return { kind: 'cycle', fields, kinds: [...new Set(kinds.filter(Boolean))] }
}
