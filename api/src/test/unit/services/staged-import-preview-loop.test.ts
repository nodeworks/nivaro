import { describe, expect, it, vi } from 'vitest'

// EFP prod 2026-11-19 (build 0.3.193), the stall watchdog: "A server process froze for 3.7 s
// (main loop blocked) … in flight: POST /api/staged-imports/preview". The file was already read
// on a worker thread; the preview then mapped, validated and dry-ran every row of a 30 MB file
// on the web process in long synchronous stretches. Every pass now yields as it goes.

// A knex double: every query answers on a later turn of the loop, as a real one does.
const tables: Record<string, Array<Record<string, unknown>>> = {}
const indexes = new Map<string, Map<string, Array<Record<string, unknown>>>>()
function chain(table: string) {
  let inCol: string | null = null
  let inVals: unknown[] | null = null
  const run = async () => {
    await new Promise((r) => setImmediate(r))
    const rows = tables[table] ?? []
    if (!inCol || !inVals) return rows
    const key = `${table}.${inCol}`
    let idx = indexes.get(key)
    if (!idx) {
      idx = new Map()
      for (const r of rows) {
        const k = String(r[inCol]).toLowerCase()
        const list = idx.get(k)
        if (list) list.push(r)
        else idx.set(k, [r])
      }
      indexes.set(key, idx)
    }
    const out: Array<Record<string, unknown>> = []
    for (const v of inVals) for (const r of idx.get(String(v).toLowerCase()) ?? []) out.push(r)
    return out
  }
  const q: any = {
    whereIn(c: string, v: unknown[]) {
      inCol = c
      inVals = v
      return q
    },
    where: () => q,
    whereNull: () => q,
    modify(fn: (x: unknown) => void) {
      fn(q)
      return q
    },
    orderBy: () => q,
    limit: () => q,
    select: () => q,
    first: () => Promise.resolve({ id: 'u1' }),
    pluck: (c: string) => run().then((rows) => rows.map((r) => r[c])),
    // biome-ignore lint/suspicious/noThenProperty: a thenable query builder, like knex's
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej)
  }
  return q
}
vi.mock('../../../db/index.js', () => {
  const db: any = (t: string) => chain(t)
  db.raw = async () => []
  return { db }
})
vi.mock('../../../services/items.js', () => ({
  createOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
  applyWriteComputedFields: vi.fn()
}))
vi.mock('../../../services/queues.js', () => ({ getLabels: vi.fn() }))
vi.mock('../../../services/batch-writes.js', () => ({
  batchCreate: vi.fn(),
  batchUpdate: vi.fn(),
  batchDelete: vi.fn(),
  batchRefusal: vi.fn(async () => null),
  columnTypes: vi.fn(
    async () =>
      new Map<string, { sql: string }>([
        ['id', { sql: 'int' }],
        ['invoice_id', { sql: 'nvarchar(50)' }],
        ['line_item_number', { sql: 'int' }],
        ['vendor', { sql: 'int' }],
        ['amount', { sql: 'decimal(12,2)' }],
        ['payment_date', { sql: 'date' }],
        ['hold_reason', { sql: 'nvarchar(255)' }]
      ])
  )
}))
vi.mock('../../../services/run-long.js', () => ({ runLongSql: vi.fn() }))

const { buildStagedImportPreview, PREVIEW_ROWS } = await import(
  '../../../services/staged-import-preview.js'
)
const { mapRowsToDeclared, mapRowsToDeclaredAsync } = await import(
  '../../../services/staged-imports.js'
)
const { makePacer } = await import('../../../services/loop-pacer.js')

const declared = [
  { name: 'invoice_id', from_header: 'Invoice ID', required: true },
  { name: 'line_number', from_header: 'Line Number', type: 'int', required: true },
  { name: 'vendor', from_header: 'Vendor' },
  { name: 'base_invoice', from_header: 'Base Invoice', type: 'decimal' },
  { name: 'payment_date', from_header: 'Payment Date' },
  { name: 'hold_reason', from_header: 'Hold Reason' }
]

function fileRows(n: number): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = []
  for (let i = 0; i < n; i++) {
    rows.push({
      'Invoice ID': `INV${100000 + Math.floor(i / 3)}`,
      'Line Number': String((i % 3) + 1),
      Vendor: `Vendor ${i % 400}`,
      'Base Invoice': `${(i % 997) + 1}.25`,
      'Payment Date': `11/${(i % 28) + 1}/2026`,
      'Hold Reason': i % 11 ? '' : 'Held',
      Notes: `note ${i}`
    })
  }
  return rows
}

