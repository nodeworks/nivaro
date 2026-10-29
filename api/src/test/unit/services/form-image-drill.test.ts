import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: async () => true,
  getAllowedFields: async () => null
}))

import { buildFormHtml, displayValue, esc } from '../../../services/form-image.js'
import type { FormFieldState, FormGroupState } from '../../../services/form-state.js'
import { clampLimit, condition, reportDrillConditions } from '../../../services/widget-drill.js'

describe('form image HTML (#3216)', () => {
  const groups: FormGroupState[] = [
    { key: 'main', label: 'Main', type: 'section', parent_key: null, visible: true, locked: false },
    {
      key: 'ops',
      label: 'Ops <b>',
      type: 'section',
      parent_key: null,
      visible: false,
      locked: false,
      why: 'hidden for this role'
    }
  ]
  const fields: FormFieldState[] = [
    {
      field: 'title',
      label: 'Title',
      group_key: 'main',
      section: 'Main',
      visible: true,
      required: true,
      locked: false
    },
    {
      field: 'vendor',
      label: 'Vendor',
      group_key: 'main',
      section: 'Main',
      visible: true,
      required: false,
      locked: true,
      why: 'Locked for this role'
    },
    {
      field: 'secret',
      label: 'Secret',
      group_key: 'ops',
      section: 'Ops',
      visible: false,
      required: false,
      locked: false,
      hidden_by: 'section_role',
      why: 'hidden for this role'
    }
  ]
  const input = (showHidden: boolean, theme: 'light' | 'dark' = 'light') => ({
    title: 'Orders #7',
    subtitle: '',
    state: {
      collection: 'orders',
      record: '7',
      can_update: true,
      layout: { id: 5, name: 'Default', why: null },
      as: { role: 'Finance', admin: false, preview: true }
    },
    groups,
    groupRows: [
      { key: 'main', parent_key: null, sort: 1 },
      { key: 'ops', parent_key: null, sort: 2 }
    ],
    fields,
    rows: new Map([
      ['title', { field: 'title', type: 'string', options: { col_span: 6 } }],
      ['vendor', { field: 'vendor', type: 'integer' }]
    ]),
    values: { title: 'Tom & "Jerry" <3', vendor: 12, secret: 'TOP SECRET' },
    linkLabels: new Map([['vendor', 'ACME']]),
    theme,
    phone: false,
    showHidden,
    generatedAt: '2026-10-29 14:00 UTC'
  })

  it('escapes values, draws widths, required and lock marks, and the link label', () => {
    const html = buildFormHtml(input(false))
    expect(html).toContain('Tom &amp; &quot;Jerry&quot; &lt;3')
    expect(html).toContain('grid-column: span 6')
    expect(html).toContain('class="req"')
    expect(html).toContain('ACME')
    expect(html).toContain('As Finance (preview)')
    expect(html).not.toMatch(/<script/i)
  })

  it('never draws a hidden field value; hidden parts appear only with show_hidden', () => {
    const plain = buildFormHtml(input(false))
    expect(plain).not.toContain('TOP SECRET')
    expect(plain).not.toContain('Secret')
    const shown = buildFormHtml(input(true, 'dark'))
    expect(shown).not.toContain('TOP SECRET')
    expect(shown).toContain('Hidden — hidden for this role')
    expect(shown).toContain('Ops &lt;b&gt;')
    expect(shown).toContain('#0b1220')
  })

  it('formats values without time zone shifts', () => {
    expect(displayValue({ type: 'date' }, '2026-03-01').text).toBe('Mar 1, 2026')
    expect(displayValue({ type: 'boolean' }, true).text).toBe('Yes')
    expect(displayValue({ type: 'string' }, null)).toEqual({ text: '—', empty: true })
    expect(
      displayValue({ type: 'string', options: { choices: [{ value: 'a', text: 'Alpha' }] } }, 'a')
        .text
    ).toBe('Alpha')
    expect(displayValue({ type: 'text' }, '<p>Hi <b>there</b></p>').text).toBe('Hi there')
    // Markup in a value never survives as markup: tags out, the rest escaped on the way in.
    expect(displayValue({ type: 'text' }, '<img src=x onerror=alert(1)>').text).toBe('')
    expect(esc('"<&>\'')).toBe('&quot;&lt;&amp;&gt;&#39;')
  })
})

describe('widget drill conditions (#3208)', () => {
  it('builds null-safe items filter members', () => {
    expect(condition('a', 'eq', null)).toEqual({ a: { _null: true } })
    expect(condition('a', 'neq', null)).toEqual({ a: { _nnull: true } })
    expect(condition('a', 'in', 'x, y')).toEqual({ a: { _in: ['x', 'y'] } })
    expect(condition('a', 'gte', 3)).toEqual({ a: { _gte: 3 } })
    expect(condition('a', 'bogus', 3)).toEqual({ a: { _eq: 3 } })
  })

  it('clamps the row limit', () => {
    expect(clampLimit(undefined)).toBe(25)
    expect(clampLimit(1000)).toBe(100)
    expect(clampLimit(-3)).toBe(25)
  })

  it('mirrors the report records modal: filters, entity filters, date window, segment', () => {
    const conds = reportDrillConditions(
      {
        filters: [
          { field: 'status', op: 'eq', value: 'open' },
          { field: 'x', op: 'weird' as never, value: 1 }
        ],
        dimension: { field: 'created_at', bucket: 'month' }
      },
      [{ field: 'region', values: ['East'] }],
      { preset: 'custom', start: '2026-01-01', end: '2026-03-31' },
      { value: '2026-02' }
    )
    expect(conds.map((c) => [c.field, c.op, c.from])).toEqual([
      ['status', 'eq', 'widget'],
      ['region', 'in', 'entity'],
      ['created_at', 'gte', 'date'],
      ['created_at', 'lte', 'date'],
      ['created_at', 'gte', 'segment'],
      ['created_at', 'lte', 'segment']
    ])
    expect(conds[4]?.value).toBe('2026-02-01')
    expect(conds[5]?.value).toBe('2026-02-28T23:59:59')
  })

  it('a plain dimension segment is an equality, a null one is _null', () => {
    const cfg = { dimension: { field: 'vendor' } }
    expect(reportDrillConditions(cfg, [], null, { value: 'ACME' })).toEqual([
      { field: 'vendor', op: 'eq', value: 'ACME', from: 'segment' }
    ])
    expect(reportDrillConditions(cfg, [], null, { value: null })).toEqual([
      { field: 'vendor', op: 'null', value: true, from: 'segment' }
    ])
    expect(reportDrillConditions(cfg, [], null, { field: 'zone', value: 3 })).toEqual([
      { field: 'zone', op: 'eq', value: 3, from: 'segment' }
    ])
  })
})
