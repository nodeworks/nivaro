import { describe, expect, it } from 'vitest'
import type { ActiveLayoutData } from '../../item-edit/types'
import {
  dependentsOf,
  fieldsUnder,
  findRuleLoops,
  type RuleLayout,
  ruleDependencies,
  ruleLayoutFromActive
} from './rule-graph'

const vw = (field: string, value: unknown, op = 'eq') => JSON.stringify([{ field, op, value }])

const layout: RuleLayout = {
  groups: [
    { key: 'main' },
    { key: 'sparing', visible_when: vw('is_sparing', 'true') },
    { key: 'tabs' },
    { key: 'tab_a', parent_key: 'tabs', visible_when: vw('kind', 'A') },
    { key: 'inner', parent_key: 'tab_a' }
  ],
  placements: [
    { field: 'is_sparing', group_key: 'main' },
    { field: 'kind', group_key: 'main' },
    { field: 'spare_part', group_key: 'sparing' },
    { field: 'a_field', group_key: 'inner' },
    { field: 'project', group_key: 'main' },
    {
      field: 'category',
      group_key: 'main',
      overrides: {
        dependency_config: {
          cascade_filters: [{ parent_field: 'project', clear_on_parent_change: true }]
        }
      }
    },
    {
      field: 'lines',
      group_key: 'main',
      overrides: {
        options: {
          parent_cascades: [{ parent_field: 'project', child_field: 'project' }],
          row_rules: [{ trigger_field: '$parent.kind', target_field: 'x' }]
        }
      }
    },
    { field: '__comments__', group_key: null }
  ]
}

