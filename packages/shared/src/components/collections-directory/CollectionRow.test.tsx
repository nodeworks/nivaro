// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { CollectionRow } from './CollectionRow'
import {
  cleanup,
  click,
  getByRole,
  getByText,
  hover,
  mount,
  queryByRole,
  queryByText,
  unhover,
  waitFor
} from './test-kit'
import type { DirectoryCollection as Collection, CollectionStat } from './types'

beforeAll(() => {
  // Radix popper + cmdk need these; jsdom has neither.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
})

type Cmd = { _method: string; _path: string }
const requests: Cmd[] = []
let summary: unknown = null
const client = {
  request: vi.fn(async (cmd: Cmd) => {
    requests.push(cmd)
    return { data: summary }
  })
}
let where = '/collections'
const navigate = vi.fn((path: string) => {
  where = path
})

beforeEach(() => {
  localStorage.clear()
  requests.length = 0
  summary = null
  where = '/collections'
  navigate.mockClear()
})
afterEach(cleanup)

const col: Collection = {
  collection: 'po_lines',
  display_name: 'Purchase order lines',
  icon: null,
  color: null,
  note: 'One row per ordered item',
  hidden: false,
  singleton: false,
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

type Props = ComponentProps<typeof CollectionRow>

/** What the admin app hands the row (its ✏ link and Data model menu). */
const adminTools: Partial<Props> = {
  editPath: '/data-model/po_lines',
  menuExtra: {
    heading: 'Data model',
    items: [
      { key: 'fields', label: 'Fields', path: '/data-model/po_lines?tab=fields' },
      { key: 'relations', label: 'Relations', path: '/data-model/po_lines?tab=relations' },
      { key: 'groups', label: 'Form layouts', path: '/data-model/po_lines?tab=groups' }
    ]
  },
  onMove: vi.fn()
}

function renderRow(over: Partial<Props> = {}) {
  const props: Props = {
    col,
    density: 'comfortable',
    favorite: false,
    onToggleFavorite: vi.fn(),
    folders: [{ key: 'finance', label: 'Finance', color: null }],
    selecting: false,
    selected: false,
    onSelect: vi.fn(),
    isAdmin: true,
    ...adminTools,
    ...over
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = mount(
    <QueryClientProvider client={qc}>
      <NivaroProvider client={client as never}>
        <NavigationContext.Provider value={{ navigate }}>
          <CollectionRow {...props} />
        </NavigationContext.Provider>
      </NivaroProvider>
    </QueryClientProvider>
  )
  const row = utils.container.querySelector('[data-collection="po_lines"]') as HTMLElement
  return { ...utils, props, row }
}

const openMenu = () => click(getByRole('button', 'More actions for Purchase order lines'))

describe('CollectionRow', () => {
  it('shows the key only on hover, unless the filter matches it', () => {
    const { row } = renderRow()
    expect(getByText('Purchase order lines')).toBeTruthy()
    expect(queryByText('po_lines')).toBeNull()
    hover(row)
    expect(getByText('po_lines')).toBeTruthy()
    unhover(row)
    expect(queryByText('po_lines')).toBeNull()
  })

  it('shows the key with the match marked when the filter matches it', () => {
    const { container } = renderRow({ highlight: 'LINE' })
    const mark = container.querySelector('mark')
    expect(mark?.textContent).toBe('line')
    expect(container.querySelector('[data-key-text]')?.textContent).toBe('po_lines')
  })

  it('does not show the key when the filter only matches the name', () => {
    renderRow({ highlight: 'purchase' })
    expect(queryByText('po_lines')).toBeNull()
  })

  it('shows the note in both densities', () => {
    renderRow({ density: 'compact' })
    expect(getByText('One row per ordered item')).toBeTruthy()
  })

  it('hides counts and stat badges without a stat', () => {
    renderRow({ col: { ...col, hidden: true } })
    expect(queryByText('1,234')).toBeNull()
    expect(queryByText('Pipeline')).toBeNull()
    expect(queryByText('Form ×2')).toBeNull()
    // Badges from the collection itself still show.
    expect(getByText('Hidden')).toBeTruthy()
  })

  it('shows counts, last change and badges with a stat', () => {
    renderRow({ stat })
    expect(getByText('1,234')).toBeTruthy()
    expect(getByText('3h ago')).toBeTruthy()
    expect(getByText('Pipeline').closest('[data-tip]')?.getAttribute('data-tip')).toBe(
      'PO approval'
    )
    expect(getByText('Form ×2')).toBeTruthy()
  })

  it('shows Empty for zero rows and folds badges past three into +N', () => {
    renderRow({
      col: { ...col, hidden: true, singleton: true },
      stat: { ...stat, rows: 0, virtual: true, link: true }
    })
    expect(getByText('Empty')).toBeTruthy()
    // A link table never carries the Hidden badge (it has its own switch): 5 badges → +2.
    expect(getByText('+2')).toBeTruthy()
    expect(queryByText('Hidden')).toBeNull()
  })

  it('shows admins a Heavy list badge first, with the heavy columns in its tip', () => {
    const { container } = renderRow({
      col: { ...col, hidden: true, singleton: true },
      stat: { ...stat, virtual: true },
      heavyList: { fields: [{ field: 'units', label: 'Units', avg: 2280.6, max: 2341 }] }
    })
    const badge = container.querySelector('[data-badge="heavy-list"]')
    expect(badge?.textContent).toBe('Heavy list')
    expect(badge?.getAttribute('data-tip')).toContain('Units (up to 2,341 per record)')
    // First of the badges, so the cap of three never folds it into +N.
    expect(container.querySelector('[data-badge]')).toBe(badge)
  })

  it('never shows the Heavy list badge to non-admins', () => {
    const { container } = renderRow({
      isAdmin: false,
      editPath: undefined,
      menuExtra: undefined,
      onMove: undefined,
      heavyList: { fields: [{ field: 'units', label: 'Units', avg: 2280.6, max: 2341 }] }
    })
    expect(container.querySelector('[data-badge="heavy-list"]')).toBeNull()
    expect(queryByText('Heavy list')).toBeNull()
  })

  it('navigates through the host and records the open on click', () => {
    renderRow()
    const link = getByRole('link', /^Purchase order lines/)
    expect(link.getAttribute('href')).toBe('/collections/po_lines')
    click(link)
    expect(where).toBe('/collections/po_lines')
    expect(localStorage.getItem('nvr_collections_usage')).toContain('po_lines')
  })

  it('opens the host’s own records path', () => {
    renderRow({ recordsPath: '/records/po_lines' })
    const link = getByRole('link', /^Purchase order lines/)
    expect(link.getAttribute('href')).toBe('/records/po_lines')
    click(link)
    expect(where).toBe('/records/po_lines')
  })

  it('offers admins the host’s edit link', () => {
    renderRow({ isAdmin: true })
    expect(getByRole('link', 'Edit Purchase order lines').getAttribute('href')).toBe(
      '/data-model/po_lines'
    )
  })

  it('shows no edit link to non-admins, nor to admins when the host has no editor', () => {
    renderRow({ isAdmin: false })
    expect(queryByRole('link', /^Edit /)).toBeNull()
    cleanup()
    renderRow({ isAdmin: true, editPath: undefined })
    expect(queryByRole('link', /^Edit /)).toBeNull()
  })

  it('toggles selection instead of navigating while selecting', () => {
    const { props } = renderRow({ selecting: true })
    click(getByRole('link', /^Purchase order lines/))
    expect(props.onSelect).toHaveBeenCalledTimes(1)
    expect(where).toBe('/collections')
    expect(localStorage.getItem('nvr_collections_usage')).toBeNull()
    click(getByRole('checkbox', 'Select Purchase order lines'))
    expect(props.onSelect).toHaveBeenCalledTimes(2)
    expect(where).toBe('/collections')
  })

  it('stars a favorite without navigating', () => {
    const { props } = renderRow()
    click(getByRole('button', 'Add Purchase order lines to my favorites'))
    expect(props.onToggleFavorite).toHaveBeenCalledTimes(1)
    expect(where).toBe('/collections')
  })

  it('shows a filled star for a favorite', () => {
    renderRow({ favorite: true })
    expect(
      getByRole('button', 'Remove Purchase order lines from my favorites').getAttribute(
        'aria-pressed'
      )
    ).toBe('true')
  })

  it('offers admins a pin for everyone, separate from the star', () => {
    const onTogglePinned = vi.fn()
    renderRow({ onTogglePinned })
    click(getByRole('button', 'Pin Purchase order lines for everyone'))
    expect(onTogglePinned).toHaveBeenCalledTimes(1)
    expect(where).toBe('/collections')
  })

  it('shows a pinned collection as pinned to admins', () => {
    renderRow({ pinnedForAll: true, onTogglePinned: vi.fn() })
    expect(
      getByRole('button', 'Unpin Purchase order lines for everyone').getAttribute('aria-pressed')
    ).toBe('true')
  })

  it('gives non-admins no pin control', () => {
    renderRow({ isAdmin: false, pinnedForAll: true })
    expect(queryByRole('button', /for everyone/)).toBeNull()
  })

  it('menu: favorites in personal words, pin for everyone for admins, moves when offered', async () => {
    const onMoveUp = vi.fn()
    renderRow({ onTogglePinned: vi.fn(), pinnedForAll: true, onMoveUp })
    openMenu()
    expect(await waitFor(() => queryByText('Add to my favorites'))).toBeTruthy()
    expect(getByText('Unpin for everyone')).toBeTruthy()
    expect(queryByText('Move down')).toBeNull()
    click(getByText('Move up'))
    expect(onMoveUp).toHaveBeenCalledTimes(1)
  })

  it('menu gives non-admins only the personal favorite', async () => {
    renderRow({ isAdmin: false, favorite: true })
    openMenu()
    expect(await waitFor(() => queryByText('Remove from my favorites'))).toBeTruthy()
    expect(queryByText(/for everyone/)).toBeNull()
    expect(queryByText(/^Pin$|^Unpin$/)).toBeNull()
  })

  it('menu offers the host’s items to admins', async () => {
    renderRow()
    openMenu()
    expect(await waitFor(() => queryByText('Open records'))).toBeTruthy()
    expect(getByText('Fields')).toBeTruthy()
    expect(getByText('Form layouts')).toBeTruthy()
    expect(getByText('Move to folder')).toBeTruthy()
    click(getByText('Relations'))
    expect(where).toBe('/data-model/po_lines?tab=relations')
  })

  it('menu hides the host’s items from non-admins', async () => {
    renderRow({ isAdmin: false })
    openMenu()
    expect(await waitFor(() => queryByText('Open records'))).toBeTruthy()
    expect(getByText('Open in new tab')).toBeTruthy()
    expect(getByText('Copy key')).toBeTruthy()
    for (const label of ['Fields', 'Relations', 'Form layouts', 'Move to folder'])
      expect(queryByText(label)).toBeNull()
  })

  it('menu has no Move to folder without a host that can move', async () => {
    renderRow({ onMove: undefined, menuExtra: undefined })
    openMenu()
    expect(await waitFor(() => queryByText('Open records'))).toBeTruthy()
    expect(queryByText('Move to folder')).toBeNull()
    expect(queryByText('Fields')).toBeNull()
  })

  it('moves to a folder from the menu', async () => {
    const onMove = vi.fn()
    renderRow({
      onMove,
      folders: [
        { key: 'finance', label: 'Finance', color: null },
        { key: 'ops', label: 'Operations', color: '#f00' }
      ]
    })
    openMenu()
    click(await waitFor(() => queryByText('Move to folder')))
    click(await waitFor(() => queryByText('Operations')))
    expect(onMove).toHaveBeenCalledWith('ops')
  })

  it('opens the summary card after a pause on the name (admins only)', async () => {
    summary = {
      collection: 'po_lines',
      fields: [{ field: 'qty', label: 'Quantity', type: 'integer' }],
      field_count: 12,
      relations_out: [{ field: 'po', collection: 'purchase_orders' }],
      relations_in: [],
      pipeline: null,
      forms: 1,
      last_edit: null
    }
    renderRow()
    hover(getByText('Purchase order lines'), 'pointer')
    expect(await waitFor(() => queryByText('Quantity'))).toBeTruthy()
    expect(getByText('12 fields')).toBeTruthy()
    expect(getByText('Purchase Orders')).toBeTruthy()
    expect(requests.map((r) => r._path)).toContain('/collections/po_lines/summary')
  })

  it('never asks for the summary for non-admins', async () => {
    renderRow({ isAdmin: false })
    hover(getByText('Purchase order lines'), 'pointer')
    await new Promise((r) => setTimeout(r, 600))
    expect(requests).toHaveLength(0)
    expect(queryByRole('dialog', 'Purchase order lines summary')).toBeNull()
  })
})
