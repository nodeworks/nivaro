// #2152 blast radius + #2274 audience: the pure parts.
import { describe, expect, it } from 'vitest'
import {
  attributeScreens,
  flowsCallingApi,
  flowsOnCollection,
  knownScreens,
  parseBlastNode,
  parseScreens,
  prefilledMessage,
  SCREEN_MATCH_MS,
  splitChainParents
} from './blast-radius.js'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

describe('parseBlastNode', () => {
  it('takes endpoints and partners only', () => {
    expect(parseBlastNode('items/orders')).toMatchObject({
      kind: 'entity',
      lane: 'items',
      entity: 'orders'
    })
    expect(parseBlastNode('ext:12')).toMatchObject({ kind: 'down', apiId: 12 })
    expect(parseBlastNode('k7')).toBeNull()
    expect(parseBlastNode('items/../x')).toBeNull()
  })
})

describe('attributeScreens', () => {
  const t0 = 1_700_000_000_000
  it('matches each call to the page its person opened last, within the window', () => {
    const { screens, attributed } = attributeScreens(
      [
        { user: A, at: t0 + 1000 },
        { user: A, at: t0 + 70_000 },
        { user: B.toUpperCase(), at: t0 + 2000 },
        { user: B, at: t0 + SCREEN_MATCH_MS + 10_000 }, // too long after B's page
        { user: 'cccccccc-0000-4000-8000-000000000003', at: t0 } // no page at all
      ],
      [
        { user: A, at: t0, route: '/collections/:c', app: 'admin' },
        { user: A, at: t0 + 60_000, route: '/collections/:c/:id', app: 'admin' },
        { user: B, at: t0 + 500, route: '/collections/:c', app: 'admin' },
        { user: A, at: t0 + 90_000, route: '/later', app: 'admin' } // after both of A's calls
      ]
    )
    expect(attributed).toBe(3)
    expect(screens).toEqual([
      {
        screen: 'admin /collections/:c',
        app: 'admin',
        route: '/collections/:c',
        people: 2,
        calls: 2
      },
      {
        screen: 'admin /collections/:c/:id',
        app: 'admin',
        route: '/collections/:c/:id',
        people: 1,
        calls: 1
      }
    ])
  })
})

describe('chain steps and flows', () => {
  it('splits cron jobs from flow runs', () => {
    const r = splitChainParents([
      { chain_parent: 'cron:sync', n: 3 },
      { chain_parent: 'cron:sync', n: '2' },
      { chain_parent: 'flow_run:abc', n: 1 },
      { chain_parent: 'request:x', n: 9 },
      { chain_parent: null, n: 4 }
    ])
    expect([...r.jobs]).toEqual([['sync', 5]])
    expect([...r.flowRuns]).toEqual([['abc', 1]])
  })

  it('finds flows configured on a collection', () => {
    const why = flowsOnCollection(
      'orders',
      [
        {
          id: 'f1',
          trigger: 'event',
          trigger_options: JSON.stringify({ collections: ['orders'] })
        },
        { id: 'f2', trigger: 'event', trigger_options: JSON.stringify({ collections: ['other'] }) },
        {
          id: 'f3',
          trigger: 'schedule',
          trigger_options: JSON.stringify({ collections: ['orders'] })
        },
        { id: 'f4', trigger: 'event', trigger_options: 'broken' }
      ],
      [
        { flow: 'f5', type: 'item-write', options: JSON.stringify({ collection: 'orders' }) },
        { flow: 'f6', type: 'item-read', options: JSON.stringify({ collection: 'orders' }) },
        { flow: 'f7', type: 'mail', options: JSON.stringify({ collection: 'orders' }) }
      ]
    )
    expect([...why.keys()].sort()).toEqual(['f1', 'f5', 'f6'])
  })

  it('finds flows with a step calling a partner', () => {
    expect([
      ...flowsCallingApi(4, [
        { flow: 'a', type: 'external-api', options: JSON.stringify({ api_id: 4 }) },
        { flow: 'b', type: 'external-api', options: JSON.stringify({ api_id: '4' }) },
        { flow: 'c', type: 'external-api', options: JSON.stringify({ api_id: 5 }) },
        { flow: 'd', type: 'webhook', options: JSON.stringify({ api_id: 4 }) }
      ])
    ]).toEqual(['a', 'b'])
  })
})

describe('telling people', () => {
  it('reads screen labels back, dropping anything odd', () => {
    expect(
      parseScreens(['admin /collections/:c', '/plain', 'bad app!/x', 'admin javascript:x', 42])
    ).toEqual([
      { app: 'admin', route: '/collections/:c' },
      { app: null, route: '/plain' }
    ])
    expect(parseScreens('nope')).toEqual([])
  })

  it('prefills a plain message naming the screens', () => {
    const m = prefilledMessage('orders', [
      { screen: 'admin /a', app: 'admin', route: '/a', people: 3, calls: 9 }
    ])
    expect(m.subject).toContain('orders')
    expect(m.message).toContain('/a')
  })
})

describe('knownScreens', () => {
  it('keeps only the screens the server-side blast radius lists', () => {
    const known = [
      { app: 'admin', route: '/collections/:c' },
      { app: null, route: '/plain' }
    ]
    expect(
      knownScreens(
        [
          { app: 'admin', route: '/collections/:c' },
          { app: 'portal', route: '/collections/:c' },
          { app: null, route: '/plain' },
          { app: null, route: '/everyone' }
        ],
        known
      )
    ).toEqual([
      { app: 'admin', route: '/collections/:c' },
      { app: null, route: '/plain' }
    ])
    expect(knownScreens([{ app: null, route: '/plain' }], [])).toEqual([])
  })
})
