import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedDeployment } from './shared-api'
import type { SharedDeploy, SharedUpgradePlan } from './shared-upgrade-api'

// Final fix wave, admin review M-3 / M-4 / M-8 and design round 2 N-r2-1 / N-r2-7.

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

Element.prototype.scrollIntoView ??= vi.fn()
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

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
  apps: [{ env_id: 7, tenant_id: 'beta-e7', app: 'beta', env: 'demo', blockers: [] }],
  blockers: [],
  warnings: [],
  plan_hash: 'h1',
  ...over
})

const run = (over: Partial<SharedDeploy> = {}): SharedDeploy => ({
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
  started_at: '2026-11-20T10:00:00.000Z',
  finished_at: null,
  ...over
})

let history: SharedDeploy[] = []
let deploy: SharedDeploy | null = null
let versions = ['0.4.0', '0.3.210']
let planned: SharedUpgradePlan = plan()

beforeEach(() => {
  history = []
  deploy = null
  versions = ['0.4.0', '0.3.210']
  planned = plan()
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/shared/4/upgrade/versions') return { data: { data: { versions } } }
    if (url === '/hub/shared/4/deploys') return { data: { data: history } }
    if (url.startsWith('/hub/shared-deploys/')) return { data: { data: deploy } }
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
  focusManager.setFocused(undefined)
})

const wrap = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SharedUpgradePanel shared={SHARED} />
    </QueryClientProvider>
  )

const planCalls = () => h.post.mock.calls.filter((c) => c[0] === '/hub/shared/4/upgrade/plan')

describe('SharedUpgradePanel final fixes', () => {
  it('M-3: Done on a finished run closes it at once, even while the history still lists it live', async () => {
    // The history read lags: it still says running while the run's own read says it finished.
    history = [run()]
    deploy = run({ status: 'success', step: 'verify', finished_at: '2026-11-20T10:10:00.000Z' })
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }, { timeout: 5000 }))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Upgrade steps' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  it('M-4: coming back to the window does not plan again', async () => {
    wrap()
    await screen.findByText('beta-e7')
    const before = planCalls().length
    expect(before).toBeGreaterThan(0)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(planCalls().length).toBe(before)
  })

  it('M-8: a step this screen does not know reads "Working…", never the raw key', async () => {
    history = [run({ step: 'drain_sockets' })]
    deploy = run({ step: 'drain_sockets' })
    wrap()
    expect(await screen.findByText('Working…', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('drain_sockets')
  })

  it("N-r2-1: a version the client can order says the downgrade once, without the planner's repeat", async () => {
    versions = ['0.3.207', '0.3.210']
    planned = plan({
      version: '0.3.207',
      downgrade: true,
      warnings: [
        { code: 'DOWNGRADE', text: '0.3.207 is older than the 0.3.210 this deployment runs.' }
      ]
    })
    wrap()
    await screen.findByText(/Runs the newest published version/)
    fireEvent.click(screen.getByRole('combobox', { name: 'Version' }))
    fireEvent.click(await screen.findByRole('option', { name: /^0\.3\.207/ }))
    const box = await screen.findByRole('status', { name: 'This is a downgrade' })
    await waitFor(() => expect(planCalls().length).toBeGreaterThan(0))
    await screen.findByText(/older than the version it runs/)
    expect(within(box).queryByText(/this deployment runs\./)).toBeNull()
  })

  it('N-r2-7: on a phone the tenant goes under the app; its column is for wider screens', async () => {
    wrap()
    const table = await screen.findByRole('table', { name: 'Apps this upgrade touches' })
    const head = within(table).getByRole('columnheader', { name: 'Tenant' })
    expect(head.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'sm:table-cell']))
    const phoneLine = within(table).getByText('Tenant beta-e7')
    expect(phoneLine.className.split(/\s+/)).toContain('sm:hidden')
    const appCell = within(table).getByText(
      (_, el) => el?.tagName === 'SPAN' && el.textContent?.replace(/\s+/g, ' ') === 'beta / demo'
    )
    expect(appCell.className.split(/\s+/)).toContain('whitespace-nowrap')
  })
})
