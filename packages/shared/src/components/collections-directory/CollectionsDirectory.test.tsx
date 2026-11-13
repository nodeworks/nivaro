// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { CollectionsDirectory, type CollectionsDirectoryProps } from './CollectionsDirectory'
import {
  cleanup,
  click,
  getByRole,
  getByText,
  mount,
  queryByRole,
  queryByText,
  typeInto,
  waitFor
} from './test-kit'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
  window.matchMedia ??= (() => ({ matches: false })) as never
})

type Cmd = { _method: string; _path: string; _body?: unknown }
const calls: Cmd[] = []
let prefs: Record<string, unknown> = {}

const ROWS = [
  { collection: 'finance', display_name: 'Finance', sort: 1 }, // folder
  { collection: 'invoices', display_name: 'Invoices', group: 'finance' },
  { collection: 'vendors', display_name: 'Vendors', group: 'finance' },
  { collection: 'notes', display_name: 'Notes' },
  { collection: 'nivaro_users', display_name: 'Users' },
  { collection: 'secret', display_name: 'Secret', hidden: true }
]

const client = {
  request: vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    if (cmd._method === 'PATCH') return { data: {} }
    switch (cmd._path) {
      case '/collections':
        return { data: ROWS }
      case '/collection-pins':
        return { data: { collections: ['vendors'] } }
      case '/collections/overview-stats':
        return {
          data: {
            invoices: {
              rows: 42,
              changed_at: null,
              pipeline: null,
              forms: 0,
              imports: 0,
              link: false,
              virtual: false
            }
          }
        }
      case '/users/me':
        return { data: { preferences: prefs } }
      default:
        return { data: null }
    }
  })
}

let where = '/'
const navigate = vi.fn((p: string) => {
  where = p
})

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
  prefs = {
    nav_favorites: [
      { label: 'Notes', path: '/collections/notes' },
      { label: 'Dashboard', path: '/dashboards/1' }
    ],
    nav_favorite_groups: []
  }
  where = '/'
})
afterEach(cleanup)

function renderDirectory(props: Partial<CollectionsDirectoryProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(
    <QueryClientProvider client={qc}>
      <NivaroProvider client={client as never}>
        <NavigationContext.Provider value={{ navigate }}>
          <CollectionsDirectory isAdmin {...props} />
        </NavigationContext.Provider>
      </NivaroProvider>
    </QueryClientProvider>
  )
}

const rowLink = (name: RegExp) => getByRole('link', name)

describe('CollectionsDirectory', () => {
  it('lists folders, Not in a folder, Pinned and My favorites for an admin without host tools', async () => {
    renderDirectory({
      title: 'All data',
      collectionPath: (c) => `/records/${c}`,
      include: (c) => !c.collection.startsWith('nivaro_')
    })
    await waitFor(() => queryByText('Invoices'))
    expect(document.querySelector('h1')?.textContent).toBe('All data')
    expect(getByText('Finance')).toBeTruthy()
    expect(getByText('Not in a folder')).toBeTruthy()
    // Pinned for everyone and the person's own favorites (from the shared store).
    await waitFor(() =>
      document.querySelector('[data-collections-pinned] [data-collection="vendors"]')
    )
    await waitFor(() =>
      document.querySelector('[data-collections-favorites]')?.textContent?.includes('Notes')
    )
    // Filtered out by the host; hidden folded away.
    expect(queryByText('Users')).toBeNull()
    expect(queryByText('Secret')).toBeNull()
    // Admin stats show; editing tools the host did not pass do not.
    await waitFor(() => queryByText('42'))
    expect(queryByRole('button', 'Arrange')).toBeNull()
    expect(queryByRole('button', 'Select')).toBeNull()
    expect(queryByRole('link', /^Edit /)).toBeNull()
    // Rows open on the host's own path.
    const link = rowLink(/^Invoices/)
    expect(link.getAttribute('href')).toBe('/records/invoices')
    click(link)
    expect(where).toBe('/records/invoices')
  })

  it('stars into the shared favorites store, keeping the other favorites', async () => {
    renderDirectory()
    await waitFor(() => queryByText('Invoices'))
    await waitFor(() =>
      document.querySelector('[data-collections-favorites]')?.textContent?.includes('Notes')
    )
    click(getByRole('button', 'Add Invoices to my favorites'))
    await waitFor(() => calls.some((c) => c._method === 'PATCH'))
    const body = calls.find((c) => c._method === 'PATCH')?._body as {
      nav_favorites: Array<{ path: string }>
    }
    expect(calls.find((c) => c._method === 'PATCH')?._path).toBe('/users/me/preferences')
    expect(body.nav_favorites.map((f) => f.path)).toEqual([
      '/collections/notes',
      '/dashboards/1',
      '/collections/invoices'
    ])
  })

  it('uses the host favorites when given and never reads the store', async () => {
    const toggle = vi.fn()
    renderDirectory({ favorites: { favorite: new Set(['invoices']), toggle } })
    await waitFor(() => queryByText('Invoices'))
    expect(calls.some((c) => c._path === '/users/me')).toBe(false)
    click(getByRole('button', 'Remove Invoices from my favorites'))
    expect(toggle).toHaveBeenCalledWith('invoices', 'Invoices')
  })

  it('turns on the host tools it is given', async () => {
    renderDirectory({
      admin: {
        editPath: (c) => `/data-model/${c}`,
        reorder: vi.fn(async () => undefined),
        moveCollections: vi.fn(async () => undefined),
        renderMoveDialog: () => null,
        toolbarActions: <button type='button'>New table</button>
      }
    })
    await waitFor(() => queryByText('Invoices'))
    expect(getByRole('button', 'Arrange')).toBeTruthy()
    expect(getByRole('button', 'Select')).toBeTruthy()
    expect(getByRole('button', 'New table')).toBeTruthy()
    expect(getByRole('link', 'Edit Invoices').getAttribute('href')).toBe('/data-model/invoices')
  })

  it('gives a non-admin no stats, no admin views and no host tools', async () => {
    renderDirectory({
      isAdmin: false,
      admin: {
        editPath: (c) => `/data-model/${c}`,
        toolbarActions: <button type='button'>New table</button>
      }
    })
    await waitFor(() => queryByText('Invoices'))
    expect(calls.some((c) => c._path === '/collections/overview-stats')).toBe(false)
    expect(queryByRole('radio', 'Most records')).toBeNull()
    expect(queryByRole('button', 'New table')).toBeNull()
    expect(queryByRole('link', /^Edit /)).toBeNull()
  })

  it('helps an empty search: near spellings and folded-away matches', async () => {
    renderDirectory()
    await waitFor(() => queryByText('Invoices'))
    const input = getByRole('textbox', 'Filter collections') as HTMLInputElement
    const type = (v: string) => typeInto(input, v)
    type('secre')
    await waitFor(() => document.querySelector('[data-collections-empty-search]'))
    expect(getByText(/1 hidden collection matches/)).toBeTruthy()
    type('invoces')
    await waitFor(() => queryByText(/Did you mean/))
    expect(getByRole('link', 'Invoices').getAttribute('href')).toBe('/collections/invoices')
  })
})
