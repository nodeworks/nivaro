import { describe, expect, it } from 'vitest'
import {
  attributeChunkRoutes,
  isReplayRouteSampled,
  normalizeReplaySampling,
  replaySampleDraw,
  replaySamplingRate,
  routeOfReplayEvent
} from './replay-sampling'

const route = (path: string) => ({
  type: 5,
  timestamp: 1,
  data: { tag: 'route', payload: { path } }
})
const ev = (n: number) => ({ type: 3, timestamp: n })

describe('normalizeReplaySampling', () => {
  it('records everything when nothing is set', () => {
    expect(normalizeReplaySampling(null)).toEqual({ default: 1, routes: {} })
    expect(normalizeReplaySampling('{bad')).toEqual({ default: 1, routes: {} })
  })

  it('keeps shares between 0 and 1 for route patterns', () => {
    expect(
      normalizeReplaySampling({
        default: 0.5,
        routes: { '/reports/*': 0, '/content/orders/:id': 0.25, nope: 1, '/x': 2 }
      })
    ).toEqual({ default: 0.5, routes: { '/reports/*': 0, '/content/orders/:id': 0.25 } })
  })
})

describe('sampling decision', () => {
  const s = normalizeReplaySampling({
    default: 0.5,
    routes: { '/reports/*': 0, '/reports/daily/*': 1, '/content/orders/:id': 0.25, '/*': 0.8 }
  })

  it('takes the exact pattern, then the longest prefix, then the default', () => {
    expect(replaySamplingRate(s, '/content/orders/:id')).toBe(0.25)
    expect(replaySamplingRate(s, '/reports/daily/sales')).toBe(1)
    expect(replaySamplingRate(s, '/reports/weekly')).toBe(0)
    expect(replaySamplingRate(s, '/reports')).toBe(0)
    expect(replaySamplingRate(s, '/home')).toBe(0.8)
    expect(replaySamplingRate(normalizeReplaySampling({ default: 0.3 }), '/home')).toBe(0.3)
  })

  it('records a route when the tab drew below its share', () => {
    expect(isReplayRouteSampled(s, '/content/orders/:id', 0.1)).toBe(true)
    expect(isReplayRouteSampled(s, '/content/orders/:id', 0.3)).toBe(false)
    expect(isReplayRouteSampled(s, '/reports/daily/x', 0.999)).toBe(true)
    expect(isReplayRouteSampled(s, '/reports/weekly', 0)).toBe(false)
  })
})

describe('replaySampleDraw', () => {
  it('draws once per tab and keeps it', () => {
    const map = new Map<string, string>()
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v)
    }
    expect(replaySampleDraw(storage, () => 0.42)).toBe(0.42)
    expect(replaySampleDraw(storage, () => 0.9)).toBe(0.42)
    expect(replaySampleDraw(null, () => 0.7)).toBe(0.7)
  })
})

describe('route attribution', () => {
  it('reads route custom events as patterns', () => {
    expect(routeOfReplayEvent(route('/content/orders/1042?tab=x'))).toBe('/content/orders/:id')
    expect(routeOfReplayEvent(ev(1))).toBeNull()
  })

  it('names each chunk after the route at its first event and carries the route on', () => {
    const chunks = [
      [ev(1), ev(2), route('/content/orders/7')],
      [ev(3)],
      [route('/reports'), ev(4)],
      [ev(5)]
    ]
    expect(attributeChunkRoutes(chunks, '/home')).toEqual({
      routes: ['/home', '/content/orders/:id', '/reports', '/reports'],
      endRoute: '/reports'
    })
    expect(attributeChunkRoutes([], '/home')).toEqual({ routes: [], endRoute: '/home' })
  })
})
