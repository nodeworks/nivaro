import { describe, expect, it } from 'vitest'
import {
  colourContrast,
  conditionsContradict,
  contrastRatio,
  type LintContext,
  type LintGroupInput,
  type LintLayoutInput,
  type LintPlacementInput,
  layoutHealth,
  lintLayout,
  mergeInherited
} from './layout-lint'

const g = (key: string, extra: Partial<LintGroupInput> = {}): LintGroupInput => ({
  key,
  parent_key: null,
  sort: 0,
  label: key[0].toUpperCase() + key.slice(1),
  type: 'section',
  ...extra
})
const p = (
  field: string,
  group_key: string | null,
  sort: number,
  extra: Partial<LintPlacementInput> = {}
): LintPlacementInput => ({ field, group_key, sort, is_visible: true, ...extra })

const layout = (
  groups: LintGroupInput[],
  placements: LintPlacementInput[],
  extra: Record<string, unknown> = {}
): LintLayoutInput => ({
  layout: { id: 1, name: 'Main', layout_type: 'grouped', ...extra },
  groups,
  placements
})

const ROLES: LintContext['roles'] = [
  { id: 'r-buyer', name: 'Buyer', can_write: true, writable_fields: null },
  { id: 'r-viewer', name: 'Viewer', can_write: false, writable_fields: null },
  { id: 'r-admin', name: 'Admin', admin: true, can_write: true, writable_fields: null }
]
const ctx = (extra: Partial<LintContext> = {}): LintContext => ({
  fields: [
    { field: 'title', label: 'Title', required: true },
    { field: 'vendor', label: 'Vendor' },
    { field: 'site', label: 'Site' },
    { field: 'contact', label: 'Contact', cascade_parents: ['vendor'] },
    { field: 'notes', label: 'Notes' },
    { field: 'po', label: 'PO number' }
  ],
  roles: ROLES,
  requirements: [],
  ...extra
})

const rules = (l: LintLayoutInput, c = ctx()) => lintLayout(l, c).map((f) => f.rule)

