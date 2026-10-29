import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { ProcDetail, ProcRow } from './status'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

import { ProceduresPage } from '../Procedures'

// The page against fixture answers for each kind of procedure: list chips, the drifted banner,
// import-owned read-only, dropped detail, New procedure (born managed) and the drift conflict.

const config = (over: Partial<NonNullable<ProcDetail['config']>> = {}) => ({
  body: 'CREATE OR ALTER PROCEDURE p_sync AS SELECT 2',
  body_hash: 'cfg',
  version: 3,
  deployed_hash: 'cfg',
  deployed_at: '2026-10-28T12:00:00Z',
  deployed_by: 'user:u1',
  dropped_at: null,
  owner: null,
  description: null,
  updated_at: '2026-10-28T12:00:00Z',
  updated_by: 'u1',
  ...over
})

const rows: ProcRow[] = [
  row('p_sync', { kind: 'managed', status: 'in-sync', version: 3, owner: null }),
  row('p_drift', { kind: 'managed', status: 'drifted', version: 2, owner: null }),
  row('p_new', { kind: 'managed', status: 'not-deployed', version: 1, owner: null }, false),
  row('p_pending', { kind: 'managed', status: 'dropped-but-live', version: 4, owner: null }),
  row('p_gone', { kind: 'managed', status: 'dropped', version: 5, owner: null }, false),
  row('p_both', { kind: 'managed', status: 'conflict', version: 1, owner: null }),
  row('p_import', { kind: 'import', key: 'po_lines' }),
  row('p_plain', null)
]

function row(name: string, managed: ProcRow['managed'], live = true): ProcRow {
  return {
    name,
    created: live ? '2026-01-01T00:00:00Z' : null,
    modified: live ? '2026-10-28T12:00:00Z' : null,
    bytes: live ? 100 : 0,
    param_count: 0,
    live,
    managed
  }
}

const details: Record<string, ProcDetail> = {
  p_drift: {
    name: 'p_drift',
    created: '2026-01-01T00:00:00Z',
    modified: '2026-10-28T12:00:00Z',
    definition: 'CREATE PROCEDURE p_drift AS SELECT 99',
    live_hash: 'live-1',
    params: [],
    managed: { kind: 'managed', status: 'drifted', version: 2, owner: null },
    config: config({ body: 'CREATE OR ALTER PROCEDURE p_drift AS SELECT 2', version: 2 })
  },
  p_import: {
    name: 'p_import',
    created: '2026-01-01T00:00:00Z',
    modified: '2026-10-28T12:00:00Z',
    definition: 'CREATE PROCEDURE p_import AS SELECT 1',
    live_hash: 'live-i',
    params: [],
    managed: { kind: 'import', key: 'po_lines' },
    config: null
  },
  p_gone: {
    name: 'p_gone',
    created: null,
    modified: null,
    definition: null,
    live_hash: null,
    params: [],
    managed: { kind: 'managed', status: 'dropped', version: 5, owner: null },
    config: config({
      body: 'CREATE OR ALTER PROCEDURE p_gone AS SELECT 5',
      version: 5,
      deployed_hash: null,
      dropped_at: '2026-10-28T13:00:00Z'
    })
  },
  p_plain: {
    name: 'p_plain',
    created: '2026-01-01T00:00:00Z',
    modified: '2026-10-28T12:00:00Z',
    definition: 'CREATE PROCEDURE p_plain AS SELECT 1',
    live_hash: 'live-p',
    params: [],
    managed: null,
    config: null
  }
}

const get = vi.mocked(api.get)
const post = vi.mocked(api.post)
const put = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ;(api as unknown as { put: typeof put }).put = put
  get.mockImplementation(async (url: string) => {
    if (url === '/procedures') return { data: { data: rows } }
    const m = /^\/procedures\/([^/]+)(\/versions)?$/.exec(url)
    if (m?.[2]) return { data: { data: [] } }
    if (m && details[m[1]]) return { data: { data: details[m[1]] } }
    throw Object.assign(new Error('nf'), { response: { status: 404, data: { error: 'nf' } } })
  })
})

function wrap(ui: ReactNode, path = '/procedures') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

async function openProc(name: string) {
  const list = await screen.findByRole('complementary', { name: 'Procedures' })
  fireEvent.click(await within(list).findByText(name))
}

