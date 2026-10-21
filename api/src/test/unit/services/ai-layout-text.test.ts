import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(),
  getAiModelSettings: vi.fn()
}))

import {
  followsGlossary,
  type GlossaryWord,
  offGlossaryUses,
  toGlossaryWording
} from '../../../services/ai-design/glossary-terms.js'
import {
  buildPlaceholderPrompt,
  buildTextModel,
  choiceCandidates,
  choiceProposals,
  glossaryTool,
  introCandidates,
  isMessyChoice,
  parseIntroAnswer,
  placeholderCandidates,
  placeholderProposals,
  readingItems,
  readingProposals,
  relabelChoices,
  ruleChoiceLabel,
  ruleExample,
  translateCandidates,
  translateProposals
} from '../../../services/ai-design/layout-text.js'
import {
  countSyllables,
  plainRewrite,
  plainScore
} from '../../../services/ai-design/reading-level.js'
import {
  copiesRealValue,
  exampleFromPattern,
  maskValue,
  type ValueShape,
  valueShape
} from '../../../services/ai-design/value-shapes.js'
import { type LayoutBundle, newGroup, newPlacement } from '../../../services/layout-ops-apply.js'

const glossary: GlossaryWord[] = [
  { id: 1, term: "PUB'd", aliases: ['CAR', 'PUB'] },
  { id: 2, term: 'Work order', aliases: ['WO', 'job ticket'] }
]

function bundle(): LayoutBundle {
  return {
    layout: { id: 3, collection: 'orders', name: 'Main', layout_type: 'grouped' },
    groups: [
      { ...newGroup('tabs', 'Steps', 'container', null), sort: 0 },
      { ...newGroup('details', 'Details', 'tab', 'tabs'), sort: 0 },
      { ...newGroup('money', 'CAR money', 'section', 'details'), sort: 1 },
      { ...newGroup('note', 'Note', 'content', null), sort: 2, content: 'Read me' }
    ],
    placements: [
      { ...newPlacement('po_number', 'details'), sort: 0 },
      {
        ...newPlacement('amount', 'money'),
        sort: 0,
        overrides: { note: 'Utilize the CAR total pursuant to policy' }
      },
      { ...newPlacement('status', 'details'), sort: 1 },
      { ...newPlacement('secret_token', 'details'), sort: 2 },
      { ...newPlacement('gone', 'details'), sort: 3, is_visible: false },
      {
        ...newPlacement('kind', 'details'),
        sort: 4,
        overrides: { i18n: { fr: { label: 'Type', draft: false } } }
      }
    ],
    rev: 'r1'
  }
}

const fieldRows = [
  { field: 'po_number', label: 'WO number', type: 'string', interface: 'input' },
  { field: 'amount', label: 'CAR date amount', type: 'decimal', interface: 'input' },
  {
    field: 'status',
    label: 'Status',
    type: 'string',
    interface: 'select-dropdown',
    options: JSON.stringify({
      choices: [
        { text: '$t:pending_approval', value: 'pending' },
        { text: 'Approved', value: 'approved' },
        { text: 'IN_PROGRESS', value: 'busy' }
      ]
    })
  },
  { field: 'secret_token', label: 'Token', type: 'string', interface: 'input' },
  { field: 'gone', label: 'Gone', type: 'string' },
  { field: 'kind', label: 'Kind', type: 'string', interface: 'input', placeholder: 'e.g. A' }
]

const model = () => buildTextModel(bundle(), fieldRows)

describe('glossary terms (#2677)', () => {
  it('finds aliases, never the term or a longer form that contains an alias', () => {
    const uses = offGlossaryUses("CAR total, PUB'd date and job ticket", glossary)
    expect(uses.map((u) => u.found)).toEqual(['CAR', 'job ticket'])
    expect(offGlossaryUses("PUB'd only", glossary)).toEqual([])
  })

  it('rewrites to the terms and checks rewrites', () => {
    expect(toGlossaryWording('CAR total for WO', glossary)).toBe("PUB'd total for Work order")
    expect(followsGlossary("PUB'd total", [glossary[0]], glossary)).toBe(true)
    expect(followsGlossary('CAR total', [glossary[0]], glossary)).toBe(false)
    expect(followsGlossary('Total', [glossary[0]], glossary)).toBe(false)
  })

  it('lists every off-glossary word and proposes per-layout rewrites (rules without AI)', async () => {
    const r = await glossaryTool(model(), glossary, null)
    const keys = r.proposals.map((p) => `${p.target.kind}:${p.key}:${p.after}`)
    expect(keys).toContain("group:label:PUB'd money")
    expect(keys).toContain('placement:label:Work order number')
    expect(keys).toContain("placement:note:Utilize the PUB'd total pursuant to policy")
    expect(r.terms?.map((t) => t.found).sort()).toEqual(['CAR', 'WO'])
    // Hidden fields are not on the form, so not listed.
    expect(
      r.proposals.some((p) => p.target.kind === 'placement' && p.target.field === 'gone')
    ).toBe(false)
  })

  it('uses an AI rewrite only when it follows the glossary', async () => {
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        rewrites: [
          { id: 'g:money:label', text: "PUB'd amounts" },
          { id: 'p:details:po_number:label', text: 'WO no.' },
          { id: 'nope', text: 'x' }
        ]
      })
    )
    const r = await glossaryTool(model(), glossary, complete)
    const money = r.proposals.find((p) => p.target.kind === 'group')
    expect(money?.after).toBe("PUB'd amounts")
    expect(money?.source).toBe('ai')
    const po = r.proposals.find((p) => p.key === 'label' && p.target.kind === 'placement')
    expect(po?.after).toBe('Work order number')
    expect(po?.source).toBe('rules')
    expect(r.dropped).toBe(2)
  })
})

