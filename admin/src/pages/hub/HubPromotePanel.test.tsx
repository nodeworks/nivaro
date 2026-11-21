import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 2): promote and roll back from the Apps hub — the plan in plain words, a
// typed confirmation, live progress with Cancel, and each environment's Hub deploy history.

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

const { HubPromotePanel, PromotionHistory } = await import('./HubPromotePanel')
const { BLOCKER_COPY, hubError } = await import('./hub-api')

const env = {
  id: 10,
  app_id: 1,
  key: 'production',
  position: 2,
  status: 'active',
  base_url: 'https://efp.example.com',
  hostnames: [],
  placement_id: 5,
  version_pin: null,
  hub_token: null,
  hub_managed: true
}

const okPlan = {
  ok: true,
  blockers: [],
  lines: ['production is currently Running', 'api: merge main into production, then deploy'],
  steps: [
    {
      position: 1,
      component: 'api',
      kind: 'api',
      sourceSha: 'abc1234',
      targetBranch: 'production',
      pinText: 'version=0.3.210',
      beforeJob: 'build_extension',
      deployJob: 'deploy_production',
      verifyUrl: 'https://efp.example.com/api/version',
      want: '0.3.210'
    },
    {
      position: 2,
      component: 'frontend',
      kind: 'frontend',
      sourceSha: 'def5678',
      targetBranch: 'production',
      pinText: null,
      beforeJob: null,
      deployJob: 'deploy_production',
      verifyUrl: 'https://efp.example.com/version.json',
      want: 'def5678'
    }
  ]
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function routes(opts: { plan?: unknown; promotion?: unknown; history?: unknown[] } = {}) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/environments/10/promotable')
      return { data: { data: { promote: ['0.3.210', '0.3.209'], rollback: ['0.3.205'] } } }
    if (url === '/hub/promotions/55') return { data: { data: opts.promotion } }
    if (url === '/hub/environments/10/deploys/hub') return { data: { data: opts.history ?? [] } }
    throw new Error(`unexpected GET ${url}`)
  })
  h.post.mockImplementation(async (url: string) => {
    if (url === '/hub/environments/10/promote/plan') return { data: { data: opts.plan ?? okPlan } }
    if (url === '/hub/environments/10/promote')
      return { data: { data: { deploy_id: 55, job_run_id: 9 } } }
    if (url === '/hub/promotions/55/cancel') return { data: {} }
    throw new Error(`unexpected POST ${url}`)
  })
}

const startButton = () => screen.getByRole('button', { name: /^Start/ })

