import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { movePrefill } from '../move/move-prefill'
import type { Advice, CapacityOverview } from './capacity-api'

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  admin: true
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: unknown) => h.get(url, opts),
    post: (url: string, body: unknown) => h.post(url, body),
    put: (url: string, body: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { is_admin: h.admin } }) }))

const { default: HubCapacity } = await import('./HubCapacity')

const fig = (over: Partial<CapacityOverview['shared'][number]['latest']> = {}) => ({
  sampled_at: '2026-11-24T12:00:00.000Z',
  cpu_pct: 40,
  memory_mb: 900,
  requests_per_min: 100,
  busy_ms_per_min: 1000,
  errors_per_min: 0,
  db_in_use: 4,
  db_waiting: 0,
  db_pool_max: 5,
  jobs_running: 1,
  jobs_waiting: 0,
  storage_bytes: 1024 * 1024,
  processes: 2,
  error: null,
  ...over
})

const OVERVIEW: CapacityOverview = {
  generated_at: '2026-11-24T12:00:00.000Z',
  settings: {
    most_share: 0.5,
    min_samples: 96,
    fits: { max_rpm: 30, max_memory_mb: 768, max_db_in_use: 3, max_storage_gb: 20 },
    outgrew: { share: 0.5, sustained: 0.6, max_rpm: 600 }
  },
  shared: [
    {
      id: 4,
      key: 'pool-a',
      name: 'Pool A',
      status: 'active',
      pool_budget: 40,
      latest: fig(),
      trend: [],
      apps: [
        {
          env_id: 21,
          app_id: 1,
          app_key: 'acme',
          app_name: 'Acme',
          env_key: 'prod',
          tenant_id: 'acme-e21',
          latest: fig({ requests_per_min: 80, cpu_pct: 30 }),
          share: { requests: 0.8, busy: 0.7, db: 0.5 },
          uses_most: true,
          limits: { requests_per_minute: 600 },
          trend: []
        }
      ]
    }
  ],
  dedicated: []
}

const ADVICE: Advice[] = [
  {
    env_id: 30,
    app_id: 2,
    app_key: 'small',
    env_key: 'prod',
    kind: 'fits_shared',
    reasons: [{ code: 'QUIET', text: 'Requests: 3/min at the 95th percentile.' }],
    target: { kind: 'shared', shared_id: 4, key: 'pool-a' },
    plan_path: '/hub?app=2&move=30&to=shared%3A4'
  }
]

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HubCapacity />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  h.admin = true
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/capacity') return { data: { data: OVERVIEW } }
    if (url === '/hub/capacity/advice') return { data: { data: ADVICE } }
    if (url === '/hub/capacity/rebalances') return { data: { data: [] } }
    throw new Error(`unexpected ${url}`)
  })
  h.put.mockResolvedValue({ data: { data: { jobs: 2 }, changed: true } })
})
afterEach(() => vi.clearAllMocks())

describe('HubCapacity', () => {
  it('shows each deployment, flags the app that uses most of it, and the advice with its plan link', async () => {
    mount()
    expect(await screen.findByText('Shared · pool-a')).toBeTruthy()
    expect(screen.getByText('Uses most of the deployment')).toBeTruthy()
    expect(screen.getByText('4 of 40')).toBeTruthy()
    const link = screen.getByRole('link', { name: /Plan the move/ })
    expect(link.getAttribute('href')).toBe('/hub?app=2&move=30&to=shared%3A4')
    expect(screen.getByText(/Fits shared · pool-a/)).toBeTruthy()
  })

  it('edits an app’s limits: empty = no limit, a bad value is said before saving', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '600/min' }))
    const form = screen.getByRole('form', { name: 'Limits of acme/prod' })
    const jobs = within(form).getByLabelText('Background jobs at once (jobs)')
    fireEvent.change(jobs, { target: { value: '40' } })
    expect(within(form).getByText(/A whole number from 1 to 16/)).toBeTruthy()
    expect(
      (within(form).getByRole('button', { name: 'Save limits' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.change(jobs, { target: { value: '2' } })
    fireEvent.change(within(form).getByLabelText('Requests per minute (/min)'), {
      target: { value: '' }
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Save limits' }))
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith('/hub/capacity/limits/21', {
        requests_per_minute: null,
        jobs: 2,
        storage_mb: null
      })
    )
  })

  it('is for administrators only', () => {
    h.admin = false
    mount()
    expect(screen.getByText('Capacity is for Hub administrators.')).toBeTruthy()
    expect(h.get).not.toHaveBeenCalled()
  })
})

describe('movePrefill', () => {
  it('opens only the named environment, with a shared target picked', () => {
    expect(movePrefill(30, '?app=2&move=30&to=shared%3A4')).toEqual({
      open: true,
      pick: 'shared:4'
    })
    expect(movePrefill(30, '?move=30&to=dedicated')).toEqual({ open: true, pick: '' })
    expect(movePrefill(31, '?move=30&to=shared:4')).toEqual({ open: false, pick: '' })
    expect(movePrefill(30, '?move=30&to=new:1')).toEqual({ open: true, pick: '' })
  })
})
