import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: { schema: { hasColumn: vi.fn() } }
}))
const tenant: { id: string | undefined } = { id: undefined }
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => tenant.id }))

import { db } from '../../../db/index.js'
import {
  requesterInsertFields,
  requesterSelectColumns,
  resetRequesterColumnProbe
} from '../../../services/erp-requester-columns.js'

type SchemaDb = { schema: { hasColumn: ReturnType<typeof vi.fn> } }
const hasColumn = () => (db as unknown as SchemaDb).schema.hasColumn as ReturnType<typeof vi.fn>

afterEach(() => {
  tenant.id = undefined
  resetRequesterColumnProbe()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('requesterInsertFields', () => {
  it('returns {} when the columns are missing — an insert must never name them', async () => {
    hasColumn().mockResolvedValue(false)
    expect(await requesterInsertFields('nivaro_erp_submissions', 'user-1', 'transition')).toEqual(
      {}
    )
  })

  it('returns {} when the probe itself throws (a stricter dialect, a closed connection…)', async () => {
    hasColumn().mockRejectedValue(new Error('boom'))
    expect(await requesterInsertFields('nivaro_erp_submissions', 'user-1', 'transition')).toEqual(
      {}
    )
  })

  it('spreads both fields — defaulting an absent requestedBy to null — once the column exists', async () => {
    hasColumn().mockResolvedValue(true)
    expect(await requesterInsertFields('nivaro_erp_submissions', 'user-1', 'transition')).toEqual({
      requested_by: 'user-1',
      requested_via: 'transition'
    })
    resetRequesterColumnProbe()
    hasColumn().mockResolvedValue(true)
    expect(await requesterInsertFields('nivaro_erp_submissions', undefined, 'cron')).toEqual({
      requested_by: null,
      requested_via: 'cron'
    })
  })

  it('probes each table once per process — a second call never re-queries', async () => {
    hasColumn().mockResolvedValue(true)
    await requesterInsertFields('nivaro_erp_submissions', 'a', 'api')
    await requesterInsertFields('nivaro_erp_submissions', 'b', 'api')
    expect(hasColumn()).toHaveBeenCalledTimes(1)
  })

  it('probes the two tables independently', async () => {
    hasColumn().mockResolvedValue(true)
    await requesterInsertFields('nivaro_erp_submissions', 'a', 'api')
    await requesterInsertFields('nivaro_erp_submission_attempts', 'a', 'api')
    expect(hasColumn()).toHaveBeenCalledTimes(2)
    expect(hasColumn()).toHaveBeenNthCalledWith(1, 'nivaro_erp_submissions', 'requested_by')
    expect(hasColumn()).toHaveBeenNthCalledWith(2, 'nivaro_erp_submission_attempts', 'requested_by')
  })

  it('re-probes a miss after a minute, but not before', async () => {
    vi.useFakeTimers()
    hasColumn().mockResolvedValue(false)
    expect(await requesterInsertFields('nivaro_erp_submissions', 'a', 'api')).toEqual({})
    await vi.advanceTimersByTimeAsync(59_000)
    expect(await requesterInsertFields('nivaro_erp_submissions', 'a', 'api')).toEqual({})
    expect(hasColumn()).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    hasColumn().mockResolvedValue(true)
    expect(await requesterInsertFields('nivaro_erp_submissions', 'a', 'api')).toEqual({
      requested_by: 'a',
      requested_via: 'api'
    })
    expect(hasColumn()).toHaveBeenCalledTimes(2)
  })

  it('never re-probes once the column is found — a hit is permanent', async () => {
    vi.useFakeTimers()
    hasColumn().mockResolvedValue(true)
    await requesterInsertFields('nivaro_erp_submissions', 'a', 'api')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await requesterInsertFields('nivaro_erp_submissions', 'a', 'api')
    expect(hasColumn()).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent probes of the same table into one query', async () => {
    let resolveHasColumn: (v: boolean) => void = () => {}
    hasColumn().mockReturnValue(
      new Promise((resolve) => {
        resolveHasColumn = resolve
      })
    )
    const p1 = requesterInsertFields('nivaro_erp_submissions', 'a', 'api')
    const p2 = requesterInsertFields('nivaro_erp_submissions', 'b', 'api')
    resolveHasColumn(true)
    await Promise.all([p1, p2])
    expect(hasColumn()).toHaveBeenCalledTimes(1)
  })
})

describe('requesterSelectColumns', () => {
  it('names the two columns once they exist, [] otherwise', async () => {
    hasColumn().mockResolvedValue(false)
    expect(await requesterSelectColumns('nivaro_erp_submissions')).toEqual([])
    resetRequesterColumnProbe()
    hasColumn().mockResolvedValue(true)
    expect(await requesterSelectColumns('nivaro_erp_submissions')).toEqual([
      'requested_by',
      'requested_via'
    ])
  })
})

describe('per tenant', () => {
  it("one tenant's migrated table never makes another, un-migrated tenant name the columns", async () => {
    tenant.id = 'tenant-a'
    hasColumn().mockResolvedValue(true)
    expect(await requesterSelectColumns('nivaro_erp_submissions')).toHaveLength(2)
    tenant.id = 'tenant-b'
    hasColumn().mockResolvedValue(false)
    expect(await requesterSelectColumns('nivaro_erp_submissions')).toEqual([])
    tenant.id = 'tenant-a'
    expect(await requesterSelectColumns('nivaro_erp_submissions')).toHaveLength(2)
    expect(hasColumn()).toHaveBeenCalledTimes(2)
  })
})