describe('HubPromotePanel', () => {
  afterEach(() => {
    h.get.mockReset()
    h.post.mockReset()
  })

  it('shows blockers in plain words and keeps Start off', async () => {
    routes({
      plan: {
        ok: false,
        blockers: [
          { code: 'PREVIOUS_NEVER_RAN', text: 'staging never ran 0.3.210' },
          { code: 'SOMETHING_NEW', text: 'A reason the UI has no copy for' }
        ],
        lines: ['production is currently Running with warnings'],
        steps: []
      }
    })
    wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    expect(
      await screen.findByText('The environment before this one has not run this version')
    ).toBeInTheDocument()
    expect(screen.getByText('Promote it there first.')).toBeInTheDocument()
    // An unknown code keeps the planner's own words.
    expect(screen.getByText('A reason the UI has no copy for')).toBeInTheDocument()
    expect(screen.getByText('production is currently Running with warnings')).toBeInTheDocument()
    expect(h.post).toHaveBeenCalledWith('/hub/environments/10/promote/plan', {
      version: '0.3.210',
      kind: 'promote'
    })
    fireEvent.change(screen.getByLabelText(/Type production to promote/), {
      target: { value: 'production' }
    })
    expect(startButton()).toBeDisabled()
  })

  it('needs the environment name typed before Start', async () => {
    routes()
    wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    expect(
      await screen.findByText('api: merge main into production, then deploy')
    ).toBeInTheDocument()
    expect(startButton()).toBeDisabled()
    const confirm = screen.getByLabelText(/Type production to promote/)
    fireEvent.change(confirm, { target: { value: 'staging' } })
    expect(startButton()).toBeDisabled()
    fireEvent.change(confirm, { target: { value: 'production' } })
    expect(startButton()).toBeEnabled()
    routes({
      plan: okPlan,
      promotion: {
        id: 55,
        app_id: 1,
        environment_id: 10,
        kind: 'promote',
        version: '0.3.210',
        from_version: '0.3.207',
        status: 'running',
        step: 'push api',
        error: null,
        job_run_id: 9,
        started_by: 'u1',
        started_at: new Date().toISOString(),
        finished_at: null,
        plan: JSON.stringify(okPlan),
        log: []
      }
    })
    fireEvent.click(startButton())
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/promote', {
        version: '0.3.210',
        kind: 'promote',
        confirm: 'production'
      })
    )
    expect(await screen.findByRole('list', { name: 'Promotion steps' })).toBeInTheDocument()
  })

  it('rolls back to the version picked on a history row', async () => {
    routes()
    wrap(
      <HubPromotePanel
        env={env}
        kind='rollback'
        initialVersion='0.3.205'
        idPrefix='t'
        onClose={() => {}}
      />
    )
    expect(await screen.findByLabelText(/Type production to roll back/)).toBeInTheDocument()
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/promote/plan', {
        version: '0.3.205',
        kind: 'rollback'
      })
    )
  })

  it('shows the blockers a refused start sent back', async () => {
    routes()
    wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    await screen.findByText('api: merge main into production, then deploy')
    h.post.mockImplementation(async () => {
      throw {
        response: {
          status: 409,
          data: {
            code: 'PROMOTION_RUNNING',
            blockers: [{ code: 'PROMOTION_RUNNING', text: 'running' }]
          }
        }
      }
    })
    fireEvent.change(screen.getByLabelText(/Type production to promote/), {
      target: { value: 'production' }
    })
    fireEvent.click(startButton())
    expect(
      await screen.findByText('Wait for it to finish, or cancel it, then try again.')
    ).toBeInTheDocument()
  })

  it('a running promotion shows its steps, the log under Details, and Cancel', async () => {
    routes({
      promotion: {
        id: 55,
        app_id: 1,
        environment_id: 10,
        kind: 'promote',
        version: '0.3.210',
        from_version: '0.3.207',
        status: 'running',
        step: 'deploy frontend',
        error: null,
        job_run_id: 9,
        started_by: 'u1',
        started_at: new Date().toISOString(),
        finished_at: null,
        plan: okPlan,
        log: [
          { seq: 1, at: new Date().toISOString(), level: 'info', line: 'push api: merged !12' },
          { seq: 2, at: new Date().toISOString(), level: 'info', line: 'deploy api: job passed' }
        ]
      }
    })
    wrap(<HubPromotePanel env={env} kind='promote' deployId={55} idPrefix='t' onClose={() => {}} />)
    const steps = await screen.findByRole('list', { name: 'Promotion steps' })
    const items = within(steps).getAllByRole('listitem')
    // api: merge, deploy · frontend: merge, deploy · check
    expect(items).toHaveLength(5)
    expect(items[0]).toHaveAttribute('data-state', 'done')
    expect(items[1]).toHaveAttribute('data-state', 'done')
    expect(items[2]).toHaveAttribute('data-state', 'done')
    expect(items[3]).toHaveAttribute('data-state', 'running')
    expect(items[4]).toHaveAttribute('data-state', 'pending')
    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getByText('push api: merged !12')).toBeInTheDocument()
    const cancel = screen.getByRole('button', { name: 'Cancel promotion' })
    fireEvent.click(cancel)
    fireEvent.click(screen.getByRole('button', { name: /Stop after this step/ }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/promotions/55/cancel', {}))
  })

  it('a failed promotion marks the step that failed and says why', async () => {
    routes({
      promotion: {
        id: 55,
        app_id: 1,
        environment_id: 10,
        kind: 'promote',
        version: '0.3.210',
        from_version: '0.3.207',
        status: 'failed',
        step: 'deploy api',
        error: 'The deploy job failed',
        job_run_id: 9,
        started_by: 'u1',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        plan: okPlan,
        log: []
      }
    })
    wrap(<HubPromotePanel env={env} kind='promote' deployId={55} idPrefix='t' onClose={() => {}} />)
    const steps = await screen.findByRole('list', { name: 'Promotion steps' })
    const items = within(steps).getAllByRole('listitem')
    expect(items[1]).toHaveAttribute('data-state', 'failed')
    expect(items[2]).toHaveAttribute('data-state', 'pending')
    expect(screen.getByText('The deploy job failed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel promotion' })).toBeNull()
  })
})