describe('Procedures page', () => {
  it('lists every chip from `managed`, none for in sync', async () => {
    wrap(<ProceduresPage />)
    const list = await screen.findByRole('complementary', { name: 'Procedures' })
    await within(list).findByText('p_sync')
    const chipOf = (name: string) =>
      within(within(list).getByText(name).closest('button') as HTMLElement)
    expect(chipOf('p_drift').getByText('drifted')).toBeInTheDocument()
    expect(chipOf('p_new').getByText('not deployed')).toBeInTheDocument()
    expect(chipOf('p_pending').getByText('drop pending')).toBeInTheDocument()
    expect(chipOf('p_gone').getByText('dropped')).toBeInTheDocument()
    expect(chipOf('p_both').getByText('conflict')).toBeInTheDocument()
    expect(chipOf('p_import').getByText('import')).toHaveAttribute(
      'data-tip',
      'Owned by import definition po_lines — edit it there'
    )
    expect(chipOf('p_plain').getByText('not managed')).toBeInTheDocument()
    expect(chipOf('p_sync').queryByText(/drifted|not managed|import/)).toBeNull()
    expect(chipOf('p_gone').getByText('not on this database')).toBeInTheDocument()
  })

  it('drifted: banner deploys config or keeps the database version', async () => {
    post.mockResolvedValue({ data: { data: { action: 'altered' } } })
    wrap(<ProceduresPage />)
    await openProc('p_drift')
    expect(
      await screen.findByText('The database differs from saved version 2.')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show the difference/ }))
    expect(screen.getByText(/vs saved version 2/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Deploy version 2/ }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/procedures/p_drift/deploy'))
    fireEvent.click(screen.getByRole('button', { name: "Keep the database's version" }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/procedures/p_drift/adopt?keep_live=1', {})
    )
  })

  it('import-owned: read-only editor and a link to the definition', async () => {
    wrap(<ProceduresPage />)
    await openProc('p_import')
    const link = await screen.findByRole('link', { name: /Open import definition/ })
    expect(link).toHaveAttribute('href', '/imports?definition=po_lines')
    expect(screen.getByLabelText('Definition of p_import')).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: /Drop/ })).toBeNull()
  })

  it('dropped: last version read-only with Restore version n', async () => {
    post.mockResolvedValue({ data: { data: { version: 6, unchanged: false } } })
    wrap(<ProceduresPage />)
    await openProc('p_gone')
    expect(await screen.findByLabelText('Definition of p_gone')).toHaveValue(
      'CREATE OR ALTER PROCEDURE p_gone AS SELECT 5'
    )
    expect(screen.getByLabelText('Definition of p_gone')).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: /Restore version 5/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Restore$/ }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/procedures/p_gone/versions/5/restore', {
        base_hash: 'cfg',
        base_version: 5,
        base_live_hash: null
      })
    )
  })

  it('unmanaged: first edit warns it becomes managed; drift 409 offers keep or overwrite', async () => {
    put.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { error: 'changed', code: 'PROC_DRIFTED', live_hash: 'live-2' }
      }
    })
    put.mockResolvedValueOnce({
      data: {
        ok: true,
        created: false,
        version: 2,
        unchanged: false,
        deployed: { action: 'altered' }
      }
    })
    wrap(<ProceduresPage />)
    await openProc('p_plain')
    expect(await screen.findByText('Not managed')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Definition of p_plain'), {
      target: { value: 'CREATE PROCEDURE p_plain AS SELECT 7' }
    })
    fireEvent.change(screen.getByPlaceholderText('What changed? (optional)'), {
      target: { value: 'seven' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Deploy changes' }))
    expect(screen.getByText(/becomes app-managed/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Deploy$/ }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/procedures/p_plain', {
        definition: 'CREATE PROCEDURE p_plain AS SELECT 7',
        note: 'seven',
        base_live_hash: 'live-p'
      })
    )
    expect(await screen.findByText('The database changed since you opened it.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2))
    expect(put.mock.calls[1][1]).toMatchObject({ base_live_hash: 'live-2' })
  })

  it('stale config: says so and offers Reload', async () => {
    put.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'stale', code: 'PROC_STALE' } }
    })
    details.p_sync = {
      name: 'p_sync',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-10-28T12:00:00Z',
      definition: 'CREATE OR ALTER PROCEDURE p_sync AS SELECT 2',
      live_hash: 'live-s',
      params: [],
      managed: { kind: 'managed', status: 'in-sync', version: 3, owner: null },
      config: config()
    }
    wrap(<ProceduresPage />)
    await openProc('p_sync')
    fireEvent.change(await screen.findByLabelText('Definition of p_sync'), {
      target: { value: 'CREATE OR ALTER PROCEDURE p_sync AS SELECT 3' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Deploy changes' }))
    fireEvent.click(screen.getByRole('button', { name: /^Deploy$/ }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/procedures/p_sync', {
        definition: 'CREATE OR ALTER PROCEDURE p_sync AS SELECT 3',
        base_hash: 'cfg',
        base_version: 3,
        base_live_hash: 'live-s'
      })
    )
    expect(
      await screen.findByText('Someone saved a newer version. Reload it before deploying.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('new procedure is born managed (create: true)', async () => {
    put.mockResolvedValueOnce({
      data: {
        ok: true,
        created: true,
        version: 1,
        unchanged: false,
        deployed: { action: 'created' }
      }
    })
    wrap(<ProceduresPage />)
    fireEvent.click(await screen.findByRole('button', { name: /New procedure/ }))
    expect(screen.getByText('Saved to config as version 1, then deployed.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'p_fresh' } })
    fireEvent.click(screen.getByRole('button', { name: /Create & deploy/ }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/procedures/p_fresh',
        expect.objectContaining({ create: true, definition: expect.stringContaining('p_fresh') })
      )
    )
  })
})
