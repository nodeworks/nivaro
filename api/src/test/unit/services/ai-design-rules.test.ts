import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn(), dbRead: vi.fn() }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(),
  getAiModelSettings: vi.fn()
}))

import {
  type CascadeContext,
  cascadeSentences,
  parseCascadeAnswer,
  validateOptionFilter
} from '../../../services/ai-design/cascade-writer.js'
import {
  type FieldRuleContext,
  fieldRuleSentence,
  parseFieldRuleAnswer
} from '../../../services/ai-design/field-rule-writer.js'
import type { FieldMeta } from '../../../services/ai-design/rule-context.js'
import { m2mTargets, m2oTargets } from '../../../services/ai-design/rule-context.js'
import {
  buildRulePrompt,
  matchesVisibleWhen,
  parseRuleAnswer,
  proposalSentence,
  type RuleContext,
  ruleOps,
  testLockRule,
  testStepRule
} from '../../../services/ai-design/rule-writer.js'
import {
  buildSuggestions,
  checkRule,
  computeStats,
  maskOf,
  parseValidationAnswer,
  patternCandidates,
  regexFromMasks,
  statsForModel
} from '../../../services/ai-design/validation-suggest.js'
import { type LayoutBundle, newGroup, newPlacement } from '../../../services/layout-ops-apply.js'

const F = (field: string, type = 'string', extra: Partial<FieldMeta> = {}): FieldMeta => ({
  field,
  label: field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  type,
  interface: null,
  choices: [],
  ...extra
})

function bundle(): LayoutBundle {
  return {
    layout: { id: 3, collection: 'orders', name: 'Default', layout_type: 'grouped' },
    groups: [
      { ...newGroup('steps', 'Steps', 'container', null), sort: 0 },
      { ...newGroup('details', 'Details', 'tab', 'steps'), sort: 0 },
      { ...newGroup('shipping', 'Shipping', 'tab', 'steps'), sort: 1 },
      { ...newGroup('notes_section', 'Notes', 'section', null), sort: 2 }
    ],
    placements: [
      { ...newPlacement('is_sparing', 'details'), sort: 0 },
      { ...newPlacement('warehouse', 'details'), sort: 1 },
      { ...newPlacement('ship_to', 'shipping'), sort: 0 }
    ],
    rev: 'r1'
  }
}

const ruleCtx = (): RuleContext => ({
  bundle: bundle(),
  fields: [
    F('is_sparing', 'boolean'),
    F('warehouse', 'integer'),
    F('ship_to'),
    F('priority', 'string', {
      choices: [
        { value: 'hi', label: 'High' },
        { value: 'lo', label: 'Low' }
      ]
    }),
    F('lines', 'alias')
  ],
  pipelines: [
    {
      id: 'p1',
      name: 'Order flow',
      states: [
        { key: 'draft', label: 'Draft' },
        { key: 'approved', label: 'Approved' }
      ]
    }
  ],
  roles: [{ id: 'r-fin', name: 'Finance' }],
  m2o: new Map([['warehouse', 'warehouses']])
})

