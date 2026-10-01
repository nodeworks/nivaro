import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, type vi } from 'vitest'
import { api } from '@/lib/api'
import { requestLinkFilters } from '../../ApiAnalytics'
import { TrafficMapContext, type TrafficMapContextValue } from '../context'
import { EventTicker } from '../EventTicker'
import { Inspector, type InspectorData } from '../Inspector'
import { callerLinks, entityUrl, recordUrl, requestPathOf, requestUrl } from '../links'
import { defaultFilters, TrafficModel } from '../model'
import type { Selection, TrafficCatalog, TrafficEventWire } from '../types'
import { parseRateLimit } from './caller-controls'
import { explainContext, splitBrief } from './explain-spike'
import { hookSlot } from './hook-cost'
import './links'
import { alertName, suggestThreshold } from './node-alert'
import { mockToggle } from './pause-node'
import { probeable } from './probe'
import { runbooksFor } from './runbooks'
import './error-groups'

const T0 = 1_800_000_000
const d: InspectorData = {
  name: 'workflows',
  type: 'Items',
  route: '',
  rps: 2,
  p95: 410,
  errPct: 5,
  series: [1, 2, 3],
  kinds: [100, 2, 10, 0, 6],
  routes: [{ route: 'GET /api/items/workflows', n: 90 }],
  callers: [{ key: 'k7', n: 80 }],
  errors: [
    {
      at: new Date(T0 * 1000).toISOString(),
      status: 422,
      code: 'CHANGE_REASON_REQUIRED',
      route: 'PATCH /api/items/workflows/:id',
      caller: 'k7',
      record: '371407'
    }
  ],
  writes: [
    {
      at: new Date(T0 * 1000).toISOString(),
      action: 'update',
      record: '12',
      fields: ['name'],
      caller: 'uA',
      via: 'items'
    }
  ]
}
const catalog: TrafficCatalog = {
  collections: {},
  widgets: {},
  pages: {},
  queries: {},
  inbound: {},
  extensions: {},
  partners: {},
  callers: {
    k7: { label: 'Fusion key', kind: 'key' },
    'u11111111-2222-3333-4444-555555555555': { label: 'LinX', kind: 'machine' }
  },
  down: {}
}
const sel: Selection = { kind: 'entity', id: 'items/workflows' }

function ctxValue(over: Partial<TrafficMapContextValue> = {}): TrafficMapContextValue {
  return {
    model: new TrafficModel(),
    filters: defaultFilters(),
    setFilters: () => {},
    selection: sel,
    setSelection: () => {},
    catalog,
    tick: 0,
    win: 60,
    paused: false,
    ready: true,
    ...over
  }
}
function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TrafficMapContext.Provider value={ctxValue()}>{children}</TrafficMapContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}
const getMock = api.get as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  getMock.mockReset()
  getMock.mockResolvedValue({ data: { data: {} } })
})

