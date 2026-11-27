import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, o?: unknown) => h.get(url, o),
    post: vi.fn(),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

const { DbServerForm } = await import('./DbServerForm')
const { linkTypesFor, linkWords } = await import('./db-api')

const branch = {
  id: 7,
  connection_id: 1,
  provider: 'neon',
  type: 'neon.branch',
  external_id: 'proj-1/br-1',
  name: 'main',
  scope: 'shared',
  app_id: null,
  environment_id: null,
  deleted_at: null
}
const server = {
  id: 3,
  name: 'Neon main',
  engine: 'pg' as const,
  host: 'ep-cool-1.us-east-2.aws.neon.tech',
  port: 5432,
  provision_mode: 'manual' as const,
  ssl_mode: null,
  trust_server_cert: false,
  collation: null,
  user_host: null,
  notes: null,
  admin_secret: null,
  resource_id: 7
}

function setup() {
  h.get.mockResolvedValue({ data: { data: [branch] } })
  h.patch.mockResolvedValue({ data: { data: server } })
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DbServerForm server={server} onSaved={() => {}} onCancel={() => {}} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  h.get.mockReset()
  h.patch.mockReset()
})

describe('link types and words', () => {
  it('offers Neon only to Postgres servers', () => {
    expect(linkTypesFor('pg')).toContain('neon.branch')
    expect(linkTypesFor('mssql')).not.toContain('neon.branch')
    expect(linkTypesFor('mysql2')).toEqual(['aws.rds_instance'])
  })
  it('names a linked server by its resource', () => {
    expect(linkWords('neon.branch', 'main')).toBe('Neon branch main')
  })
})

describe('DbServerForm linked to a Neon branch', () => {
  it('says host and TLS come from the branch and that the password stays sealed', async () => {
    setup()
    expect(await screen.findByText(/pooled address/)).toBeTruthy()
    expect(screen.getByText(/never shown here/)).toBeTruthy()
  })

  it('keeps resource_id in the save body', async () => {
    setup()
    await screen.findByText(/pooled address/)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalled())
    expect(h.patch.mock.calls[0][1]).toMatchObject({ resource_id: 7, engine: 'pg' })
  })
})
