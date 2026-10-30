import { describe, expect, it } from 'vitest'
import {
  cronInWords,
  describeAlert,
  describeCascadeFilter,
  describeCondition,
  describeFieldChangeImpact,
  describeFieldReach,
  describeFieldRule,
  describeFieldSource,
  describeFilterObject,
  describeFlow,
  describeLockCondition,
  describeOwnerGroup,
  describeSectionShowWhen,
  describeTransition,
  describeValidationRule,
  describeValidationRules,
  describeVisibilityRules,
  type SentenceLabels,
  sentenceLabelsFromFields
} from './config-sentences'

const L: SentenceLabels = {
  fields: { zone: 'Zone', amount: 'Amount', region: 'Region', vendor: 'Vendor', status: 'Status' },
  types: { amount: 'decimal', name: 'string', due: 'date', is_priority: 'boolean' },
  choices: { zone: { E: 'East', W: 'West' }, status: { cancelled: 'Cancelled' } },
  records: { region: { '7': 'North' } },
  collections: { lines: 'Lines', vendors: 'Vendors', projects: 'Projects', workflows: 'Workflows' },
  relatedFields: {
    lines: { amount: 'Line Amount', status: 'Status', price: 'Price', qty: 'Quantity' },
    vendors: { zone: 'Zone' },
    projects: { zone: 'Zone', default_zone: 'Default Zone' }
  },
  links: { project: 'projects' },
  roles: { r1: 'Finance', r2: 'Admin' },
  states: { s1: 'Review', s2: 'Approved' },
  formats: { amount: 'money' }
}

describe('conditions', () => {
  it('uses labels, choice labels and words', () => {
    expect(describeCondition('zone', 'eq', 'E', L)).toBe('Zone is East')
    expect(describeCondition('amount', 'gt', 50000, L)).toBe('Amount is over $50,000')
    expect(describeCondition('zone', 'in', 'E,W', L)).toBe('Zone is East or West')
  })
  it('is null-safe', () => {
    expect(describeCondition('zone', 'null', null, L)).toBe('Zone is empty')
    expect(describeCondition('zone', 'eq', '', L)).toBe('Zone is empty')
    expect(describeCondition('zone', 'neq', 'E', L)).toBe('Zone is not East (or is empty)')
  })
  it('gives nothing for unknown ops', () => {
    expect(describeCondition('zone', 'related_some', 'x', L)).toBeNull()
  })
  it('reads filter objects, including null-safe _neq and nested relations', () => {
    expect(describeFilterObject({ status: { _neq: 'cancelled' } }, L)).toBe(
      'Status is not Cancelled (or is empty)'
    )
    expect(describeFilterObject({ zone: 'E', amount: { _gte: 10 } }, L)).toBe(
      'Zone is East and Amount is at least $10'
    )
    expect(describeFilterObject({ project: { zone: { _eq: 'E' } } }, L)).toBe('Project’s Zone is E')
    expect(describeFilterObject({ zone: { _between: [1, 2] } }, L)).toBeNull()
  })
})

describe('field rules', () => {
  it('reads a set rule', () => {
    expect(
      describeFieldRule(
        {
          trigger_field: 'zone',
          trigger_op: 'eq',
          trigger_value: 'E',
          target_field: 'region',
          target_type: 'set',
          target_value: '7',
          only_when_empty: true
        },
        L
      )
    ).toBe('When Zone changes to East, set Region to North (only if Region is empty).')
  })
  it('reads clear, lookup and from-trigger rules', () => {
    expect(
      describeFieldRule(
        { trigger_field: 'zone', trigger_op: 'null', target_field: 'region', target_type: 'clear' },
        L
      )
    ).toBe('When Zone is cleared, clear Region.')
    expect(
      describeFieldRule(
        {
          trigger_field: 'project',
          trigger_op: 'nnull',
          target_field: 'zone',
          target_type: 'set_from_trigger',
          dynamic_config: { field: 'default_zone' }
        },
        L
      )
    ).toBe('When Project changes to any value, copy the picked Project’s Default Zone into Zone.')
    expect(
      describeFieldRule(
        {
          trigger_field: 'zone',
          trigger_op: 'nnull',
          target_field: 'vendor',
          target_type: 'set_lookup',
          dynamic_config:
            '{"collection":"vendors","filter_field":"zone","filter_op":"eq","select":"id"}'
        },
        L
      )
    ).toBe(
      'When Zone changes to any value, set Vendor to the Id of each Vendors record whose Zone is the new Zone.'
    )
  })
  it('gives nothing for an empty eq trigger (it never matches a cleared field)', () => {
    expect(
      describeFieldRule(
        { trigger_field: 'zone', trigger_op: 'eq', trigger_value: '', target_field: 'region' },
        L
      )
    ).toBeNull()
    expect(
      describeFieldRule(
        {
          trigger_field: 'zone',
          trigger_op: 'eq',
          trigger_value: 'E',
          target_field: 'region',
          target_type: 'weird'
        },
        L
      )
    ).toBeNull()
  })
})

