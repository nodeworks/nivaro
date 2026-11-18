import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { DashboardPage } from '../Dashboard'

const who = vi.hoisted(() => ({ admin: true }))
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'me', first_name: 'Robert', email: 'r@x', is_admin: who.admin, role: 'R1' }
  })
}))
vi.mock('@/lib/useUiPermissions', () => ({ useUiPermissions: () => new Set<string>() }))
vi.mock('@/lib/socket', () => ({
  getSocket: () => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() })
}))
vi.mock('@nivaro/react', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  FirstLoginChecklist: () => null
}))

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const post = api.post as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
;(api as unknown as { put: unknown }).put = vi.fn().mockResolvedValue({ data: { data: {} } })

const STATS = {
  figures: [
    { key: 'records_changed', value: 38, previous: 30, compare: 'yesterday' },
    { key: 'people_active', value: 12, previous: 12, compare: 'yesterday' },
    { key: 'failed_jobs', value: 2, previous: 0, compare: 'previous_24h' },
    { key: 'open_issues', value: 5, previous: 6, compare: 'previous_24h' }
  ],
  hourly: Array.from({ length: 24 }, (_, i) => i % 5),
  day_start: '2026-10-29T04:00:00.000Z',
  scope: 'all',
  computed_at: '2026-10-29T22:00:00.000Z'
}

const ISSUES = [
  {
    id: 41,
    title: '[server] GET /api/items/:collection: Request timed out',
    severity: 'critical',
    status: 'open',
    source: 'server',
    occurrence_count: 12,
    people: 4,
    last_seen_at: new Date(Date.now() - 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 86_400_000).toISOString()
  },
  {
    id: 42,
    title: '[client] /collections/orders/5: nn.find is not a function',
    severity: 'medium',
    status: 'in_progress',
    source: 'client',
    details: 'Route: /collections/:c/:id\nCrash: app=efp-new; release=0.3.131; kind=error',
    occurrence_count: 1,
    last_seen_at: new Date(Date.now() - 7_200_000).toISOString(),
    created_at: new Date(Date.now() - 7_200_000).toISOString()
  }
]
const layout = vi.hoisted(() => ({ current: null as unknown }))

function answer() {
  get.mockImplementation((url: string) => {
    const ok = (data: unknown) => Promise.resolve({ data: { data } })
    if (url.startsWith('/issues?'))
      return Promise.resolve({ data: { data: ISSUES, meta: { total: 11 } } })
    switch (url) {
      case '/issues/summary':
        return ok({ active_by_severity: { critical: 1, high: 2, medium: 8 } })
      case '/overview/stats':
        return ok(STATS)
      case '/overview/prefs':
        return ok({
          layout: layout.current,
          role_default: null,
          pinned_actions: [{ path: '/roles', label: 'Roles' }],
          dismissed_actions: [],
          pinned_widgets: []
        })
      case '/overview/since':
        return ok({
          since: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          clamped: false,
          records_changed: 38,
          my_records_changed: 2,
          my_records: [
            { collection: 'orders', item: '7', changes: 3, last_at: new Date().toISOString() }
          ],
          new_people: 1,
          people: [{ id: 'p1', name: 'Pat' }],
          failed_jobs: 0,
          release: null
        })
      case '/overview/my-routes':
        return ok([{ path: '/flows', opens: 9 }])
      case '/my-work':
        return ok({
          tasks: [],
          counts: {
            owned: 3,
            owned_breached: 1,
            owned_warning: 0,
            tasks: 1,
            team_tasks: 0,
            approvals: 0,
            notifications: 2,
            questions: 0
          }
        })
      case '/health':
        return Promise.resolve({
          data: {
            status: 'ok',
            version: '0.3.57',
            environment: 'development',
            db: { status: 'connected', database: 'EFP_Development' },
            redis: { status: 'connected' }
          }
        })
      default:
        return ok([])
    }
  })
  post.mockImplementation((url: string) =>
    Promise.resolve({
      data: {
        data:
          url === '/overview/visit'
            ? { prev_visit_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }
            : {}
      }
    })
  )
}

function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  who.admin = true
  layout.current = null
  get.mockReset()
  post.mockReset()
  localStorage.clear()
  answer()
})

