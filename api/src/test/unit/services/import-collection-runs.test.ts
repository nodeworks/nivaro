import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1826 — procedure-mode staged imports write set-based inside one EXEC, so the record pages
// never heard "an import is updating this record". Their runs are now announced per
// collection (the ones the definition says the procedure writes): running with a start time,
// then completed with the rows the run reported, or failed.

const emitted = vi.hoisted(() => ({
  list: [] as Array<{ room: string; event: string; payload: any }>
}))
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => emitted.list.push({ room, event, payload })
    })
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  announceCollectionImport,
  buildCollectionImportRuns,
  procImportCollections,
  RECENT_FINISH_MS,
  runsAsProcedure
} from '../../../services/import-collection-runs.js'

const none = () => false
const NOW = Date.parse('2026-11-13T15:00:00Z')
const DEFS = [
  {
    key: 'po_lines',
    label: 'PO lines',
    procedure: 'sp_import_po_lines',
    processor: null,
    recalc_rollups: '["purchase_orders","po_lines"]'
  },
  {
    key: 'vendors',
    label: null,
    procedure: 'sp_vendors',
    processor: 'service',
    recalc_rollups: '["purchase_orders"]'
  },
  {
    key: 'invoices',
    label: 'Invoices',
    procedure: 'sp_invoices',
    processor: 'efp-ops:invoices',
    recalc_rollups: 'purchase_orders'
  }
]

beforeEach(() => {
  emitted.list.length = 0
})

describe('which runs count as procedure mode', () => {
  it('is the procedure path: no processor, proc, or a processor not registered here', () => {
    expect(runsAsProcedure({ procedure: 'p', processor: null }, none)).toBe(true)
    expect(runsAsProcedure({ procedure: 'p', processor: 'proc' }, none)).toBe(true)
    expect(runsAsProcedure({ procedure: 'p', processor: 'service' }, none)).toBe(false)
    expect(runsAsProcedure({ procedure: 'p', processor: 'x:y' }, none)).toBe(true)
    expect(runsAsProcedure({ procedure: 'p', processor: 'x:y' }, () => true)).toBe(false)
    expect(runsAsProcedure({ procedure: null, processor: null }, none)).toBe(false)
  })

  it('targets the collections the procedure writes', () => {
    expect(procImportCollections(DEFS[0], none)).toEqual(['purchase_orders', 'po_lines'])
    expect(procImportCollections(DEFS[1], none)).toEqual([])
  })
})

describe('buildCollectionImportRuns', () => {
  const rows = [
    {
      id: 41,
      import_key: 'po_lines',
      status: 'running',
      started_at: new Date(NOW - 95_000),
      finished_at: null,
      row_count: 1200
    },
    {
      id: 40,
      import_key: 'invoices',
      status: 'completed',
      started_at: new Date(NOW - 300_000),
      finished_at: new Date(NOW - 120_000),
      row_count: 812
    },
    {
      id: 39,
      import_key: 'po_lines',
      status: 'error',
      started_at: new Date(NOW - 500_000),
      finished_at: new Date(NOW - 400_000),
      row_count: null
    },
    // Too old to show.
    {
      id: 30,
      import_key: 'po_lines',
      status: 'completed',
      started_at: new Date(NOW - RECENT_FINISH_MS - 60_000),
      finished_at: new Date(NOW - RECENT_FINISH_MS - 1_000),
      row_count: 5
    },
    // Service mode: announced per record by its own events, never here.
    {
      id: 38,
      import_key: 'vendors',
      status: 'running',
      started_at: new Date(NOW - 10_000),
      finished_at: null,
      row_count: null
    },
    // Queued runs are not running yet.
    { id: 42, import_key: 'po_lines', status: 'queued', started_at: null, finished_at: null }
  ]

  it('lists running and recently ended procedure runs of the collection, newest first', () => {
    const out = buildCollectionImportRuns(rows, DEFS, 'Purchase_Orders', NOW, none)
    expect(out.map((r) => [r.run_id, r.status])).toEqual([
      ['41', 'running'],
      ['40', 'completed'],
      ['39', 'error']
    ])
    expect(out[0]).toMatchObject({ label: 'PO lines', finished_at: null, rows: null })
    expect(out[0].started_at).toBe(new Date(NOW - 95_000).toISOString())
    // Finished shows the rows the run reported; a failed run reports none.
    expect(out[1]).toMatchObject({ label: 'Invoices', rows: 812 })
    expect(out[2].rows).toBeNull()
  })

  it('leaves out collections the run does not write', () => {
    expect(buildCollectionImportRuns(rows, DEFS, 'invoice_lines', NOW, none)).toEqual([])
    expect(
      buildCollectionImportRuns(rows, DEFS, 'po_lines', NOW, none).map((r) => r.run_id)
    ).toEqual(['41', '39'])
  })

  it('drops a run left "running" by a process that died long ago', () => {
    const stale = [{ ...rows[0], started_at: new Date(NOW - 13 * 3600_000) }]
    expect(buildCollectionImportRuns(stale, DEFS, 'po_lines', NOW, none)).toEqual([])
  })
})

describe('announceCollectionImport', () => {
  it('tells each target collection room the run id and status only', () => {
    const out = announceCollectionImport(DEFS[0], 41, 'running', none)
    expect(out).toEqual(['purchase_orders', 'po_lines'])
    expect(emitted.list).toEqual([
      {
        room: 'collection:purchase_orders',
        event: 'import:collection',
        payload: { collection: 'purchase_orders', run_id: '41', status: 'running' }
      },
      {
        room: 'collection:po_lines',
        event: 'import:collection',
        payload: { collection: 'po_lines', run_id: '41', status: 'running' }
      }
    ])
  })

  it('says nothing for a service-mode run', () => {
    expect(announceCollectionImport(DEFS[1], 38, 'running', none)).toEqual([])
    expect(emitted.list).toEqual([])
  })
})
