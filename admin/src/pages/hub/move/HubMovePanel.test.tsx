import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 6, Task 18): the move panel — pick a target, read the plan, tick the
// checklist, type <app>/<env>, start; then follow the steps, wait for a manual address, cancel,
// resume or roll back.

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: (url: string) => h.del(url)
  }
}))

const { HubMovePanel } = await import('./HubMovePanel')

beforeAll(() => {
  // cmdk (the Combobox list) measures and scrolls; jsdom has neither.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
})

const env = {
  id: 10,
  app_id: 1,
  key: 'production',
  position: 0,
  status: 'active',
  base_url: 'https://efp.example.com',
  hostnames: ['efp.example.com'],
  placement_id: 5,
  version_pin: '0.3.210',
  hub_token: '••••••'
}

const shared = [
  {
    id: 3,
    key: 'east',
    name: 'East shared',
    mode: 'docker',
    status: 'active',
    version_pin: '0.3.210',
    pool_budget: 60
  },
  {
    id: 4,
    key: 'old',
    name: 'Old shared',
    mode: 'docker',
    status: 'retired',
    version_pin: '0.3.200',
    pool_budget: 60
  }
]

const basePlan = {
  kind: 'to_shared',
  routing: 'automatic',
  steps: ['check', 'files_warm', 'maintenance_on', 'release', 'retire_source', 'done'],
  route: [],
  manual_request: null,
  version: '0.3.210',
  hostnames: ['efp.example.com'],
  files: { count: 120, bytes: 5 * 1024 * 1024 },
  blockers: [],
  warnings: [],
  checklist: [
    {
      id: 'callbacks_registered',
      text: 'Register https://efp.example.com/api/auth/callback on the deployment sign-in app.',
      required: true
    }
  ],
  plan_hash: 'h1'
}

let plan: Record<string, unknown> = basePlan
let moves: Record<string, unknown>[] = []
let move: Record<string, unknown> | null = null

function routes() {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/shared') return { data: { data: shared } }
    if (url === '/hub/placements/5')
      return {
        data: { data: { id: 5, kind: 'dedicated', driver_id: 2, target: { stack: 'efp' } } }
      }
    if (url === '/hub/drivers')
      return {
        data: { data: [{ id: 2, kind: 'docker', name: 'Docker east', config: {}, secret: null }] }
      }
    if (url === '/hub/environments/10/moves') return { data: { data: moves } }
    if (url === '/hub/environments/10/app-key')
      return {
        data: { data: { known: false, key: null, fp: null, source: null, code: 'APP_KEY_UNKNOWN' } }
      }
    if (move && url === `/hub/moves/${move.id}`) return { data: { data: move } }
    throw new Error(`unexpected GET ${url}`)
  })
  h.post.mockImplementation(async (url: string) => {
    if (url === '/hub/environments/10/move/plan') return { data: { data: plan } }
    if (url === '/hub/environments/10/move') return { data: { data: { move_id: 77 } } }
    if (/^\/hub\/moves\/\d+\/(cancel|resume)$/.test(url)) return { data: { data: {} } }
    if (/^\/hub\/moves\/\d+\/confirm-route$/.test(url))
      return { data: { data: { serving: false } } }
    throw new Error(`unexpected POST ${url}`)
  })
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubMovePanel appKey='efp' env={env} idPrefix='mv' onClose={() => {}} />
    </QueryClientProvider>
  )
}

async function pickTarget(label: RegExp) {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Move to' }))
  fireEvent.click(await screen.findByRole('option', { name: label }))
}

beforeEach(() => {
  window.localStorage.clear()
  plan = basePlan
  moves = []
  move = null
  routes()
})
afterEach(() => vi.clearAllMocks())

