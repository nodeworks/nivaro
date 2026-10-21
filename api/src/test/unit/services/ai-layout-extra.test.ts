import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(),
  getAiModelSettings: vi.fn()
}))

import { correctedFields } from '../../../services/ai-design/autofill-tuning.js'
import {
  cleanFieldValue,
  promptTokens,
  readAiFill,
  renderPrompt,
  takeFieldFillSlot
} from '../../../services/ai-design/field-fill.js'
import {
  buildPersonaPrompt,
  buildWalkthrough,
  type FieldMeta,
  parsePersonaAnswer,
  type RoleAccess,
  walkthroughRuleFindings
} from '../../../services/ai-design/persona-test.js'
import {
  cleanGeometry,
  critiqueRuleComments,
  critiqueSections,
  FORM_TARGET,
  gridRows,
  imageFromDataUri,
  parseCritiqueAnswer
} from '../../../services/ai-design/visual-critique.js'
import { type LayoutBundle, newGroup, newPlacement } from '../../../services/layout-ops-apply.js'

const meta = (field: string, extra: Partial<FieldMeta> = {}): [string, FieldMeta] => [
  field,
  {
    field,
    label: extra.label ?? field.replace(/_/g, ' '),
    type: 'string',
    interface: 'input',
    note: null,
    required: false,
    readonly: false,
    options: null,
    ...extra
  }
]

function stepsBundle(): LayoutBundle {
  return {
    layout: {
      id: 3,
      collection: 'orders',
      name: 'Order form',
      layout_type: 'grouped',
      tab_mode: 'steps',
      default_values: JSON.stringify({ region: 'east' })
    },
    groups: [
      { ...newGroup('steps', 'Steps', 'container', null), sort: 0 },
      { ...newGroup('details', 'Details', 'tab', 'steps'), sort: 0 },
      { ...newGroup('money', 'Money', 'tab', 'steps'), sort: 1 },
      {
        ...newGroup('secret_tab', 'Internal', 'tab', 'steps'),
        sort: 2,
        hidden_for_roles: JSON.stringify(['r-clerk'])
      },
      { ...newGroup('__ungrouped__', 'Ungrouped', 'ungrouped', null), sort: 1 }
    ],
    placements: [
      { ...newPlacement('title', 'details'), sort: 0 },
      { ...newPlacement('vendor_code', 'details'), sort: 1 },
      { ...newPlacement('region', 'details'), sort: 2 },
      {
        ...newPlacement('cost_center', 'money'),
        sort: 0,
        overrides: JSON.stringify({ required: true })
      },
      { ...newPlacement('amount', 'money'), sort: 1 },
      { ...newPlacement('internal_note', 'secret_tab'), sort: 0 },
      { ...newPlacement('__pipeline__', null), sort: 0 },
      { ...newPlacement('loose', null), sort: 1 }
    ],
    rev: 'r1'
  }
}

const fields = new Map<string, FieldMeta>([
  meta('title', { label: 'Title', required: true }),
  meta('vendor_code', { label: 'vendor_code' }),
  meta('region', {
    label: 'Region',
    required: true,
    options: { choices: [{ text: 'East', value: 'east' }] }
  }),
  meta('cost_center', { label: 'Cost center' }),
  meta('amount', { label: 'Title' }),
  meta('internal_note', { label: 'Internal note' }),
  meta('loose', { label: 'Loose' })
])

const clerk = (extra: Partial<RoleAccess> = {}): RoleAccess => ({
  name: 'Clerk',
  hidden: new Set(['cost_center']),
  readonly: new Set(),
  can_create: true,
  ...extra
})