describe('ruleDependencies', () => {
  it('finds sections, cascades, grid rules and field rules a field drives', () => {
    const deps = ruleDependencies(
      layout,
      [{ field: 'vendor', dependency_config: { cascade_filters: [{ parent_field: 'project' }] } }],
      [
        { trigger_field: 'kind', target_field: 'priority', is_active: true },
        { trigger_field: 'kind', target_field: 'off', is_active: false }
      ]
    )
    expect(dependentsOf(deps, 'is_sparing')).toEqual([
      { driver: 'is_sparing', kind: 'visibility', target: { kind: 'group', key: 'sparing' } }
    ])
    expect(
      dependentsOf(deps, 'kind')
        .map((d) => d.kind)
        .sort()
    ).toEqual(['field_rule', 'row_rule', 'visibility'])
    expect(
      dependentsOf(deps, 'project')
        .map((d) => `${d.kind}:${(d.target as { field: string }).field}`)
        .sort()
    ).toEqual(['cascade:category', 'parent_cascade:lines'])
  })

  it('reads a field’s own cascade filters when the form does not override them', () => {
    const deps = ruleDependencies(
      { groups: [], placements: [{ field: 'vendor', group_key: null }] },
      [
        {
          field: 'vendor',
          dependency_config: JSON.stringify({ cascade_filters: [{ parent_field: 'project' }] })
        }
      ]
    )
    expect(deps).toEqual([
      {
        driver: 'project',
        kind: 'cascade',
        target: { kind: 'field', field: 'vendor' },
        filterOnly: true
      }
    ])
  })

  it('reads skip_if_filled as a comma list or JSON', () => {
    const deps = ruleDependencies({
      groups: [
        { key: 's1', skip_if_filled: 'a, b' },
        { key: 's2', skip_if_filled: '["c"]' }
      ],
      placements: []
    })
    expect(deps.map((d) => d.driver).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('fieldsUnder', () => {
  it('includes nested groups', () => {
    expect(fieldsUnder(layout, 'tab_a')).toEqual(['a_field'])
    expect(fieldsUnder(layout, 'tabs')).toEqual(['a_field'])
  })
})

describe('findRuleLoops', () => {
  it('finds nothing in a well-formed form', () => {
    expect(findRuleLoops(ruleDependencies(layout), layout)).toEqual([])
  })

  it('flags a driver hidden by the very section it shows', () => {
    const l: RuleLayout = {
      groups: [{ key: 'g', label: 'Extra', visible_when: vw('flag', 'true') }],
      placements: [
        { field: 'flag', group_key: 'g' },
        { field: 'other', group_key: 'g' }
      ]
    }
    expect(findRuleLoops(ruleDependencies(l), l)).toEqual([
      { kind: 'self', fields: ['flag'], group: 'g', kinds: ['visibility'] }
    ])
  })

  it('does not count a step skipped by its own field', () => {
    const l: RuleLayout = {
      groups: [{ key: 'g', skip_if_filled: '["flag"]' }],
      placements: [{ field: 'flag', group_key: 'g' }]
    }
    expect(findRuleLoops(ruleDependencies(l), l)).toEqual([])
  })

  it('ignores two pickers that only filter each other; flags them when both clear', () => {
    const l: RuleLayout = {
      groups: [],
      placements: [
        { field: 'project', group_key: null },
        { field: 'sub_type', group_key: null }
      ]
    }
    const rows = (clears: boolean) => [
      {
        field: 'project',
        dependency_config: {
          cascade_filters: [{ parent_field: 'sub_type', clear_on_parent_change: clears }]
        }
      },
      {
        field: 'sub_type',
        dependency_config: {
          cascade_filters: [{ parent_field: 'project', clear_on_parent_change: clears }]
        }
      }
    ]
    expect(findRuleLoops(ruleDependencies(l, rows(false)), l)).toEqual([])
    expect(findRuleLoops(ruleDependencies(l, rows(true)), l)).toEqual([
      { kind: 'cycle', fields: ['project', 'sub_type'], kinds: ['cascade'] }
    ])
  })

  it('finds two field rules that fill each other', () => {
    const l: RuleLayout = { groups: [], placements: [] }
    const deps = ruleDependencies(
      l,
      [],
      [
        { trigger_field: 'a', target_field: 'b' },
        { trigger_field: 'b', target_field: 'c' },
        { trigger_field: 'c', target_field: 'a' }
      ]
    )
    expect(findRuleLoops(deps, l)).toEqual([
      { kind: 'cycle', fields: ['a', 'b', 'c'], kinds: ['field_rule'] }
    ])
  })

  it('finds two sections that each show on a field inside the other', () => {
    const l: RuleLayout = {
      groups: [
        { key: 'g1', visible_when: vw('y', '1') },
        { key: 'g2', visible_when: vw('x', '1') }
      ],
      placements: [
        { field: 'x', group_key: 'g1' },
        { field: 'y', group_key: 'g2' }
      ]
    }
    const loops = findRuleLoops(ruleDependencies(l), l)
    expect(loops).toEqual([{ kind: 'cycle', fields: ['x', 'y'], kinds: ['visibility'] }])
  })

  it('mixes kinds: a rule fills a field whose section shows on the rule’s trigger', () => {
    const l: RuleLayout = {
      groups: [{ key: 'g', visible_when: vw('b', 'x') }],
      placements: [
        { field: 'a', group_key: 'g' },
        { field: 'b', group_key: null }
      ]
    }
    const deps = ruleDependencies(l, [], [{ trigger_field: 'a', target_field: 'b' }])
    const loops = findRuleLoops(deps, l)
    expect(loops).toHaveLength(1)
    expect(loops[0].fields).toEqual(['a', 'b'])
    expect(loops[0].kinds.sort()).toEqual(['field_rule', 'visibility'])
  })
})

describe('ruleLayoutFromActive', () => {
  it('maps container ids to parent keys', () => {
    const active = {
      layout: null,
      groups: [
        {
          id: 1,
          key: 'c',
          label: 'C',
          type: 'container',
          icon: null,
          sort: 0,
          is_collapsed: false
        },
        {
          id: 2,
          key: 't',
          label: 'T',
          type: 'tab',
          icon: null,
          sort: 0,
          is_collapsed: false,
          container_id: 1,
          visible_when: vw('a', '1')
        }
      ],
      assignments: [{ field: 'a', sort: 0, group_key: 't', is_visible: true }]
    } as unknown as ActiveLayoutData
    const l = ruleLayoutFromActive(active)
    expect(l.groups[1]).toMatchObject({ key: 't', parent_key: 'c' })
    expect(fieldsUnder(l, 'c')).toEqual(['a'])
  })
})

describe('overviewLoops', () => {
  it('puts section loops on their form and field-rule loops on the collection', async () => {
    const { overviewLoops } = await import('./overview-loops')
    const row = (id: number, shape?: object) =>
      ({ layout_id: id, rule_shape: shape }) as unknown as import('../overview/types').OverviewRow
    const res = overviewLoops(
      [
        row(1, {
          groups: [
            { key: 'g', label: 'Extra', parent_key: null, visible_when: vw('flag', 'true') }
          ],
          placements: [{ field: 'flag', group_key: 'g' }]
        }),
        row(2, { groups: [], placements: [] }),
        row(3)
      ],
      [],
      [
        { trigger_field: 'a', target_field: 'b' },
        { trigger_field: 'b', target_field: 'a' }
      ],
      [{ field: 'flag', label: 'Flag' }]
    )
    expect([...res.byLayout.keys()]).toEqual([1])
    expect(res.byLayout.get(1)?.[0]).toContain('Flag is inside Extra')
    expect(res.collection).toEqual(['A → B → A depend on each other in a loop (fills a field)'])
  })
})
