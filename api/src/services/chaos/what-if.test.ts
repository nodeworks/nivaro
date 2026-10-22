import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FaultDefinition } from './catalog.js'
import type { ChaosRun } from './runs.js'
import {
  type BlastAnswer,
  faultsFor,
  normaliseScorecard,
  resolveDependency,
  summariseBlast,
  type WhatIfDeps,
  whatIf
} from './what-if.js'

const fault = (over: Partial<FaultDefinition>): FaultDefinition => ({
  key: 'redis_pause',
  label: 'Redis unreachable',
  proves: 'Redis fails open.',
  claim_keys: ['redis.fails_open'],
  targets: ['all', 'node'],
  params: {},
  max_seconds: 300,
  default_seconds: 30,
  points: ['redis.command'],
  ...over
})

const FAULTS = [
  fault({}),
  fault({
    key: 'redis_latency',
    label: 'Redis latency',
    area: 'redis',
    claim_keys: ['redis.latency_ok'],
    params: { delay_ms: { type: 'number', label: 'Delay', min: 1, max: 500, default: 50 } }
  }),
  fault({ key: 'mail_down', label: 'Mail down', claim_keys: ['mail.fails_clean'] }),
  fault({ key: 'db_latency', label: 'DB latency', area: 'db', claim_keys: ['db.retry'] })
]

const run = (over: Partial<ChaosRun>): ChaosRun => ({
  id: 'r1',
  kind: 'drill',
  status: 'completed',
  fault_key: 'redis_pause',
  label: 'Redis unreachable',
  target: { kind: 'all' },
  params: {},
  hypothesis: [],
  verdict: 'held',
  verdict_detail: null,
  baseline: null,
  started_by: null,
  started_at: '2026-10-20T10:00:00.000Z',
  ends_at: null,
  ended_at: '2026-10-20T10:00:30.000Z',
  preset_id: null,
  gameday_id: null,
  meta: {},
  created_at: '2026-10-20T10:00:00.000Z',
  ...over
})

function deps(over: Partial<WhatIfDeps> = {}): WhatIfDeps {
  return {
    scorecard: vi.fn(async () => null),
    blast: vi.fn(
      async (): Promise<BlastAnswer> =>
        summariseBlast(
          {
            window: '24h',
            routes: [{ route: 'GET /api/items/orders', per_min: 12, strength: 'direct' }],
            jobs: [{ id: 'cache-warm' }],
            claims: {
              fails: [{ text: 'Browser sessions fail.' }],
              degrades: [{ text: 'Presence is this replica only.' }],
              keeps: []
            },
            totals: { routes: 1, per_min: 12, share_of_calls: 0.4, screens: 2, jobs: 1 }
          },
          '24h'
        )
    ),
    runs: vi.fn(async () => [run({})]),
    faults: () => FAULTS,
    presets: vi.fn(async () => []),
    ...over
  }
}

afterEach(() => vi.restoreAllMocks())

describe('what if X died (#2860)', () => {
  it('resolves keys, aliases, map nodes and partner ids; refuses the unknown', () => {
    expect(resolveDependency('Redis')?.key).toBe('redis')
    expect(resolveDependency('sql')?.key).toBe('database')
    expect(resolveDependency('db')?.key).toBe('database')
    expect(resolveDependency('smtp')?.key).toBe('mail')
    expect(resolveDependency('what if the file share died')?.key).toBe('files')
    expect(resolveDependency('ext:42')).toMatchObject({
      map_node: 'ext:42',
      label: 'Partner API 42'
    })
    expect(resolveDependency('the moon')).toBeNull()
    expect(resolveDependency('')).toBeNull()
  })

  it('matches faults by key, area or claim prefix', () => {
    const redis = resolveDependency('redis')
    if (!redis) throw new Error('no redis')
    expect(faultsFor(redis, FAULTS).map((f) => f.key)).toEqual(['redis_pause', 'redis_latency'])
  })

  it('answers from the catalog without a scorecard and drafts from the fault (never arms)', async () => {
    const d = deps()
    const out = await whatIf('redis', d)
    expect(out.dependency).toEqual({ key: 'redis', label: 'Redis', map_node: 'redis' })
    expect(d.blast).toHaveBeenCalledWith('redis')
    expect(out.claims).toEqual([
      expect.objectContaining({ key: 'redis.fails_open', status: 'proven', source: 'catalog' }),
      expect.objectContaining({ key: 'redis.latency_ok', status: 'never', source: 'catalog' })
    ])
    expect(out.blast_radius).toMatchObject({
      available: true,
      totals: { per_min: 12 },
      fails: ['Browser sessions fail.']
    })
    expect(out.draft).toMatchObject({ fault_key: 'redis_pause', target: { kind: 'all' } })
    expect(out.draft_only).toBe(true)
    expect(out.builder_href).toContain('/chaos?tab=builder')
    const spec = JSON.parse(
      new URL(out.builder_href as string, 'http://x').searchParams.get('spec') as string
    )
    expect(spec.fault_key).toBe('redis_pause')
  })

  it('prefers the scorecard and a matching preset when present', async () => {
    const out = await whatIf(
      'redis',
      deps({
        scorecard: async () => [
          {
            key: 'redis.fails_open',
            statement: 'Redis fails open',
            status: 'stale',
            last_run_at: '2026-09-01T00:00:00.000Z',
            verdict: 'held',
            source: 'scorecard'
          }
        ],
        presets: async () => [
          {
            key: 'redis-outage-fails-open',
            label: 'Redis outage',
            claim_keys: ['redis.fails_open'],
            spec: { fault_key: 'redis_pause', target: { kind: 'all' }, seconds: 30 }
          }
        ]
      })
    )
    expect(out.claims).toHaveLength(1)
    expect(out.claims[0]).toMatchObject({ status: 'stale', source: 'scorecard' })
    expect(out.draft).toMatchObject({ preset_key: 'redis-outage-fails-open', seconds: 30 })
    expect(out.builder_href).toContain('preset=redis-outage-fails-open')
  })

  it('says "no estimate" for a dependency without a map node and degrades on a failing source', async () => {
    const d = deps({ runs: async () => Promise.reject(new Error('down')) })
    const out = await whatIf('sockets', d)
    expect(d.blast).not.toHaveBeenCalled()
    expect(out.blast_radius).toMatchObject({ available: false })
    expect(out.last_runs).toEqual([])
    const failing = await whatIf(
      'redis',
      deps({ blast: async () => Promise.reject(new Error('boom')) })
    )
    expect(failing.blast_radius).toEqual({ available: false, reason: 'boom' })
  })

  it('has no draft when no fault acts on the dependency', async () => {
    const out = await whatIf('signin', deps())
    expect(out.faults).toEqual([])
    expect(out.draft).toBeNull()
    expect(out.builder_href).toBeNull()
  })

  it('throws a clear error for an unknown dependency', async () => {
    await expect(whatIf('the moon', deps())).rejects.toThrow(/Choose one of database, redis/)
  })

  it('normalises scorecard shapes and rejects odd blast answers', () => {
    expect(
      normaliseScorecard(
        {
          claims: [
            { key: 'a.b', label: 'A', status: 'broke', last_run: { verdict: 'broke' } },
            { key: 'x.y' }
          ]
        },
        ['a.b']
      )
    ).toEqual([
      {
        key: 'a.b',
        statement: 'A',
        status: 'broke',
        last_run_at: null,
        verdict: 'broke',
        source: 'scorecard'
      }
    ])
    expect(summariseBlast({ nope: 1 }, '24h')).toMatchObject({ available: false })
  })
})