describe('persona test (#2685)', () => {
  it('walks the steps in order, skips slots and steps hidden for the role', () => {
    const steps = buildWalkthrough(stepsBundle(), fields, clerk(), 'r-clerk')
    expect(steps.map((s) => s.key)).toEqual(['details', 'money', '__ungrouped__'])
    expect(steps[0].fields.map((f) => f.field)).toEqual(['title', 'vendor_code', 'region'])
    expect(steps[0].fields[2]).toMatchObject({ has_default: true, choices: ['East'] })
    expect(steps[1].fields[0]).toMatchObject({ field: 'cost_center', required: true, hidden: true })
  })

  it('rule findings: required but hidden, empty step, machine label, duplicate label', () => {
    const steps = buildWalkthrough(stepsBundle(), fields, clerk(), 'r-clerk')
    const f = walkthroughRuleFindings(steps, clerk())
    const by = (t: string) => f.filter((x) => x.target === t).map((x) => x.severity)
    expect(by('field:cost_center')).toEqual(['blocking'])
    expect(by('field:vendor_code')).toEqual(['minor'])
    expect(f.find((x) => x.target === 'field:vendor_code')?.better_label).toBe('Vendor Code')
    // Region is required and has a default: not blocking.
    expect(by('field:region')).toEqual([])
    // "Title" twice is only judged within one step (amount is on Money).
    expect(by('field:amount')).toEqual([])
    const noCreate = walkthroughRuleFindings(steps, clerk({ can_create: false }))
    expect(noCreate[0]).toMatchObject({ target: 'form', severity: 'blocking' })
  })

  it('sends metadata only: hidden fields leave the prompt', () => {
    const steps = buildWalkthrough(stepsBundle(), fields, clerk(), 'r-clerk')
    const prompt = JSON.parse(
      buildPersonaPrompt({
        collection: 'orders',
        layout: 'Order form',
        role: 'Clerk',
        goal: null,
        steps,
        ruleFindings: []
      })
    )
    expect(prompt.steps[1].fields.map((x: { key: string }) => x.key)).toEqual(['amount'])
    expect(JSON.stringify(prompt)).not.toContain('internal_note')
  })

  it('parses the answer and drops names the form does not have', () => {
    const steps = buildWalkthrough(stepsBundle(), fields, clerk(), 'r-clerk')
    const answer = `Here you go:\n\`\`\`json\n${JSON.stringify({
      summary: 'Mostly fine.',
      steps: [
        { step: 'details', feeling: 'clear', note: 'Easy.' },
        { step: 'nope', feeling: 'stuck', note: 'x' },
        { step: 'money', feeling: 'weird', note: 'Not sure what amount means.' }
      ],
      findings: [
        {
          target: 'field:amount',
          severity: 'confusing',
          problem: 'Amount of what?',
          better_label: 'Order total'
        },
        { target: 'field:ghost', severity: 'minor', problem: 'x' },
        { target: 'group:money', severity: 'bogus', problem: 'Money step is vague.' },
        { target: 'group:money', problem: '' }
      ]
    })}\n\`\`\``
    const p = parsePersonaAnswer(answer, steps)
    expect(p.summary).toBe('Mostly fine.')
    expect(p.steps).toEqual([
      { step: 'details', feeling: 'clear', note: 'Easy.' },
      { step: 'money', feeling: 'unsure', note: 'Not sure what amount means.' }
    ])
    expect(p.findings.map((x) => [x.target, x.severity, x.step, x.better_label])).toEqual([
      ['field:amount', 'confusing', 'money', 'Order total'],
      ['group:money', 'confusing', 'money', null]
    ])
    expect(p.dropped.sort()).toEqual(['ghost', 'nope'])
    expect(parsePersonaAnswer('no json', steps).findings).toEqual([])
  })
})

describe('visual critique (#2690)', () => {
  const bundle = (): LayoutBundle => ({
    layout: { id: 4, collection: 'orders', name: 'Order form', layout_type: 'grouped' },
    groups: [
      { ...newGroup('long', 'Long', 'section', null), sort: 0 },
      { ...newGroup('ragged', 'Ragged', 'section', null), sort: 1 },
      { ...newGroup('lonely', 'Lonely', 'section', null), sort: 2 }
    ],
    placements: [
      ...Array.from({ length: 15 }, (_, i) => ({ ...newPlacement(`f${i}`, 'long'), sort: i })),
      ...Array.from({ length: 4 }, (_, i) => ({
        ...newPlacement(`r${i}`, 'ragged'),
        sort: i,
        col_span: 8
      })),
      { ...newPlacement('only', 'lonely'), sort: 0 },
      { ...newPlacement('gone', 'lonely'), sort: 1, is_visible: false }
    ],
    rev: 'r'
  })

  it('packs rows on the 12-column grid', () => {
    expect(gridRows([6, 6, 4, 4, 4, 12, 8, 6])).toEqual([[6, 6], [4, 4, 4], [12], [8], [6]])
  })

  it('measures sections and finds density, ragged rows and one-field sections', () => {
    const geo = cleanGeometry(
      [
        { key: 'long', x: 1.4, y: -3, w: 800, h: 900, rows: 15 },
        { key: 'evil', x: 0 }
      ],
      new Set(['long', 'ragged', 'lonely'])
    )
    expect([...geo.keys()]).toEqual(['long'])
    expect(geo.get('long')).toMatchObject({ x: 1, y: 0 })
    const sections = critiqueSections(bundle(), (f) => f, geo)
    expect(sections.map((s) => [s.key, s.fields, s.rows.length])).toEqual([
      ['long', 15, 15],
      ['ragged', 4, 4],
      ['lonely', 1, 1]
    ])
    const c = critiqueRuleComments(sections)
    expect(c.map((x) => [x.section, x.topic])).toEqual([
      ['long', 'density'],
      ['ragged', 'alignment'],
      ['lonely', 'hierarchy']
    ])
  })

  it('accepts only jpeg/png data URIs within the cap', () => {
    expect(imageFromDataUri('data:image/jpeg;base64,QUJD')).toEqual({
      media_type: 'image/jpeg',
      data: 'QUJD'
    })
    expect(imageFromDataUri('data:image/svg+xml;base64,QUJD')).toBeNull()
    expect(imageFromDataUri(`data:image/png;base64,${'A'.repeat(2_100_000)}`)).toBeNull()
    expect(imageFromDataUri(42)).toBeNull()
  })

  it('pins comments to known sections or the whole form', () => {
    const p = parseCritiqueAnswer(
      JSON.stringify({
        summary: 'Dense top.',
        comments: [
          { section: 'long', topic: 'density', severity: 'high', comment: 'Too long.' },
          { section: FORM_TARGET, topic: 'hierarchy', comment: 'Lead with money.' },
          { section: 'made_up', comment: 'x' },
          { section: 'ragged', topic: 'colour', severity: 'urgent', comment: 'Odd widths.' }
        ]
      }),
      new Set(['long', 'ragged'])
    )
    expect(p.comments.map((c) => [c.section, c.topic, c.severity])).toEqual([
      ['long', 'density', 'high'],
      [FORM_TARGET, 'hierarchy', 'medium'],
      ['ragged', 'other', 'medium']
    ])
    expect(p.dropped).toEqual(['made_up'])
  })
})

