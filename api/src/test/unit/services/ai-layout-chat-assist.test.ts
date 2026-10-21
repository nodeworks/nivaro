import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(async () => null),
  getAiModelSettings: vi.fn(async () => ({ chatModel: 'test-chat', generateModel: 'test-gen' }))
}))
vi.mock('../../../services/ai-design/layout-explain-field.js', () => {
  class LayoutAssistError extends Error {
    constructor(
      readonly statusCode: number,
      message: string
    ) {
      super(message)
    }
  }
  return {
    LayoutAssistError,
    findRole: vi.fn(async (r: unknown) => (r ? { id: 'R1', name: String(r), admin: false } : null)),
    whichForm: vi.fn(async () => ({
      as: 'Finance',
      record: '284212',
      layout: { id: 9, name: 'Finance form' },
      why: 'it is the form for this role',
      checked: []
    })),
    explainField: vi.fn(),
    collectionLabels: vi.fn()
  }
})

import {
  cleanCandidates,
  findSetting,
  parseFindAnswer
} from '../../../services/ai-design/find-setting.js'
import { askAboutLayout } from '../../../services/ai-design/layout-ask.js'
import { diffSides, parseExplainAnswer } from '../../../services/ai-design/layout-diff-explain.js'
import { describeLayoutOps } from '../../../services/ai-design/layout-facts.js'
import { checkLayoutOps } from '../../../services/ai-design/layout-proposals.js'
import { type LayoutBundle, newGroup, newPlacement } from '../../../services/layout-ops-apply.js'

const bundle = (): LayoutBundle => ({
  layout: { id: 5, collection: 'orders', name: 'Default', layout_type: 'grouped' },
  groups: [
    { ...newGroup('details', 'Details', 'section', null), sort: 0 },
    { ...newGroup('money', 'Money', 'section', null), sort: 1 }
  ],
  placements: [
    { ...newPlacement('zone', 'details'), sort: 0 },
    { ...newPlacement('region', 'details'), sort: 1 },
    { ...newPlacement('amount', 'money'), sort: 0 }
  ],
  rev: 'r1'
})

const labels = new Map([
  ['zone', 'Zone'],
  ['region', 'Region'],
  ['amount', 'Amount'],
  ['notes', 'Notes']
])
const facts = {
  labels,
  roleNames: new Map([['R1', 'Finance']]),
  ctx: {
    fields: [...labels.keys()].map((field) => ({ field, label: labels.get(field) })),
    roles: [],
    requirements: []
  }
}

describe('layout proposals: checkLayoutOps (#2694)', () => {
  it('keeps valid ops and describes them in plain words', () => {
    const res = checkLayoutOps(facts, bundle(), [
      {
        op: 'move',
        from: { field: 'zone', group_key: 'details' },
        to_group_key: 'money',
        index: 0
      },
      {
        op: 'update_placement',
        at: { field: 'region', group_key: 'details' },
        patch: { col_span: 6, overrides: { required: true } }
      },
      { op: 'place', field: 'notes', group_key: 'money', index: 5 }
    ])
    expect(res.error).toBeNull()
    expect(res.ops).toHaveLength(3)
    expect(res.sentences).toEqual([
      'Move Zone from Details to Money',
      'Region: half width, required',
      'Add Notes to Money'
    ])
  })

  it('drops unknown fields, op kinds and settings keys, and names each', () => {
    const res = checkLayoutOps(facts, bundle(), [
      { op: 'place', field: 'ghost', group_key: 'money', index: 0 },
      { op: 'explode' },
      {
        op: 'update_placement',
        at: { field: 'zone', group_key: 'details' },
        patch: { col_span: 4, colour: 'red' }
      }
    ])
    expect(res.ops).toHaveLength(1)
    expect(res.dropped).toEqual([
      'Change 1: no field “ghost” on this collection',
      'Change 2: “explode” is not a layout change',
      'Change 3: unknown setting “colour” left out'
    ])
    expect(res.error).toBeNull()
  })

  it('refuses ops the ops twin rejects, naming the op', () => {
    const res = checkLayoutOps(facts, bundle(), [
      { op: 'remove', at: { field: 'nowhere', group_key: 'details' } }
    ])
    expect(res.error).toBeTruthy()
    expect(res.op_index).toBe(0)
  })

  it('refuses an empty proposal', () => {
    expect(checkLayoutOps(facts, bundle(), []).error).toBe('No change is left to propose')
    expect(checkLayoutOps(facts, bundle(), 'nope').error).toBe('No change is left to propose')
  })

  it('names a section the batch creates by its label', () => {
    const s = describeLayoutOps(facts, bundle(), [
      {
        op: 'group_create',
        key: 'review',
        label: 'Review',
        group_type: 'tab',
        parent_key: null,
        index: 2
      },
      {
        op: 'move',
        from: { field: 'zone', group_key: 'details' },
        to_group_key: 'review',
        index: 0
      },
      { op: 'group_update', key: 'money', patch: { hidden_for_roles: '["r1"]' } },
      { op: 'layout_update', patch: { disable_comments: true } }
    ])
    expect(s).toEqual([
      'Add step “Review”',
      'Move Zone from Details to Review',
      'Money: hidden for roles Finance',
      'Form settings: disable comments on'
    ])
  })
})