describe('links (#1090 #1091)', () => {
  it('maps records, entities and callers to their pages', () => {
    expect(recordUrl('items', 'workflows', '12')).toBe('/collections/workflows/12')
    expect(recordUrl('system', 'nivaro_users', 'AB')).toBe('/collections/nivaro_users/AB')
    expect(recordUrl('widgets', '5', '12')).toBeNull()
    expect(recordUrl('items', '__other__', '12')).toBeNull()
    expect(entityUrl('pages', 'budget')).toBe('/p/budget')
    expect(entityUrl('other', 'cron')).toBeNull()
    expect(callerLinks('k7', catalog)[0].url).toBe('/integration-health?tab=inbound&caller=key%3A7')
    const machine = callerLinks('u11111111-2222-3333-4444-555555555555', catalog)
    expect(machine.map((l) => l.kind)).toEqual(['inbound', 'profile'])
    const person = callerLinks('uAAAAAAAA-2222-3333-4444-555555555555', catalog)
    expect(person[0]).toEqual({
      kind: 'profile',
      label: 'Profile',
      url: '/users/AAAAAAAA-2222-3333-4444-555555555555'
    })
    expect(callerLinks('cron:digest', catalog)[0].kind).toBe('jobs')
    expect(callerLinks('anon', catalog)).toEqual([])
  })
  it('turns a route template + record into the logged path', () => {
    expect(requestPathOf('PATCH /api/items/workflows/:id', '12')).toEqual({
      method: 'PATCH',
      path: '/api/items/workflows/12'
    })
    expect(requestPathOf('GET /api/items/workflows/:id/history/:id', null).path).toBe(
      '/api/items/workflows'
    )
    expect(requestPathOf('POST /api/graphql · getThings', null)).toEqual({
      method: 'POST',
      path: '/api/graphql'
    })
  })
  it('links a ticker error to the request list around its second, filtered to its caller', () => {
    const url = requestUrl({
      t: T0 * 1000,
      route: 'PATCH /api/items/workflows/:id',
      record: '12',
      status: 422,
      caller: 'k7'
    })
    const p = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith('/api-analytics?')).toBe(true)
    expect(p.get('req_path')).toBe('/api/items/workflows/12')
    expect(p.get('req_method')).toBe('PATCH')
    expect(p.get('req_status')).toBe('422')
    expect(p.get('req_key')).toBe('7')
    expect(new Date(p.get('from') as string).getTime()).toBe(T0 * 1000 - 5000)
    // The analytics page reads the same link back into list filters.
    expect(requestLinkFilters(p)).toEqual({
      focus: true,
      path: '/api/items/workflows/12',
      method: 'PATCH',
      status: '422',
      api_key: 7,
      from: p.get('from'),
      to: p.get('to')
    })
    expect(requestLinkFilters(new URLSearchParams('req_path=/api/x'))).toEqual({ path: '/api/x' })
    expect(requestLinkFilters(new URLSearchParams(''))).toBeNull()
  })
  it('ticker rows offer Record, Request and Path where they apply', () => {
    const ev: TrafficEventWire = {
      t: T0 * 1000,
      lane: 'items',
      entity: 'workflows',
      kind: 'error',
      caller: 'k7',
      route: 'PATCH /api/items/workflows/:id',
      status: 422,
      record: '12',
      chain: 'c-1'
    }
    const write: TrafficEventWire = { ...ev, kind: 'update', status: undefined, record: '13' }
    render(
      wrap(
        <EventTicker
          events={[ev, write]}
          newestT={0}
          win={60}
          catalog={catalog}
          total={2}
          loading={false}
        />
      )
    )
    expect(document.querySelector('[data-tm-open-request]')?.getAttribute('href')).toContain(
      'req_path=%2Fapi%2Fitems%2Fworkflows%2F12'
    )
    expect(document.querySelectorAll('[data-tm-open-record]')).toHaveLength(2)
    // Path is offered on the write only (an error's chain has nothing to draw).
    expect(document.querySelectorAll('[data-tm-show-path]')).toHaveLength(1)
  })
  it('the inspector links record ids and the selected node', () => {
    render(wrap(<Inspector d={d} catalog={catalog} sel={sel} />))
    expect(document.querySelector('[data-tm-record-link="371407"]')?.getAttribute('href')).toBe(
      '/collections/workflows/371407'
    )
    expect(document.getElementById('tm-entity-open')?.getAttribute('href')).toBe(
      '/collections/workflows'
    )
  })
})

describe('explain (#1096)', () => {
  it('sends the node’s own window and splits the answer', () => {
    const m = new TrafficModel()
    m.events = [
      {
        t: T0 * 1000,
        lane: 'items',
        entity: 'workflows',
        kind: 'error',
        caller: 'k7',
        route: 'GET /api/items/workflows',
        status: 500,
        ms: 900
      },
      { t: T0 * 1000, lane: 'items', entity: 'regions', kind: 'read', caller: 'k7', route: 'x' }
    ]
    const text = explainContext(sel, d, m.events, catalog, 300)
    expect(text).toContain('Node: workflows (Items). Window: last 5 minutes.')
    expect(text).toContain('Top callers: Fusion key ×80.')
    expect(text).toContain('CHANGE_REASON_REQUIRED')
    expect(text).toContain('GET /api/items/workflows 500')
    expect(text).not.toContain(' x')
    expect(splitBrief('Errors climbed. Fusion key fails.\nLook next: API Analytics')).toEqual({
      body: 'Errors climbed. Fusion key fails.',
      next: 'API Analytics'
    })
    expect(splitBrief('Quiet.')).toEqual({ body: 'Quiet.', next: null })
  })
})

