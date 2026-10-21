import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(),
  getAiModelSettings: vi.fn()
}))

import {
  buildCommandPrompt,
  type CommandContext,
  parseCommandAnswer
} from '../../../services/ai-design/layout-command.js'
import {
  buildLayoutPrompt,
  type LayoutFinding,
  parseLayoutAnswer,
  STEP_FIELD_LIMIT
} from '../../../services/ai-design/layout-review.js'
import {
  attachSplitChangeSets,
  planSplit,
  ruleSplit,
  splitCandidates,
  validateSplit
} from '../../../services/ai-design/layout-split.js'
import {
  applyLayoutOps,
  type LayoutBundle,
  newGroup,
  newPlacement
} from '../../../services/layout-ops-apply.js'

const N = 34

function crowded(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Default', layout_type: 'grouped' },
    groups: [
      { ...newGroup('tabs', 'Steps', 'container', null), sort: 0 },
      { ...newGroup('details', 'Details', 'tab', 'tabs'), sort: 0 },
      { ...newGroup('review', 'Review', 'tab', 'tabs'), sort: 1 }
    ],
    placements: [
      ...Array.from({ length: N }, (_, i) => ({ ...newPlacement(`f${i}`, 'details'), sort: i })),
      { ...newPlacement('secret', 'details'), sort: N, is_visible: false },
      { ...newPlacement('ok', 'review'), sort: 0 }
    ],
    rev: 'rev-1'
  }
}

const finding = (key: string): LayoutFinding => ({
  id: `too_many_fields:${key}`,
  kind: 'too_many_fields',
  severity: 'warn',
  source: 'rules',
  field: `f${STEP_FIELD_LIMIT}`,
  field_label: null,
  group: { id: 2, key, label: 'Details' },
  message: '',
  suggestion: '',
  fix: null
})

describe('restructure change sets (#2587)', () => {
  it('splits a 34-field step into 3 balanced steps as one valid ops batch', () => {
    const b = crowded()
    const [c] = splitCandidates([finding('details')], b)
    expect(c).toMatchObject({ group: 'details', parts: 3 })
    expect(c.fields).toHaveLength(N) // the hidden field stays where it is
    const parts = ruleSplit('Details', c.fields, c.parts)
    expect(parts.map((p) => p.fields.length)).toEqual([12, 11, 11])
    expect(parts.map((p) => p.label)).toEqual(['Details', 'Details (2)', 'Details (3)'])

    const cs = planSplit(b, 'details', parts, (f) => f.toUpperCase())
    expect(cs?.title).toBe('Split into 3 steps')
    expect(cs?.base_rev).toBe('rev-1')
    const after = applyLayoutOps(b, cs?.ops ?? [])
    const tabs = after.groups
      .filter((g) => g.parent_key === 'tabs')
      .sort((x, y) => x.sort - y.sort)
      .map((g) => g.key)
    expect(tabs).toEqual(['details', 'details_2', 'details_3', 'review'])
    const count = (k: string) => after.placements.filter((p) => p.group_key === k).length
    expect([count('details'), count('details_2'), count('details_3')]).toEqual([13, 11, 11])
    expect(cs?.steps[0]).toMatch(/^Add step "Details \(2\)" after "Details" with 11 fields: F12/)
  })

  it('uses the model parts only when they cover every field exactly once', () => {
    const fields = ['a', 'b', 'c', 'd']
    expect(
      validateSplit(
        [
          { label: 'Who', fields: ['c', 'a'] },
          { label: 'What', fields: ['b', 'd'] }
        ],
        fields
      )
    ).toEqual([
      { label: 'Who', fields: ['a', 'c'] },
      { label: 'What', fields: ['b', 'd'] }
    ])
    expect(validateSplit([{ label: 'All', fields }], fields)).toBeNull()
    expect(
      validateSplit(
        [
          { label: 'A', fields: ['a', 'b'] },
          { label: 'B', fields: ['b', 'c', 'd'] }
        ],
        fields
      )
    ).toBeNull()
    expect(
      validateSplit(
        [
          { label: 'A', fields: ['a'] },
          { label: 'B', fields: ['c', 'd'] }
        ],
        fields
      )
    ).toBeNull()
  })

  it('attaches a change set per crowded group, naming parts from a valid model answer', () => {
    const b = crowded()
    const fields = Array.from({ length: N }, (_, i) => `f${i}`)
    const ai = new Map<string, unknown>([
      [
        'details',
        [
          { label: 'Basics', fields: fields.slice(0, 10) },
          { label: 'Shipping', fields: fields.slice(10, 22) },
          { label: 'Billing', fields: fields.slice(22) }
        ]
      ]
    ])
    const [f] = attachSplitChangeSets([finding('details')], b, (x) => x, ai) as Array<
      LayoutFinding & { change_set?: { source: string; steps: string[] } }
    >
    expect(f.change_set?.source).toBe('ai')
    expect(f.change_set?.steps[0]).toBe('Rename step "Details" to "Basics"')
    // A model answer that drops a field falls back to the rules split.
    const bad = new Map<string, unknown>([['details', [{ label: 'x', fields: ['f0'] }]]])
    const [g] = attachSplitChangeSets([finding('details')], b, (x) => x, bad) as Array<
      LayoutFinding & { change_set?: { source: string } }
    >
    expect(g.change_set?.source).toBe('rules')
  })

  it('asks the model for splits only when there is one to ask', () => {
    const model = {
      layout: { id: 7, name: 'Default', collection: 'orders', layout_type: 'grouped' },
      groups: [],
      fields: []
    }
    expect(JSON.parse(buildLayoutPrompt(model, [])).split_wanted).toBeUndefined()
    const ask = [{ group: 'details', label: 'Details', parts: 3, fields: ['a'] }]
    expect(JSON.parse(buildLayoutPrompt(model, [], ask)).split_wanted).toEqual(ask)
    const answer = parseLayoutAnswer(
      JSON.stringify({ splits: [{ group: 'details', parts: [{ label: 'x', fields: ['a'] }] }] }),
      model,
      []
    )
    expect(answer.splits.get('details')).toEqual([{ label: 'x', fields: ['a'] }])
  })
})

