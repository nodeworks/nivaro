import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'

// Hub shared deployments: mail retry, the live SLA flip pass and the cumulative-flow rollup run per
// app. Nivaro Cloud keeps refusing all three; self-hosted is unchanged.

const distinct = vi.hoisted(() => vi.fn(async () => [] as unknown[]))
vi.mock('../../../db/index.js', () => ({
  db: () => ({ distinct }),
  _backgroundDb: null,
  _staticDb: null
}))

const { mailRetryEnabled } = await import('../../../services/mail-retry-state.js')
const { runSlaFlipPass } = await import('../../../services/sla-flips.js')
const { runCfdRollup } = await import('../../../services/cumulative-flow.js')
const { liveCollectionsFrom } = await import('../../../services/live-collections.js')

const SHARED = { HUB_SHARED_DEPLOYMENT: 'shared-a', HUB_URL: 'https://hub.example' }
const KEYS = ['CLOUD_META_DB_URL', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'MAIL_RETRY']
const saved = { ...process.env }
function useEnv(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
}
beforeEach(() => {
  useEnv({})
  distinct.mockClear()
})
afterEach(() => {
  process.env = { ...saved }
})

const fakeKnex = {} as Knex
function inApp<T>(app: string, fn: () => T): T {
  let out!: T
  runWithTenantDb(
    fakeKnex,
    app,
    () => {
      out = fn()
    },
    app
  )
  return out
}

describe('mailRetryEnabled', () => {
  it('is on shared, off in cloud, off with MAIL_RETRY=off', () => {
    useEnv(SHARED)
    expect(mailRetryEnabled()).toBe(true)
    process.env.MAIL_RETRY = 'off'
    expect(mailRetryEnabled()).toBe(false)
    useEnv({ CLOUD_META_DB_URL: 'postgres://meta/x' })
    expect(mailRetryEnabled()).toBe(false)
    useEnv({})
    expect(mailRetryEnabled()).toBe(true)
  })
})

describe('cumulative-flow rollup', () => {
  const redis = {} as never
  it('runs on shared, refuses in cloud', async () => {
    useEnv(SHARED)
    await runCfdRollup(redis)
    expect(distinct).toHaveBeenCalledTimes(1)
    distinct.mockClear()
    useEnv({ CLOUD_META_DB_URL: 'postgres://meta/x' })
    expect(await runCfdRollup(redis)).toEqual({ stored: 0 })
    expect(distinct).not.toHaveBeenCalled()
  })
})

describe('live SLA flips per app', () => {
  const NOW = 10_000 * 60_000
  const mk = (announce: Array<[string, string]>) => ({
    liveCollections: () => null,
    slaCollections: async () => ['orders'],
    loadDeadlines: async () => [
      { collection: 'orders', item: '7', warning_at: null, due_at: NOW - 60_000 }
    ],
    announce: (c: string, i: string) => announce.push([c, i]),
    now: () => NOW
  })

  it('A announced crossings never silence B (same collection, same record id)', async () => {
    useEnv(SHARED)
    const a: Array<[string, string]> = []
    const b: Array<[string, string]> = []
    expect(await inApp('A', () => runSlaFlipPass(mk(a)))).toEqual({ collections: 1, announced: 1 })
    // A's second tick: already announced
    expect(await inApp('A', () => runSlaFlipPass(mk(a)))).toEqual({ collections: 1, announced: 0 })
    // B's pass starts empty and announces its own copy of the same crossing
    expect(await inApp('B', () => runSlaFlipPass(mk(b)))).toEqual({ collections: 1, announced: 1 })
    expect(a).toEqual([['orders', '7']])
    expect(b).toEqual([['orders', '7']])
  })

  it('cloud still returns at once', async () => {
    useEnv({ CLOUD_META_DB_URL: 'postgres://meta/x' })
    const a: Array<[string, string]> = []
    expect(await runSlaFlipPass(mk(a))).toEqual({ collections: 0, announced: 0 })
    expect(a).toEqual([])
  })
})

describe('liveCollectionsFrom with an app key', () => {
  it('keeps only that app rooms', () => {
    const rooms = ['t:A:collection:orders', 't:B:collection:tickets', 't:A:record:invoices:3']
    expect([...liveCollectionsFrom(rooms, 'A')].sort()).toEqual(['invoices', 'orders'])
    expect([...liveCollectionsFrom(rooms, 'B')]).toEqual(['tickets'])
    expect([...liveCollectionsFrom(rooms)].sort()).toEqual(['invoices', 'orders', 'tickets'])
  })
})