const definition = {
  id: 1,
  key: 'invoices_service',
  label: 'Invoices',
  staging_table: 'staging_invoices_service',
  procedure: null,
  is_active: true,
  processor: 'service',
  staging_columns: JSON.stringify(declared),
  validation: JSON.stringify({
    key_columns: ['invoice_id', 'line_number'],
    target_table: 'invoices',
    target_match: { invoice_id: 'invoice_id', line_number: 'line_item_number' },
    lookups: [{ column: 'vendor', collection: 'vendors', match_field: 'name' }]
  }),
  service_config: JSON.stringify({
    collection: 'invoices',
    match_by: ['invoice_id', 'line_item_number'],
    columns: {
      invoice_id: { field: 'invoice_id' },
      line_number: { field: 'line_item_number' },
      vendor: {
        field: 'vendor',
        lookup: { collection: 'vendors', match_field: 'name', on_missing: 'null' }
      },
      base_invoice: { field: 'amount' },
      payment_date: { field: 'payment_date' },
      hold_reason: { field: 'hold_reason' }
    }
  })
} as any

/** Run fn while a 2 ms timer measures the longest stretch the loop was held. */
async function measured<T>(fn: () => Promise<T>): Promise<{ out: T; worst: number; took: number }> {
  let worst = 0
  let last = performance.now()
  const tick = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 2)
  const began = performance.now()
  const out = await fn()
  // the stretch still open when the work answers counts too
  worst = Math.max(worst, performance.now() - last)
  clearInterval(tick)
  return { out, worst, took: performance.now() - began }
}

describe('staged import preview keeps the event loop answering', () => {
  it('maps, validates and dry-runs a big file in short slices', async () => {
    const n = 60_000
    tables.vendors = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, name: `Vendor ${i}` }))
    tables.invoices = []
    for (let i = 0; i < n; i += 2) {
      tables.invoices.push({
        id: i + 1,
        invoice_id: `INV${100000 + Math.floor(i / 3)}`,
        line_item_number: (i % 3) + 1,
        amount: 1,
        vendor: 3
      })
    }
    indexes.clear()
    const rows = fileRows(n)

    const { out, worst, took } = await measured(() =>
      buildStagedImportPreview({ definition, rows, fileName: 'invoices.csv', userId: 'u1' })
    )

    // the answer the dialog reads, and no more
    expect(out.row_count).toBe(n)
    expect(out.rows).toHaveLength(PREVIEW_ROWS)
    expect(out.columns).toEqual([
      'Invoice ID',
      'Line Number',
      'Vendor',
      'Base Invoice',
      'Payment Date',
      'Hold Reason',
      'Notes'
    ])
    expect(out.validation.warnings.map((w) => w.code)).toContain('lookup_miss')
    expect(out.dry_run).not.toBeNull()
    expect(Object.keys(out.dry_run ?? {}).sort()).toEqual(
      ['created', 'failed', 'log', 'samples', 'skipped', 'unchanged', 'updated'].sort()
    )
    expect((out.dry_run?.created ?? 0) + (out.dry_run?.updated ?? 0)).toBe(n)
    expect(out.dry_run?.samples?.creates.length).toBeLessThanOrEqual(25)

    // Before: the dry run alone held the loop for most of the call in one piece. Now the
    // longest stretch is one paced slice (20 ms) plus whatever a busy CI box adds.
    expect(worst).toBeLessThan(Math.max(150, took / 8))
  }, 120_000)

  it('mapRowsToDeclaredAsync answers what mapRowsToDeclared does', async () => {
    const rows = fileRows(7000)
    rows[5] = { ...rows[5], Extra: 'x' }
    expect(await mapRowsToDeclaredAsync(definition, rows)).toEqual(
      mapRowsToDeclared(definition, rows)
    )
    // no declared schema: the rows pass through untouched
    expect(await mapRowsToDeclaredAsync({ staging_columns: null } as any, rows)).toBe(rows)
  })

  it('a pacer yields once its slice has run its budget', async () => {
    const pace = makePacer(5)
    let other = false
    setImmediate(() => {
      other = true
    })
    let breaths = 0
    let sawOther = false
    const until = performance.now() + 30
    while (performance.now() < until) {
      if (pace.due()) {
        await pace.breathe()
        breaths++
        sawOther ||= other
      }
    }
    // other work ran while the loop was still going, between its slices
    expect(sawOther).toBe(true)
    expect(breaths).toBeGreaterThanOrEqual(1)
  })
})
