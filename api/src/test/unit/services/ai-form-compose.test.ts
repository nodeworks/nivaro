import { describe, expect, it, vi } from 'vitest'

// AI form building (#2668-#2672): the model's answers are DATA. These pin the
// checks that stand between an answer and the editor — names that are not
// fields are dropped and reported, locks only name bound pipeline states,
// unmatched labels become candidate fields — plus the slim-version planner
// and the upload routing (picture / PDF / text). No provider is reached: every
// model call is a stub.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(),
  getAiModelSettings: vi.fn(async () => ({ chatModel: 'chat-m', generateModel: 'gen-m' })),
  settingsRow: vi.fn(),
  IMAGES_REQUIRED: Symbol.for('nivaro.ai.imagesRequired'),
  AiImagesUnsupportedError: class AiImagesUnsupportedError extends Error {}
}))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: (_who: unknown, fn: () => unknown) => fn()
}))
vi.mock('../../../services/document-extract.js', () => ({
  ACCEPTED_EXTENSIONS: ['.pdf', '.docx', '.xlsx', '.txt'],
  MAX_TEXT_CHARS: 60_000,
  extractDocumentText: vi.fn(async (_b: Buffer, name: string) => ({
    text: name.includes('scan') ? '' : 'Step 1. Requester enters the reason and amount.',
    method: 'pdftotext',
    pages: 1,
    truncated: false
  }))
}))

import {
  AiImagesUnsupportedError,
  getAiClient,
  IMAGES_REQUIRED
} from '../../../services/ai-client.js'
import {
  buildComposeContextJson,
  type ComposeContext,
  ComposeRefusal,
  composeAsk,
  composeForm,
  documentContent,
  fieldResolver,
  parseComposeAnswer
} from '../../../services/ai-design/form-compose.js'
import {
  buildMeaningPrompt,
  cleanMeaningRequest,
  parseMeaningAnswer
} from '../../../services/ai-design/form-meaning.js'
import { planSlim } from '../../../services/ai-design/form-slim.js'
import { type LayoutBundle, newGroup, newPlacement } from '../../../services/layout-ops-apply.js'

const ctx: ComposeContext = {
  collection: 'returns',
  label: 'Returns',
  fields: [
    { field: 'reason', label: 'Reason', type: 'text', note: null, relation: null, required: false },
    {
      field: 'amount',
      label: 'Amount',
      type: 'decimal',
      note: null,
      relation: null,
      required: true
    },
    {
      field: 'manager',
      label: 'Approving manager',
      type: 'uuid',
      note: 'Who signs it off',
      relation: 'links to one nivaro_users',
      required: false
    },
    {
      field: 'decision',
      label: 'Decision',
      type: 'string',
      note: null,
      relation: null,
      required: false
    }
  ],
  states: [
    { pipeline_id: 'p1', pipeline: 'Returns flow', key: 'draft', label: 'Draft' },
    { pipeline_id: 'p1', pipeline: 'Returns flow', key: 'approved', label: 'Approved' }
  ]
}

