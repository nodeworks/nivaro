import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 8 review M6: the alerts "Now X" reading ran each custom query as the viewer
// with no cache and no heavy read gate. `shared` reads the execute route's own cache
// entry and runs a miss through sharedGatedRead on the same key.
const fake = vi.hoisted(() => ({
  redisGet: vi.fn(async (_k: string) => null as string | null),
  setex: vi.fn(async () => 'OK'),
  gated: vi.fn(async (_key: string, _who: string, _fn: () => Promise<unknown>) => ({
    value: { rows: [{ n: 5 }], cachedAt: '2026-11-07T00:00:00Z' },
    shared: false,
    waitedMs: 0
  }))
}))

vi.mock('../../../db/index.js', () => ({
  db: () => ({
    where: () => ({
      first: async () => ({
        id: 1,
        slug: 'past-due',
        sql_text: 'SELECT 1 AS n',
        params: null,
        cache_ttl: 300,
        enabled: true,
        access: 'authenticated',
        scope_params: null
      })
    })
  })
}))
vi.mock('../../../services/custom-query-scope.js', () => ({
  applyScopeParams: async (_s: unknown, params: Record<string, unknown>) => {
    params.zones = 'Z1'
  }
}))
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({ redis: { get: fake.redisGet, setex: fake.setex } })
}))
vi.mock('../../../services/read-gate.js', () => ({ sharedGatedRead: fake.gated }))

import { customQueryCacheKey } from '../../../services/custom-query-cache.js'
import { runCustomQueryAsUser } from '../../../services/custom-query-exec.js'

const user = { id: 'u-1' }
const def = { sql_text: 'SELECT 1 AS n', scope_params: null }

describe('runCustomQueryAsUser — shared mode', () => {
  beforeEach(() => {
    fake.redisGet.mockClear()
    fake.gated.mockClear()
  })

  it('a cached entry (key built after scope injection) answers without a run', async () => {
    fake.redisGet.mockResolvedValueOnce(JSON.stringify({ cached_at: 'x', rows: [{ n: 9 }] }))
    const rows = await runCustomQueryAsUser('past-due', {}, user, false, { shared: {} })
    expect(rows).toEqual([{ n: 9 }])
    expect(fake.redisGet).toHaveBeenCalledWith(
      customQueryCacheKey('past-due', { zones: 'Z1' }, def)
    )
    expect(fake.gated).not.toHaveBeenCalled()
  })

  it('a miss runs through the heavy read gate on the same key, as the viewer', async () => {
    const rows = await runCustomQueryAsUser('past-due', {}, user, false, {
      shared: { who: 'u-1', label: 'metric:past-due' }
    })
    expect(rows).toEqual([{ n: 5 }])
    const [key, who] = fake.gated.mock.calls[0]
    expect(key).toBe(customQueryCacheKey('past-due', { zones: 'Z1' }, def))
    expect(who).toBe('u-1')
  })
})
