import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub People tab: the list, a person, the live access check and Offboard everywhere (typed
// email), with the run's per-environment results in words.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), admin: true }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'me', is_admin: h.admin } })
}))

const { default: HubPeople } = await import('./HubPeople')

const KEY = 'u:DDDDDDDD-0000-4000-8000-000000000004'
const person = {
  key: KEY,
  name: 'Dana Doe',
  email: 'dana@x.io',
  hub_user_id: 'DDDDDDDD-0000-4000-8000-000000000004',
  last_seen: new Date().toISOString(),
  environments: [
    {
      environment_id: 1,
      app_id: 1,
      app_key: 'efp',
      app_name: 'EFP',
      environment_key: 'production',
      via: 'hub',
      last_seen: new Date().toISOString()
    }
  ]
}
const run = {
  id: 4,
  label: 'Dana Doe',
  person_key: KEY,
  status: 'partial',
  blocked: true,
  hub_account: 'suspended',
  started_at: new Date().toISOString(),
  finished_at: null,
  lifted_at: null,
  results: [
    {
      environment_id: 1,
      app_id: 1,
      app_key: 'efp',
      app_name: 'EFP',
      environment_key: 'production',
      state: 'refused',
      code: 'LAST_ADMIN',
      attempts: 1,
      at: null
    }
  ]
}

function setup(offboards: unknown[] = []) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/people') return { data: { data: [person], total: 1 } }
    if (url.endsWith('/access'))
      return {
        data: {
          data: [
            {
              environment_id: 1,
              app_id: 1,
              app_key: 'efp',
              app_name: 'EFP',
              environment_key: 'production',
              production: true,
              state: 'account',
              accounts: [
                {
                  user_id: 'x',
                  status: 'active',
                  role: 'Planner',
                  admin: false,
                  matched_by: 'email'
                }
              ]
            }
          ]
        }
      }
    if (url.startsWith('/hub/people/'))
      return {
        data: { data: { ...person, identity: { emails: ['dana@x.io'], entra: 1 }, offboards } }
      }
    return { data: { data: [] } }
  })
}

const view = (path = `/hub/people?person=${encodeURIComponent(KEY)}`) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[path]}>
        <HubPeople />
      </MemoryRouter>
    </QueryClientProvider>
  )

afterEach(() => {
  vi.clearAllMocks()
  h.admin = true
})

describe('HubPeople', () => {
  it('is for Hub administrators only', () => {
    h.admin = false
    view('/hub/people')
    expect(screen.getByText(/People are for Hub administrators/)).toBeTruthy()
    expect(h.get).not.toHaveBeenCalled()
  })

  it('asks the apps only on Check now, and shows the role there', async () => {
    setup()
    view()
    expect(await screen.findByRole('heading', { name: 'Dana Doe' })).toBeTruthy()
    expect(h.get).not.toHaveBeenCalledWith(expect.stringContaining('/access'), undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Planner')).toBeTruthy()
  })

  it('Offboard everywhere waits for the typed email, then starts the run', async () => {
    setup()
    h.post.mockResolvedValue({ data: { data: run } })
    view()
    const go = (await screen.findByRole('button', {
      name: /Offboard everywhere/
    })) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type dana@x.io to confirm/), {
      target: { value: 'DANA@x.io' }
    })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith(`/hub/people/${encodeURIComponent(KEY)}/offboard`, {
        confirm: 'DANA@x.io'
      })
    )
  })

  it('a run lists each environment in words, with Retry and Lift', async () => {
    setup([run])
    view()
    expect(await screen.findByText('Refused')).toBeTruthy()
    expect(screen.getByText('Their last administrator')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Retry 1 environment/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Lift Hub sign-in block/ })).toBeTruthy()
  })
})