describe('PromotionHistory', () => {
  afterEach(() => h.get.mockReset())

  const at = new Date().toISOString()
  const row = (over: Record<string, unknown>) => ({
    app_id: 1,
    environment_id: 10,
    from_version: null,
    error: null,
    job_run_id: 1,
    started_by: 'u1',
    started_by_name: 'Pat Owner',
    started_at: at,
    finished_at: at,
    ...over
  })
  const rows = [
    row({ id: 3, kind: 'promote', version: '0.3.207', status: 'success', step: 'verify' }),
    row({
      id: 2,
      kind: 'rollback',
      version: '0.3.206',
      status: 'failed',
      step: 'deploy api',
      error: 'The deploy job failed',
      started_by: 'u2',
      started_by_name: 'Sam Admin'
    }),
    row({ id: 1, kind: 'promote', version: '0.3.205', status: 'success', step: 'verify' })
  ]

  it('lists version, kind, status, who, step and error per deploy', async () => {
    routes({ history: rows })
    const onRollback = vi.fn()
    wrap(<PromotionHistory env={env} canPromote onRollback={onRollback} onWatch={() => {}} />)
    const table = await screen.findByRole('table', { name: 'production Hub deploys' })
    expect(within(table).getByText('0.3.207')).toBeInTheDocument()
    expect(within(table).getAllByText('Promote')).toHaveLength(2)
    expect(within(table).getByText('Rollback')).toBeInTheDocument()
    expect(within(table).getAllByText('Succeeded')).toHaveLength(2)
    expect(within(table).getByText('Failed')).toBeInTheDocument()
    expect(within(table).getByText('Sam Admin')).toBeInTheDocument()
    expect(within(table).getByText('deploy api')).toBeInTheDocument()
    expect(within(table).getByText('The deploy job failed')).toBeInTheDocument()
    // Roll back is offered only on a version this environment deployed successfully and the
    // API lists as a rollback target.
    expect(within(table).queryByRole('button', { name: 'Roll back to 0.3.207' })).toBeNull()
    expect(within(table).queryByRole('button', { name: 'Roll back to 0.3.206' })).toBeNull()
    fireEvent.click(await within(table).findByRole('button', { name: 'Roll back to 0.3.205' }))
    expect(onRollback).toHaveBeenCalledWith('0.3.205')
    // Phone: the same deploys as stacked entries.
    const list = screen.getByRole('list', { name: 'production Hub deploys' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
  })

  it('offers no Roll back to readers who may not promote', async () => {
    routes({ history: rows })
    wrap(<PromotionHistory env={env} canPromote={false} onRollback={() => {}} onWatch={() => {}} />)
    await screen.findByRole('table', { name: 'production Hub deploys' })
    expect(screen.queryByRole('button', { name: /Roll back to/ })).toBeNull()
  })
})

describe('promotion copy', () => {
  it('has plain words for every planner blocker code', () => {
    for (const code of [
      'NOT_HUB_MANAGED',
      'PROMOTION_RUNNING',
      'NO_PREVIOUS_ENVIRONMENT',
      'PREVIOUS_NEVER_RAN',
      'ALREADY_RUNS',
      'OLDER_THAN_CURRENT',
      'NOT_DEPLOYED_BEFORE',
      'NO_SOURCE_COMMIT',
      'FRONTEND_UNKNOWN',
      'IMAGE_MISSING',
      'IMAGE_NO_DIGEST',
      'NO_COMPONENTS',
      'BAD_VERSION'
    ])
      expect(BLOCKER_COPY[code]?.title, code).toBeTruthy()
  })

  it('names the route refusals in plain words', () => {
    const refusal = (code: string) =>
      hubError({ response: { status: 400, data: { code } } }, 'fallback').title
    expect(refusal('CONFIRM_REQUIRED')).toBe("Type the environment's name to confirm")
    expect(refusal('BAD_KIND')).toBe('Pick what the component is')
    expect(refusal('BAD_DRIVER')).toBe('That driver does not exist any more')
    expect(refusal('POSITION_TAKEN')).toBe('Another component already has that place')
    expect(refusal('BAD_VERIFY_URL')).toBe('The check address is not valid')
    expect(refusal('NOT_HUB_MANAGED')).toBe('The Hub does not deploy this environment yet')
  })
})
