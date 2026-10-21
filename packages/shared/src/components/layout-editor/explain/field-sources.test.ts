import { describe, expect, it } from 'vitest'
import {
  crossConfigs,
  crossValues,
  ghostText,
  layoutDefaults,
  mergeGhosts,
  ruleTriggers
} from './default-ghosts'
import {
  type ExplainInput,
  fieldStateChips,
  groupRuleChips,
  loopSentence,
  ruleSentence
} from './field-sources'

const describeFields = [
  { field: 'is_sparing', label: 'Is Sparing', type: 'boolean' },
  { field: 'status', label: 'Status', options: { choices: [{ text: 'Open', value: 'open' }] } },
  { field: 'kind', label: 'Kind' },
  { field: 'amount', label: 'Amount' },
  { field: 'notes', label: 'Notes' }
]

const base: ExplainInput = {
  collection: 'orders',
  layout: { groups: [], placements: [] },
  fields: [],
  describe: describeFields,
  choices: { status: { open: 'Open' } },
  fieldRules: [],
  pipelines: [],
  roleNames: new Map([
    ['R1', 'Finance'],
    ['R2', 'Ops']
  ])
}

describe('ruleSentence', () => {
  it('reads like the overview', () => {
    expect(
      ruleSentence([{ field: 'is_sparing', op: 'eq', value: 'true' }], describeFields, base.choices)
    ).toBe('is sparing')
    expect(ruleSentence([{ field: 'status', value: 'open' }], describeFields, base.choices)).toBe(
      'Status is Open'
    )
  })

  it('reads `in` as a list of choices', () => {
    expect(ruleSentence([{ field: 'kind', op: 'in', value: 'A, B,C' }], describeFields, {})).toBe(
      'Kind is A, B or C'
    )
  })
})

describe('fieldStateChips', () => {
  it('names the source of each state', () => {
    const chips = fieldStateChips({
      ...base,
      layout: {
        groups: [],
        placements: [
          { field: 'amount', group_key: null, overrides: { required: true } },
          { field: 'status', group_key: null },
          {
            field: 'notes',
            group_key: null,
            overrides: { readonly: true, hidden: true },
            lock_conditions: JSON.stringify([
              { type: 'role', role_ids: ['r1', 'r2'] },
              { type: 'pipeline_state', state_keys: ['approved', 'closed_out'] }
            ])
          },
          { field: 'kind', group_key: null, overrides: { required: false } }
        ]
      },
      fields: [
        { field: 'status', required: true, readonly: 1 },
        { field: 'kind', required: true, hidden: true },
        { field: 'amount', computed_type: 'rollup' }
      ],
      fieldRules: [
        {
          trigger_field: 'kind',
          trigger_value: 'A',
          target_field: 'status',
          target_type: 'set',
          target_value: 'open'
        }
      ],
      pipelines: [
        {
          id: 'p1',
          name: 'Flow',
          states: [{ id: 's1', key: 'approved', label: 'Approved' }],
          transitions: [
            { label: 'Approve', from_state: null, requirements: [{ fields: ['amount'] }] },
            {
              label: 'Other',
              from_state: null,
              requirements: [{ collection: 'lines', fields: ['notes'] }]
            }
          ]
        }
      ]
    })
    const words = (f: string) => (chips.get(f) ?? []).map((c) => `${c.state}:${c.origin}:${c.text}`)
    expect(words('amount')).toEqual([
      'required:placement:Required here',
      'required:transition:Needed to Approve',
      'readonly:field:Calculated'
    ])
    expect(words('status')).toEqual([
      'required:field:Required field',
      'readonly:field:Read-only field',
      'filled:field_rule:Filled by a rule'
    ])
    expect(words('notes')).toEqual([
      'readonly:placement:Read-only here',
      'readonly:role:Locked for Finance and Ops',
      'readonly:placement:Locked in Approved or Closed Out',
      'hidden:placement:Hidden here'
    ])
    // Optional on this form overrides the field's own required; hidden still comes from the field.
    expect(words('kind')).toEqual(['hidden:field:Hidden field'])
    expect(chips.get('status')?.[2].tip).toBe('When Kind is A, a rule sets it to Open')
  })

  it('opens the setting behind each chip', () => {
    const chips = fieldStateChips({
      ...base,
      layout: {
        groups: [],
        placements: [{ field: 'amount', group_key: null, overrides: { required: true } }]
      },
      pipelines: [
        {
          id: 'p9',
          name: 'Flow',
          states: [],
          transitions: [{ label: 'Go', from_state: null, requirements: [{ fields: ['amount'] }] }]
        }
      ]
    })
    expect(chips.get('amount')?.map((c) => c.open)).toEqual([
      { kind: 'tab', tab: 'rules' },
      { kind: 'pipeline', id: 'p9' }
    ])
  })
})

