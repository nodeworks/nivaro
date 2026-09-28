import { buildCascadeFilter, type CascadeRule } from '../components/item-edit/helpers'
import { resolveOptionFilterTokens } from './option-filter-tokens'

/** What a relation ask in the document-autofill review carries from the
 *  field's own picker configuration. */
export type AskRelationInput = {
  type: 'relation'
  collection: string
  template: string | null
  cascades?: CascadeRule[] | null
  option_filter?: Record<string, unknown> | null
}

export type AskNarrowing = {
  /** The items filter the picker should apply — undefined = every record. */
  extraFilter: Record<string, unknown> | undefined
  /** Parents that narrowed the list, for the picker's "narrowed by" note. */
  narrowedBy: { labels: string[]; keys: string[] }
  /** A parent with show_all_if_no_parent=false that holds no value yet —
   *  the picker waits for it rather than offering everything. */
  requiredParent: string | null
}

/**
 * The narrowing a document-autofill ask's picker applies: the field's
 * cascade rules over the values the proposal is KEEPING (checked fields,
 * checked links, the other asks' answers) plus its option_filter with
 * `$parent.` tokens resolved off the same draft — the same compile as the
 * form's own picker, so an ask never offers a project the form would refuse.
 */
export function askPickerNarrowing(
  input: AskRelationInput,
  draft: Record<string, unknown>,
  labelOf: (field: string) => string
): AskNarrowing {
  const rules = Array.isArray(input.cascades) ? input.cascades : []
  const cascade = buildCascadeFilter({ rules, parentValue: (p) => draft[p] ?? null })
  const option = resolveOptionFilterTokens(input.option_filter ?? undefined, draft, 'new')
  const parts = [cascade.filter, option].filter((f): f is Record<string, unknown> => !!f)
  const extraFilter =
    parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { _and: parts }
  return {
    extraFilter,
    narrowedBy: {
      labels: cascade.satisfiedParents.map(labelOf),
      keys: cascade.satisfiedParents
    },
    requiredParent: cascade.missingRequiredParents[0] ?? null
  }
}