describe('cascade filters', () => {
  it('reads the picker narrowing and its switches', () => {
    expect(
      describeCascadeFilter(
        {
          parent_field: 'zone',
          filter_column: 'zone',
          show_all_if_no_parent: false,
          upstream: true
        },
        { field: 'vendor', relatedCollection: 'vendors' },
        L
      )
    ).toEqual([
      'Vendor only offers Vendors whose Zone is this record’s Zone.',
      'Changing Zone clears Vendor.',
      'Vendor stays locked until Zone is picked.',
      'Picking a Vendor fills Zone from it.'
    ])
  })
  it('gives nothing without a parent', () => {
    expect(describeCascadeFilter({ filter_column: 'zone' }, { field: 'vendor' }, L)).toBeNull()
  })
})

describe('alerts', () => {
  it('reads a threshold alert with scope and cooldown', () => {
    expect(
      describeAlert(
        {
          collection: 'workflows',
          field: 'amount',
          operator: 'gt',
          threshold: 50000,
          unit: 'dollar',
          cooldown_minutes: 60,
          filters: { zone: 'E' }
        },
        L
      )
    ).toEqual([
      'Alert when a Workflows record’s Amount is over $50,000 (only where Zone is East).',
      'Then wait 60 minutes before alerting on the same record again.'
    ])
  })
  it('reads an anomaly alert; unknown operators give nothing', () => {
    expect(
      describeAlert(
        { collection: 'workflows', field: 'amount', detection_type: 'anomaly', sensitivity: 2 },
        L
      )?.[0]
    ).toBe(
      'Alert when a Workflows record’s Amount is more than 2 standard deviations from its 90-day average.'
    )
    expect(
      describeAlert(
        { collection: 'workflows', field: 'amount', operator: 'between', threshold: 1 },
        L
      )
    ).toBeNull()
  })
})

describe('flows', () => {
  it('reads common crons', () => {
    expect(cronInWords('*/5 * * * *')).toBe('every 5 minutes')
    expect(cronInWords('0 9 * * 1-5')).toBe('every weekday at 09:00 UTC')
    expect(cronInWords('0 0 * * 1')).toBe('every Monday at 00:00 UTC')
    expect(cronInWords('0 0 1 * *')).toBe('on the schedule “0 0 1 * *”')
  })
  it('reads trigger, main path and the failure branch', () => {
    expect(
      describeFlow(
        {
          trigger: 'event',
          trigger_options: { timing: 'after', types: ['create'], collections: ['projects'] },
          operations: [
            { id: 'a', type: 'condition', name: 'Big?', resolve: 'b', reject: 'c' },
            { id: 'b', type: 'mail' },
            { id: 'c', type: 'log' }
          ]
        },
        L
      )
    ).toEqual([
      'Runs after a Projects record is created.',
      'Then it checks a condition (“Big?”), then sends an email.',
      'If the condition is not met, it writes to the log instead.'
    ])
  })
  it('says any collection / every action when the trigger leaves them open', () => {
    expect(describeFlow({ trigger: 'event', trigger_options: {}, operations: [] }, L)).toEqual([
      'Runs after a record in any collection is created, updated or deleted.',
      'It has no steps yet.'
    ])
  })
  it('gives nothing for login triggers and unknown triggers', () => {
    expect(describeFlow({ trigger: 'event', trigger_options: { types: ['login'] } }, L)).toBeNull()
    expect(describeFlow({ trigger: 'custom-thing' }, L)).toBeNull()
  })
})

describe('owner groups', () => {
  it('reads filters and owners', () => {
    expect(
      describeOwnerGroup(
        {
          filters: [{ field: 'zone', op: 'eq', value: 'E' }],
          users: [{ first_name: 'Pat', last_name: 'Lee' }],
          teams: [{ name: 'Finance' }]
        },
        { stateLabel: 'Approval' },
        L
      )
    ).toBe('When Zone is East, Pat Lee and the Finance team own Approval.')
  })
  it('reads the default group; a filterless non-default group gives nothing', () => {
    expect(
      describeOwnerGroup(
        { filters: [], is_default: true, users: [{ email: 'a@x.com' }] },
        { stateLabel: 'Approval' },
        L
      )
    ).toBe('When no other group matches, a@x.com owns Approval.')
    expect(describeOwnerGroup({ filters: [] }, {}, L)).toBeNull()
    expect(
      describeOwnerGroup({ filters: [{ field: 'zone', op: 'null', value: null }] }, {}, L)
    ).toBeNull()
  })
})

