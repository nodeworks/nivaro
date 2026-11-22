import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: (url: string, cfg?: unknown) => h.delete(url, cfg)
  }
}))

const { DatabaseDetail, DbConnectionForm } = await import('./DatabaseDetail')

const server = (mode: 'automatic' | 'manual') => ({
  id: 3,
  name: 'Shared',
  engine: 'pg',
  host: 'db.example.com',
  port: 5432,
  provision_mode: mode,
  ssl_mode: null,
  trust_server_cert: false,
  collation: null,
  user_host: null,
  notes: null,
  admin_secret: '••••••'
})

const base = {
  id: 9,
  server_id: 3,
  server_name: 'Shared',
  engine: 'pg',
  host: 'db.example.com',
  port: 5432,
  database_name: 'app_prod',
  login_name: 'app_prod_login',
  status: 'ready',
  adopted: false,
  created_by_hub: true,
  last_check: null,
  checked_at: null,
  connection: '••••••',
  environment: null,
  checklist: null
}

function setup(row: Record<string, unknown>, mode: 'automatic' | 'manual' = 'automatic') {
  h.get.mockImplementation(async (url: string) =>
    url.startsWith('/hub/db-servers')
      ? { data: { data: [server(mode)] } }
      : { data: { data: { ...base, ...row } } }
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DatabaseDetail id={9} onDeleted={() => {}} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  h.get.mockReset()
  h.post.mockReset()
  h.put.mockReset()
  h.delete.mockReset()
})

describe('DatabaseDetail', () => {
  it('lists the checklist with copy buttons for a requested database and never renders a password', async () => {
    setup(
      {
        status: 'requested',
        created_by_hub: false,
        connection: null,
        checklist: [
          { label: 'Server', value: 'Shared (db.example.com:5432)' },
          { label: 'Database name', value: 'app_prod' },
          { label: 'Then', value: 'Enter the connection in the Hub' }
        ]
      },
      'manual'
    )
    expect(await screen.findByRole('list', { name: 'DBA checklist' })).toBeTruthy()
    expect(screen.getByText('app_prod', { selector: 'p' })).toBeTruthy()
    // The closing "Then" row is an instruction: no copy button (P3-32).
    expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Copy Then' })).toBeNull()
    const pw = document.querySelector('input[type=password]') as HTMLInputElement
    expect(pw.value).toBe('')
    expect(document.body.textContent).not.toContain('••••••')
  })

  it('says a foreign database in words and keeps driver text behind details', async () => {
    setup({
      last_check: {
        state: 'foreign',
        ok: false,
        version: '16',
        migrations: null,
        last_migration: null,
        text: 'relation "x" exists',
        at: new Date().toISOString()
      },
      checked_at: new Date().toISOString()
    })
    expect(await screen.findByText('Holds something that is not Nivaro')).toBeTruthy()
    expect(screen.getByText('Details for support')).toBeTruthy()
  })

  it('shows the refusal copy for a check another Hub record already holds', async () => {
    setup({
      last_check: {
        state: 'error',
        code: 'DATABASE_IN_USE',
        ok: false,
        version: null,
        migrations: null,
        last_migration: null,
        text: '',
        at: new Date().toISOString()
      }
    })
    expect(await screen.findByText('Another Hub record uses this database')).toBeTruthy()
  })

  it('needs the exact name before it detaches', async () => {
    setup({})
    const btn = await screen.findByRole('button', { name: 'Detach database' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type app_prod to confirm/), {
      target: { value: 'app_pro' }
    })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type app_prod to confirm/), {
      target: { value: 'app_prod' }
    })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
    h.delete.mockResolvedValue({ data: { data: { id: 9, dropped: false } } })
    fireEvent.click(btn)
    fireEvent.click(await screen.findByRole('button', { name: 'Detach it?' }))
    await waitFor(() =>
      expect(h.delete).toHaveBeenCalledWith('/hub/databases/9', {
        data: { confirm: 'app_prod', drop: false }
      })
    )
  })

  it('offers the drop switch only for a database the Hub made on an automatic server', async () => {
    const view = setup({})
    expect(await screen.findByRole('switch', { name: 'Drop the database too' })).toBeTruthy()
    view.unmount()
    setup({ adopted: true, created_by_hub: false })
    await screen.findByRole('button', { name: 'Detach database' })
    expect(screen.queryByRole('switch', { name: 'Drop the database too' })).toBeNull()
  })
})

