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
  requests: [] as Array<{ method: string; url: string }>
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
    default: (p: { layoutId: number; recordId: string | null; onClose: () => void }) => (
      <div data-testid='record-layout-editor' data-layout={p.layoutId} data-record={p.recordId}>
        <button type='button' onClick={p.onClose}>
          Done
        </button>
      </div>
    )
  }
})

vi.mock('@nivaro/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nivaro/shared')>()
  return { ...actual, ItemEditForm: () => <div data-testid='item-form' /> }
})

// A real axios instance whose adapter answers from fixtures and records every
// call, so the classic editor's request guard (an interceptor) is exercised.
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

import { NivaroProvider } from '@nivaro/shared'
import { api } from '@/lib/api'
import { ClassicLayoutsView } from '@/pages/TableEditor'

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
  // AppLayout's provider in the app; the classic tab's shared pickers read it.
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

const writes = () => state.requests.filter((r) => r.method !== 'GET')

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
    const link = await screen.findByRole('link', { name: /edit layout/i })
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
    expect(screen.queryByRole('link', { name: /edit layout/i })).toBeNull()
  })

  it('shows Edit layout for admins', async () => {
    state.user = { id: 'u1', is_admin: true }
    renderWith(<ItemEditPage />, HostProvider)
    const toggle = await screen.findByRole('button', { name: /edit layout/i })
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

    // Turning it off returns to the record, which re-reads its layout.
    const activeReads = () =>
      state.requests.filter((r) => r.url === '/collection-layouts/active').length
    const before = activeReads()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByTestId('record-layout-editor')).toBeNull())
    await waitFor(() => expect(activeReads()).toBeGreaterThan(before))
  })
})

// ── Classic Layouts tab (read-only) ─────────────────────────────────────────

describe('classic layout editor', () => {
  it('classic editor makes no write calls', async () => {
    state.user = { id: 'u1', is_admin: true }
    const onOpenNew = vi.fn()
    renderWith(
      <ClassicLayoutsView
        tableName='orders'
        dbColumns={[
          { name: 'title', data_type: 'nvarchar' },
          { name: 'amount', data_type: 'decimal' }
        ]}
        layoutId={7}
        onOpenNew={onOpenNew}
      />
    )
    expect(screen.getByText(/Read-only — use the new editor/)).toBeTruthy()
    await screen.findAllByText('Order form')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // Press every control the classic tab shows, twice (popovers and menus
    // open on the first pass), and type into every box.
    const root = document.querySelector('[data-classic-read-only]') as HTMLElement
    for (let pass = 0; pass < 2; pass++) {
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"], input[type="checkbox"]'
        )
      ).filter((el) => !el.textContent?.includes('Open in the new editor'))
      for (const el of controls) {
        if (!el.isConnected) continue
        await act(async () => {
          fireEvent.pointerDown(el)
          fireEvent.mouseDown(el)
          fireEvent.click(el)
        })
      }
      for (const el of Array.from(
        root.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"]), textarea')
      )) {
        await act(async () => {
          fireEvent.keyDown(el, { key: 'a' })
          fireEvent.change(el, { target: { value: 'changed' } })
          fireEvent.keyDown(el, { key: 'Enter' })
          fireEvent.blur(el)
        })
      }
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700)) // past any autosave debounce
    })
    expect(writes()).toEqual([])

    // The guard itself: a write made through admin's axios while the classic
    // view is open never leaves the browser.
    await expect(api.patch('/collection-layouts/7', { name: 'x' })).rejects.toThrow(/Read-only/)
    await expect(api.post('/field-groups', { collection: 'orders' })).rejects.toThrow(/Read-only/)
    await expect(api.put('/collection-layouts/7/assignments', { assignments: [] })).rejects.toThrow(
      /Read-only/
    )
    expect(writes()).toEqual([])
    // The page around it keeps writing: sign-out, preferences.
    await api.post('/auth/logout')
    await api.patch('/users/me/preferences', { x: 1 })
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual([
      'POST /auth/logout',
      'PATCH /users/me/preferences'
    ])
    // Reads still work.
    await api.get('/collection-layouts', { params: { collection: 'orders' } })
    expect(state.requests.at(-1)?.method).toBe('GET')
  })
})
