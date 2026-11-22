import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 3): Create app. The preview asks the Hub 600 ms after the last change; Create
// is offered only while the preview of exactly this form has no blockers; blockers are shown in
// the planner's words next to their environment; manual targets need a hostname per environment.

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

// Test doubles: the Radix select and the person search need a real browser.
vi.mock('@/components/ui/simple-select', () => ({
  SimpleSelect: ({
    value,
    onChange,
    options,
    ariaLabel
  }: {
    value: string
    onChange: (v: string) => void
    options: Array<{ value: string; label: string }>
    ariaLabel?: string
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}))
vi.mock('@/components/user-combobox', () => ({ UserCombobox: () => null }))

const { HubCreateApp } = await import('./HubCreateApp')
const { dbKeys } = await import('../databases/db-api')

const baseTarget = {
  id: 3,
  kind: 'gitlab',
  name: 'Swarm one',
  secret: '••••••',
  config: {
    api: 'https://gitlab.example.com/api/v4',
    namespace: 'apps',
    template_project: 'ops/nivaro-app',
    template_ref: 'v1.2.0',
    pin_file: '.hub/nivaro-version',
    deploy_job: 'deploy',
    deploy_host: 'swarm1.example.com',
    manager_known_hosts: 'swarm1.example.com ssh-ed25519 AAAA',
    proxy_network: 'proxy',
    dns_mode: 'automatic',
    wildcard_domain: 'apps.example.com',
    edge_address: null,
    scheme: 'https',
    port: null,
    cert_note: null
  }
}
const manualTarget = {
  ...baseTarget,
  id: 4,
  name: 'By hand',
  config: { ...baseTarget.config, dns_mode: 'manual', wildcard_domain: null }
}

const cleanPlan = {
  ok: true,
  blockers: [],
  lines: ['Fork ops/nivaro-app into apps/demo-deploy (target Swarm one).'],
  app: { key: 'demo', name: 'Demo', project_path: 'apps/demo-deploy' },
  environments: [
    {
      key: 'staging',
      position: 0,
      hostname: 'demo--staging.apps.example.com',
      base_url: 'https://demo--staging.apps.example.com',
      dns_mode: 'automatic',
      ticket: null,
      redirect_uri: 'https://demo--staging.apps.example.com/api/auth/callback',
      branch: 'staging',
      source_branch: 'staging',
      stack_name: 'demo--staging',
      database: {
        mode: 'manual',
        server_name: 'sql-dba',
        database_name: 'nivaro_demo_staging',
        login_name: 'demo_staging',
        engine: 'mssql',
        checklist: []
      }
    },
    {
      key: 'production',
      position: 1,
      hostname: 'demo.apps.example.com',
      base_url: 'https://demo.apps.example.com',
      dns_mode: 'automatic',
      ticket: null,
      redirect_uri: 'https://demo.apps.example.com/api/auth/callback',
      branch: 'production',
      source_branch: 'staging',
      stack_name: 'demo--production',
      database: {
        mode: 'automatic',
        server_name: 'sql-auto',
        database_name: 'nivaro_demo_production',
        login_name: 'demo_production',
        engine: 'mssql',
        checklist: null
      }
    }
  ]
}

function answerGets(targets: unknown[]) {
  h.get.mockImplementation((url: string) => {
    if (url === '/hub/targets') return Promise.resolve({ data: { data: targets } })
    if (url === '/hub/db-servers')
      return Promise.resolve({
        data: {
          data: [
            {
              id: 1,
              name: 'sql-auto',
              engine: 'mssql',
              host: 'a',
              port: null,
              provision_mode: 'automatic'
            }
          ]
        }
      })
    if (url === '/hub/databases') return Promise.resolve({ data: { data: [] } })
    return Promise.reject(new Error(`unexpected ${url}`))
  })
}

function answerPlan(plan: unknown) {
  h.post.mockImplementation((url: string) =>
    url === '/hub/apps/create/plan'
      ? Promise.resolve({ data: { data: plan } })
      : Promise.reject(new Error(`unexpected ${url}`))
  )
}

function mount(onDone = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <HubCreateApp onDone={onDone} onCancel={vi.fn()} />
    </QueryClientProvider>
  )
  return onDone
}

async function fillBasics(targetId = '3') {
  await screen.findByRole('option', { name: /Swarm one|By hand/ })
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'demo' } })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Demo' } })
  fireEvent.change(screen.getByLabelText('Target'), { target: { value: targetId } })
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.2.3' } })
}

const createButton = () => screen.getByRole('button', { name: /Create app/ }) as HTMLButtonElement
const planCalls = () => h.post.mock.calls.filter(([u]) => u === '/hub/apps/create/plan')