describe('groupRuleChips', () => {
  it('says when a section shows, skips and who it is hidden or locked for', () => {
    const chips = groupRuleChips({
      ...base,
      layout: {
        groups: [
          {
            key: 'g',
            label: 'Sparing',
            visible_when: JSON.stringify([{ field: 'is_sparing', op: 'eq', value: 'true' }]),
            skip_if_filled: '["kind"]',
            hidden_for_roles: '["R1"]',
            locked_for_roles: '["r2"]'
          },
          { key: 'plain' }
        ],
        placements: []
      }
    })
    expect(chips.get('g')?.map((c) => c.text)).toEqual([
      'Shows when is sparing',
      'Skipped when Kind is filled',
      'Hidden for Finance',
      'Read-only for Ops'
    ])
    expect(chips.has('plain')).toBe(false)
  })
})

describe('loopSentence', () => {
  it('words both kinds of loop', () => {
    expect(
      loopSentence(
        { kind: 'self', fields: ['is_sparing'], group: 'g', kinds: ['visibility'] },
        describeFields,
        () => 'Sparing'
      )
    ).toBe(
      'Is Sparing is inside Sparing, which shows only by its value — once hidden, nobody can change it back'
    )
    expect(
      loopSentence(
        { kind: 'cycle', fields: ['kind', 'status'], kinds: ['field_rule'] },
        describeFields,
        (k) => k
      )
    ).toBe('Kind → Status → Kind depend on each other in a loop (fills a field)')
  })
})

describe('default ghosts', () => {
  it('orders layout defaults, rule results and cross-record values', () => {
    const defaults = layoutDefaults('{"status":"open","project":7,"kind":null}')
    expect(defaults).toEqual({ status: 'open', project: 7, kind: null })
    expect(
      ruleTriggers(defaults, [
        { trigger_field: 'project', target_field: 'region' },
        { trigger_field: 'status', target_field: 'x', is_active: 0 }
      ])
    ).toEqual([{ field: 'project', value: 7, targets: ['region'] }])
    const cfg = crossConfigs([
      {
        field: 'project',
        cross_record_defaults: {
          source_collection: 'projects',
          field_map: { region: 'region_id||area' }
        }
      },
      { field: 'nope', cross_record_defaults: '{}' }
    ])
    expect(cfg).toEqual([
      {
        field: 'project',
        source_collection: 'projects',
        fk: 'project',
        field_map: { region: 'region_id||area' }
      }
    ])
    expect(crossValues(cfg[0], { region_id: null, area: 'North' })).toEqual({ region: 'North' })
    const ghosts = mergeGhosts(
      defaults,
      [{ region: 3, status: null }],
      [{ from: 'project', values: { region: 'North' } }]
    )
    expect([...ghosts.entries()]).toEqual([
      ['project', { value: 7, via: 'layout' }],
      ['kind', { value: null, via: 'layout' }],
      ['region', { value: 'North', via: 'cross', from: 'project' }]
    ])
  })

  it('words a ghost by where it comes from', () => {
    expect(
      ghostText('status', { value: 'open', via: 'layout' }, describeFields, base.choices)
    ).toBe('Default: Open')
    expect(
      ghostText('is_sparing', { value: true, via: 'rule' }, describeFields, {}, 'boolean')
    ).toBe('By rule: Yes')
    expect(ghostText('x', { value: 'N', via: 'cross', from: 'kind' }, describeFields, {})).toBe(
      'From Kind: N'
    )
    expect(ghostText('x', { value: [1, 2], via: 'layout' }, describeFields, {})).toBe(
      'Default: 2 linked'
    )
    expect(ghostText('x', { value: null, via: 'layout' }, describeFields, {})).toBeNull()
  })
})
