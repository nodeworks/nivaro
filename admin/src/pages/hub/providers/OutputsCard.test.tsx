import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Hub providers (Task 13): the Outputs card shows what a resource hands out without any value
// (held + a short fingerprint, lost → Rotate), and where each output goes with the binding's own
// state (written, needs Apply now, not written + the reason).

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    put: (url: string, body?: unknown) => h.put(url, body),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

const { OutputsCard } = await import('./OutputsCard')

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
