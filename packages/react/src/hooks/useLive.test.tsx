// @vitest-environment jsdom
import {
  type CollectionUpdateEvent,
  type LiveEvent,
  NivaroProvider,
  type RealtimeAdapter,
  RealtimeContext
} from '@nivaro/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyListRows,
  filterFields,
  type LiveListResult,
  type LiveRecordResult,
  mergeRecordFields,
  planListUpdate,
  recordRereadFields,
  useLiveList,
  useLiveRecord,
  withId
} from './useLive'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ev = (e: Partial<LiveEvent>): LiveEvent => ({
  collection: 'orders',
  item: '1',
  own: false,
  ...e
})
const page = (ids: string[], total = ids.length) => ({
  data: ids.map((id) => ({ id, title: `t${id}` })),
  total,
  limit: 25,
  offset: 0
})

describe('planning', () => {
  it('reads filter fields through logical groups and relation roots', () => {
    expect([
      ...filterFields({
        status: { _eq: 'open' },
        _or: [{ owner: { name: { _eq: 'x' } } }, { _not: { total: { _gt: 1 } } }]
      })
    ]).toEqual(['status', 'owner', 'total'])
  })

  it('re-reads only the requested fields a change touched', () => {
    expect(recordRereadFields(undefined, ['title'])).toBe('all')
    expect(recordRereadFields(['title', 'author.name'], null)).toBe('all')
    expect(recordRereadFields(['title', 'author.name', 'author.email'], ['author'])).toEqual([
      'author.name',
      'author.email'
    ])
    expect(recordRereadFields(['title'], ['status'])).toBe('none')
  })

  it('merges a partial re-read by field root', () => {
    const prev = { id: '1', title: 'a', author: { name: 'x', email: 'e' } }
    expect(mergeRecordFields(prev, { id: '1', author: { name: 'y' } }, ['author.name'])).toEqual({
      id: '1',
      title: 'a',
      author: { name: 'y' }
    })
  })

  it('adds id to an explicit field list', () => {
    expect(withId({ fields: ['title'] }).fields).toEqual(['id', 'title'])
    expect(withId({ fields: ['*'] }).fields).toEqual(['*'])
    expect(withId({}).fields).toBeUndefined()
  })

  it('patches visible rows, drops visible deletes, ignores off-page updates the filter cannot see', () => {
    const plan = planListUpdate(
      [
        ev({ item: '1', action: 'update', changed_fields: ['title'] }),
        ev({ item: '2', action: 'delete' }),
        ev({ item: '9', action: 'update', changed_fields: ['title'] })
      ],
      page(['1', '2', '3']),
      { filter: { status: { _eq: 'open' } } }
    )
    expect(plan).toEqual({ refetch: false, remove: ['2'], reread: ['1'] })
  })

  it('re-reads an off-page record when the change may bring it into the filter', () => {
    const plan = planListUpdate(
      [
        ev({ item: '9', action: 'update', changed_fields: ['status'] }),
        ev({ item: '8', action: 'create' })
      ],
      page(['1']),
      { filter: { status: { _eq: 'open' } } }
    )
    expect(plan.reread).toEqual(['9', '8'])
  })

  it('refetches on a bulk write, a sort-field change and an off-page delete of a paged list', () => {
    expect(planListUpdate([ev({ item: '*' })], page(['1']), {}).refetch).toBe(true)
    expect(
      planListUpdate([ev({ item: '1', changed_fields: ['due'] })], page(['1', '2']), {
        sort: ['-due']
      }).refetch
    ).toBe(true)
    expect(planListUpdate([ev({ item: '7', action: 'delete' })], page(['1'], 40), {}).refetch).toBe(
      true
    )
    // A complete list cannot have held an off-page record.
    expect(planListUpdate([ev({ item: '7', action: 'delete' })], page(['1']), {}).refetch).toBe(
      false
    )
  })

  it('aspect notices re-read only lists that show that virtual field', () => {
    const e = ev({ item: '1', changed_fields: ['$state'] })
    expect(planListUpdate([e], page(['1']), {}).reread).toEqual([])
    expect(planListUpdate([e], page(['1']), { fields: ['id', '$state'] }).reread).toEqual(['1'])
  })

  it('applies re-read rows: patch, leave when no longer returned, refetch on a new match', () => {
    const rows = new Map([['1', { id: '1', title: 'new' }]])
    const out = applyListRows(page(['1', '2']), ['1', '2'], rows, [])
    expect(out.page.data).toEqual([{ id: '1', title: 'new' }])
    expect(out.page.total).toBe(1)
    expect(out.refetch).toBe(false)
    const entered = applyListRows(page(['1']), ['5'], new Map([['5', { id: '5', title: 'x' }]]), [])
    expect(entered.refetch).toBe(true)
    expect(entered.page.data).toHaveLength(1)
    // A row leaving a page with more behind it asks for the next one to slide up.
    expect(applyListRows(page(['1', '2'], 30), ['2'], new Map(), []).refetch).toBe(true)
  })
})

// ── Hooks against a fake adapter + client ──────────────────────────────────

