import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub providers (Task 3): the change view — the operations with their reasons, field changes and
// risk chips; a typed confirm when the plan names one; "Request approval" for an owner's cost
// change; an administrator approves with the plan hash; live steps once it runs.

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

const { ChangeView } = await import('./ChangeView')
const { changeFromPlan } = await import('./providers-api')

type Plan = Parameters<typeof changeFromPlan>[0]

const basePlan: Plan = {
  changeId: 12,
  planHash: 'hash-12',
  status: 'planned',
  ops: [
    {
      kind: 'delete',
      type: 'aws.s3_bucket',
      resourceId: 3,
      externalId: 'arn:aws:s3:::uploads',
      reason: 'Delete the bucket uploads',
      changes: [
        { field: 'versioning', from: true, to: null },
        { field: 'access_key', secret: true }
      ],
      preconditions: {},
      risk: ['destructive', 'data_loss']
    }
  ],
  gates: [
    { code: 'freeze', passed: true, message: 'No freeze on staging' },
    { code: 'window', passed: true, message: 'Inside the deploy window' }
  ],
  needsConfirm: 'uploads',
  needsApproval: false,
  blockers: []
}

const types = {
  risk_flags: [],
  providers: [
    {
      key: 'aws',
      label: 'AWS',
      connection: { fields: [] },
      types: [
        {
          key: 'aws.s3_bucket',
          label: 'S3 bucket',
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
          reversible: false,
          refs: [],
          name_field: 'name',
          has_cost_class: false
        }
      ]
    }
  ]
}

function row(over: Record<string, unknown> = {}, plan: Plan = basePlan) {
  return {
    id: plan.changeId,
    connection_id: 1,
    app_id: 4,
    environment_id: 5,
    scope: 'app',
    status: plan.status,
    plan: {
      request: {},
      ops: plan.ops,
      gates: plan.gates,
      needsConfirm: plan.needsConfirm,
      needsApproval: plan.needsApproval,
      blockers: plan.blockers,
      preconditionFingerprint: 'p',
      resourceIds: [3]
    },
    plan_hash: plan.planHash,
    steps: [],
    requested_by: null,
    approved_by: null,
    decline_reason: null,
    run_key: null,
    heartbeat_at: null,
    error_code: null,
    error: null,
    created_at: '2026-11-26T10:00:00Z',
    updated_at: null,
    finished_at: null,
    ...over
  }
}

function mount(plan: Plan, isAdmin: boolean, stored = row({}, plan)) {
  h.get.mockImplementation((url: string) => {
    if (url === '/hub/provider-types') return Promise.resolve({ data: { data: types } })
    if (url === `/hub/resource-changes/${plan.changeId}`)
      return Promise.resolve({ data: { data: stored } })
    return Promise.reject(new Error(url))
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ChangeView initial={changeFromPlan(plan)} isAdmin={isAdmin} onClose={vi.fn()} />
    </QueryClientProvider>
  )
}

afterEach(() => vi.clearAllMocks())

describe('ChangeView', () => {
  it('shows each operation with its reason, field changes and risk chips; never a secret', async () => {
    mount(basePlan, true)
    expect(screen.getByText('Delete the bucket uploads')).toBeTruthy()
    expect(screen.getByText('Removes something')).toBeTruthy()
    expect(screen.getByText('Can lose data')).toBeTruthy()
    expect(screen.getByText('versioning')).toBeTruthy()
    expect(screen.getByText('A new value is set (secrets are never shown)')).toBeTruthy()
    expect(screen.getByText('Every check passed')).toBeTruthy()
    expect(await screen.findByText('S3 bucket')).toBeTruthy()
  })

  it('needs the typed name before Start, and sends it with the plan hash', async () => {
    h.post.mockResolvedValue({ data: { data: { ...basePlan, status: 'applying' } } })
    mount(basePlan, true)
    const start = screen.getByRole('button', { name: 'Start change' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/to start/), { target: { value: 'upload' } })
    expect(start.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/to start/), { target: { value: 'uploads' } })
    expect(start.disabled).toBe(false)
    fireEvent.click(start)
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    expect(h.post.mock.calls[0]).toEqual([
      '/hub/resource-changes/12/start',
      { planHash: 'hash-12', confirm: 'uploads' }
    ])
  })

  it("an owner's cost change asks for approval instead of starting", async () => {
    const plan: Plan = {
      ...basePlan,
      changeId: 13,
      planHash: 'hash-13',
      needsConfirm: null,
      needsApproval: true,
      ops: [{ ...(basePlan.ops[0] as Plan['ops'][0]), kind: 'create', risk: ['cost'] }]
    }
    h.post.mockResolvedValue({ data: { data: { ...plan, status: 'pending_approval' } } })
    mount(plan, false)
    expect(screen.queryByLabelText(/to start/)).toBeNull()
    expect(screen.getByText('Costs money')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    expect(h.post.mock.calls[0]).toEqual([
      '/hub/resource-changes/13/start',
      { planHash: 'hash-13' }
    ])
  })

  it('an administrator approves a pending change with its plan hash, or declines with a reason', async () => {
    const plan: Plan = {
      ...basePlan,
      changeId: 14,
      planHash: 'hash-14',
      status: 'pending_approval'
    }
    h.post.mockResolvedValue({ data: { data: plan } })
    mount(plan, true)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and start' }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    expect(h.post.mock.calls[0]).toEqual([
      '/hub/resource-changes/14/approve',
      { planHash: 'hash-14' }
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Decline…' }))
    const decline = screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement
    expect(decline.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Why not/), { target: { value: 'Too big' } })
    fireEvent.click(decline)
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2))
    expect(h.post.mock.calls[1]).toEqual([
      '/hub/resource-changes/14/decline',
      { reason: 'Too big' }
    ])
  })

  it('an owner sees a pending change as waiting, without approve', async () => {
    const plan: Plan = { ...basePlan, changeId: 15, status: 'pending_approval' }
    mount(plan, false)
    expect(await screen.findByText(/Waiting for a Hub administrator/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve and start' })).toBeNull()
  })

  it('a blocker stops the start outright', async () => {
    const plan: Plan = {
      ...basePlan,
      changeId: 16,
      blockers: [{ code: 'SHARED_IN_USE', message: '2 security groups use this VPC.' }]
    }
    mount(plan, true)
    expect(screen.getByRole('alert').textContent).toContain('Other resources still use this')
    expect(screen.queryByRole('button', { name: 'Start change' })).toBeNull()
  })

  it('a running change shows its steps; a failed step its scrubbed error and Resume', async () => {
    const plan: Plan = { ...basePlan, changeId: 17, status: 'failed' }
    mount(
      plan,
      true,
      row(
        {
          status: 'failed',
          error_code: 'PROVIDER_ERROR',
          error: 'The provider answered 503',
          steps: [
            {
              index: 0,
              status: 'failed',
              resourceId: 3,
              before: null,
              result: null,
              snapshot: null,
              error: { code: 'PROVIDER_ERROR', message: 'Slow down (503)', retryable: true },
              startedAt: null,
              finishedAt: null
            }
          ]
        },
        plan
      )
    )
    expect(await screen.findByText(/Slow down \(503\)/)).toBeTruthy()
    // The change's chip and the step's own state both say it.
    expect(screen.getAllByText('Failed').length).toBe(2)
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
  })
})
