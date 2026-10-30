import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { CommandPalette, type GlobalSearchResponse } from './command-palette'

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'me', is_admin: true } }) }))
vi.mock('@/lib/contrast-audit', () => ({ showContrastAudit: vi.fn() }))

beforeAll(() => {
  // cmdk + ScrollTabs in jsdom.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const get = api.get as unknown as ReturnType<typeof vi.fn>
const post = api.post as unknown as ReturnType<typeof vi.fn>

function answer(data: Partial<GlobalSearchResponse>) {
  get.mockImplementation((url: string) => {
    if (url === '/global-search')
      return Promise.resolve({ data: { data: { records: [], pages: [], actions: [], ...data } } })
    if (url === '/global-search/saved') return Promise.reject({ response: { status: 404 } })
    if (url === '/global-search/preview') return Promise.reject({ response: { status: 404 } })
    return Promise.resolve({ data: { data: [] } })
  })
}

async function openAndType(text: string) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>
    </QueryClientProvider>
  )
  act(() => {
    window.dispatchEvent(new Event('nivaro:focus-search'))
  })
  const input = await screen.findByPlaceholderText('Search pages, people, records, actions…')
  fireEvent.change(input, { target: { value: text } })
  return input
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  post.mockResolvedValue({ data: { data: { id: 1 } } })
  localStorage.clear()
})

describe('command palette with the new search answer', () => {
  it('shows why each record matched, the exact hit, chips and extra tabs', async () => {
    answer({
      records: [
        {
          collection: 'workflows',
          display_name: 'Workflows',
          id: 7,
          label: 'Pump overhaul',
          snippet: '',
          matched_label: 'Vendor',
          matched_value: 'Acme Pumps'
        }
      ],
      exact: {
        collection: 'workflows',
        display_name: 'Workflows',
        id: 4512,
        label: 'WF 4512',
        snippet: ''
      },
      query: {
        text: 'pump',
        scope: 'workflows',
        filters: [{ field: 'vendor', label: 'Vendor', op: 'contains', value: 'acme' }]
      },
      extra: {
        comments: [
          {
            kind: 'comment',
            id: 'c1',
            label: 'Pump is late',
            href: '/records/workflows/7?comment=c1'
          }
        ]
      }
    })
    const input = await openAndType('wf: vendor:acme pump')

    expect(await screen.findByText('Exact ID')).toBeInTheDocument()
    expect(screen.getByText('Vendor:')).toBeInTheDocument()
    const chips = document.querySelector('[data-palette-chips]') as HTMLElement
    expect(within(chips).getByText('Vendor ∋ acme')).toBeInTheDocument()
    expect(within(chips).getByLabelText('Remove Vendor ∋ acme')).toBeInTheDocument()

    // Alt+3 → All, Workflows, Comments.
    fireEvent.keyDown(input, { key: '¢', code: 'Digit3', altKey: true })
    const commentsTab = document.querySelector('[data-palette-tab="extra:comments"]')
    expect(commentsTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Pump is late')).toBeInTheDocument()
  })

  it('asks before running a command, then posts the transition route', async () => {
    answer({
      commands: [
        {
          id: 'x1',
          label: 'Move WF 7 to Approved',
          kind: 'transition',
          collection: 'workflows',
          item: '7',
          confirm: 'This moves the record to Approved.',
          payload: { transition_id: 't1' }
        }
      ]
    })
    await openAndType('approve 7')
    fireEvent.click(await screen.findByText('Move WF 7 to Approved'))
    const bar = document.querySelector('[data-palette-confirm]') as HTMLElement
    expect(within(bar).getByText(/moves the record to Approved/)).toBeInTheDocument()
    expect(post).not.toHaveBeenCalledWith(
      '/pipelines/instance/workflows/7/transition',
      expect.anything()
    )
    fireEvent.click(within(bar).getByRole('button', { name: 'Confirm' }))
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith('/pipelines/instance/workflows/7/transition', {
        transition_id: 't1'
      })
    )
  })

  it('offers suggestions and a synonym when nothing matched', async () => {
    answer({ suggestions: ['pump'] })
    await openAndType('pmup')
    expect(await screen.findByText(/Did you mean/)).toBeInTheDocument()
    expect(screen.getByText('pump')).toBeInTheDocument()
    expect(screen.getByText(/Add a synonym for/)).toBeInTheDocument()
  })

  it('still works on an older answer without the new fields', async () => {
    answer({
      records: [{ collection: 'units', id: 3, label: 'Unit 3', snippet: 'Building A' }]
    })
    await openAndType('unit')
    expect(await screen.findByText('Building A')).toBeInTheDocument()
    expect(document.querySelector('[data-palette-chips]')).toBeNull()
    expect(document.querySelector('[data-palette-see-all]')).not.toBeNull()
  })

  it('lists recently viewed records first, with state and a changed dot, before typing', async () => {
    get.mockImplementation((url: string, cfg?: { params?: Record<string, unknown> }) => {
      if (url === '/record-views/recent') {
        expect(cfg?.params?.changed).toBe(1)
        return Promise.resolve({
          data: {
            data: [
              {
                collection: 'purchase_orders',
                item_id: '4471',
                label: 'PO 4471',
                state: { key: 'pending', label: 'Pending approval', color: '#f59e0b' },
                last_viewed_at: new Date().toISOString(),
                changed: true,
                changed_at: new Date().toISOString()
              },
              {
                collection: 'purchase_orders',
                item_id: '12',
                label: 'PO 12',
                state: null,
                last_viewed_at: new Date().toISOString(),
                changed: false,
                changed_at: null
              }
            ]
          }
        })
      }
      if (url === '/global-search/saved') return Promise.reject({ response: { status: 404 } })
      return Promise.resolve({ data: { data: [] } })
    })
    await openAndType('')
    const group = await screen.findByText('Recently viewed')
    expect(group).toBeInTheDocument()
    const row = await screen.findByText('PO 4471')
    const item = row.closest('[data-palette-recent-view]') as HTMLElement
    expect(item.getAttribute('data-palette-recent-view')).toBe('purchase_orders:4471')
    expect(within(item).getByText('Pending approval')).toBeInTheDocument()
    expect(within(item).getByText('(changed since you looked)')).toBeInTheDocument()
    const other = (await screen.findByText('PO 12')).closest(
      '[data-palette-recent-view]'
    ) as HTMLElement
    expect(within(other).queryByText('(changed since you looked)')).toBeNull()
  })
})
