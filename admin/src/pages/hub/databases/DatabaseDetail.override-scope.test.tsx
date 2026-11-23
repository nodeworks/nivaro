import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// FW-3 re-review I1 (ruling P6-40): an identity refusal and its "Attach anyway" belong to the one
// environment that was refused. Picking another app or environment drops both, and the override
// is only ever sent for the refused environment.

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: vi.fn(),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

const { DatabaseDetail } = await import('./DatabaseDetail')
const { ENV_DB_COPY } = await import('./env-db-api')

const openSelect = (el: HTMLElement) => fireEvent.keyDown(el, { key: 'Enter' })
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const base = {
  id: 9,
  server_id: null,
  server_name: null,
  engine: 'pg',
  host: 'db.example.com',
  port: 5432,
  database_name: 'app_prod',
  login_name: 'app_prod_login',
  status: 'ready',
  adopted: true,
  created_by_hub: false,
  last_check: null,
  checked_at: null,
  connection: '••••••',
  environment: null,
  checklist: null
}

function mount() {
  h.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/hub/db-servers')) return { data: { data: [] } }
    if (url === '/hub/apps')
      return {
        data: {
          data: [
            { id: 4, key: 'shop', name: 'Shop' },
            { id: 5, key: 'blog', name: 'Blog' }
          ]
        }
      }
    if (url === '/hub/apps/5')
      return {
        data: {
          data: {
            id: 5,
            key: 'blog',
            name: 'Blog',
            owners: [],
            environments: [{ id: 51, app_id: 5, key: 'production' }]
          }
        }
      }
    if (url === '/hub/apps/4')
      return {
        data: {
          data: {
            id: 4,
            key: 'shop',
            name: 'Shop',
            owners: [],
            environments: [
              { id: 41, app_id: 4, key: 'production' },
              { id: 42, app_id: 4, key: 'staging' }
            ]
          }
        }
      }
    return { data: { data: base } }
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DatabaseDetail id={9} onDeleted={() => {}} />
    </QueryClientProvider>
  )
}

async function pick(app: string | null, env: string) {
  if (app) {
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: 'App' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    openSelect(screen.getByRole('combobox', { name: 'App' }))
    fireEvent.click(await screen.findByRole('option', { name: app }))
  }
  await waitFor(() =>
    expect(
      (screen.getByRole('combobox', { name: 'Environment' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
  openSelect(screen.getByRole('combobox', { name: 'Environment' }))
  fireEvent.click(await screen.findByRole('option', { name: env }))
}

const differs = {
  isAxiosError: true,
  response: {
    status: 409,
    data: { code: 'DATABASE_IDENTITY_DIFFERS', error: 'another identity' }
  }
}

afterEach(() => {
  h.get.mockReset()
  h.put.mockReset()
})

describe('an identity refusal belongs to the environment that was refused', () => {
  it('refused for production, then staging picked: no Attach anyway, and staging sends no override', async () => {
    h.put.mockRejectedValueOnce(differs).mockResolvedValueOnce({
      data: { data: { database: base, check: null, changed: true, warning: null } }
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to environment…' }))
    await pick('Shop', 'production')
    fireEvent.click(screen.getByRole('button', { name: 'Attach to environment' }))
    expect(
      await screen.findByText(ENV_DB_COPY.DATABASE_IDENTITY_DIFFERS.title as string)
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Attach anyway' })).toBeTruthy()

    await pick(null, 'staging')
    expect(screen.queryByRole('button', { name: 'Attach anyway' })).toBeNull()
    expect(screen.queryByText(ENV_DB_COPY.DATABASE_IDENTITY_DIFFERS.title as string)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Attach to environment' }))
    await waitFor(() =>
      expect(h.put).toHaveBeenNthCalledWith(2, '/hub/environments/42/database', {
        database_id: 9
      })
    )
  })

  it('a new app pick drops the refusal too', async () => {
    h.put.mockRejectedValueOnce(differs)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to environment…' }))
    await pick('Shop', 'production')
    fireEvent.click(screen.getByRole('button', { name: 'Attach to environment' }))
    expect(await screen.findByRole('button', { name: 'Attach anyway' })).toBeTruthy()
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: 'App' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    openSelect(screen.getByRole('combobox', { name: 'App' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Blog' }))
    expect(screen.queryByRole('button', { name: 'Attach anyway' })).toBeNull()
  })
})