describe('lintLayout', () => {
  it('a clean form has no findings', () => {
    const l = layout([g('main')], [p('title', 'main', 0), p('vendor', 'main', 1)])
    expect(lintLayout(l, ctx())).toEqual([])
  })

  it('skips layouts that are not record forms', () => {
    const l = layout([g('main')], [], { layout_type: 'table' })
    expect(lintLayout(l, ctx())).toEqual([])
  })

  it('flags a required field the form hides, with a fix that shows it', () => {
    const l = layout([g('main')], [p('title', 'main', 0, { is_visible: false })])
    const f = lintLayout(l, ctx()).find((x) => x.rule === 'required-hidden')
    expect(f?.severity).toBe('error')
    expect(f?.fix?.ops).toEqual([
      {
        op: 'update_placement',
        at: { field: 'title', group_key: 'main' },
        patch: { is_visible: true }
      }
    ])
  })

  it('flags a required field in a section hidden from a role that edits', () => {
    const l = layout(
      [g('main', { hidden_for_roles: JSON.stringify(['R-BUYER', 'r-viewer']) })],
      [p('title', 'main', 0)]
    )
    const f = lintLayout(l, ctx()).find((x) => x.rule === 'required-hidden-for-role')
    expect(f?.message).toContain('Buyer')
    expect(f?.message).not.toContain('Viewer')
    // The fix keeps the other role hidden.
    expect(f?.fix?.ops[0]).toEqual({
      op: 'group_update',
      key: 'main',
      patch: { hidden_for_roles: JSON.stringify(['r-viewer']) }
    })
  })

  it('a second placement the role can see clears the role finding', () => {
    const l = layout(
      [g('main', { hidden_for_roles: '["r-buyer"]' }), g('other')],
      [p('title', 'main', 0), p('title', 'other', 0)]
    )
    expect(rules(l)).not.toContain('required-hidden-for-role')
  })

  it('flags a field a transition needs when its section is locked for that role', () => {
    const l = layout([g('main', { locked_for_roles: '["r-buyer"]' })], [p('po', 'main', 0)])
    const c = ctx({ requirements: [{ field: 'po', transition: 'Approve', role_ids: ['r-buyer'] }] })
    const f = lintLayout(l, c).find((x) => x.rule === 'required-hidden-for-role')
    expect(f?.message).toBe(
      'Buyer must fill PO number to Approve, but Main is locked for that role.'
    )
  })

  it('ignores roles without write access to the field', () => {
    const l = layout([g('main', { hidden_for_roles: '["r-buyer"]' })], [p('title', 'main', 0)])
    const c = ctx({
      roles: [{ id: 'r-buyer', name: 'Buyer', can_write: true, writable_fields: ['vendor'] }]
    })
    expect(rules(l, c)).not.toContain('required-hidden-for-role')
  })

  it('flags a picker cascade whose parent is not on the form, and fixes it by placing it', () => {
    const l = layout([g('main')], [p('title', 'main', 0), p('contact', 'main', 1)])
    const f = lintLayout(l, ctx()).find((x) => x.rule === 'cascade-missing')
    expect(f?.message).toContain('Vendor')
    expect(f?.fix?.ops).toEqual([{ op: 'place', field: 'vendor', group_key: 'main', index: 1 }])
  })

  it('a parent in the header counts as on the form', () => {
    const l = layout(
      [g('main')],
      [p('title', 'main', 0), p('contact', 'main', 1), p('vendor', '__header__', 0)]
    )
    expect(rules(l)).not.toContain('cascade-missing')
  })

  it('flags empty sections and steps; text blocks are fine', () => {
    const l = layout(
      [
        g('main'),
        g('blank'),
        g('step2', { type: 'tab' }),
        g('note', { type: 'content' }),
        g('holder', { type: 'container' })
      ],
      [p('title', 'main', 0)],
      { tab_mode: 'steps' }
    )
    const fs = lintLayout(l, ctx())
    expect(fs.filter((f) => f.rule === 'empty-section').map((f) => f.target)).toEqual([
      { kind: 'group', key: 'blank' },
      { kind: 'group', key: 'holder' }
    ])
    const step = fs.find((f) => f.rule === 'empty-step')
    expect(step?.message).toContain('step')
    expect(step?.fix?.ops).toEqual([{ op: 'group_remove', key: 'step2', placements: 'ungroup' }])
  })

  it('finds steps no record reaches and the fields only they hold', () => {
    const l = layout(
      [
        g('main'),
        g('never', {
          type: 'tab',
          visible_when: JSON.stringify([{ field: 'status', op: 'eq', value: 'closed' }])
        })
      ],
      [p('title', 'main', 0), p('notes', 'never', 0), p('vendor', 'main', 1)],
      { record_conditions: JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }]) }
    )
    const fs = lintLayout(l, ctx())
    expect(fs.find((f) => f.rule === 'unreachable-step')?.target).toEqual({
      kind: 'group',
      key: 'never'
    })
    const field = fs.filter((f) => f.rule === 'unreachable-field')
    expect(field.map((f) => (f.target as { field: string }).field)).toEqual(['notes'])
  })

  it('a section hidden from every editing role is unreachable', () => {
    const l = layout(
      [g('main'), g('admin', { hidden_for_roles: '["r-buyer","r-viewer"]' })],
      [p('title', 'main', 0), p('notes', 'admin', 0)]
    )
    expect(lintLayout(l, ctx()).find((f) => f.rule === 'unreachable-step')?.message).toContain(
      'every role but administrators'
    )
  })

  it('flags a field hidden everywhere it is placed', () => {
    const l = layout(
      [g('main')],
      [p('title', 'main', 0), p('notes', 'main', 1, { is_visible: false })]
    )
    expect(rules(l)).toContain('unreachable-field')
  })

  it('flags no label, and a required field without its marker', () => {
    const l = layout(
      [g('main')],
      [
        p('title', 'main', 0, { overrides: { label: '' } }),
        p('vendor', 'main', 1, { overrides: JSON.stringify({ label: '', note: 'x' }) })
      ]
    )
    const fs = lintLayout(l, ctx())
    expect(fs.find((f) => f.rule === 'a11y-required-no-marker')?.target).toMatchObject({
      field: 'title'
    })
    const noLabel = fs.find((f) => f.rule === 'a11y-no-label')
    expect(noLabel?.fix?.ops[0]).toEqual({
      op: 'update_placement',
      at: { field: 'vendor', group_key: 'main' },
      patch: { overrides: { note: 'x' } }
    })
  })

  it('a related-records list, or the only field of its section, needs no label of its own', () => {
    const c = ctx({ fields: [...ctx().fields, { field: 'lines', type: 'alias', required: true }] })
    const l = layout(
      [g('main'), g('solo')],
      [
        p('title', 'main', 0),
        p('lines', 'main', 1, { overrides: { label: '' } }),
        p('notes', 'solo', 0, { overrides: { label: '' } })
      ]
    )
    expect(rules(l, c)).toEqual([])
  })

  it('flags a half-width field that sits after a full-width one with room above it', () => {
    const l = layout(
      [g('main')],
      [
        p('title', 'main', 0, { col_span: 6 }),
        p('notes', 'main', 1, { col_span: 12 }),
        p('vendor', 'main', 2, { col_span: 6 })
      ]
    )
    const f = lintLayout(l, ctx()).find((x) => x.rule === 'a11y-tab-order')
    expect(f?.target).toMatchObject({ field: 'vendor' })
    expect(f?.fix?.ops).toEqual([
      { op: 'move', from: { field: 'vendor', group_key: 'main' }, to_group_key: 'main', index: 1 }
    ])
  })

  it('flags a low-contrast colour choice', () => {
    const l = layout(
      [g('main')],
      [
        p('title', 'main', 0),
        p('vendor', '__header__', 0, {
          input_bindings: [{ key: '__color__', binding_type: 'static', binding_value: 'cyan' }]
        }),
        p('site', '__header__', 1, {
          input_bindings: [{ key: '__color__', binding_type: 'static', binding_value: 'blue' }]
        })
      ]
    )
    const fs = lintLayout(l, ctx()).filter((f) => f.rule === 'a11y-contrast')
    expect(fs).toHaveLength(1)
    expect(fs[0].message).toContain('cyan')
  })

  it('never calls the Ungrouped zone row an empty section', () => {
    const l = layout([g('main'), g('__ungrouped__')], [p('title', 'main', 0)])
    expect(lintLayout(l, ctx())).toEqual([])
  })

  it('judges what a parent layout supplies but leaves its fixes to the parent', () => {
    const parent = layout([g('base')], [p('title', 'base', 0, { is_visible: false })])
    const own = layout([g('main')], [p('vendor', 'main', 0)])
    const merged = mergeInherited(own, parent)
    expect(merged.inherited).toEqual({ fields: ['title'], groups: ['base'] })
    const f = lintLayout(merged, ctx()).find((x) => x.rule === 'required-hidden')
    expect(f).toBeDefined()
    expect(f?.fix).toBeUndefined()
  })

  it('sorts errors first', () => {
    const l = layout([g('main'), g('blank')], [p('title', 'main', 0, { is_visible: false })])
    expect(lintLayout(l, ctx())[0].severity).toBe('error')
  })
})

