// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import { rememberRecordLookups, resetRecordLookups } from './item-edit/record-lookups'
import type { CMSField } from './item-edit/types'

// Army 9 b14: a link to a record that does not exist showed "Order not found"
// but the form's own side reads still went out and each answered 404 — the
// lines, the junction rows, the addendums, the relation paths, the edit lock,
// the integrity check. Once the record read says 403/404 they stay off.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  })
}))

function field(name: string, label: string, extra: Partial<CMSField> = {}): CMSField {
  return {
    field: name,
    type: 'string',
    interface: 'input',
    label,
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: 'main',
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    layout_assigned: true,
    ...extra
  }
}

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

const later = <T,>(v: T, ms = 30) => new Promise<T>((r) => setTimeout(() => r(v), ms))

function makeClient(exists: boolean) {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/items/orders/1') {
        if (exists) return { data: { id: 1, title: 'First', 'vendor.name': null } }
        throw Object.assign(new Error('Not found'), { status: 404 })
      }
      if (p === '/pipelines/instance/orders/1')
        return {
          data: { instance: { current_state: 's1' }, states: [], available_transitions: [] }
        }
      if (p === '/access-explain/orders/1')
        throw Object.assign(new Error('Not found'), { status: 404 })
      // The layout, fields and relations land after the record read answered,
      // as on a real cold load — the side reads they unlock must still wait.
      if (p === '/collection-layouts/active')
        return later({
          data: {
            layout: { id: 7, name: 'Order form', slug: 'order-form' },
            groups: [{ id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0 }],
            assignments: [
              { field: 'title', sort: 0, group_key: 'main', is_visible: true },
              { field: 'vendor.name', sort: 1, group_key: 'main', is_visible: true }
            ],
            ungrouped_sort: 99
          }
        })
      if (p === '/field-config/orders')
        return later({
          data: [
            field('title', 'Title'),
            field('vendor.name', 'Vendor', { interface: 'relation-path', readonly: true })
          ]
        })
      if (p === '/data-model/relations/for/orders')
        return later({
          data: [
            // O2M: order_lines.order → orders
            {
              id: 1,
              many_collection: 'order_lines',
              many_field: 'order',
              one_collection: 'orders',
              one_field: 'lines',
              junction_field: null
            },
            // M2M: orders ↔ tags through orders_tags
            {
              id: 2,
              many_collection: 'orders_tags',
              many_field: 'orders_id',
              one_collection: 'orders',
              one_field: 'tags',
              junction_field: 'tags_id'
            },
            {
              id: 3,
              many_collection: 'orders_tags',
              many_field: 'tags_id',
              one_collection: 'tags',
              one_field: null,
              junction_field: 'orders_id'
            }
          ]
        })
      if (p === '/collections/orders')
        return later({
          data: { display_name: 'Orders', singular: 'Order', addendums_enabled: true }
        })
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls }
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= NoopObserver
g.IntersectionObserver ??= NoopObserver
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false
})) as typeof window.matchMedia
Element.prototype.scrollIntoView ??= () => {}
g.CSS ??= { escape: (v: string) => v }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function mount(exists: boolean) {
  const { client, calls } = makeClient(exists)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'U1' }}>
            <ItemEditForm collection='orders' itemId='1' documentTitle={false} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls, qc }
}

/** Reads about this one record, beyond the record read itself. */
const sideReads = (calls: Cmd[]) =>
  calls
    .map((c) => c._path)
    .filter(
      (p) =>
        p.startsWith('/items/order_lines') ||
        p.startsWith('/items/orders_tags') ||
        p.startsWith('/addendums/orders/1') ||
        p === '/items/orders/1/resolve-paths' ||
        p.startsWith('/item-locks/orders/1') ||
        p.startsWith('/config-conformance/record/orders/1') ||
        p === '/pipelines/instance/orders/1'
    )

