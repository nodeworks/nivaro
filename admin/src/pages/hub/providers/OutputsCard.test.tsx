import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Hub providers (Task 13): the Outputs card shows what a resource hands out without any value
// (held + a short fingerprint, lost → Rotate), and where each output goes with the binding's own
// state (written, needs Apply now, not written + the reason).

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    put: (url: string, body?: unknown) => h.put(url, body),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

// Radix pieces (switch, select) in jsdom.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const { OutputsCard } = await import('./OutputsCard')
const { audienceWords, mayEditRoute, NotifyRoutesCard } = await import('./NotifyRoutes')

const resource = {
  id: 9,
  connection_id: 2,
  provider: 'neon',
  type: 'neon.database',
  external_id: 'db-1',
  name: 'orders',
  scope: 'app',
  app_id: 4,
  environment_id: 5,
  desired: {},
  observed: null,
  drift: false,
  observed_at: null,
  tags: {},
  refs: [],
  created_by: null,
  adopted: false,
  deleted_at: null,
  created_at: null,
  updated_at: null
} as const

const type = {
  key: 'neon.database',
  label: 'Database',
  scope: 'app',
  fields: [],
  capabilities: {
    create: true,
    update: true,
    delete: true,
    adopt: true,
    snapshot: false,
    tag: true
  },
  reversible: true,
  refs: [],
  name_field: 'name',
  has_cost_class: false
} as const

const answer = {
  outputs: [
    {
      key: 'dsn',
      label: 'Connection string',
      secret: true,
      once_only: false,
      set: true,
      fingerprint: '0123456789abcdef0123456789abcdef',
      updated_at: '2026-11-26T10:00:00Z',
      lost: false,
      rotate: true
    },
    {
      key: 'key',
      label: 'Service key',
      secret: true,
      once_only: true,
      set: false,
      fingerprint: null,
      updated_at: null,
      lost: true,
      rotate: true
    }
  ],
  bindings: [
    {
      id: 1,
      resource_id: 9,
      output_key: 'dsn',
      environment_id: 5,
      environment_key: 'staging',
      target: 'stack_secret',
      target_key: 'DB_PASSWORD',
      last_pushed_at: '2026-11-26T10:01:00Z',
      last_fingerprint: '0123456789abcdef0123456789abcdef',
      last_error: null,
      stale: false,
      needs_apply: true
    },
    {
      id: 2,
      resource_id: 9,
      output_key: 'key',
      environment_id: 5,
      environment_key: 'staging',
      target: 'app_setting',
      target_key: 'anthropic_api_key',
      last_pushed_at: null,
      last_fingerprint: null,
      last_error: 'Service key was shown by the provider only once — rotate it.',
      stale: false,
      needs_apply: false
    }
  ],
  app_settings: ['smtp_pass', 'anthropic_api_key']
}