describe('Overview page', () => {
  it('greets with what needs the person and what changed on their records', async () => {
    mount()
    const h1 = await screen.findByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('Robert')
    expect(await screen.findByText(/4 things need you, 2 changed on your records/)).toBeTruthy()
    expect(await screen.findByText(/38 records changed, 2 of yours, 1 new person/)).toBeTruthy()
  })

  it('shows one stat line with deltas and drill-down links', async () => {
    mount()
    const records = await screen.findByText('Records changed today')
    const link = records.closest('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('/activity?from=')
    expect(within(link).getByText('+8')).toBeTruthy()
    expect(screen.getByText('Failed jobs, 24 h').closest('a')?.getAttribute('href')).toBe('/jobs')
    expect(screen.getByText('Open issues').closest('a')?.getAttribute('href')).toBe('/issues')
  })

  it('puts pinned quick actions first, then usage', async () => {
    mount()
    const unpin = await screen.findByRole('button', { name: 'Unpin Roles' })
    expect(unpin).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('button', { name: 'Pin Automations' })).toBeTruthy()
  })

  it('offers the activity scopes the person may use and remembers the choice', async () => {
    mount()
    const group = await screen.findByRole('radiogroup', { name: 'Whose activity' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent)
    ).toEqual(['Everyone', 'Mine', 'My records'])
    fireEvent.click(within(group).getByRole('radio', { name: 'Mine' }))
    expect(localStorage.getItem('nivaro_overview_activity_scope:me')).toBe('mine')
  })

  it('keeps the instance facts and Everyone scope for administrators only', async () => {
    who.admin = false
    mount()
    const group = await screen.findByRole('radiogroup', { name: 'Whose activity' })
    expect(within(group).queryByRole('radio', { name: 'Everyone' })).toBeNull()
    expect(screen.queryByText('This instance')).toBeNull()
    expect(screen.getByText('Your work')).toBeTruthy()
  })

  it('opens Customize with keyboard-reachable order and visibility controls', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Customize/ }))
    expect(screen.getByRole('button', { name: 'Move Recently viewed up' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Show Recent activity' })).toBeTruthy()
  })

  it('shows open issues in the side column for administrators', async () => {
    mount()
    const heading = await screen.findByRole('heading', { name: /^Issues/ })
    await vi.waitFor(() => expect(heading).toHaveTextContent('1 critical'))
    expect(heading).toHaveTextContent('2 high')
    expect(heading).toHaveTextContent('11 open')
    const side = screen.getByRole('complementary')
    const list = await within(side).findByRole('list', { name: 'Issues' })
    const first = within(list).getByRole('link', { name: 'Request timed out' })
    expect(first.getAttribute('href')).toBe('/issues/41?status=active')
    expect(within(list).getByText('12× · 4 people')).toBeTruthy()
    expect(within(list).getByText('Browser').closest('[data-tip]')?.getAttribute('data-tip')).toBe(
      'efp-new, build 0.3.131'
    )
    expect(within(list).getByText('In progress')).toBeTruthy()
    // GitLab sync is off: no GitLab column, chips or filters.
    expect(within(list).queryByText('Not in GitLab')).toBeNull()
    expect(screen.queryByRole('button', { name: 'In GitLab' })).toBeNull()
    expect(screen.getByRole('link', { name: '9 more in the issue log' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Issues' }).getAttribute('href')).toBe(
      '/issues?status=active'
    )
  })

  it('switches to New today and remembers it', async () => {
    mount()
    const today = await screen.findByRole('button', { name: 'New today' })
    expect(today.textContent).toBe('Today')
    fireEvent.click(today)
    expect(today).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('nvr:overview-issues-filter:me')).toBe('new-today')
    await vi.waitFor(() =>
      expect(get.mock.calls.some(([u]) => String(u).includes('created_after='))).toBe(true)
    )
  })

  it('draws a table when placed in the main column', async () => {
    layout.current = { order: [], hidden: [], shown: [], columns: { issues: 'main' } }
    mount()
    const list = await screen.findByRole('list', { name: 'Issues' })
    expect(screen.getByRole('complementary').contains(list)).toBe(false)
    expect(screen.getByText('Happened')).toBeTruthy()
    expect(within(list).getByText('GET /api/items/:collection')).toBeTruthy()
    expect(within(list).getByText('efp-new')).toBeTruthy()
  })

  it('offers moving Issues between columns in Customize', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Customize/ }))
    expect(screen.getByRole('button', { name: 'Move Issues to the main column' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Move Your work to the/ })).toBeNull()
  })

  it('keeps Issues for administrators only', async () => {
    who.admin = false
    mount()
    await screen.findByText('Your work')
    expect(screen.queryByRole('heading', { name: /^Issues/ })).toBeNull()
  })
})
