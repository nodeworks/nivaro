import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub providers (Task 3b): Shared infrastructure lists its open changes (shared scope only) and
// shows a create that never reached the provider as "Create failed" — never as a real resource
// that is "Not checked yet · Not used".

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()

const { SharedInfra } = await import('./SharedInfra')

const vpcType = {
  key: 'aws.vpc',
  label: 'VPC',
  scope: 'shared',
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
}
const types = {
  risk_flags: [],
  providers: [{ key: 'aws', label: 'AWS', connection: { fields: [] }, types: [vpcType] }]
}
const conn = {
  id: 2,
  provider: 'aws',
  provider_label: 'AWS',
  name: 'AWS shared',
  description: 'AWS · us-east-1',
  config: {},
  secret_mask: null,
  secret_fingerprint: null,
  secret_keys: [],
  status: 'ok',
  last_test_at: null,
  last_test: null,
  created_by: null,
  updated_by: null,
  created_at: null,
  updated_at: null
}
const failedVpc = {
  id: 9,
  connection_id: 2,
  provider: 'aws',
  type: 'aws.vpc',
  external_id: null,
  name: 'hub-shared-2',
  scope: 'shared',
  app_id: null,
  environment_id: null,
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
  updated_at: null,
  pending_create: { change_id: 77, status: 'failed', resumable: false }
}
const failedChange = {
  id: 77,
  connection_id: 2,
  app_id: null,
  environment_id: null,
  scope: 'shared',
  status: 'failed',
  plan: {
    request: { ops: [{ action: 'create', type: 'aws.vpc', fields: { name: 'hub-shared-2' } }] },
    ops: [
      {
        kind: 'create',
        type: 'aws.vpc',
        resourceId: null,
        externalId: null,
        reason: 'Create VPC hub-shared-2',
        changes: [],
        preconditions: {},
        risk: []
      }
    ]
  },
  plan_hash: 'h',
  steps: [],
  created_at: '2026-11-26T10:00:00Z'
}

afterEach(() => vi.clearAllMocks())

describe('SharedInfra', () => {
  it('lists shared open changes and shows a failed create as Create failed', async () => {
    h.get.mockImplementation((url: string) => {
      if (url === '/hub/provider-types') return Promise.resolve({ data: { data: types } })
      if (url === '/hub/connections') return Promise.resolve({ data: { data: [conn] } })
      if (url === '/hub/resources') return Promise.resolve({ data: { data: [failedVpc] } })
      if (url === '/hub/resource-changes')
        return Promise.resolve({ data: { data: [failedChange] } })
      return Promise.reject(new Error(url))
    })
    render(
      <MemoryRouter>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <SharedInfra />
        </QueryClientProvider>
      </MemoryRouter>
    )
    expect(await screen.findByText('Open changes')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /Create VPC hub-shared-2/ })).toBeTruthy()
    const asked = h.get.mock.calls.find((c) => c[0] === '/hub/resource-changes')
    expect((asked?.[1] as { params: Record<string, unknown> }).params).toMatchObject({
      scope: 'shared'
    })
    expect(await screen.findByText('Create failed')).toBeTruthy()
    expect(screen.queryByText('Not used')).toBeNull()
    expect(screen.queryByText('Not checked yet')).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Discard hub-shared-2/ })).toBeTruthy()
    )
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })
})
