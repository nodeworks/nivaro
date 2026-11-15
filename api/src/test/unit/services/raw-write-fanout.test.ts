import { beforeEach, describe, expect, it, vi } from 'vitest'

// Announced raw writes (procedures, imports, scripts) feed what an items-service write would:
// GraphQL events for action-less announcements, opted-in webhooks and flows on update, alert
// re-evaluation — never per-row for collection-wide announcements, never a flow / webhook for
// its own write.

vi.mock('../../../db/pool-context.js', () => ({ runInBackgroundPool: (fn: () => unknown) => fn() }))
vi.mock('../../../services/collection-live-mode.js', () => ({ liveModeNow: () => null }))
vi.mock('../../../services/item-events.js', () => ({ publishItemEvent: vi.fn() }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

const {
  __resetRawWriteFanout,
  fanOutRawWrites,
  flowHearsOutside,
  originOf,
  outsideFlowsFrom,
  planOutsideRows,
  webhookHearsOutside
} = await import('../../../services/raw-write-fanout.js')
type Deps = Parameters<typeof fanOutRawWrites>[2] & {}

function deps(over: Partial<Deps> = {}) {
  const calls = {
    events: [] as unknown[],
    reads: [] as Array<[string, string[]]>,
    webhooks: [] as Array<[string, unknown]>,
    flows: [] as Array<[string, Record<string, unknown>]>,
    alerts: [] as string[]
  }
  const d: Deps = {
    liveModeOff: () => false,
    publishItemEvent: (ev) => void calls.events.push(ev),
    outsideWebhooks: async () => [],
    outsideFlows: async () => [],
    hasAlerts: async () => false,
    readRows: async (c, ids) => {
      calls.reads.push([c, ids])
      return ids.map((id) => ({ id, status: 'open' }))
    },
    fireWebhooks: async (_c, row) => void calls.webhooks.push([String(row.id), row]),
    runFlow: async (flow, payload) => void calls.flows.push([flow.id, payload]),
    evaluateAlerts: async (_c, _row, id) => void calls.alerts.push(id),
    ...over
  }
  return { d, calls }
}

beforeEach(() => __resetRawWriteFanout())

describe('planOutsideRows', () => {
  it('keeps per-row updates, drops deletes, system tables and collection-wide announcements', () => {
    const g = planOutsideRows([
      { collection: 'orders', ids: [1, 2], action: 'update', changed_fields: ['status'] },
      { collection: 'orders', ids: [2, 3], changed_fields: ['total'] },
      { collection: 'orders', ids: [9], action: 'delete' },
      { collection: 'nivaro_users', ids: [1], action: 'update' },
      { collection: 'lines', ids: null, action: 'update' },
      { collection: 'bulk', ids: Array.from({ length: 101 }, (_, i) => i), action: 'update' }
    ])
    expect(g).toEqual([
      {
        collection: 'orders',
        action: 'update',
        ids: ['1', '2', '3'],
        changed_fields: ['status', 'total'],
        origin: null
      }
    ])
  })

  it('a collection-wide announcement in a group makes the whole group collection-wide', () => {
    expect(
      planOutsideRows([
        { collection: 'orders', ids: [1] },
        { collection: 'orders', ids: [] }
      ])
    ).toEqual([])
  })

  it('groups by origin so the loop guard can tell writers apart', () => {
    const g = planOutsideRows([
      { collection: 'orders', ids: [1], origin: 'flow:abc' },
      { collection: 'orders', ids: [2], source: 'webhook:7' },
      { collection: 'orders', ids: [3], source: 'procedure:reforecast' }
    ])
    expect(g.map((x) => [x.ids, x.origin])).toEqual([
      [['1'], 'flow:abc'],
      [['2'], 'webhook:7'],
      [['3'], null]
    ])
  })

  it('origin markers are only flow:/webhook: ids', () => {
    expect(originOf({ source: 'flow:abc-1' })).toBe('flow:abc-1')
    expect(originOf({ source: 'procedure:x' })).toBeNull()
    expect(originOf({ origin: 'flow:a b' })).toBeNull()
  })
})

describe('opt-in', () => {
  it('webhooks need both update and outside in their events, and skip their own write', () => {
    const wh = { id: 7, events: '["update","outside"]', collections: '["orders"]' }
    expect(webhookHearsOutside(wh, 'orders', null)).toBe(true)
    expect(webhookHearsOutside(wh, 'lines', null)).toBe(false)
    expect(webhookHearsOutside(wh, 'orders', 'webhook:7')).toBe(false)
    expect(webhookHearsOutside({ ...wh, events: '["update"]' }, 'orders', null)).toBe(false)
    expect(webhookHearsOutside({ ...wh, events: '["outside"]' }, 'orders', null)).toBe(false)
  })

  it('flows opt in with outside_changes: true, after-timing, hearing update', () => {
    const flows = outsideFlowsFrom([
      { id: 'a', name: 'A', trigger_options: '{"types":["update"],"outside_changes":true}' },
      { id: 'b', name: 'B', trigger_options: '{"types":["update"]}' },
      { id: 'c', name: 'C', trigger_options: '{"timing":"before","outside_changes":true}' },
      { id: 'd', name: 'D', trigger_options: '{"types":["create"],"outside_changes":true}' },
      { id: 'e', name: 'E', trigger_options: '{"outside_changes":true,"collections":["x"]}' },
      { id: 'f', name: 'F', trigger_options: 'not json' }
    ])
    expect(flows.map((f) => f.id)).toEqual(['a', 'e'])
    expect(flowHearsOutside(flows[1], 'x', null)).toBe(true)
    expect(flowHearsOutside(flows[1], 'y', null)).toBe(false)
    expect(flowHearsOutside(flows[0], 'x', 'flow:a')).toBe(false)
  })
})

describe('fanOutRawWrites', () => {
  it('nothing opted in and no alerts: no row read, no fire (default off)', async () => {
    const { d, calls } = deps()
    await fanOutRawWrites([{ collection: 'orders', ids: [1], action: 'update' }], [], d)
    expect(calls.reads).toEqual([])
    expect(calls.webhooks).toEqual([])
    expect(calls.flows).toEqual([])
  })

  it('an action-less announcement reaches GraphQL subscriptions / @live as an update', async () => {
    const { d, calls } = deps()
    await fanOutRawWrites(
      [{ collection: 'orders', ids: null }],
      [
        { collection: 'orders', item: '*', changed_fields: ['status'] },
        { collection: 'orders', item: 5, action: 'update' }
      ],
      d
    )
    // The one with an action was already published by broadcastCollectionUpdate.
    expect(calls.events).toEqual([
      { collection: 'orders', item: '*', action: 'update', changed_fields: ['status'] }
    ])
  })

  it('a collection switched off sends no GraphQL event', async () => {
    const { d, calls } = deps({ liveModeOff: () => true })
    await fanOutRawWrites([], [{ collection: 'orders', item: 1 }], d)
    expect(calls.events).toEqual([])
  })

  it('fires opted-in webhooks and flows per row, never the flow whose own write it was', async () => {
    const { d, calls } = deps({
      outsideWebhooks: async () => [
        {
          id: 7,
          url: 'https://x',
          method: 'POST',
          headers: null,
          secret: null,
          events: '["update","outside"]',
          collections: null
        }
      ],
      outsideFlows: async () => [
        { id: 'abc', name: 'Self', collections: [] },
        { id: 'def', name: 'Other', collections: ['orders'] }
      ]
    })
    await fanOutRawWrites(
      [{ collection: 'orders', ids: [1, 2], changed_fields: ['status'], origin: 'flow:abc' }],
      [],
      d
    )
    expect(calls.reads).toEqual([['orders', ['1', '2']]])
    expect(calls.webhooks.map(([id]) => id)).toEqual(['1', '2'])
    expect(calls.flows.map(([id]) => id)).toEqual(['def', 'def'])
    expect(calls.flows[0][1]).toMatchObject({
      collection: 'orders',
      action: 'update',
      keys: ['1'],
      payload: { status: 'open' },
      previousData: {},
      outside: true
    })
  })

  it('collection-wide announcements never fire per-row webhooks, flows or alerts', async () => {
    const { d, calls } = deps({
      outsideWebhooks: async () => [
        {
          id: 1,
          url: 'https://x',
          method: 'POST',
          headers: null,
          secret: null,
          events: '["update","outside"]'
        }
      ],
      outsideFlows: async () => [{ id: 'f', name: 'F', collections: [] }],
      hasAlerts: async () => true
    })
    await fanOutRawWrites(
      [
        { collection: 'orders', ids: null, action: 'update' },
        { collection: 'lines', ids: Array.from({ length: 150 }, (_, i) => i) }
      ],
      [],
      d
    )
    expect(calls.reads).toEqual([])
    expect(calls.webhooks).toEqual([])
    expect(calls.flows).toEqual([])
    expect(calls.alerts).toEqual([])
  })

  it('alerts are re-evaluated for announced creates and updates without any opt-in', async () => {
    const { d, calls } = deps({ hasAlerts: async (c) => c === 'orders' })
    await fanOutRawWrites(
      [
        { collection: 'orders', ids: [4], action: 'create' },
        { collection: 'lines', ids: [5], action: 'update' }
      ],
      [],
      d
    )
    expect(calls.alerts).toEqual(['4'])
    expect(calls.webhooks).toEqual([])
  })
})
