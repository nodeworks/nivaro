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

const { HubPromotePanel, PromotionHistory, currentStepIndex, stepRows } = await import(
  './HubPromotePanel'
)
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

const HASH = 'a'.repeat(64)
const okPlan = {
  ok: true,
  plan_hash: HASH,
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

function wrap(
  ui: ReactNode,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const out = render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
  return {
    ...out,
    qc,
    rerender: (next: ReactNode) =>
      out.rerender(<QueryClientProvider client={qc}>{next}</QueryClientProvider>)
  }
}

function routes(
  opts: {
    plan?: unknown
    promotion?: unknown
    history?: unknown[]
    promotable?: unknown
    /** Answer of POST /promote: a thrown axios-like error instead of a start. */
    startError?: unknown
  } = {}
) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/environments/10/promotable')
      return {
        data: {
          data: opts.promotable ?? { promote: ['0.3.210', '0.3.209'], rollback: ['0.3.205'] }
        }
      }
    if (url === '/hub/promotions/55') return { data: { data: opts.promotion } }
    if (url === '/hub/environments/10/deploys/hub') return { data: { data: opts.history ?? [] } }
    throw new Error(`unexpected GET ${url}`)
  })
  h.post.mockImplementation(async (url: string) => {
    if (url === '/hub/environments/10/promote/plan') return { data: { data: opts.plan ?? okPlan } }
    if (url === '/hub/environments/10/promote') {
      if (opts.startError) throw opts.startError
      return { data: { data: { deploy_id: 55, job_run_id: 9 } } }
    }
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

  it('offers the running version again when its Hub promotion stopped between components', async () => {
    routes({ promotable: { promote: ['0.3.208'], rollback: [], finish: '0.3.208' } })
    wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/promote/plan', {
        version: '0.3.208',
        kind: 'promote'
      })
    )
    expect(screen.queryByText(/Nothing to promote/)).not.toBeInTheDocument()
    expect(
      screen.getByText(/production already runs 0\.3\.208, but its Hub promotion stopped/)
    ).toBeInTheDocument()
  })

  it("shows every blocker's own reason under its plain words", async () => {
    routes({
      plan: {
        ok: false,
        plan_hash: HASH,
        blockers: [
          {
            code: 'PIN_CHANGED',
            text: 'api: the image for 0.3.208 changed since it was deployed — production pins 0.3.208 image cccccccccccc, the registry now has 0.3.208 image aaaaaaaaaaaa'
          },
          {
            code: 'FRONTEND_ROLLBACK_NO_BUILD',
            text: "frontend: 1a2b3c4d is no longer on production — that build can't be redeployed"
          }
        ],
        lines: ['production is currently Running'],
        steps: []
      }
    })
    wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    expect(
      await screen.findByText('The image for this version changed since it was deployed here')
    ).toBeInTheDocument()
    expect(screen.getByText(/production pins 0\.3\.208 image cccccccccccc/)).toBeInTheDocument()
    expect(
      screen.getByText('The frontend build for that version cannot be redeployed')
    ).toBeInTheDocument()
    expect(screen.getByText(/1a2b3c4d is no longer on production/)).toBeInTheDocument()
    expect(screen.getByText(/Its commit is no longer on the branch/)).toBeInTheDocument()
  })

  it('a start refused with PLAN_CHANGED shows the new plan and asks to check it again', async () => {
    const newPlan = {
      ...okPlan,
      plan_hash: 'b'.repeat(64),
      lines: ['production is currently Running', 'Frontend: deploy production head 9f9f9f9']
    }
    routes({
      startError: {
        response: {
          status: 409,
          data: { code: 'PLAN_CHANGED', error: 'The plan changed', plan: newPlan }
        }
      }
    })
    wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    expect(
      await screen.findByText('api: merge main into production, then deploy')
    ).toBeInTheDocument()
    const confirm = screen.getByLabelText(/Type production to promote/)
    fireEvent.change(confirm, { target: { value: 'production' } })
    fireEvent.click(startButton())
    expect(await screen.findByText(/The plan changed — check it again/)).toBeInTheDocument()
    expect(screen.getByText('Frontend: deploy production head 9f9f9f9')).toBeInTheDocument()
    // The typed confirmation is cleared: the new plan must be confirmed on its own.
    expect((confirm as HTMLInputElement).value).toBe('')
    expect(startButton()).toBeDisabled()
    // Confirming again sends the new plan's hash.
    routes()
    fireEvent.change(confirm, { target: { value: 'production' } })
    fireEvent.click(startButton())
    await waitFor(() =>
      expect(h.post).toHaveBeenLastCalledWith('/hub/environments/10/promote', {
        version: '0.3.210',
        kind: 'promote',
        confirm: 'production',
        plan_hash: 'b'.repeat(64)
      })
    )
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
        confirm: 'production',
        plan_hash: HASH
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
      'BAD_VERSION',
      'NO_DRIVER',
      'FRONTEND_NOT_ON_SOURCE',
      'FRONTEND_ROLLBACK_NO_BUILD',
      'PIN_CHANGED',
      'HEAD_UNKNOWN',
      'ROLLBACK_NO_BUILD',
      'ROLLBACK_NOT_RECORDED'
    ])
      expect(BLOCKER_COPY[code]?.title, code).toBeTruthy()
  })

  it('names the route refusals in plain words', () => {
    const refusal = (code: string) =>
      hubError({ response: { status: 400, data: { code } } }, 'fallback').title
    // Minor 5: every refusal a promotion route or run can answer has its own words.
    for (const code of [
      'LOCK_UNAVAILABLE',
      'PLAN_HASH_REQUIRED',
      'NOT_RUNNING',
      'GITLAB_UNAUTHORIZED',
      'GITLAB_FORBIDDEN',
      'GITLAB_NO_TOKEN',
      'DRIVER_MISCONFIGURED',
      'DRIVER_CHANGED',
      'ROLLBACK_NOT_RECORDED',
      'ROLLBACK_REFUSED_BY_GITLAB'
    ])
      expect(refusal(code), code).not.toBe('fallback')
    expect(refusal('ROLLBACK_REFUSED_BY_GITLAB')).toBe(
      'GitLab refused to rerun the earlier deploy job'
    )
    expect(refusal('CONFIRM_REQUIRED')).toBe("Type the environment's name to confirm")
    expect(refusal('BAD_KIND')).toBe('Pick what the component is')
    expect(refusal('BAD_DRIVER')).toBe('That driver does not exist any more')
    expect(refusal('POSITION_TAKEN')).toBe('Another component already has that place')
    expect(refusal('BAD_VERIFY_URL')).toBe('The check address is not valid')
    expect(refusal('NOT_HUB_MANAGED')).toBe('The Hub does not deploy this environment yet')
  })
})

