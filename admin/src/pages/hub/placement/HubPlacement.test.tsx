import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { movePrefill } from '../move/move-prefill'
import type { ChargebackReport, PeerFleet, PlacementMap } from './placement-api'
import { moveToHostPath, peerLink, stackNameFor } from './placement-api'

// Hub placement screens (ideas 48–50): Hosts (regions, hosts, run an unplaced environment here,
// Move… to another host), Costs (report, departments) and Other Hubs on the Fleet tab (read
// only, the one link built from the stored address).

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  admin: true
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: unknown) => h.get(url, opts),
    post: (url: string, body: unknown) => h.post(url, body),
    put: (url: string, body: unknown) => h.put(url, body),
    patch: (url: string, body: unknown) => h.patch(url, body),
    delete: (url: string) => h.del(url)
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { is_admin: h.admin } }) }))

const { default: HubHosts } = await import('./HubHosts')
const { default: HubCosts } = await import('./HubCosts')
const { FederatedFleet } = await import('./FederatedFleet')

const MAP: PlacementMap = {
  regions: [
    {
      id: 1,
      key: 'eu',
      name: 'EU West',
      note: null,
      cost_percent: 120,
      position: 0,
      hosts: [
        {
          driver_id: 7,
          name: 'host-a',
          label: 'rack 4',
          region_id: 1,
          environments: [
            {
              env_id: 11,
              app_id: 1,
              app_key: 'shop',
              app_name: 'Shop',
              env_key: 'production',
              status: 'active',
              stack: 'shop-prod'
            }
          ],
          shared: [],
          figures: {
            cpu_pct: 40,
            memory_mb: 512,
            storage_bytes: 1024,
            sampled_at: '2026-11-25T10:00:00Z'
          }
        }
      ]
    }
  ],
  ungrouped: [
    {
      driver_id: 8,
      name: 'host-b',
      label: null,
      region_id: null,
      environments: [],
      shared: [],
      figures: { cpu_pct: null, memory_mb: null, storage_bytes: null, sampled_at: null }
    }
  ],
  unplaced: [
    { env_id: 12, app_id: 2, app_key: 'crm', app_name: 'CRM', env_key: 'staging', status: 'active' }
  ]
}

const REPORT: ChargebackReport = {
  generated_at: '2026-11-25T10:00:00Z',
  window_days: 30,
  currency: 'USD',
  rates: {
    cpu_core_month: 10,
    memory_gb_month: 2,
    storage_gb_month: 0,
    database_gb_month: 0,
    environment_month: 5
  },
  apps: [
    {
      app_id: 1,
      app_key: 'shop',
      app_name: 'Shop',
      department: 'Retail',
      cost_center: 'CC-1',
      owners: [{ user_id: 'u', name: 'Olive Owner' }],
      environments: [
        {
          env_id: 11,
          env_key: 'production',
          runs_on: 'host-a',
          region: 'EU West',
          usage: { cpu_cores: 2, memory_gb: 2, storage_gb: null, database_gb: null },
          cost: {
            cpu: 20,
            memory: 4,
            storage: 0,
            database: 0,
            environment: 5,
            subtotal: 29,
            factor_percent: 120,
            total: 34.8
          },
          gaps: ['storage', 'database size']
        }
      ],
      total: 34.8
    }
  ],
  departments: [{ key: 'retail', label: 'Retail', apps: 1, total: 34.8 }],
  owners: [{ key: 'u', label: 'Olive Owner', apps: 1, total: 34.8 }],
  total: 34.8,
  unrated: false
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  h.admin = true
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/placement') return { data: { data: MAP } }
    if (url === '/hub/chargeback') return { data: { data: REPORT } }
    throw new Error(`unexpected GET ${url}`)
  })
  h.post.mockResolvedValue({ data: { data: { placement_id: 99 } } })
  h.put.mockResolvedValue({ data: { data: {} } })
})
afterEach(() => vi.clearAllMocks())

describe('placement helpers', () => {
  it('opens the move panel with a new stack on the host picked', () => {
    const path = moveToHostPath(1, 11, 8)
    expect(path).toBe('/hub?app=1&move=11&to=new:8')
    expect(movePrefill(11, path.slice(path.indexOf('?')))).toEqual({ open: true, pick: 'new:8' })
    expect(movePrefill(11, '?move=11&to=dedicated:5').pick).toBe('dedicated:5')
    expect(movePrefill(11, '?move=11&to=javascript:1').pick).toBe('')
  })

  it('names a stack by the stack rule', () => {
    expect(stackNameFor('shop', 'production')).toBe('shop-production')
    expect(stackNameFor('9lives', 'x')).toMatch(/^[a-z][a-z0-9-]{1,40}$/)
    expect(stackNameFor('a'.repeat(50), 'prod').length).toBeLessThanOrEqual(41)
  })

  it('links a remote row only on the stored origin with a plain host-relative path', () => {
    expect(peerLink('https://hub.other.example', '/hub?app=5')).toBe(
      'https://hub.other.example/hub?app=5'
    )
    expect(peerLink('https://hub.other.example', '//evil.example/hub?app=5')).toBeNull()
    expect(peerLink('https://hub.other.example', 'javascript:alert(1)')).toBeNull()
    expect(peerLink('javascript:alert(1)', '/hub?app=5')).toBeNull()
    // Review L2: https only; no stored address, no link.
    expect(peerLink('http://hub.other.example', '/hub?app=5')).toBeNull()
    expect(peerLink(null, '/hub?app=5')).toBeNull()
  })
})

