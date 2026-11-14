import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Heavy list columns (2026-11-13): the Data model card names the "link to many" columns a
// list opens on that carry thousands of rows per record, and saves a default view without
// them through the saved-views API.

const h = vi.hoisted(() => ({
  report: null as unknown,
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body: unknown) => h.post(url, body),
    patch: (url: string, body: unknown) => h.patch(url, body)
  }
}))

const { HeavyListColumnsCard, heavySentence } = await import('./heavy-list-columns-card')

const units = {
  field: 'units',
  label: 'Units',
  kind: 'o2m' as const,
  related_collection: 'units',
  heavy: true,
  in_default: true,
  in_role_defaults: [],
  measure: { status: 'ok' as const, avg: 2280.6, max: 2341 }
}
const requests = {
  ...units,
  field: 'inventory_requests',
  label: 'Inventory requests',
  related_collection: 'inventory_requests',
  measure: { status: 'ok' as const, avg: 297, max: 900 }
}
const report = (over: Record<string, unknown> = {}) => ({
  collection: 'deployment_part_types',
  thresholds: { avg_children: 20, max_children: 200 },
  fields: [units, requests],
  defaults: [
    {
      source: 'baseline',
      view_id: null,
      view_name: null,
      role_name: null,
      columns: ['id', 'name', 'units', 'inventory_requests', 'code'],
      heavy: ['units', 'inventory_requests'],
      suggested_columns: ['id', 'name', 'code']
    }
  ],
  heavy_in_default: ['units', 'inventory_requests'],
  partial: false,
  measured_at: new Date().toISOString(),
  ...over
})

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  h.get.mockImplementation(async () => ({ data: { data: h.report } }))
  h.post.mockResolvedValue({ data: { data: { id: 99 } } })
  h.patch.mockResolvedValue({ data: { data: { id: 48 } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <HeavyListColumnsCard collection='deployment_part_types' />
    </QueryClientProvider>
  )
  return { ...utils, qc }
}

afterEach(() => {
  h.get.mockReset()
  h.post.mockReset()
  h.patch.mockReset()
})

describe('heavySentence', () => {
  it('says how many linked rows a row can show', () => {
    expect(heavySentence(units)).toBe(
      'Units shows up to 2,341 linked units per row on this list — slow and unreadable.'
    )
  })
})

describe('HeavyListColumnsCard', () => {
  it('names the heavy columns and creates a shared default view without them', async () => {
    h.report = report()
    renderCard()
    expect(await screen.findByText(/Units shows up to 2,341 linked units per row/)).toBeTruthy()
    expect(
      screen.getByText(/Inventory requests shows up to 900 linked inventory requests/)
    ).toBeTruthy()
    expect(h.get).toHaveBeenCalledWith('/collections/deployment_part_types/list-weight')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create a default view without them' }))
    })
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1))
    expect(h.post).toHaveBeenCalledWith('/saved-views', {
      collection: 'deployment_part_types',
      name: 'Default',
      is_default: true,
      is_shared: true,
      columns: ['id', 'name', 'code']
    })
    expect(h.patch).not.toHaveBeenCalled()
  })

  it('trims an existing default view, keeping its stored entries', async () => {
    h.report = report({
      fields: [units],
      heavy_in_default: ['units'],
      defaults: [
        {
          source: 'collection_view',
          view_id: 48,
          view_name: 'Default',
          role_name: null,
          columns: ['name', 'units'],
          heavy: ['units'],
          suggested_columns: [{ key: 'name', pin: 'left' }]
        }
      ]
    })
    renderCard()
    const button = await screen.findByRole('button', { name: 'Remove it from the default view' })
    await act(async () => {
      fireEvent.click(button)
    })
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1))
    expect(h.patch).toHaveBeenCalledWith('/saved-views/48', {
      columns: [{ key: 'name', pin: 'left' }]
    })
  })

  it('renders nothing when the list opens on no heavy column', async () => {
    h.report = report({ heavy_in_default: [], defaults: [] })
    const { container } = renderCard()
    await waitFor(() => expect(h.get).toHaveBeenCalled())
    expect(container.querySelector('[data-heavy-list-card]')).toBeNull()
  })
})
