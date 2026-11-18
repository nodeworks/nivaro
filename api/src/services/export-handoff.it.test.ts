import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The export hand-off scripts against a REAL Redis (fix round 2) — only with EXPORT_REDIS_IT=1
 * (or CHAOS_REDIS_IT=1), and never on database 0: `EXPORT_REDIS_IT_URL` (default
 * redis://localhost:6379/9). Keys carry the prefix `export-it:` and are deleted afterwards.
 * Every script names all its keys in KEYS (Redis Cluster / Dragonfly would refuse otherwise).
 */
const URL =
  process.env.EXPORT_REDIS_IT_URL ?? process.env.CHAOS_REDIS_IT_URL ?? 'redis://localhost:6379/9'
const run = process.env.EXPORT_REDIS_IT === '1' || process.env.CHAOS_REDIS_IT === '1'

describe.skipIf(!run)('export hand-off scripts on a real Redis', () => {
  let redis: Redis
  let h: typeof import('./export-handoff.js')

  const job = (runId: number, extra: Record<string, unknown> = {}) => ({
    v: 1 as const,
    run_id: runId,
    kind: 'items' as const,
    subject: 'units',
    label: 'Exporting Units',
    user_id: 'u-1',
    workspace_id: null,
    params: { q: {} },
    total: null,
    slot: 0,
    slot_owner: 'o',
    started_at: Date.now(),
    ...extra
  })

  beforeAll(async () => {
    process.env.REDIS_CHANNEL_PREFIX = 'export-it:'
    redis = new Redis(URL, { maxRetriesPerRequest: 1 })
    const db = Number((redis.options as { db?: number }).db ?? 0)
    if (db === 0) throw new Error('refusing to run on Redis db 0')
    h = await import('./export-handoff.js')
  })
  const cleanup = async () => {
    const keys = await redis.keys('export-it:*')
    if (keys.length) await redis.del(...keys)
  }
  beforeEach(cleanup)
  afterAll(async () => {
    await cleanup()
    redis.disconnect()
    delete process.env.REDIS_CHANNEL_PREFIX
  })

  it('claims atomically: off the list, lease and claim written in one script', async () => {
    const r = h.asExportRedis(redis)!
    await h.enqueueExport(r, job(11))
    const got = await h.claimNextExport(r, 'proc-a')
    expect(got).toMatchObject({ job: { run_id: 11 } })
    expect(await redis.llen(h.exportQueueKey())).toBe(0)
    expect(h.parseExportJob(await redis.hget(h.exportClaimedKey(), '11'))).toMatchObject({
      run_id: 11
    })
    expect(h.parseLease(await redis.hget(h.exportLeasesKey(), '11'))).toMatchObject({
      by: 'proc-a'
    })
    expect(await h.claimNextExport(r, 'proc-a')).toBeNull()
  })

  it('another version’s entry is popped unclaimed and named by its run id', async () => {
    const r = h.asExportRedis(redis)!
    await redis.rpush(h.exportQueueKey(), JSON.stringify({ v: 2, run_id: 12, spec: {} }))
    await redis.rpush(h.exportQueueKey(), 'not json')
    expect(await h.claimNextExport(r, 'proc-a')).toMatchObject({ invalidRunId: 12 })
    expect(await h.claimNextExport(r, 'proc-a')).toMatchObject({ invalidRunId: null })
    expect(await redis.hlen(h.exportClaimedKey())).toBe(0)
    expect(await redis.hlen(h.exportLeasesKey())).toBe(0)
  })

  it('renew and release only for the owner; a lost claim is released exactly as found', async () => {
    const r = h.asExportRedis(redis)!
    await h.enqueueExport(r, job(13))
    await h.claimNextExport(r, 'proc-a')
    expect(await h.renewExportLease(r, 13, 'proc-b')).toBe(false)
    expect(await h.renewExportLease(r, 13, 'proc-a')).toBe(true)
    expect(await h.releaseExportClaim(r, 13, 'proc-b')).toBe(false)
    expect(await redis.hexists(h.exportClaimedKey(), '13')).toBe(1)
    // Its lease ran out: found lost, released only while the lease is still the one read.
    await redis.hset(h.exportLeasesKey(), '13', 'proc-a|1')
    const lost = await h.lostExportClaims(r, new Set())
    expect(lost.map((l) => l.runId)).toEqual([13])
    await redis.hset(h.exportLeasesKey(), '13', h.leaseValue('proc-a'))
    expect(await h.releaseLostExportClaim(r, 13, lost[0].lease)).toBe(false)
    expect(await h.releaseExportClaim(r, 13, 'proc-a')).toBe(true)
    expect(await redis.hexists(h.exportClaimedKey(), '13')).toBe(0)
    expect(await redis.hexists(h.exportLeasesKey(), '13')).toBe(0)
  })
})
