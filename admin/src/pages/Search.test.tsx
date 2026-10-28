import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSearchResponse } from '@/components/command-palette'
import { api } from '@/lib/api'
import { SearchPage } from './Search'

vi.unmock('react-router')
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'me', is_admin: true } }) }))

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const get = api.get as unknown as ReturnType<typeof vi.fn>

function answer(data: Partial<GlobalSearchResponse>, tabRows: unknown[] = []) {
  get.mockImplementation((url: string) => {
    if (url === '/global-search')
      return Promise.resolve({ data: { data: { records: [], pages: [], actions: [], ...data } } })
    if (url === '/global-search/records')
      return Promise.resolve({ data: { data: tabRows, total: tabRows.length } })
    if (url === '/global-search/saved') return Promise.resolve({ data: { data: [] } })
    return Promise.resolve({ data: { data: [] } })
  })
}

const renderAt = (url: string) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[url]}>
        <SearchPage />
      </MemoryRouter>
    </QueryClientProvider>
  )

beforeEach(() => {
  get.mockReset()
  localStorage.clear()
})

describe('search page', () => {
  const rec = {
    collection: 'workflows',
    display_name: 'Workflows',
    id: 7,
    label: 'Pump overhaul',
    snippet: '',
    matched_label: 'Vendor',
    matched_value: 'Acme'
  }

  it('groups results by collection, shows the exact hit and switches tabs', async () => {
    answer(
      {
        records: [rec],
        exact: { ...rec, id: 4512, label: 'WF 4512', matched_label: undefined },
        people: [
          {
            id: 'u1',
            first_name: 'Ann',
            last_name: 'Lee',
            email: 'a@x',
            title: 'Lead',
            department: null,
            role_name: 'PM',
            zones: ['North']
          }
        ]
      },
      [rec]
    )
    renderAt('/search?q=pump')
    expect(await screen.findByText('WF 4512')).toBeInTheDocument()
    // The label is split by the highlight <mark>.
    expect(document.body.textContent).toContain('Pump overhaul')
    expect(document.body.textContent).toContain('Vendor:')
    expect(screen.getByText('PM · North · Lead')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Workflows/ }))
    expect(await screen.findByRole('columnheader', { name: 'Why it matched' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Save search/ })).toBeInTheDocument()
  })

  it('helps when nothing matched', async () => {
    answer({ suggestions: ['pump'] })
    renderAt('/search?q=pmup')
    expect(await screen.findByText('Nothing matched “pmup”')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pump' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a synonym' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ask AI instead/ })).toBeInTheDocument()
  })

  it('starts with how to search when empty', () => {
    answer({})
    renderAt('/search')
    expect(screen.getByText('How to search')).toBeInTheDocument()
  })
})