describe('section intros (#2678)', () => {
  it('offers steps and sections with fields and no intro', () => {
    const cands = introCandidates(model())
    expect(cands.map((c) => c.group.key)).toEqual(['details', 'money'])
    // The step counts the fields of the sections inside it.
    expect(cands[0].fields.map((f) => f.field)).toContain('amount')
  })

  it('keeps answers for known groups only, with a valid tone', () => {
    const cands = introCandidates(model())
    const r = parseIntroAnswer(
      JSON.stringify({
        intros: [
          { group: 'details', text: 'Tell us what you are ordering and why.', tone: 'loud' },
          { group: 'money', text: 'Check the amount before you send it.', tone: 'warn' },
          { group: 'ghost', text: 'Nothing here at all.' },
          { group: 'money', text: 'Duplicate answer for money.' }
        ]
      }),
      cands
    )
    expect(r.proposals.map((p) => [p.target, p.key, p.tone])).toEqual([
      [{ kind: 'group', key: 'details' }, 'content', 'info'],
      [{ kind: 'group', key: 'money' }, 'content', 'warn']
    ])
    expect(r.dropped).toBe(2)
  })
})

describe('placeholders from value shapes (#2679)', () => {
  it('masks values into shapes without the values', () => {
    expect(maskValue('PO-123456')).toBe('AA-######')
    expect(maskValue('Jonathan Smith')).toBe('Aaaa… Aaaa…')
    const s = valueShape(['PO-100001', 'PO-100002', 'PO-100003', null], false)
    expect(s).toMatchObject({ kind: 'text', patterns: [{ pattern: 'AA-######', share: 1 }] })
    expect(JSON.stringify(s)).not.toContain('100001')
    const n = valueShape([1234.5, 980, 15000], true)
    expect(n).toMatchObject({ kind: 'number', min: 980, max: 15000, typical: 1200, decimals: 1 })
  })

  it('makes examples in the shape and refuses copies of stored values', () => {
    expect(exampleFromPattern('AA-######')).toBe('KM-471829')
    expect(copiesRealValue('e.g. PO-100001', ['PO-100001'])).toBe(true)
    expect(copiesRealValue('e.g. 1,250.00', [1250])).toBe(true)
    expect(copiesRealValue('e.g. PO-555555', ['PO-100001'])).toBe(false)
    const shape = valueShape(['1200', '1100', '1300'], true) as ValueShape
    // 1200 is stored, so the rules nudge to a number nobody typed.
    expect(ruleExample(shape, ['1200', '1100', '1300'])).not.toMatch(/^e\.g\. 1,200$/)
  })

  it('picks inputs without placeholders, skips selects and relations and never samples secrets', () => {
    const cands = placeholderCandidates(model(), new Set(['amount_rel']))
    expect(cands.map((c) => [c.placed.field, c.sample])).toEqual([
      ['po_number', true],
      ['secret_token', false],
      ['amount', true]
    ])
  })

  it('drops AI examples that copy a sampled value or name unknown fields', () => {
    const cands = placeholderCandidates(model(), new Set())
    const samples = new Map<string, unknown[]>([
      ['po_number', ['PO-100001', 'PO-100002', 'PO-100003']]
    ])
    const shapes = new Map<string, ValueShape>([
      ['po_number', valueShape(samples.get('po_number')!, false)!]
    ])
    const prompt = buildPlaceholderPrompt(cands, shapes)
    expect(prompt).not.toContain('100001')
    const r = placeholderProposals(
      cands,
      shapes,
      samples,
      JSON.stringify({
        placeholders: [
          { field: 'po_number', text: 'e.g. PO-100001' },
          { field: 'amount', text: 'e.g. 2,500.00' },
          { field: 'ghost', text: 'e.g. 1' }
        ]
      })
    )
    const po = r.proposals.find(
      (p) => p.target.kind === 'placement' && p.target.field === 'po_number'
    )
    expect(po?.source).toBe('rules')
    expect(po?.after).toBe('e.g. KM-471829')
    expect(r.proposals.find((p) => p.after === 'e.g. 2,500.00')?.source).toBe('ai')
    expect(r.dropped).toBe(2)
  })
})

