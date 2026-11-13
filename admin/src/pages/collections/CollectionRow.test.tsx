import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Collection } from '@/lib/api'
import { CollectionRow } from './CollectionRow'
import type { CollectionStat } from './types'

// The shared setup stubs react-router's hooks; this file tests real routing.
vi.unmock('react-router')

beforeAll(() => {
  // Radix popper + cmdk need these; jsdom has neither.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
})

beforeEach(() => {
  localStorage.clear()
  vi.mocked(api.get).mockClear()
})

const col: Collection = {
  id: 1,
  collection: 'po_lines',
  display_name: 'Purchase order lines',
  icon: null,
  color: null,
  note: 'One row per ordered item',
  hidden: false,
  singleton: false,
  display_template: null,
  sort: null,
  group: 'finance'
}

const stat: CollectionStat = {
  rows: 1234,
  changed_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  pipeline: 'PO approval',
  forms: 2,
  imports: 0,
  link: false,
  virtual: false
}

function Where() {
  const { pathname } = useLocation()
  return <output data-testid='where'>{pathname}</output>
}

type Props = ComponentProps<typeof CollectionRow>

function renderRow(over: Partial<Props> = {}) {
  const props: Props = {
    col,
    density: 'comfortable',
    favorite: false,
    onToggleFavorite: vi.fn(),
    folders: [{ key: 'finance', label: 'Finance', color: null }],
    onMove: vi.fn(),
    selecting: false,
    selected: false,
    onSelect: vi.fn(),
    isAdmin: true,
    ...over
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/collections']}>
        <Routes>
          <Route
            path='*'
            element={
              <>
                <CollectionRow {...props} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const row = utils.container.querySelector('[data-collection="po_lines"]') as HTMLElement
  return { ...utils, props, row }
}

const where = () => screen.getByTestId('where').textContent

describe('CollectionRow', () => {
  it('shows the key only on hover, unless the filter matches it', () => {
    const { row } = renderRow()
    expect(screen.getByText('Purchase order lines')).toBeInTheDocument()
    expect(screen.queryByText('po_lines')).toBeNull()
    fireEvent.mouseEnter(row)
    expect(screen.getByText('po_lines')).toBeInTheDocument()
    fireEvent.mouseLeave(row)
    expect(screen.queryByText('po_lines')).toBeNull()
  })

  it('shows the key with the match marked when the filter matches it', () => {
    const { container } = renderRow({ highlight: 'LINE' })
    const mark = container.querySelector('mark')
    expect(mark?.textContent).toBe('line')
    expect(container.querySelector('[data-key-text]')?.textContent).toBe('po_lines')
  })

  it('does not show the key when the filter only matches the name', () => {
    renderRow({ highlight: 'purchase' })
    expect(screen.queryByText('po_lines')).toBeNull()
  })

  it('shows the note in both densities', () => {
    renderRow({ density: 'compact' })
    expect(screen.getByText('One row per ordered item')).toBeInTheDocument()
  })

  it('hides counts and stat badges without a stat', () => {
    renderRow({ col: { ...col, hidden: true } })
    expect(screen.queryByText('1,234')).toBeNull()
    expect(screen.queryByText('Pipeline')).toBeNull()
    expect(screen.queryByText('Form ×2')).toBeNull()
    // Badges from the collection itself still show.
    expect(screen.getByText('Hidden')).toBeInTheDocument()
  })

  it('shows counts, last change and badges with a stat', () => {
    renderRow({ stat })
    expect(screen.getByText('1,234')).toBeInTheDocument()
    expect(screen.getByText('3h ago')).toBeInTheDocument()
    expect(screen.getByText('Pipeline').closest('[data-tip]')).toHaveAttribute(
      'data-tip',
      'PO approval'
    )
    expect(screen.getByText('Form ×2')).toBeInTheDocument()
  })

  it('shows Empty for zero rows and folds badges past three into +N', () => {
    renderRow({
      col: { ...col, hidden: true, singleton: true },
      stat: { ...stat, rows: 0, virtual: true, link: true }
    })
    expect(screen.getByText('Empty')).toBeInTheDocument()
    // A link table never carries the Hidden badge (it has its own switch): 5 badges → +2.
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.queryByText('Hidden')).toBeNull()
  })

  it('navigates and records the open on click', () => {
    renderRow()
    fireEvent.click(screen.getByRole('link', { name: /^Purchase order lines/ }))
    expect(where()).toBe('/collections/po_lines')
    expect(localStorage.getItem('nvr_collections_usage')).toContain('po_lines')
  })

  it('offers admins an edit link to the collection editor', () => {
    renderRow({ isAdmin: true })
    expect(screen.getByRole('link', { name: 'Edit Purchase order lines' })).toHaveAttribute(
      'href',
      '/data-model/po_lines'
    )
  })

  it('shows no edit link to non-admins', () => {
    renderRow({ isAdmin: false })
    expect(screen.queryByRole('link', { name: /^Edit / })).toBeNull()
  })

  it('toggles selection instead of navigating while selecting', () => {
    const { props } = renderRow({ selecting: true })
    fireEvent.click(screen.getByRole('link', { name: /^Purchase order lines/ }))
    expect(props.onSelect).toHaveBeenCalledTimes(1)
    expect(where()).toBe('/collections')
    expect(localStorage.getItem('nvr_collections_usage')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Purchase order lines' }))
    expect(props.onSelect).toHaveBeenCalledTimes(2)
    expect(where()).toBe('/collections')
  })

  it('stars a favorite without navigating', () => {
    const { props } = renderRow()
    fireEvent.click(
      screen.getByRole('button', { name: 'Add Purchase order lines to my favorites' })
    )
    expect(props.onToggleFavorite).toHaveBeenCalledTimes(1)
    expect(where()).toBe('/collections')
  })

  it('shows a filled star for a favorite', () => {
    renderRow({ favorite: true })
    expect(
      screen.getByRole('button', { name: 'Remove Purchase order lines from my favorites' })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('offers admins a pin for everyone, separate from the star', () => {
    const onTogglePinned = vi.fn()
    renderRow({ onTogglePinned })
    fireEvent.click(screen.getByRole('button', { name: 'Pin Purchase order lines for everyone' }))
    expect(onTogglePinned).toHaveBeenCalledTimes(1)
    expect(where()).toBe('/collections')
  })

  it('shows a pinned collection as pinned to admins', () => {
    renderRow({ pinnedForAll: true, onTogglePinned: vi.fn() })
    expect(
      screen.getByRole('button', { name: 'Unpin Purchase order lines for everyone' })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('gives non-admins no pin control', () => {
    renderRow({ isAdmin: false, pinnedForAll: true })
    expect(screen.queryByRole('button', { name: /for everyone/ })).toBeNull()
  })

  it('menu: favorites in personal words, pin for everyone for admins, moves when offered', async () => {
    const onMoveUp = vi.fn()
    renderRow({ onTogglePinned: vi.fn(), pinnedForAll: true, onMoveUp })
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Purchase order lines' }))
    expect(await screen.findByText('Add to my favorites')).toBeInTheDocument()
    expect(screen.getByText('Unpin for everyone')).toBeInTheDocument()
    expect(screen.queryByText('Move down')).toBeNull()
    fireEvent.click(screen.getByText('Move up'))
    expect(onMoveUp).toHaveBeenCalledTimes(1)
  })

  it('menu gives non-admins only the personal favorite', async () => {
    renderRow({ isAdmin: false, favorite: true })
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Purchase order lines' }))
    expect(await screen.findByText('Remove from my favorites')).toBeInTheDocument()
    expect(screen.queryByText(/for everyone/)).toBeNull()
    expect(screen.queryByText(/^Pin$|^Unpin$/)).toBeNull()
  })

  it('menu offers data-model items to admins', async () => {
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Purchase order lines' }))
    expect(await screen.findByText('Open records')).toBeInTheDocument()
    expect(screen.getByText('Fields')).toBeInTheDocument()
    expect(screen.getByText('Form layouts')).toBeInTheDocument()
    expect(screen.getByText('Move to folder')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Relations'))
    expect(where()).toBe('/data-model/po_lines')
  })

  it('menu hides data-model items from non-admins', async () => {
    renderRow({ isAdmin: false })
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Purchase order lines' }))
    expect(await screen.findByText('Open records')).toBeInTheDocument()
    expect(screen.getByText('Open in new tab')).toBeInTheDocument()
    expect(screen.getByText('Copy key')).toBeInTheDocument()
    for (const label of ['Fields', 'Relations', 'Form layouts', 'Rules', 'Imports', 'Settings'])
      expect(screen.queryByText(label)).toBeNull()
  })

  it('moves to a folder from the menu', async () => {
    const { props } = renderRow({
      folders: [
        { key: 'finance', label: 'Finance', color: null },
        { key: 'ops', label: 'Operations', color: '#f00' }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Purchase order lines' }))
    fireEvent.click(await screen.findByText('Move to folder'))
    fireEvent.click(await screen.findByText('Operations'))
    expect(props.onMove).toHaveBeenCalledWith('ops')
  })

  it('opens the summary card after a pause on the name (admins only)', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        data: {
          collection: 'po_lines',
          fields: [{ field: 'qty', label: 'Quantity', type: 'integer' }],
          field_count: 12,
          relations_out: [{ field: 'po', collection: 'purchase_orders' }],
          relations_in: [],
          pipeline: null,
          forms: 1,
          last_edit: null
        }
      }
    } as never)
    renderRow()
    fireEvent.pointerEnter(screen.getByText('Purchase order lines'))
    expect(await screen.findByText('Quantity', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByText('12 fields')).toBeInTheDocument()
    expect(screen.getByText('Purchase Orders')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/collections/po_lines/summary')
  })

  it('never asks for the summary for non-admins', async () => {
    renderRow({ isAdmin: false })
    fireEvent.pointerEnter(screen.getByText('Purchase order lines'))
    await new Promise((r) => setTimeout(r, 600))
    expect(api.get).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Purchase order lines summary')).toBeNull()
  })
})
