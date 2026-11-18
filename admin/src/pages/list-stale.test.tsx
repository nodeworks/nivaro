import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, type vi } from 'vitest'
import { api, type DashboardWidget } from '@/lib/api'
import { WidgetCard } from './DashboardEdit'
import { TrashPage } from './Trash'

/**
 * Low (seamless) 1, review round 1: a page/search/filter change keeps the previous answer on
 * screen (keepPreviousData) — and says so: dimmed and aria-busy until the new answer lands.
 */

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('previous rows are marked while the next answer loads', () => {
  it('Trash: a new search dims the old rows and marks them busy', async () => {
    let hold: (v: unknown) => void = () => {}
    get.mockImplementation((url: string, cfg?: { params?: { search?: string } }) => {
      if (url !== '/trash') return Promise.resolve({ data: { data: [] } })
      if (cfg?.params?.search) return new Promise((r) => (hold = r))
      return Promise.resolve({
        data: {
          data: [
            {
              id: 1,
              collection: 'workflows',
              item_id: '7',
              label: 'Old workflow',
              deleted_by: null,
              deleted_by_name: null,
              deleted_at: new Date().toISOString()
            }
          ],
          total: 1,
          limit: 50
        }
      })
    })
    const { container } = render(wrap(<TrashPage />))
    await screen.findByText('Old workflow')
    expect(container.querySelector('[data-stale]')).toBeNull()

    const box = container.querySelector('[data-trash-search]') as HTMLInputElement
    fireEvent.change(box, { target: { value: 'quote' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => expect(container.querySelector('[data-stale]')).not.toBeNull())
    const stale = container.querySelector('[data-stale]') as HTMLElement
    expect(stale.className).toContain('opacity-60')
    expect(stale.getAttribute('aria-busy')).toBe('true')
    expect(stale.textContent).toContain('Old workflow')

    hold({ data: { data: [], total: 0, limit: 50 } })
    await waitFor(() => expect(container.querySelector('[data-stale]')).toBeNull())
  })

  it('Dashboard widget card: a global filter change dims the previous figure', async () => {
    let hold: (v: unknown) => void = () => {}
    get.mockImplementation((_url: string, cfg?: { params?: { extra_filters?: string } }) =>
      cfg?.params?.extra_filters
        ? new Promise((r) => (hold = r))
        : Promise.resolve({ data: { data: { value: 42 } } })
    )
    const widget: DashboardWidget = {
      id: 'w1',
      dashboard: 'd1',
      type: 'count',
      title: 'Open workflows',
      collection: null,
      field: null,
      filters: null,
      col: 0,
      row: 0,
      width: 3,
      height: 1
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (filters: Array<{ field: string; op: 'eq'; value: string }>) => (
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <WidgetCard widget={widget} globalFilters={filters as never} onDrill={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { container, rerender } = render(view([]))
    const card = () => container.querySelector('[data-widget-card="w1"]') as HTMLElement
    await waitFor(() => expect(get).toHaveBeenCalled())
    await waitFor(() => expect(card().getAttribute('aria-busy')).toBeNull())
    expect(card().className).not.toContain('opacity-60')

    rerender(view([{ field: 'status', op: 'eq', value: 'open' }]))
    await waitFor(() => expect(card().getAttribute('aria-busy')).toBe('true'))
    expect(card().className).toContain('opacity-60')

    hold({ data: { data: { value: 7 } } })
    await waitFor(() => expect(card().getAttribute('aria-busy')).toBeNull())
  })
})
