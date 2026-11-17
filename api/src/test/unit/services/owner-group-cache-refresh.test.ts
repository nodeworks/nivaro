import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// EFP prod 2026-11-16: the owner-group matrix read (COMPRESS … FOR JSON, 1.0-1.3 s, ~10k reads,
// up to 5.3 s) ran ~1,500 times in four hours across seven processes — a 60 s TTL, and the
// stale-while-revalidate refresh ran inside the request that found the entry expired, on the
// request pool, beside /api/my-work's slow bursts. The refresh now runs on the background pool,
// and the TTL is a 10-minute backstop (edits clear every process through the config epoch).

const fetches = vi.hoisted(() => [] as Array<{ pool: string; states: string[] }>)

vi.mock('../../../db/index.js', async () => {
  const { requestedPool } = await import('../../../db/pool-context.js')
  const db = Object.assign(
    (table: string) => {
      let states: string[] = []
      const q = {
        whereIn: (_c: string, ids: string[]) => {
          states = ids
          return q
        },
        orderBy: () => q,
        // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
        then: (ok: (rows: unknown[]) => unknown, bad?: (e: unknown) => unknown) => {
          fetches.push({ pool: requestedPool(), states })
          const rows =
            table === 'nivaro_pipeline_owner_groups'
              ? states.map((s) => ({ id: `g-${s}`, state: s, sort: 1, is_default: true }))
              : []
          return Promise.resolve(rows).then(ok, bad)
        }
      }
      return q
    },
    {
      // No COMPRESS here: the read falls back to the plain select.
      raw: async () => {
        throw new Error('no COMPRESS in this test')
      }
    }
  )
  return { db, dbRead: db, isMssql: () => true }
})

import { db } from '../../../db/index.js'
import {
  bustOwnerGroupCache,
  getOwnerGroupsForStates,
  OWNER_GROUP_CACHE_TTL,
  ownerGroupRefreshInFlight
} from '../../../services/pipeline-engine.js'

beforeEach(() => {
  fetches.length = 0
  bustOwnerGroupCache()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('owner-group cache', () => {
  it('a minute later (the old TTL) the matrix is not read again', async () => {
    await getOwnerGroupsForStates(['s1'], db)
    expect(fetches).toHaveLength(1)
    vi.setSystemTime(Date.now() + 61_000)
    const hit = await getOwnerGroupsForStates(['s1'], db)
    expect(hit.get('s1')?.groups).toHaveLength(1)
    expect(ownerGroupRefreshInFlight()).toBeNull()
    expect(fetches).toHaveLength(1)
    expect(OWNER_GROUP_CACHE_TTL).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it('an expired entry is served at once and refreshed behind the request on the background pool', async () => {
    await getOwnerGroupsForStates(['s1', 's2'], db)
    expect(fetches.map((f) => f.pool)).toEqual(['main'])
    vi.setSystemTime(Date.now() + OWNER_GROUP_CACHE_TTL + 1)
    const stale = await getOwnerGroupsForStates(['s1', 's2'], db)
    expect(stale.get('s2')?.groups).toHaveLength(1)
    await ownerGroupRefreshInFlight()
    expect(fetches).toHaveLength(2)
    expect(fetches[1]).toEqual({ pool: 'background', states: ['s1', 's2'] })
  })
})
