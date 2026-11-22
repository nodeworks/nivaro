import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 6, Task 18): place a new environment (one that never served) on a shared
// deployment: deployment, database, connections, first administrator; then follow the run.

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

const { HubPlaceSharedForm } = await import('./HubPlaceSharedForm')

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
})

const env = {
  id: 12,
  app_id: 1,
  key: 'dev',
  position: 2,
  status: 'provisioning',
  base_url: 'https://dev.efp.example.com',
  hostnames: [],
  placement_id: null,
  version_pin: null,
  hub_token: null
}

const db = (over: Record<string, unknown>) => ({
  id: 1,
  server_id: 1,
  server_name: 'sql1',
  engine: 'mssql',
  host: 'sql1',
  port: 1433,
  database_name: 'efp_dev',
  login_name: null,
  status: 'ready',
  adopted: false,
  created_by_hub: true,
  last_check: null,
  checked_at: null,
  connection: '••••••',
  environment: null,
  ...over
})

beforeEach(() => {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/shared')
      return {
        data: {
          data: [
            {
              id: 3,
              key: 'east',
              name: 'East',
              mode: 'docker',
              status: 'active',
              version_pin: '0.3.210',
              pool_budget: 60
            }
          ]
        }
      }
    if (url === '/hub/databases')
      return {
        data: {
          data: [
            db({}),
            db({
              id: 2,
              database_name: 'efp_prod',
              environment: { id: 10, app_id: 1, app_key: 'efp', env_key: 'production' }
            }),
            db({ id: 3, database_name: 'efp_new', status: 'creating' })
          ]
        }
      }
    if (url === '/hub/environments/12/app-key')
      return {
        data: { data: { known: false, key: null, fp: null, source: null, code: 'APP_KEY_UNKNOWN' } }
      }
    if (url === '/job-runs/55/log')
      return { data: { data: { run: { id: 55, status: 'running', error: null }, lines: [] } } }
    throw new Error(`unexpected GET ${url}`)
  })
})
afterEach(() => vi.clearAllMocks())

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubPlaceSharedForm appId={1} env={env} idPrefix='p' onClose={() => {}} />
    </QueryClientProvider>
  )
}

async function pick(name: string, option: RegExp) {
  fireEvent.click(await screen.findByRole('combobox', { name }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

describe('HubPlaceSharedForm', () => {
  it('offers only ready databases no other environment uses', async () => {
    renderForm()
    fireEvent.click(await screen.findByRole('combobox', { name: 'Database' }))
    expect(await screen.findByRole('option', { name: /efp_dev/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /efp_prod/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /efp_new/ })).toBeNull()
  })

  it('places the environment and follows the run', async () => {
    h.post.mockResolvedValue({ data: { data: { job_run_id: 55 } } })
    renderForm()
    await pick('Shared deployment', /east/)
    await pick('Database', /efp_dev/)
    fireEvent.change(screen.getByLabelText('First administrator email'), {
      target: { value: 'pat@example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Place on shared deployment' }))
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/12/place-shared', {
        shared_id: 3,
        database_id: 1,
        pool_max: 5,
        first_admin: { email: 'pat@example.com' }
      })
    )
    expect(await screen.findByText(/Placing dev on east/)).toBeInTheDocument()
  })

  it('an unknown key in an adopted database asks for the key in place', async () => {
    h.post.mockRejectedValue({
      response: {
        status: 409,
        data: { code: 'APP_KEY_UNKNOWN', message: 'The Hub does not know this app’s key' }
      }
    })
    renderForm()
    await pick('Shared deployment', /east/)
    await pick('Database', /efp_dev/)
    fireEvent.change(screen.getByLabelText('First administrator email'), {
      target: { value: 'pat@example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Place on shared deployment' }))
    expect(
      await screen.findByText("The Hub does not know this app's encryption key")
    ).toBeInTheDocument()
    expect(await screen.findByLabelText('App encryption key')).toBeInTheDocument()
  })

  it('says a refusal in plain words, never a status code', async () => {
    h.post.mockRejectedValue({
      response: { status: 409, data: { code: 'ALREADY_PLACED', message: 'already' } }
    })
    renderForm()
    await pick('Shared deployment', /east/)
    await pick('Database', /efp_dev/)
    fireEvent.change(screen.getByLabelText('First administrator email'), {
      target: { value: 'pat@example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Place on shared deployment' }))
    expect(
      await screen.findByText('This environment already runs on a shared deployment')
    ).toBeInTheDocument()
    expect(screen.queryByText(/status code/i)).toBeNull()
  })

  it('keeps connections between 2 and 20', async () => {
    renderForm()
    const pool = await screen.findByLabelText('Database connections')
    fireEvent.change(pool, { target: { value: '1' } })
    expect(screen.getByText('Between 2 and 20.')).toBeInTheDocument()
  })
})

