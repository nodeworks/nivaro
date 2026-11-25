import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub fleet tab: one row per environment from GET /api/hub/fleet; the health filter narrows it;
// owners see no Check now and no rules card.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), admin: true }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string) => h.post(url),
    put: (url: string, b: unknown) => h.put(url, b),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', is_admin: h.admin } }) }))

const { default: HubFleet } = await import('./HubFleet')

const row = (over: Record<string, unknown>) => ({
  app_id: 1,
  app_key: 'efp',
  app_name: 'EFP',
  environment_id: 1,
  env_key: 'production',
  env_status: 'active',
  position: 1,
  base_url: 'https://efp.example.com',
  placement: 'dedicated',
  shared_key: null,
  version: '0.3.214',
  version_since: '2026-11-20T10:00:00Z',
  behind: 0,
  state: 'ok',
  preflight: 'ok',
  readiness_score: 95,
  open_issues: 2,
  failing: [],
  error: null,
  checked_at: '2026-11-24T10:00:00Z',
  up: true,
  probed_at: '2026-11-24T10:00:00Z',
  uptime_24h: 100,
  uptime_30d: 99.98,
  slo: { month: '2026-11', target: 99.5, uptime: 99.99, met: true, left_samples: 100 },
  last_deploy: null,
  deployed_at: '2026-11-20T10:00:00Z',
  alerts: [],
  ...over
})

function wire(admin: boolean) {
  h.admin = admin
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/fleet')
      return {
        data: {
          data: {
            newest: '0.3.214',
            hub_version: '0.3.214',
            generated_at: '2026-11-24T10:00:00Z',
            unprobed: 0,
            rows: [
              row({}),
              row({
                environment_id: 3,
                env_key: 'preview',
                version: '9.0.0',
                behind: null,
                version_unverified: true
              }),
              row({
                environment_id: 2,
                env_key: 'staging',
                version: '0.3.200',
                behind: 14,
                up: false,
                alerts: [
                  {
                    id: 9,
                    rule_id: 'behind-newest',
                    kind: 'behind_newest',
                    message: 'efp/staging runs 0.3.200',
                    opened_at: null
                  }
                ]
              })
            ]
          }
        }
      }
    if (url === '/hub/fleet/settings')
      return {
        data: {
          data: { rules: [], slo: { default_target: 99.5, targets: {} }, report_enabled: true }
        }
      }
    throw new Error(`unexpected ${url}`)
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HubFleet />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HubFleet', () => {
  it('lists every environment with drift, alerts and the down count', async () => {
    wire(true)
    renderPage()
    expect(await screen.findByText('14 behind')).toBeTruthy()
    expect(screen.getByText('1 not answering')).toBeTruthy()
    // A version above every known release is flagged, never counted as behind.
    expect(screen.getByText('not a known release')).toBeTruthy()
    expect(screen.getByText(/^Behind/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Check now/ })).toBeTruthy()
    // The rules card opens from the header; a summary count filters the table.
    expect(screen.queryByText('Alert rules and uptime targets')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Rules and targets/ }))
    expect(await screen.findByText('Alert rules and uptime targets')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '1 not answering' }))
    expect(within(screen.getByRole('table')).queryByText('0.3.214')).toBeNull()
  })

  it('owners get no Check now and no rules card', async () => {
    wire(false)
    renderPage()
    await screen.findByText('14 behind')
    expect(screen.queryByRole('button', { name: /Check now/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Rules and targets/ })).toBeNull()
    expect(h.get).not.toHaveBeenCalledWith('/hub/fleet/settings')
  })

  it('the search narrows the table', async () => {
    wire(true)
    renderPage()
    await screen.findByText('14 behind')
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'staging' } })
    const table = screen.getByRole('table')
    expect(within(table).queryByText('0.3.214')).toBeNull()
    expect(within(table).getByText('0.3.200')).toBeTruthy()
  })
})
