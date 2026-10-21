import { resolveOptionFilterTokens } from '../../../lib/option-filter-tokens'
import { userOptionFilter } from '../../../lib/utils'
import { buildCascadeFilter, type CascadeRule } from '../../item-edit/helpers'

// #2637: the narrowing a relation picker applies for one saved record, built
// with the record form's own compilers (buildCascadeFilter for the cascades,
// resolveOptionFilterTokens for the option filter) so the preview offers what
// the picker would. The server counts each step as the admin and applies the
// picker exclusions (/layout-inspect/picker-preview).

export interface PreviewStep {
  key: string
  label: string
  filter: Record<string, unknown> | null
}

export interface PreviewNarrowing {
  steps: PreviewStep[]
  /** Parents the cascades read a value from. */
  satisfied: string[]
  /** A parent the picker waits for (show_all_if_no_parent false) that is empty. */
  waitsFor: string | null
}

export function previewNarrowing(input: {
  target: string
  rules: CascadeRule[]
  optionFilter: Record<string, unknown> | null | undefined
  /** The sample record as stored. */
  record: Record<string, unknown>
  itemId: string
  /** Many-to-many parents: the ids the record links (the form reads them from its junction). */
  linked?: Record<string, Array<string | number>>
  labelOf: (field: string) => string
}): PreviewNarrowing {
  const linked = input.linked ?? {}
  const cascade = buildCascadeFilter({
    rules: input.rules,
    parentValue: (p) => {
      const v = input.record[p]
      if (v != null && v !== '' && !(Array.isArray(v) && v.length === 0) && typeof v !== 'object')
        return v
      const ids = linked[p]
      if (ids?.length) return ids.length === 1 ? String(ids[0]) : ids.map(String)
      // A many-to-one read back expanded ({ id, … }) still names its id.
      if (v && typeof v === 'object' && !Array.isArray(v) && 'id' in v)
        return (v as { id: unknown }).id
      return null
    }
  })
  const option = resolveOptionFilterTokens(
    input.optionFilter && typeof input.optionFilter === 'object' ? input.optionFilter : undefined,
    input.record,
    input.itemId
  )
  const steps: PreviewStep[] = []
  if (input.target === 'nivaro_users')
    steps.push({ key: 'people', label: 'Active people', filter: userOptionFilter(true) })
  if (input.rules.length)
    steps.push({
      key: 'cascade',
      label: cascade.satisfiedParents.length
        ? `Cascade filters (${cascade.satisfiedParents.map(input.labelOf).join(', ')})`
        : 'Cascade filters (no parent value)',
      filter: cascade.filter ?? null
    })
  if (input.optionFilter && Object.keys(input.optionFilter).length)
    steps.push({ key: 'option_filter', label: 'Option filter', filter: option ?? null })
  return {
    steps,
    satisfied: cascade.satisfiedParents,
    waitsFor: cascade.missingRequiredParents[0] ?? null
  }
}

/** The many-to-many parents among the cascade rules: alias field → junction read. */
export function m2mParents(
  rules: CascadeRule[],
  collection: string,
  relations: Array<{
    many_collection?: string | null
    many_field?: string | null
    one_collection?: string | null
    one_field?: string | null
    junction_field?: string | null
  }>
): Array<{ parent: string; junction: string; parentFk: string; targetFk: string }> {
  const out: Array<{ parent: string; junction: string; parentFk: string; targetFk: string }> = []
  for (const p of [...new Set(rules.map((r) => r.parent_field))]) {
    const r = relations.find((x) => x.one_collection === collection && x.one_field === p)
    if (!r?.many_collection || !r.many_field) continue
    let targetFk = r.junction_field ?? null
    if (!targetFk) {
      const companion = relations.find(
        (c) => c.many_collection === r.many_collection && c !== r && c.many_field !== r.many_field
      )
      targetFk = companion?.many_field ?? null
    }
    if (!targetFk) continue
    out.push({ parent: p, junction: r.many_collection, parentFk: r.many_field, targetFk })
  }
  return out
}
