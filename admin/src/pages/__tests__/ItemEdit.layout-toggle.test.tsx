import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AxiosAdapter, AxiosRequestConfig } from 'axios'
import axios from 'axios'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Record page (ItemEdit) ──────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  user: null as { id: string; is_admin: boolean } | null,
  chunkLoads: 0,
  noLayout: false,
  activeStatus: 0,
  requests: [] as Array<{ method: string; url: string }>,
  // The editor's last save, as the mocked editor hands it to onClose.
  release: null as null | (() => void)
}))

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({ collection: 'orders', id: '5', table: 'orders' })
  }
})

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: state.user }) }))
vi.mock('@/lib/use-record-presence', () => ({
  useRecordPresence: () => ({ viewers: [], editing: {} })
}))
vi.mock('@/components/timeline-sheet', () => ({ TimelineSheet: () => null }))
vi.mock('@/components/share-link-popover', () => ({ ShareLinkPopover: () => null }))

// The lazily loaded editor: the factory runs only when its chunk is requested.
vi.mock('@/components/record-layout-editor', () => {
  state.chunkLoads++
  return {
    default: (p: {
      layoutId: number
      recordId: string | null
      onClose: (saved: Promise<void>) => void
    }) => (
      <div data-testid='record-layout-editor' data-layout={p.layoutId} data-record={p.recordId}>
        <button
          type='button'
          onClick={() =>
            p.onClose(
              new Promise<void>((r) => {
                state.release = r
              })
            )
          }
        >
          Done
        </button>
      </div>
    )
  }
})

vi.mock('@nivaro/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nivaro/shared')>()
  return {
    ...actual,
    // The More menu's host rows (Edit layout) render as the form would put them.
    ItemEditForm: (p: { layoutEditing?: boolean; moreMenuItems?: React.ReactNode }) => (
      <div data-testid='item-form' data-layout-editing={String(!!p.layoutEditing)}>
        <div data-testid='more-menu'>{p.moreMenuItems}</div>
      </div>
    )
  }
})

// A real axios instance whose adapter answers from fixtures and records every
// call, so what the page requests can be asserted.
const LAYOUTS = [
  {
    id: 7,
    collection: 'orders',
    name: 'Order form',
    slug: 'order_form',
    is_active: true,
    layout_type: 'grouped',
    sort: 0,
    conditions: null,
    record_conditions: null
  }
]
function answer(config: AxiosRequestConfig): unknown {
  const url = String(config.url ?? '').split('?')[0]
  const params = (config.params ?? {}) as Record<string, unknown>
  if (url === '/collection-layouts/active')
    return {
      data: {
        layout: state.noLayout ? null : { id: 7, name: 'Order form' },
        groups: [],
        assignments: []
      }
    }
  if (url === '/collection-layouts' && !params.layout_type) return { data: LAYOUTS }
  if (url === '/collections/orders') return { data: { display_name: 'Orders', fields: [] } }
  if (url.startsWith('/field-groups')) return { data: [] }
  if (url === '/field-config/orders')
    return {
      data: [
        { field: 'title', type: 'string', interface: 'input', label: 'Title', sort: 0 },
        { field: 'amount', type: 'decimal', interface: 'input', label: 'Amount', sort: 1 }
      ]
    }
  return { data: [] }
}
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const adapter: AxiosAdapter = async (config) => {
    state.requests.push({ method: (config.method ?? 'get').toUpperCase(), url: config.url ?? '' })
    const status = String(config.url ?? '').startsWith('/collection-layouts/active')
      ? state.activeStatus || (state.noLayout ? 404 : 0)
      : 0
    if (status) {
      // Shaped like the real API: 404 { error: 'No layout found' }.
      throw new axios.AxiosError(
        `Request failed with status code ${status}`,
        'ERR_BAD_REQUEST',
        config as never,
        null,
        {
          data: { error: status === 404 ? 'No layout found' : 'boom' },
          status,
          statusText: '',
          headers: {},
          config: config as never
        } as never
      )
    }
    return { data: answer(config), status: 200, statusText: 'OK', headers: {}, config }
  }
  return { ...actual, api: axios.create({ baseURL: '/api', adapter }) }
})

import { LAYOUT_PUSH_SETTLE_MS, NivaroProvider } from '@nivaro/shared'

// jsdom lacks what Radix and the editors measure with.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= NoopObserver
g.IntersectionObserver ??= NoopObserver
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
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

