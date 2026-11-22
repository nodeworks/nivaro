import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 7: the Sign-in tab. Hub administrators rotate signing keys; owners do not
// even see the control.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn(), admin: true }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string) => h.post(url),
    patch: vi.fn(),
    put: vi.fn(),
    delete: (url: string) => h.del(url)
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', is_admin: h.admin } }) }))

const { default: HubSignin } = await import('./HubSignin')

let keys: Array<Record<string, unknown>> = []
const baseKeys = [
  {
    kid: 'k2',
    alg: 'ES256',
    created_at: '2026-11-20T10:00:00Z',
    retired_at: null,
    active: true,
    status: 'active',
    signs_from: null,
    published_until: null
  },
  {
    kid: 'k1',
    alg: 'ES256',
    created_at: '2026-10-01T10:00:00Z',
    retired_at: '2026-11-20T10:06:00Z',
    active: false,
    status: 'retired',
    signs_from: null,
    published_until: '2026-11-21T10:06:00Z'
  }
]
const nextKey = {
  kid: 'k3',
  alg: 'ES256',
  created_at: '2026-11-21T10:00:00Z',
  retired_at: null,
  active: false,
  status: 'next',
  signs_from: '2026-11-21T10:06:00Z',
  published_until: null
}

function wire(admin: boolean, withNext = false) {
  h.admin = admin
  keys = withNext ? [nextKey, ...baseKeys] : baseKeys
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/signin/settings')
      return {
        data: {
          data: {
            issuer: 'https://hub.example.com',
            idp_audience: 'aud-1',
            keys: admin ? keys : null
          }
        }
      }
    if (url === '/hub/signin/overview')
      return {
        data: {
          data: [
            {
              id: 1,
              key: 'efp',
              name: 'EFP',
              signin_mode: 'hub',
              signins_30d: 7,
              environments: [
                { id: 10, key: 'production', has_client: true, active: true, signins_30d: 7 },
                { id: 11, key: 'staging', has_client: false, active: false, signins_30d: 0 }
              ]
            }
          ]
        }
      }
    throw new Error(`unexpected GET ${url}`)
  })
  h.post.mockResolvedValue({ data: { data: { kid: 'k3', signs_from: '2026-11-21T10:06:00Z' } } })
  h.del.mockResolvedValue({ data: { data: { kid: 'k1', signing_kid: 'k2', warning: null } } })
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubSignin />
    </QueryClientProvider>
  )
}

afterEach(() => vi.clearAllMocks())

describe('HubSignin', () => {
  it('shows the issuer, the audience value, the keys and the apps to an administrator', async () => {
    wire(true)
    mount()
    expect(await screen.findByText('https://hub.example.com')).toBeTruthy()
    expect(screen.getByText('Set on each app as HUB_IDP_AUDIENCE')).toBeTruthy()
    expect(screen.getByText('aud-1')).toBeTruthy()
    expect(await screen.findByText('Active')).toBeTruthy()
    expect(screen.getByText('Retired')).toBeTruthy()
    expect(await screen.findByText('Via the Hub')).toBeTruthy()
    expect(screen.getByText('production: client')).toBeTruthy()
    expect(screen.getByText('staging: no client')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText(/What happens when the Hub is down/)).toBeTruthy()
  })

  it('Rotate needs two presses', async () => {
    wire(true)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate signing key' }))
    expect(h.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Rotate the key?' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/signin/keys/rotate'))
  })

  it('a next key shows when it signs; the only signing key has no Remove', async () => {
    wire(true, true)
    mount()
    expect(await screen.findByText(/Published, signs from/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove key k3' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove key k1' })).toBeTruthy()
    // with a next key the signing key may go too
    expect(screen.getByRole('button', { name: 'Remove key k2' })).toBeTruthy()

    cleanup()
    wire(true, false)
    mount()
    await screen.findByText('Retired')
    expect(screen.queryByRole('button', { name: 'Remove key k2' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove key k1' })).toBeTruthy()
  })

  it('Remove needs two presses and calls DELETE for that key', async () => {
    wire(true)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove key k1' }))
    expect(h.del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove the key?' }))
    await waitFor(() => expect(h.del).toHaveBeenCalledWith('/hub/signin/keys/k1'))
    expect(screen.queryByRole('button', { name: 'Remove key k2' })).toBeNull()
  })

  it('hides Rotate and the keys from an owner', async () => {
    wire(false)
    mount()
    expect(await screen.findByText('https://hub.example.com')).toBeTruthy()
    await screen.findByText('Via the Hub')
    expect(screen.queryByRole('button', { name: /Rotate/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove key/ })).toBeNull()
    expect(screen.queryByText('Signing keys')).toBeNull()
  })
})