const answer = (o: unknown) => `Here you go:\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``

describe('fieldResolver', () => {
  it('matches keys, case-insensitive keys and unique labels', () => {
    const r = fieldResolver(ctx.fields)
    expect(r('reason')).toBe('reason')
    expect(r('AMOUNT')).toBe('amount')
    expect(r('approving manager')).toBe('manager')
    expect(r('Cost centre')).toBeNull()
    expect(r(12)).toBeNull()
  })
})

describe('parseComposeAnswer', () => {
  it('keeps known fields, drops and reports unknown names, keeps first place of a twin', () => {
    const form = parseComposeAnswer(
      answer({
        name: 'Returns',
        layout: 'steps',
        groups: [
          { label: 'Request', fields: ['reason', 'amount', 'cost_centre'] },
          { label: 'Approval', fields: ['Approving manager', 'decision', 'reason'] },
          { label: 'Empty', fields: ['nope'] }
        ],
        explanation: 'Two steps.'
      }),
      ctx,
      'describe'
    )
    expect(form.layout).toBe('steps')
    expect(form.groups).toEqual([
      { label: 'Request', fields: ['reason', 'amount'], source: null },
      { label: 'Approval', fields: ['manager', 'decision'], source: null }
    ])
    expect(form.dropped).toEqual(['cost_centre', 'nope'])
    expect(form.candidates).toEqual([])
    expect(form.locks).toEqual([])
  })

  it('numbers a repeated group name', () => {
    const form = parseComposeAnswer(
      answer({
        layout: 'sections',
        groups: [
          { label: 'Details', fields: ['reason'] },
          { label: 'details', fields: ['amount'] }
        ]
      }),
      ctx,
      'describe'
    )
    expect(form.groups.map((g) => g.label)).toEqual(['Details', 'details 2'])
    expect(form.layout).toBe('sections')
  })

  it('refuses when the model refused or named no field', () => {
    expect(() => parseComposeAnswer('{"error":"Too vague"}', ctx, 'describe')).toThrow('Too vague')
    expect(() =>
      parseComposeAnswer(answer({ groups: [{ label: 'X', fields: ['a', 'b'] }] }), ctx, 'describe')
    ).toThrow(/named no field of this collection/)
    expect(() => parseComposeAnswer('not json', ctx, 'describe')).toThrow(ComposeRefusal)
  })

  it('turns unmatched labels into candidate fields for a picture, never into the form', () => {
    const form = parseComposeAnswer(
      answer({
        layout: 'sections',
        groups: [{ label: 'Header', fields: ['reason', 'Store number'] }],
        unmatched: [
          { label: 'Receipt attached', type: 'yes/no', group: 'Header' },
          { label: 'Amount', type: 'number' }
        ]
      }),
      ctx,
      'picture'
    )
    expect(form.groups[0].fields).toEqual(['reason'])
    expect(form.candidates).toEqual([
      { label: 'Store number', type: null, group: 'Header' },
      { label: 'Receipt attached', type: 'yes/no', group: 'Header' }
    ])
  })

  it('keeps SOP locks and requirements only on bound pipeline states', () => {
    const form = parseComposeAnswer(
      answer({
        layout: 'sections',
        groups: [{ label: 'Request', fields: ['reason', 'amount'], source: 'The requester…' }],
        locks: [
          { field: 'amount', pipeline: 'p1', states: ['approved', 'Draft', 'shipped'] },
          { field: 'amount', pipeline: 'p1', states: ['approved'] },
          { field: 'ghost', pipeline: 'p1', states: ['approved'] },
          { field: 'reason', pipeline: 'p1', states: ['shipped'] }
        ],
        requirements: [
          {
            field: 'manager',
            pipeline: 'Returns flow',
            state: 'approved',
            source: 'Manager signs'
          },
          { field: 'decision', pipeline: 'p9', state: 'nope' }
        ]
      }),
      ctx,
      'sop'
    )
    expect(form.layout).toBe('steps')
    expect(form.groups[0].source).toBe('The requester…')
    expect(form.locks).toEqual([
      { field: 'amount', pipeline_id: 'p1', state_keys: ['approved', 'draft'], source: null }
    ])
    expect(form.requirements).toEqual([
      { field: 'manager', pipeline_id: 'p1', state_key: 'approved', source: 'Manager signs' }
    ])
  })

  it('ignores locks when the collection has no pipeline', () => {
    const form = parseComposeAnswer(
      answer({
        groups: [{ label: 'A', fields: ['reason'] }],
        locks: [{ field: 'reason', pipeline: 'p1', states: ['draft'] }]
      }),
      { ...ctx, states: [] },
      'sop'
    )
    expect(form.locks).toEqual([])
  })
})

describe('buildComposeContextJson', () => {
  it('sends metadata and pipeline states, never values', () => {
    const json = JSON.parse(buildComposeContextJson(ctx, { description: 'a returns form' }))
    expect(json.description).toBe('a returns form')
    expect(json.fields[2]).toEqual({
      key: 'manager',
      label: 'Approving manager',
      type: 'uuid',
      description: 'Who signs it off',
      relation: 'links to one nivaro_users'
    })
    expect(json.pipelines).toEqual([
      {
        id: 'p1',
        name: 'Returns flow',
        states: [
          { key: 'draft', label: 'Draft' },
          { key: 'approved', label: 'Approved' }
        ]
      }
    ])
  })
})

describe('composeForm', () => {
  it('asks once with the mode prompt and checks the answer', async () => {
    const ask = vi.fn(async () =>
      answer({ layout: 'steps', groups: [{ label: 'Request', fields: ['reason'] }] })
    )
    const form = await composeForm(ask, ctx, { mode: 'describe', text: 'a returns form' })
    expect(form.groups).toHaveLength(1)
    expect(ask).toHaveBeenCalledTimes(1)
    const [system, content] = ask.mock.calls[0] as unknown as [string, string]
    expect(system).toMatch(/from an admin's description/)
    expect(JSON.parse(content).description).toBe('a returns form')
  })

  it('puts the document before the field list for a picture', async () => {
    const ask = vi.fn(async () => answer({ groups: [{ label: 'A', fields: ['reason'] }] }))
    await composeForm(ask, ctx, {
      mode: 'picture',
      doc: [{ type: 'text', text: 'Reason: ____' }]
    })
    const content = (ask.mock.calls[0] as unknown as [string, Array<{ type: string }>])[1]
    expect(content.map((b) => b.type)).toEqual(['text', 'text'])
  })
})

describe('documentContent', () => {
  const doc = (filename: string, mimetype: string | null = null) => ({
    buffer: Buffer.from('abc'),
    filename,
    mimetype
  })

  it('sends a picture as an image block', async () => {
    const out = await documentContent(doc('form.PNG'), { pdfBlocks: false })
    expect(out.method).toBe('image')
    expect(out.blocks[0]).toMatchObject({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from('abc').toString('base64')
      }
    })
  })

  it('sends a PDF as a document block only where the provider reads them', async () => {
    expect((await documentContent(doc('a.pdf'), { pdfBlocks: true })).blocks[0].type).toBe(
      'document'
    )
    const text = await documentContent(doc('a.pdf'), { pdfBlocks: false })
    expect(text.blocks[0].type).toBe('text')
    expect(text.method).toBe('pdftotext')
  })

  it('refuses a PDF with no text layer on a text-only provider', async () => {
    await expect(documentContent(doc('scan.pdf'), { pdfBlocks: false })).rejects.toThrow(
      /Upload a picture/
    )
  })
})

describe('sections by meaning', () => {
  const groups = [
    { key: 'request', label: 'Request', fields: ['reason'] },
    { key: 'approval', label: 'Approval', fields: [] }
  ]

  it('cleans the request against the collection', () => {
    const req = cleanMeaningRequest(
      {
        groups: [
          { key: 'request', label: 'Request', fields: ['reason', 'ghost'] },
          { key: '__header__', label: 'Header' },
          { key: 'request', label: 'Again' }
        ],
        fields: ['manager', 'ghost', 'manager']
      },
      ctx
    )
    expect(req.groups).toEqual([{ key: 'request', label: 'Request', fields: ['reason'] }])
    expect(req.fields).toEqual(['manager'])
  })

  it('keeps suggestions for asked fields into known sections only', () => {
    const out = parseMeaningAnswer(
      answer({
        suggestions: [
          { field: 'manager', section: 'approval', reason: 'Approver belongs with approval' },
          { field: 'manager', section: 'request' },
          { field: 'decision', section: 'nowhere' },
          { field: 'amount', section: 'request' }
        ]
      }),
      groups,
      ['manager', 'decision']
    )
    expect(out.suggestions).toEqual([
      { field: 'manager', group_key: 'approval', reason: 'Approver belongs with approval' }
    ])
    expect(out.dropped).toBe(3)
  })

  it('describes sections by their fields labels', () => {
    const p = JSON.parse(buildMeaningPrompt(ctx, groups, ['manager']))
    expect(p.sections[0].fields).toEqual(['Reason'])
    expect(p.place[0]).toMatchObject({ key: 'manager', relation: 'links to one nivaro_users' })
  })
})

describe('planSlim', () => {
  const bundle: LayoutBundle = {
    layout: { id: 3, collection: 'returns', name: 'Main', layout_type: 'grouped' },
    groups: [
      { ...newGroup('request', 'Request', 'section', null), sort: 0 },
      { ...newGroup('internal', 'Internal', 'section', null), sort: 1 }
    ],
    placements: [
      { ...newPlacement('reason', 'request'), sort: 0 },
      { ...newPlacement('amount', 'request'), sort: 1 },
      { ...newPlacement('notes', 'request'), sort: 2 },
      { ...newPlacement('decision', 'internal'), sort: 0 },
      { ...newPlacement('audit', 'internal'), sort: 1, overrides: '{"required":true}' },
      { ...newPlacement('secret', 'internal'), sort: 2, is_visible: false },
      { ...newPlacement('__comments__', null), sort: 2 },
      { ...newPlacement('date_created', 'request'), sort: 3 }
    ],
    rev: 'r1'
  }
  const labelOf = (f: string) => f.toUpperCase()

  it('keeps what the role changed and what is required, hides the rest', () => {
    const plan = planSlim(
      bundle,
      { revisions: 40, people: 3, counts: { reason: 30, amount: 12, notes: 0 } },
      { labelOf, required: new Set(['amount']) }
    )
    expect(plan.keep.map((k) => [k.field, k.why])).toEqual([
      ['reason', 'changed'],
      ['amount', 'changed'],
      ['audit', 'required']
    ])
    expect(plan.drop.map((d) => d.field)).toEqual(['notes', 'decision'])
    expect(plan.drop[1]).toMatchObject({ group_key: 'internal', group_label: 'Internal' })
    expect(plan.hide_groups).toEqual([])
    expect(plan.min_changes).toBe(1)
  })

  it('hides a section whose fields are all dropped', () => {
    const plan = planSlim(
      { ...bundle, placements: bundle.placements.filter((p) => p.field !== 'audit') },
      { revisions: 400, people: 9, counts: { reason: 300, amount: 3 } },
      { labelOf, required: new Set() }
    )
    // 1 % of 400 = 4 changes: amount (3) is dropped too.
    expect(plan.min_changes).toBe(4)
    expect(plan.keep.map((k) => k.field)).toEqual(['reason'])
    expect(plan.hide_groups).toEqual([{ key: 'internal', label: 'Internal' }])
  })
})

describe('composeAsk', () => {
  it('marks a call with pictures as needing them and turns a refusal into a clear 422', async () => {
    const create = vi.fn(async () => {
      throw new AiImagesUnsupportedError('The configured AI cannot read pictures.')
    })
    vi.mocked(getAiClient).mockResolvedValue({ messages: { create } } as never)
    const ask = await composeAsk('chat')
    await expect(
      ask?.(
        'sys',
        [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }],
        10
      )
    ).rejects.toThrow(ComposeRefusal)
    const params = (create.mock.calls[0] as unknown as [Record<PropertyKey, unknown>])[0]
    expect(params[IMAGES_REQUIRED]).toBe(true)
    expect(params.model).toBe('chat-m')
  })

  it('does not mark a text-only call', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: 'hi' }] }))
    vi.mocked(getAiClient).mockResolvedValue({ messages: { create } } as never)
    const ask = await composeAsk('chat')
    expect(await ask?.('sys', 'plain', 10)).toBe('hi')
    const params = (create.mock.calls[0] as unknown as [Record<PropertyKey, unknown>])[0]
    expect(params[IMAGES_REQUIRED]).toBeUndefined()
  })
})
