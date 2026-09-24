import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: { schema: { hasColumn: vi.fn() } } }))
const tenant: { id: string | undefined } = { id: undefined }
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => tenant.id }))

import { db } from '../../../db/index.js'
import { startChain, withChainStep } from '../../../services/chain.js'
import {
  chainFields,
  hasChainColumns,
  resetChainColumnProbe
} from '../../../services/chain-columns.js'

type SchemaDb = { schema: { hasColumn: ReturnType<typeof vi.fn> } }
const hasColumn = () => (db as unknown as SchemaDb).schema.hasColumn

afterEach(() => {
  tenant.id = undefined
  resetChainColumnProbe()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('chainFields', () => {
  it('returns {} outside a chain without probing', async () => {
    expect(await chainFields('nivaro_activity')).toEqual({})
    expect(hasColumn()).not.toHaveBeenCalled()
  })

  it('stamps chain id and open parent when the column exists', async () => {
    hasColumn().mockResolvedValue(true)
    const out = await startChain(
      'cron:x',
      () => withChainStep('history:9', () => chainFields('nivaro_activity')),
      'c-1'
    )
    expect(out).toEqual({ chain_id: 'c-1', chain_parent: 'history:9' })
  })

  it('an explicit parent overrides the open one', async () => {
    hasColumn().mockResolvedValue(true)
    const out = await startChain(
      'cron:x',
      () => chainFields('nivaro_erp_submission_attempts', { parent: 'submission:4' }),
      'c-2'
    )
    expect(out).toEqual({ chain_id: 'c-2', chain_parent: 'submission:4' })
  })

  it('returns {} when the tenant has not migrated (probe miss)', async () => {
    hasColumn().mockResolvedValue(false)
    const out = await startChain('cron:x', () => chainFields('nivaro_activity'))
    expect(out).toEqual({})
  })

  it('a probe that throws counts as a miss', async () => {
    hasColumn().mockRejectedValue(new Error('down'))
    expect(await startChain('cron:x', () => chainFields('nivaro_activity'))).toEqual({})
  })

  it('caches a hit per tenant and table', async () => {
    hasColumn().mockResolvedValue(true)
    await hasChainColumns('nivaro_activity')
    await hasChainColumns('nivaro_activity')
    expect(hasColumn()).toHaveBeenCalledTimes(1)
    tenant.id = 't2'
    await hasChainColumns('nivaro_activity')
    expect(hasColumn()).toHaveBeenCalledTimes(2)
  })

  it('re-probes a miss after 60 s', async () => {
    vi.useFakeTimers()
    hasColumn().mockResolvedValue(false)
    await hasChainColumns('nivaro_flow_runs')
    vi.advanceTimersByTime(61_000)
    hasColumn().mockResolvedValue(true)
    expect(await hasChainColumns('nivaro_flow_runs')).toBe(true)
  })
})
