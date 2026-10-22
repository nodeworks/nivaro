import { describe, expect, it } from 'vitest'
import type { CatalogFault } from '../api'
import {
  abortLine,
  builderHref,
  clampDraft,
  draftIssues,
  faultAllowed,
  initialDraft,
  mapNodeFor,
  parseSpecParam,
  routePattern,
  slugKey,
  targetWords
} from './model'

const slow: CatalogFault = {
  key: 'slow_requests',
  label: 'Slow requests',
  area: 'http',
  proves: 'x',
  claim_keys: ['http.slow_honest'],
  targets: ['all', 'route', 'share'],
  params: {
    delay_ms: { type: 'number', label: 'Delay', min: 100, max: 5000, default: 1500, unit: 'ms' }
  },
  max_seconds: 300,
  default_seconds: 30,
  points: ['http.request'],
  danger: 'low',
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }],
  console_href: null,
  last_run: null
}

describe('experiment builder model (#2844)', () => {
  it('starts from the fault defaults, then a preset, then a deep link', () => {
    const d0 = initialDraft(slow, [])
    expect(d0).toMatchObject({ target: { kind: 'all' }, params: { delay_ms: 1500 }, seconds: 30 })
    expect(d0.hypothesis).toEqual(slow.hypothesis_defaults)
    expect(d0.hypothesis[0]).not.toBe(slow.hypothesis_defaults[0])
    const d = initialDraft(slow, [
      { fault_key: 'slow_requests', target: { kind: 'share', share_pct: 25 }, seconds: 60 },
      { target: { kind: 'route', pattern: '/api/items/*' }, params: { delay_ms: 800, junk: 1 } }
    ])
    expect(d.target).toEqual({ kind: 'route', pattern: '/api/items/*' })
    expect(d.params).toEqual({ delay_ms: 800 })
    expect(d.seconds).toBe(60)
  })

  it('ignores a layer for another fault or a target the fault refuses', () => {
    const d = initialDraft(slow, [
      { fault_key: 'mail_down', seconds: 99 },
      { target: { kind: 'user', user_id: 'x' } }
    ])
    expect(d.seconds).toBe(30)
    expect(d.target.kind).toBe('all')
  })

  it('clamps into the catalog caps and the environment caps (#2862)', () => {
    const d = initialDraft(slow, [{ params: { delay_ms: 99_999 }, seconds: 9999 }])
    expect(d.params.delay_ms).toBe(5000)
    expect(d.seconds).toBe(300)
    const capped = clampDraft(
      { ...d, target: { kind: 'share', share_pct: 80 } },
      slow,
      { max_latency_ms: 2000, max_seconds: 120, max_share_pct: 10 }
    )
    expect(capped.params.delay_ms).toBe(2000)
    expect(capped.seconds).toBe(120)
    expect(capped.target).toEqual({ kind: 'share', share_pct: 10 })
    expect(faultAllowed(slow, { allowed_faults: ['mail_down'] })).toBe(false)
    expect(faultAllowed(slow, { allowed_faults: '*' })).toBe(true)
    expect(faultAllowed(slow, null)).toBe(true)
  })

  it('names what is missing per step', () => {
    const d = initialDraft(slow, [{ target: { kind: 'route', pattern: '' } }])
    expect(draftIssues(d, slow, null).target).toMatch(/route/)
    expect(draftIssues({ ...d, target: { kind: 'route', pattern: '/api/x/*' } }, slow, null)).toEqual({})
    expect(
      draftIssues({ ...d, hypothesis: [{ sampler: '', op: '<', limit: 1 }] }, slow, null).hypothesis
    ).toBeTruthy()
    expect(draftIssues(d, slow, { allowed_faults: [] }).fault).toBeTruthy()
  })

  it('turns Traffic Map route templates into patterns', () => {
    expect(routePattern('GET /api/items/orders/:id')).toBe('/api/items/orders/*')
    expect(routePattern('POST /api/chaos/runs')).toBe('/api/chaos/runs')
    expect(routePattern('/api/x/:a/y?z=1')).toBe('/api/x/*/y')
  })

  it('maps faults to the dependency node simulate-down understands', () => {
    expect(mapNodeFor(slow, {})).toBeNull()
    expect(mapNodeFor({ ...slow, key: 'redis_pause' }, {})).toBe('redis')
    expect(mapNodeFor({ ...slow, key: 'db_latency', area: 'db' }, {})).toBe('db')
    expect(mapNodeFor({ ...slow, key: 'partner_500', area: 'partner' }, { api_id: 7 })).toBe('ext:7')
    expect(mapNodeFor({ ...slow, key: 'ai_timeout', area: 'outbound' }, {})).toBe('ai')
  })

  it('round-trips the deep link and words the run', () => {
    const href = builderHref({ preset: 'p-1', spec: { fault_key: 'slow_requests', seconds: 10 } })
    const q = new URL(href, 'http://x').searchParams
    expect(q.get('tab')).toBe('builder')
    expect(q.get('preset')).toBe('p-1')
    expect(parseSpecParam(q.get('spec'))).toEqual({ fault_key: 'slow_requests', seconds: 10 })
    expect(parseSpecParam('{nope')).toBeNull()
    expect(targetWords({ kind: 'share', share_pct: 25 })).toBe('25% of traffic')
    expect(targetWords({ kind: 'user', user_id: 'u', name: 'Ada' })).toBe('Ada')
    expect(abortLine({ sampler: 's', op: '<', limit: 1, tolerance: 0.5 })).toBe(1.5)
    expect(abortLine({ sampler: 's', op: '>', limit: 10, tolerance: 2 })).toBe(8)
    expect(slugKey('Slow requests on 25% of traffic, 1m')).toBe('slow-requests-on-25-of-traffic-1m')
  })
})
