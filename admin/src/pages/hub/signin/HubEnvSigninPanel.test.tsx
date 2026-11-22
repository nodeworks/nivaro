import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: an environment's sign-in panel. The secret is shown once, held in
// component state only (never the query cache), and a refetch shows the mask.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

const { HubAppSigninCard, HubEnvSigninPanel } = await import('./HubEnvSigninPanel')

const SECRET = 'hubs_super-secret-value'
const lines = (id: string | null) => ({
  HUB_URL: 'https://hub.example.com',
  HUB_CLIENT_ID: id,
  HUB_IDP_AUDIENCE: 'aud-1'
})
const URIS = ['https://efp.example.com/api/auth/callback']

let hasClient = false
function wire() {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/signin/environments/10/client')
      return {
        data: {
          data: {
            client: hasClient
              ? {
                  client_id: 'hubc_1',
                  active: true,
                  secret: '••••••',
                  redirect_uris: URIS,
                  post_logout_uris: [],
                  created_at: null,
                  secret_rotated_at: null
                }
              : null,
            redirect_uris: URIS,
            env_lines: lines(hasClient ? 'hubc_1' : null),
            signins_30d: 0
          }
        }
      }
    throw new Error(`unexpected GET ${url}`)
  })
  h.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/client')) {
      hasClient = true
      return {
        data: { data: { client_id: 'hubc_1', client_secret: SECRET, env_lines: lines('hubc_1') } }
      }
    }
    return { data: { data: { client_secret: SECRET } } }
  })
  h.patch.mockResolvedValue({ data: { data: {} } })
}

function mount(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) }
}

afterEach(() => {
  hasClient = false
  vi.clearAllMocks()
})

describe('HubEnvSigninPanel', () => {
  it('create shows the secret once; it is not in the query cache; a refetch shows the mask', async () => {
    wire()
    const { qc, unmount } = mount(
      <HubEnvSigninPanel env={{ id: 10, key: 'production' }} mode='hub' />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Create sign-in client' }))
    expect(await screen.findByText('This secret is shown once.')).toBeTruthy()
    const lineBlock = screen.getByTestId('hub-env-lines').textContent ?? ''
    expect(lineBlock).toContain(`HUB_CLIENT_SECRET=${SECRET}`)
    expect(lineBlock).toContain('HUB_URL=https://hub.example.com')
    expect(lineBlock).toContain('HUB_IDP_AUDIENCE=aud-1')

    // Not in the query cache, nor the mutation cache.
    expect(
      JSON.stringify(
        qc
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data)
      )
    ).not.toContain(SECRET)
    expect(
      JSON.stringify(
        qc
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data)
      )
    ).not.toContain(SECRET)
    // A refetch of the client shows only the mask.
    await waitFor(() => expect(screen.getByText('hubc_1')).toBeTruthy())
    expect(
      JSON.stringify(
        qc
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data)
      )
    ).toContain('••••••')

    // Closing clears it.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('hub-env-lines')).toBeNull()
    unmount()
  })

  it('rotate needs two presses and shows the new secret once', async () => {
    hasClient = true
    wire()
    mount(<HubEnvSigninPanel env={{ id: 10, key: 'production' }} mode='hub' />)
    const rotate = await screen.findByRole('button', { name: 'Rotate secret' })
    fireEvent.click(rotate)
    expect(h.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Rotate the secret?' }))
    expect(await screen.findByText('This secret is shown once.')).toBeTruthy()
    expect(h.post).toHaveBeenCalledWith('/hub/signin/environments/10/client/rotate', undefined)
  })

  it('direct mode shows the redirect URIs to register in Entra, even with no client', async () => {
    wire()
    mount(<HubEnvSigninPanel env={{ id: 10, key: 'production' }} mode='direct' />)
    expect(
      await screen.findByText("Register these in the app's Entra app registration")
    ).toBeTruthy()
    expect(screen.getByText(URIS[0])).toBeTruthy()
    expect(screen.getByText("Change the environment's addresses to change these.")).toBeTruthy()
  })

  it('an error goes through hubToast, never raw text', async () => {
    wire()
    h.post.mockRejectedValueOnce(new Error('Request failed with status code 500'))
    const spy = vi.spyOn(toast, 'error').mockImplementation(() => 1 as never)
    mount(<HubEnvSigninPanel env={{ id: 10, key: 'production' }} mode='hub' />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create sign-in client' }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(String(spy.mock.calls[0]?.[0])).not.toMatch(/status code/)
  })
})

describe('HubAppSigninCard', () => {
  it('the mode switch sends PATCH /hub/signin/apps/:id/mode', async () => {
    wire()
    mount(
      <HubAppSigninCard
        app={{ id: 1, name: 'EFP', signin_mode: 'direct' }}
        envs={[{ id: 10, key: 'production' }]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Via the Hub' }))
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith('/hub/signin/apps/1/mode', { signin_mode: 'hub' })
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Via the Hub' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    )
  })
})