describe('find a setting (#2676)', () => {
  const candidates = cleanCandidates([
    { key: 'layout.disable_comments', label: 'Comments panel', where: 'Form settings' },
    { key: 'field.required', label: 'Required', where: 'Inspector · Rules' },
    { key: 'bad key!', label: 'x' },
    { key: 'field.required', label: 'duplicate' }
  ])

  it('cleans the candidate list', () => {
    expect(candidates.map((c) => c.key)).toEqual(['layout.disable_comments', 'field.required'])
  })

  it('keeps only keys from the list', () => {
    const res = parseFindAnswer(
      '```json\n{"keys":["layout.disable_comments","made.up"],"explanation":"Comments are a form setting."}\n```',
      candidates
    )
    expect(res.keys).toEqual(['layout.disable_comments'])
    expect(res.dropped).toBe(1)
    expect(res.explanation).toBe('Comments are a form setting.')
  })

  it('treats an unreadable answer as no match', () => {
    expect(parseFindAnswer('no idea', candidates).keys).toEqual([])
  })

  it('sends the question and the list to the model', async () => {
    const complete = vi.fn(async () => '{"keys":["field.required"]}')
    const res = await findSetting('where do I make a field mandatory', candidates, complete)
    expect(res.keys).toEqual(['field.required'])
    const call = (complete.mock.calls[0] as unknown as [{ user: string }])[0]
    expect(JSON.parse(call.user).question).toBe('where do I make a field mandatory')
  })
})

describe('why two forms differ (#2693)', () => {
  const side = (over: Partial<Parameters<typeof diffSides>[0]>) => ({
    layoutId: 1,
    title: '“A”',
    name: 'A',
    version: null,
    createdAt: null,
    layout: { collection: 'orders' },
    groups: [
      {
        key: 'details',
        label: 'Details',
        type: 'section',
        parent: null,
        collapsed: false,
        visible_when: [],
        hidden_for: [],
        locked_for: []
      }
    ],
    placements: [
      {
        field: 'zone',
        group: 'details',
        label: null,
        width: null,
        required: false,
        readonly: false,
        hidden: false,
        other: {}
      }
    ],
    ...over
  })

  it('reads fields, sections and settings as sentences', () => {
    const a = side({
      layout: { collection: 'orders', disable_comments: true },
      placements: [
        {
          field: 'zone',
          group: 'details',
          label: null,
          width: 6,
          required: true,
          readonly: false,
          hidden: false,
          other: {}
        },
        {
          field: 'region',
          group: 'details',
          label: null,
          width: null,
          required: false,
          readonly: false,
          hidden: false,
          other: {}
        }
      ]
    })
    const b = side({
      layoutId: 2,
      title: '“B”',
      name: 'B',
      groups: [
        {
          key: 'details',
          label: 'Details',
          type: 'section',
          parent: null,
          collapsed: false,
          visible_when: [],
          hidden_for: ['R1'],
          locked_for: []
        }
      ]
    })
    const d = diffSides(a, b, facts)
    expect(d.sentences).toEqual([
      'Hide comments — “A”: on; “B”: off.',
      'Section Details — “A”: hidden for nobody; “B”: hidden for Finance.',
      'Fields in “A” only: Region.',
      'Zone — “A”: required, half width; “B”: optional, default width.'
    ])
    expect(d.counts).toMatchObject({ only_a: 1, only_b: 0, changed: 1, sections: 1, settings: 1 })
  })

  it('names other own settings that differ', () => {
    const p = (other: Record<string, unknown>) => [
      {
        field: 'zone',
        group: 'details',
        label: null,
        width: null,
        required: false,
        readonly: false,
        hidden: false,
        other
      }
    ]
    const d = diffSides(
      side({ placements: p({ note: 'Pick the zone' }) }),
      side({ layoutId: 2, title: '“B”', placements: p({}) }),
      facts
    )
    expect(d.sentences).toEqual(['Zone: its own settings differ (note).'])
  })

  it('finds nothing between equal sides', () => {
    expect(diffSides(side({}), side({ layoutId: 2 }), facts).sentences).toEqual([])
  })

  it('parses the explanation, falling back to the raw text', () => {
    expect(parseExplainAnswer('{"summary":"B is for Finance.","points":["a",2,"b"]}')).toEqual({
      summary: 'B is for Finance.',
      points: ['a', 'b']
    })
    expect(parseExplainAnswer('Just words').summary).toBe('Just words')
  })
})

describe('ask about this form (#2695)', () => {
  const ctx = {
    collection: 'orders',
    layoutId: 5,
    layoutName: 'Default',
    asker: { id: 'u1' } as never
  }

  it('answers 503 when AI is not configured', async () => {
    await expect(
      askAboutLayout('why is Zone hidden?', ctx, { client: null })
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('runs read-only tools, reports unknown ones as errors, and cites what it looked up', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'which_form',
            input: { role: 'Finance', record_id: '284212' }
          },
          { type: 'tool_use', id: 't2', name: 'drop_table', input: {} }
        ]
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Finance gets the Finance form.' }]
      })
    const res = await askAboutLayout('why cant Finance see Zone on record 284212?', ctx, {
      client: { messages: { create } }
    })
    expect(res.answer).toBe('Finance gets the Finance form.')
    expect(res.tools).toEqual([
      { tool: 'which_form', ok: true },
      { tool: 'drop_table', ok: false }
    ])
    expect(res.cites).toEqual([
      { kind: 'record', id: '284212' },
      { kind: 'layout', id: 9, name: 'Finance form' }
    ])
    const second = create.mock.calls[1][0]
    const results = second.messages[second.messages.length - 1].content
    expect(results[1]).toMatchObject({ tool_use_id: 't2', is_error: true })
    expect(second.model).toBe('test-chat')
  })

  it('refuses an empty question', async () => {
    await expect(askAboutLayout(' ', ctx, { client: null })).rejects.toMatchObject({
      statusCode: 400
    })
  })
})
