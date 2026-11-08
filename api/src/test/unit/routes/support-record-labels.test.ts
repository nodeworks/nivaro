import { describe, expect, it, vi } from 'vitest'

// Army 9 b16: /support named a purchase order by its row id "134946". Fable L9: one failed
// batch lookup must not rename every record of the collection.

const h = vi.hoisted(() => ({ batchFails: false }))

vi.mock('../../../config.js', () => ({
  config: { NODE_ENV: 'test', PUBLIC_URL: 'http://x', ADMIN_URL: 'http://x' }
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async () => ({ display_name: 'Purchase Orders' }))
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyIds: vi.fn(async (_c: string, ids: string[]) => {
    if (h.batchFails) throw new Error('boom')
    return new Map(ids.map((i) => [i, i === '134946' ? '2971054' : i]))
  }),
  resolveFriendlyId: vi.fn(async (_c: string, i: string) => (i === '134946' ? '2971054' : i))
}))

import { recordLabels } from '../../../routes/support.js'

const rows = [
  { collection: 'purchase_orders', item: '134946' },
  { collection: 'purchase_orders', item: '9' }
] as never

describe('support recordLabels', () => {
  it('names a record by its number, else by its type — never the row id', async () => {
    h.batchFails = false
    const out = await recordLabels(rows)
    expect(out.get('purchase_orders:134946')).toBe('2971054')
    expect(out.get('purchase_orders:9')).toBe('Purchase Order')
  })
  it('asks each id on its own when the batch fails', async () => {
    h.batchFails = true
    const out = await recordLabels(rows)
    expect(out.get('purchase_orders:134946')).toBe('2971054')
    expect(out.get('purchase_orders:9')).toBe('Purchase Order')
  })
})
