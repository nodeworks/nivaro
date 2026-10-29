// Builds the plain-language Diagram of a pipeline template (states = boxes,
// transitions = arrows). Wording helpers are local on purpose (small, no
// dependency on the shared config-sentences module).

import { type Diagram, type DiagramEdgeIn, type DiagramNodeIn, layoutGraph } from './layout'

export interface PState {
  id: string
  key: string
  label: string
  color: string | null
  is_initial: boolean
  is_terminal: boolean
  lock_record?: boolean
  sort?: number
  skip_criteria?: {
    mode: 'any' | 'all'
    conditions: Array<Record<string, unknown>>
  } | null
}

export interface PTransition {
  id: string
  from_state: string | null
  to_state: string
  label: string
  required_roles: string[] | null
  auto_trigger?: boolean
  comment_mode?: string
  sort?: number
  condition_rules?: Array<{ field: string; op: string; value?: unknown }> | null
  requirements?: unknown[] | null
  require_owner?: boolean | number | null
  allow_creator?: boolean | number | null
}

export interface PSplit {
  id: string
  label: string
  /** State KEYS. */
  branch_states: string[]
  join_state: string
  from_state: string | null
}

export interface PipelineDiagramInput {
  states: PState[]
  transitions: PTransition[]
  splits?: PSplit[]
  /** role id -> display name. */
  roleNames?: Record<string, string>
}

const OPS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  notin: 'is none of',
  contains: 'contains'
}

function humanField(f: unknown): string {
  return String(f ?? '')
    .split('.')
    .pop()
    ?.replace(/_/g, ' ') as string
}

function valueText(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(', ')
  return String(v ?? '')
}

export function describeSkip(sc: PState['skip_criteria']): string | null {
  if (!sc || !sc.conditions?.length) return null
  const parts = sc.conditions.map((c) => {
    switch (c.type) {
      case 'no_owners':
        return 'nobody owns this step'
      case 'field_empty':
        return `${humanField(c.field)} is empty`
      case 'field_nonempty':
        return `${humanField(c.field)} is filled in`
      case 'field_compare':
        return `${humanField(c.field)} ${OPS[String(c.op)] ?? String(c.op)} ${valueText(c.value)}`
      case 'lookup_compare':
        return `a ${String(c.collection ?? 'related')} lookup matches`
      default:
        return 'a condition holds'
    }
  })
  const join = sc.mode === 'all' ? ' and ' : ' or '
  return `Skipped when ${parts.join(join)}`
}

function flag(v: unknown): boolean {
  return v === true || v === 1
}

/** Who may run a transition, in words. */
export function describeWho(t: PTransition, roleNames: Record<string, string> = {}): string {
  if (t.auto_trigger) return 'Happens automatically'
  const roles = (t.required_roles ?? []).map((r) => roleNames[r] ?? r)
  const roleText = roles.length ? roles.join(' or ') : ''
  if (flag(t.require_owner)) {
    const who = flag(t.allow_creator) ? 'Owner or creator' : 'Owner'
    return roleText ? `${who} (${roleText})` : who
  }
  if (roleText) return `${roleText} only`
  return 'Anyone who can edit'
}

function ruleText(r: { field: string; op: string; value?: unknown }): string {
  if (r.op === 'null') return `${humanField(r.field)} is empty`
  if (r.op === 'nnull') return `${humanField(r.field)} is filled in`
  return `${humanField(r.field)} ${OPS[r.op] ?? r.op} ${valueText(r.value)}`
}

export function describeTransition(t: PTransition, roleNames: Record<string, string> = {}) {
  const lines = [t.label, describeWho(t, roleNames)]
  if (t.condition_rules?.length)
    lines.push(`Only if ${t.condition_rules.map(ruleText).join(' and ')}`)
  if (t.requirements?.length) lines.push('Needs details filled in')
  if (t.comment_mode === 'required') lines.push('Comment required')
  return lines
}

export const ANY_NODE_ID = '__any__'

export function buildPipelineDiagram(input: PipelineDiagramInput): Diagram {
  const roleNames = input.roleNames ?? {}
  const splits = input.splits ?? []
  const splitIds = new Set(splits.map((s) => s.id))
  const states = [...input.states].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const byKey = new Map(states.map((s) => [s.key, s]))
  const branchKeys = new Set(splits.flatMap((s) => s.branch_states))
  const stateIds = new Set(states.map((s) => s.id))

  const nodes: DiagramNodeIn[] = states.map((s) => {
    const tags: string[] = []
    if (s.is_initial) tags.push('Start')
    if (s.is_terminal) tags.push('End')
    if (branchKeys.has(s.key)) tags.push('Parallel branch')
    if (s.lock_record) tags.push('Locks record')
    const skip = describeSkip(s.skip_criteria)
    return {
      id: s.id,
      title: s.label,
      role: s.is_initial ? 'initial' : s.is_terminal ? 'terminal' : 'normal',
      tags,
      notes: skip ? [skip] : [],
      color: s.color
    }
  })

  const transitions = input.transitions
    .filter((t) => !splitIds.has(t.id) && stateIds.has(t.to_state))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const edges: DiagramEdgeIn[] = []
  let anyUsed = false
  // Merge transitions that share from+to into one arrow with stacked labels.
  const merged = new Map<string, DiagramEdgeIn>()
  for (const t of transitions) {
    const from = t.from_state && stateIds.has(t.from_state) ? t.from_state : ANY_NODE_ID
    if (from === ANY_NODE_ID) anyUsed = true
    const key = `${from}>${t.to_state}`
    const lines = describeTransition(t, roleNames)
    const ex = merged.get(key)
    if (ex) {
      ex.lines = [...(ex.lines ?? []), ...lines]
    } else {
      const e: DiagramEdgeIn = {
        id: `t:${key}`,
        from,
        to: t.to_state,
        lines,
        tone: from === ANY_NODE_ID ? 'any' : 'normal',
        dashed: from === ANY_NODE_ID,
        noLayer: from === ANY_NODE_ID
      }
      merged.set(key, e)
      edges.push(e)
    }
  }
  if (anyUsed) {
    nodes.unshift({ id: ANY_NODE_ID, title: 'From any step', role: 'virtual', tags: [], notes: [] })
  }

  for (const sp of splits) {
    const forkId = `split:${sp.id}`
    const from = sp.from_state ? byKey.get(sp.from_state) : undefined
    nodes.push({
      id: forkId,
      title: `Split: ${sp.label}`,
      role: 'fork',
      tags: ['Runs in parallel'],
      notes: ['Branches run side by side; the record moves on when every branch ends']
    })
    if (from) {
      edges.push({
        id: `sf:${sp.id}`,
        from: from.id,
        to: forkId,
        lines: [sp.label, 'Starts parallel branches'],
        tone: 'split'
      })
    }
    sp.branch_states.forEach((k, i) => {
      const b = byKey.get(k)
      if (!b) return
      edges.push({ id: `sb:${sp.id}:${i}`, from: forkId, to: b.id, tone: 'split' })
    })
    const join = byKey.get(sp.join_state)
    if (join) {
      sp.branch_states.forEach((k, i) => {
        const b = byKey.get(k)
        if (!b || b.id === join.id) return
        edges.push({
          id: `sj:${sp.id}:${i}`,
          from: b.id,
          to: join.id,
          lines: i === 0 ? ['When every branch ends'] : undefined,
          tone: 'split',
          dashed: true
        })
      })
    }
  }

  return layoutGraph(nodes, edges, { nodeW: 210, gapX: 150 })
}
