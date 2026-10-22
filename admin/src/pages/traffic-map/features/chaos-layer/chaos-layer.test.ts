// #2851 Chaos layer: placing armed faults on the map and the "Inject fault here" options.
import { describe, expect, it } from 'vitest'
import {
  type ArmedShape,
  chaosMarks,
  downsForFault,
  type FaultShape,
  injectHref,
  injectOptions,
  type MapShape,
  routeMatches,
  routePrefix,
  timeLeft
} from './mapping'

const NOW = 1_800_000_000_000
const F: FaultShape[] = [
  {
    key: 'slow_requests',
    label: 'Slow requests',
    area: 'http',
    points: ['http.request'],
    targets: ['all', 'route', 'share']
  },
  { key: 'mail_down', label: 'Mail down', area: 'http', points: ['mail.send'], targets: ['all'] },
  {
    key: 'redis_pause',
    label: 'Redis pause',
    area: 'http',
    points: ['redis.command'],
    targets: ['all', 'node']
  },
  {
    key: 'db_latency',
    label: 'Database latency',
    area: 'db',
    points: ['db.query'],
    targets: ['all', 'table']
  },
  {
    key: 'partner_down',
    label: 'Partner down',
    area: 'external',
    points: ['external.call'],
    targets: ['all']
  },
  {
    key: 'socket_drill',
    label: 'Socket drill',
    area: 'socket',
    points: [],
    targets: ['room', 'user', 'share'],
    console_href: '/realtime?tab=verify'
  }
]
const faults = new Map(F.map((f) => [f.key, f]))
const map: MapShape = {
  entityKeys: () => ['items/orders', 'items/invoices', 'queries/q1'],
  entityMeta: (k) =>
    ({
      'items/orders': { routes: [{ route: 'GET /api/items/orders/:id', n: 9 }] },
      'items/invoices': { routes: [{ route: 'POST /api/items/invoices', n: 3 }] },
      'queries/q1': { routes: [{ route: 'POST /api/custom-queries/q1/execute', n: 1 }] }
    })[k] ?? null,
  downIds: () => ['db', 'redis', 'mail', 'ext:4', 'ext:9', 'ai:anthropic'],
  callerKeys: () => ['k3', 'cron:digest']
}
const armed = (
  key: string,
  target: ArmedShape['target'] = { kind: 'all' },
  id = key
): ArmedShape => ({
  id,
  fault_key: key,
  label: faults.get(key)?.label ?? key,
  target,
  ends_at: NOW + 42_000,
  run_id: `run-${id}`
})

describe('where a fault sits', () => {
  it('points name the down node; the area is the fallback', () => {
    expect(downsForFault(F[1], [])).toEqual(['mail'])
    expect(downsForFault(F[2], [])).toEqual(['redis'])
    expect(downsForFault(F[3], [])).toEqual(['db'])
    expect(downsForFault(F[4], ['db', 'ext:4', 'x:acme.erp'])).toEqual(['ext:4', 'x:acme.erp'])
    expect(downsForFault({ points: [], area: 'storage' }, [])).toEqual(['store'])
    expect(downsForFault(F[0], ['db'])).toEqual([])
  })

  it('an HTTP fault on everything marks every lane; on a route only the matching entities', () => {
    const all = chaosMarks(
      [armed('slow_requests')],
      faults,
      map,
      ['items', 'queries', 'socket'],
      NOW
    )
    expect([...all.lanes.keys()]).toEqual(['items', 'queries'])
    expect(all.ents.size).toBe(0)
    const one = chaosMarks(
      [armed('slow_requests', { kind: 'route', pattern: '/api/items/orders*' })],
      faults,
      map,
      ['items', 'queries'],
      NOW
    )
    expect([...one.ents.keys()]).toEqual(['items/orders'])
    expect(one.lanes.size).toBe(0)
  })

  it('database, Redis, mail and partner faults mark their nodes; a table target its entity', () => {
    const m = chaosMarks(
      [
        armed('db_latency', { kind: 'table', table: 'ORDERS' }),
        armed('redis_pause', { kind: 'node', node: 'api-1' }),
        armed('mail_down'),
        armed('partner_down')
      ],
      faults,
      map,
      ['items'],
      NOW
    )
    expect(m.downs.get('db')?.[0].label).toBe('Database latency')
    expect(m.downs.get('redis')?.[0].ends_at).toBe(NOW + 42_000)
    expect(m.downs.has('mail')).toBe(true)
    expect(m.downs.has('ext:4') && m.downs.has('ext:9')).toBe(true)
    expect([...m.ents.keys()]).toEqual(['items/orders'])
  })

  it('socket drills mark the Sockets lane; a person target marks their caller node', () => {
    const m = chaosMarks(
      [
        armed('socket_drill', { kind: 'room', room: 'r' }, 's1'),
        armed(
          'slow_requests',
          { kind: 'user', user_id: 'aaaaaaaa-0000-4000-8000-000000000001' },
          's2'
        )
      ],
      faults,
      map,
      ['items', 'socket'],
      NOW
    )
    expect(m.lanes.get('socket')?.map((x) => x.id)).toEqual(['s1'])
    expect(m.callers.has('uAAAAAAAA-0000-4000-8000-000000000001')).toBe(true)
    expect(m.lanes.has('items')).toBe(false)
  })

  it('ended and unknown faults are not drawn', () => {
    const ended = { ...armed('mail_down'), ends_at: NOW - 1 }
    const m = chaosMarks([ended, armed('nope')], faults, map, ['items'], NOW)
    expect(m.downs.size + m.lanes.size + m.ents.size + m.callers.size).toBe(0)
  })
})