describe('small pure helpers', () => {
  it('alert names, thresholds, rate limits, mock toggles, runbooks, probes, hook slots', () => {
    expect(alertName('workflows', 'errors_per_min', 5, 300)).toBe(
      'workflows errors per minute > 5 over 5 min'
    )
    expect(alertName('workflows', 'p95_ms', 800, 60)).toBe(
      'workflows p95 latency > 800 ms over 1 min'
    )
    expect(suggestThreshold('errors_per_min', d)).toBe(12)
    expect(suggestThreshold('p95_ms', d)).toBe(615)
    expect(parseRateLimit('')).toBe('none')
    expect(parseRateLimit('120')).toBe(120)
    expect(parseRateLimit('1.5')).toBeNull()
    expect(
      mockToggle({ prod: { enabled: false, rules: [{ status: 200 }] } }, 'staging', true)
    ).toEqual({
      prod: { enabled: false, rules: [{ status: 200 }] },
      staging: { enabled: true, rules: [], record: undefined }
    })
    expect(
      mockToggle({ staging: { enabled: true, rules: [{ status: 503 }] } }, 'staging', false)
    ).toEqual({
      staging: { enabled: false, rules: [{ status: 503 }] }
    })
    const entries = [
      {
        match: ['mdsi'],
        label: 'MDSi runbook',
        url: 'https://w',
        source: 'environment' as const,
        detail: ''
      },
      { match: ['workflows'], label: 'WF', url: '/x', source: 'environment' as const, detail: '' },
      { match: ['ext:9'], label: 'Other', url: '/y', source: 'environment' as const, detail: '' }
    ]
    expect(runbooksFor(entries, { kind: 'down', id: 'ext:3' }, 'MDSi').map((r) => r.label)).toEqual(
      ['MDSi runbook']
    )
    expect(runbooksFor(entries, sel, 'workflows').map((r) => r.label)).toEqual(['WF'])
    expect(probeable(sel)).toBe(true)
    expect(probeable({ kind: 'entity', id: 'system/nivaro_users' })).toBe(true)
    expect(probeable({ kind: 'entity', id: 'widgets/5' })).toBe(false)
    expect(probeable({ kind: 'caller', id: 'k7' })).toBe(false)
    expect(hookSlot({ timing: 'after', action: 'create', collection: '*' })).toBe(
      'after-create (every collection)'
    )
  })
})

describe('error groups panel (#1150)', () => {
  it('lists the groups from entity-detail and links issues', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url.includes('/traffic-map/entity-detail'))
        return {
          data: {
            data: {
              'error-groups': {
                groups: [
                  {
                    key: '5|GET /x|db down',
                    route: 'GET /api/items/workflows',
                    status: 500,
                    code: null,
                    message: 'db down',
                    n: 4,
                    last: new Date(T0 * 1000).toISOString(),
                    issue: { id: 42, status: 'open', occurrence_count: 9 }
                  }
                ]
              }
            }
          }
        }
      return { data: { data: {} } }
    })
    render(wrap(<Inspector d={d} catalog={catalog} sel={sel} />))
    await waitFor(() => expect(document.querySelector('[data-tm-error-issue="42"]')).not.toBeNull())
    expect(screen.getByText('db down')).toBeTruthy()
    expect(document.querySelector('[data-tm-error-issue="42"]')?.getAttribute('href')).toBe(
      '/issues/42'
    )
  })
  it('shows nothing when the entity has no errors at all', async () => {
    render(wrap(<Inspector d={{ ...d, errors: [] }} catalog={catalog} sel={sel} />))
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(document.querySelector('[data-tm-error-groups]')).toBeNull()
    fireEvent.click(document.body)
  })
})