function renderWith(ui: React.ReactNode, Provider: typeof NivaroProvider = NivaroProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // AppLayout's provider in the app.
  const client = {
    url: 'http://test',
    request: vi.fn(async (c: { _method?: string; _path?: string }) => {
      state.requests.push({ method: (c._method ?? 'GET').toUpperCase(), url: c._path ?? '' })
      return { data: [] }
    })
  }
  return render(
    <QueryClientProvider client={qc}>
      <Provider client={client as never}>
        <MemoryRouter initialEntries={['/collections/orders/5']}>{ui}</MemoryRouter>
      </Provider>
    </QueryClientProvider>
  )
}

// A fresh module registry per test re-runs the lazy chunk's mock factory, so
// the load count belongs to the test, not to the order the tests run in.
let ItemEditPage: typeof import('@/pages/ItemEdit').ItemEditPage
let HostProvider: typeof NivaroProvider
beforeEach(async () => {
  state.requests.length = 0
  state.chunkLoads = 0
  state.noLayout = false
  state.activeStatus = 0
  vi.resetModules()
  ItemEditPage = (await import('@/pages/ItemEdit')).ItemEditPage
  HostProvider = (await import('@nivaro/shared')).NivaroProvider
})

describe('record page Edit layout toggle', () => {
  it('hides Edit layout for non-admins and never requests the editor chunk', async () => {
    state.user = { id: 'u2', is_admin: false }
    renderWith(<ItemEditPage />, HostProvider)
    await screen.findByTestId('item-form')
    await waitFor(() =>
      expect(state.requests.some((r) => r.url === '/collection-layouts/active')).toBe(true)
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(screen.queryByRole('button', { name: /edit layout/i })).toBeNull()
    expect(state.chunkLoads).toBe(0)
  })

  it('offers admins a way into the Layouts tab when the collection has no layout', async () => {
    state.user = { id: 'u1', is_admin: true }
    state.noLayout = true
    renderWith(<ItemEditPage />, HostProvider)
    const link = await screen.findByRole('link', { name: /create the first form/i })
    expect(link.getAttribute('href')).toBe('/data-model/orders?tab=groups')
    expect(state.chunkLoads).toBe(0)
  })

  it('does not offer the first-form link when the layout read fails with a 500', async () => {
    state.user = { id: 'u1', is_admin: true }
    state.activeStatus = 500
    renderWith(<ItemEditPage />, HostProvider)
    await screen.findByTestId('item-form')
    await waitFor(() =>
      expect(state.requests.some((r) => r.url === '/collection-layouts/active')).toBe(true)
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(screen.queryByRole('link', { name: /create the first form/i })).toBeNull()
  })

  it('shows Edit layout for admins', async () => {
    state.user = { id: 'u1', is_admin: true }
    renderWith(<ItemEditPage />, HostProvider)
    const toggle = await screen.findByRole('button', { name: /edit layout/i })
    // A More-menu row, not a header button.
    expect(toggle.closest('[data-testid="more-menu"]')).not.toBeNull()
    expect(toggle.hasAttribute('data-nvr-menu-close')).toBe(true)
    expect(screen.queryByTestId('record-layout-editor')).toBeNull()

    fireEvent.click(toggle)
    const overlay = await screen.findByTestId('record-layout-editor')
    // The layout /active resolved for THIS record, previewing this record.
    expect(overlay.getAttribute('data-layout')).toBe('7')
    expect(overlay.getAttribute('data-record')).toBe('5')
    expect(
      state.requests.some((r) => r.url === '/collection-layouts/active' && r.method === 'GET')
    ).toBe(true)
    expect(state.chunkLoads).toBe(1)

    // Turning it off returns to the record at once (the editor wrapper re-reads
    // the record's layout once the last save lands: record-layout-editor.test).
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByTestId('record-layout-editor')).toBeNull())
  })

  it('keeps the record form quiet about its own layout saves until they settle (no banner on close)', async () => {
    state.user = { id: 'u1', is_admin: true }
    renderWith(<ItemEditPage />, HostProvider)
    const form = () => screen.getByTestId('item-form').getAttribute('data-layout-editing')
    fireEvent.click(await screen.findByRole('button', { name: /edit layout/i }))
    await screen.findByTestId('record-layout-editor')
    expect(form()).toBe('true')

    // Closed with a save still in flight: its config push has not been sent yet.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByTestId('record-layout-editor')).toBeNull())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(form()).toBe('true')

    // The save lands; the push can still arrive for the push gap, then the form listens again.
    await act(async () => {
      state.release?.()
      await Promise.resolve()
    })
    expect(form()).toBe('true')
    await waitFor(() => expect(form()).toBe('false'), { timeout: LAYOUT_PUSH_SETTLE_MS + 1500 })
  })
})