describe('Hosts tab', () => {
  it('shows regions, hosts, what runs there and a Move… link per environment', async () => {
    wrap(<HubHosts />)
    expect((await screen.findAllByText('EU West')).length).toBeGreaterThan(0)
    expect(screen.getByText('host-a')).toBeTruthy()
    expect(screen.getByText('rack 4')).toBeTruthy()
    expect(screen.getByText(/Priced at 120% of the rates/)).toBeTruthy()
    const move = screen.getByRole('link', { name: /Move…/ })
    expect(move.getAttribute('href')).toBe('/hub?app=1&move=11&to=new:7')
    expect(screen.getByText('Hosts in no region')).toBeTruthy()
    expect(screen.getByText('Not running anywhere yet')).toBeTruthy()
  })

  it('is for administrators only', () => {
    h.admin = false
    wrap(<HubHosts />)
    expect(screen.getByText(/for Hub administrators/)).toBeTruthy()
    expect(h.get).not.toHaveBeenCalled()
  })
})

describe('Costs tab', () => {
  it('shows the totals, the department bars and the per-app breakdown', async () => {
    wrap(<HubCosts />)
    expect((await screen.findAllByText('$34.80')).length).toBeGreaterThan(0)
    expect(screen.getByText('By department')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Owner' }))
    expect(screen.getByText(/totals overlap/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Shop$/ }))
    expect(await screen.findByText(/Not measured: storage, database size/)).toBeTruthy()
    expect(screen.getByText(/×120%/)).toBeTruthy()
  })

  it('saves an app’s department', async () => {
    wrap(<HubCosts />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the department of Shop' }))
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Sales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith('/hub/chargeback/apps/1', {
        department: 'Sales',
        cost_center: 'CC-1'
      })
    )
  })
})

describe('Other Hubs (Fleet tab)', () => {
  const FLEET: PeerFleet[] = [
    {
      peer_id: 3,
      name: 'US Hub',
      base_url: 'https://hub.us.example',
      link_base: 'https://hub.us.example',
      ok: false,
      error: 'PEER_UNREACHABLE',
      error_text: 'The other Hub did not answer.',
      stale: true,
      fetched_at: '2026-11-25T09:00:00Z',
      version: '0.3.215',
      newest: '0.3.215',
      rows: [
        {
          app_id: 5,
          app_key: 'billing',
          app_name: '<img src=x onerror=alert(1)>',
          environment_id: 50,
          env_key: 'production',
          env_status: 'active',
          host: 'billing.us.example',
          placement: 'dedicated',
          version: '0.3.214',
          behind: 1,
          state: 'ok',
          up: true,
          uptime_30d: 99.9,
          open_issues: 0,
          alerts: 0,
          checked_at: null,
          deployed_at: null,
          path: '/hub?app=5'
        }
      ]
    }
  ]

  it('tags remote apps with their Hub, renders names as text, says when the answer is stale', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/federation/peers')
        return {
          data: {
            data: [
              {
                id: 3,
                name: 'US Hub',
                base_url: 'https://hub.us.example',
                token: '••••••',
                enabled: true,
                last_ok_at: null,
                last_tried_at: null,
                last_error: 'PEER_UNREACHABLE',
                last_count: null
              }
            ]
          }
        }
      if (url === '/hub/federation/fleet') return { data: { data: FLEET } }
      throw new Error(`unexpected GET ${url}`)
    })
    const { container } = wrap(<FederatedFleet />)
    expect(await screen.findByText('US Hub')).toBeTruthy()
    expect(screen.getByText(/Showing the last answer/)).toBeTruthy()
    const row = screen.getByText(/<img src=x onerror=alert\(1\)>/)
    expect(row).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    const open = screen.getByRole('link', { name: /Open .* on US Hub/ })
    expect(open.getAttribute('href')).toBe('https://hub.us.example/hub?app=5')
    expect(open.getAttribute('rel')).toContain('noopener')
    // No action reaches the other Hub from here: no buttons inside its rows.
    const table = container.querySelector('table') as HTMLElement
    expect(within(table).queryAllByRole('button')).toHaveLength(0)
  })

  it('offers to add a Hub when none is registered', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/federation/peers') return { data: { data: [] } }
      throw new Error(`unexpected GET ${url}`)
    })
    wrap(<FederatedFleet />)
    expect(await screen.findByText(/No other Hub yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Add a Hub/ }))
    expect(screen.getByLabelText('API key (hub:read)')).toBeTruthy()
  })
})