function fakeAdapter() {
  const subs: Array<{ cols: string[]; cb: (e: CollectionUpdateEvent) => void }> = []
  const adapter: RealtimeAdapter = {
    subscribeCollections(cols, cb) {
      const s = { cols, cb }
      subs.push(s)
      return () => subs.splice(subs.indexOf(s), 1)
    },
    on: () => () => {},
    emit: () => {}
  }
  const send = (e: CollectionUpdateEvent) => {
    for (const s of [...subs]) if (s.cols.includes(e.collection)) s.cb(e)
  }
  return { adapter, send }
}

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

function mount(node: ReactNode, request: (cmd: any) => Promise<any>, adapter?: RealtimeAdapter) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = { request, getToken: () => null, url: '' } as any
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const inner = createElement(NivaroProvider as any, { client }, node)
  const withRt = adapter
    ? createElement(RealtimeContext.Provider, { value: adapter }, inner)
    : inner
  act(() => root?.render(createElement(QueryClientProvider, { client: qc }, withRt)))
}

const flush = async (ms = 0) => {
  await act(async () => {
    // react-query notifies on a 0ms timer: always let the clock move.
    await vi.advanceTimersByTimeAsync(ms || 1)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1)
  })
}

describe('useLiveRecord', () => {
  it('re-reads only the touched fields as the viewer and merges them in place', async () => {
    vi.useFakeTimers()
    const { adapter, send } = fakeAdapter()
    const calls: any[] = []
    const request = vi.fn(async (cmd: any) => {
      calls.push(cmd)
      if (cmd._params?.fields === 'id,title,status')
        return { data: { id: '1', title: 'Old', status: 'open' } }
      return { data: { id: '1', status: 'closed' } }
    })
    let seen: LiveRecordResult<Record<string, unknown>> | null = null
    function Probe() {
      seen = useLiveRecord('orders', '1', { fields: ['title', 'status'] })
      return null
    }
    mount(createElement(Probe), request, adapter)
    await flush()
    expect(seen!.data).toEqual({ id: '1', title: 'Old', status: 'open' })
    expect(seen!.live).toBe(true)
    send({ collection: 'orders', item: '1', action: 'update', changed_fields: ['status'] })
    await flush(300)
    expect(calls.at(-1)._params).toEqual({ fields: 'id,status' })
    expect(seen!.data).toEqual({ id: '1', title: 'Old', status: 'closed' })
    // A change to a field this read does not show costs no request.
    const before = calls.length
    send({ collection: 'orders', item: '1', action: 'update', changed_fields: ['notes'] })
    await flush(300)
    expect(calls.length).toBe(before)
  })

  it('marks the record deleted', async () => {
    vi.useFakeTimers()
    const { adapter, send } = fakeAdapter()
    let seen: LiveRecordResult<Record<string, unknown>> | null = null
    function Probe() {
      seen = useLiveRecord('orders', 1)
      return null
    }
    mount(createElement(Probe), async () => ({ data: { id: 1 } }), adapter)
    await flush()
    send({ collection: 'orders', item: 1, action: 'delete' })
    await flush(300)
    expect(seen!.deleted).toBe(true)
    expect(seen!.data).toBeNull()
  })

  it('polls when the host has no realtime adapter', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => ({ data: { id: '1' } }))
    let seen: LiveRecordResult<Record<string, unknown>> | null = null
    function Probe() {
      seen = useLiveRecord('orders', '1', { pollMs: 1000 })
      return null
    }
    mount(createElement(Probe), request)
    await flush()
    expect(seen!.live).toBe(false)
    const n = request.mock.calls.length
    await flush(1000)
    expect(request.mock.calls.length).toBeGreaterThan(n)
  })
})

describe('useLiveList', () => {
  it('patches a changed row from the viewer read under the list filter', async () => {
    vi.useFakeTimers()
    const { adapter, send } = fakeAdapter()
    const calls: any[] = []
    const request = vi.fn(async (cmd: any) => {
      calls.push(cmd)
      const filter = JSON.parse(cmd._params?.filter ?? '{}')
      if (filter._and) return { data: [{ id: '2', title: 'changed' }], total: null }
      return {
        data: [
          { id: '1', title: 'a' },
          { id: '2', title: 'b' }
        ],
        total: 2,
        limit: 25,
        offset: 0
      }
    })
    let seen: LiveListResult<Record<string, unknown>> | null = null
    function Probe() {
      seen = useLiveList('orders', { filter: { status: { _eq: 'open' } }, fields: ['title'] })
      return null
    }
    mount(createElement(Probe), request, adapter)
    await flush()
    expect(seen!.data?.data).toHaveLength(2)
    send({ collection: 'orders', item: '2', action: 'update', changed_fields: ['title'] })
    await flush(300)
    const reread = JSON.parse(calls.at(-1)._params.filter)
    expect(reread).toEqual({ _and: [{ status: { _eq: 'open' } }, { id: { _in: ['2'] } }] })
    expect(calls.at(-1)._params.fields).toBe('id,title')
    expect(seen!.data?.data).toEqual([
      { id: '1', title: 'a' },
      { id: '2', title: 'changed' }
    ])
  })
})
