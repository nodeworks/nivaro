import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub providers (Task 3): an environment's Resources panel groups what it owns outside Nivaro by
// provider, with a drift chip and the provider's own state; it stays out of the way when there
// is nothing and nothing the person could add; drift offers Re-apply / Accept as a plan.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()

const { AppConnectionsCard, ResourcesPanel } = await import('./ResourcesPanel')

const app = { id: 4, key: 'shop', name: 'Shop', environments: [], owners: [] }
const env = { id: 5, app_id: 4, key: 'staging', position: 1, status: 'ok', base_url: 'https://x' }

const res = (over: Record<string, unknown>) => ({
  connection_id: 2,
  scope: 'app',
  app_id: 4,
  environment_id: 5,
  desired: {},
  drift: false,
  observed_at: '2026-11-26T10:00:00Z',
  tags: {},
  refs: [],
  created_by: null,
  adopted: false,
  deleted_at: null,
  created_at: null,
  updated_at: null,
  ...over
})

const resources = [
  res({
    id: 1,
    provider: 'github',
    type: 'github.repository',
    external_id: 'R_1',
    name: 'shop-web',
    observed: {
      type: 'github.repository',
      externalId: 'R_1',
      name: 'shop-web',
      fields: {},
      tags: {},
      status: 'active'
    }
  }),
  res({
    id: 2,
    provider: 'aws',
    type: 'aws.s3_bucket',
    external_id: 'arn:aws:s3:::shop-uploads',
    name: 'shop-uploads',
    drift: true,
    observed: {
      type: 'aws.s3_bucket',
      externalId: 'arn',
      name: 'shop-uploads',
      fields: {},
      tags: {},
      status: 'available'
    }
  }),
  res({
    id: 3,
    provider: 'aws',
    type: 'aws.security_group',
    external_id: 'sg-1',
    name: 'shop-sg',
    observed: null
  })
]

const cap = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: true }
const t = (key: string, label: string) => ({
  key,
  label,
  scope: 'app',
  fields: [],
  capabilities: cap,
  reversible: true,
  refs: [],
  name_field: 'name',
  has_cost_class: false
})
const types = {
  risk_flags: [],
  providers: [
    {
      key: 'aws',
      label: 'AWS',
      connection: { fields: [] },
      types: [t('aws.s3_bucket', 'S3 bucket'), t('aws.security_group', 'Security group')]
    },
    {
      key: 'github',
      label: 'GitHub',
      connection: { fields: [] },
      types: [t('github.repository', 'Repository')]
    }
  ]
}
const conn = {
  id: 2,
  provider: 'aws',
  provider_label: 'AWS',
  name: 'AWS prod',
  description: null,
  status: 'ok'
}

function routes(rows: unknown[], allowed: unknown[]) {
  h.get.mockImplementation((url: string) => {
    if (url === '/hub/resources') return Promise.resolve({ data: { data: rows } })
    if (url === '/hub/apps/4/connections')
      return Promise.resolve({
        data: {
          data: {
            connection_ids: allowed.map((c) => (c as { id: number }).id),
            connections: allowed
          }
        }
      })
    if (url === '/hub/provider-types') return Promise.resolve({ data: { data: types } })
    if (url === '/hub/connections') return Promise.resolve({ data: { data: [conn] } })
    if (url.startsWith('/hub/resource-changes/'))
      return Promise.resolve({
        data: { data: { id: 50, status: 'planned', plan: null, steps: [] } }
      })
    return Promise.reject(new Error(url))
  })
}

function mount(canDeploy = true, node: React.ReactNode = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        {node ?? (
          <ResourcesPanel
            app={app as never}
            env={env as never}
            isAdmin={false}
            canDeploy={canDeploy}
            layout='card'
          />
        )}
      </QueryClientProvider>
    </MemoryRouter>
  )
}

afterEach(() => vi.clearAllMocks())

