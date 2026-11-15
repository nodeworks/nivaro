import { describe, expect, it } from 'vitest'
import {
  cleanBeacon,
  cleanSample,
  hoursBetween,
  recordW2SSamples,
  sampleFields,
  screenPattern,
  summarizeW2S,
  takeSampleSlots,
  w2sHourKey,
  w2sSectionRows
} from '../../../services/write-to-screen.js'

const ST = Date.UTC(2026, 10, 14, 15, 10, 0)
const HOUR = Math.floor(ST / 3_600_000)

describe('screenPattern', () => {
  it('turns id segments into :id and refuses junk', () => {
    expect(screenPattern('/collections/workflows/12345')).toBe('/collections/workflows/:id')
    expect(screenPattern('/collections/:c/:id')).toBe('/collections/:c/:id')
    expect(screenPattern('/queues/3f2a1b4c-1111-2222-3333-444455556666?x=1')).toBe('/queues/:id')
    expect(screenPattern('https://evil')).toBeNull()
    expect(screenPattern('//x')).toBeNull()
    expect(screenPattern('/a|b')).toBeNull()
    expect(screenPattern(42)).toBeNull()
  })
})

describe('cleanSample', () => {
  const ok = {
    seq: 50,
    st: ST,
    rx: ST + 120,
    done: ST + 900,
    screen: '/collections/workflows',
    collection: 'workflows',
    app: 'admin'
  }
  it('keeps a sane sample', () => {
    expect(cleanSample(ok)).toEqual(ok)
  })
  it('clamps a small clock skew and drops a large one', () => {
    expect(cleanSample({ ...ok, rx: ST - 200 })?.rx).toBe(ST)
    expect(cleanSample({ ...ok, rx: ST - 2000 })).toBeNull()
    expect(cleanSample({ ...ok, done: ST + 61_000 })).toBeNull()
  })
  it('drops bad sequences, names and screens', () => {
    expect(cleanSample({ ...ok, seq: 0 })).toBeNull()
    expect(cleanSample({ ...ok, collection: 'x; drop' })).toBeNull()
    expect(cleanSample({ ...ok, screen: 'nope' })).toBeNull()
  })
  it('falls back to the beacon app', () => {
    expect(cleanSample({ ...ok, app: undefined }, 'portal')?.app).toBe('portal')
  })
  it('cleanBeacon caps and dedupes by sequence', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...ok, seq: 1 + (i % 5) }))
    expect(cleanBeacon({ samples: many }).map((s) => s.seq)).toEqual([1, 2, 3, 4, 5])
    expect(cleanBeacon(null)).toEqual([])
  })
})

describe('takeSampleSlots', () => {
  it('allows a minute budget per person', () => {
    const slots = new Map<string, number[]>()
    expect(takeSampleSlots(slots, 'a', 10, 0, 12)).toBe(10)
    expect(takeSampleSlots(slots, 'a', 10, 1000, 12)).toBe(2)
    expect(takeSampleSlots(slots, 'b', 3, 1000, 12)).toBe(3)
    expect(takeSampleSlots(slots, 'a', 5, 61_000, 12)).toBe(5)
  })
})

function fakeRedis(stamps: Record<string, string>) {
  const hashes = new Map<string, Map<string, number>>()
  return {
    hashes,
    async mget(...keys: string[]) {
      return keys.map((k) => stamps[k] ?? null)
    },
    multi() {
      const ops: Array<() => void> = []
      const m = {
        hincrby(k: string, f: string, n: number) {
          ops.push(() => {
            const h = hashes.get(k) ?? new Map<string, number>()
            h.set(f, (h.get(f) ?? 0) + n)
            hashes.set(k, h)
          })
          return m
        },
        expire() {
          return m
        },
        async exec() {
          for (const o of ops) o()
          return []
        }
      }
      return m
    }
  }
}

describe('recording and the report', () => {
  const s = (
    seq: number,
    total: number,
    screen = '/collections/workflows/:id',
    collection = 'workflows'
  ) => ({
    seq,
    st: ST,
    rx: ST + Math.round(total / 4),
    done: ST + total,
    screen,
    collection,
    app: 'admin'
  })

  it('keeps only samples whose stamp the server made', async () => {
    const redis = fakeRedis({
      'nvr:rt:ack:st:1': String(ST),
      'nvr:rt:ack:st:2': String(ST + 1)
    })
    const kept = await recordW2SSamples([s(1, 400), s(2, 400), s(3, 400)], {
      tenant: '',
      redis: redis as never
    })
    expect(kept).toBe(1)
    const h = redis.hashes.get(w2sHourKey('', HOUR))
    expect(h?.get('t|425')).toBe(1)
    expect(h?.get('d|125')).toBe(1)
    expect(h?.get('r|325')).toBe(1)
    expect(h?.get('s|admin|/collections/workflows/:id|workflows|425')).toBe(1)
  })

  it('keys carry the tenant', () => {
    expect(w2sHourKey('acme', 5)).toBe('nvr:rt:w2s:acme:h:5')
    expect(w2sHourKey(null, 5)).toBe('nvr:rt:w2s:-:h:5')
  })

  it('summarizes p50/p95 overall, per hour and per screen, slowest first', () => {
    const h1: Record<string, string> = {}
    const bump = (f: string) => {
      h1[f] = String(Number(h1[f] ?? 0) + 1)
    }
    for (let i = 0; i < 19; i++) for (const f of sampleFields(s(i + 1, 300))) bump(f)
    for (const f of sampleFields(s(99, 4000, '/queues/:id', 'invoices'))) bump(f)
    const r = summarizeW2S([HOUR - 1, HOUR], [null, h1])
    expect(r.overall.samples).toBe(20)
    expect(r.overall.p50_ms).toBe(325)
    expect(r.overall.p95_ms).toBe(325)
    expect(r.hours).toHaveLength(2)
    expect(r.hours[0].samples).toBe(0)
    expect(r.hours[1].samples).toBe(20)
    expect(r.screens[0]).toMatchObject({
      screen: '/queues/:id',
      collection: 'invoices',
      p95_ms: 4250
    })
    expect(r.screens[1]).toMatchObject({ screen: '/collections/workflows/:id', samples: 19 })
    expect(r.delivery.samples).toBe(20)
    expect(r.render.samples).toBe(20)

    const rows = w2sSectionRows(r)
    expect(rows[0]).toMatchObject({ key: 'p95_ms', value: 325, unit: 'ms', better: 'down' })
    expect(rows[0].note).toContain('Changes reached other screens in 0.33 s p95')
    // The slowest screen with at least 3 samples.
    expect(rows[1]).toMatchObject({ key: 'slowest_screen_p95_ms', value: 325 })
  })

  it('an empty window has no report rows', () => {
    expect(w2sSectionRows(summarizeW2S([HOUR], [null]))).toEqual([])
  })

  it('hoursBetween covers the window, at most 14 days', () => {
    const start = new Date(ST - 3 * 3_600_000)
    expect(hoursBetween(start, new Date(ST))).toHaveLength(4)
    expect(hoursBetween(new Date(0), new Date(ST))).toHaveLength(14 * 24)
  })
})
