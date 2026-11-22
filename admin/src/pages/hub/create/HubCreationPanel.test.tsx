import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 3): one environment's creation — the eight steps, what it waits for and
// what to do about it (DBA checklist + connection, DNS ticket, the operator's deploy key),
// Retry only after a failure, Cancel only while it runs.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: vi.fn(),
    put: (url: string, body?: unknown) => h.put(url, body),
    delete: vi.fn()
  }
}))

const { HubCreationPanel } = await import('./HubCreationPanel')
const { creationPollMs, STEP_ORDER } = await import('./create-api')

const steps = (overrides: Record<string, { status: string; note?: string; at?: string }> = {}) =>
  STEP_ORDER.map((key) => ({
    key,
    status: overrides[key]?.status ?? 'pending',
    at: overrides[key]?.at ?? null,
    note: overrides[key]?.note ?? null
  }))

const database = {
  id: 9,
  server_id: 2,
  server_name: 'sql-dba',
  engine: 'mssql',
  host: 'sql1.example.com',
  port: 1433,
  database_name: 'nivaro_demo_staging',
  login_name: 'demo_staging',
  status: 'requested',
  adopted: false,
  created_by_hub: false,
  last_check: null,
  checked_at: null,
  connection: '••••••',
  environment: { id: 10, app_id: 1, app_key: 'demo', env_key: 'staging' }
}

function view(patch: Record<string, unknown> = {}) {
  return {
    id: 1,
    app_id: 1,
    app_key: 'demo',
    environment_id: 10,
    env_key: 'staging',
    status: 'running',
    step: 'repository',
    waiting_for: null,
    operator_installed_at: null,
    steps: steps({ database: { status: 'done' }, repository: { status: 'running' } }),
    error: null,
    version: '1.2.3',
    first_admin: { email: 'ada@example.com' },
    job_run_id: 5,
    started_by: 'u1',
    created_at: null,
    updated_at: null,
    finished_at: null,
    hostname: 'demo--staging.apps.example.com',
    base_url: 'https://demo--staging.apps.example.com',
    redirect_uri: 'https://demo--staging.apps.example.com/api/auth/callback',
    log: [{ seq: 1, at: new Date().toISOString(), level: 'info', line: 'database → done' }],
    checklist: null,
    ticket: null,
    database: null,
    deploy_key: null,
    ...patch
  }
}