describe('HubMovePanel — before start', () => {
  it('lists active shared deployments as targets, never a retired one', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('combobox', { name: 'Move to' }))
    expect(await screen.findByRole('option', { name: /Shared · east/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Shared · old/ })).toBeNull()
  })

  it('from a shared deployment, offers the dedicated stack it ran on before', async () => {
    moves = [
      {
        id: 50,
        environment_id: 10,
        from_placement_id: 5,
        to_placement_id: 9,
        kind: 'to_shared',
        status: 'success',
        steps: '[]'
      }
    ]
    // That move ended and was dismissed: the panel opens on the form.
    window.localStorage.setItem('nvr:hub-move-dismissed:10', '50')
    const base = h.get.getMockImplementation() as (url: string) => Promise<unknown>
    h.get.mockImplementation(async (url: string) =>
      url === '/hub/placements/9'
        ? {
            data: {
              data: { id: 9, kind: 'shared', shared_deployment_id: 4, driver_id: null, target: {} }
            }
          }
        : base(url)
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <HubMovePanel
          appKey='efp'
          env={{ ...env, placement_id: 9 }}
          idPrefix='mv'
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
    fireEvent.click(await screen.findByRole('combobox', { name: 'Move to' }))
    expect(
      await screen.findByRole('option', { name: /Dedicated · Docker east · efp/ })
    ).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Shared · east/ })).toBeInTheDocument()
  })

  it('born on shared: makes a new stack placement on a Docker driver and plans the move to it', async () => {
    window.localStorage.setItem('nvr:hub-move-dismissed:10', '0')
    const base = h.get.getMockImplementation() as (url: string) => Promise<unknown>
    h.get.mockImplementation(async (url: string) =>
      url === '/hub/placements/9'
        ? {
            data: {
              data: { id: 9, kind: 'shared', shared_deployment_id: 4, driver_id: null, target: {} }
            }
          }
        : base(url)
    )
    const basePost = h.post.getMockImplementation() as (
      url: string,
      b?: unknown
    ) => Promise<unknown>
    h.post.mockImplementation(async (url: string, b?: unknown) =>
      url === '/hub/placements' ? { data: { data: { id: 12 } } } : basePost(url, b)
    )
    h.del.mockResolvedValue({})
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={qc}>
        <HubMovePanel
          appKey='efp'
          env={{ ...env, placement_id: 9 }}
          idPrefix='mv'
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
    fireEvent.click(await screen.findByRole('combobox', { name: 'Move to' }))
    fireEvent.click(await screen.findByRole('option', { name: /New stack on Docker east/ }))
    expect(screen.getByLabelText('Stack name')).toHaveValue('efp-production')
    fireEvent.click(screen.getByRole('button', { name: 'Make the stack placement and plan' }))
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/placements', {
        kind: 'dedicated',
        driver_id: 2,
        target: { stack: 'efp-production' }
      })
    )
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/move/plan', {
        to: { kind: 'dedicated', placement_id: 12 }
      })
    )
    // Leaving without starting removes the placement again.
    view.unmount()
    await waitFor(() => expect(h.del).toHaveBeenCalledWith('/hub/placements/12'))
  })

  it('keeps Start off until required checklist items are ticked and the confirmation matches', async () => {
    renderPanel()
    await pickTarget(/Shared · east/)
    expect(await screen.findByText(/Register https:\/\/efp.example.com/)).toBeInTheDocument()
    const start = screen.getByRole('button', { name: 'Start move' })
    fireEvent.change(screen.getByLabelText(/Type efp\/production to move/), {
      target: { value: 'efp/production' }
    })
    expect(start).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Register https/ }))
    expect(start).toBeEnabled()
    fireEvent.click(start)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/move', {
        to: { kind: 'shared', shared_id: 3, pool_max: 5 },
        plan_hash: 'h1',
        confirm: 'efp/production',
        checklist: { callbacks_registered: true }
      })
    )
  })

  it('a P6-15 unverified side asks for its required item; the confirmation alone never starts', async () => {
    plan = {
      ...basePlan,
      checklist: [
        {
          id: 'redis_separate',
          text: 'The source and the target do not share one Redis database and channel prefix.',
          required: true
        }
      ],
      warnings: [
        { code: 'REDIS_UNVERIFIED', text: 'The Hub cannot see which Redis the target uses.' }
      ]
    }
    renderPanel()
    await pickTarget(/Shared · east/)
    expect(
      await screen.findByText('The Hub cannot see which Redis one side uses')
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Type efp\/production to move/), {
      target: { value: 'efp/production' }
    })
    const start = screen.getByRole('button', { name: 'Start move' })
    expect(start).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /do not share one Redis/ }))
    expect(start).toBeEnabled()
  })

  it('groups required items under Confirm before moving and asks for the plan once', async () => {
    plan = {
      ...basePlan,
      checklist: [
        { id: 'redis_separate', text: 'No shared Redis.', required: true },
        { id: 'issuer_same', text: 'Same Entra tenant.', required: true },
        { id: 'old_stack_stopped', text: 'Stop the old stack.', required: false }
      ]
    }
    renderPanel()
    await pickTarget(/Shared · east/)
    const group = await screen.findByRole('group', { name: 'Confirm before moving' })
    expect(within(group).getAllByRole('checkbox')).toHaveLength(2)
    expect(within(group).getByText(/0 of 2 ticked/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'After the move' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Type efp\/production to move/), {
      target: { value: 'efp/production' }
    })
    const start = screen.getByRole('button', { name: 'Start move' })
    fireEvent.click(within(group).getByRole('checkbox', { name: 'No shared Redis.' }))
    expect(start).toBeDisabled()
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Same Entra tenant.' }))
    expect(start).toBeEnabled()
    // The after-the-move reminder never gates Start.
    window.dispatchEvent(new Event('focus'))
    const asked = h.post.mock.calls.filter((c) => c[0] === '/hub/environments/10/move/plan')
    expect(asked).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Plan again' }))
    await waitFor(() =>
      expect(
        h.post.mock.calls.filter((c) => c[0] === '/hub/environments/10/move/plan')
      ).toHaveLength(2)
    )
  })

  it('a start refused with PLAN_BLOCKED says so in plain words and plans again', async () => {
    const { toast } = await import('sonner')
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 1)
    plan = { ...basePlan, checklist: [] }
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/environments/10/move/plan') return { data: { data: plan } }
      if (url === '/hub/environments/10/move')
        throw {
          response: {
            status: 409,
            data: {
              code: 'PLAN_BLOCKED',
              message: 'The move cannot start: ROW_SCHEDULES',
              blockers: [{ code: 'ROW_SCHEDULES', text: '' }]
            }
          }
        }
      throw new Error(url)
    })
    renderPanel()
    await pickTarget(/Shared · east/)
    fireEvent.change(await screen.findByLabelText(/Type efp\/production to move/), {
      target: { value: 'efp/production' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start move' }))
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('Something now stops this move', expect.anything())
    )
    const planCalls = h.post.mock.calls.filter((c) => c[0] === '/hub/environments/10/move/plan')
    await waitFor(() => expect(planCalls.length).toBeGreaterThanOrEqual(1))
    error.mockRestore()
  })

  it('a new connections count clears the ticks and the confirmation (a new plan)', async () => {
    renderPanel()
    await pickTarget(/Shared · east/)
    fireEvent.click(await screen.findByRole('checkbox', { name: /Register https/ }))
    const confirm = screen.getByLabelText(/Type efp\/production to move/)
    fireEvent.change(confirm, { target: { value: 'efp/production' } })
    fireEvent.change(screen.getByLabelText('Database connections'), { target: { value: '6' } })
    await waitFor(() => expect(confirm).toHaveValue(''))
    expect(await screen.findByRole('checkbox', { name: /Register https/ })).not.toBeChecked()
  })

  it('keeps Start off while a blocker is open, and says each blocker in plain words', async () => {
    plan = {
      ...basePlan,
      checklist: [],
      blockers: [
        { code: 'POOL_TOO_SMALL', text: '' },
        { code: 'ROW_SCHEDULES', text: '3 scheduled reports' },
        {
          code: 'SHARED_NOT_ACTIVE',
          text: 'The shared deployment east is retired; nothing moves onto it.'
        },
        { code: 'REDIS_SHARED', text: '' }
      ],
      warnings: [{ code: 'SIGNED_LINKS_RESET', text: '' }]
    }
    renderPanel()
    await pickTarget(/Shared · east/)
    const alert = await screen.findByRole('alert')
    expect(
      within(alert).getByText('The app needs at least 2 database connections')
    ).toBeInTheDocument()
    expect(within(alert).getByText('The app has schedules stored in its data')).toBeInTheDocument()
    // The app's own detail stays under the plain words.
    expect(within(alert).getByText('3 scheduled reports')).toBeInTheDocument()
    expect(
      within(alert).getByText('That shared deployment takes no apps right now')
    ).toBeInTheDocument()
    expect(
      within(alert).getByText('The shared deployment east is retired; nothing moves onto it.')
    ).toBeInTheDocument()
    expect(
      within(alert).getByText('The old and the new home share one Redis database')
    ).toBeInTheDocument()
    expect(screen.getByText('Links the old home signed stop working')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Type efp\/production to move/), {
      target: { value: 'efp/production' }
    })
    expect(screen.getByRole('button', { name: 'Start move' })).toBeDisabled()
  })

  it('an unknown app key blocker offers the app key field right there', async () => {
    plan = { ...basePlan, checklist: [], blockers: [{ code: 'APP_KEY_UNKNOWN', text: '' }] }
    renderPanel()
    await pickTarget(/Shared · east/)
    expect(
      await screen.findByText("The Hub does not know this app's encryption key")
    ).toBeInTheDocument()
    expect(await screen.findByLabelText('App encryption key')).toBeInTheDocument()
  })

  it('a manual route shows the request to send, ready to copy', async () => {
    plan = {
      ...basePlan,
      checklist: [],
      routing: 'manual',
      manual_request: 'Point efp.example.com at shared-east.example.net (TLS certificate needed).'
    }
    renderPanel()
    await pickTarget(/Shared · east/)
    expect(await screen.findByText('Address change request')).toBeInTheDocument()
    expect(screen.getByText('Manual address change')).toBeInTheDocument()
    expect(
      screen.getByText('Point efp.example.com at shared-east.example.net (TLS certificate needed).')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy the request' })).toBeInTheDocument()
  })

  it('a changed plan at start shows the new plan and asks for the confirmation again', async () => {
    plan = { ...basePlan, checklist: [] }
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/environments/10/move/plan') return { data: { data: plan } }
      if (url === '/hub/environments/10/move')
        throw {
          response: {
            status: 409,
            data: {
              code: 'PLAN_CHANGED',
              message: 'The plan changed',
              plan: {
                ...basePlan,
                checklist: [],
                plan_hash: 'h2',
                blockers: [{ code: 'BUSY', text: '' }]
              }
            }
          }
        }
      throw new Error(url)
    })
    renderPanel()
    await pickTarget(/Shared · east/)
    const confirm = await screen.findByLabelText(/Type efp\/production to move/)
    fireEvent.change(confirm, { target: { value: 'efp/production' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start move' }))
    expect(await screen.findByText(/The plan changed — check it again/)).toBeInTheDocument()
    expect(screen.getByText('Something else is running on this environment')).toBeInTheDocument()
    expect(confirm).toHaveValue('')
  })
})

