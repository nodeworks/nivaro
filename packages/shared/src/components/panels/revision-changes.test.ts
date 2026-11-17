import { describe, expect, it } from 'vitest'
import {
  buildSaveRows,
  type ChangeSourceRevision,
  matrixColumns,
  matrixCsv,
  rowsChanging,
  signedAmount,
  viaText
} from './revision-changes'

const LABELS: Record<string, string> = {
  requisition_amount: 'Requisition Amount',
  name: 'Name',
  vendor: 'Vendor',
  changed: 'Changed'
}
const meta = (f: string) => ({
  label: LABELS[f] ?? f,
  system: f === 'changed',
  order: ['name', 'vendor', 'requisition_amount'].indexOf(f) + 1 || undefined
})

const rev = (r: Partial<ChangeSourceRevision>): ChangeSourceRevision => ({
  id: null,
  action: null,
  data: null,
  delta: null,
  timestamp: null,
  user_id: 'U1',
  first_name: 'Richard',
  last_name: 'Peart',
  ...r
})

// Newest first, as the API answers.
const history: ChangeSourceRevision[] = [
  rev({
    id: '3',
    action: 'update',
    timestamp: '2026-11-11T15:09:00Z',
    data: { id: 1, name: 'Fuse repair', vendor: 7, requisition_amount: 2060, changed: 'b' },
    delta: { name: 'Fuse repair', changed: 'b' }
  }),
  rev({
    action: 'o2m-update',
    timestamp: '2026-11-11T14:51:00Z',
    o2m: {
      verb: 'changed',
      collection: 'workflow_line_items',
      collection_label: 'Lines',
      row_label: 'Line 1',
      changes: [{ field: 'amount', label: 'Amount', from: '1', to: '2060' }],
      totals: [{ field: 'requisition_amount', label: 'Requisition Amount', delta: 2059 }]
    }
  }),
  rev({
    id: '2',
    action: 'update',
    timestamp: '2026-11-10T12:00:00Z',
    first_name: 'Nisha',
    last_name: 'Uprety',
    user_id: 'U2',
    data: { id: 1, name: 'Fuse', vendor: 7, requisition_amount: 1, changed: 'a2' },
    delta: { vendor: 7, changed: 'a2' }
  }),
  rev({
    id: '1',
    action: 'create',
    timestamp: '2026-11-09T22:08:00Z',
    data: { id: 1, name: 'Fuse', vendor: null, requisition_amount: 1, changed: 'a' }
  })
]

describe('the revision grid', () => {
  const rows = buildSaveRows(history)

  it('one row per save, newest first, each the record as that save left it', () => {
    expect(rows.map((r) => r.action)).toEqual(['changed', 'changed', 'created'])
    expect(rows[0].values.requisition_amount).toBe(2060)
    expect(rows[1].who).toBe('Nisha Uprety')
  })

  it('tells written fields from recalculated ones, and who moved a total', () => {
    expect(rows[0].changed.has('name')).toBe(true)
    expect(rows[0].changed.has('requisition_amount')).toBe(false)
    expect([...rows[0].recalculated]).toEqual(['requisition_amount'])
    expect(rows[0].via.get('requisition_amount')).toEqual([
      { name: 'Richard Peart', userId: 'U1', row: 'Line 1', delta: 2059 }
    ])
    expect(viaText(rows[0].via.get('requisition_amount'))).toBe(
      'Recalculated after Richard Peart · Line 1 +2,059'
    )
  })

  it('columns in form order, counting how often each moved, system columns left out', () => {
    expect(matrixColumns(rows, meta)).toEqual([
      { field: 'name', label: 'Name', changes: 1 },
      { field: 'vendor', label: 'Vendor', changes: 1 },
      { field: 'requisition_amount', label: 'Requisition Amount', changes: 1 }
    ])
  })

  it('narrows to the saves that moved the chosen columns, keeping the creation', () => {
    expect(rowsChanging(rows, ['requisition_amount']).map((r) => r.action)).toEqual([
      'changed',
      'created'
    ])
  })

  it('writes the grid as CSV with the recalculation note', () => {
    const csv = matrixCsv(rows, matrixColumns(rows, meta), (_f, v) => String(v ?? ''))
    const [head, first] = csv.split('\r\n')
    expect(head).toBe('When,Changed by,Action,Name,Vendor,Requisition Amount,Recalculated')
    expect(first).toContain('Richard Peart,Changed,Fuse repair,7,2060')
    expect(first).toContain('Requisition Amount: Recalculated after Richard Peart · Line 1 +2,059')
    expect(signedAmount(-50)).toBe('−50')
  })
})
