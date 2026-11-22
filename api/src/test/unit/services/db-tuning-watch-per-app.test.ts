import { describe, expect, it, vi } from 'vitest'

// Review Minor 4: stuckClaims() keeps "first seen with no run" clocks per claim. On a Hub
// shared deployment the watch job runs once per app, so a process-wide map let app A's pass
// delete app B's clocks (B's stuck claims were never found) and mixed proposal ids across apps.

const lists = vi.hoisted(() => ({ byApp: {} as Record<string, unknown[]> }))
vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/db-tuning/ledger.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  return {
    getProposal: async () => null,
    updateProposal: async () => null,
    listProposals: async () => lists.byApp[getTenantId() ?? ''] ?? []
  }
})

const { stuckClaims } = await import('../../../services/db-tuning/watch.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

const inApp = <T>(id: string, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as never, id, () => void fn().then(resolve, reject), id)
  )

describe('db-tuning stuck-claim clocks are per app', () => {
  it("app A's pass never resets app B's clock for the same proposal id", async () => {
    const claim = { id: 7, run_id: null, status: 'applying' }
    lists.byApp.A = [claim]
    lists.byApp.B = [claim]
    const t0 = 1_800_000_000_000
    expect(await inApp('B', () => stuckClaims(t0))).toEqual([])
    // A no longer has the claim: its pass forgets A's clock only
    lists.byApp.A = []
    await inApp('A', () => stuckClaims(t0 + 1000))
    // B's clock started at t0: well past the stuck window it is reported
    const later = await inApp('B', () => stuckClaims(t0 + 24 * 3_600_000))
    expect(later.map((x) => [x.row.id, x.job])).toEqual([[7, 'apply or rollback']])
  })
})