describe('ItemEditForm on a record that does not exist', () => {
  it('says so and sends none of the record’s side reads', async () => {
    const { calls } = await mount(false)
    await settle(() => /not found/i.test(host.textContent ?? ''))
    // Let the layout, fields and relations land, and anything they unlock go out.
    await settle(() => calls.some((c) => c._path === '/data-model/relations/for/orders'))
    for (let i = 0; i < 10; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15))
      })
    expect(host.textContent).toMatch(/Order not found/)
    expect(sideReads(calls)).toEqual([])
  })

  it('an existing record still reads its lines, links and paths', async () => {
    const { calls, qc } = await mount(true)
    await settle(() => {
      const s = sideReads(calls)
      return (
        s.some((p) => p.startsWith('/items/order_lines')) &&
        s.some((p) => p.startsWith('/items/orders_tags')) &&
        s.includes('/items/orders/1/resolve-paths')
      )
    })
    const s = sideReads(calls)
    // The lock lookup's answer seeds the pipeline panel's own cache entry, so
    // the panel mounting later does not read the same instance again.
    await settle(() => !!qc.getQueryData(['pipeline-instance', 'orders', '1']))
    expect(qc.getQueryData(['pipeline-instance', 'orders', '1'])).toMatchObject({
      instance: { current_state: 's1' }
    })
    expect(s.filter((p) => p === '/pipelines/instance/orders/1')).toHaveLength(1)
    expect(s.some((p) => p.startsWith('/items/order_lines'))).toBe(true)
    expect(s.some((p) => p.startsWith('/items/orders_tags'))).toBe(true)
    expect(s).toContain('/items/orders/1/resolve-paths')
  })
})

// Army 10: on staging 0.3.84 the EFP record page (header, actions, comments, revisions,
// pipeline, tasks, lock banner) still made 6 failing calls for a missing record: revisions,
// comments, last-touch, provenance, the record read, pipelines/instance. Every read about the
// record answers 404 here, as the server does; only the record read itself may fail.
const FULL_PAGE = {
  showHeader: true,
  showItemActions: true,
  showRevisions: true,
  showPipeline: true,
  showWorkflow: true,
  showComments: true,
  showTasks: true,
  showLockBanner: true
} as const

describe('the full record page on a record that does not exist', () => {
  afterEach(() => resetRecordLookups())
  it('makes exactly one failing call — the record read', async () => {
    // A record of this collection opened earlier asked for its state at entry: that
    // prefetch must wait for the record too.
    rememberRecordLookups('orders', { role: false, state: true })
    const failed: string[] = []
    const { client } = makeClient(false)
    const inner = client.request
    const aboutRecord = (c: Cmd) => {
      const q = c._params ?? {}
      // These answer 200 for a missing record on the server (the layout resolves without
      // it; /access-explain says "no record with this id").
      if (c._path === '/collection-layouts/active' || c._path.startsWith('/access-explain/'))
        return false
      return (
        /\/orders\/1(\/|$)/.test(c._path) ||
        String(q.item ?? '') === '1' ||
        String(q.items ?? '') === '1' ||
        String(q.ids ?? '') === '1' ||
        String(q.item_id ?? '') === '1'
      )
    }
    client.request = vi.fn(async (cmd: Cmd) => {
      if ((cmd._method ?? 'GET').toUpperCase() === 'GET' && aboutRecord(cmd)) {
        failed.push(`${cmd._path}${cmd._params ? ` ${JSON.stringify(cmd._params)}` : ''}`)
        await inner(cmd).catch(() => null)
        throw Object.assign(new Error('Not found'), { status: 404 })
      }
      return inner(cmd)
    }) as typeof client.request
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U1' }}>
              <ItemEditForm collection='orders' itemId='1' documentTitle={false} {...FULL_PAGE} />
            </ItemEditAuthContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await settle(() => /not found/i.test(host.textContent ?? ''))
    for (let i = 0; i < 20; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15))
      })
    expect(host.textContent).toMatch(/Order not found/)
    expect(failed).toEqual(['/items/orders/1'])
  })
})

describe('the full record page on a record that exists', () => {
  it('still reads its touch line, origin, collision baseline, comments and state', async () => {
    const { client, calls } = makeClient(true)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U1' }}>
              <ItemEditForm collection='orders' itemId='1' documentTitle={false} {...FULL_PAGE} />
            </ItemEditAuthContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const paths = () => calls.map((c) => c._path)
    await settle(
      () =>
        paths().includes('/last-touch/orders/1') &&
        paths().includes('/provenance/orders/1') &&
        paths().includes('/comments') &&
        calls.some((c) => c._path === '/revisions' && c._params?.latest_only === '1') &&
        paths().includes('/pipelines/instance/orders/1')
    )
    expect(paths()).toContain('/last-touch/orders/1')
    expect(paths()).toContain('/provenance/orders/1')
    expect(paths()).toContain('/comments')
    expect(paths()).toContain('/pipelines/instance/orders/1')
    expect(calls.some((c) => c._path === '/revisions' && c._params?.latest_only === '1')).toBe(true)
  })
})
