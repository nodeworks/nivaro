import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedDeployment, SharedDetail, SharedListRow } from './shared-api'

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  admin: true
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: unknown) => h.get(url, opts),
    post: (url: string, body: unknown) => h.post(url, body),
    patch: (url: string, body: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: (url: string) => h.del(url)
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { is_admin: h.admin } }) }))

const { default: HubShared } = await import('./HubShared')

const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyz'
const ETAG = `"${'a'.repeat(64)}"`

const ROW: SharedDeployment = {
  id: 4,
  key: 'shared-one',
  name: 'Shared one',
  mode: 'registered',
  driver_id: null,
  stack: null,
  version_pin: '0.3.210',
  extensions: ['efp-ops'],
  extension_pins: {},
  host_pattern: '*.apps.example.com',
  link_url: 'https://shared-one.example.com',
  pool_budget: 60,
  status: 'active',
  settings: {},
  token: '••••••',
  last_seen_at: null,
  created_at: '2026-11-20T10:00:00.000Z',
  updated_at: null
}

const LIST: SharedListRow[] = [
  { ...ROW, apps: 2, live_replicas: 2 },
  {
    ...ROW,
    id: 5,
    key: 'shared-two',
    name: 'Shared two',
    mode: 'docker',
    driver_id: 3,
    version_pin: null,
    apps: 0,
    live_replicas: null
  }
]

const DETAIL: SharedDetail = {
  row: ROW,
  apps: [
    {
      env_id: 7,
      env_key: 'prod',
      env_status: 'active',
      app_id: 1,
      app_key: 'acme',
      app_name: 'Acme',
      tenant_id: 'acme-e7',
      status: 'active',
      placed_here: true,
      pool_max: 5,
      base_url: 'https://acme.example.com'
    },
    {
      env_id: 8,
      env_key: 'dev',
      env_status: 'maintenance',
      app_id: 1,
      app_key: 'acme',
      app_name: 'Acme',
      tenant_id: 'acme-e8',
      status: 'maintenance',
      placed_here: true,
      pool_max: null,
      base_url: 'https://acme-dev.example.com'
    }
  ],
  sightings: [
    { instance: 'web-1', version: '0.3.210', etag: ETAG, at: new Date().toISOString() },
    { instance: 'web-2', version: '0.3.210', etag: '"old"', at: new Date().toISOString() }
  ],
  previous_token_valid_until: null,
  list_etag: ETAG,
  env_block: 'HUB_SHARED_DEPLOYMENT=shared-one\nHUB_DEPLOYMENT_TOKEN=<shown once>',
  warnings: []
}

const STATUS = {
  state: 'ok',
  checked_at: new Date().toISOString(),
  version: '0.3.210',
  instance: 'web-1',
  registry: { count: 2, loaded_at: null, etag: ETAG, stale: false, dropped: [] },
  apps: [
    { id: 'acme-e7', schema: { state: 'ok', version: '0.3.210', error: null } },
    { id: 'acme-e8', schema: { state: 'failed', version: null, error: 'boom' } }
  ],
  extensions: ['efp-ops', 'surprise-ext'],
  oidc: null,
  process: {}
}

function routes(detail: SharedDetail = DETAIL, status: unknown = STATUS) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/shared') return { data: { data: LIST } }
    if (url === `/hub/shared/${detail.row.id}`) return { data: { data: detail } }
    if (url === `/hub/shared/${detail.row.id}/status`) return { data: { data: status } }
    if (url === '/hub/drivers') return { data: { data: [] } }
    throw Object.assign(new Error('not found'), { response: { status: 404, data: {} } })
  })
}

const wrap = (
  url = '/hub/shared',
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) =>
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <HubShared />
      </MemoryRouter>
    </QueryClientProvider>
  )

beforeEach(() => routes())

afterEach(() => {
  h.get.mockReset()
  h.post.mockReset()
  h.patch.mockReset()
  h.del.mockReset()
  h.admin = true
})

