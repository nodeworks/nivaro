import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub providers (Task 3): the generic form draws every FieldSpec kind (string, number, boolean,
// enum, list, object, ref, secret) and Plan change sends the request the engine plans.

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
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()
// The region picker's list (cmdk) measures itself.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const { ResourceForm } = await import('./ResourceForm')

// The running cost estimate (Task 44c) also POSTs, to /hub/providers/estimate: the plan's own
// calls are the ones to /hub/resources/plan.
const planCalls = () =>
  h.post.mock.calls.filter((c) => c[0] === '/hub/resources/plan') as Array<[string, unknown]>

const type = {
  key: 'aws.security_group',
  label: 'Security group',
  scope: 'app' as const,
  capabilities: {
    create: true,
    update: true,
    delete: true,
    adopt: true,
    snapshot: false,
    tag: true
  },
  reversible: true,
  refs: [{ field: 'vpc', type: 'aws.vpc' }],
  name_field: 'name',
  has_cost_class: false,
  fields: [
    { key: 'name', label: 'Name', kind: 'string' as const, required: true },
    { key: 'max_rules', label: 'Max rules', kind: 'number' as const },
    { key: 'logging', label: 'Logging', kind: 'boolean' as const },
    {
      key: 'mode',
      label: 'Mode',
      kind: 'enum' as const,
      options: [
        { value: 'strict', label: 'Strict' },
        { value: 'open', label: 'Open' }
      ]
    },
    { key: 'vpc', label: 'Network', kind: 'ref' as const, refType: 'aws.vpc' },
    { key: 'api_key', label: 'API key', kind: 'secret' as const },
    {
      key: 'owner',
      label: 'Owner',
      kind: 'object' as const,
      fields: [{ key: 'team', label: 'Team', kind: 'string' as const }]
    },
    {
      key: 'cidrs',
      label: 'Allowed ranges',
      kind: 'list' as const,
      items: { key: 'cidr', label: 'Range', kind: 'string' as const }
    },
    { key: 'arn', label: 'ARN', kind: 'string' as const, readOnly: true },
    { key: 'region', label: 'Region', kind: 'string' as const, createOnly: true }
  ]
}

const vpc = {
  id: 3,
  connection_id: 2,
  provider: 'aws',
  type: 'aws.vpc',
  external_id: 'vpc-1',
  name: 'main network',
  scope: 'shared',
  app_id: null,
  environment_id: null,
  desired: null,
  observed: null,
  drift: false,
  observed_at: null,
  tags: {},
  refs: [],
  created_by: null,
  adopted: true,
  deleted_at: null,
  created_at: null,
  updated_at: null
}

const plan = {
  changeId: 41,
  planHash: 'hash-1',
  status: 'planned',
  ops: [
    {
      kind: 'create',
      type: 'aws.security_group',
      resourceId: null,
      externalId: null,
      reason: 'A new security group',
      changes: [{ field: 'name', to: 'web' }],
      preconditions: {},
      risk: []
    }
  ],
  gates: [],
  needsConfirm: null,
  needsApproval: false,
  blockers: []
}

function mount(resource: Record<string, unknown> | null = null) {
  h.get.mockImplementation((url: string) => {
    if (url === '/hub/resources') return Promise.resolve({ data: { data: [vpc] } })
    if (url === '/hub/provider-types')
      return Promise.resolve({ data: { data: { risk_flags: [], providers: [] } } })
    if (url === '/hub/resource-changes/41')
      return Promise.resolve({ data: { data: { id: 41, status: 'planned', plan, steps: [] } } })
    return Promise.reject(new Error(url))
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ResourceForm
        type={type}
        resource={resource as never}
        connectionId={2}
        scope='app'
        appId={4}
        environmentId={5}
        idPrefix='t'
        isAdmin
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  )
}

afterEach(() => vi.clearAllMocks())

describe('ResourceForm', () => {
  it('renders every field kind from the spec; read-only ones are left out', async () => {
    mount()
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect((screen.getByLabelText('Max rules') as HTMLInputElement).inputMode).toBe('decimal')
    expect(screen.getByRole('switch')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Mode' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Network' })).toBeTruthy()
    expect((screen.getByLabelText('API key') as HTMLInputElement).type).toBe('password')
    expect(screen.getByRole('group', { name: 'Owner' })).toBeTruthy()
    expect(screen.getByLabelText('Team')).toBeTruthy()
    expect(screen.getByRole('group', { name: /Allowed ranges/ })).toBeTruthy()
    expect(screen.queryByLabelText('ARN')).toBeNull()
  })

  it('refuses before planning when a required field is empty', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Plan change' }))
    expect(await screen.findByText('Required')).toBeTruthy()
    expect(planCalls()).toHaveLength(0)
  })

  it('plans a create with the values typed, list items included', async () => {
    h.post.mockResolvedValue({ data: { data: plan } })
    mount()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'web' } })
    fireEvent.change(screen.getByLabelText('Max rules'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Add range/ }))
    fireEvent.change(screen.getByLabelText('Allowed ranges 1'), {
      target: { value: '10.0.0.0/8' }
    })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-secret-k' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plan change' }))
    await waitFor(() => expect(planCalls().length).toBeGreaterThan(0))
    const [url, body] = planCalls()[0] as [string, Record<string, unknown>]
    expect(url).toBe('/hub/resources/plan')
    expect(body).toEqual({
      connectionId: 2,
      scope: 'app',
      appId: 4,
      environmentId: 5,
      ops: [
        {
          action: 'create',
          type: 'aws.security_group',
          fields: {
            name: 'web',
            max_rules: 5,
            logging: false,
            cidrs: ['10.0.0.0/8'],
            api_key: 'test-secret-k'
          }
        }
      ]
    })
    // The plan opens in the change view.
    expect(await screen.findByText('A new security group')).toBeTruthy()
  })

  it('an update sends only changed fields and never the masked secret', async () => {
    h.post.mockResolvedValue({ data: { data: plan } })
    mount({
      ...vpc,
      id: 9,
      type: 'aws.security_group',
      scope: 'app',
      app_id: 4,
      desired: {
        name: 'web',
        max_rules: 5,
        api_key: { secret: true, fingerprint: 'f' },
        region: 'eu-west-1'
      }
    })
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('••••••')
    expect((screen.getByLabelText('Region') as HTMLInputElement).disabled).toBe(true)
    const plan1 = screen.getByRole('button', { name: 'Plan change' }) as HTMLButtonElement
    expect(plan1.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Max rules'), { target: { value: '6' } })
    fireEvent.click(plan1)
    await waitFor(() => expect(planCalls().length).toBeGreaterThan(0))
    const body = planCalls()[0]?.[1] as { ops: Array<Record<string, unknown>> }
    expect(body.ops).toEqual([{ action: 'update', resourceId: 9, fields: { max_rules: 6 } }])
  })

  it('a ref picks among the resources the Hub manages of that type', async () => {
    mount()
    const pick = await screen.findByRole('combobox', { name: 'Network' })
    await waitFor(() => expect((pick as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(pick)
    const list = await screen.findByRole('listbox')
    expect(within(list).getByText('main network')).toBeTruthy()
  })
})

describe('a field that picks from the connection (Task 3b C)', () => {
  const vpcType = {
    ...type,
    key: 'aws.vpc',
    label: 'VPC',
    scope: 'shared' as const,
    refs: [],
    fields: [
      {
        key: 'region',
        label: 'Region',
        kind: 'string' as const,
        required: true,
        createOnly: true,
        optionsFrom: 'regions'
      },
      { key: 'name', label: 'Name', kind: 'string' as const, required: true }
    ]
  }
  const vpcPlan = { ...plan, changeId: 42, ops: [] }

  function mountVpc() {
    h.get.mockImplementation((url: string) => {
      if (url === '/hub/connections')
        return Promise.resolve({
          data: {
            data: [
              {
                id: 2,
                provider: 'aws',
                provider_label: 'AWS',
                name: 'AWS prod',
                description: null,
                status: 'ok',
                field_options: { regions: ['us-east-1', 'eu-west-1'] }
              }
            ]
          }
        })
      if (url === '/hub/provider-types')
        return Promise.resolve({ data: { data: { risk_flags: [], providers: [] } } })
      if (url === '/hub/resource-changes/42')
        return Promise.resolve({
          data: { data: { id: 42, status: 'planned', plan: vpcPlan, steps: [] } }
        })
      return Promise.reject(new Error(url))
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <ResourceForm
          type={vpcType}
          resource={null}
          connectionId={2}
          scope='shared'
          idPrefix='v'
          isAdmin
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    )
  }

  it('titles the form with the type label and picks the region from the allowed list', async () => {
    h.post.mockResolvedValue({ data: { data: vpcPlan } })
    const { container } = mountVpc()
    expect(screen.getByRole('heading', { name: 'New VPC' })).toBeTruthy()
    const region = screen.getByRole('combobox', { name: 'Region' })
    // Starts on the connection's first allowed region.
    await waitFor(() => expect(region.textContent).toContain('us-east-1'))
    expect(container.querySelector('select')).toBeNull()
    fireEvent.click(region)
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['us-east-1', 'eu-west-1'])
    fireEvent.click(screen.getByRole('option', { name: 'eu-west-1' }))
    await waitFor(() => expect(region.textContent).toContain('eu-west-1'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'hub-shared-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plan change' }))
    await waitFor(() => expect(planCalls().length).toBeGreaterThan(0))
    expect(planCalls()[0]?.[1]).toMatchObject({
      scope: 'shared',
      ops: [
        { action: 'create', type: 'aws.vpc', fields: { region: 'eu-west-1', name: 'hub-shared-2' } }
      ]
    })
  })
})
