import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyJournalListeners } from '../../../services/journal-listeners.js'
import {
  __resetWidgetLive,
  type DashboardRow,
  type DashboardWidgetRow,
  gateWatch,
  type ReportRow,
  type ReportWidgetRow,
  unwatchWidgets,
  type WidgetLiveDeps,
  watchWidgets,
  widgetLiveStats
} from '../../../services/widget-live.js'
import type { User } from '../../../types.js'

const alice = { id: 'A1', role: 'R-SALES' } as unknown as User
const bob = { id: 'B2', role: 'R-OPS' } as unknown as User
const eve = { id: 'E3', role: 'R-NONE' } as unknown as User

const report: ReportRow = {
  id: 'rep1',
  owner: 'A1',
  is_shared: true,
  role_id: null,
  global_filters: null
}
const kpi: ReportWidgetRow = {
  id: 'w1',
  report: 'rep1',
  type: 'kpi',
  collection: 'orders',
  config: null
}

function makeDeps(over: Partial<WidgetLiveDeps> = {}): WidgetLiveDeps & {
  computeReport: ReturnType<typeof vi.fn>
} {
  const computeReport = vi.fn(async (user: User) => ({
    // Each viewer's own figure — what their row filters let them count.
    value: user.id === 'A1' ? 10 : user.id === 'B2' ? 3 : 0
  }))
  const base: WidgetLiveDeps = {
    isAdmin: async () => false,
    canRead: async (user) => user.id !== 'E3',
    dashboardWidget: async () => null,
    savedViewCollection: async () => null,
    reportWidget: async (r, w) => (r === 'rep1' && w === 'w1' ? { widget: kpi, report } : null),
    computeDashboard: async () => ({ data: { value: 1 } }),
    computeReport
  }
  return { ...base, ...over } as never
}

function fakeSocket(id: string) {
  const sent: Array<{ event: string; payload: any }> = []
  return {
    id,
    data: { nvrBind: { kind: 'session', sid: `sid-${id}` } },
    sent,
    emit(event: string, payload: unknown) {
      sent.push({ event, payload })
    }
  }
}

function write(collection: string, tenant = '', item: string | number = 5) {
  notifyJournalListeners({
    seq: 1,
    room: tenant ? `t:${tenant}:collection:${collection}` : `collection:${collection}`,
    event: 'collection:update',
    payload: { collection, item, action: 'update', changed_fields: ['total'] }
  })
}

const spec = (key: string) => ({ key, kind: 'report', widget: 'w1', report: 'rep1' })

beforeEach(() => {
  vi.useFakeTimers()
  __resetWidgetLive()
  delete process.env.WIDGET_LIVE_MAX_PER_MIN
})
afterEach(() => {
  __resetWidgetLive()
  vi.useRealTimers()
})

