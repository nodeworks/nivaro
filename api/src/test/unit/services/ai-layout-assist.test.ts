import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(),
  getAiModelSettings: vi.fn()
}))
vi.mock('../../../services/layout-analysis.js', () => ({ cachedLintContext: vi.fn() }))

import {
  type AssistContext,
  assistFieldsFromRows,
  bundleFromBody,
  factsForPlacement,
  fieldsReferenced
} from '../../../services/ai-design/layout-assist-context.js'
import {
  checkLayoutChange,
  describeLayoutChange,
  parseCheckAnswer
} from '../../../services/ai-design/layout-change-check.js'
import {
  driversFirst,
  entryOrderChangeSets,
  orderOps,
  orderSections,
  validateOrder
} from '../../../services/ai-design/layout-entry-order.js'
import {
  meaningFindings,
  meaningInputs,
  parseMeaningAnswer,
  reviewMeaning
} from '../../../services/ai-design/layout-meaning.js'
import {
  parseSensitiveAnswer,
  sensitiveFindings
} from '../../../services/ai-design/layout-sensitive.js'
import type { RoleFieldAccess } from '../../../services/layout-field-access.js'
import {
  applyLayoutOps,
  type LayoutBundle,
  newGroup,
  newPlacement
} from '../../../services/layout-ops-apply.js'

const FIN = 'role-fin'
const STAFF = 'role-staff'
const ADMIN = 'role-admin'

function ctx(): AssistContext {
  return {
    collection: 'orders',
    fields: assistFieldsFromRows([
      { field: 'requester', label: 'Requester', type: 'uuid' },
      { field: 'vendor', label: 'Vendor', type: 'string' },
      { field: 'supplier', label: 'Supplier', type: 'string' },
      {
        field: 'site',
        label: 'Site',
        type: 'integer',
        dependency_config: JSON.stringify({ cascade_filters: [{ parent_field: 'region' }] })
      },
      { field: 'region', label: 'Region', type: 'integer' },
      { field: 'needed_by', label: 'Needed by', type: 'date' },
      {
        field: 'amount',
        label: 'Amount',
        type: 'decimal',
        note: 'Optional — leave blank if unsure.'
      },
      { field: 'salary', label: 'Requester salary', type: 'decimal' },
      { field: 'notes', label: 'Notes', type: 'text' }
    ]),
    roles: [
      {
        id: ADMIN,
        name: 'Administrator',
        admin: true,
        can_write: true,
        writable_fields: null,
        members: 2
      },
      {
        id: FIN,
        name: 'Finance',
        admin: false,
        can_write: true,
        writable_fields: ['amount'],
        members: 4
      },
      {
        id: STAFF,
        name: 'Staff',
        admin: false,
        can_write: true,
        writable_fields: ['notes', 'vendor'],
        members: 40
      }
    ],
    transitions: [
      {
        label: 'Approve',
        from: 'Finance Review',
        to: 'Approved',
        role_ids: [FIN],
        fields: ['amount']
      }
    ],
    states: [{ pipeline: 'p1', key: 'finance_review', label: 'Finance Review' }]
  }
}

function bundle(): LayoutBundle {
  const fields = [
    'notes',
    'amount',
    'requester',
    'site',
    'region',
    'needed_by',
    'vendor',
    'supplier'
  ]
  return {
    layout: { id: 7, collection: 'orders', name: 'Default', layout_type: 'grouped' },
    groups: [
      { ...newGroup('details', 'Details', 'section', null), sort: 0 },
      { ...newGroup('money', 'Money', 'section', null), sort: 1 }
    ],
    placements: [
      ...fields.map((f, i) => ({ ...newPlacement(f, 'details'), sort: i })),
      { ...newPlacement('secret', 'details'), sort: 99, is_visible: false },
      { ...newPlacement('salary', 'money'), sort: 0 }
    ],
    rev: 'rev-1'
  }
}

const stub = (answer: unknown) => vi.fn(async () => JSON.stringify(answer))