function mount(v: Record<string, unknown>, opts: { isAdmin?: boolean; envStatus?: string } = {}) {
  h.get.mockResolvedValue({ data: { data: v } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubCreationPanel
        envId={10}
        envStatus={opts.envStatus ?? 'provisioning'}
        appId={1}
        isAdmin={opts.isAdmin ?? true}
      />
    </QueryClientProvider>
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('HubCreationPanel', () => {
  it('shows all eight steps with their state', async () => {
    mount(view())
    const track = await screen.findByRole('list', { name: 'Steps' })
    expect(within(track).getAllByRole('listitem')).toHaveLength(8)
    expect(screen.getByLabelText('Database: done')).toBeTruthy()
    expect(screen.getByLabelText('Deploy repository: in progress')).toBeTruthy()
    expect(screen.getByLabelText('First administrator: not started')).toBeTruthy()
    expect(h.get).toHaveBeenCalledWith('/hub/environments/10/creation', undefined)
  })

  it('Retry only on a failed creation, and only for admins', async () => {
    const failed = view({
      status: 'failed',
      error: 'GitLab refused variable NIVARO_DB_URL_B64 (400)',
      steps: steps({ database: { status: 'done' }, variables: { status: 'failed' } })
    })
    const one = mount(failed)
    expect(await screen.findByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
    one.unmount()

    const two = mount(failed, { isAdmin: false })
    await screen.findByText(/GitLab refused variable/)
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    two.unmount()

    const three = mount(view())
    await screen.findByRole('list', { name: 'Steps' })
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy()
    three.unmount()
  })

  it('Retry posts and reads again', async () => {
    mount(view({ status: 'interrupted', steps: steps({ database: { status: 'done' } }) }))
    h.post.mockResolvedValue({ data: { data: { status: 'running' } } })
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }))
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/creation/retry', {})
    )
  })

  it('a database wait shows the DBA checklist and a connection form with an empty password', async () => {
    mount(
      view({
        status: 'waiting',
        waiting_for: 'database',
        steps: steps({ database: { status: 'waiting', note: 'waiting for the DBA' } }),
        checklist: [
          { label: 'Database', value: 'nivaro_demo_staging' },
          { label: 'Login', value: 'demo_staging', note: 'Owner of the database' }
        ],
        database
      })
    )
    const list = await screen.findByRole('list', { name: 'DBA checklist' })
    expect(within(list).getByText('nivaro_demo_staging')).toBeTruthy()
    expect(within(list).getByRole('button', { name: 'Copy Login' })).toBeTruthy()
    const pw = screen.getByLabelText('Password') as HTMLInputElement
    expect(pw.value).toBe('')
    expect(pw.type).toBe('password')
    expect(document.body.textContent).not.toContain('••••••')
    expect(screen.getByRole('button', { name: /Check now/ })).toBeTruthy()
  })

  it('an owner sees the database host and port read-only and may save a connection', async () => {
    mount(
      view({
        status: 'waiting',
        waiting_for: 'database',
        steps: steps({ database: { status: 'waiting' } }),
        database
      }),
      { isAdmin: false }
    )
    const host = (await screen.findByLabelText('Host')) as HTMLInputElement
    expect(host.readOnly).toBe(true)
    expect((screen.getByLabelText('Port') as HTMLInputElement).readOnly).toBe(true)
    h.put.mockResolvedValue({
      data: {
        data: { ...database, status: 'ready' },
        check: { state: 'empty', text: 'Empty and owned by the login', at: '' },
        creation: { status: 'running' }
      }
    })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-typed-here' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and check' }))
    await waitFor(() => expect(h.put).toHaveBeenCalled())
    expect(h.put.mock.calls[0][0]).toBe('/hub/databases/9/connection')
    expect(await screen.findByText('Empty and owned by the login')).toBeTruthy()
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
  })

  it('a name wait shows the ticket and the last check in words', async () => {
    mount(
      view({
        status: 'waiting',
        waiting_for: 'name',
        ticket: 'Please add demo.example.com → edge.example.com with a certificate.',
        steps: steps({
          name: {
            status: 'waiting',
            note: 'demo.example.com does not resolve yet',
            at: new Date().toISOString()
          }
        })
      })
    )
    expect(await screen.findByText(/Please add demo\.example\.com/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy ticket' })).toBeTruthy()
    expect(screen.getAllByText(/Demo\.example\.com does not resolve yet/).length).toBeGreaterThan(0)
  })

  it('an operator wait shows both lines with Copy, and Installed posts', async () => {
    mount(
      view({
        status: 'waiting',
        waiting_for: 'operator',
        steps: steps({ deploy: { status: 'waiting' } }),
        deploy_key: {
          keyid: 'SHA256:abc',
          public_key: 'ssh-ed25519 AAAA demo',
          authorized_keys:
            'command="/usr/local/bin/nivaro-hub-deploy demo keyid=SHA256:abc" ssh-ed25519 AAAA demo',
          key_conf: 'stack=demo--staging\nhost=demo--staging.apps.example.com\n',
          key_conf_path: '/etc/nivaro-hub-deploy/keys/demo.conf'
        }
      }),
      { isAdmin: false }
    )
    expect(await screen.findByText(/nivaro-hub-deploy demo keyid/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy authorized_keys line' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy key configuration' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Check now/ })).toBeNull()
    h.post.mockResolvedValue({ data: { data: { status: 'running', environments: [10] } } })
    fireEvent.click(screen.getByRole('button', { name: 'Installed' }))
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/10/creation/installed', {})
    )
  })

  it('shows the queued note when another run holds the environment', async () => {
    mount(
      view({
        status: 'waiting',
        waiting_for: 'database',
        steps: steps({
          database: { status: 'waiting', note: 'queued: another run holds this environment' }
        })
      })
    )
    expect(await screen.findByText('Queued: another run holds this environment')).toBeTruthy()
  })

  it('renders nothing for a done creation or an environment not being created', async () => {
    const one = mount(view({ status: 'done' }))
    await waitFor(() => expect(h.get).toHaveBeenCalled())
    expect(screen.queryByRole('list', { name: 'Steps' })).toBeNull()
    one.unmount()
    vi.clearAllMocks()
    mount(view(), { envStatus: 'active' })
    expect(h.get).not.toHaveBeenCalled()
  })

  it('polls fast while running and slowly while waiting', () => {
    expect(creationPollMs('running')).toBe(3000)
    expect(creationPollMs('waiting')).toBe(30000)
    expect(creationPollMs('failed')).toBe(false)
  })
})
