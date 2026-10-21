import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildResourceRows,
  loadContainerResources,
  resourceExprs,
  resourcesAvailable
} from './container-resources.js'
import { setStoreFetchForTests } from './telemetry-store.js'

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.TELEMETRY_STORE_URL = 'http://vm:8427'
  process.env.TELEMETRY_STORE_ENV = 'staging'
})
afterEach(() => {
  process.env = { ...saved }
  setStoreFetchForTests(null)
})

const L = (container: string, host = 'h1') => ({ host, container })
const empty = {
  cpu: [],
  throttled: [],
  mem: [],
  limit: [],
  oom: [],
  rx: [],
  tx: [],
  read: [],
  write: [],
  cpuSeries: [],
  memSeries: []
}

describe('buildResourceRows', () => {
  it('joins metrics per host+container, treats a 0 limit as no limit', () => {
    const rows = buildResourceRows({
      ...empty,
      cpu: [{ labels: L('api'), value: 1.5 }],
      mem: [
        { labels: L('api'), value: 900 },
        { labels: L('db'), value: 500 }
      ],
      limit: [
        { labels: L('api'), value: 1000 },
        { labels: L('db'), value: 0 }
      ],
      oom: [{ labels: L('api'), value: 2.0000001 }],
      rx: [{ labels: L('api'), value: 10 }],
      read: [{ labels: L('api'), value: 5 }]
    })
    const api = rows.find((r) => r.container === 'api')!
    const db = rows.find((r) => r.container === 'db')!
    expect(api.cpu_cores).toBe(1.5)
    expect(api.mem_share).toBeCloseTo(0.9)
    expect(api.oom_events).toBe(2)
    expect(api.rx_bps).toBe(10)
    expect(api.tx_bps).toBeNull()
    expect(db.mem_limit_bytes).toBeNull()
    expect(db.mem_share).toBeNull()
  })

  it('flags throttling over 10 % and memory over 85 % of the limit', () => {
    const rows = buildResourceRows({
      ...empty,
      throttled: [
        { labels: L('a'), value: 0.11 },
        { labels: L('b'), value: 0.1 },
        { labels: L('c'), value: Number.NaN }
      ],
      mem: [
        { labels: L('a'), value: 86 },
        { labels: L('b'), value: 85 }
      ],
      limit: [
        { labels: L('a'), value: 100 },
        { labels: L('b'), value: 100 }
      ]
    })
    const by = (n: string) => rows.find((r) => r.container === n)!
    expect(by('a').flags).toEqual(['throttled', 'memory'])
    expect(by('b').flags).toEqual([])
    expect(by('c').throttled_share).toBeNull()
  })

  it('keeps two hosts running the same container name apart; thins long sparklines', () => {
    const points = Array.from({ length: 300 }, (_, i) => [i, i] as [number, number])
    const rows = buildResourceRows({
      ...empty,
      cpu: [
        { labels: L('api', 'h1'), value: 1 },
        { labels: L('api', 'h2'), value: 2 }
      ],
      cpuSeries: [{ labels: L('api', 'h1'), points }]
    })
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.host === 'h1')!.cpu_spark).toHaveLength(60)
  })
})

describe('resourceExprs', () => {
  it('scopes to the env and the window, and filters a container pattern', () => {
    const e = resourceExprs('7d', 'gitlab')
    expect(e.oom).toContain('[7d]')
    expect(e.cpu).toContain('env="staging"')
    expect(e.cpu).toContain('container=~"gitlab"')
    expect(resourceExprs('24h').cpu).toContain('container!=""')
  })
})

describe('loadContainerResources', () => {
  it('is unavailable without a store', () => {
    delete process.env.TELEMETRY_STORE_URL
    expect(resourcesAvailable()).toBe(false)
  })

  it('degrades per metric: a failing query empties its column only', async () => {
    setStoreFetchForTests(async (_url, init) => {
      const q = new URLSearchParams(String(init.body)).get('query') ?? ''
      if (q.includes('oom_events')) return new Response('x', { status: 500 })
      if (q.includes('container_cpu_usage_seconds_total'))
        return new Response(
          JSON.stringify({
            data: { result: [{ metric: { host: 'h1', container: 'api' }, value: [1, '0.5'] }] }
          }),
          { status: 200 }
        )
      return new Response(JSON.stringify({ data: { result: [] } }), { status: 200 })
    })
    const rows = await loadContainerResources('24h')
    expect(rows).toHaveLength(1)
    expect(rows[0].cpu_cores).toBe(0.5)
    expect(rows[0].oom_events).toBeNull()
  })
})
