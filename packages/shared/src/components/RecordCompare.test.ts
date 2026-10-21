import { describe, expect, it } from 'vitest'
import { buildCompare, compareKey } from './RecordCompare'

describe('compareKey', () => {
  it('reads numbers, blanks and text the way people do', () => {
    expect(compareKey('10.000')).toBe(compareKey(10))
    expect(compareKey(null)).toBe(compareKey(''))
    expect(compareKey(' a ')).toBe('a')
    expect(compareKey(true)).not.toBe(compareKey('1'))
  })
})

describe('buildCompare', () => {
  const formA = [
    {
      key: 'main',
      label: 'Main',
      fields: [
        { field: 'title', label: 'Name' },
        { field: 'amount', label: null }
      ]
    }
  ]
  const formB = [
    { key: 'main', label: 'Main', fields: [{ field: 'title', label: null }] },
    { key: 'extra', label: 'Extra', fields: [{ field: 'site', label: null }] }
  ]

  it('lays records out in their form sections and highlights real differences', () => {
    const out = buildCompare({
      records: [
        { id: 1, title: 'A', amount: 5, site: 'N' },
        { id: 2, title: 'B', amount: 9, site: 'S' }
      ],
      forms: [formA, formB],
      labels: { amount: 'Amount' },
      fallback: []
    })
    expect(out.map((s) => [s.label, s.rows.map((r) => r.field)])).toEqual([
      ['Main', ['title', 'amount']],
      ['Extra', ['site']]
    ])
    const [title, amount] = out[0].rows
    expect(title).toMatchObject({ label: 'Name', differs: true })
    // Only record 1's form shows amount: no difference, the other side says why.
    expect(amount.differs).toBe(false)
    expect(amount.cells.map((c) => c.absent)).toEqual([null, 'form'])
    expect(out[1].rows[0].cells.map((c) => c.absent)).toEqual(['form', null])
  })

  it('never shows a field the viewer cannot read, and falls back without a form', () => {
    const out = buildCompare({
      records: [{ id: 1, title: 'A' }, null],
      forms: [null, null],
      labels: {},
      fallback: ['title', 'secret']
    })
    expect(out).toHaveLength(1)
    expect(out[0].rows.map((r) => r.field)).toEqual(['title'])
    expect(out[0].rows[0].cells.map((c) => c.absent)).toEqual([null, 'record'])
  })
})
