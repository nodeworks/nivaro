// #2841 Simulate down: the overlay model (which map nodes are shaded, how strongly).
import { describe, expect, it } from 'vitest'
import {
  isDependency,
  type OverlayModel,
  overlayFrom,
  pct,
  perMinText,
  type SimResult
} from './overlay'

function model(
  ents: Record<
    string,
    { down?: Record<string, number>; callers?: Array<{ key: string; n: number }> }
  >,
  downs: string[] = []
): OverlayModel {
  return {
    entityKeys: () => Object.keys(ents),
    entityMeta: (k) => ents[k] ?? null,
    downIds: () => downs
  }
}

function result(over: Partial<SimResult> = {}): SimResult {
  return {
    node: 'ext:4',
    label: 'Fusion',
    kind: 'partner',
    window: '24h',
    window_h: 24,
    from: '2026-10-20T12:00:00Z',
    to: '2026-10-21T12:00:00Z',
    routes: [],
    entities: [{ key: 'items/invoices', strength: 'direct', calls: 90 }],
    screens: [],
    jobs: [],
    callers: [{ key: 'cron:nightly-sync', strength: 'direct', calls: 80 }],
    downstream: [{ id: 'mail', strength: 'indirect', calls: 10 }],
    claims: { fails: [], degrades: [], keeps: [] },
    totals: {
      routes: 0,
      calls: 0,
      per_min: 0,
      share_of_calls: null,
      screens: 0,
      jobs: 0,
      channels: 0,
      entities: 1
    },
    sources: [],
    notes: [],
    truncated: false,
    computed_at: '2026-10-21T12:00:00Z',
    ...over
  }
}

describe('overlayFrom', () => {
  it('merges the server answer with what the map shows', () => {
    const ov = overlayFrom(
      'ext:4',
      result(),
      model(
        {
          'items/invoices': { down: { db: 3 }, callers: [{ key: 'k3', n: 4 }] },
          'items/orders': { down: { db: 9, 'ext:4': 2 }, callers: [{ key: 'uA', n: 1 }] },
          'widgets/w1': { down: { db: 1 }, callers: [{ key: 'uB', n: 5 }] }
        },
        ['db', 'ext:4']
      )
    )
    expect([...ov.ents]).toEqual([
      ['items/invoices', 'direct'],
      ['items/orders', 'direct']
    ])
    expect(ov.lanes.get('items')).toBe('direct')
    expect(ov.lanes.has('widgets')).toBe(false)
    expect(ov.callers.get('cron:nightly-sync')).toBe('direct')
    expect(ov.callers.get('k3')).toBe('indirect')
    expect(ov.callers.get('uA')).toBe('indirect')
    expect(ov.callers.has('uB')).toBe(false)
    expect(ov.downs.get('ext:4')).toBe('target')
    expect(ov.downs.get('mail')).toBe('indirect')
  })

  it('an answer for another node is ignored (the read is still in flight)', () => {
    const ov = overlayFrom('db', result(), model({ 'items/x': { down: { db: 1 } } }))
    expect([...ov.ents.keys()]).toEqual(['items/x'])
    expect(ov.callers.size).toBe(0)
    expect(ov.downs.has('mail')).toBe(false)
  })

  it('Redis cache edges on the map are not shaded (cache hits fall back to SQL)', () => {
    const ov = overlayFrom(
      'redis',
      null,
      model({ 'queries/q1': { down: { redis: 40 } } }, ['redis'])
    )
    expect(ov.ents.size).toBe(0)
    expect(ov.downs.get('redis')).toBe('target')
  })

  it('"ai" covers every AI provider node', () => {
    const ov = overlayFrom(
      'ai',
      null,
      model({ 'other/ai': { down: { 'ai:gateway-openai': 3 } } }, [
        'ai:gateway-openai',
        'ai:anthropic'
      ])
    )
    expect(ov.ents.get('other/ai')).toBe('direct')
    expect(ov.downs.get('ai:gateway-openai')).toBe('target')
    expect(ov.downs.get('ai:anthropic')).toBe('target')
  })

  it('works with no map (a node the map does not draw)', () => {
    const ov = overlayFrom('signin', result({ node: 'signin', downstream: [] }), null)
    expect(ov.ents.get('items/invoices')).toBe('direct')
    expect([...ov.downs]).toEqual([['signin', 'target']])
  })
})

describe('helpers', () => {
  it('knows which nodes can be simulated', () => {
    for (const id of ['db', 'redis', 'store', 'signin', 'ai', 'ai:anthropic', 'ext:4', 'mail'])
      expect(isDependency(id)).toBe(true)
    for (const id of ['items/orders', 'k3', 'cron:x', 'ext:abc'])
      expect(isDependency(id)).toBe(false)
  })
  it('formats shares and rates', () => {
    expect(pct(null)).toBe('—')
    expect(pct(0.004)).toBe('<1%')
    expect(pct(0.456)).toBe('46%')
    expect(perMinText(0)).toBe('0/min')
    expect(perMinText(0.04)).toBe('<0.1/min')
    expect(perMinText(2.345)).toBe('2.3/min')
    expect(perMinText(1234.4)).toBe(`${(1234).toLocaleString()}/min`)
  })
})
