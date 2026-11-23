import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub shared features Task 8: on a shared deployment each app saves its own Microsoft app
// registration for directory lookups. The card shows the three inputs there (even before the
// directory is configured), never elsewhere.

const h = vi.hoisted(() => ({
  status: null as unknown,
  settings: {} as Record<string, unknown>,
  patch: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: async (url: string) => {
      if (url === '/directory/status') return { data: { data: h.status } }
      if (url === '/directory/report') return { data: { data: null } }
      return { data: { data: h.settings } }
    },
    post: vi.fn(),
    patch: (url: string, body: unknown) => h.patch(url, body)
  }
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { DirectorySyncCard } = await import('./directory-sync-card')

const status = (over: Record<string, unknown> = {}) => ({
  configured: false,
  granted: false,
  roles: [],
  reason: 'No Microsoft tenant or app credentials configured',
  auth_mode: 'app',
  username: null,
  connected_user: null,
  connected_at: null,
  shared_deployment: false,
  ...over
})

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  h.patch.mockResolvedValue({ data: { data: {} } })
  return render(
    <QueryClientProvider client={qc}>
      <DirectorySyncCard />
    </QueryClientProvider>
  )
}

afterEach(() => {
  h.patch.mockReset()
  h.settings = {}
})

describe('DirectorySyncCard — app registration per app', () => {
  it('shared: shows the three inputs and the help line before anything is configured', async () => {
    h.status = status({ shared_deployment: true })
    h.settings = {
      directory_graph_tenant_id: 'tenant-a',
      directory_graph_client_id: null,
      directory_graph_client_secret: '••••••'
    }
    renderCard()
    expect(await screen.findByLabelText('Directory tenant ID')).toBeTruthy()
    expect(screen.getByLabelText('Application (client) ID')).toBeTruthy()
    expect(screen.getByLabelText('Client secret')).toBeTruthy()
    expect(
      screen.getByText(
        'On a shared deployment each app uses its own Microsoft app registration to read its directory.'
      )
    ).toBeTruthy()
    await waitFor(() =>
      expect((screen.getByLabelText('Directory tenant ID') as HTMLInputElement).value).toBe(
        'tenant-a'
      )
    )
    fireEvent.change(screen.getByLabelText('Application (client) ID'), {
      target: { value: ' client-a ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }))
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith('/settings', {
        directory_graph_tenant_id: 'tenant-a',
        directory_graph_client_id: 'client-a',
        // The mask goes back unchanged: the server keeps the saved secret.
        directory_graph_client_secret: '••••••'
      })
    )
  })

  it('self-hosted: no registration inputs; not configured = no card', async () => {
    h.status = status({ configured: true, granted: true })
    const { unmount } = renderCard()
    expect(await screen.findByText('Directory sync')).toBeTruthy()
    expect(screen.queryByLabelText('Directory tenant ID')).toBeNull()
    unmount()
    h.status = status()
    const { container } = renderCard()
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })
})
