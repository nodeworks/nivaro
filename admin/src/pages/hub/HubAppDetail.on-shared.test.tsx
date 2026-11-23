import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Phase 6 (parked C3): an app owner cannot read placements, so the app read says which
// environments run on a shared deployment (`on_shared`). Promote there is off, with the reason,
// and the history offers no Roll back: both could only be refused.

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

describe('HubAppDetail: an owner on a shared environment', () => {
  afterEach(() => h.get.mockReset())

  it('Promote is off with the reason; a dedicated environment keeps it', async () => {
    renderAsOwner()
    await screen.findAllByText('Running')
    const shared = screen.getAllByRole('button', { name: 'Promote production' })
    expect(shared.length).toBeGreaterThan(0)
    for (const b of shared) {
      expect(b).toBeDisabled()
      expect(b).toHaveAccessibleDescription(/Runs on a shared deployment/)
      expect(b.closest('[data-tip]')?.getAttribute('data-tip')).toMatch(
        /Upgrade the shared deployment instead/
      )
    }
    fireEvent.click(shared[0])
    expect(screen.queryByLabelText(/Type production to promote/)).toBeNull()
    for (const b of screen.getAllByRole('button', { name: 'Promote staging' }))
      expect(b).toBeEnabled()
  })

  it("the shared environment's history offers no Roll back; the dedicated one does", async () => {
    renderAsOwner()
    const sharedTable = await screen.findByRole('table', { name: 'production Hub deploys' })
    const dedicated = await screen.findByRole('table', { name: 'staging Hub deploys' })
    expect(
      await within(dedicated).findByRole('button', { name: 'Roll back to 0.3.205' })
    ).toBeInTheDocument()
    expect(within(sharedTable).queryByRole('button', { name: /Roll back to/ })).toBeNull()
  })
})
