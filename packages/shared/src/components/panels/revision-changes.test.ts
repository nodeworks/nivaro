import { describe, expect, it } from 'vitest'
import {
  buildSaveRows,
  type ChangeSourceRevision,
  csvCell,
  deriveOf,
  matrixColumns,
  matrixCsv,
  recalcReason,
  rowsChanging,
  STEP_FIELD,
  signedAmount,
  viaText,
  withLinkLabels
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

describe('a partial first save (an integration create)', () => {
  it('a field the save before never recorded is not a change, let alone a recalculation', () => {
    const rows = buildSaveRows([
      rev({
        id: '2',
        action: 'update',
        timestamp: '2026-08-19T17:00:05Z',
        data: { id: 1, name: 'X', p2: false, is_send_back: false },
        delta: { name: 'X' }
      }),
      rev({
        id: '1',
        action: 'create',
        timestamp: '2026-08-19T17:00:00Z',
        data: { id: 1, name: 'W' }
      })
    ])
    expect([...rows[0].recalculated]).toEqual([])
    expect(rows[0].changed.has('name')).toBe(true)
  })
})

describe('csvCell', () => {
  it('defuses formulas, keeps plain negative numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('-2,059.50')).toBe('"-2,059.50"')
    expect(csvCell('-50')).toBe('-50')
    expect(csvCell('Fuse repair')).toBe('Fuse repair')
  })
})

describe('why a value was recalculated', () => {
  const rows = buildSaveRows(history)
  const label = (c: string | null, f?: string) =>
    c == null ? (LABELS[f ?? ''] ?? String(f)) : f ? `«${f}»` : `«${c}»`

  it('a rollup names its rows and who moved it', () => {
    const d = deriveOf(
      'rollup',
      JSON.stringify({
        sources: [
          {
            related_collection: 'workflow_line_items',
            fk_field: 'workflow',
            aggregate: 'sum',
            value_field: 'amount',
            filter: { line_type: { _eq: 'Capital' } }
          }
        ]
      })
    )
    expect(recalcReason('requisition_amount', rows[0], d, label)).toEqual({
      why: 'Sum of «workflow_line_items» · «amount» (filtered)',
      because: 'Richard Peart changed Line 1 (+2,059)'
    })
  })

  it('a formula names its inputs and the ones that moved', () => {
    const d = deriveOf('write', '{{name}} - {{vendor}}')
    expect(d).toEqual({ kind: 'formula', inputs: ['name', 'vendor'] })
    expect(recalcReason('label', rows[0], d, label)).toEqual({
      why: 'Worked out from Name and Vendor',
      because: 'Name changed'
    })
  })

  it('a plain field moved by something else says so', () => {
    expect(recalcReason('p2', rows[0], deriveOf(null, null), label).why).toBe(
      'Set automatically (rule, job or integration)'
    )
  })
})

describe('the pipeline step column', () => {
  const withMoves: ChangeSourceRevision[] = [
    ...history,
    rev({
      action: 'transition',
      timestamp: '2026-11-11T15:13:00Z',
      event: { kind: 'transition', from_label: 'Started', to_label: 'Level 1 Approval' }
    }),
    rev({
      action: 'transition',
      timestamp: '2026-11-09T22:08:30Z',
      event: { kind: 'start', from_label: null, to_label: 'Started' }
    }),
    rev({
      action: 'transition',
      timestamp: '2026-11-10T09:00:00Z',
      event: { kind: 'transition', from_label: 'A', to_label: 'B', addendum: { id: '9' } }
    })
  ]

  it('every save carries the step the record was in', () => {
    const rows = buildSaveRows(withMoves)
    expect(rows.map((r) => r.values[STEP_FIELD])).toEqual(['Started', 'Started', null])
  })

  it('each move is a row of its own (an addendum’s moves are not the record’s)', () => {
    const rows = buildSaveRows(withMoves, { withMoves: true })
    const moved = rows.filter((r) => r.action === 'moved')
    expect(moved.map((r) => r.values[STEP_FIELD])).toEqual(['Level 1 Approval', 'Started'])
    expect(rows[0]).toMatchObject({ action: 'moved' })
    expect(rows[0].values.name).toBe('Fuse repair')
    const cols = matrixColumns(rows, meta)
    expect(cols[0]).toEqual({ field: STEP_FIELD, label: 'Pipeline step', changes: 2 })
    expect(rowsChanging(rows, ['name']).some((r) => r.action === 'moved')).toBe(false)
    expect(rowsChanging(rows, [STEP_FIELD]).filter((r) => r.action === 'moved')).toHaveLength(2)
  })
})

