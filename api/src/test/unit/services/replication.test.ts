import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import {
  bustReplicationCache,
  isReplicatedArticle,
  isReplicatedProcedure
} from '../../../services/replication.js'

describe('isReplicatedArticle', () => {
  const original = (db as any).client
  beforeEach(() => {
    ;(db as any).client = { config: { client: 'mssql' } }
  })
  afterEach(() => {
    ;(db as any).client = original
    vi.clearAllMocks()
    bustReplicationCache()
  })
  it('is false when the catalog query throws (not a publisher)', async () => {
    vi.mocked(db.raw).mockRejectedValueOnce(new Error('Invalid object name sysarticles'))
    expect(await isReplicatedArticle('workflows')).toBe(false)
  })
  it('is true when an article row exists, and caches', async () => {
    vi.mocked(db.raw).mockResolvedValueOnce([{ n: 1 }] as never)
    expect(await isReplicatedArticle('workflows')).toBe(true)
    expect(await isReplicatedArticle('workflows')).toBe(true)
    expect(vi.mocked(db.raw)).toHaveBeenCalledTimes(1)
  })
  it('does not cache a failed lookup', async () => {
    vi.mocked(db.raw)
      .mockRejectedValueOnce(new Error('pool blip'))
      .mockResolvedValueOnce([{ n: 1 }] as never)
    expect(await isReplicatedArticle('workflows')).toBe(false)
    expect(await isReplicatedArticle('workflows')).toBe(true)
    expect(vi.mocked(db.raw)).toHaveBeenCalledTimes(2)
  })
  it('tables and procedures use different article types', async () => {
    vi.mocked(db.raw).mockResolvedValue([{ n: 0 }] as never)
    await isReplicatedArticle('thing')
    await isReplicatedProcedure('thing')
    const sqls = vi.mocked(db.raw).mock.calls.map((c) => String(c[0]))
    expect(sqls[0]).toContain('IN (1, 3, 5, 7)')
    expect(sqls[1]).toContain('IN (8, 24, 32)')
  })
  it('refuses a non-identifier without touching the database', async () => {
    expect(await isReplicatedArticle('x; drop')).toBe(false)
    expect(vi.mocked(db.raw)).not.toHaveBeenCalled()
  })
})