describe('DatabaseDetail passwords', () => {
  const requested = { status: 'requested', created_by_hub: false, connection: null, checklist: [] }
  const passwordInput = () => document.querySelector('input[type=password]') as HTMLInputElement

  it('clears the typed password after a save', async () => {
    setup(requested, 'manual')
    await screen.findByRole('button', { name: 'Save and check' })
    fireEvent.change(passwordInput(), { target: { value: 'dba-secret' } })
    expect(passwordInput().value).toBe('dba-secret')
    h.put.mockResolvedValue({
      data: {
        check: {
          state: 'foreign',
          ok: false,
          text: '',
          at: '',
          version: null,
          migrations: null,
          last_migration: null
        }
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save and check' }))
    await waitFor(() => expect(h.put).toHaveBeenCalled())
    await waitFor(() => expect(passwordInput().value).toBe(''))
  })

  it('clears the typed password after Check now', async () => {
    setup({ ...requested, status: 'failed', connection: '••••••' }, 'manual')
    await screen.findByRole('button', { name: 'Save and check' })
    fireEvent.change(passwordInput(), { target: { value: 'dba-secret' } })
    h.post.mockResolvedValue({
      data: {
        data: {
          state: 'foreign',
          ok: false,
          text: '',
          at: '',
          version: null,
          migrations: null,
          last_migration: null
        }
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    await waitFor(() => expect(passwordInput().value).toBe(''))
  })

  it('Check now keeps the rest of an unsaved connection draft (only the password goes)', async () => {
    setup({ ...requested, status: 'failed', connection: '••••••' }, 'manual')
    await screen.findByRole('button', { name: 'Save and check' })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'db9.corp.example.com' } })
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'typed_login' } })
    fireEvent.change(passwordInput(), { target: { value: 'dba-secret' } })
    h.post.mockResolvedValue({
      data: {
        data: {
          state: 'foreign',
          ok: false,
          text: '',
          at: '',
          version: null,
          migrations: null,
          last_migration: null
        }
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(passwordInput().value).toBe(''))
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('db9.corp.example.com')
    expect((screen.getByLabelText('Login') as HTMLInputElement).value).toBe('typed_login')
  })

  it('hides Check now until a connection is saved (P3-29)', async () => {
    setup({ ...requested, status: 'failed', connection: null }, 'manual')
    await screen.findByRole('button', { name: 'Save and check' })
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
  })
})

describe('DbConnectionForm', () => {
  it("an admin's form starts from the server's TLS (P3-29)", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DbConnectionForm
          row={
            {
              ...base,
              engine: 'mssql',
              status: 'requested',
              server_tls: { ssl_mode: 'require', trust_server_cert: true }
            } as never
          }
        />
      </QueryClientProvider>
    )
    expect(screen.getByLabelText('TLS').textContent).toContain('TLS, any certificate')
    expect(
      screen
        .getByRole('switch', { name: 'Trust the server certificate' })
        .getAttribute('aria-checked')
    ).toBe('true')
  })

  it('shows an owner the server TLS read-only', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DbConnectionForm
          row={{ ...base, status: 'requested' } as never}
          lockPlace
          serverTls='TLS, verify the CA'
        />
      </QueryClientProvider>
    )
    const tls = screen.getByLabelText('TLS') as HTMLInputElement
    expect(tls.readOnly).toBe(true)
    expect(tls.value).toBe('TLS, verify the CA')
  })

  it('owners see the server address read-only', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DbConnectionForm row={{ ...base, status: 'requested' } as never} lockPlace />
      </QueryClientProvider>
    )
    expect((screen.getByLabelText('Host') as HTMLInputElement).readOnly).toBe(true)
    expect((screen.getByLabelText('Port') as HTMLInputElement).readOnly).toBe(true)
  })
})
