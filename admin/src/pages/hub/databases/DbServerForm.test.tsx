import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ patch: vi.fn(), post: vi.fn(), delete: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: (url: string) => h.delete(url)
  }
}))

const { DbServerForm } = await import('./DbServerForm')

const MASK = '••••••'
const server = {
  id: 3,
  name: 'Shared',
  engine: 'pg' as const,
  host: 'db.example.com',
  port: 5432,
  provision_mode: 'manual' as const,
  ssl_mode: null,
  trust_server_cert: false,
  collation: null,
  user_host: null,
  notes: null,
  admin_secret: MASK
}

function setup(s = server) {
  h.patch.mockResolvedValue({ data: { data: s } })
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DbServerForm server={s} onSaved={() => {}} onCancel={() => {}} />
    </QueryClientProvider>
  )
}
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))

afterEach(() => {
  h.patch.mockReset()
  h.post.mockReset()
  h.delete.mockReset()
})

describe('DbServerForm provisioning login', () => {
  it('keeps the stored login when nothing was touched (sends the mask)', async () => {
    setup()
    type('Notes', 'a note')
    save()
    await waitFor(() => expect(h.patch).toHaveBeenCalled())
    expect(h.patch.mock.calls[0][1]).toMatchObject({ admin_secret: MASK, notes: 'a note' })
  })

  it('clears the login when both halves are emptied', async () => {
    setup()
    type('User', '')
    type('Password', '')
    save()
    await waitFor(() => expect(h.patch).toHaveBeenCalled())
    expect(h.patch.mock.calls[0][1].admin_secret).toBeNull()
  })

  it('seals a new login when both halves are retyped', async () => {
    setup()
    type('User', 'dba')
    type('Password', 'new-secret')
    save()
    await waitFor(() => expect(h.patch).toHaveBeenCalled())
    expect(h.patch.mock.calls[0][1].admin_secret).toEqual({ user: 'dba', password: 'new-secret' })
  })

  it('refuses a half-edited login: the mask is never sent as a credential', async () => {
    setup()
    type('User', 'dba')
    save()
    expect(
      await screen.findByText(
        'Type both the user and the password again, or leave both as they are'
      )
    ).toBeTruthy()
    expect(h.patch).not.toHaveBeenCalled()
  })

  it('blocks Save after the address moved until a new login is typed', async () => {
    setup()
    type('Host', 'other.example.com')
    save()
    expect(
      await screen.findByText(
        'The address or TLS setting changed: type the user and the password again'
      )
    ).toBeTruthy()
    expect(h.patch).not.toHaveBeenCalled()
    type('User', 'dba')
    type('Password', 'pw')
    save()
    await waitFor(() => expect(h.patch).toHaveBeenCalled())
  })

  it('keeps the raw request error out of what it shows and holds', async () => {
    setup()
    h.patch.mockRejectedValue({
      response: { status: 400, data: { code: 'SECRET_REQUIRED' } },
      config: { data: '{"password":"hunter2"}' }
    })
    type('Notes', 'x')
    save()
    expect(await screen.findByText('Enter the login again')).toBeTruthy()
    expect(document.body.textContent).not.toContain('hunter2')
  })
})

describe('DbServerForm Test', () => {
  it('says what the login may do and which rights are missing', async () => {
    h.post.mockResolvedValue({
      data: {
        data: {
          ok: true,
          version: 'PostgreSQL 16',
          can_create: false,
          missing: ['CREATEDB'],
          text: ''
        }
      }
    })
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Connected, but the login cannot create databases')).toBeTruthy()
    expect(screen.getByText('Missing right: CREATEDB')).toBeTruthy()
  })

  it('reads a manual server with no login from the typed flag, not from text', async () => {
    h.post.mockResolvedValue({
      data: {
        data: { ok: true, version: null, can_create: false, missing: [], text: '', manual: true }
      }
    })
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Manual server: nothing to test')).toBeTruthy()
  })
})
