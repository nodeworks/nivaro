import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 6, Task 18): an environment's Hub deploys name moves and shared upgrades,
// a promotion of a shared-placed environment says why it cannot run, and the environment row
// carries its placement chip and the Move / Place actions.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

const { PromotionHistory, HubPromotePanel } = await import('../HubPromotePanel')
const { HubAppDetail } = await import('../HubAppDetail')

const env = {
  id: 10,
  app_id: 1,
  key: 'production',
  position: 0,
  status: 'active',
  base_url: 'https://efp.example.com',
  hostnames: [],
  placement_id: 9,
  version_pin: '0.3.210',
  hub_token: '••••••'
}

const now = new Date().toISOString()
const row = (over: Record<string, unknown>) => ({
  id: 1,
  app_id: 1,
  environment_id: 10,
  kind: 'promote',
  version: '0.3.210',
  from_version: '0.3.209',
  status: 'success',
  step: null,
  error: null,
  job_run_id: null,
  started_by: null,
  started_at: now,
  finished_at: now,
  ...over
})

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

afterEach(() => vi.clearAllMocks())

describe('Hub deploys history', () => {
  it('names a move "Moved" and a shared deployment upgrade "Shared upgrade"', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/environments/10/deploys/hub')
        return {
          data: {
            data: [
              row({ id: 3, kind: 'move', from_version: null }),
              row({ id: 2, kind: 'shared', version: '0.3.211', status: 'running' }),
              row({ id: 1 })
            ]
          }
        }
      if (url === '/hub/environments/10/promotable')
        return { data: { data: { promote: [], rollback: ['0.3.210'] } } }
      throw new Error(url)
    })
    wrap(<PromotionHistory env={env} canPromote onRollback={() => {}} onWatch={() => {}} />)
    const table = await screen.findByRole('table', { name: 'production Hub deploys' })
    expect(within(table).getByText('Moved')).toBeInTheDocument()
    expect(within(table).getByText('Shared upgrade')).toBeInTheDocument()
    expect(within(table).getByText('Promote')).toBeInTheDocument()
    // A move or shared run is watched on its own panel, never as a promotion.
    expect(within(table).queryByRole('button', { name: 'Watch 0.3.211' })).toBeNull()
  })
})

describe('Promote on a shared-placed environment', () => {
  it('the promote panel says to upgrade the shared deployment instead', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/environments/10/promotable')
        return { data: { data: { promote: ['0.3.211'], rollback: [] } } }
      throw new Error(url)
    })
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/environments/10/promote/plan')
        return {
          data: {
            data: {
              ok: false,
              blockers: [{ code: 'SHARED_PLACEMENT', text: 'shared' }],
              lines: [],
              steps: []
            }
          }
        }
      throw new Error(url)
    })
    wrap(<HubPromotePanel env={env} kind='promote' idPrefix='pp' onClose={() => {}} />)
    expect(
      await screen.findByText('This environment runs on a shared deployment')
    ).toBeInTheDocument()
    expect(screen.getByText(/Upgrade the shared deployment instead/)).toBeInTheDocument()
  })
})

describe('Environment row (Hub admin)', () => {
  const app = {
    id: 1,
    key: 'efp',
    name: 'EFP',
    signin_mode: 'direct',
    adopted: false,
    extensions: [],
    owners: [],
    environments: [
      env,
      {
        ...env,
        id: 11,
        key: 'staging',
        position: 1,
        placement_id: 5,
        base_url: 'https://staging.efp.example.com'
      },
      {
        ...env,
        id: 12,
        key: 'dev',
        position: 2,
        status: 'provisioning',
        placement_id: null,
        hub_token: null,
        base_url: 'https://dev.efp.example.com'
      }
    ]
  }

  it('shows the placement chip and offers Move or Place on shared deployment', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/apps/1') return { data: { data: app } }
      if (url === '/hub/placements/9')
        return {
          data: {
            data: { id: 9, kind: 'shared', shared_deployment_id: 3, driver_id: null, target: {} }
          }
        }
      if (url === '/hub/placements/5')
        return {
          data: { data: { id: 5, kind: 'dedicated', driver_id: 2, target: { stack: 'efp' } } }
        }
      if (url === '/hub/shared')
        return {
          data: { data: [{ id: 3, key: 'east', name: 'East', mode: 'docker', status: 'active' }] }
        }
      if (url === '/hub/drivers')
        return {
          data: { data: [{ id: 2, kind: 'docker', name: 'Docker east', config: {}, secret: null }] }
        }
      if (/\/status$/.test(url))
        return {
          data: {
            data: {
              state: 'ok',
              version: '0.3.210',
              preflight: 'pass',
              checked_at: now,
              source: 'hub-link'
            }
          }
        }
      if (/\/deploys(\/hub)?$/.test(url)) return { data: { data: [] } }
      if (/\/promotable$/.test(url)) return { data: { data: { promote: [], rollback: [] } } }
      throw { response: { status: 404, data: { code: 'NOT_FOUND' } } }
    })
    wrap(<HubAppDetail appId={1} isAdmin userId='u1' onDeleted={() => {}} />)
    const table = await screen.findByRole('table')
    expect(await within(table).findByText('Shared · east')).toBeInTheDocument()
    expect(await within(table).findByText('Dedicated · Docker east')).toBeInTheDocument()
    expect(within(table).getByRole('button', { name: 'Move production' })).toBeInTheDocument()
    expect(within(table).getByRole('button', { name: 'Move staging' })).toBeInTheDocument()
    expect(
      within(table).getByRole('button', { name: 'Place dev on a shared deployment' })
    ).toBeInTheDocument()
    expect(within(table).queryByRole('button', { name: 'Move dev' })).toBeNull()
    // A shared-placed environment's Promote says why instead of opening a panel that refuses.
    const promote = within(table).getByRole('button', { name: 'Promote production' })
    expect(promote).toBeDisabled()
    expect(promote.closest('[data-tip]')?.getAttribute('data-tip')).toMatch(
      /Upgrade the shared deployment instead/
    )
    // Assistive tech hears the reason too.
    expect(promote).toHaveAccessibleDescription(/Upgrade the shared deployment instead/)
  })
})