// ─── Fix round 1 ──────────────────────────────────────────────────────────────

const running = (over: Record<string, unknown> = {}) => ({
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
  plan: okPlan,
  log: [],
  ...over
})

describe('fix round 1: progress', () => {
  afterEach(() => {
    vi.useRealTimers()
    h.get.mockReset()
    h.post.mockReset()
  })

  it('stops polling when the promotion cannot be read at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/promotions/99') throw { response: { status: 404, data: {} } }
      throw new Error(`unexpected GET ${url}`)
    })
    wrap(<HubPromotePanel env={env} kind='promote' deployId={99} idPrefix='t' onClose={() => {}} />)
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/hub/promotions/99', undefined))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(screen.queryByRole('list', { name: 'Promotion steps' })).toBeNull()
    const reads = h.get.mock.calls.filter(([u]) => u === '/hub/promotions/99')
    expect(reads).toHaveLength(1)
  })

  it('shows an unknown status in its own word and keeps the run live', async () => {
    routes({ promotion: running({ status: 'verifying_twice' }) })
    wrap(<HubPromotePanel env={env} kind='promote' deployId={55} idPrefix='t' onClose={() => {}} />)
    expect(await screen.findByText('verifying_twice')).toBeInTheDocument()
    expect(screen.queryByText('undefined')).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel promotion' })).toBeInTheDocument()
  })

  it('names a rollback when cancelling one', async () => {
    routes({ promotion: running({ kind: 'rollback', version: '0.3.205' }) })
    wrap(
      <HubPromotePanel env={env} kind='rollback' deployId={55} idPrefix='t' onClose={() => {}} />
    )
    expect(await screen.findByRole('button', { name: 'Cancel rollback' })).toBeInTheDocument()
  })

  it('puts a raw runner error into plain words with the text under Details for support', async () => {
    const raw = 'GitLab answered: Request failed with status code 502'
    routes({ promotion: running({ status: 'failed', step: 'deploy api', error: raw }) })
    wrap(<HubPromotePanel env={env} kind='promote' deployId={55} idPrefix='t' onClose={() => {}} />)
    expect(
      await screen.findByText('It stopped on an error the Hub could not put in plain words')
    ).toBeInTheDocument()
    const details = screen.getByText('Details for support').closest('details') as HTMLElement
    expect(within(details).getByText(raw)).toBeInTheDocument()
    expect(details).not.toHaveAttribute('open')
  })

  it('matches a component name as a whole token', () => {
    const plan = {
      ...okPlan,
      steps: [
        { ...okPlan.steps[0], position: 1, component: 'api' },
        { ...okPlan.steps[0], position: 2, component: 'api-v2' }
      ]
    }
    const rows = stepRows(plan as never)
    expect(rows[currentStepIndex(rows, 'deploy api-v2')].key).toBe('deploy-2')
    expect(rows[currentStepIndex(rows, 'deploy api')].key).toBe('deploy-1')
    expect(rows[currentStepIndex(rows, 'push api-v2: merged !4')].key).toBe('push-2')
  })

  it('Minor 4: a rollback says Redeploy; a no-op API step says it already runs', () => {
    const back = stepRows(okPlan as never, 'rollback').map((r) => r.label)
    expect(back).toContain("Redeploy api's earlier build")
    expect(back).toContain("Find frontend's earlier build on production")
    expect(back.join('\n')).not.toMatch(/Merge|pin the version/)
    const finish = {
      ...okPlan,
      steps: [{ ...okPlan.steps[0], noop: true }, okPlan.steps[1]]
    }
    const labels = stepRows(finish as never).map((r) => r.label)
    expect(labels).toContain('Already running 0.3.210 — api is not deployed again')
    expect(labels).not.toContain('Deploy api')
    expect(labels).toContain('Deploy frontend')
  })

  it('P22: a rollback lists the portal first, then the API', () => {
    const plan = {
      ...okPlan,
      steps: [
        { ...okPlan.steps[0], position: 1, component: 'api', kind: 'api' },
        { ...okPlan.steps[0], position: 2, component: 'portal', kind: 'frontend' }
      ]
    }
    const keys = (k: 'promote' | 'rollback') => stepRows(plan as never, k).map((r) => r.key)
    expect(keys('rollback')).toEqual(['push-2', 'deploy-2', 'push-1', 'deploy-1', 'verify'])
    expect(keys('promote')).toEqual(['push-1', 'deploy-1', 'push-2', 'deploy-2', 'verify'])
  })
})

