import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub providers (Task 3): the Connections tab. Secrets are only ever the mask (and a fingerprint);
// a save sends a secret only when one was typed; Test shows who the credentials are.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: (url: string) => h.del(url)
  }
}))

const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()

const { HubConnections } = await import('./HubConnections')
const { LinkedChange } = await import('./ChangeView')

const types = {
  risk_flags: ['destructive', 'data_loss', 'public_exposure', 'downtime', 'cost'],
  providers: [
    {
      key: 'github',
      label: 'GitHub',
      connection: {
        fields: [
          { key: 'org', label: 'Organisation', kind: 'string', required: true },
          { key: 'app_id', label: 'App id', kind: 'string', required: true },
          {
            key: 'private_key',
            label: 'Private key',
            kind: 'text',
            secret: true,
            required: true
          },
          { key: 'webhook_secret', label: 'Webhook secret', kind: 'string', secret: true }
        ]
      },
      types: [
        {
          key: 'github.repository',
          label: 'Repository',
          scope: 'app',
          fields: [],
          capabilities: {
            create: true,
            update: true,
            delete: true,
            adopt: true,
            snapshot: false,
            tag: false
          },
          reversible: true,
          refs: [],
          name_field: 'name',
          has_cost_class: false
        }
      ]
    }
  ]
}

const conn = {
  id: 7,
  provider: 'github',
  provider_label: 'GitHub',
  name: 'GitHub · acme',
  description: 'org acme',
  config: { org: 'acme', app_id: '12345' },
  secret_mask: '••••••',
  secret_fingerprint: '0123456789abcdef0123456789abcdef',
  secret_keys: ['private_key'],
  status: 'ok',
  last_test_at: '2026-11-26T10:00:00Z',
  last_test: { ok: true, identity: 'org acme', permissions: [], missing: [] },
  created_by: null,
  updated_by: null,
  created_at: null,
  updated_at: '2026-11-26T10:00:00Z'
}

