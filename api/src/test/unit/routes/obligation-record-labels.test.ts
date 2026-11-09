import { describe, expect, it, vi } from 'vitest'
import { obligationRecordLabels } from '../../../routes/integration-obligations.js'

describe('obligationRecordLabels — the board names records by business id', () => {
  it('batches one lookup per collection and keys labels by collection:item', async () => {
    const resolve = vi.fn(async (collection: string, ids: string[]) => {
      const m = new Map<string, string>()
      for (const id of ids) m.set(id, collection === 'workflows' ? `PW26-${id}` : id)
      return m
    })
    const labels = await obligationRecordLabels(
      [
        { collection: 'workflows', item: '81102' },
        { collection: 'workflows', item: '81103' },
        { collection: 'workflows', item: '81102' },
        { collection: 'inventory_request', item: '37838' },
        // An inbound kind's bucket is not a record — never looked up.
        { collection: 'nivaro_api_logs', item: '/graphql@2026-11-08T18' }
      ],
      resolve
    )
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenCalledWith('workflows', ['81102', '81103'])
    expect(labels.get('workflows:81102')).toBe('PW26-81102')
    // A label that is just the id is no label (the board then says the record kind instead).
    expect(labels.has('inventory_request:37838')).toBe(false)
    expect(labels.has('nivaro_api_logs:/graphql@2026-11-08T18')).toBe(false)
  })

  it('a failing lookup leaves the rows unlabelled rather than failing the board', async () => {
    const labels = await obligationRecordLabels(
      [{ collection: 'workflows', item: '1' }],
      async () => {
        throw new Error('down')
      }
    )
    expect(labels.size).toBe(0)
  })
})
