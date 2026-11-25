import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub release operations: the Releases tab (trains, schedules, freezes, rollback rules) and the
// release notes view. Administrators change things; app owners only read.

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  admin: true
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    delete: (url: string) => h.del(url)
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', is_admin: h.admin } }) }))

const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()

const { default: HubReleases } = await import('./HubReleases')
const { ReleaseNotesView } = await import('./ReleaseNotes')
const { isoToLocalInput, localInputToIso } = await import('./releases-api')

const overview = {
  apps: [{ id: 1, key: 'acme', name: 'Acme' }],
  environments: [
    {
      id: 10,
      app_id: 1,
      key: 'staging',
      position: 0,
      on_shared: false,
      linked: true,
      placed: true
    },
    {
      id: 11,
      app_id: 1,
      key: 'production',
      position: 1,
      on_shared: false,
      linked: false,
      placed: true
    }
  ],
  trains: [
    {
      id: 5,
      app_id: 1,
      version: '0.3.215',
      status: 'running',
      step_index: 0,
      error: null,
      schedule_id: null,
      started_by: 'u1',
      started_at: '2026-11-24T12:00:00Z',
      finished_at: null,
      steps: [
        {
          environment_id: 10,
          key: 'staging',
          soak_minutes: 30,
          min_readiness: 80,
          max_hold_minutes: 240,
          status: 'held',
          deploy_id: 40,
          started_at: null,
          deployed_at: null,
          passed_at: null,
          note: 'Held: readiness 60 is below 80',
          readiness: 60,
          attempts: 1
        },
        {
          environment_id: 11,
          key: 'production',
          soak_minutes: 0,
          min_readiness: null,
          max_hold_minutes: 240,
          status: 'pending',
          deploy_id: null,
          started_at: null,
          deployed_at: null,
          passed_at: null,
          note: null,
          readiness: null,
          attempts: 0
        }
      ]
    }
  ],
  schedules: [
    {
      id: 7,
      app_id: 1,
      environment_id: 11,
      kind: 'promote',
      version: '0.3.215',
      run_at: '2026-11-25T02:00:00Z',
      on_freeze: 'wait',
      status: 'waiting',
      note: 'Waiting for the freeze to end',
      deploy_id: null,
      train_id: null,
      error: null,
      train: null
    }
  ],
  freezes: [
    {
      id: 3,
      app_id: null,
      name: 'Month end',
      recurrence: 'month_end',
      starts_at: null,
      ends_at: null,
      days_before: 2,
      days_after: 3,
      time_zone: 'America/New_York',
      active: { start: '2026-11-29T05:00:00Z', end: '2026-12-04T05:00:00Z' },
      next: null
    }
  ],
  rules: [
    {
      environment_id: 11,
      enabled: true,
      window_minutes: 30,
      max_error_pct: 5,
      min_requests: 50,
      max_crashes: null,
      min_readiness: null
    }
  ],
  watches: [
    {
      id: 1,
      deploy_id: 40,
      app_id: 1,
      environment_id: 11,
      version: '0.3.215',
      from_version: '0.3.214',
      status: 'rolled_back',
      reason: '5xx rate 9.0% reached the limit of 5%',
      until_at: null,
      rollback_deploy_id: 41,
      finished_at: null
    }
  ],
  now: '2026-11-30T12:00:00Z'
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubReleases />
    </QueryClientProvider>
  )
}

afterEach(() => {
  vi.clearAllMocks()
  h.admin = true
})

describe('HubReleases', () => {
  it('shows trains, schedules, freezes and watches; skips a hold', async () => {
    h.get.mockResolvedValue({ data: { data: overview } })
    h.post.mockResolvedValue({ data: { data: overview.trains[0] } })
    mount()
    expect(await screen.findByText('acme 0.3.215')).toBeTruthy()
    expect(screen.getByText('Needs a person')).toBeTruthy()
    expect(screen.getByText('Held: readiness 60 is below 80')).toBeTruthy()
    expect(screen.getByText('Waiting for the freeze to end')).toBeTruthy()
    expect(screen.getByText('Month end')).toBeTruthy()
    expect(screen.getByText(/5xx rate 9\.0%/)).toBeTruthy()
    expect(screen.getByText('Rolled back')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skip the hold' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/trains/5/skip', { step: 0 }))
  })

  it('an owner reads but gets no buttons that change anything', async () => {
    h.admin = false
    h.get.mockResolvedValue({ data: { data: overview } })
    mount()
    expect(await screen.findByText('acme 0.3.215')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Skip the hold' })).toBeNull()
    expect(screen.queryByRole('button', { name: /New train/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /New freeze/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save rule' })).toBeNull()
  })

  it('a new train needs a version and the app key before it starts', async () => {
    h.get.mockResolvedValue({ data: { data: { ...overview, trains: [] } } })
    h.post.mockResolvedValue({ data: { data: overview.trains[0] } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /New train/ }))
    const start = screen.getByRole('button', { name: 'Start train' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '0.3.215' } })
    fireEvent.change(screen.getByLabelText(/Type acme to start/), { target: { value: 'acme' } })
    expect(start.disabled).toBe(false)
    fireEvent.click(start)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/apps/1/trains', {
        version: '0.3.215',
        confirm: 'acme',
        steps: [
          { environment_id: 10, soak_minutes: 30, min_readiness: 80, max_hold_minutes: 240 },
          { environment_id: 11, soak_minutes: 0, min_readiness: null, max_hold_minutes: 240 }
        ]
      })
    )
  })
})

describe('release notes view', () => {
  it('lists commits newest first, migrations and settings, and says what a rollback takes away', () => {
    render(
      <ReleaseNotesView
        notes={{
          kind: 'rollback',
          from_version: '0.3.215',
          to_version: '0.3.214',
          components: [
            {
              position: 1,
              component: 'api',
              kind: 'api',
              from_sha: 'aaaaaaaa11',
              to_sha: 'bbbbbbbb22',
              direction: 'removed',
              commits: [
                { sha: 'cccccccc33', title: 'feat: release trains', author: 'Rob', at: null }
              ],
              total_commits: 1,
              migrations: ['012_x.ts'],
              env_keys: ['NEW_KEY']
            }
          ],
          nivaro: {
            migrations: ['565_hub_release_ops'],
            env_keys: [],
            note: 'These came with 0.3.215. A rollback does not undo migrations that ran.'
          },
          computed_at: '2026-11-24T12:00:00Z'
        }}
      />
    )
    expect(screen.getByText(/this is what goes away/)).toBeTruthy()
    expect(screen.getByText('feat: release trains')).toBeTruthy()
    expect(screen.getByText('1 commit taken away')).toBeTruthy()
    expect(screen.getByText('012_x.ts')).toBeTruthy()
    expect(screen.getByText('NEW_KEY')).toBeTruthy()
    expect(screen.getByText('565_hub_release_ops')).toBeTruthy()
    expect(screen.getByText(/does not undo migrations/)).toBeTruthy()
  })

  it('converts the viewer’s local time to UTC and back', () => {
    const iso = localInputToIso('2026-11-25T09:30') as string
    expect(isoToLocalInput(iso)).toBe('2026-11-25T09:30')
    expect(localInputToIso('')).toBeNull()
  })
})
