import { afterEach, describe, expect, it, vi } from 'vitest'

const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    vi.fn((table: string) => ({
      insert: vi.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row })
        const p = Promise.resolve([{ id: 1 }])
        return Object.assign(p, { returning: vi.fn().mockResolvedValue([{ id: 1 }]) })
      })
    })),
    {
      schema: {
        hasColumn: vi.fn(async (_t: string, c: string) => c === 'chain_id' || c === 'origin')
      }
    }
  )
  return { db }
})
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => undefined }))

import { logActivity } from '../../../services/activity.js'
import { startChain, withChainStep } from '../../../services/chain.js'
import { resetChainColumnProbe } from '../../../services/chain-columns.js'
import { writeApiCallLog } from '../../../services/external-apis.js'

afterEach(() => {
  inserts.length = 0
  resetChainColumnProbe()
})

describe('central writers stamp the chain', () => {
  it('logActivity stamps chain id and open parent', async () => {
    await startChain(
      'cron:x',
      () =>
        withChainStep('history:5', () =>
          logActivity({ action: 'update', user: null, collection: 'workflows', item: '1' })
        ),
      'c-a'
    )
    const row = inserts.find((i) => i.table === 'nivaro_activity')?.row
    expect(row).toMatchObject({ chain_id: 'c-a', chain_parent: 'history:5' })
  })

  it('logActivity outside a chain writes no chain columns', async () => {
    await logActivity({ action: 'update', user: null })
    const row = inserts.find((i) => i.table === 'nivaro_activity')?.row
    expect(row).not.toHaveProperty('chain_id')
  })

  it('writeApiCallLog stamps the chain', async () => {
    await startChain(
      'cron:x',
      () => writeApiCallLog({ api_id: 1, triggered_by: 'test', method: 'POST', url: 'https://x' }),
      'c-b'
    )
    const row = inserts.find((i) => i.table === 'nivaro_external_api_logs')?.row
    expect(row).toMatchObject({ chain_id: 'c-b', chain_parent: 'cron:x' })
  })
})
