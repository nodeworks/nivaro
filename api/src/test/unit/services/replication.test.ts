import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { bustReplicationCache, isReplicatedArticle } from '../../../services/replication.js'

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
  it('refuses a non-identifier without touching the database', async () => {
    expect(await isReplicatedArticle('x; drop')).toBe(false)
    expect(vi.mocked(db.raw)).not.toHaveBeenCalled()
  })
})