const steps = [
  'check',
  'files_warm',
  'maintenance_on',
  'route',
  'verify',
  'release',
  'retire_source',
  'done'
]

function openMove(over: Record<string, unknown>) {
  move = {
    id: 77,
    app_id: 1,
    environment_id: 10,
    from_placement_id: 5,
    to_placement_id: 9,
    kind: 'to_shared',
    routing: 'automatic',
    status: 'running',
    step: 'files_warm',
    steps: JSON.stringify(steps),
    plan: JSON.stringify(basePlan),
    files: JSON.stringify({
      state: 'running',
      total: 100,
      copied: 40,
      skipped: 10,
      failed: 0,
      bytes: 2048
    }),
    checklist: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    ...over
  }
  moves = [move]
}

describe('HubMovePanel — a move in progress', () => {
  it('lists each step with its state and the files progress', async () => {
    openMove({})
    renderPanel()
    const list = await screen.findByRole('list', { name: 'Move steps' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0]).toHaveAttribute('data-state', 'done')
    expect(items[1]).toHaveAttribute('data-state', 'running')
    expect(items[2]).toHaveAttribute('data-state', 'pending')
    const bar = screen.getByRole('progressbar', { name: 'Files copied' })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
  })

  it('a manual address wait shows the request and Check now asks the Hub to check it', async () => {
    openMove({
      status: 'waiting',
      step: 'verify',
      routing: 'manual',
      plan: JSON.stringify({
        ...basePlan,
        routing: 'manual',
        manual_request: 'Point efp.example.com at shared-east.example.net.'
      })
    })
    renderPanel()
    const card = await screen.findByRole('region', { name: 'Waiting for the address' })
    expect(
      within(card).getByText('Point efp.example.com at shared-east.example.net.')
    ).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/moves/77/confirm-route', {}))
    expect(await screen.findByText(/still answers from the old home/)).toBeInTheDocument()
  })

  it('Cancel rolls back before release; after release no Cancel is offered (P6-17 I-2)', async () => {
    openMove({ step: 'maintenance_on' })
    const first = renderPanel()
    expect(await screen.findByText(/Cancel rolls the move back/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Roll back?' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/moves/77/cancel', {}))
    first.unmount()
    window.localStorage.clear()

    openMove({ step: 'retire_source' })
    renderPanel()
    expect(await screen.findByText(/can no longer be cancelled or rolled back/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel move' })).toBeNull()
    expect(screen.queryByText(/Cancel rolls the move back/)).toBeNull()
  })

  it('an interrupted move offers Resume and Roll back, each naming the move', async () => {
    openMove({ status: 'interrupted', step: 'maintenance_on' })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/moves/77/resume', {}))
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Roll back the move?' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/moves/77/cancel', {}))
  })

  it('an interrupted move past release offers only Resume', async () => {
    openMove({ status: 'interrupted', step: 'retire_source' })
    renderPanel()
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull()
  })
})

