import { beforeEach, describe, expect, it, vi } from 'vitest'

// The record read AS THE VIEWER: null = they cannot see it (row filter / scope), a throw with
// 403/404 = no access at all. Either way there is no card.
let readOneResult: Record<string, unknown> | null = null
let readOneError: { statusCode: number } | null = null
const readOneCalls: unknown[][] = []
vi.mock('./items.js', () => ({
  readOne: async (...args: unknown[]) => {
    readOneCalls.push(args)
    if (readOneError) throw Object.assign(new Error('refused'), readOneError)
    return readOneResult
  }
}))
vi.mock('./collections.js', () => ({
  getCollection: async () => ({ display_template: '{{number}} · {{total}}', singular: 'Order' }),
  getFields: async () => [
    { field: 'id', type: 'integer' },
    { field: 'number', type: 'string' },
    { field: 'total', type: 'decimal', label: 'Order total' },
    { field: 'tax_amount', type: 'decimal' },
    { field: 'secret_cost', type: 'decimal' },
    { field: 'line_count', type: 'integer' }
  ]
}))
vi.mock('./record-labels-as-viewer.js', () => ({
  recordLabelsAsViewer: async () => ({ 'orders:5': 'PO-5 · 120.5' })
}))
// The card's step / owners / SLA come from the SAME sources the record page reads (security
// review 2026-11-14) — never the command center's looser decorations.
const geoCalls: unknown[] = []
vi.mock('./command-center/geo.js', () => ({
  decorateRecords: async (...a: unknown[]) => {
    geoCalls.push(a)
    return new Map()
  }
}))
let instance: { current_state?: string | null } | undefined = { current_state: 'S1' }
const instanceCalls: unknown[][] = []
vi.mock('./branch-instances.js', () => ({
  findRecordInstance: async (...a: unknown[]) => {
    instanceCalls.push(a)
    return instance
  }
}))
vi.mock('../db/index.js', () => ({
  db: () => {
    const b: Record<string, unknown> = {}
    b.where = () => b
    b.first = async () => ({ key: 'review', label: 'In review', color: '#f59e0b' })
    return b
  }
}))
const ownerCalls: unknown[][] = []
let ownersAnswer: Record<
  string,
  Array<{ id: string; name: string; inactive?: 'suspended' | 'former' }>
> = {
  '5': [
    { id: 'u1', name: 'Beth Smith' },
    { id: 'u2', name: 'Former user', inactive: 'former' }
  ]
}
vi.mock('../routes/pipelines.js', () => ({
  resolvedOwnerNames: async (...a: unknown[]) => {
    ownerCalls.push(a)
    return ownersAnswer
  }
}))
let slaAnswer: Record<string, { status: string | null }> = { '5': { status: 'warning' } }
vi.mock('../routes/sla.js', () => ({
  computeStatusBatch: async () => slaAnswer
}))
vi.mock('./command-center/regions.js', () => ({
  readableName: (c: string, n?: string | null) => n || c
}))

import { pickCardAmounts, recordCard, templateFieldNames } from './record-card.js'

const user = { id: 'viewer' } as never

describe('recordCard — read as the viewer', () => {
  beforeEach(() => {
    readOneResult = null
    readOneError = null
    readOneCalls.length = 0
    geoCalls.length = 0
    ownerCalls.length = 0
    instanceCalls.length = 0
    instance = { current_state: 'S1' }
    ownersAnswer = {
      '5': [
        { id: 'u1', name: 'Beth Smith' },
        { id: 'u2', name: 'Former user', inactive: 'former' }
      ]
    }
    slaAnswer = { '5': { status: 'warning' } }
  })

  it('an unreadable record never reaches the step, owner or SLA reads', async () => {
    readOneResult = null
    await recordCard(user, 'orders', '5')
    expect(ownerCalls).toHaveLength(0)
    expect(instanceCalls).toHaveLength(0)
  })

  it('step, owners and SLA come from the record page’s own sources', async () => {
    readOneResult = { id: 5, number: 'PO-5' }
    const card = await recordCard(user, 'orders', '5')
    // The instance the pipeline panel shows (findRecordInstance), the header tile's owners.
    expect(instanceCalls[0]).toEqual(['orders', '5'])
    expect(ownerCalls[0]).toEqual(['orders', ['5']])
    expect(geoCalls).toHaveLength(0)
    expect(card?.state).toEqual({ key: 'review', label: 'In review', color: '#f59e0b' })
    expect(card?.sla).toBe('warning')
    // Redacted people read as the tile names them; inactive people stay marked.
    expect(card?.owners).toEqual([
      { id: 'u1', name: 'Beth Smith' },
      { id: 'u2', name: 'Former user', inactive: 'former' }
    ])
  })

  it('no pipeline, no SLA rule: no step and no SLA, never a guess', async () => {
    readOneResult = { id: 5 }
    instance = undefined
    ownersAnswer = {}
    slaAnswer = {}
    const card = await recordCard(user, 'orders', '5')
    expect(card).toMatchObject({ state: null, sla: null, owners: [] })
  })

  it('no card for a record the viewer cannot read (readOne answers null)', async () => {
    readOneResult = null
    expect(await recordCard(user, 'orders', '5')).toBeNull()
    expect(readOneCalls[0]?.[0]).toBe(user)
  })

  it('no card when the read is refused (403/404)', async () => {
    readOneError = { statusCode: 403 }
    expect(await recordCard(user, 'orders', '5')).toBeNull()
    readOneError = { statusCode: 404 }
    expect(await recordCard(user, 'orders', '5')).toBeNull()
  })

  it('never reads system tables', async () => {
    readOneResult = { id: 1 }
    expect(await recordCard(user, 'nivaro_users', '1')).toBeNull()
    expect(await recordCard(user, 'directus_files', '1')).toBeNull()
    expect(readOneCalls).toHaveLength(0)
  })

  it('a readable record: name, step, owners, and only the amounts the viewer’s read returned', async () => {
    // secret_cost is not in the row: the viewer's field list left it out.
    readOneResult = { id: 5, number: 'PO-5', total: '120.5', tax_amount: 10, line_count: 3 }
    const card = await recordCard(user, 'orders', '5')
    expect(card).toMatchObject({
      title: 'PO-5 · 120.5',
      collection_label: 'Order',
      state: { label: 'In review' },
      owners: [{ name: 'Beth Smith' }, { name: 'Former user' }]
    })
    expect(card?.amounts.map((a) => a.field)).toEqual(['total', 'tax_amount'])
    expect(card?.amounts[0]).toMatchObject({ label: 'Order total', value: 120.5, money: true })
  })
})

describe('pickCardAmounts / templateFieldNames', () => {
  it('reads the template’s top-level field names', () => {
    expect(templateFieldNames('{{number}} - {{project.name}} {{ number }}')).toEqual([
      'number',
      'project'
    ])
  })
  it('template amounts first, at most three, skipping counts and ids', () => {
    const out = pickCardAmounts(
      { a_total: 1, b_cost: 2, c_price: 3, qty: 4, line_count: 9, vendor_id: 7 },
      [
        { field: 'a_total', type: 'decimal' },
        { field: 'b_cost', type: 'decimal' },
        { field: 'c_price', type: 'decimal' },
        { field: 'qty', type: 'integer' },
        { field: 'line_count', type: 'integer' },
        { field: 'vendor_id', type: 'integer' }
      ],
      '{{qty}}'
    )
    expect(out.map((a) => a.field)).toEqual(['qty', 'a_total', 'b_cost'])
  })
})