describe('choice labels (#2681)', () => {
  it('spots codes and turns them into words', () => {
    expect(isMessyChoice({ text: '$t:pending_approval', value: 'p' })).toBe(true)
    expect(isMessyChoice({ text: 'IN_PROGRESS', value: 'b' })).toBe(true)
    expect(isMessyChoice({ text: 'Approved', value: 'a' })).toBe(false)
    expect(isMessyChoice({ text: 'PO', value: 'po' })).toBe(false)
    expect(ruleChoiceLabel({ text: '$t:pending-approval', value: 'p' })).toBe('Pending approval')
    expect(ruleChoiceLabel({ text: 'IN_PROGRESS', value: 'b' })).toBe('In progress')
  })

  it('keeps every value and changes only the texts it may', () => {
    const cands = choiceCandidates(model())
    expect(cands.map((c) => c.field)).toEqual(['status'])
    const r = choiceProposals(
      cands,
      JSON.stringify({
        fields: [
          {
            field: 'status',
            choices: [
              { value: 'pending', text: 'Waiting for approval' },
              { value: 'invented', text: 'New' }
            ]
          }
        ]
      })
    )
    const p = r.proposals[0]
    expect(p.choices?.from).toBe('field')
    expect(p.choices?.all.map((c) => c.value)).toEqual(['pending', 'approved', 'busy'])
    expect(p.choices?.changed.map((c) => c.after)).toEqual(['Waiting for approval', 'In progress'])
    expect(r.dropped).toBe(1)
  })
})

describe('reading level (#2682)', () => {
  it('scores deterministically, worst first', () => {
    expect(countSyllables('approval')).toBe(3)
    expect(plainScore('Status', 'label').score).toBe(100)
    expect(plainScore('po_number', 'label').reasons).toContain('reads like a raw field name')
    expect(plainScore('Utilize the CAR total', 'help').score).toBeLessThan(80)
    expect(plainScore('Utilize the CAR total', 'help', new Set(['car'])).score).toBeGreaterThan(
      plainScore('Utilize the CAR total', 'help').score
    )
    expect(plainRewrite('Utilize the total', 'help')).toBe('Use the total')
    const items = readingItems(model(), new Set())
    for (let i = 1; i < items.length; i++)
      expect(items[i].score).toBeGreaterThanOrEqual(items[i - 1].score)
  })

  it('offers a rewrite only when it reads plainer', () => {
    const items = readingItems(model(), new Set())
    const note = items.find((i) => i.key === 'note')!
    const r = readingProposals(
      items,
      new Set(),
      JSON.stringify({
        rewrites: [{ id: note.id, text: 'Utilize aforementioned CAR total pursuant policy' }]
      })
    )
    const p = r.proposals.find((x) => x.key === 'note')
    // The AI's wording scored worse, so the rules' rewrite is offered instead.
    expect(p?.source).toBe('rules')
    expect(p?.after).toBe('Use the CAR total under policy')
    expect(p?.score?.after).toBeGreaterThan(p?.score?.before ?? 100)
  })
})

describe('translation drafts (#2683)', () => {
  it('skips approved translations and marks the rest as drafts', () => {
    const cands = translateCandidates(model(), 'fr')
    expect(cands.map((c) => c.field)).not.toContain('kind')
    const r = translateProposals(
      cands,
      'fr',
      JSON.stringify({
        translations: [
          { field: 'po_number', label: 'Numéro de bon', help: null },
          { field: 'amount', label: 'Montant' },
          { field: 'kind', label: 'Genre' }
        ]
      })
    )
    expect(r.proposals.map((p) => [p.target, p.i18n])).toEqual([
      [
        { kind: 'placement', field: 'po_number', group_key: 'details' },
        { locale: 'fr', label: 'Numéro de bon', help: null }
      ]
    ])
    // amount has help text but no help translation; kind is approved already.
    expect(r.dropped).toBe(2)
  })
})

describe('relabelChoices (#2681 on the field)', () => {
  it('changes only text and keeps every other key, the order and untouched choices', () => {
    const raw = [
      { text: 'A', value: 'a', color: '#f00', icon: 'star', extra: { x: 1 } },
      { text: 'B', value: 'b', color: '#0f0' },
      'c',
      { value: 'd', foreground: '#000' }
    ]
    const wanted = new Map([
      ['a', 'Alpha'],
      ['c', 'Charlie'],
      ['d', 'Delta'],
      ['zzz', 'Nope']
    ])
    const { next, changed } = relabelChoices(raw, wanted)
    expect(changed).toBe(3)
    expect(next).toEqual([
      { text: 'Alpha', value: 'a', color: '#f00', icon: 'star', extra: { x: 1 } },
      { text: 'B', value: 'b', color: '#0f0' },
      { text: 'Charlie', value: 'c' },
      { text: 'Delta', value: 'd', foreground: '#000' }
    ])
    expect(next[1]).toBe(raw[1])
  })
  it('counts nothing when the labels already match', () => {
    const raw = [{ text: 'A', value: 'a', color: '#f00' }]
    const { next, changed } = relabelChoices(raw, new Map([['a', 'A']]))
    expect(changed).toBe(0)
    expect(next[0]).toBe(raw[0])
  })
})
