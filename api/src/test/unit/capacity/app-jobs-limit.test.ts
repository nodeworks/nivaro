import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub capacity, idea 15: an app's `jobs` limit holds across every fan-out of the per-app job
// runner — a turn past it waits for one of the app's slots, then is skipped ('app_limit').

vi.mock('../../../db/tenant-context.js', async (orig) => ({
  ...(await orig<typeof import('../../../db/tenant-context.js')>()),
  withTenant: async (_t: unknown, fn: () => Promise<unknown>) => fn()
}))

const { forEachApp } = await import('../../../services/app-jobs.js')
const enforce = await import('../../../services/capacity/enforce.js')

import type { TenantRecord } from '../../../services/tenancy/types.js'

const t = (id: string, jobs?: number): TenantRecord => ({
  id,
  slug: id,
  name: id,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://x/${id}`,
  poolMax: null,
  hostnames: [`${id}.x`],
  ...(jobs ? { limits: { jobs } } : {})
})

afterEach(() => {
  enforce._resetEnforceForTests()
  enforce._setJobSlotWaitForTests(5 * 60_000)
})

describe('forEachApp with job limits', () => {
  it('two fan-outs over an app limited to one job run its turns one after the other', async () => {
    let running = 0
    let peak = 0
    const work = async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return 'ran' as const
    }
    const list = async () => [t('one', 1)]
    const [a, b] = await Promise.all([
      forEachApp(work, { listActive: list }),
      forEachApp(work, { listActive: list })
    ])
    expect(peak).toBe(1)
    expect([...a.ran, ...b.ran]).toEqual(['one', 'one'])
  })

  it('a turn that finds no slot in time is skipped as app_limit; others carry on', async () => {
    enforce._setJobSlotWaitForTests(15)
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const long = forEachApp(
      async () => {
        await held
        return 'ran' as const
      },
      { listActive: async () => [t('busy', 1)] }
    )
    await new Promise((r) => setTimeout(r, 5))
    const second = await forEachApp(async () => 'ran' as const, {
      listActive: async () => [t('busy', 1), t('free')]
    })
    expect(second.skipped).toEqual([{ tenant: 'busy', why: 'app_limit' }])
    expect(second.ran).toEqual(['free'])
    release()
    expect((await long).ran).toEqual(['busy'])
    expect(enforce.appJobCounts('busy')).toEqual({ running: 0, waiting: 0 })
  })
})