describe('conditionsContradict', () => {
  it.each([
    [
      [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'a', op: 'eq', value: '2' }
      ],
      true
    ],
    [
      [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'a', op: 'eq', value: '1' }
      ],
      false
    ],
    [
      [
        { field: 'a', op: 'eq', value: 'x' },
        { field: 'a', op: 'neq', value: 'x' }
      ],
      true
    ],
    [
      [
        { field: 'a', op: 'null' },
        { field: 'a', op: 'nnull' }
      ],
      true
    ],
    [
      [
        { field: 'a', op: 'gt', value: 10 },
        { field: 'a', op: 'lt', value: 5 }
      ],
      true
    ],
    [
      [
        { field: 'a', op: 'gte', value: 5 },
        { field: 'a', op: 'lte', value: 5 }
      ],
      false
    ],
    [
      [
        { field: 'a', op: 'eq', value: 3 },
        { field: 'a', op: 'gt', value: 5 }
      ],
      true
    ],
    [
      [
        { field: 'a', op: 'eq', value: '{{b}}' },
        { field: 'a', op: 'eq', value: 2 }
      ],
      false
    ],
    [
      [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 }
      ],
      false
    ]
  ])('%j → %s', (cs, want) => {
    expect(conditionsContradict(cs)).toBe(want)
  })
})

describe('contrast', () => {
  it('computes the WCAG ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrastRatio('nope', '#fff')).toBeNull()
  })
  it('judges named colours on the worse background', () => {
    expect(colourContrast('cyan')?.mode).toBe('light')
    expect(colourContrast('cyan')?.ratio).toBeLessThan(3)
    expect(colourContrast('#1e293b')?.mode).toBe('dark')
    expect(colourContrast('teal-ish')).toBeNull()
  })
})

describe('layoutHealth', () => {
  it('a clean small form scores 100', () => {
    const l = layout([g('main')], [p('title', 'main', 0)])
    expect(layoutHealth(l, [])).toEqual({ score: 100, costs: [] })
  })
  it('lists what costs points', () => {
    const many = Array.from({ length: 45 }, (_, i) => p(`f${i}`, 'main', i))
    const l = layout([g('main')], many)
    const findings = lintLayout(
      layout([g('main'), g('blank')], [p('title', 'main', 0, { is_visible: false })]),
      ctx()
    )
    const h = layoutHealth(l, findings)
    expect(h.costs.map((c) => c.label)).toEqual(['45 fields on one form', '1 problem', '1 warning'])
    expect(h.score).toBe(100 - 5 - 10 - 4)
  })
  it('caps lint costs and never goes below zero', () => {
    const l = layout([g('main')], [p('title', 'main', 0)])
    const errs = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      rule: 'required-hidden' as const,
      severity: 'error' as const,
      target: { kind: 'layout' as const },
      message: ''
    }))
    expect(layoutHealth(l, errs).score).toBe(50)
  })
})