describe('transitions', () => {
  it('reads who, when, from/to and requirements', () => {
    expect(
      describeTransition(
        {
          from_state: 's1',
          to_state: 's2',
          required_roles: ['r1'],
          condition_rules: [
            { field: 'zone', op: 'eq', value: 'E' },
            { field: 'amount', op: 'gt', value: 50000 }
          ],
          requirements: [
            {
              type: 'child_fields',
              collection: 'lines',
              fk_field: 'wf',
              fields: ['amount']
            } as never
          ],
          comment_mode: 'required'
        },
        L
      )
    ).toEqual([
      'When Zone is East and Amount is over $50,000, Finance can move it from Review to Approved.',
      'Before it moves, every Lines line needs Line Amount.',
      'A comment is required.'
    ])
  })
  it('reads owner-only and automatic moves; unknown ops give nothing', () => {
    expect(
      describeTransition({ to_state: 's2', require_owner: true, allow_creator: true }, L)?.[0]
    ).toBe('The step’s owner or the record’s creator can move it from any step to Approved.')
    expect(
      describeTransition({ from_state: 's1', to_state: 's2', auto_trigger: true }, L)?.[0]
    ).toBe('It moves by itself from Review to Approved.')
    expect(
      describeTransition(
        { to_state: 's2', condition_rules: [{ field: 'lines', op: 'related_some', value: 'x' }] },
        L
      )
    ).toBeNull()
  })
})

describe('validation rules', () => {
  it('reads each enforced type', () => {
    expect(describeValidationRule({ type: 'min', value: 10 }, 'amount', L)).toBe(
      'Amount must be at least $10.'
    )
    expect(describeValidationRule({ type: 'max', value: 5 }, 'name', L)).toBe(
      'Name must be at most 5 characters long.'
    )
    expect(describeValidationRule({ type: 'email' }, 'name', L)).toBe(
      'Name must be a valid email address.'
    )
    expect(
      describeValidationRule(
        { type: 'required_if', field: 'zone', op: 'eq', value: 'E' },
        'vendor',
        L
      )
    ).toBe('Vendor is required when Zone is East.')
    expect(describeValidationRule({ type: 'gte_field', field: 'start' }, 'due', L)).toBe(
      'Due must be on or after Start.'
    )
    expect(describeValidationRule({ type: 'required', soft: true }, 'vendor', L)).toBe(
      'Vendor is required — a warning only, saving still works.'
    )
  })
  it('gives nothing for types no evaluator enforces', () => {
    expect(describeValidationRule({ type: 'min_length', value: 3 }, 'name', L)).toBeNull()
    expect(describeValidationRules('[{"type":"unique"},{"type":"url"}]', 'name', L)).toEqual([
      'Name must be a full web address.'
    ])
  })
})

describe('show / lock conditions', () => {
  it('reads show and hide rules as isFieldVisible judges them', () => {
    expect(
      describeVisibilityRules(
        [
          { when: 'zone', op: 'eq', value: 'E', action: 'show' },
          { when: 'status', op: 'eq', value: 'cancelled', action: 'hide' }
        ],
        'vendor',
        L
      )
    ).toBe('Vendor shows only when Zone is East; it is hidden when Status is Cancelled.')
    expect(describeLockCondition({ when: 'status', op: 'nnull' }, 'vendor', L)).toBe(
      'Vendor becomes read-only when Status is set.'
    )
    expect(describeSectionShowWhen('[{"field":"zone","op":"eq","value":"W"}]', 'Shipping', L)).toBe(
      'Shipping shows only when Zone is West.'
    )
    expect(
      describeVisibilityRules(
        [{ when: 'zone', op: 'eq', value: 'E', action: 'blink' }],
        'vendor',
        L
      )
    ).toBeNull()
  })
})

