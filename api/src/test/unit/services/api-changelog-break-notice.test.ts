import { describe, expect, it, vi } from 'vitest'

// army6 L53: the same "GraphQL schema change removed 170 type(s)…" notice
// reached admins after every nightly staging rebuild.

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => ({}) }) }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))

const { removedSetHash, shouldNotifyBreak } = await import('../../../services/api-changelog.js')

function fakeRedis() {
  const m = new Map<string, string>()
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => {
      m.set(k, v)
      return 'OK'
    }
  }
}

describe('schema break notices', () => {
  it('hashes only the removed lines, in any order', () => {
    expect(removedSetHash(['- type A', '+ type B', '- field X.y'])).toBe(
      removedSetHash(['- field X.y', '- type A', '+ type C'])
    )
    expect(removedSetHash(['- type A'])).not.toBe(removedSetHash(['- type B']))
  })

  it('tells admins about a removed set once; the same set again stays quiet', async () => {
    const redis = fakeRedis()
    const lines = ['- type Allocation', '- field projects.allocated_total']
    expect(await shouldNotifyBreak('graphql', lines, redis)).toBe(true)
    expect(await shouldNotifyBreak('graphql', [...lines].reverse(), redis)).toBe(false)
    // Another process (memory empty) still reads Redis.
    expect(redis.m.size).toBe(1)
  })

  it('a different removal is told again', async () => {
    const redis = fakeRedis()
    expect(await shouldNotifyBreak('rest', ['- GET /a'], redis)).toBe(true)
    expect(await shouldNotifyBreak('rest', ['- GET /b'], redis)).toBe(true)
  })
})