describe('gateWatch', () => {
  it('mirrors the report gate: owner, shared to role, admin', async () => {
    const deps = makeDeps({
      reportWidget: async () => ({ widget: kpi, report: { ...report, role_id: 'R-SALES' } })
    })
    const spec0 = { kind: 'report' as const, widget: 'w1', report: 'rep1' }
    expect((await gateWatch(alice, spec0, deps)).ok).toBe(true)
    expect(await gateWatch(bob, spec0, deps)).toEqual({ ok: false, reason: 'forbidden' })
    const asAdmin = makeDeps({
      isAdmin: async () => true,
      reportWidget: async () => ({ widget: kpi, report: { ...report, role_id: 'R-SALES' } })
    })
    expect((await gateWatch(bob, spec0, asAdmin)).ok).toBe(true)
  })

  it('refuses a viewer who cannot read the collection, even on a shared report', async () => {
    const r = await gateWatch(eve, { kind: 'report', widget: 'w1', report: 'rep1' }, makeDeps())
    expect(r).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('leaves raw-SQL, AI and sibling-formula widgets on their poll', async () => {
    for (const type of ['query', 'ai_insight', 'calc', 'narrative']) {
      const deps = makeDeps({
        reportWidget: async () => ({ widget: { ...kpi, type }, report })
      })
      const r = await gateWatch(alice, { kind: 'report', widget: 'w1', report: 'rep1' }, deps)
      expect(r).toEqual({ ok: false, reason: 'not-live' })
    }
  })

  it('reads every kpi_group tile collection', async () => {
    const group = {
      ...kpi,
      type: 'kpi_group',
      collection: null,
      config: JSON.stringify({ metrics: [{ collection: 'orders' }, { collection: 'invoices' }] })
    }
    const deps = makeDeps({ reportWidget: async () => ({ widget: group, report }) })
    const r = await gateWatch(alice, { kind: 'report', widget: 'w1', report: 'rep1' }, deps)
    expect(r.ok && r.collections).toEqual(['orders', 'invoices'])
  })

  it('dashboard: private dashboards are the owner’s; `latest` rows keep polling', async () => {
    const widget: DashboardWidgetRow = {
      id: 'd1',
      dashboard: 'dash',
      type: 'count',
      collection: 'orders',
      field: null,
      filters: null
    }
    const dashboard: DashboardRow = { id: 'dash', user: 'A1', is_shared: false }
    const deps = makeDeps({ dashboardWidget: async () => ({ widget, dashboard }) })
    expect((await gateWatch(alice, { kind: 'dashboard', widget: 'd1' }, deps)).ok).toBe(true)
    expect(await gateWatch(bob, { kind: 'dashboard', widget: 'd1' }, deps)).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    const latest = makeDeps({
      dashboardWidget: async () => ({ widget: { ...widget, type: 'latest' }, dashboard })
    })
    expect(await gateWatch(alice, { kind: 'dashboard', widget: 'd1' }, latest)).toEqual({
      ok: false,
      reason: 'not-live'
    })
  })
})

describe('pushed widgets', () => {
  it('two viewers with different access each get their own figure, never the other’s', async () => {
    const deps = makeDeps()
    const sa = fakeSocket('sa')
    const sb = fakeSocket('sb')
    const se = fakeSocket('se')
    expect(
      (await watchWidgets(sa, () => alice, { watches: [spec('key-ka')] }, { deps })).accepted
    ).toEqual(['key-ka'])
    expect(
      (await watchWidgets(sb, () => bob, { watches: [spec('key-kb')] }, { deps })).accepted
    ).toEqual(['key-kb'])
    const refused = await watchWidgets(se, () => eve, { watches: [spec('key-ke')] }, { deps })
    expect(refused.refused).toEqual([{ key: 'key-ke', reason: 'forbidden' }])

    write('orders')
    await vi.advanceTimersByTimeAsync(1_500)

    expect(sa.sent).toEqual([
      { event: 'widget:data', payload: { key: 'key-ka', widget: 'w1', data: { value: 10 } } }
    ])
    expect(sb.sent).toEqual([
      { event: 'widget:data', payload: { key: 'key-kb', widget: 'w1', data: { value: 3 } } }
    ])
    expect(se.sent).toEqual([])
    // Computed once per viewer, as that viewer.
    expect(deps.computeReport.mock.calls.map((c) => (c[0] as User).id).sort()).toEqual(['A1', 'B2'])
  })

  it('ignores writes to other collections and other tenants', async () => {
    const deps = makeDeps()
    const sa = fakeSocket('sa')
    await watchWidgets(sa, () => alice, { watches: [spec('key-ka')] }, { deps })
    write('invoices')
    write('orders', 'other-tenant')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sa.sent).toEqual([])
    expect(deps.computeReport).not.toHaveBeenCalled()
  })

  it('recomputes at most once every 10 seconds per widget and only pushes a change', async () => {
    let n = 1
    const deps = makeDeps({ computeReport: vi.fn(async () => ({ value: n })) as never })
    const sa = fakeSocket('sa')
    await watchWidgets(sa, () => alice, { watches: [spec('key-ka')] }, { deps })
    write('orders')
    write('orders')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(sa.sent).toHaveLength(1)
    write('orders') // same figure: computed, not pushed
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.computeReport).toHaveBeenCalledTimes(1) // still inside the 10s window
    await vi.advanceTimersByTimeAsync(6_000)
    expect(deps.computeReport).toHaveBeenCalledTimes(2)
    expect(sa.sent).toHaveLength(1)
    n = 2
    write('orders')
    await vi.advanceTimersByTimeAsync(11_000)
    expect(sa.sent.map((s) => s.payload.data)).toEqual([{ value: 1 }, { value: 2 }])
  })

  it('drops a watch whose access went away, with no figure', async () => {
    let readable = true
    const deps = makeDeps({ canRead: async () => readable })
    const sa = fakeSocket('sa')
    await watchWidgets(sa, () => alice, { watches: [spec('key-ka')] }, { deps })
    readable = false
    write('orders')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(sa.sent).toEqual([
      { event: 'widget:unwatched', payload: { key: 'key-ka', reason: 'forbidden' } }
    ])
    expect(deps.computeReport).not.toHaveBeenCalled()
    expect(widgetLiveStats().watches).toBe(0)
  })

  it('keeps two sign-ins of one person apart (session vs API key)', async () => {
    const deps = makeDeps()
    const session = fakeSocket('s1')
    const key = { ...fakeSocket('s2'), data: { nvrBind: { kind: 'apikey', id: 7 } } }
    await watchWidgets(session, () => alice, { watches: [spec('key-k1')] }, { deps })
    await watchWidgets(key, () => alice, { watches: [spec('key-k2')] }, { deps })
    write('orders')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(deps.computeReport).toHaveBeenCalledTimes(2)
  })

  it('defers past the per-process budget instead of computing', async () => {
    process.env.WIDGET_LIVE_MAX_PER_MIN = '1'
    const deps = makeDeps()
    const sa = fakeSocket('sa')
    const sb = fakeSocket('sb')
    await watchWidgets(sa, () => alice, { watches: [spec('key-ka')] }, { deps })
    await watchWidgets(sb, () => bob, { watches: [spec('key-kb')] }, { deps })
    write('orders')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(deps.computeReport).toHaveBeenCalledTimes(1)
    expect(widgetLiveStats().deferred).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deps.computeReport).toHaveBeenCalledTimes(2)
    expect(sa.sent.length + sb.sent.length).toBe(2)
  })

  it('unwatch and malformed requests', async () => {
    const deps = makeDeps()
    const sa = fakeSocket('sa')
    const res = await watchWidgets(
      sa,
      () => alice,
      {
        watches: [
          spec('key-ka'),
          { key: 'bad key!', kind: 'report' },
          { key: 'key-kx', kind: 'nope' }
        ]
      },
      { deps }
    )
    expect(res.accepted).toEqual(['key-ka'])
    expect(res.refused).toEqual([{ key: 'key-kx', reason: 'invalid' }])
    unwatchWidgets('sa', { keys: ['key-ka'] })
    write('orders')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sa.sent).toEqual([])
  })
})
