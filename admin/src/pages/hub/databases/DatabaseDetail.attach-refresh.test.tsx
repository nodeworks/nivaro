import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Final fix wave (admin review M-2, design R2-S3 and N-r2-5): attach and detach refresh the
// environment's app page and any move plan on screen for it; the remove card does not contradict
// the Detach button above it; the attach picker has a Cancel.

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: vi.fn(),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: (url: string, cfg?: unknown) => h.delete(url, cfg)
  }
}))

const { DatabaseDetail } = await import('./DatabaseDetail')

const openSelect = (el: HTMLElement) => fireEvent.keyDown(el, { key: 'Enter' })
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const base = {
  id: 9,
  server_id: 3,
  server_name: 'Shared',
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

function mount(row: Record<string, unknown>) {
  h.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/hub/db-servers'))
      return {
        data: {
          data: [
            {
              id: 3,
              name: 'Shared',
              engine: 'pg',
              host: 'db.example.com',
              port: 5432,
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
    return { data: { data: { ...base, ...row } } }
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <DatabaseDetail id={9} onDeleted={() => {}} />
    </QueryClientProvider>
  )
  return { invalidate }
}

const invalidatedKeys = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown } | undefined)?.queryKey))

afterEach(() => {
  vi.clearAllMocks()
})

describe('DatabaseDetail attach and detach refresh what shows the environment', () => {
  it('detach refreshes the app page and the move plan of the environment it left', async () => {
    h.delete.mockResolvedValue({ data: { data: { database_id: 9, changed: true } } })
    const { invalidate } = mount({
      environment: { id: 41, app_id: 4, app_key: 'shop', env_key: 'production' }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Detach from environment' }))
    fireEvent.click(await screen.findByRole('button', { name: /Detach from shop\/production\?/ }))
    await waitFor(() => expect(h.delete).toHaveBeenCalled())
    await waitFor(() => {
      const keys = invalidatedKeys(invalidate)
      expect(keys).toContain(JSON.stringify(['hub-app', 4]))
      expect(keys).toContain(JSON.stringify(['hub', 'move-plan', 41]))
    })
  })

  it('attach refreshes the app page and the move plan of the environment it joined', async () => {
    h.put.mockResolvedValue({
      data: { data: { database: base, check: null, changed: true, warning: null } }
    })
    const { invalidate } = mount({})
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
    fireEvent.click(screen.getByRole('button', { name: 'Attach to environment' }))
    await waitFor(() => {
      const keys = invalidatedKeys(invalidate)
      expect(keys).toContain(JSON.stringify(['hub-app', 4]))
      expect(keys).toContain(JSON.stringify(['hub', 'move-plan', 41]))
    })
  })

  it('the remove card says to detach first instead of saying it cannot be detached', async () => {
    mount({ environment: { id: 41, app_id: 4, app_key: 'shop', env_key: 'production' } })
    expect(
      await screen.findByText(
        'Used by shop/production. Detach it first (above), then remove it here.'
      )
    ).toBeTruthy()
    expect(document.body.textContent).not.toContain('cannot be detached')
  })

  it('the attach picker has a Cancel that closes it', async () => {
    mount({})
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to environment…' }))
    expect(await screen.findByRole('combobox', { name: 'App' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Attach to environment…' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'App' })).toBeNull()
  })
})