describe('HubPlaceSharedForm — a run that failed', () => {
  it('a raw error never shows as the message', async () => {
    h.post.mockResolvedValue({ data: { data: { job_run_id: 56 } } })
    const base = h.get.getMockImplementation() as (url: string) => Promise<unknown>
    h.get.mockImplementation(async (url: string) =>
      url === '/job-runs/56/log'
        ? {
            data: {
              data: {
                run: {
                  id: 56,
                  status: 'failed',
                  error:
                    'STEP_FAILED: TypeError: Cannot read properties of undefined (reading x)\n    at run (place.ts:10:5)'
                },
                lines: []
              }
            }
          }
        : base(url)
    )
    renderForm()
    await pick('Shared deployment', /east/)
    await pick('Database', /efp_dev/)
    fireEvent.change(screen.getByLabelText('First administrator email'), {
      target: { value: 'pat@example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Place on shared deployment' }))
    expect(
      await screen.findByText('It stopped on an error the Hub could not put in plain words')
    ).toBeInTheDocument()
    expect(screen.getByText(/place it again to retry/)).toBeInTheDocument()
  })
})

describe('HubPlaceSharedForm — a failed run with a known sentence', () => {
  it('shows the sentence without its code', async () => {
    h.post.mockResolvedValue({ data: { data: { job_run_id: 57 } } })
    const base = h.get.getMockImplementation() as (url: string) => Promise<unknown>
    h.get.mockImplementation(async (url: string) =>
      url === '/job-runs/57/log'
        ? {
            data: {
              data: {
                run: {
                  id: 57,
                  status: 'failed',
                  error: "SCHEMA_TIMEOUT: The app's database was not ready in 10 minutes."
                },
                lines: []
              }
            }
          }
        : base(url)
    )
    renderForm()
    await pick('Shared deployment', /east/)
    await pick('Database', /efp_dev/)
    fireEvent.change(screen.getByLabelText('First administrator email'), {
      target: { value: 'pat@example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Place on shared deployment' }))
    expect(
      await screen.findByText("The app's database was not ready in 10 minutes.")
    ).toBeInTheDocument()
    expect(screen.queryByText(/SCHEMA_TIMEOUT/)).toBeNull()
  })
})

describe('HubPlaceSharedForm — an interrupted run', () => {
  it('shows plain words for INTERRUPTED, never the code', async () => {
    h.post.mockResolvedValue({ data: { data: { job_run_id: 58 } } })
    const base = h.get.getMockImplementation() as (url: string) => Promise<unknown>
    h.get.mockImplementation(async (url: string) =>
      url === '/job-runs/58/log'
        ? {
            data: {
              data: {
                run: {
                  id: 58,
                  status: 'failed',
                  error: 'INTERRUPTED: The environment lock was lost; place it again.'
                },
                lines: []
              }
            }
          }
        : base(url)
    )
    renderForm()
    await pick('Shared deployment', /east/)
    await pick('Database', /efp_dev/)
    fireEvent.change(screen.getByLabelText('First administrator email'), {
      target: { value: 'pat@example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Place on shared deployment' }))
    expect(await screen.findByText('The run stopped before it finished')).toBeInTheDocument()
    expect(screen.getByText('The environment lock was lost; place it again.')).toBeInTheDocument()
    expect(screen.queryByText(/INTERRUPTED/)).toBeNull()
  })
})
