import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Unused files list and the purge use config review's full reference
// check (orphanFiles), not the foreign-key-only scan they used before.

const scan = vi.hoisted(() => ({
  calls: [] as Date[],
  rows: [] as Array<{ id: string; uploaded_on: Date }>,
  fail: false
}))

vi.mock('../../../services/config-review/checks.js', () => ({
  FILE_MIN_AGE_DAYS: 30,
  orphanFiles: vi.fn(async (cutoff: Date) => {
    scan.calls.push(cutoff)
    if (scan.fail) throw new Error('a reference source could not be read')
    return scan.rows
  })
}))

vi.mock('../../../db/index.js', () => {
  const db = (_table: string) => {
    let ids: string[] = []
    const q = {
      whereIn: (_col: string, v: string[]) => {
        ids = v
        return q
      },
      select: async () =>
        ids.map((id) => ({ id: id.toUpperCase(), filename_download: `${id}.pdf` }))
    }
    return q
  }
  return { db }
})

vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => null }))

const { findOrphanFiles, forgetUnusedFiles } = await import('../../../services/file-usage.js')

describe('findOrphanFiles (full reference check)', () => {
  beforeEach(() => {
    forgetUnusedFiles()
    scan.calls = []
    scan.fail = false
    scan.rows = [
      { id: 'a', uploaded_on: new Date('2026-01-01') },
      { id: 'b', uploaded_on: new Date('2026-02-01') },
      { id: 'c', uploaded_on: new Date('2026-03-01') }
    ]
  })

  it('lists only what orphanFiles returns, newest first, with a 30-day cutoff', async () => {
    const before = Date.now()
    const res = await findOrphanFiles({ limit: 2 })
    expect(res.total).toBe(3)
    expect(res.data.map((r) => String(r.id).toLowerCase())).toEqual(['c', 'b'])
    const cutoff = scan.calls[0].getTime()
    expect(before - cutoff).toBeGreaterThanOrEqual(30 * 86_400_000 - 1000)
  })

  it('reuses the cached scan for pages, and rescans when asked fresh', async () => {
    await findOrphanFiles({ limit: 1 })
    await findOrphanFiles({ limit: 1, offset: 1 })
    expect(scan.calls).toHaveLength(1)
    await findOrphanFiles({ limit: 1, fresh: true })
    expect(scan.calls).toHaveLength(2)
  })

  it('fails closed: a scan error throws instead of listing anything', async () => {
    scan.fail = true
    await expect(findOrphanFiles({ fresh: true })).rejects.toThrow()
  })
})