describe('assist context', () => {
  it('finds the fields a condition reads', () => {
    const known = new Set(['region', 'site'])
    expect(
      fieldsReferenced([{ rule: { region: { _eq: 1 } } }, { parent_field: 'site' }], known).sort()
    ).toEqual(['region', 'site'])
    expect(ctx().fields.get('site')?.drivers).toEqual(['region'])
  })

  it('states the facts the form applies to a field', () => {
    const b = bundle()
    const amount = b.placements.find((p) => p.field === 'amount')!
    const facts = factsForPlacement(b, amount, ctx())
    expect(facts).toContain('optional on this form')
    expect(facts.join(' ')).toContain(
      'must be filled before "Approve" (from Finance Review), run by Finance'
    )
    expect(facts.join(' ')).toContain('roles that edit records but not this field: Staff')
  })

  it('reads a sent draft bundle and refuses junk', () => {
    const b = bundle()
    expect(bundleFromBody({ groups: 'x', placements: [] }, b.layout)).toBeNull()
    expect(bundleFromBody({ groups: [{ key: '' }], placements: [] }, b.layout)).toBeNull()
    const got = bundleFromBody(JSON.parse(JSON.stringify(b)), b.layout)
    expect(got?.placements.map((p) => p.field)).toEqual(b.placements.map((p) => p.field))
  })
})

describe('#2684 change check', () => {
  it('describes a hide-for-role and calls it significant', () => {
    const before = bundle()
    const after = applyLayoutOps(before, [
      { op: 'group_update', key: 'details', patch: { hidden_for_roles: JSON.stringify([FIN]) } }
    ])
    const s = describeLayoutChange(before, after, ctx())
    expect(s.lines).toEqual(['Hid "Details" from Finance'])
    expect(s.significant).toBe(true)
    expect(s.groups).toEqual(['details'])
  })

  it('treats relabels and reorders as trivial and never calls the model', async () => {
    const before = bundle()
    const after = applyLayoutOps(before, [
      {
        op: 'update_placement',
        at: { field: 'notes', group_key: 'details' },
        patch: { label_override: 'Remarks' }
      },
      {
        op: 'move',
        from: { field: 'amount', group_key: 'details' },
        to_group_key: 'details',
        index: 0
      }
    ])
    const complete = stub({ warnings: [] })
    const r = await checkLayoutChange(before, after, ctx(), complete)
    expect(r).toMatchObject({ status: 'skipped', reason: 'trivial' })
    expect(complete).not.toHaveBeenCalled()
    expect((await checkLayoutChange(before, before, ctx(), complete)).status).toBe('skipped')
  })

  it('keeps warnings that name real things and drops guesses', async () => {
    const before = bundle()
    const after = applyLayoutOps(before, [
      {
        op: 'update_placement',
        at: { field: 'amount', group_key: 'details' },
        patch: { is_visible: false }
      }
    ])
    const complete = stub({
      warnings: [
        {
          message: 'You hid Amount, which Finance must fill before Approve.',
          field: 'amount',
          roles: ['finance']
        },
        { message: 'Ghost field', field: 'nope' },
        { message: 'Unknown role', roles: ['Nobody'] },
        { message: '' }
      ]
    })
    const r = await checkLayoutChange(before, after, ctx(), complete)
    expect(r.status).toBe('checked')
    if (r.status !== 'checked') return
    expect(r.changes).toEqual(['Hid "Amount" on this form'])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatchObject({
      field: 'amount',
      field_label: 'Amount',
      roles: ['Finance']
    })
    expect(r.dropped).toBe(3)
    const prompt = JSON.parse((complete.mock.calls[0] as unknown as [{ user: string }])[0].user)
    expect(prompt.touched_fields[0].facts).toContain('hidden on this form')
    expect(JSON.stringify(prompt)).not.toContain('@') // roles and counts, never people
  })

  it('parses a fenced answer', () => {
    const b = bundle()
    const r = parseCheckAnswer(
      '```json\n{"warnings":[{"message":"x","section":"money"}]}\n```',
      b,
      b,
      ctx()
    )
    expect(r.warnings[0]).toMatchObject({ section: 'money', section_label: 'Money' })
  })
})

