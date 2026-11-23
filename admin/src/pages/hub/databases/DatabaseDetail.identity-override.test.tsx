import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Final fix wave (parked wave B, server side in FW-1): on a Docker stack an attach whose database
// identity differs from what the app reports answers 409 DATABASE_IDENTITY_DIFFERS. The card says
// so in plain words and offers "Attach anyway" behind a two-press confirm, which sends
// `override: true` (the Hub logs it). A plain attach never sends `override`.

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
const { ENV_DB_COPY, envDbError } = await import('./env-db-api')

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
    if (url === '/hub/apps') return { data: { data: [{ id: 4, key: 'shop', name: 'Shop' }] } }
    if (url === '/hub/apps/4')
      return {
        data: {
          data: {
            id: 4,
            key: 'shop',
            name: 'Shop',
            owners: [],
            environments: [{ id: 41, app_id: 4, key: 'production' }]
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

async function pickProduction() {
  fireEvent.click(await screen.findByRole('button', { name: 'Attach to environment…' }))
  await waitFor(() =>
    expect((screen.getByRole('combobox', { name: 'App' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  )
  openSelect(screen.getByRole('combobox', { name: 'App' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Shop' }))
  await waitFor(() =>
    expect(
      (screen.getByRole('combobox', { name: 'Environment' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
  openSelect(screen.getByRole('combobox', { name: 'Environment' }))
  fireEvent.click(await screen.findByRole('option', { name: 'production' }))
}

const differs = {
  isAxiosError: true,
  response: {
    status: 409,
    data: {
      code: 'DATABASE_IDENTITY_DIFFERS',
      error:
        "The Hub reaches this record's database under another server name, address or database than the app reports."
    }
  }
}

afterEach(() => {
  h.get.mockReset()
  h.put.mockReset()
})

describe('attach when the database identity differs on a Docker stack', () => {
  it('has plain copy for the refusal', () => {
    expect(ENV_DB_COPY.DATABASE_IDENTITY_DIFFERS).toBeDefined()
    const d = envDbError(differs, 'Could not attach the database')
    expect(d.title).toBe(ENV_DB_COPY.DATABASE_IDENTITY_DIFFERS.title)
  })

  it('offers Attach anyway behind a confirm, which sends override: true', async () => {
    h.put.mockRejectedValueOnce(differs).mockResolvedValueOnce({
      data: {
        data: { database: base, check: null, changed: true, warning: null, overridden: true }
      }
    })
    mount()
    await pickProduction()
    fireEvent.click(screen.getByRole('button', { name: 'Attach to environment' }))
    expect(
      await screen.findByText(ENV_DB_COPY.DATABASE_IDENTITY_DIFFERS.title as string)
    ).toBeTruthy()
    expect(h.put).toHaveBeenNthCalledWith(1, '/hub/environments/41/database', {
      database_id: 9
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach anyway' }))
    expect(h.put).toHaveBeenCalledTimes(1)
    fireEvent.click(await screen.findByRole('button', { name: /same database/ }))
    await waitFor(() =>
      expect(h.put).toHaveBeenNthCalledWith(2, '/hub/environments/41/database', {
        database_id: 9,
        override: true
      })
    )
  })

  it('another refusal offers no Attach anyway', async () => {
    h.put.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 409, data: { code: 'ENGINE_MISMATCH', error: 'raw' } }
    })
    mount()
    await pickProduction()
    fireEvent.click(screen.getByRole('button', { name: 'Attach to environment' }))
    expect(await screen.findByText('The app runs on another database engine')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Attach anyway' })).toBeNull()
  })
})