function routeGets(over: Record<string, unknown> = {}) {
  h.get.mockImplementation((url: string) => {
    if (url in over) return Promise.resolve({ data: { data: over[url] } })
    if (url === '/hub/provider-types') return Promise.resolve({ data: { data: types } })
    if (url === '/hub/connections') return Promise.resolve({ data: { data: [conn] } })
    if (url === '/hub/resource-changes') return Promise.resolve({ data: { data: [] } })
    if (url.endsWith('/unmanaged'))
      return Promise.resolve({
        data: {
          data: {
            items: [
              {
                type: 'github.repository',
                externalId: 'R_9',
                name: 'old-site',
                fields: {},
                tags: {}
              }
            ],
            cursor: null
          }
        }
      })
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <HubConnections />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

afterEach(() => vi.clearAllMocks())

describe('HubConnections', () => {
  it('shows a stored secret as the mask with the fingerprint, never a value', async () => {
    routeGets()
    mount()
    fireEvent.click(await screen.findByText('GitHub · acme'))
    const key = (await screen.findByLabelText('Private key')) as HTMLInputElement
    expect(key.value).toBe('••••••')
    expect(key.type).toBe('password')
    expect((screen.getByLabelText('Webhook secret') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('0123456789ab')).toBeTruthy()
    expect(screen.getByText('The connection works')).toBeTruthy()
  })

  it('saving without touching a secret sends none; typing one sends only it', async () => {
    routeGets()
    h.patch.mockResolvedValue({ data: { data: conn } })
    mount()
    fireEvent.click(await screen.findByText('GitHub · acme'))
    const org = (await screen.findByLabelText('Organisation')) as HTMLInputElement
    fireEvent.change(org, { target: { value: 'acme-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1))
    const [url, body] = h.patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/hub/connections/7')
    expect(body).toEqual({ name: 'GitHub · acme', config: { org: 'acme-2', app_id: '12345' } })

    fireEvent.change(screen.getByLabelText('Webhook secret'), {
      target: { value: 'test-secret-hook' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(2))
    const second = h.patch.mock.calls[1]?.[1] as { secrets?: Record<string, unknown> }
    expect(second.secrets).toEqual({ webhook_secret: 'test-secret-hook' })
  })

  it('a new connection needs its required secret before it is sent', async () => {
    routeGets({ '/hub/connections': [] })
    h.post.mockResolvedValue({ data: { data: { ...conn, id: 8 } } })
    mount()
    const add = (await screen.findByRole('button', {
      name: /Connect an account/
    })) as HTMLButtonElement
    await waitFor(() => expect(add.disabled).toBe(false))
    fireEvent.click(add)
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'GH' } })
    fireEvent.change(screen.getByLabelText('Organisation'), { target: { value: 'acme' } })
    fireEvent.change(screen.getByLabelText('App id'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    expect(await screen.findByText('Required')).toBeTruthy()
    expect(h.post).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Private key'), {
      target: { value: 'test-secret-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    const [url, body] = h.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/hub/connections')
    expect(body).toEqual({
      provider: 'github',
      name: 'GH',
      config: { org: 'acme', app_id: '1' },
      secrets: { private_key: 'test-secret-key' }
    })
  })

  it('Test shows who the credentials are and what is missing', async () => {
    routeGets()
    h.post.mockImplementation((url: string) =>
      url === '/hub/connections/7/test'
        ? Promise.resolve({
            data: {
              data: {
                ok: false,
                identity: 'app nivaro-hub',
                permissions: [
                  { type: 'github.repository', need: 'contents:write', has: false },
                  { type: '*', need: 'metadata:read', has: true }
                ],
                missing: ['contents:write']
              }
            }
          })
        : Promise.reject(new Error(url))
    )
    mount()
    fireEvent.click(await screen.findByText('GitHub · acme'))
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    expect(await screen.findByText('The connection needs fixing')).toBeTruthy()
    expect(screen.getByText('app nivaro-hub')).toBeTruthy()
    expect(screen.getByLabelText('Missing')).toBeTruthy()
    expect(screen.getByText('contents:write')).toBeTruthy()
  })

  it('lists what the account holds outside the Hub, to adopt', async () => {
    routeGets()
    // Opening a connection never calls the provider by itself.
    mount()
    fireEvent.click(await screen.findByText('GitHub · acme'))
    // Listing reads the provider: only when asked.
    fireEvent.click(await screen.findByRole('button', { name: 'List repository' }))
    expect(await screen.findByText('old-site')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Adopt…' })).toBeTruthy()
  })

  it('lists open changes (approval first) and opens one in the ?change= panel', async () => {
    const pendingRow = {
      id: 31,
      connection_id: 7,
      app_id: 4,
      environment_id: 5,
      scope: 'app',
      status: 'pending_approval',
      plan: {
        request: {
          ops: [{ action: 'create', type: 'github.repository', fields: { name: 'site' } }]
        },
        ops: [
          {
            kind: 'create',
            type: 'github.repository',
            resourceId: null,
            externalId: null,
            reason: 'Create GitHub repository site.',
            changes: [],
            preconditions: {},
            risk: ['cost']
          }
        ],
        gates: [],
        blockers: []
      },
      plan_hash: 'h1',
      steps: [],
      created_at: '2026-11-26T10:00:00Z'
    }
    routeGets({ '/hub/resource-changes': [pendingRow], '/hub/resource-changes/31': pendingRow })
    mount()
    expect(await screen.findByText('Open changes')).toBeTruthy()
    expect(await screen.findByText(/1 waiting for your approval/)).toBeTruthy()
    const row = await screen.findByRole('button', { name: /Create Repository site/ })
    expect(row.textContent).toContain('GitHub · acme')
    const asked = h.get.mock.calls.find((c) => c[0] === '/hub/resource-changes')
    expect((asked?.[1] as { params: Record<string, unknown> }).params.status).toBe(
      'planned,pending_approval,applying,failed,interrupted'
    )
    fireEvent.click(row)
    expect(await screen.findByText('Change 31')).toBeTruthy()
    await waitFor(() =>
      expect(h.get.mock.calls.some((c) => c[0] === '/hub/resource-changes/31')).toBe(true)
    )
  })

  it('shows no open changes card when nothing is open', async () => {
    routeGets()
    mount()
    expect(await screen.findByText('GitHub · acme')).toBeTruthy()
    expect(screen.queryByText('Open changes')).toBeNull()
  })

  it('names a change by its type label', async () => {
    routeGets({
      '/hub/resource-changes': [
        {
          id: 31,
          connection_id: 7,
          app_id: 4,
          environment_id: 5,
          scope: 'app',
          status: 'pending_approval',
          plan: {
            ops: [
              {
                kind: 'create',
                type: 'github.repository',
                resourceId: null,
                externalId: null,
                reason: 'New',
                changes: [],
                preconditions: {},
                risk: ['cost']
              }
            ]
          },
          plan_hash: 'h1',
          steps: [],
          created_at: '2026-11-26T10:00:00Z'
        }
      ]
    })
    mount()
    expect(await screen.findByText('Waiting for approval')).toBeTruthy()
    // The type's own label, never lower-cased ("Create Repository", not "Create repository").
    expect(await screen.findByText('Create Repository')).toBeTruthy()
  })
})

describe('a change link', () => {
  const link = (id: string) =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={[`/hub/connections?change=${id}`]}>
          <LinkedChange isAdmin />
        </MemoryRouter>
      </QueryClientProvider>
    )

  it('opens the change named in ?change=', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/resource-changes/42')
        return {
          data: {
            data: {
              id: 42,
              status: 'applied',
              plan: { ops: [], gates: [], blockers: [] },
              steps: [],
              created_at: '2026-11-26T10:00:00Z'
            }
          }
        }
      return { data: { data: types } }
    })
    link('42')
    expect(await screen.findByText('Change 42')).toBeTruthy()
    await waitFor(() =>
      expect(h.get.mock.calls.some((c) => c[0] === '/hub/resource-changes/42')).toBe(true)
    )
  })

  it('says so for an id that is not a number, and reads nothing', async () => {
    h.get.mockClear()
    link('abc')
    expect(await screen.findByText(/not a change number/)).toBeTruthy()
    expect(h.get.mock.calls.some((c) => String(c[0]).includes('abc'))).toBe(false)
  })
})