describe('ResourcesPanel', () => {
  it('groups by provider with drift and health chips', async () => {
    routes(resources, [conn])
    mount()
    const toggle = await screen.findByRole('button', { name: /Outside resources/ })
    expect(toggle.textContent).toContain('3')
    expect(toggle.textContent).toContain('1 drifted')
    expect(toggle.textContent).toContain('1 gone')
    fireEvent.click(toggle)
    const aws = await screen.findByRole('region', { name: 'AWS' })
    const gh = screen.getByRole('region', { name: 'GitHub' })
    expect(within(aws).getByText('shop-uploads')).toBeTruthy()
    expect(within(aws).getByText('Drifted')).toBeTruthy()
    expect(within(aws).getByText('available')).toBeTruthy()
    expect(within(aws).getByText('Gone')).toBeTruthy()
    expect(within(gh).getByText('In sync')).toBeTruthy()
    expect(within(gh).getByText('active')).toBeTruthy()
    // AWS before GitHub (label order).
    const groups = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(groups).toEqual(['AWS', 'GitHub'])
  })

  it('hides itself with no resources and nothing the person may add', async () => {
    routes([], [conn])
    const { container } = mount(false)
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2))
    expect(container.textContent).toBe('')
  })

  it('a drifted resource plans a re-apply on one click', async () => {
    routes(resources, [conn])
    h.post.mockResolvedValue({
      data: {
        data: {
          changeId: 50,
          planHash: 'h',
          status: 'planned',
          ops: [],
          gates: [],
          needsConfirm: null,
          needsApproval: false,
          blockers: []
        }
      }
    })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Outside resources/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Re-apply/ }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    expect(h.post.mock.calls[0]).toEqual([
      '/hub/resources/plan',
      {
        connectionId: 2,
        scope: 'app',
        appId: 4,
        environmentId: 5,
        ops: [{ action: 'reapply', resourceId: 2 }]
      }
    ])
  })

  it('a create that never reached the provider says Create failed, with Resume and Discard', async () => {
    const failed = res({
      id: 9,
      provider: 'aws',
      type: 'aws.s3_bucket',
      external_id: null,
      name: 'shop-logs',
      observed: null,
      observed_at: null,
      pending_create: { change_id: 61, status: 'failed', resumable: true }
    })
    const stuck = res({
      id: 10,
      provider: 'aws',
      type: 'aws.security_group',
      external_id: null,
      name: 'shop-sg',
      observed: null,
      observed_at: null,
      pending_create: { change_id: 62, status: 'failed', resumable: false }
    })
    routes([failed, stuck], [conn])
    h.post.mockResolvedValue({ data: { data: { resourceId: 9, changeId: 61 } } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Outside resources/ }))
    const aws = await screen.findByRole('region', { name: 'AWS' })
    expect(within(aws).getAllByText('Create failed').length).toBe(2)
    expect(within(aws).queryByText('Not checked yet')).toBeNull()
    // A row that was never made has no change or delete of its own.
    expect(within(aws).queryByRole('button', { name: /Change shop-/ })).toBeNull()
    expect(within(aws).queryByRole('button', { name: /Delete shop-/ })).toBeNull()
    // Resume only where a retry can help.
    const resume = within(aws).getAllByRole('button', { name: 'Resume' })
    expect(resume.length).toBe(1)
    fireEvent.click(resume[0] as HTMLElement)
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/resource-changes/61/resume', {}))
    // Discard is two presses.
    const discard = within(aws).getByRole('button', { name: /Discard shop-sg/ })
    fireEvent.click(discard)
    expect(h.post).not.toHaveBeenCalledWith('/hub/resources/10/discard', undefined)
    fireEvent.click(within(aws).getByRole('button', { name: /Discard shop-sg\?/ }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/resources/10/discard', undefined))
  })

  it('without the right to deploy here, no actions show', async () => {
    routes(resources, [conn])
    mount(false)
    fireEvent.click(await screen.findByRole('button', { name: /Outside resources/ }))
    await screen.findByRole('region', { name: 'AWS' })
    expect(screen.queryByRole('button', { name: /Re-apply/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add resource/ })).toBeNull()
  })
})

describe('AppConnectionsCard', () => {
  it('saves the connections an app’s owners may use', async () => {
    routes([], [])
    h.put.mockResolvedValue({ data: { data: { connection_ids: [2] } } })
    mount(true, <AppConnectionsCard appId={4} />)
    fireEvent.click(await screen.findByLabelText(/AWS prod/))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.put).toHaveBeenCalled())
    expect(h.put.mock.calls[0]).toEqual(['/hub/apps/4/connections', { connection_ids: [2] }])
  })
})
