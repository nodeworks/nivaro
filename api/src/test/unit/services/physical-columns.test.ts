import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1224 — owner resolution leaves alias (M2M/O2M) fields out of its narrowed
// record read, using the table's real columns.
const columnInfo = vi.fn()
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ columnInfo }))
}))

import type { db } from '../../../db/index.js'
import { clearMetadataCache, getPhysicalColumns } from '../../../services/collections.js'

describe('getPhysicalColumns', () => {
  beforeEach(() => {
    clearMetadataCache()
    columnInfo.mockReset()
  })

  it('answers the real columns lower-cased, cached until metadata is cleared', async () => {
    columnInfo.mockResolvedValue({ id: {}, Project: {}, name: {} })
    const cols = await getPhysicalColumns('workflows')
    expect(cols).toEqual(new Set(['id', 'project', 'name']))
    await getPhysicalColumns('workflows')
    expect(columnInfo).toHaveBeenCalledTimes(1)
    clearMetadataCache('workflows')
    await getPhysicalColumns('workflows')
    expect(columnInfo).toHaveBeenCalledTimes(2)
  })

  it('is null when the columns cannot be read (callers keep the old path)', async () => {
    columnInfo.mockRejectedValue(new Error('no such table'))
    expect(await getPhysicalColumns('missing')).toBeNull()
    columnInfo.mockResolvedValue({})
    expect(await getPhysicalColumns('empty')).toBeNull()
  })

  it('never caches a non-default database handle', async () => {
    columnInfo.mockResolvedValue({ id: {} })
    const other = vi.fn(() => ({ columnInfo })) as unknown as typeof db
    await getPhysicalColumns('workflows', other)
    await getPhysicalColumns('workflows', other)
    expect(columnInfo).toHaveBeenCalledTimes(2)
  })
})