afterEach(() => {
  vi.clearAllMocks()
})

describe('HubCreateApp', () => {
  it('Create stays disabled while the plan has blockers, which show in plain words', async () => {
    answerGets([baseTarget])
    answerPlan({
      ...cleanPlan,
      ok: false,
      blockers: [
        { code: 'KEY_TAKEN', text: 'An app with the key demo exists already.' },
        { code: 'BAD_EMAIL', text: "The first administrator's first name must be one line." },
        {
          code: 'DATABASE_RECORDED',
          text: 'demo_production is given to two environments.',
          env: 'production'
        }
      ]
    })
    mount()
    await fillBasics()
    expect(
      await screen.findByText('An app with the key demo exists already.', {}, { timeout: 3000 })
    ).toBeTruthy()
    expect(screen.getByText("The first administrator's first name must be one line.")).toBeTruthy()
    const prod = screen.getByRole('listitem', { name: 'Environment 2: production' })
    expect(within(prod).getByText('demo_production is given to two environments.')).toBeTruthy()
    expect(createButton().disabled).toBe(true)
  })

  it('previews once, 600 ms after the last change, and enables Create on a clean plan', async () => {
    answerGets([baseTarget])
    answerPlan(cleanPlan)
    const onDone = mount()
    await fillBasics()
    expect(planCalls()).toHaveLength(0)
    await waitFor(() => expect(createButton().disabled).toBe(false), { timeout: 3000 })
    expect(planCalls()).toHaveLength(1)
    const sent = planCalls()[0][1]
    expect(sent.key).toBe('demo')
    expect(sent.target_id).toBe(3)
    expect(sent.environments.map((e: { key: string }) => e.key)).toEqual(['staging', 'production'])

    h.post.mockImplementation((url: string) =>
      url === '/hub/apps/create'
        ? Promise.resolve({ data: { data: { app_id: 42, environments: [] } } })
        : Promise.resolve({ data: { data: cleanPlan } })
    )
    fireEvent.click(createButton())
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(42))
  })

  it('shows the automatic hostnames and the redirect URIs to add', async () => {
    answerGets([baseTarget])
    answerPlan(cleanPlan)
    mount()
    await fillBasics()
    expect(await screen.findAllByText('demo--staging.apps.example.com')).toBeTruthy()
    expect(screen.getAllByText('demo.apps.example.com').length).toBeGreaterThan(0)
    expect(
      await screen.findByText(
        'https://demo.apps.example.com/api/auth/callback',
        {},
        { timeout: 3000 }
      )
    ).toBeTruthy()
    expect(screen.queryByLabelText('Hostname (you will request it)')).toBeNull()
  })

  it('shows plan warnings (an existing Nivaro database) without blocking Create (P3-32)', async () => {
    answerGets([baseTarget])
    const warning =
      'staging: nivaro_old already holds a Nivaro install (545 migrations): the app starts on that data and its users, and the first administrator is made only if it has none. Make sure no other app still uses it.'
    answerPlan({ ...cleanPlan, warnings: [warning] })
    mount()
    await fillBasics()
    const list = await screen.findByRole('list', { name: 'Before you create' }, { timeout: 3000 })
    expect(list.textContent).toContain('already holds a Nivaro install')
  })

  it('a manual target requires a hostname per environment before Create', async () => {
    answerGets([manualTarget])
    answerPlan({
      ...cleanPlan,
      environments: cleanPlan.environments.map((e) => ({ ...e, dns_mode: 'manual' }))
    })
    mount()
    await fillBasics('4')
    const fields = await screen.findAllByLabelText('Hostname (you will request it)')
    expect(fields).toHaveLength(2)
    expect(screen.getAllByText('Enter the hostname you will request')).toHaveLength(2)
    await waitFor(() => expect(planCalls().length).toBeGreaterThan(0), { timeout: 3000 })
    expect(createButton().disabled).toBe(true)

    fireEvent.change(fields[0], { target: { value: 'demo-staging.example.com' } })
    fireEvent.change(fields[1], { target: { value: 'demo.example.com' } })
    await waitFor(() => expect(createButton().disabled).toBe(false), { timeout: 3000 })
    const last = planCalls().at(-1)?.[1]
    expect(last.environments.map((e: { hostname?: string }) => e.hostname)).toEqual([
      'demo-staging.example.com',
      'demo.example.com'
    ])
  })

  it('the client secret is a password field that starts empty', async () => {
    answerGets([baseTarget])
    mount()
    const secret = (await screen.findByLabelText('Client secret')) as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(secret.value).toBe('')
  })

  it('a client secret of spaces only keeps Create disabled with one message', async () => {
    answerGets([baseTarget])
    // The planner refuses a missing secret; spaces must not also earn that blocker.
    h.post.mockImplementation((url: string, body: { signin: { client_secret: string } }) =>
      url === '/hub/apps/create/plan'
        ? Promise.resolve({
            data: {
              data: body.signin.client_secret
                ? cleanPlan
                : {
                    ...cleanPlan,
                    ok: false,
                    blockers: [{ code: 'BAD_SIGNIN', text: 'Enter the client secret.' }]
                  }
            }
          })
        : Promise.reject(new Error(`unexpected ${url}`))
    )
    mount()
    await fillBasics()
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: '   ' } })
    await waitFor(() => expect(planCalls().length).toBeGreaterThan(0), { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 700))
    expect(createButton().disabled).toBe(true)
    expect(screen.getByText('Type the client secret')).toBeTruthy()
    expect(planCalls().at(-1)?.[1].signin.client_secret).toBe('••••••')
    expect(screen.queryByText('The sign-in settings are not complete')).toBeNull()
    expect(screen.queryByText('Enter the client secret.')).toBeNull()
  })

  it('reads servers and databases under the Databases tab keys (one key per endpoint)', async () => {
    answerGets([baseTarget])
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <HubCreateApp onDone={vi.fn()} onCancel={vi.fn()} />
      </QueryClientProvider>
    )
    await waitFor(() => expect(qc.getQueryData(dbKeys.servers())).toHaveLength(1))
    expect(qc.getQueryData(dbKeys.databases())).toEqual([])
    expect(qc.getQueryCache().find({ queryKey: ['hub-create-servers'] })).toBeUndefined()
    expect(qc.getQueryCache().find({ queryKey: ['hub-create-databases'] })).toBeUndefined()
  })

  it('previews never carry the client secret; only Create does', async () => {
    answerGets([baseTarget])
    answerPlan(cleanPlan)
    const onDone = mount()
    await fillBasics()
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'real-secret-123' }
    })
    await waitFor(() => expect(createButton().disabled).toBe(false), { timeout: 3000 })
    for (const [, body] of planCalls())
      expect(JSON.stringify(body)).not.toContain('real-secret-123')
    expect(planCalls().at(-1)?.[1].signin.client_secret).toBe('••••••')
    h.post.mockImplementation((url: string) =>
      url === '/hub/apps/create'
        ? Promise.resolve({ data: { data: { app_id: 7, environments: [] } } })
        : Promise.resolve({ data: { data: cleanPlan } })
    )
    fireEvent.click(createButton())
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(7))
    const created = h.post.mock.calls.find(([u]) => u === '/hub/apps/create')?.[1]
    expect(created.signin.client_secret).toBe('real-secret-123')
  })

  it("an older preview's blockers leave the environment rows once the form changes", async () => {
    answerGets([baseTarget])
    answerPlan({
      ...cleanPlan,
      ok: false,
      blockers: [
        { code: 'DATABASE_RECORDED', text: 'demo_production repeated.', env: 'production' }
      ]
    })
    mount()
    await fillBasics()
    const prod = screen.getByRole('listitem', { name: 'Environment 2: production' })
    expect(
      await within(prod).findByText('demo_production repeated.', {}, { timeout: 3000 })
    ).toBeTruthy()
    h.post.mockImplementation(() => new Promise(() => undefined))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Demo 2' } })
    expect(within(prod).queryByText('demo_production repeated.')).toBeNull()
  })

  it('a start refused with blockers shows them and stays on the form', async () => {
    answerGets([baseTarget])
    answerPlan(cleanPlan)
    const onDone = mount()
    await fillBasics()
    await waitFor(() => expect(createButton().disabled).toBe(false), { timeout: 3000 })
    h.post.mockImplementation((url: string) =>
      url === '/hub/apps/create'
        ? Promise.reject({
            response: {
              status: 409,
              data: {
                error: 'blocked',
                code: 'HOSTNAME_TAKEN',
                blockers: [
                  {
                    code: 'HOSTNAME_TAKEN',
                    text: 'demo.apps.example.com is used by another environment.',
                    env: 'production'
                  }
                ]
              }
            }
          })
        : Promise.resolve({ data: { data: cleanPlan } })
    )
    fireEvent.click(createButton())
    const prod = screen.getByRole('listitem', { name: 'Environment 2: production' })
    expect(
      await within(prod).findByText('demo.apps.example.com is used by another environment.')
    ).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    expect(createButton().disabled).toBe(true)
  })
})