describe('fix round 1: the confirmation names one version', () => {
  afterEach(() => {
    h.get.mockReset()
    h.post.mockReset()
  })

  it('keeps the picked version when a newer one appears, and clears the confirmation on a kind change', async () => {
    let listed = ['0.3.210']
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/environments/10/promotable')
        return { data: { data: { promote: listed, rollback: ['0.3.205'] } } }
      throw new Error(`unexpected GET ${url}`)
    })
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/environments/10/promote/plan') return { data: { data: okPlan } }
      if (url === '/hub/environments/10/promote')
        return { data: { data: { deploy_id: 55, job_run_id: 9 } } }
      throw new Error(`unexpected POST ${url}`)
    })
    const view = wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    await screen.findByText('api: merge main into production, then deploy')
    const confirm = screen.getByLabelText(/Type production to promote/)
    fireEvent.change(confirm, { target: { value: 'production' } })
    listed = ['0.3.211', '0.3.210']
    await view.qc.invalidateQueries({ queryKey: ['hub-promotable', 10] })
    await waitFor(() => expect(h.get.mock.calls.length).toBeGreaterThan(1))
    expect(screen.getByLabelText(/Type production to promote/)).toHaveValue('production')
    fireEvent.click(startButton())
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/promote', {
        version: '0.3.210',
        kind: 'promote',
        confirm: 'production',
        plan_hash: HASH
      })
    )
  })

  it('Minor 7: clears a typed confirmation when a re-read plans differently', async () => {
    let current: unknown = okPlan
    routes()
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/environments/10/promote/plan') return { data: { data: current } }
      throw new Error(`unexpected POST ${url}`)
    })
    const view = wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    await screen.findByText('api: merge main into production, then deploy')
    const confirm = screen.getByLabelText(/Type production to promote/)
    fireEvent.change(confirm, { target: { value: 'production' } })
    // The same plan read again keeps it.
    await view.qc.invalidateQueries({ queryKey: ['hub-plan'] })
    await view.qc.refetchQueries()
    expect(confirm).toHaveValue('production')
    current = { ...okPlan, plan_hash: 'b'.repeat(64), lines: ['production moved on'] }
    await view.qc.refetchQueries()
    await screen.findByText('production moved on')
    await waitFor(() => expect(confirm).toHaveValue(''))
    expect(startButton()).toBeDisabled()
  })

  it('clears a typed confirmation when the kind changes', async () => {
    routes()
    const view = wrap(<HubPromotePanel env={env} kind='promote' idPrefix='t' onClose={() => {}} />)
    await screen.findByText('api: merge main into production, then deploy')
    fireEvent.change(screen.getByLabelText(/Type production to promote/), {
      target: { value: 'production' }
    })
    view.rerender(<HubPromotePanel env={env} kind='rollback' idPrefix='t' onClose={() => {}} />)
    const confirm = await screen.findByLabelText(/Type production to roll back/)
    expect(confirm).toHaveValue('')
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/promote/plan', {
        version: '0.3.205',
        kind: 'rollback'
      })
    )
  })
})