describe('HubMovePanel — a move that ended (ruling P6-17 I-1)', () => {
  const ended = {
    status: 'success',
    step: 'done',
    steps: {
      list: steps.map((key) => ({ key, state: key === 'retire_source' ? 'failed' : 'done' })),
      phase: 'forward'
    },
    error: 'The old home could not be retired; retire it by hand.',
    checklist: [
      { id: 'retire_source', text: 'Retire the old home by hand.', required: false, done: false }
    ]
  }

  beforeEach(() => window.localStorage.clear())

  it('keeps the result on screen when the move ends while the panel is open', async () => {
    openMove({ status: 'interrupted', step: 'retire_source' })
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/moves/77/resume') {
        openMove(ended)
        return { data: { data: { resumed: true } } }
      }
      if (url === '/hub/moves/77/checklist') return { data: { data: [] } }
      throw new Error(url)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    expect(await screen.findByText('Moved')).toBeInTheDocument()
    expect(
      screen.getByText('The old home could not be retired; retire it by hand.')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Retire the old home by hand/ }))
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/moves/77/checklist', {
        item: 'retire_source',
        done: true
      })
    )
  })

  it('after a reload shows the newest move until it is dismissed', async () => {
    openMove(ended)
    const first = renderPanel()
    expect(await screen.findByText('Moved')).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: /Retire the old home by hand/ })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(await screen.findByRole('combobox', { name: 'Move to' })).toBeInTheDocument()
    first.unmount()
    // Dismissed stays dismissed in this browser.
    renderPanel()
    expect(await screen.findByRole('combobox', { name: 'Move to' })).toBeInTheDocument()
  })
})