describe('rule writer (#2673)', () => {
  it('turns "hide Shipping when sparing or warehouse 3" into AND-of-negations', () => {
    const ctx = ruleCtx()
    const answer = JSON.stringify({
      kind: 'step',
      group: 'shipping',
      show_when: [
        { field: 'is_sparing', op: 'neq', value: 'yes' },
        { field: 'warehouse', op: 'neq', value: 3 }
      ],
      explanation: 'Hidden when sparing or warehouse 3'
    })
    const r = parseRuleAnswer(answer, ctx)
    expect(r.error).toBeNull()
    expect(r.proposal).toEqual({
      kind: 'step',
      group: 'shipping',
      conditions: [
        { field: 'is_sparing', op: 'neq', value: 'true' },
        { field: 'warehouse', op: 'neq', value: '3' }
      ]
    })
    expect(r.notes[0]).toMatch(/matched as that record's id/)
    const planned = ruleOps(ctx.bundle, r.proposal!)
    expect(planned.ok && planned.ops[0]).toEqual({
      op: 'group_update',
      key: 'shipping',
      patch: { visible_when: JSON.stringify(r.proposal!.conditions) }
    })
    expect(proposalSentence(r.proposal!, ctx)).toBe(
      'Show the step Shipping only when Is Sparing is not yes and Warehouse is not 3'
    )
  })

  it('drops unknown fields, alias fields and bad choice values, and names them', () => {
    const r = parseRuleAnswer(
      JSON.stringify({
        kind: 'step',
        group: 'shipping',
        show_when: [
          { field: 'nope', op: 'eq', value: 'x' },
          { field: 'lines', op: 'nnull' },
          { field: 'priority', op: 'eq', value: 'Medium' },
          { field: 'priority', op: 'in', value: 'High,lo' },
          { field: 'ship_to', op: 'gt', value: '4' }
        ]
      }),
      ruleCtx()
    )
    expect(r.proposal?.conditions).toEqual([{ field: 'priority', op: 'in', value: 'hi,lo' }])
    expect(r.dropped).toHaveLength(4)
  })

  it('refuses sections, a different target and empty results', () => {
    const ctx = ruleCtx()
    const section = parseRuleAnswer(
      JSON.stringify({ kind: 'step', group: 'notes_section', show_when: [] }),
      ctx
    )
    expect(section.error).toMatch(/not a step/)
    const other = parseRuleAnswer(
      JSON.stringify({
        kind: 'step',
        group: 'details',
        show_when: [{ field: 'ship_to', op: 'nnull' }]
      }),
      ctx,
      { kind: 'step', group: 'shipping' }
    )
    expect(other.error).toMatch(/not for the one you asked about/)
    expect(parseRuleAnswer('{"error":"Fields cannot hide"}', ctx).error).toBe('Fields cannot hide')
    expect(parseRuleAnswer('nonsense', ctx).error).toMatch(/not readable/)
  })

  it('maps lock states and roles by label or name; unknown ones are dropped', () => {
    const ctx = ruleCtx()
    const r = parseRuleAnswer(
      JSON.stringify({
        kind: 'lock',
        field: 'ship_to',
        lock_when: [
          { type: 'pipeline_state', pipeline: 'p1', states: ['Approved', 'gone'] },
          { type: 'role', roles: ['finance', 'Nobody'] },
          { type: 'field', field: 'warehouse' }
        ]
      }),
      ctx
    )
    expect(r.proposal).toEqual({
      kind: 'lock',
      field: 'ship_to',
      conditions: [
        { type: 'pipeline_state', pipeline_id: 'p1', state_keys: ['approved'] },
        { type: 'role', role_ids: ['r-fin'] }
      ]
    })
    expect(r.dropped).toHaveLength(3)
    const planned = ruleOps(ctx.bundle, r.proposal!)
    expect(planned.ok && planned.ops[0]).toMatchObject({
      op: 'update_placement',
      at: { field: 'ship_to', group_key: 'shipping' }
    })
    expect(proposalSentence(r.proposal!, ctx)).toBe(
      'Make Ship To read-only when the record is Approved in Order flow, or when the viewer is in Finance'
    )
  })

  it('a lock on a field that is not on the form is refused', () => {
    const r = parseRuleAnswer(
      JSON.stringify({ kind: 'lock', field: 'priority', lock_when: [] }),
      ruleCtx()
    )
    expect(r.error).toMatch(/not on this form/)
  })

  it('counts records like the form evaluator (mirror semantics)', () => {
    const rows = [
      { id: 1, is_sparing: true, warehouse: { id: 3 } },
      { id: 2, is_sparing: false, warehouse: 4 },
      { id: 3, is_sparing: null, warehouse: null },
      { id: 4, is_sparing: false, warehouse: 3 }
    ]
    const t = testStepRule(
      [
        { field: 'is_sparing', op: 'neq', value: 'true' },
        { field: 'warehouse', op: 'neq', value: '3' }
      ],
      [{ field: 'warehouse', op: 'nnull' }],
      rows
    )
    expect(t).toEqual({ checked: 4, matched: 2, current: 3, roles: [] })
    expect(matchesVisibleWhen([{ field: 'a', op: 'in', value: 'x, y' }], { a: 'y' })).toBe(true)
    const l = testLockRule(
      [
        { type: 'pipeline_state', state_keys: ['approved'] },
        { type: 'role', role_ids: ['r-fin'] }
      ],
      null,
      ['approved', 'draft', null, 'approved'],
      ruleCtx()
    )
    expect(l).toEqual({ checked: 4, matched: 2, current: null, roles: ['Finance'] })
  })

  it('the prompt carries config only: steps, fields, choices, pipelines, role names', () => {
    const p = JSON.parse(buildRulePrompt(ruleCtx(), 'hide shipping'))
    expect(p.steps.map((s: { key: string }) => s.key)).toEqual(['details', 'shipping'])
    expect(p.fields.find((f: { field: string }) => f.field === 'lines')).toBeUndefined()
    expect(p.roles).toEqual(['Finance'])
  })
})

const cascadeCtx = (): CascadeContext => ({
  collection: 'orders',
  field: 'region',
  fieldLabel: 'Region',
  related: 'regions',
  fields: [F('zone'), F('region'), F('year', 'integer')],
  relatedFields: [
    F('name'),
    F('zone', 'integer'),
    F('active', 'boolean'),
    F('divisions', 'alias'),
    F('year', 'integer')
  ],
  parents: [
    { field: 'zone', label: 'Zone', kind: 'M2O', target: 'zones' },
    { field: 'divisions', label: 'Divisions', kind: 'M2M', target: 'divisions' }
  ],
  relatedM2o: new Map([['zone', 'zones']]),
  relatedM2m: new Map([['divisions', 'divisions']])
})

describe('cascade writer (#2674)', () => {
  it('keeps matching cascade rules with defaults and drops mismatched ones', () => {
    const r = parseCascadeAnswer(
      JSON.stringify({
        cascade_filters: [
          { parent_field: 'zone', filter_column: 'zone', show_all_if_no_parent: false },
          { parent_field: 'divisions', filter_column: 'divisions' },
          { parent_field: 'zone', filter_column: 'year' },
          { parent_field: 'region', filter_column: 'zone' },
          { parent_field: 'nope', filter_column: 'zone' }
        ],
        option_filter: null
      }),
      cascadeCtx()
    )
    expect(r.error).toBeNull()
    expect(r.cascade_filters).toEqual([
      {
        parent_field: 'zone',
        filter_column: 'zone',
        clear_on_parent_change: true,
        clear_on_unavailable: false,
        show_all_if_no_parent: false
      },
      {
        parent_field: 'divisions',
        filter_column: 'divisions',
        filter_is_m2m: true,
        clear_on_parent_change: true,
        clear_on_unavailable: false,
        show_all_if_no_parent: true
      }
    ])
    expect(r.dropped).toHaveLength(3)
  })

  it('validates option filters: fields, ops, $parent tokens, nesting', () => {
    const dropped: string[] = []
    const f = validateOptionFilter(
      {
        _and: [
          { active: { _eq: true } },
          { year: { _gte: '$parent.year' } },
          { zone: { _eq: '$parent.nope' } },
          { secret: { _eq: 1 } },
          { name: { _regex: '.*' } },
          { name: { _in: ['a', '$parent.zone'] } }
        ]
      },
      cascadeCtx(),
      dropped
    )
    expect(f).toEqual({
      _and: [
        { active: { _eq: true } },
        { year: { _gte: '$parent.year' } },
        { name: { _in: ['a', '$parent.zone'] } }
      ]
    })
    expect(dropped).toHaveLength(3)
  })

  it('describes the result in plain words', () => {
    const ctx = cascadeCtx()
    const r = parseCascadeAnswer(
      JSON.stringify({
        cascade_filters: [{ parent_field: 'zone', filter_column: 'zone' }],
        option_filter: { active: { _eq: true } }
      }),
      ctx
    )
    expect(cascadeSentences(r, ctx)).toEqual([
      "Offer only Region options whose Zone matches the record's Zone",
      'Offer only Region options where Active is yes'
    ])
  })

  it('an answer with nothing usable is an error', () => {
    const r = parseCascadeAnswer(
      JSON.stringify({ cascade_filters: [{ parent_field: 'x', filter_column: 'y' }] }),
      cascadeCtx()
    )
    expect(r.error).toMatch(/Nothing the picker can use/)
  })
})

describe('relation helpers', () => {
  it('reads M2O fields and M2M aliases', () => {
    const rels = [
      {
        many_collection: 'orders',
        many_field: 'zone',
        one_collection: 'zones',
        one_field: null,
        junction_field: null
      },
      {
        many_collection: 'orders_divisions',
        many_field: 'orders_id',
        one_collection: 'orders',
        one_field: 'divisions',
        junction_field: 'divisions_id'
      },
      {
        many_collection: 'orders_divisions',
        many_field: 'divisions_id',
        one_collection: 'divisions',
        one_field: null,
        junction_field: 'orders_id'
      }
    ]
    expect([...m2oTargets('orders', rels)]).toEqual([['zone', 'zones']])
    expect([...m2mTargets('orders', rels)]).toEqual([['divisions', 'divisions']])
  })
})

const ruleFieldCtx = (): FieldRuleContext => ({
  collection: 'orders',
  fields: [F('project', 'integer'), F('zone', 'integer'), F('rush', 'boolean'), F('notes', 'text')],
  m2o: new Map([
    ['project', 'projects'],
    ['zone', 'zones']
  ]),
  targets: new Map([
    ['projects', [F('name'), F('zone', 'integer'), F('lines', 'alias')]],
    ['zones', [F('name')]]
  ])
})

describe('field-rule writer (#2675)', () => {
  it('"Default Zone from the project\'s zone" becomes set_from_trigger, empty-only', () => {
    const ctx = ruleFieldCtx()
    const r = parseFieldRuleAnswer(
      JSON.stringify({
        rule: {
          trigger_field: 'project',
          trigger_op: 'nnull',
          target_field: 'zone',
          target_type: 'set_from_trigger',
          dynamic_config: { field: 'zone' }
        }
      }),
      ctx
    )
    expect(r.error).toBeNull()
    expect(r.rule).toEqual({
      collection: 'orders',
      trigger_field: 'project',
      trigger_op: 'nnull',
      trigger_value: null,
      target_field: 'zone',
      target_type: 'set_from_trigger',
      target_value: null,
      only_when_empty: true,
      dynamic_config: { field: 'zone' }
    })
    expect(fieldRuleSentence(r.rule!, ctx)).toBe(
      "When Project is picked, set Zone from the Project's Zone (only while Zone is empty)"
    )
  })

  it('refuses unknown fields, self-triggers, non-picker triggers and alias sources', () => {
    const ctx = ruleFieldCtx()
    const bad = (rule: Record<string, unknown>) =>
      parseFieldRuleAnswer(JSON.stringify({ rule }), ctx).error
    expect(bad({ trigger_field: 'x', target_field: 'zone' })).toMatch(/not a field/)
    expect(bad({ trigger_field: 'zone', target_field: 'zone', target_type: 'clear' })).toMatch(
      /cannot set the field that triggers/
    )
    expect(
      bad({
        trigger_field: 'rush',
        trigger_op: 'nnull',
        target_field: 'zone',
        target_type: 'set_from_trigger',
        dynamic_config: { field: 'zone' }
      })
    ).toMatch(/not a picker/)
    expect(
      bad({
        trigger_field: 'project',
        target_field: 'zone',
        target_type: 'set_from_trigger',
        dynamic_config: { field: 'lines' }
      })
    ).toMatch(/not a field of the picked record/)
    expect(bad({ trigger_field: 'rush', trigger_op: 'gt', target_field: 'zone' })).toMatch(
      /not a trigger/
    )
  })

  it('normalizes yes/no values and honours the asked-for target', () => {
    const ctx = ruleFieldCtx()
    const r = parseFieldRuleAnswer(
      JSON.stringify({
        rule: {
          trigger_field: 'rush',
          trigger_op: 'eq',
          trigger_value: 'yes',
          target_field: 'notes',
          target_type: 'set',
          target_value: 'Rush order',
          only_when_empty: false
        }
      }),
      ctx,
      'notes'
    )
    expect(r.rule).toMatchObject({ trigger_value: 'true', target_value: 'Rush order' })
    const wrong = parseFieldRuleAnswer(
      JSON.stringify({
        rule: { trigger_field: 'rush', target_field: 'notes', target_type: 'clear' }
      }),
      ctx,
      'zone'
    )
    expect(wrong.error).toMatch(/not for the field you asked about/)
  })
})

describe('validation suggestions (#2680)', () => {
  it('masks values and builds an anchored pattern with run ranges', () => {
    expect(maskOf('PO-12a')).toBe('AA-99a')
    const values = Array.from({ length: 40 }, (_, i) => `PO-${String(100000 + i * 7)}`).concat([
      'PO-99999'
    ])
    const s = computeStats(values, 'string')
    expect(s.prefix).toBe('PO-')
    const re = regexFromMasks(s.masks!, values.length, s.prefix)
    expect(re).toBe('^PO\\-\\d{5,6}$')
    expect(patternCandidates(s)).toEqual([{ type: 'regex', value: '^PO\\-\\d{5,6}$' }])
  })

  it('never sends values to the model: the stats carry shapes only', () => {
    const s = computeStats(['Jane Doe', 'John Smith', 'Ann Lee', 'Bo Yu', 'Al Ng'], 'string')
    const sent = JSON.stringify(statsForModel(s))
    expect(sent).not.toMatch(/Jane|Smith|Doe/)
    expect(s.prefix).toBeNull()
    // Names are free text: no pattern, only a length cap.
    expect(patternCandidates(s).map((r) => r.type)).toEqual(['max', 'min'])
  })

  it('recognizes emails and non-negative numbers', () => {
    const emails = Array.from({ length: 10 }, (_, i) => `u${i}@x.org`)
    expect(patternCandidates(computeStats(emails, 'string'))).toEqual([
      { type: 'email' },
      { type: 'max', value: 8 },
      { type: 'min', value: 8 }
    ])
    expect(patternCandidates(computeStats([1, 2, 3, 4, 5, null], 'integer'))).toEqual([
      { type: 'min', value: 0 }
    ])
    expect(patternCandidates(computeStats([1, 2], 'integer'))).toEqual([])
  })

  it('checks model rules: types, compiling regexes, no nested quantifiers', () => {
    expect(checkRule({ type: 'regex', value: '^(a+)+$' })).toBeNull()
    expect(checkRule({ type: 'regex', value: '^[' })).toBeNull()
    expect(checkRule({ type: 'drop_table' })).toBeNull()
    expect(checkRule({ type: 'max', value: 'ten' })).toBeNull()
    expect(checkRule({ type: 'max', value: '10', message: '  Too long  ' })).toEqual({
      type: 'max',
      value: 10,
      message: 'Too long'
    })
    const parsed = parseValidationAnswer(
      '```json\n{"suggestions":[{"rule":{"type":"regex","value":"^\\\\d{4}$"},"message":"Four digits"},{"rule":{"type":"x"}}]}\n```'
    )
    expect(parsed).toEqual({
      rules: [{ type: 'regex', value: '^\\d{4}$', message: 'Four digits' }],
      dropped: 1
    })
  })

  it('counts existing fails with the server evaluator and skips stored rules', () => {
    const values = ['1234', '12345', '', null, 'abcd']
    const out = buildSuggestions(
      [
        { type: 'regex', value: '^\\d{4}$' },
        { type: 'max', value: 4 }
      ],
      [{ type: 'regex', value: '^\\d{4}$', message: 'Four digits' }],
      [{ type: 'max', value: 4 }],
      values,
      'Code',
      'text'
    )
    expect(out).toEqual([
      {
        rule: { type: 'regex', value: '^\\d{4}$', message: 'Four digits' },
        sentence: 'Values must match the pattern ^\\d{4}$',
        source: 'ai',
        fails: 2
      }
    ])
  })
})