describe('autofill corrections (#2691)', () => {
  it('counts proposed, corrected and kept per field — no values out', () => {
    const ev = (proposed: string[], changed: string[]) => ({
      proposed: JSON.stringify(proposed.map((f) => ({ field: f, proposed: 'secret', kept: true }))),
      overrides: JSON.stringify(changed.map((f) => ({ field: f, final: 'other secret' })))
    })
    const out = correctedFields([
      ev(['vendor', 'amount', 'po'], ['vendor']),
      ev(['vendor', 'amount'], ['vendor', 'amount']),
      ev(['vendor', 'amount', 'po'], ['vendor']),
      ev(['vendor'], []),
      { proposed: 'not json', overrides: null }
    ])
    expect(out[0]).toMatchObject({
      field: 'vendor',
      proposed: 4,
      corrected: 3,
      kept: 1,
      suggest: true
    })
    expect(out.find((f) => f.field === 'amount')).toMatchObject({
      proposed: 3,
      corrected: 1,
      suggest: true
    })
    expect(out.find((f) => f.field === 'po')).toMatchObject({ proposed: 2, suggest: false })
    expect(JSON.stringify(out)).not.toContain('secret')
  })
})

describe('AI fill per field (#2692)', () => {
  it('reads the placement setting from overrides (object or JSON text)', () => {
    expect(readAiFill({ ai_generate: { enabled: true, prompt: 'Hi {{title}}' } })).toEqual({
      enabled: true,
      prompt: 'Hi {{title}}'
    })
    expect(readAiFill(JSON.stringify(JSON.stringify({ ai_generate: { enabled: false } })))).toEqual(
      { enabled: false, prompt: null }
    )
    expect(readAiFill({ label: 'x' })).toBeNull()
    expect(readAiFill('not json')).toBeNull()
  })

  it('renders tokens from readable fields only', () => {
    const prompt = 'Summarise {{ title }} for {{vendor}}; cost {{amount}}; {{secret}}; {{title}}'
    expect(promptTokens(prompt)).toEqual(['title', 'vendor', 'amount', 'secret'])
    const r = renderPrompt(
      prompt,
      { title: '<b>Pump</b>  repair', vendor: null, amount: 12.5, secret: 'pw' },
      (f) => f !== 'secret'
    )
    expect(r.text).toBe('Summarise Pump repair for ; cost 12.5; ; Pump repair')
    expect(r.missing).toEqual(['vendor', 'secret'])
  })

  it('cleans the answer into a value', () => {
    expect(cleanFieldValue('  "Pump repair"  ', null)).toBe('Pump repair')
    expect(cleanFieldValue('```\nabc\n```', null)).toBe('abc')
    expect(cleanFieldValue('abcdef', 3)).toBe('abc')
  })

  it('limits fills per person per window', () => {
    const t0 = 1_000_000
    let ok = 0
    for (let i = 0; i < 40; i++) if (takeFieldFillSlot('u-limit', t0 + i)) ok++
    expect(ok).toBe(30)
    expect(takeFieldFillSlot('u-limit', t0 + 6 * 60_000)).toBe(true)
  })
})
