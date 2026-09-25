import { describe, expect, it } from 'vitest'
import { explainProvenance, type RuleProvenance } from '../rule-provenance'

const chain: RuleProvenance = {
  rule_index: 11,
  target_type: 'precedence',
  trigger_field: 'category',
  trigger_value: 106,
  trigger_op: 'nnull',
  trigger_expected: null,
  trigger_related_field: null,
  target_value: null,
  value: 7,
  sources: [
    {
      index: 0,
      source_type: 'o2m_filtered',
      source_field: 'cifa',
      source_related_field: 'task',
      o2m_collection: 'cifa_tasks',
      filter_field: 'project_type',
      filter_value: '35',
      via: { collection: 'cifa_items', id: '27426' },
      via_label: '300324',
      filter_label: 'HQ NFE Projects',
      miss: 'no-match'
    },
    {
      index: 1,
      source_type: 'relation_field',
      source_field: 'cifa',
      source_related_field: 'task',
      via: { collection: 'cifa_items', id: '27426' },
      via_label: '300324',
      miss: 'no-value'
    },
    {
      index: 4,
      source_type: 'parent_m2o',
      source_field: 'project',
      source_related_field: 'default_expenditure_type_p2',
      miss: 'gate-closed'
    },
    {
      index: 9,
      source_type: 'parent_m2o',
      source_field: 'project_type',
      source_related_field: 'task',
      via: { collection: 'project_types', id: '35' },
      via_label: 'HQ NFE Projects',
      value: 7
    },
    {
      index: 10,
      source_type: 'relation_field',
      source_field: 'category',
      source_related_field: 'task',
      miss: 'no-value'
    }
  ]
}

describe('explainProvenance', () => {
  it('leads with the value and the winner, folds the sources tried before it', () => {
    const story = explainProvenance(chain, {
      labelOf: (v) => (String(v) === '7' ? '164 - HE Small Electronics' : String(v)),
      fieldLabel: (f) =>
        f === 'category'
          ? 'Category'
          : f === '$parent.project_type'
            ? "the record's project type"
            : f
    })
    expect(story.value).toBe('164 - HE Small Electronics')
    expect(story.rule).toBe('Rule 12 · runs when Category is set')
    expect(story.winner).toBe(
      "the record's project type HQ NFE Projects → task → 164 - HE Small Electronics"
    )
    expect(story.tried).toEqual([
      'Cifa tasks for 300324 × HQ NFE Projects — no row',
      "cifa 300324's task — empty",
      "the record's project → default expenditure type p2 — not applicable"
    ])
  })

  it('phrases a set rule by its trigger', () => {
    const story = explainProvenance({
      rule_index: 2,
      target_type: 'set',
      trigger_field: 'category',
      trigger_value: 104,
      trigger_op: 'eq',
      trigger_expected: '1',
      trigger_related_field: 'sub_category.__entity__',
      target_value: '1',
      value: '1'
    })
    expect(story.rule).toBe('Rule 3 · runs when Category (sub category) is 1')
    expect(story.winner).toBe('Set to 1 by the rule')
    expect(story.tried).toEqual([])
  })
})
