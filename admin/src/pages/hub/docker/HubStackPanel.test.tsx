import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 4): the stack panel — owners see status + Restart only; admins also get
// settings and Remove; confirms are typed inline.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

const { HubStackPanel } = await import('./HubStackPanel')

const env = {
  id: 5,
  app_id: 1,
  key: 'staging',
  position: 0,
  status: 'active',
  base_url: 'https://s.example.com',
  hostnames: [],
  placement_id: 7,
  version_pin: '1.0.0',
  hub_token: null
}

const status = (state: string) => ({
  name: 'efp-staging',
  image: 'nodeworks/nivaro@sha256:0123456789abcdef0123',
  state,
  published_port: null,
  services: [
    {
      name: 's_web',
      role: 'web',
      image: 'x',
      replicas: { desired: 2, running: 2 },
      update: 'completed',
      message: null
    }
  ]
})

function setup(opts: { state?: string; agent?: string; settings?: unknown } = {}) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/environments/5/stack')
      return {
        data: {
          data: {
            stack_name: 'efp-staging',
            dns_mode: 'automatic',
            name_request: null,
            status: opts.agent && opts.agent !== 'ok' ? null : status(opts.state ?? 'converged'),
            agent: opts.agent ?? 'ok'
          }
        }
      }
    if (url === '/hub/environments/5/stack/settings')
      return {
        data: {
          data: opts.settings ?? {
            size: 'small',
            redis: 'bundled',
            publish_port: null,
            settings: { LOG_LEVEL: 'info' },
            secrets: { SESSION_SECRET: '••••••', API_KEY: '••••••' },
            saved: true,
            extension_pins: {}
          }
        }
      }
    return { data: { data: [] } }
  })
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const view = (isAdmin: boolean) =>
  render(
    <QueryClientProvider client={client()}>
      <HubStackPanel env={env} appId={1} isAdmin={isAdmin} layout='card' />
    </QueryClientProvider>
  )

afterEach(() => {
  vi.clearAllMocks()
})

describe('HubStackPanel', () => {
  it('owner sees status and Restart, no settings, no Remove', async () => {
    setup()
    view(false)
    expect(await screen.findByText('Converged')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
    expect(screen.queryByText('Edit settings')).toBeNull()
    expect(screen.queryByText(/Remove stack/)).toBeNull()
  })

  it('Restart stays disabled until the environment key is typed', async () => {
    setup()
    h.post.mockResolvedValue({ data: { data: { services: [] } } })
    view(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    const go = screen.getByRole('button', { name: 'Restart now' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/to restart/), { target: { value: 'staging' } })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/5/stack/restart', {
        confirm: 'staging'
      })
    )
  })

  it('shows the rolled back hint', async () => {
    setup({ state: 'rolled_back' })
    view(false)
    expect(await screen.findByText(/rolled the stack back/)).toBeTruthy()
  })

  it('says another environment owns a mismatched stack', async () => {
    setup({ agent: 'STACK_OWNER_MISMATCH' })
    view(false)
    expect((await screen.findAllByText(/belongs to another environment/)).length).toBeGreaterThan(0)
  })

  it('secrets show only masks and Replace never pre-fills', async () => {
    setup()
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    await screen.findByText('API_KEY')
    expect(screen.getAllByText('••••••').length).toBe(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Replace' })[1])
    const input = screen.getByLabelText('New value for API_KEY') as HTMLInputElement
    expect(input.value).toBe('')
    // The generated secret cannot be cleared.
    expect(screen.queryAllByRole('button', { name: 'Clear' }).length).toBe(0)
  })

  it('a settings refusal lands on its row', async () => {
    setup()
    h.put.mockRejectedValue({
      response: {
        status: 400,
        data: { code: 'SECRET_IN_SETTINGS', error: 'LOG_LEVEL looks like a credential' }
      }
    })
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    const value = (await screen.findByLabelText('Setting value')) as HTMLInputElement
    fireEvent.change(value, { target: { value: 'debug' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByText(/put it under Secrets/)).toBeTruthy()
    expect(h.put.mock.calls[0][1].secrets).toEqual({ SESSION_SECRET: '••••••', API_KEY: '••••••' })
  })

  it('removing with volumes needs both phrases', async () => {
    setup()
    h.post.mockResolvedValue({
      data: {
        data: { removed: { services: ['a'], secrets: 2, networks: [], volumes: ['v'] } }
      }
    })
    view(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove stack…' }))
    const go = screen.getByRole('button', { name: 'Remove stack' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText(/to remove it/), { target: { value: 'efp-staging' } })
    expect(go.disabled).toBe(false)
    fireEvent.click(screen.getByLabelText(/data volumes/))
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/delete efp-staging data/), {
      target: { value: 'delete efp-staging data' }
    })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/5/stack/remove', {
        confirm: 'efp-staging',
        remove_volumes: true,
        confirm_volumes: 'delete efp-staging data'
      })
    )
    expect(await screen.findByText(/Removed 1 services, 2 secrets/)).toBeTruthy()
  })
})