describe('command palette AI half (#2586)', () => {
  const ctx = (): CommandContext => ({
    bundle: crowded(),
    fields: new Map([
      ['f0', 'Zone'],
      ['f1', 'Region'],
      ['ok', 'OK'],
      ['extra', 'Extra Field']
    ]),
    roles: [{ id: 'r-fin', name: 'Finance' }]
  })

  it('summarises the layout for the model without values', () => {
    const p = JSON.parse(buildCommandPrompt(ctx(), 'tidy up'))
    expect(p.instruction).toBe('tidy up')
    expect(p.groups.map((g: { key: string }) => g.key)).toEqual(['tabs', 'details', 'review'])
    expect(p.other_fields).toEqual([{ field: 'extra', label: 'Extra Field' }])
    expect(p.roles).toEqual(['Finance'])
  })

  it('keeps intents that name real things and drops the rest', () => {
    const r = parseCommandAnswer(
      JSON.stringify({
        intents: [
          { kind: 'move_field', field: 'f0', to_group: 'review' },
          { kind: 'move_field', field: 'ghost', to_group: 'review' },
          { kind: 'set_field', field: 'f1', required: true, role: 'finance', width: 6 },
          { kind: 'add_field', field: 'extra', to_group: null },
          { kind: 'add_field', field: 'f0', to_group: null },
          { kind: 'update_group', group: 'nowhere', label: 'x' },
          { kind: 'drop_table', table: 'users' }
        ],
        explanation: 'Moves Zone.'
      }),
      ctx()
    )
    expect(r.error).toBeNull()
    expect(r.dropped).toBe(4)
    expect(r.intents).toEqual([
      { kind: 'move_field', field: 'f0', to_group: 'review' },
      { kind: 'set_field', field: 'f1', required: true, width: 6, role: 'r-fin' },
      { kind: 'add_field', field: 'extra', to_group: null }
    ])
  })

  it('passes a refusal or an unreadable answer through as an error', () => {
    expect(parseCommandAnswer('{"error":"Cannot delete fields"}', ctx()).error).toBe(
      'Cannot delete fields'
    )
    expect(parseCommandAnswer('no idea', ctx()).error).toMatch(/not readable/)
    expect(parseCommandAnswer('{"intents":[]}', ctx()).error).toMatch(/nothing/)
  })
})
