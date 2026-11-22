import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ get: vi.fn(), admin: true }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { is_admin: h.admin } }) }))

const { default: HubDatabases } = await import('./HubDatabases')

const wrap = (url = '/hub/databases') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[url]}>
        <HubDatabases />
      </MemoryRouter>
    </QueryClientProvider>
  )

afterEach(() => {
  h.get.mockReset()
  h.admin = true
})

describe('HubDatabases', () => {
  it('lists servers and databases with their environment', async () => {
    h.get.mockImplementation(async (url: string) =>
      url === '/hub/db-servers'
        ? {
            data: {
              data: [
                {
                  id: 1,
                  name: 'Shared',
                  engine: 'pg',
                  host: 'h',
                  port: null,
                  provision_mode: 'automatic',
                  ssl_mode: null,
                  trust_server_cert: false,
                  collation: null,
                  user_host: null,
                  notes: null,
                  admin_secret: '••••••'
                }
              ]
            }
          }
        : {
            data: {
              data: [
                {
                  id: 5,
                  server_id: 1,
                  server_name: 'Shared',
                  engine: 'pg',
                  host: 'h',
                  port: null,
                  database_name: 'a_db',
                  login_name: 'l',
                  status: 'ready',
                  adopted: false,
                  created_by_hub: true,
                  last_check: null,
                  checked_at: null,
                  connection: '••••••',
                  environment: { id: 1, app_id: 1, app_key: 'efp', env_key: 'prod' }
                },
                {
                  id: 6,
                  server_id: 1,
                  server_name: 'Shared',
                  engine: 'pg',
                  host: 'h',
                  port: null,
                  database_name: 'b_db',
                  login_name: 'l',
                  status: 'requested',
                  adopted: false,
                  created_by_hub: false,
                  last_check: null,
                  checked_at: null,
                  connection: null,
                  environment: null
                }
              ]
            }
          }
    )
    wrap()
    expect(await screen.findByText('Shared')).toBeTruthy()
    expect(await screen.findByText('efp/prod')).toBeTruthy()
    expect(screen.getByText('Not attached')).toBeTruthy()
    expect(screen.getByText('Waiting for a DBA')).toBeTruthy()
  })

  it('shows the admins-only state for a non-admin and for a 403', async () => {
    h.admin = false
    wrap()
    expect(screen.getByText(/Only administrators/)).toBeTruthy()
    expect(h.get).not.toHaveBeenCalled()
  })

  it('shows the admins-only state when the API answers 403', async () => {
    h.get.mockRejectedValue({ response: { status: 403, data: {} } })
    wrap()
    expect(await screen.findByText(/Only administrators/)).toBeTruthy()
  })
})
