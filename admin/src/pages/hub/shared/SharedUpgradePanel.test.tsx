import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedDeployment } from './shared-api'
import type { SharedDeploy, SharedUpgradePlan } from './shared-upgrade-api'

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body: unknown) => h.post(url, body),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

// cmdk scrolls the active option into view; jsdom has no scrollIntoView or ResizeObserver.
Element.prototype.scrollIntoView ??= vi.fn()
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const { rollbackVersions, SharedUpgradePanel } = await import('./SharedUpgradePanel')

const SHARED: SharedDeployment = {
  id: 4,
  key: 'shared-one',
  name: 'Shared one',
  mode: 'docker',
  driver_id: 3,
  stack: 'shared-one',
  version_pin: '0.3.210',
  extensions: [],
  extension_pins: {},
  host_pattern: '*.apps.example.com',
  link_url: 'https://shared-one.example.com',
  pool_budget: 60,
  status: 'active',
  settings: {},
  token: '••••••',
  last_seen_at: null,
  created_at: null,
  updated_at: null
}

const plan = (over: Partial<SharedUpgradePlan> = {}): SharedUpgradePlan => ({
  shared_id: 4,
  kind: 'upgrade',
  version: '0.4.0',
  from_version: '0.3.210',
  apps: [
    { env_id: 7, tenant_id: 'acme-e7', app: 'acme', env: 'prod', blockers: [] },
    { env_id: 8, tenant_id: 'acme-e8', app: 'acme', env: 'dev', blockers: [] }
  ],
  blockers: [],
  warnings: [],
  plan_hash: 'h1',
  ...over
})

let history: SharedDeploy[] = []
let planned: SharedUpgradePlan = plan()

beforeEach(() => {
  history = []
  planned = plan()
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/shared/4/upgrade/versions')
      return { data: { data: { versions: ['0.4.0', '0.3.210'] } } }
    if (url === '/hub/shared/4/deploys') return { data: { data: history } }
    if (url.startsWith('/hub/shared-deploys/'))
      return { data: { data: history.find((d) => url.endsWith(`/${d.id}`)) } }
    throw Object.assign(new Error('nope'), { response: { status: 404, data: {} } })
  })
  h.post.mockImplementation(async (url: string) => {
    if (url === '/hub/shared/4/upgrade/plan') return { data: { data: planned } }
    throw new Error(`unexpected ${url}`)
  })
})

afterEach(() => {
  h.get.mockReset()
  h.post.mockReset()
})

const wrap = (shared: SharedDeployment = SHARED) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SharedUpgradePanel shared={shared} />
    </QueryClientProvider>
  )

const start = () => screen.getByRole('button', { name: 'Start upgrade' })
const confirmBox = () => screen.getByLabelText(/to (up|down)grade$/)

/** The page text a person reads: the collapsed "Details for support" left out. */
function shownText(): string {
  const copy = document.body.cloneNode(true) as HTMLElement
  for (const d of copy.querySelectorAll('[data-error-details]')) d.remove()
  return copy.textContent ?? ''
}

