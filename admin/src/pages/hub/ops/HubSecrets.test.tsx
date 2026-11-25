import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 19: the Secrets tab. Fingerprints and ages, never a value; a Docker hub token
// rotates here only after the environment key is typed; a route-rotated secret shows its new
// value once, then is gone.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), admin: true }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', is_admin: h.admin } }) }))

const { default: HubSecrets } = await import('./HubSecrets')

const item = (over: Record<string, unknown>) => ({
  ref: 'hub_token:3',
  kind: 'hub_token',
  kind_label: 'Hub token',
  label: 'efp / prod — hub token',
  fingerprint: 'abcdef012345',
  path: '/hub?app=1',
  rotate: 'helper',
  helper_ready: true,
  first_seen_at: '2026-01-01T00:00:00Z',
  rotated_at: null,
  rotated_via: null,
  age_days: 327,
  due_at: '2026-06-30T00:00:00Z',
  due: 'overdue',
  check_state: null,
  check_detail: null,
  check_due_at: null,
  env_id: 3,
  env_key: 'prod',
  shared_id: null,
  ...over
})

const kinds = {
  hub_token: { label: 'Hub token', every_days: 180, remind_days: 14, rotate: 'helper', how: 'x' },
  deployment_token: {
    label: 'Shared deployment token',
    every_days: 180,
    remind_days: 14,
    rotate: 'route',
    how: 'Rotate on the shared deployment.'
  }
}

function wire() {
  h.get.mockImplementation(async () => ({
    data: {
      data: {
        items: [
          item({}),
          item({
            ref: 'deployment_token:2',
            kind: 'deployment_token',
            kind_label: 'Shared deployment token',
            label: 'shared-a — deployment token',
            rotate: 'route',
            helper_ready: false,
            env_id: null,
            env_key: null,
            shared_id: 2,
            due: 'ok'
          })
        ],
        policies: {
          hub_token: { kind: 'hub_token', every_days: 180, remind_days: 14, saved: false },
          deployment_token: {
            kind: 'deployment_token',
            every_days: 180,
            remind_days: 14,
            saved: false
          }
        },
        kinds
      }
    }
  }))
  h.post.mockImplementation(async (url: string) => {
    if (url === '/hub/shared/2/token') return { data: { data: { token: 'NEW-DEPLOY-TOKEN' } } }
    return { data: { data: { rotated: true } } }
  })
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HubSecrets />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  h.get.mockReset()
  h.post.mockReset()
  h.admin = true
})

describe('HubSecrets', () => {
  it('owners do not see secrets', () => {
    h.admin = false
    mount()
    expect(screen.getByText(/Only administrators see/)).toBeTruthy()
    expect(h.get).not.toHaveBeenCalled()
  })

  it('lists fingerprints and due states', async () => {
    wire()
    mount()
    expect(await screen.findByText('efp / prod — hub token')).toBeTruthy()
    expect(screen.getByText('Overdue')).toBeTruthy()
    expect(screen.getAllByText('abcdef012345')).toHaveLength(2)
  })

  it('a hub token rotates only after the environment key is typed', async () => {
    wire()
    mount()
    await screen.findByText('efp / prod — hub token')
    fireEvent.click(screen.getAllByRole('button', { name: /Rotate…/ })[0])
    const go = screen.getByRole('button', { name: 'Rotate and apply' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Environment key to confirm'), {
      target: { value: 'prod' }
    })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/secrets/rotate', {
        ref: 'hub_token:3',
        confirm: 'prod'
      })
    )
  })

  it('a route-rotated token is shown once, recorded, and gone after Done', async () => {
    wire()
    mount()
    await screen.findByText('shared-a — deployment token')
    fireEvent.click(screen.getAllByRole('button', { name: /Rotate…/ })[1])
    fireEvent.click(screen.getByRole('button', { name: 'Rotate now' }))
    expect(await screen.findByText('NEW-DEPLOY-TOKEN')).toBeTruthy()
    expect(h.post).toHaveBeenCalledWith('/hub/secrets/rotated', { ref: 'deployment_token:2' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText('NEW-DEPLOY-TOKEN')).toBeNull()
  })
})