describe('inject fault here', () => {
  it('a down node offers the faults acting on it, aimed at everything', () => {
    expect(injectOptions({ kind: 'down', id: 'redis' }, F, map)).toEqual([
      {
        fault_key: 'redis_pause',
        label: 'Redis pause',
        target: 'all',
        href: '/chaos?tab=faults&fault=redis_pause&target=all'
      }
    ])
    expect(injectOptions({ kind: 'down', id: 'ext:4' }, F, map).map((o) => o.fault_key)).toEqual([
      'partner_down'
    ])
  })

  it('an entity offers a route-aimed HTTP fault and a table-aimed database fault', () => {
    const o = injectOptions({ kind: 'entity', id: 'items/orders' }, F, map)
    expect(o.map((x) => [x.fault_key, x.target])).toEqual([
      ['slow_requests', 'route:/api/items/orders*'],
      ['db_latency', 'table:orders']
    ])
    expect(o[0].href).toBe(
      '/chaos?tab=faults&fault=slow_requests&target=route%3A%2Fapi%2Fitems%2Forders*'
    )
  })

  it('lanes, people and sockets; the socket drill goes to its own page', () => {
    expect(injectOptions({ kind: 'lane', id: 'items' }, F, map)[0].target).toBe(
      'route:/api/items/*'
    )
    expect(injectOptions({ kind: 'lane', id: 'socket' }, F, map)).toEqual([
      {
        fault_key: 'socket_drill',
        label: 'Socket drill',
        target: null,
        href: '/realtime?tab=verify'
      }
    ])
    const person = injectOptions(
      { kind: 'caller', id: 'uAAAAAAAA-0000-4000-8000-000000000001' },
      F,
      map
    )
    // slow_requests takes no person target; the socket drill does (on its own page)
    expect(person.map((x) => [x.fault_key, x.target])).toEqual([
      ['socket_drill', 'user:aaaaaaaa-0000-4000-8000-000000000001']
    ])
    expect(injectOptions({ kind: 'caller', id: 'k3' }, F, map)).toEqual([])
  })

  it('helpers', () => {
    expect(routePrefix('/api/items/orders/:id/history/:id')).toBe('/api/items/orders*')
    expect(routePrefix('/api/items/invoices')).toBe('/api/items/invoices*')
    expect(routeMatches('/api/items/orders*', '/api/items/orders/:id')).toBe(true)
    expect(routeMatches('/api/items/orders', '/api/items/ordersX')).toBe(false)
    expect(injectHref(F[5], null)).toBe('/realtime?tab=verify')
    expect(timeLeft(NOW + 65_400, NOW)).toBe('1:05')
    expect(timeLeft(NOW - 5, NOW)).toBe('0:00')
  })
})