describe('#2686 #2687 meaning review', () => {
  it('flags same-meaning pairs and help text conflicts with a rewrite change set', async () => {
    const b = bundle()
    const c = ctx()
    const complete = stub({
      same_meaning: [
        { fields: ['vendor', 'supplier'], reason: 'Both name the company selling.' },
        { fields: ['vendor', 'ghost'], reason: 'x' },
        { fields: ['supplier', 'vendor'], reason: 'dup' }
      ],
      help_conflicts: [
        {
          field: 'amount',
          problem: 'Says optional, but Approve needs it.',
          rewrite: 'Required before Finance approves.'
        },
        { field: 'notes', problem: 'has no help text', rewrite: 'x' }
      ]
    })
    const r = await reviewMeaning(b, c, complete)
    expect(r.error).toBeNull()
    expect(r.dropped).toBe(2)
    const kinds = r.findings.map((f) => f.kind)
    expect(kinds).toEqual(['same_meaning', 'help_conflict'])
    const conflict = r.findings[1] as (typeof r.findings)[number] & {
      change_set: { ops: unknown[]; steps: string[] }
    }
    expect(conflict.change_set.ops).toEqual([
      {
        op: 'update_placement',
        at: { field: 'amount', group_key: 'details' },
        patch: { overrides: { note: 'Required before Finance approves.' } }
      }
    ])
    expect(() => applyLayoutOps(b, conflict.change_set.ops as never)).not.toThrow()
  })

  it('skips identical labels (the rules finding) and unknown fields', () => {
    const b = bundle()
    const inputs = meaningInputs(b, ctx()).map((i) =>
      i.field === 'supplier' ? { ...i, label: 'Vendor' } : i
    )
    const a = parseMeaningAnswer(
      JSON.stringify({ same_meaning: [{ fields: ['vendor', 'supplier'], reason: 'x' }] }),
      inputs
    )
    expect(a.pairs).toEqual([])
    expect(meaningFindings(b, inputs, a)).toEqual([])
  })

  it('does nothing without a model', async () => {
    expect((await reviewMeaning(bundle(), ctx(), null)).findings).toEqual([])
  })
})

describe('#2688 entry order', () => {
  it('puts drivers before what they drive', () => {
    const drivers = new Map([['site', ['region']]])
    expect(driversFirst(['site', 'x', 'region', 'y'], drivers)).toEqual([
      'x',
      'region',
      'site',
      'y'
    ])
    expect(driversFirst(['region', 'site'], drivers)).toEqual(['region', 'site'])
    // A cycle stays put instead of looping.
    const cyc = new Map([
      ['a', ['b']],
      ['b', ['a']]
    ])
    expect(driversFirst(['a', 'b'], cyc)).toHaveLength(2)
  })

  it('checks the model order against the section', () => {
    const fields = ['a', 'b', 'c', 'd']
    expect(validateOrder(['d', 'x', 'a', 'd', 'b'], fields)).toEqual(['d', 'a', 'b', 'c'])
    expect(validateOrder(['a'], fields)).toBeNull()
    expect(validateOrder('nope', fields)).toBeNull()
  })

  it('builds move ops that leave hidden fields in their slots', () => {
    const b = applyLayoutOps(bundle(), [{ op: 'layout_update', patch: {} }])
    const [s] = orderSections(b)
    const target = [...s.fields].reverse()
    const ops = orderOps(b, 'details', target)
    const after = applyLayoutOps(b, ops)
    const members = after.placements
      .filter((p) => p.group_key === 'details')
      .sort((x, y) => x.sort - y.sort)
    expect(members.filter((p) => p.is_visible).map((p) => p.field)).toEqual(target)
    expect(members[members.length - 1].field).toBe('secret')
  })

  it('turns the answer into one checked change set per section, drivers first', () => {
    const b = applyLayoutOps(bundle(), [{ op: 'layout_update', patch: {} }])
    const sections = orderSections(b)
    expect(sections.map((s) => s.key)).toEqual(['details']) // Money has one field
    const answer = {
      sections: [
        {
          section: 'details',
          order: [
            'requester',
            'vendor',
            'supplier',
            'site',
            'region',
            'needed_by',
            'amount',
            'notes'
          ],
          why: 'Who, what, when, cost.'
        },
        { section: 'ghost', order: [] }
      ]
    }
    const r = entryOrderChangeSets(JSON.stringify(answer), b, sections, ctx())
    expect(r.dropped).toEqual(['a section "ghost" that is not on this form'])
    expect(r.change_sets).toHaveLength(1)
    const cs = r.change_sets[0]
    expect(cs.title).toBe('Reorder "Details"')
    expect(cs.steps[0]).toBe('Put "Requester" first')
    const after = applyLayoutOps(b, cs.ops)
    const order = after.placements
      .filter((p) => p.group_key === 'details' && p.is_visible)
      .sort((x, y) => x.sort - y.sort)
      .map((p) => p.field)
    expect(order).toEqual([
      'requester',
      'vendor',
      'supplier',
      'region',
      'site',
      'needed_by',
      'amount',
      'notes'
    ])
  })

  it('still fixes a driver after its dependent when the model leaves the section out', () => {
    const b = applyLayoutOps(bundle(), [{ op: 'layout_update', patch: {} }])
    const r = entryOrderChangeSets('{"sections":[]}', b, orderSections(b), ctx())
    expect(r.change_sets).toHaveLength(1)
    expect(r.change_sets[0].steps).toEqual(['Put "Region" after "Requester"'])
  })
})