describe('SharedUpgradePanel', () => {
  it('start stays off until the typed key matches the deployment key', async () => {
    wrap()
    expect(await screen.findByText('acme-e7')).toBeInTheDocument()
    expect(start()).toBeDisabled()
    fireEvent.change(confirmBox(), { target: { value: 'shared-on' } })
    expect(start()).toBeDisabled()
    fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
    expect(start()).toBeEnabled()
  })

  it('an open blocker keeps start off even with the key typed', async () => {
    planned = plan({ blockers: [{ code: 'AGENT_UNREACHABLE', text: 'The agent did not answer.' }] })
    wrap()
    expect(await screen.findByText('The Hub agent did not answer')).toBeInTheDocument()
    fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
    expect(start()).toBeDisabled()
  })

  it("repeated blocker codes each show with the planner's own sentence (two BUSY rows)", async () => {
    planned = plan({
      blockers: [
        { code: 'BUSY', text: 'The shared deployment is held by a move.' },
        { code: 'BUSY', text: 'acme/prod: a promotion holds this environment.' },
        { code: 'EXTENSION_UNPINNED', text: 'efp-ops has no image pin.' }
      ]
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    wrap()
    const list = await screen.findByRole('list', { name: 'What holds it back' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(
      within(rows[0]).getByText('The shared deployment is held by a move.')
    ).toBeInTheDocument()
    expect(
      within(rows[1]).getByText('acme/prod: a promotion holds this environment.')
    ).toBeInTheDocument()
    expect(within(rows[2]).getByText(/repo@sha256/)).toBeInTheDocument()
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false)
    errors.mockRestore()
  })

  it('an override checkbox appears only for overridable app blockers (ORDER, PREFLIGHT_FAILING)', async () => {
    planned = plan({
      overridable: ['ORDER', 'PREFLIGHT_FAILING'],
      apps: [
        { env_id: 7, tenant_id: 'acme-e7', app: 'acme', env: 'prod', blockers: ['ORDER'] },
        {
          env_id: 8,
          tenant_id: 'acme-e8',
          app: 'acme',
          env: 'dev',
          blockers: ['PREFLIGHT_FAILING'],
          notes: ['Preflight check mail fails on acme/dev.']
        },
        { env_id: 9, tenant_id: 'beta-e9', app: 'beta', env: 'prod', blockers: ['NOT_READY'] }
      ]
    })
    wrap()
    const table = await screen.findByRole('table', { name: 'Apps this upgrade touches' })
    const checks = within(table).getAllByRole('checkbox')
    expect(checks).toHaveLength(2)
    const orderRow = within(table).getByText('acme-e7').closest('tr') as HTMLElement
    expect(within(orderRow).getByRole('checkbox')).toBeInTheDocument()
    const preflightRow = within(table).getByText('acme-e8').closest('tr') as HTMLElement
    expect(within(preflightRow).getByRole('checkbox')).toBeInTheDocument()
    expect(
      within(preflightRow).getByText('Preflight check mail fails on acme/dev.')
    ).toBeInTheDocument()
    const otherRow = within(table).getByText('beta-e9').closest('tr') as HTMLElement
    expect(within(otherRow).queryByRole('checkbox')).toBeNull()
  })

  it('overriding the only ORDER blocker lets it start and sends the override', async () => {
    planned = plan({
      apps: [{ env_id: 7, tenant_id: 'acme-e7', app: 'acme', env: 'prod', blockers: ['ORDER'] }]
    })
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/shared/4/upgrade/plan') return { data: { data: planned } }
      if (url === '/hub/shared/4/upgrade') return { data: { data: { shared_deploy_id: 31 } } }
      throw new Error(url)
    })
    wrap()
    const box = await screen.findByRole('checkbox')
    fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
    expect(start()).toBeDisabled()
    fireEvent.click(box)
    expect(start()).toBeEnabled()
    fireEvent.click(start())
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/shared/4/upgrade', {
        kind: 'upgrade',
        version: '0.4.0',
        plan_hash: 'h1',
        confirm: 'shared-one',
        overrides: ['ORDER:7']
      })
    )
  })

  it('a 409 PLAN_CHANGED shows the new plan and asks for the key again', async () => {
    const newer = plan({
      plan_hash: 'h2',
      apps: [
        ...plan().apps,
        { env_id: 12, tenant_id: 'gamma-e12', app: 'gamma', env: 'prod', blockers: [] }
      ]
    })
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/shared/4/upgrade/plan') return { data: { data: planned } }
      if (url === '/hub/shared/4/upgrade')
        throw {
          isAxiosError: true,
          message: 'Request failed with status code 409',
          response: {
            status: 409,
            data: { statusCode: 409, code: 'PLAN_CHANGED', message: 'changed', plan: newer }
          }
        }
      throw new Error(url)
    })
    wrap()
    await screen.findByText('acme-e7')
    expect(screen.queryByText('gamma-e12')).toBeNull()
    fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
    fireEvent.click(start())
    expect(await screen.findByText('gamma-e12')).toBeInTheDocument()
    expect(screen.getByText(/The plan changed/)).toBeInTheDocument()
    expect((confirmBox() as HTMLInputElement).value).toBe('')
    expect(start()).toBeDisabled()
  })

  it('a 409 BLOCKED shows the plan it carries, its blockers in plain words, and the refusal', async () => {
    const now = plan({
      plan_hash: 'h3',
      blockers: [{ code: 'HUB_URL_UNUSABLE', text: 'HUB_URL is not https.' }]
    })
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/shared/4/upgrade/plan') return { data: { data: planned } }
      throw {
        isAxiosError: true,
        message: 'Request failed with status code 409',
        response: {
          status: 409,
          data: { statusCode: 409, code: 'BLOCKED', message: 'blocked', plan: now }
        }
      }
    })
    wrap()
    await screen.findByText('acme-e7')
    fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
    fireEvent.click(start())
    expect(
      await screen.findByText("The Hub's own address is not one the deployment could start with")
    ).toBeInTheDocument()
    expect(screen.getByText('Something now holds the upgrade back')).toBeInTheDocument()
    expect((confirmBox() as HTMLInputElement).value).toBe('')
    expect(start()).toBeDisabled()
    expect(shownText()).not.toMatch(/409|status code/)
  })

  it('another refusal shows in plain words without a status code', async () => {
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/shared/4/upgrade/plan') return { data: { data: planned } }
      throw {
        isAxiosError: true,
        message: 'Request failed with status code 409',
        response: {
          status: 409,
          data: { statusCode: 409, code: 'SHARED_BUSY', message: 'Busy.' }
        }
      }
    })
    wrap()
    await screen.findByText('acme-e7')
    fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
    fireEvent.click(start())
    expect(
      await screen.findByText('Something else is running on this deployment')
    ).toBeInTheDocument()
    expect(shownText()).not.toMatch(/409|status code/)
  })

  it('a running upgrade shows its steps live, with Cancel behind an inline confirm', async () => {
    history = [
      {
        id: 31,
        shared_deployment_id: 4,
        kind: 'upgrade',
        version: '0.4.0',
        from_version: '0.3.210',
        status: 'running',
        step: 'wait_version',
        error: null,
        job_run_id: 1,
        started_by: null,
        started_at: new Date().toISOString(),
        finished_at: null
      }
    ]
    h.post.mockResolvedValue({ data: {} })
    wrap()
    const steps = await screen.findByRole(
      'list',
      { name: 'Upgrade steps' },
      // Two reads in a row (history, then the run): slow on a loaded machine. The form never
      // shows before the history answers, so no plan is asked for (see the test below).
      { timeout: 5000 }
    )
    const items = within(steps).getAllByRole('listitem')
    expect(items[0]).toHaveAttribute('data-state', 'done')
    expect(items[2]).toHaveAttribute('data-state', 'running')
    expect(items[4]).toHaveAttribute('data-state', 'pending')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upgrade' }))
    expect(h.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel now?' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/shared-deploys/31/cancel', {}), {
      timeout: 5000
    })
  })

  it('nothing is planned while the history is still being read (a running run may be there)', async () => {
    // The race behind the flaky test above: the versions answer came before the history one, so
    // the form showed for a moment and asked for a plan of a deployment that was mid-upgrade.
    let answerHistory: (v: unknown) => void = () => {}
    const historyRead = new Promise((resolve) => {
      answerHistory = resolve
    })
    const run: SharedDeploy = {
      id: 31,
      shared_deployment_id: 4,
      kind: 'upgrade',
      version: '0.4.0',
      from_version: '0.3.210',
      status: 'running',
      step: 'wait_version',
      error: null,
      job_run_id: 1,
      started_by: null,
      started_at: new Date().toISOString(),
      finished_at: null
    }
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/shared/4/upgrade/versions')
        return { data: { data: { versions: ['0.4.0', '0.3.210'] } } }
      if (url === '/hub/shared/4/deploys') return historyRead
      if (url === '/hub/shared-deploys/31') return { data: { data: run } }
      throw Object.assign(new Error('nope'), { response: { status: 404, data: {} } })
    })
    wrap()
    // Give the versions read every chance to answer and a plan to be asked for.
    await new Promise((r) => setTimeout(r, 50))
    expect(h.post).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Start upgrade' })).toBeNull()
    answerHistory({ data: { data: [run] } })
    expect(
      await screen.findByRole('list', { name: 'Upgrade steps' }, { timeout: 5000 })
    ).toBeInTheDocument()
    expect(h.post).not.toHaveBeenCalled()
  })

  it('roll back offers only versions a finished Hub run deployed here, not the registry', async () => {
    history = [
      {
        id: 30,
        shared_deployment_id: 4,
        kind: 'upgrade',
        version: '0.3.210',
        from_version: '0.3.200',
        status: 'success',
        step: 'verify',
        error: null,
        job_run_id: 1,
        started_by: null,
        started_at: '2026-11-20T10:00:00.000Z',
        finished_at: '2026-11-20T10:10:00.000Z'
      },
      {
        id: 29,
        shared_deployment_id: 4,
        kind: 'upgrade',
        version: '0.3.200',
        from_version: null,
        status: 'success',
        step: 'verify',
        error: null,
        job_run_id: 1,
        started_by: null,
        started_at: '2026-11-19T10:00:00.000Z',
        finished_at: '2026-11-19T10:10:00.000Z'
      },
      {
        id: 28,
        shared_deployment_id: 4,
        kind: 'upgrade',
        version: '0.3.150',
        from_version: null,
        status: 'failed',
        step: 'apply',
        error: null,
        job_run_id: 1,
        started_by: null,
        started_at: '2026-11-18T10:00:00.000Z',
        finished_at: '2026-11-18T10:10:00.000Z'
      }
    ]
    wrap()
    await screen.findByRole('list', { name: 'Upgrade history' })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }))
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/shared/4/upgrade/plan', {
        version: '0.3.200',
        kind: 'rollback'
      })
    )
    expect(rollbackVersions(history, '0.3.210')).toEqual(['0.3.200'])
  })

  it('roll back picked before the versions answer still picks a version it ran before', async () => {
    history = [
      {
        id: 30,
        shared_deployment_id: 4,
        kind: 'upgrade',
        version: '0.3.200',
        from_version: null,
        status: 'success',
        step: 'verify',
        error: null,
        job_run_id: 1,
        started_by: null,
        started_at: '2026-11-19T10:00:00.000Z',
        finished_at: '2026-11-19T10:10:00.000Z'
      }
    ]
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/shared/4/upgrade/versions') return new Promise(() => {})
      if (url === '/hub/shared/4/deploys') return { data: { data: history } }
      throw Object.assign(new Error('nope'), { response: { status: 404, data: {} } })
    })
    wrap()
    await screen.findByRole('list', { name: 'Upgrade history' })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }))
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/shared/4/upgrade/plan', {
        version: '0.3.200',
        kind: 'rollback'
      })
    )
  })

  it('history lists earlier runs', async () => {
    history = [
      {
        id: 30,
        shared_deployment_id: 4,
        kind: 'upgrade',
        version: '0.3.210',
        from_version: '0.3.200',
        status: 'success',
        step: 'verify',
        error: null,
        job_run_id: 1,
        started_by: null,
        started_at: '2026-11-20T10:00:00.000Z',
        finished_at: '2026-11-20T10:10:00.000Z'
      }
    ]
    wrap()
    const list = await screen.findByRole('list', { name: 'Upgrade history' })
    expect(within(list).getByText('Succeeded')).toBeInTheDocument()
    expect(within(list).getByText(/0\.3\.200 → 0\.3\.210/)).toBeInTheDocument()
  })

  it('parked C5: on a phone the version pair takes its own line, never cut ("0.…")', async () => {
    history = [
      {
        id: 30,
        shared_deployment_id: 4,
        kind: 'upgrade',
        version: '0.3.210',
        from_version: '0.3.200',
        status: 'success',
        step: 'verify',
        error: null,
        job_run_id: 1,
        started_by: null,
        started_at: '2026-11-20T10:00:00.000Z',
        finished_at: '2026-11-20T10:10:00.000Z'
      }
    ]
    wrap()
    const list = await screen.findByRole('list', { name: 'Upgrade history' })
    const pair = within(list).getByText(/0\.3\.200 → 0\.3\.210/)
    const cls = pair.className.split(/\s+/)
    // Below sm: a full-width line of its own, wrapping; truncation only from sm up.
    expect(cls).toContain('basis-full')
    expect(cls).toContain('break-words')
    expect(cls).not.toContain('truncate')
    expect(cls).toContain('sm:truncate')
  })

  describe('B2: never a downgrade by default; an older pick is named and confirmed', () => {
    const versionsAre = (list: string[]) => {
      const base = h.get.getMockImplementation() as (url: string) => Promise<unknown>
      h.get.mockImplementation(async (url: string) =>
        url === '/hub/shared/4/upgrade/versions'
          ? { data: { data: { versions: list } } }
          : base(url)
      )
    }
    const pickVersion = async (v: string) => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Version' }))
      fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${v}`) }))
    }

    it('defaults to the newest published version, whatever order the registry lists', async () => {
      versionsAre(['0.3.209', '0.3.211', '0.3.210'])
      wrap()
      await waitFor(() =>
        expect(h.post).toHaveBeenCalledWith('/hub/shared/4/upgrade/plan', {
          version: '0.3.211',
          kind: 'upgrade'
        })
      )
    })

    it('runs the newest already: says so and plans nothing', async () => {
      versionsAre(['0.3.207', '0.3.210'])
      wrap()
      expect(await screen.findByText(/Runs the newest published version/)).toBeInTheDocument()
      expect(h.post).not.toHaveBeenCalled()
      expect(start()).toBeDisabled()
    })

    it('an older pick is a downgrade: warned, confirmed, then sent with downgrade: true', async () => {
      versionsAre(['0.3.207', '0.3.210'])
      planned = plan({ version: '0.3.207', downgrade: true })
      wrap()
      await screen.findByText(/Runs the newest published version/)
      await pickVersion('0.3.207')
      const box = await screen.findByRole('status', { name: 'This is a downgrade' })
      expect(within(box).getByText(/older than the version it runs/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Start downgrade' })).toBeDisabled()
      fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
      await screen.findByText('acme-e7')
      expect(screen.getByRole('button', { name: 'Start downgrade' })).toBeDisabled()
      fireEvent.click(within(box).getByRole('checkbox', { name: /downgrade to 0\.3\.207/ }))
      h.post.mockImplementation(async (url: string) =>
        url === '/hub/shared/4/upgrade/plan'
          ? { data: { data: planned } }
          : { data: { data: { shared_deploy_id: 40 } } }
      )
      const go = screen.getByRole('button', { name: 'Start downgrade' })
      expect(go).toBeEnabled()
      fireEvent.click(go)
      await waitFor(() =>
        expect(h.post).toHaveBeenCalledWith(
          '/hub/shared/4/upgrade',
          expect.objectContaining({ kind: 'upgrade', version: '0.3.207', downgrade: true })
        )
      )
    })

    it("the server's plan decides: plan.downgrade shows the box with the planner's sentence", async () => {
      // A version the client cannot order (not x.y.z): only the server's plan says downgrade.
      versionsAre(['0.3.210'])
      planned = plan({
        version: 'nightly-1',
        downgrade: true,
        warnings: [
          {
            code: 'DOWNGRADE',
            text: 'nightly-1 is not newer than the 0.3.210 this deployment runs.'
          }
        ]
      })
      wrap()
      await screen.findByText(/Runs the newest published version/)
      fireEvent.click(screen.getByRole('combobox', { name: 'Version' }))
      fireEvent.change(screen.getByPlaceholderText('Search or type a version…'), {
        target: { value: 'nightly-1' }
      })
      fireEvent.click(await screen.findByRole('option', { name: /Use nightly-1/ }))
      const box = await screen.findByRole('status', { name: 'This is a downgrade' })
      expect(
        within(box).getByText('nightly-1 is not newer than the 0.3.210 this deployment runs.')
      ).toBeInTheDocument()
      // Said once, in the box: not again as a plain warning row, and never as a code.
      expect(screen.getAllByText(/is not newer than the 0\.3\.210/)).toHaveLength(1)
      expect(shownText()).not.toContain('DOWNGRADE')
    })

    it('a start refused DOWNGRADE_NEEDS_CONFIRM says so in plain words', async () => {
      h.post.mockImplementation(async (url: string) => {
        if (url === '/hub/shared/4/upgrade/plan') return { data: { data: planned } }
        throw Object.assign(new Error('409'), {
          response: {
            status: 409,
            data: {
              code: 'DOWNGRADE_NEEDS_CONFIRM',
              error: '0.4.0 is not newer — confirm the downgrade to start.',
              plan: { ...planned, downgrade: true }
            }
          }
        })
      })
      wrap()
      await screen.findByText('acme-e7')
      fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
      fireEvent.click(start())
      expect(
        await screen.findByText('This version is older than the one the deployment runs')
      ).toBeInTheDocument()
      // The plan it carried is on screen now: the downgrade box asks for the confirmation.
      expect(screen.getByRole('status', { name: 'This is a downgrade' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Start downgrade' })).toBeDisabled()
    })

    it('a normal upgrade start never sends downgrade', async () => {
      h.post.mockImplementation(async (url: string) =>
        url === '/hub/shared/4/upgrade/plan'
          ? { data: { data: planned } }
          : { data: { data: { shared_deploy_id: 41 } } }
      )
      wrap()
      await screen.findByText('acme-e7')
      fireEvent.change(confirmBox(), { target: { value: 'shared-one' } })
      fireEvent.click(start())
      await waitFor(() =>
        expect(h.post).toHaveBeenCalledWith('/hub/shared/4/upgrade', expect.anything())
      )
      const body = h.post.mock.calls.find((c) => c[0] === '/hub/shared/4/upgrade')?.[1]
      expect(body).not.toHaveProperty('downgrade')
    })
  })

  describe('design review S5 + S8 on screen', () => {
    const failedRun = (error: string): SharedDeploy => ({
      id: 33,
      shared_deployment_id: 4,
      kind: 'upgrade',
      version: '0.4.0',
      from_version: '0.3.210',
      status: 'failed',
      step: 'wait_version',
      error,
      job_run_id: 1,
      started_by: null,
      started_at: '2026-11-20T10:00:00.000Z',
      finished_at: '2026-11-20T10:10:00.000Z'
    })
    const openRun = async () => {
      const list = await screen.findByRole('list', { name: 'Upgrade history' })
      fireEvent.click(within(list).getByRole('button', { name: 'Details' }))
      return screen.findByRole('list', { name: 'Upgrade steps' })
    }

    it('S5: a swarm rollback says the earlier version runs again, never "Nothing was reverted"', async () => {
      history = [
        failedRun(
          'SWARM_ROLLED_BACK: Swarm rolled shared-one back to its previous spec — the new tasks did not become healthy.'
        )
      ]
      wrap()
      await openRun()
      expect(screen.getByText('Swarm put the previous version back')).toBeInTheDocument()
      expect(screen.getByText(/the apps still run/)).toHaveTextContent(
        'Swarm put the previous version back: the apps still run 0.3.210. Fix what failed and upgrade again.'
      )
      expect(screen.queryByText(/Nothing was reverted/)).toBeNull()
      expect(shownText()).not.toContain('SWARM_ROLLED_BACK')
    })

    it('S5: another failure keeps "Nothing was reverted" under plain words', async () => {
      history = [failedRun('VERSION_TIMEOUT: 1 of 2 replicas still run 0.3.210.')]
      wrap()
      await openRun()
      expect(screen.getByText('The replicas did not reach the version in time')).toBeInTheDocument()
      expect(screen.getByText('1 of 2 replicas still run 0.3.210.')).toBeInTheDocument()
      expect(screen.getByText(/Nothing was reverted/)).toBeInTheDocument()
    })

    it('S8: an app a plan-wide BUSY holds shows Busy, not Ready', async () => {
      planned = plan({
        blockers: [{ code: 'BUSY', text: 'acme/prod: a promotion holds this environment.' }]
      })
      wrap()
      const table = await screen.findByRole('table', { name: 'Apps this upgrade touches' })
      const rows = within(table).getAllByRole('row')
      expect(within(rows[1]).getByText('Busy')).toBeInTheDocument()
      expect(within(rows[1]).queryByText('Ready')).toBeNull()
      expect(within(rows[2]).getByText('Ready')).toBeInTheDocument()
    })

    it('S7: an agent row says it once', async () => {
      planned = plan({
        blockers: [{ code: 'AGENT_UNREACHABLE', text: 'The Hub agent does not answer.' }]
      })
      wrap()
      const list = await screen.findByRole('list', { name: 'What holds it back' })
      expect(within(list).getByText('The Hub agent did not answer')).toBeInTheDocument()
      expect(within(list).queryByText('The Hub agent does not answer.')).toBeNull()
    })
  })
})