/** The page text a person reads: the collapsed "Details for support" left out. */
function shownText(): string {
  const copy = document.body.cloneNode(true) as HTMLElement
  for (const d of copy.querySelectorAll('[data-error-details]')) d.remove()
  return copy.textContent ?? ''
}

describe('HubShared', () => {
  it('lists the deployments: key, name, mode, version, apps and live replicas', async () => {
    wrap()
    const list = await screen.findByRole('list', { name: 'Shared deployments' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Shared one')).toBeInTheDocument()
    expect(within(rows[0]).getByText('shared-one')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Run elsewhere')).toBeInTheDocument()
    expect(within(rows[0]).getByText('0.3.210')).toBeInTheDocument()
    expect(within(rows[0]).getByText('2 apps')).toBeInTheDocument()
    expect(within(rows[0]).getByText('2 live')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Run by the Hub')).toBeInTheDocument()
    expect(within(rows[1]).getByText('No version yet')).toBeInTheDocument()
    // Redis down: unknown, never "0 live".
    expect(within(rows[1]).getByText('Replicas unknown')).toBeInTheDocument()
  })

  it('only administrators see the tab', () => {
    h.admin = false
    wrap()
    expect(screen.getByText(/Only administrators manage shared deployments/)).toBeInTheDocument()
  })

  it('create shows the token once; after closing, the detail shows the mask', async () => {
    h.post.mockResolvedValue({
      data: {
        data: {
          row: ROW,
          token: TOKEN,
          env_block: `HUB_SHARED_DEPLOYMENT=shared-one\nHUB_DEPLOYMENT_TOKEN=${TOKEN}`
        }
      }
    })
    wrap('/hub/shared?new=1')
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Shared one' } })
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'shared-one' } })
    fireEvent.change(screen.getByLabelText(/Link address/), {
      target: { value: 'https://shared-one.example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add shared deployment' }))
    expect(await screen.findByTestId('shared-token')).toHaveTextContent(TOKEN)
    fireEvent.click(screen.getByRole('button', { name: 'Done, I have stored it' }))
    await waitFor(() => expect(screen.queryByTestId('shared-token')).toBeNull())
    expect(screen.queryByText(new RegExp(TOKEN))).toBeNull()
    const card = await screen.findByRole('region', { name: 'Deployment token' })
    expect(within(card).getByText('••••••')).toBeInTheDocument()
  })

  it('rotating the token asks for an inline confirm before it calls the Hub', async () => {
    h.post.mockResolvedValue({
      data: {
        data: {
          token: TOKEN,
          previous_token_valid_until: '2026-11-23T12:00:00.000Z',
          reapply: 'manual',
          reapply_reason: null,
          env_block: null
        }
      }
    })
    wrap('/hub/shared?shared=4')
    const card = await screen.findByRole('region', { name: 'Deployment token' })
    fireEvent.click(within(card).getByRole('button', { name: 'Rotate token' }))
    expect(h.post).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: 'Rotate now?' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/shared/4/token', {}))
    expect(await screen.findByTestId('shared-token')).toHaveTextContent(TOKEN)
  })

  it('Done drops the rotated token from memory (the mutation cache holds no answer with it)', async () => {
    h.post.mockResolvedValue({
      data: {
        data: {
          token: TOKEN,
          previous_token_valid_until: null,
          reapply: 'manual',
          reapply_reason: null,
          env_block: null
        }
      }
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const holdsToken = () =>
      client
        .getMutationCache()
        .getAll()
        .some((m) => JSON.stringify(m.state.data ?? null).includes(TOKEN))
    wrap('/hub/shared?shared=4', client)
    const card = await screen.findByRole('region', { name: 'Deployment token' })
    fireEvent.click(within(card).getByRole('button', { name: 'Rotate token' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Rotate now?' }))
    expect(await screen.findByTestId('shared-token')).toHaveTextContent(TOKEN)
    expect(holdsToken()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Done, I have stored it' }))
    await waitFor(() => expect(holdsToken()).toBe(false))
    expect(screen.queryByTestId('shared-token')).toBeNull()
  })

  it('a shown token is gone once the person leaves that deployment', async () => {
    h.post.mockResolvedValue({
      data: {
        data: {
          token: TOKEN,
          previous_token_valid_until: null,
          reapply: 'manual',
          reapply_reason: null,
          env_block: null
        }
      }
    })
    wrap('/hub/shared?shared=4')
    const card = await screen.findByRole('region', { name: 'Deployment token' })
    fireEvent.click(within(card).getByRole('button', { name: 'Rotate token' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Rotate now?' }))
    expect(await screen.findByTestId('shared-token')).toHaveTextContent(TOKEN)
    const list = screen.getByRole('list', { name: 'Shared deployments' })
    fireEvent.click(within(list).getByText('Shared two'))
    await waitFor(() => expect(screen.queryByTestId('shared-token')).toBeNull())
    fireEvent.click(within(list).getByText('Shared one'))
    await screen.findByRole('region', { name: 'Deployment token' })
    expect(screen.queryByTestId('shared-token')).toBeNull()
    expect(screen.queryByText(TOKEN)).toBeNull()
  })

  it('the detail shows apps with schema state, replicas holding the latest list, and warnings', async () => {
    wrap('/hub/shared?shared=4')
    const apps = await screen.findByRole('table', { name: 'Apps on this deployment' })
    expect(within(apps).getByText('acme-e7')).toBeInTheDocument()
    expect(await within(apps).findByText('Migration failed')).toBeInTheDocument()
    expect(within(apps).getByText('Up to date')).toBeInTheDocument()
    expect(within(apps).getByText('Maintenance')).toBeInTheDocument()
    const replicas = screen.getByRole('table', { name: 'Replicas' })
    const r1 = within(replicas).getByText('web-1').closest('tr') as HTMLElement
    const r2 = within(replicas).getByText('web-2').closest('tr') as HTMLElement
    expect(within(r1).getByText('Yes')).toBeInTheDocument()
    expect(within(r2).getByText('No')).toBeInTheDocument()
    expect(
      await screen.findByText('The deployment loaded other extensions than the Hub lists')
    ).toBeInTheDocument()
    // Registered mode: the settings to run it yourself, the token as a placeholder.
    expect(screen.getByRole('region', { name: 'Run it yourself' })).toHaveTextContent(
      'HUB_SHARED_DEPLOYMENT=shared-one'
    )
  })

  it('a deployment that does not answer says why in plain words', async () => {
    routes(DETAIL, {
      state: 'unreachable',
      code: 'LINK_REFUSED',
      message: 'The deployment refused the token.',
      checked_at: new Date().toISOString()
    })
    wrap('/hub/shared?shared=4')
    expect(await screen.findByText('Not answering')).toBeInTheDocument()
    expect(screen.getByText("The deployment did not accept the Hub's token")).toBeInTheDocument()
    expect(shownText()).not.toMatch(/LINK_REFUSED/)
  })

  it('deleting a deployment that served apps retires it and stays on its page', async () => {
    h.del.mockResolvedValue({ data: { data: { id: 4, outcome: 'retired' } } })
    wrap('/hub/shared?shared=4')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete now?' }))
    await waitFor(() => expect(h.del).toHaveBeenCalledWith('/hub/shared/4'))
    // The detail is read again (now retired); the page stays on it.
    await waitFor(() =>
      expect(h.get.mock.calls.filter(([u]) => u === '/hub/shared/4').length).toBeGreaterThan(1)
    )
    expect(screen.getByRole('region', { name: 'Deployment token' })).toBeInTheDocument()
  })

  it('delete is a two-press inline confirm; a refusal shows in plain words, no status code', async () => {
    h.del.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 409',
      response: {
        status: 409,
        data: {
          statusCode: 409,
          code: 'SHARED_IN_USE',
          error: 'Conflict',
          message: 'Environments are placed here.'
        }
      }
    })
    wrap('/hub/shared?shared=4')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(h.del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete now?' }))
    expect(await screen.findByText('Apps are still placed on this deployment')).toBeInTheDocument()
    expect(shownText()).not.toMatch(/409|status code/)
  })
})