function mount(onRotate = vi.fn()) {
  h.get.mockResolvedValue({ data: { data: answer } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <OutputsCard
        resource={resource as never}
        type={type as never}
        environments={[{ id: 5, key: 'staging' }]}
        canDeploy
        idPrefix='t'
        onRotate={onRotate}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  )
  return onRotate
}

describe('OutputsCard', () => {
  it('shows outputs and bindings without a value, and offers Rotate for a lost one', async () => {
    const onRotate = mount()
    expect(await screen.findByText('DB_PASSWORD')).toBeTruthy()
    expect(screen.getByText('01234567')).toBeTruthy()
    expect(screen.queryByText(/0123456789abcdef/)).toBeNull()
    expect(screen.getByText('Lost')).toBeTruthy()
    expect(screen.getByText('Needs Apply now')).toBeTruthy()
    expect(screen.getByText('Not written')).toBeTruthy()
    expect(screen.getByText(/rotate it\./)).toBeTruthy()
    const line = screen.getAllByText('Service key')[0].closest('li') as HTMLElement
    fireEvent.click(within(line).getByRole('button', { name: /Rotate/ }))
    expect(onRotate).toHaveBeenCalledTimes(1)
  })

  it('removing a binding saves the rest of the list', async () => {
    mount()
    await screen.findByText('DB_PASSWORD')
    h.put.mockResolvedValue({ data: { data: { outputs: answer.outputs, bindings: [] } } })
    const line = screen.getByText('DB_PASSWORD').closest('li') as HTMLElement
    fireEvent.click(within(line).getByRole('button', { name: /Stop writing DB_PASSWORD|Remove/ }))
    fireEvent.click(within(line).getByRole('button', { name: /Remove\?/ }))
    await waitFor(() => expect(h.put).toHaveBeenCalled())
    expect(h.put).toHaveBeenCalledWith('/hub/resources/9/bindings', {
      bindings: [
        {
          output_key: 'key',
          environment_id: 5,
          target: 'app_setting',
          target_key: 'anthropic_api_key'
        }
      ]
    })
  })
})

// Task 33b: app owners' notify routes on the app page — that app's routes, the app's own senders,
// who each route reaches in words, and a route an administrator set up through a shared sender
// shown but not changed.

const sender = (over: Record<string, unknown>) => ({ ...resource, ...over }) as never

describe('notify routes on an app page', () => {
  const slack = { label: 'Slack channel', audience: null }
  const mail = { label: 'Email sender', audience: 'email' as const }
  const appRoute = { scope: 'app' as const, app_id: 4 }

  it('says who a route reaches', () => {
    const ch = sender({ type: 'slack.channel', name: '#orders' })
    expect(audienceWords(appRoute, ch, slack, 3)).toBe(
      'Reaches everyone who can read #orders (Slack channel).'
    )
    const sg = sender({ type: 'sendgrid.sender', name: 'Orders mail', desired: {} })
    expect(audienceWords(appRoute, sg, mail, 3)).toBe('Emails this app’s 3 owners.')
    expect(audienceWords(appRoute, sg, mail, 1)).toBe('Emails this app’s 1 owner.')
    expect(audienceWords(appRoute, sg, mail, 0)).toBe(
      'Emails the Hub administrators: this app has no owners yet.'
    )
    expect(audienceWords({ scope: 'hub', app_id: null }, sg, mail, null)).toBe(
      'Emails the Hub administrators.'
    )
    const own = sender({
      type: 'sendgrid.sender',
      desired: { recipients: ['a@x.test', 'b@x.test'] }
    })
    expect(audienceWords(appRoute, own, mail, 3)).toBe('Emails the 2 addresses set on the sender.')
    expect(audienceWords(appRoute, null, mail, 3)).toBeNull()
  })

  it('an owner changes only app routes through that app’s own sender (the API rule)', () => {
    expect(mayEditRoute(appRoute, sender({ scope: 'app', app_id: 4 }), false)).toBe(true)
    expect(mayEditRoute(appRoute, sender({ scope: 'shared', app_id: null }), false)).toBe(false)
    expect(mayEditRoute(appRoute, sender({ scope: 'app', app_id: 5 }), false)).toBe(false)
    expect(mayEditRoute({ scope: 'hub', app_id: null }, sender({}), false)).toBe(false)
    expect(mayEditRoute(appRoute, null, false)).toBe(false)
    expect(mayEditRoute(appRoute, null, true)).toBe(true)
  })

  it('lists this app’s routes, keeps a shared-sender route read-only, makes new ones for the app', async () => {
    const route = (over: Record<string, unknown>) => ({
      name: null,
      scope: 'app',
      app_id: 4,
      events: ['deploy.failed'],
      enabled: true,
      last_sent_at: null,
      last_error_at: null,
      last_error: null,
      ...over
    })
    h.get.mockImplementation((url: string) => {
      if (url === '/hub/notify-routes')
        return Promise.resolve({
          data: {
            data: {
              routes: [
                route({ id: 1, name: 'Orders alerts', resource_id: 20 }),
                route({ id: 2, name: 'Ops pager', resource_id: 21 }),
                route({ id: 3, name: 'Other app', app_id: 5, resource_id: 22 })
              ],
              events: [
                { key: 'deploy.failed', label: 'Deploy failed' },
                { key: 'incident.opened', label: 'Incident opened' }
              ]
            }
          }
        })
      if (url === '/hub/provider-types')
        return Promise.resolve({
          data: {
            data: {
              risk_flags: [],
              providers: [
                {
                  key: 'slack',
                  label: 'Slack',
                  notify: true,
                  connection: { fields: [] },
                  types: [{ ...type, key: 'slack.channel', label: 'Slack channel', sends: true }]
                }
              ]
            }
          }
        })
      if (url.startsWith('/hub/resources'))
        return Promise.resolve({
          data: {
            data: [
              { ...resource, id: 20, type: 'slack.channel', name: '#orders', provider: 'slack' },
              {
                ...resource,
                id: 21,
                type: 'slack.channel',
                name: '#ops',
                provider: 'slack',
                scope: 'shared',
                app_id: null,
                environment_id: null
              }
            ]
          }
        })
      return Promise.resolve({ data: { data: [] } })
    })
    h.post.mockResolvedValue({ data: { data: route({ id: 9, resource_id: 20 }) } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <NotifyRoutesCard app={{ id: 4, owners: 2 }} isAdmin={false} />
      </QueryClientProvider>
    )
    const mine = (await screen.findByText('Orders alerts')).closest('li') as HTMLElement
    expect(screen.queryByText('Other app')).toBeNull()
    expect(within(mine).getByRole('button', { name: /Test/ })).toBeTruthy()
    expect(within(mine).getByText(/Reaches everyone who can read #orders/)).toBeTruthy()
    const theirs = screen.getByText('Ops pager').closest('li') as HTMLElement
    expect(within(theirs).queryByRole('button', { name: /Test/ })).toBeNull()
    expect(within(theirs).getByText(/Set up by a Hub administrator/)).toBeTruthy()
    // An owner's resources are read for their app only.
    expect(h.get).toHaveBeenCalledWith('/hub/resources', { params: { app: 4 } })

    fireEvent.click(screen.getByRole('button', { name: /New route/ }))
    expect(screen.queryByLabelText('For')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    expect(h.post).toHaveBeenCalledWith('/hub/notify-routes', {
      name: null,
      scope: 'app',
      app_id: 4,
      events: ['deploy.failed', 'incident.opened'],
      resource_id: 20
    })
  })
})