describe('#2689 sensitive fields', () => {
  const access = (hidden: Record<string, string[]> = {}): RoleFieldAccess[] =>
    [
      { id: ADMIN, name: 'Administrator', admin_access: true },
      { id: FIN, name: 'Finance', admin_access: false },
      { id: STAFF, name: 'Staff', admin_access: false }
    ].map((role) => ({
      role,
      can_read: true,
      can_update: true,
      hidden_fields: hidden[role.id] ?? [],
      readonly_fields: []
    }))

  it('drops unknown fields and classes', () => {
    const r = parseSensitiveAnswer(
      JSON.stringify({
        fields: [
          { field: 'salary', class: 'personal', why: 'pay of a person' },
          { field: 'ghost', class: 'financial' },
          { field: 'notes', class: 'secret' }
        ]
      }),
      new Set(['salary', 'notes'])
    )
    expect([...r.classes.keys()]).toEqual(['salary'])
    expect(r.dropped).toBe(1)
  })

  it('warns when a broad role sees it and suggests hiding the section from readers only', () => {
    const classes = new Map([
      ['salary', { class: 'personal' as const, why: 'pay of a person' }],
      ['amount', { class: 'financial' as const, why: 'money' }]
    ])
    const r = sensitiveFindings(bundle(), ctx(), access(), classes)
    const salary = r.find((f) => f.field === 'salary')!
    expect(salary.broad).toEqual(['Staff'])
    expect(salary.suggest).toEqual([{ id: STAFF, name: 'Staff' }])
    expect(salary.change_set?.ops).toEqual([
      { op: 'group_update', key: 'money', patch: { hidden_for_roles: JSON.stringify([STAFF]) } }
    ])
    // Amount: Staff sees it, but Finance must fill it — Staff is the only one to hide it from.
    const amount = r.find((f) => f.field === 'amount')!
    expect(amount.suggest.map((s) => s.name)).toEqual(['Staff'])
    expect(amount.also_hides.length).toBeGreaterThan(0)
    expect(amount.change_set?.steps[1]).toContain('It also hides')
  })

  it('stays quiet when the policy or a section already keeps broad roles out', () => {
    const classes = new Map([['salary', { class: 'personal' as const, why: 'pay' }]])
    expect(sensitiveFindings(bundle(), ctx(), access({ [STAFF]: ['salary'] }), classes)).toEqual([])
    const hidden = applyLayoutOps(bundle(), [
      { op: 'group_update', key: 'money', patch: { hidden_for_roles: JSON.stringify([STAFF]) } }
    ])
    expect(sensitiveFindings(hidden, ctx(), access(), classes)).toEqual([])
  })
})
