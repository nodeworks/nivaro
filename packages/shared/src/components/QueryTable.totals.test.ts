import { describe, expect, it } from 'vitest'
import { evaluateNumeric } from '../lib/expression'
import { pivotQueryRows, queryTableTotals, UNDATED_KEY } from './QueryTable'

// Army 5 b04-N-1 / b05-N3: the Project Type Allocation Total row read
// "CAPEX BUDGET $0 · % PUB'D 0% · AVAILABLE $0" while every row said "—"
// (no CAPEX target for the year).
describe('queryTableTotals', () => {
  const columns = [
    { field: 'project_type', label: 'Project Type' },
    { field: 'budget', label: 'CAPEX Budget', format: 'currency' as const, sum: true },
    { field: 'carAmount', label: 'CAR amount', format: 'currency' as const, sum: true },
    { field: 'available', label: 'Available', format: 'currency' as const, sum: true },
    { field: 'units', label: 'Units', format: 'number' as const, sum: true }
  ]
  const rows = [
    { project_type: 'Power', budget: null, carAmount: 100, available: null, units: null },
    { project_type: 'CMTS', budget: null, carAmount: 50.5, available: null, units: null }
  ]

  it('a money column no row holds a number in totals to null, not 0', () => {
    const t = queryTableTotals(rows, columns)
    expect(t.budget).toBeNull()
    expect(t.available).toBeNull()
    expect(t.carAmount).toBe(150.5)
  })

  it('non-money columns keep their 0 unless they opt in', () => {
    expect(queryTableTotals(rows, columns).units).toBe(0)
    const optIn = columns.map((c) => (c.field === 'units' ? { ...c, null_when_empty: true } : c))
    expect(queryTableTotals(rows, optIn).units).toBeNull()
    const optOut = columns.map((c) => (c.field === 'budget' ? { ...c, null_when_empty: false } : c))
    expect(queryTableTotals(rows, optOut).budget).toBe(0)
  })

  it('sums the rows that hold a number and skips null / blank', () => {
    const t = queryTableTotals(
      [{ budget: 100 }, { budget: null }, { budget: '' }, { budget: '25' }],
      columns
    )
    expect(t.budget).toBe(125)
  })

  it("% PUB'd over the totals is no figure without a target (formula {{carAmount}} * 100 / {{budget}})", () => {
    const t = queryTableTotals(rows, columns)
    expect(evaluateNumeric('{{carAmount}} * 100 / {{budget}}', t)).toBeNull()
    // the old shape read 0%: x / null → null, null * 100 → 0
    expect(evaluateNumeric('{{carAmount}} / {{budget}} * 100', t)).toBe(0)
    expect(
      evaluateNumeric('{{carAmount}} * 100 / {{budget}}', { carAmount: 50, budget: 200 })
    ).toBe(25)
  })
})

// Army 5 b05-N6 / b11-N5: other spend with no year came back keyed "-01" and
// dropped out of the Calendar Year Spend grid; the procs now key it 'Undated'.
describe('pivotQueryRows: Undated spend', () => {
  const pivot = { key_fields: ['project'], date_field: 'spend_date', value_field: 'amt' }
  it('gives undated spend its own column and counts it in the total', () => {
    const { rows, columns } = pivotQueryRows(
      [
        { project: 'A', spend_date: '2026-01', amt: 10 },
        { project: 'A', spend_date: UNDATED_KEY, amt: 5 },
        { project: 'B', spend_date: '2025-07', amt: 3 },
        { project: 'B', spend_date: '-01', amt: 99 }
      ],
      pivot,
      2026
    )
    const a = rows.find((r) => r.project === 'A')!
    expect(a.jan).toBe(10)
    expect(a.undated).toBe(5)
    expect(a.total).toBe(15)
    // any other non-date key still skips
    expect(rows.find((r) => r.project === 'B')!.total).toBe(3)
    const labels = columns.map((c) => c.label)
    expect(labels.indexOf('Undated')).toBe(labels.indexOf('Total') - 1)
  })
  it('adds no Undated column when nothing is undated', () => {
    const { columns } = pivotQueryRows(
      [{ project: 'A', spend_date: '2026-01', amt: 1 }],
      pivot,
      2026
    )
    expect(columns.some((c) => c.field === 'undated')).toBe(false)
  })
})
