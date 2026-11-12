import { describe, expect, it, vi } from 'vitest'

// army6 L53: the same "GraphQL schema change removed 170 type(s)…" notice
// reached admins after every nightly staging rebuild.

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => ({}) }) }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))

const {
  findingsHitByRemoval,
  removedKeys,
  removedSetHash,
  routesUsedByPartners,
  shouldNotifyBreak
} = await import('../../../services/api-changelog.js')

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

  // 2026-11-12: dropping the directus_* tables told every admin "removed 247
  // type(s)/field(s)" twice; nobody's integration queried any of them.
  describe('only removals a partner used are news', () => {
    const removed = removedKeys([
      '- type directus_users_filter',
      '- permissions_filter.role',
      '- Query.directus_users',
      '- categories_projects_m2m.pub_amount_follows_cars',
      '+ type ideas'
    ])
    const f = (collection: string, field: string | null, severity = 'break') => ({
      severity,
      caller: 'Fusion',
      collection,
      field,
      message: `${collection}.${field}`
    })

    it('reads the removed keys', () => {
      expect([...removed]).toEqual([
        'type directus_users_filter',
        'permissions_filter.role',
        'Query.directus_users',
        'categories_projects_m2m.pub_amount_follows_cars'
      ])
    })

    it('keeps breaks this removal caused, drops older breaks and deprecations', () => {
      const hits = findingsHitByRemoval(
        [
          f('(graphql)', 'directus_users'),
          f('permissions_filter', 'role'),
          f('projects', 'pub_amount_follows_cars'), // M2M row type carried the field
          f('projects', 'old_field_gone_last_month'),
          f('(graphql)', 'something_else'),
          f('permissions_filter', 'role', 'deprecated')
        ],
        removed
      )
      expect(hits.map((h) => h.message)).toEqual([
        '(graphql).directus_users',
        'permissions_filter.role',
        'projects.pub_amount_follows_cars'
      ])
    })

    it('nothing used = no notice', () => {
      expect(findingsHitByRemoval([], removed)).toEqual([])
      expect(findingsHitByRemoval([f('projects', 'name')], removed)).toEqual([])
    })

    it('matches removed REST route templates against logged calls', () => {
      const lines = [
        '- GET /api/legacy/:id',
        '- POST /api/old-hook',
        '- GET /api/files/*',
        '+ GET /api/new'
      ]
      expect(
        routesUsedByPartners(lines, [
          { method: 'GET', path: '/api/legacy/{id}' },
          { method: 'GET', path: '/api/old-hook' },
          { method: 'GET', path: '/api/files/a/b' }
        ])
      ).toEqual(['- GET /api/legacy/:id', '- GET /api/files/*'].map((l) => l.slice(2)))
      expect(routesUsedByPartners(lines, [])).toEqual([])
    })
  })
})
