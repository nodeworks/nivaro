import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DETAIL, OVERVIEW, PLAN } from './scale-fixtures'

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  admin: true
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: unknown) => h.get(url, opts),
    post: (url: string, body: unknown) => h.post(url, body),
    put: (url: string, body: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { is_admin: h.admin } }) }))

const { default: HubScale } = await import('./HubScale')

function mount(path = '/hub/scale') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <HubScale />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  h.admin = true
  h.get.mockReset()
  h.post.mockReset()
  h.put.mockReset()
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/scale') return { data: { data: OVERVIEW } }
    if (url === '/hub/scale/targets/environment/1') return { data: { data: DETAIL } }
    if (url === '/hub/scale/db-servers')
      return {
        data: {
          data: [
            { id: 1, name: 'sql-prod-1', engine: 'mssql', host: 'sql1', max_connections: 1200 }
          ]
        }
      }
    throw new Error(`unexpected ${url}`)
  })
})

describe('HubScale', () => {
  it('lists dedicated stacks and shared deployments with their replicas and chips', async () => {
    mount()
    const dedicated = await screen.findByRole('list', { name: 'Dedicated stacks' })
    expect(within(dedicated).getByText('Acme · production')).toBeTruthy()
    expect(within(dedicated).getByText('Web 4 · Worker 1 · Realtime 2')).toBeTruthy()
    expect(within(dedicated).getByText('Autoscaling')).toBeTruthy()
    const shared = screen.getByRole('list', { name: 'Shared deployments' })
    expect(within(shared).getByText('At its max')).toBeTruthy()
  })

  it('shows one stack: running vs kept, rules, pins, connections and recent changes', async () => {
    mount('/hub/scale?target=environment:1')
    expect(await screen.findByText('Running as kept')).toBeTruthy()
    expect(screen.getByText('size: 3')).toBeTruthy()
    expect(screen.getByText('Stays at one')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Pin Realtime to manual' })).toHaveProperty(
      'ariaChecked',
      'true'
    )
    expect(screen.getByText('790 of 1200 (300 other stacks, 490 this one)')).toBeTruthy()
    expect(screen.getByText('web 3 → 4: CPU (% of the limit) 86 > 70 for 3 checks.')).toBeTruthy()
    expect(screen.getByText('Not run')).toBeTruthy()
  })

  it('plans a change, asks for the key on production, then starts it', async () => {
    h.post.mockImplementation(async (url: string, body: unknown) => {
      if (url.endsWith('/plan')) return { data: { data: PLAN } }
      if (url.endsWith('/runs')) return { data: { data: { run_id: 13 } }, body }
      throw new Error(url)
    })
    mount('/hub/scale?target=environment:1')
    fireEvent.click(await screen.findByRole('button', { name: /Change/ }))
    fireEvent.change(screen.getByLabelText('Web replicas'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plan the change' }))
    await screen.findByText('Web 4 → 6')
    expect(h.post).toHaveBeenCalledWith('/hub/scale/targets/environment/1/plan', {
      roles: [{ role: 'web', replicas: 6 }]
    })
    const start = screen.getByRole('button', { name: 'Start' })
    expect(start).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText(/to change it/), { target: { value: 'production' } })
    expect(start).toHaveProperty('disabled', false)
    fireEvent.click(start)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/scale/targets/environment/1/runs', {
        roles: [{ role: 'web', replicas: 6 }],
        plan_hash: PLAN.plan_hash,
        confirm: 'production'
      })
    )
  })

  it('edits a rule inline and refuses an "in" mark above the "out" one', async () => {
    h.put.mockResolvedValue({ data: { data: DETAIL } })
    mount('/hub/scale?target=environment:1')
    fireEvent.click(await screen.findByRole('button', { name: /3–6/ }))
    const inBelow = screen.getAllByLabelText('Scale in below')[0]
    fireEvent.change(inBelow, { target: { value: '90' } })
    expect(screen.getByText(/so the two never fight/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save rule' })).toHaveProperty('disabled', true)
    fireEvent.change(inBelow, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }))
    await waitFor(() => expect(h.put).toHaveBeenCalled())
    const [url, body] = h.put.mock.calls[0] as [string, { auto: { metrics: unknown[] } }]
    expect(url).toBe('/hub/scale/targets/environment/1/roles/web')
    expect(body.auto.metrics).toEqual([{ metric: 'cpu_pct', out_above: 70, in_below: 25 }])
  })

  it('is for administrators only', () => {
    h.admin = false
    mount()
    expect(screen.getByText('Scaling is for Hub administrators.')).toBeTruthy()
    expect(h.get).not.toHaveBeenCalled()
  })
})
