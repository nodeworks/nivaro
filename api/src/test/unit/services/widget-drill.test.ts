// drill_widget (#3208): the rows behind a widget come from readItems AS THE
// VIEWER; a widget filter on a field the viewer cannot read refuses, a filter
// bar one does not bind, and asked-for columns are cut to readable fields.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  allowed: null as string[] | null,
  canRead: true,
  calls: [] as Array<{ user: unknown; collection: string; query: Record<string, unknown> }>
}))

vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const b: Record<string, unknown> = {}
    b.where = () => b
    b.select = async () => [
      { field: 'id' },
      { field: 'status' },
      { field: 'amount' },
      { field: 'secret' },
      { field: 'title' },
      { field: 'created_at' }
    ]
    return b
  })
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => state.canRead),
  getAllowedFields: vi.fn(async () => state.allowed)
}))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async () => ({ display_template: '{{title}}' }))
}))
vi.mock('../../../services/items.js', () => ({
  readItems: vi.fn(async (user: unknown, collection: string, query: Record<string, unknown>) => {
    state.calls.push({ user, collection, query })
    return { data: [{ id: 1, title: 'A' }], total: 40 }
  })
}))

import {
  DrillError,
  drillDashboardWidget,
  drillReportWidget
} from '../../../services/widget-drill.js'

const viewer = { id: 'U1', role: 'R1' } as never

beforeEach(() => {
  state.allowed = null
  state.canRead = true
  state.calls = []
})

describe('drillDashboardWidget', () => {
  it('reads as the viewer with the widget filter, the bar and the segment', async () => {
    const out = await drillDashboardWidget(
      viewer,
      {
        id: 'w1',
        type: 'sum',
        title: 'Open value',
        collection: 'orders',
        field: 'amount',
        filters: [{ field: 'status', value: 'open' }]
      },
      {
        segment: { field: 'status', value: 'open' },
        extra_filters: [
          { field: 'nope', value: 1 },
          { field: 'title', value: 'A' }
        ],
        limit: 5
      }
    )
    expect(state.calls[0]?.user).toBe(viewer)
    expect(state.calls[0]?.query).toMatchObject({
      limit: 5,
      filter: {
        _and: [{ status: { _eq: 'open' } }, { title: { _eq: 'A' } }, { status: { _eq: 'open' } }]
      }
    })
    expect(out.columns).toEqual(expect.arrayContaining(['id', 'title', 'amount', 'status']))
    expect(out).toMatchObject({ total: 40, capped: true, collection: 'orders' })
    expect(out.definition).toMatchObject({ type: 'sum', field: 'amount', aggregate: 'sum' })
  })

  it('refuses a widget filter on a field the viewer cannot read; a bar one does not bind', async () => {
    state.allowed = ['id', 'title', 'amount']
    await expect(
      drillDashboardWidget(
        viewer,
        {
          id: 'w1',
          type: 'count',
          collection: 'orders',
          field: null,
          filters: [{ field: 'secret', value: 'x' }]
        },
        {}
      )
    ).rejects.toMatchObject({ statusCode: 403 })
    const out = await drillDashboardWidget(
      viewer,
      { id: 'w1', type: 'count', collection: 'orders', field: null, filters: [] },
      { extra_filters: [{ field: 'secret', value: 'x' }], fields: ['title', 'secret'] }
    )
    expect(state.calls.at(-1)?.query.filter).toBeUndefined()
    expect(out.columns).toEqual(['id', 'title'])
  })

  it('a collection the viewer cannot read is 403, a system table 400', async () => {
    state.canRead = false
    await expect(
      drillDashboardWidget(
        viewer,
        { id: 'w', type: 'count', collection: 'orders', field: null, filters: [] },
        {}
      )
    ).rejects.toBeInstanceOf(DrillError)
    state.canRead = true
    await expect(
      drillDashboardWidget(
        viewer,
        { id: 'w', type: 'count', collection: 'nivaro_users', field: null, filters: [] },
        {}
      )
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('drillReportWidget', () => {
  it('reads as the viewer with config filters, entity filters and the dimension segment', async () => {
    const out = await drillReportWidget(
      viewer,
      'r1',
      {
        id: 'w2',
        type: 'bar',
        collection: 'orders',
        config: JSON.stringify({
          metric: { aggregate: 'sum', field: 'amount' },
          dimension: { field: 'status' },
          filters: [{ field: 'amount', op: 'gt', value: 0 }]
        })
      },
      { entity_filters: [{ field: 'title', values: ['A'] }], segment: { value: 'open' } }
    )
    expect(state.calls[0]?.query.filter).toEqual({
      _and: [{ amount: { _gt: 0 } }, { title: { _in: ['A'] } }, { status: { _eq: 'open' } }]
    })
    expect(out.definition).toMatchObject({
      source: 'report',
      metric: { aggregate: 'sum', field: 'amount' },
      dimension: { field: 'status' }
    })
  })

  it('a segment on an unreadable field is refused', async () => {
    state.allowed = ['id', 'title', 'amount']
    await expect(
      drillReportWidget(
        viewer,
        'r1',
        { id: 'w2', type: 'bar', collection: 'orders', config: { dimension: { field: 'secret' } } },
        { segment: { value: 'x' } }
      )
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