describe('field sources', () => {
  it('reads a stored rollup with a null-safe filter', () => {
    const s = describeFieldSource(
      {
        field: 'total',
        computed_type: 'rollup',
        computed_store: true,
        computed_formula: JSON.stringify({
          related_collection: 'lines',
          fk_field: 'wf',
          aggregate: 'sum',
          value_field: 'amount',
          filter: { status: { _neq: 'cancelled' } }
        })
      },
      { ...L, relatedFields: { ...L.relatedFields, lines: { amount: 'Amount', status: 'Status' } } }
    )
    expect(s?.sentence).toBe('Sum of Amount on Lines where Status is not cancelled (or is empty).')
    expect(s?.notes).toContain(
      'Saved on the record and recalculated when one of those records changes.'
    )
    expect(s?.inputs).toEqual(['Amount'])
  })
  it('reads a value formula rollup, a write formula and a lookup', () => {
    expect(
      describeFieldSource(
        {
          field: 'total',
          computed_type: 'rollup',
          computed_formula: JSON.stringify({
            related_collection: 'lines',
            fk_field: 'wf',
            aggregate: 'sum',
            value_formula: '{{price}} * {{qty}}'
          })
        },
        L
      )?.sentence
    ).toBe('Sum of (Price × Quantity) on Lines.')
    const w = describeFieldSource(
      { field: 'net', computed_type: 'write', computed_formula: '{{amount}} - {{tax}}' },
      L
    )
    expect(w?.sentence).toBe('Worked out as Amount - Tax.')
    expect(w?.inputs).toEqual(['Amount', 'Tax'])
    expect(
      describeFieldSource(
        {
          field: 'zone',
          computed_type: 'lookup',
          computed_formula: '{"fk_field":"project","source_field":"zone"}'
        },
        L
      )?.sentence
    ).toBe('Copied from the Project’s Zone when Project is set.')
  })
  it('reads a cross-record default from another field', () => {
    expect(
      describeFieldSource({ field: 'zone' }, L, [
        {
          field: 'project',
          config: { source_collection: 'projects', field_map: { zone: 'zone||default_zone' } }
        }
      ])?.sentence
    ).toBe(
      'Filled from the Project’s Zone (or Default Zone when that is empty) when Project is set, on the form or through the API.'
    )
  })
  it('gives nothing for plain fields and unknown aggregates', () => {
    expect(describeFieldSource({ field: 'name' }, L)).toBeNull()
    expect(
      describeFieldSource(
        {
          field: 't',
          computed_type: 'rollup',
          computed_formula:
            '{"related_collection":"lines","fk_field":"wf","aggregate":"mode","value_field":"a"}'
        },
        L
      )
    ).toBeNull()
  })
})

describe('change impact', () => {
  it('reads a hide with forms and records', () => {
    const r = describeFieldChangeImpact({
      fieldLabel: 'Vendor',
      changes: [{ kind: 'hide' }],
      forms: ['Default', 'Intake', 'Phone', 'Admin'],
      records: { total: 2000, with_value: 1240 }
    })
    expect(r.sentences).toEqual([
      'This will hide Vendor on 4 forms (“Default”, “Intake”, “Phone” and 1 more) and affect 1,240 records that have a Vendor.'
    ])
    expect(r.nonZero).toBe(true)
  })
  it('reads required as the records still missing a value', () => {
    const r = describeFieldChangeImpact({
      fieldLabel: 'Vendor',
      changes: [{ kind: 'require' }],
      forms: ['Default'],
      records: { total: 1240, with_value: 1000 },
      otherRefs: 2
    })
    expect(r.sentences).toEqual([
      'This will make Vendor required on 1 form (“Default”); 240 records of 1,240 have no Vendor yet.',
      '2 other settings also name Vendor.'
    ])
  })
  it('is zero when nothing is touched', () => {
    const r = describeFieldChangeImpact({
      fieldLabel: 'Vendor',
      changes: [{ kind: 'require' }],
      forms: [],
      records: { total: 10, with_value: 10 }
    })
    expect(r.nonZero).toBe(false)
  })
})

describe('field reach and labels from field rows', () => {
  it('reads forms and records; nothing counted gives nothing', () => {
    expect(
      describeFieldReach({
        fieldLabel: 'Vendor',
        forms: ['Default'],
        records: { total: 9, with_value: 1 }
      })
    ).toBe('It is on 1 form (“Default”) and 1 record has a Vendor.')
    expect(describeFieldReach({ fieldLabel: 'Vendor', forms: [], records: null })).toBeNull()
  })
  it('builds labels, choices and links from field rows', () => {
    const labels = sentenceLabelsFromFields(
      [
        {
          field: 'zone',
          label: 'Zone',
          type: 'string',
          options: { choices: [{ value: 'E', text: 'East' }] }
        },
        { field: 'kind', options: '[{"value":"a","text":"$t:alpha"}]' }
      ],
      [{ many_collection: 'wf', many_field: 'project', one_collection: 'projects' }],
      'wf'
    )
    expect(labels.choices).toEqual({ zone: { E: 'East' }, kind: { a: 'Alpha' } })
    expect(labels.links).toEqual({ project: 'projects' })
    expect(describeCondition('zone', 'eq', 'E', labels)).toBe('Zone is East')
  })
  it('reads a back-to-previous transition', () => {
    expect(
      describeTransition({ from_state: 's2', to_state: 's1', to_previous: true }, L)?.[0]
    ).toBe(
      'Anyone who can edit the record can move it from Approved back to the step it came from (Review when that is not known).'
    )
  })
})
