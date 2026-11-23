import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Design round 2 N-r2-6: on a phone (no hover) the reason an environment's Promote is off is a
// visible line under its actions, not only a tip; the wide table keeps the tip alone.

const h = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

const { HubAppDetail } = await import('./HubAppDetail')

const now = new Date().toISOString()
const envRow = (id: number, key: string, onShared: boolean) => ({
  id,
  app_id: 1,
  key,
  position: id,
  status: 'active',
  base_url: `https://${key}.example.com`,
  hostnames: [],
  placement_id: id + 100,
  version_pin: null,
  hub_token: null,
  hub_managed: true,
  on_shared: onShared
})
const app = {
  id: 1,
  key: 'efp',
  name: 'EFP',
  signin_mode: 'direct',
  adopted: true,
  extensions: [],
  owners: [{ user_id: 'u1', name: 'Pat Owner' }],
  environments: [envRow(10, 'production', true), envRow(11, 'staging', false)]
}

function renderAsOwner() {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/apps/1') return { data: { data: app } }
    if (/\/status$/.test(url))
      return {
        data: {
          data: { state: 'ok', version: '0.3.208', checked_at: now, source: 'public' }
        }
      }
    if (/\/environments\/\d+\/deploys$/.test(url)) return { data: { data: [] } }
    if (/\/environments\/\d+\/deploys\/hub$/.test(url))
      return {
        data: {
          data: [
            {
              id: 3,
              app_id: 1,
              environment_id: Number(url.split('/')[3]),
              kind: 'promote',
              version: '0.3.205',
              from_version: null,
              status: 'success',
              step: 'verify',
              error: null,
              job_run_id: 1,
              started_by: null,
              started_at: now,
              finished_at: now
            }
          ]
        }
      }
    if (/\/promotable$/.test(url))
      return { data: { data: { promote: ['0.3.209'], rollback: ['0.3.205'] } } }
    if (/\/stack/.test(url)) throw { response: { status: 404, data: {} } }
    throw new Error(`unexpected GET ${url}`)
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubAppDetail appId={1} isAdmin={false} userId='u1' onDeleted={() => {}} />
    </QueryClientProvider>
  )
}

describe('HubAppDetail: the off Promote on a phone', () => {
  afterEach(() => h.get.mockReset())

  it('says why under the actions of the shared environment only', async () => {
    renderAsOwner()
    await screen.findAllByText('Running')
    const lines = screen.getAllByTestId('promote-blocked-line')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveTextContent(/Runs on a shared deployment/)
    expect(lines[0]).toHaveAttribute('aria-hidden')
    // It sits in the phone list, never in the wide table.
    expect(lines[0].closest('table')).toBeNull()
    expect(lines[0].closest('ul')?.className).toMatch(/sm:hidden/)
  })
})
