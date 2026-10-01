import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'

// Deep link /issues/:id — the global setup mocks useParams to {}, override it per test.
let routeId: string | undefined = '292'
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => (routeId ? { id: routeId } : {}),
    useLocation: () => ({ pathname: '/issues', search: '', hash: '', state: null })
  }
})

import { IssuesPage } from './Issues'

const getMock = api.get as unknown as ReturnType<typeof vi.fn>
const patchMock = api.patch as unknown as ReturnType<typeof vi.fn>
const RAISER = '7A0411F3-C687-40E5-ADF5-614157CF88EC'

const issue = (id: number, status = 'open') => ({
  id,
  collection: null,
  item: null,
  title: `[server] GET /api/items/:collection: failure ${id}`,
  severity: 'high',
  status,
  assigned_to: null,
  raised_by: RAISER,
  resolution_notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IssuesPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('Issues deep link', () => {
  let linkedStatus = 'open'
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn() // jsdom has no layout
    routeId = '292'
    linkedStatus = 'open'
    getMock.mockReset()
    patchMock.mockReset()
    patchMock.mockResolvedValue({ data: { data: {} } })
    getMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/issues/summary'))
        return { data: { data: { by_status: {}, by_severity: {} } } }
      if (url === '/issues/292') return { data: { data: issue(292, linkedStatus) } }
      if (url === '/issues/999') throw Object.assign(new Error('nf'), { response: { status: 404 } })
      if (url.startsWith('/issues')) return { data: { data: [] } } // newest 200 hold neither
      if (url.startsWith('/users'))
        return {
          data: {
            data: [
              { id: RAISER.toLowerCase(), first_name: 'Beth', last_name: 'Ray', email: 'b@x.io' }
            ]
          }
        }
      return { data: { data: [] } }
    })
  })

  it('pins an issue missing from the list, expands it, names the raiser and selects it in all', async () => {
    renderPage()
    await waitFor(() => expect(document.getElementById('issue-row-292')).not.toBeNull())
    // the empty list does not hide the pinned row, and the raiser is a name, never a uuid
    expect(screen.queryByText('No issues found')).toBeNull()
    expect(screen.getAllByText('Beth Ray').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain(RAISER)
    // expanded: the detail panel is open under the row
    await waitFor(() => expect(screen.getByText('Transition:', { exact: false })).toBeTruthy())
    const all = document.querySelector('thead input[type=checkbox]') as HTMLInputElement
    act(() => {
      fireEvent.click(all)
    })
    expect(screen.getByText(/1 selected/)).toBeInTheDocument()
  })

  it('refreshes the pinned row after an edit (it lives under the issues key)', async () => {
    renderPage()
    await waitFor(() => expect(document.getElementById('issue-row-292')).not.toBeNull())
    const linkedCalls = () => getMock.mock.calls.filter((c) => c[0] === '/issues/292').length
    const before = linkedCalls()
    const resolve = await screen.findByRole('button', { name: 'resolved' })
    linkedStatus = 'resolved'
    act(() => {
      fireEvent.click(resolve)
    })
    await waitFor(() => expect(linkedCalls()).toBeGreaterThan(before))
    await waitFor(() =>
      expect(document.getElementById('issue-row-292')?.textContent).toMatch(/resolved/i)
    )
  })

  it('says so when the linked issue does not exist', async () => {
    routeId = '999'
    renderPage()
    await waitFor(() => expect(document.getElementById('issue-linked-missing')).not.toBeNull())
    expect(screen.getByText(/Issue #999 was not found/)).toBeInTheDocument()
    expect(getMock.mock.calls.filter((c) => c[0] === '/issues/999')).toHaveLength(1)
  })
})