describe('an automatic move', () => {
  it('is folded into the save that set it off', () => {
    const rows = buildSaveRows(
      [
        rev({
          action: 'transition',
          timestamp: '2026-08-20T02:20:59Z',
          user_id: null,
          first_name: null,
          last_name: null,
          event: {
            kind: 'transition',
            from_label: 'Waiting on PO',
            to_label: 'Completed',
            source: 'auto'
          }
        }),
        rev({
          id: '2',
          action: 'update',
          timestamp: '2026-08-20T02:21:00Z',
          first_name: 'Timothy',
          last_name: 'Desrosiers',
          data: { id: 1, name: 'B' },
          delta: { name: 'B' }
        }),
        rev({
          id: '1',
          action: 'create',
          timestamp: '2026-08-19T17:00:00Z',
          data: { id: 1, name: 'A' }
        })
      ],
      { withMoves: true }
    )
    // Folded into the save that set it off: one row, Tim's, with the step changed.
    expect(rows.map((r) => r.action)).toEqual(['changed', 'created'])
    expect(rows[0].who).toBe('Timothy Desrosiers')
    expect(rows[0].values[STEP_FIELD]).toBe('Completed')
    expect(rows[0].changed.has(STEP_FIELD)).toBe(true)
    expect(rows[0].autoMove).toEqual({ from: 'Waiting on PO', to: 'Completed' })
  })
})

describe('link fields read as what they point at', () => {
  const links = {
    fields: {
      divisions: {
        '484714': { target: '3', label: 'Zone 3' },
        '484826': { target: '3', label: 'Zone 3' },
        '480971': { target: '4', label: 'Zone 4' }
      }
    }
  }
  it('a rewrite of the links to the same Zone is no change, a new Zone is', () => {
    const revs = withLinkLabels(
      [
        rev({
          id: '3',
          action: 'update',
          timestamp: '2026-12-05T15:53:00Z',
          data: { id: 1, divisions: [484826, 480971] },
          delta: {}
        }),
        rev({
          id: '2',
          action: 'update',
          timestamp: '2026-12-04T16:57:00Z',
          data: { id: 1, divisions: [484714] },
          delta: {}
        }),
        rev({
          id: '1',
          action: 'create',
          timestamp: '2026-12-03T17:00:00Z',
          data: { id: 1, divisions: [484714] }
        })
      ],
      links
    )
    expect(revs.map((r) => r.data?.divisions)).toEqual(['Zone 3, Zone 4', 'Zone 3', 'Zone 3'])
    const rows = buildSaveRows(revs)
    expect(rows[1].recalculated.has('divisions')).toBe(false)
    expect(rows[0].recalculated.has('divisions')).toBe(true)
  })

  it('ids the reader cannot see read as a count, never as ids', () => {
    const [r] = withLinkLabels(
      [rev({ id: '1', action: 'create', data: { divisions: [484714, 999] } })],
      links
    )
    expect(r.data?.divisions).toBe('Zone 3, +1 more')
  })

  it('reads expanded keys and names an all-unknown set by its count', () => {
    const [r] = withLinkLabels(
      [rev({ id: '1', action: 'create', data: { divisions: [{ id: 484714 }], files: [5, 6] } })],
      { fields: { ...links.fields, files: {} } }
    )
    expect(r.data?.divisions).toBe('Zone 3')
    expect(r.data?.files).toBe('2 linked')
  })
})
