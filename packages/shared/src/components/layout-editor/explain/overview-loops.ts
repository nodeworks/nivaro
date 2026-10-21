import type { DescribeField } from '../overview/describe-conditions'
import type { OverviewRow } from '../overview/types'
import { loopSentence } from './field-sources'
import {
  findRuleLoops,
  type RuleFieldRow,
  type RuleFieldRule,
  type RuleLayout,
  ruleDependencies
} from './rule-graph'

/**
 * Rule loops on the Layouts overview (#2642). A loop through a form's
 * sections belongs to that form's row; a loop of field rules and cascades
 * alone is the collection's, the same on every form: said once, above.
 */
export function overviewLoops(
  rows: OverviewRow[],
  fields: RuleFieldRow[],
  fieldRules: RuleFieldRule[],
  describe: DescribeField[]
): { byLayout: Map<number, string[]>; collection: string[] } {
  const byLayout = new Map<number, string[]>()
  const collection = new Set<string>()
  for (const row of rows) {
    const shape = row.rule_shape
    if (!shape) continue
    const layout: RuleLayout = { groups: shape.groups, placements: shape.placements }
    const labels = new Map(shape.groups.map((g) => [g.key, g.label || g.key]))
    const label = (k: string) => labels.get(k) ?? k
    const own: string[] = []
    for (const loop of findRuleLoops(ruleDependencies(layout, fields, fieldRules), layout)) {
      const text = loopSentence(loop, describe, label)
      if (loop.kind === 'self' || loop.kinds.includes('visibility')) own.push(text)
      else collection.add(text)
    }
    if (own.length > 0) byLayout.set(row.layout_id, own)
  }
  return { byLayout, collection: [...collection] }
}
