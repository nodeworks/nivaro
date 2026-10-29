import { useCallback, useMemo } from 'react'
import { applyLayoutOps, type LayoutBundle, type LayoutOp } from '../../../lib/layout-ops'
import { useCollectionBody } from '../collection-meta'
import type { RuleDep, RuleDepKind, RuleDepTarget } from '../explain/rule-graph'

// The trash says what depends on what is dragged onto it (#3190): "Region
// drives 3 rules". The rules come from the canvas explanations (explain/
// rule-graph.ts: visibility, skips, cascades, field rules, grid rules) plus the
// collection's formulas and default formulas that read the field. Only fields
// that leave the form entirely count: a twin placement elsewhere keeps the
// field on the form, and so do rules that point at what goes in the same drop.

export type LinkKind = RuleDepKind | 'formula' | 'default'

export interface FieldLink {
  driver: string
  kind: LinkKind
  target: RuleDepTarget
  filterOnly?: true
}

/** The parts of a field row (GET /collections/:c) formulas are read from. */
export interface LinkFieldRow {
  field: string
  computed_type?: string | null
  computed_formula?: unknown
  default_formula?: unknown
}

/** `item.<col>` and `{{col}}` references of a formula (the data-model graph reads them the same way). */
export function formulaRefs(src: unknown): string[] {
  if (typeof src !== 'string' || !src) return []
  const out = new Set<string>()
  for (const m of src.matchAll(/\bitem\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1])
  for (const m of src.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) out.add(m[1])
  return [...out]
}

/** Calculated fields and starting values that read another field. Rollups read related rows: none. */
export function formulaLinks(rows: LinkFieldRow[]): FieldLink[] {
  const out: FieldLink[] = []
  for (const r of rows) {
    if (!r?.field) continue
    if (r.computed_type !== 'rollup')
      for (const f of formulaRefs(r.computed_formula))
        if (f !== r.field)
          out.push({ driver: f, kind: 'formula', target: { kind: 'field', field: r.field } })
    for (const f of formulaRefs(r.default_formula))
      if (f !== r.field)
        out.push({ driver: f, kind: 'default', target: { kind: 'field', field: r.field } })
  }
  return out
}

export interface TrashWarning {
  /** "Region drives 3 rules". */
  headline: string
  /** What each rule does, in plain words, most telling first ("shows Billing"). */
  effects: string[]
  /** Rules counted. */
  count: number
}

const KIND_ORDER: LinkKind[] = [
  'visibility',
  'skip',
  'field_rule',
  'formula',
  'cascade',
  'default',
  'parent_cascade',
  'row_rule'
]

const realField = (f: string) => !!f && !f.startsWith('__') && !f.startsWith('$')
const placedFields = (b: LayoutBundle) =>
  new Set(b.placements.map((p) => p.field).filter(realField))
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function effectOf(l: FieldLink, label: (f: string) => string, group: (k: string) => string) {
  const t = l.target.kind === 'group' ? group(l.target.key) : label(l.target.field)
  switch (l.kind) {
    case 'visibility':
      return `shows or hides ${t}`
    case 'skip':
      return `skips ${t}`
    case 'field_rule':
      return `fills ${t}`
    case 'formula':
      return `calculates ${t}`
    case 'default':
      return `sets the starting value of ${t}`
    case 'cascade':
      return l.filterOnly ? `narrows the choices of ${t}` : `filters and clears ${t}`
    case 'parent_cascade':
      return `filters the rows of ${t}`
    case 'row_rule':
      return `drives row rules in ${t}`
  }
}

/**
 * What the trash says about a removal: the rules driven by fields the drop
 * takes off the form entirely. Null when nothing depends on them.
 */
export function trashWarning(input: {
  bundle: LayoutBundle
  ops: LayoutOp[]
  links: FieldLink[]
  label: (field: string) => string
  groupLabel: (key: string) => string
}): TrashWarning | null {
  let after: LayoutBundle
  try {
    after = applyLayoutOps(input.bundle, input.ops)
  } catch {
    return null
  }
  const still = placedFields(after)
  const gone = [...placedFields(input.bundle)].filter((f) => !still.has(f))
  if (gone.length === 0) return null
  const goneSet = new Set(gone)
  const groupsLeft = new Set(after.groups.map((g) => g.key))
  const groupsGone = new Set(
    input.bundle.groups.map((g) => g.key).filter((k) => !groupsLeft.has(k))
  )
  const seen = new Set<string>()
  const hits: FieldLink[] = []
  for (const l of input.links) {
    if (!goneSet.has(l.driver)) continue
    // Rules about what leaves in the same drop do not matter any more.
    if (l.target.kind === 'group' && groupsGone.has(l.target.key)) continue
    if (l.target.kind === 'field' && (goneSet.has(l.target.field) || l.target.field === l.driver))
      continue
    const k = `${l.kind}|${l.target.kind}:${l.target.kind === 'group' ? l.target.key : l.target.field}`
    if (seen.has(k)) continue
    seen.add(k)
    hits.push(l)
  }
  if (hits.length === 0) return null
  hits.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
  const drivers = [...new Set(hits.map((h) => h.driver))]
  const n = plural(hits.length, 'rule')
  const headline =
    drivers.length === 1
      ? `${input.label(drivers[0])} drives ${n}`
      : `${drivers.length} of these fields drive ${n}`
  const effects = hits.map((h) => {
    const e = effectOf(h, input.label, input.groupLabel)
    const line = drivers.length === 1 ? e : `${input.label(h.driver)} ${e}`
    return line.charAt(0).toUpperCase() + line.slice(1)
  })
  return { headline, effects, count: hits.length }
}

/**
 * The trash's warning for the editor: rule dependencies (useCanvasExplain's
 * `deps`) plus the collection's formulas. Returns the function
 * LayoutDndProvider asks when a removable drag starts.
 */
export function useTrashWarning(
  collection: string,
  deps: RuleDep[],
  label: (field: string) => string,
  groupLabel: (key: string) => string
): (bundle: LayoutBundle, ops: LayoutOp[]) => TrashWarning | null {
  const { data: rows = [] } = useCollectionBody(collection, {
    select: (b) => (Array.isArray(b?.fields) ? (b.fields as LinkFieldRow[]) : [])
  })
  const links = useMemo<FieldLink[]>(
    () => [...deps.map((d) => ({ ...d }) as FieldLink), ...formulaLinks(rows)],
    [deps, rows]
  )
  return useCallback(
    (bundle: LayoutBundle, ops: LayoutOp[]) =>
      trashWarning({ bundle, ops, links, label, groupLabel }),
    [links, label, groupLabel]
  )
}
