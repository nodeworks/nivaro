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

const { SharedUpgradePanel } = await import('./SharedUpgradePanel')

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

const wrap = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SharedUpgradePanel shared={SHARED} />
    </QueryClientProvider>
  )

const start = () => screen.getByRole('button', { name: 'Start upgrade' })
const confirmBox = () => screen.getByLabelText(/to upgrade$/)

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
      // Two reads in a row (history, then the run): slow on a loaded machine.
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
})
