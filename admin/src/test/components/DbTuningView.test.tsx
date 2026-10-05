import type { NivaroClient } from '@nivaro/sdk'
import { DbTuningView, NivaroProvider, type TuningProposal } from '@nivaro/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

const SETTINGS = {
  enabled: true,
  ai_rewrites: true,
  min_estimate_ms_per_day: 5000,
  watch_days: 7,
  regression_pct: 25,
  proc_timeout_minutes: 10,
  ai_daily_budget_usd: 2
}

function proposal(over: Partial<TuningProposal> = {}): TuningProposal {
  return {
    id: 'p1',
    kind: 'index_create',
    target: 'dbo.orders',
    fingerprint: 'f1',
    status: 'proposed',
    title: 'Index orders on customer_id',
    evidence: { seeks: 12 },
    proof: {
      passed: true,
      method: 'hypothetical',
      before: { cost: 10 },
      after: { cost: 2 },
      detail: 'plans 80% cheaper'
    },
    estimate_ms_per_day: 7_200_000,
    risk: 'reversible',
    replicated: false,
    dialect_note: null,
    apply: {
      type: 'sql',
      statements: ['CREATE INDEX ix_orders_customer ON dbo.orders (customer_id)']
    },
    undo: { type: 'sql', statements: ['DROP INDEX ix_orders_customer ON dbo.orders'] },
    applied_at: null,
    applied_by: null,
    watch_until: null,
    watch_baseline: null,
    rolled_back_at: null,
    rollback_reason: null,
    dismissed_at: null,
    dismissed_by: null,
    dismiss_note: null,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    run_id: null,
    ...over
  }
}

const apiError = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.error)), { status, response: body })

/** A client that answers the tuning routes; `posts` overrides a POST path's answer. */
function mockClient(
  rows: TuningProposal[],
  posts: Record<string, (body: unknown) => unknown> = {}
) {
  const request = vi.fn(async (cmd: Cmd) => {
    if (cmd._method === 'GET' && cmd._path === '/db-tuning')
      return {
        data: {
          settings: SETTINGS,
          by_status: { proposed: rows.length },
          by_kind: {},
          open_estimate_ms_per_day: 7_200_000,
          applied_30d: 0,
          last_run: null,
          is_running: false,
          observers: []
        }
      }
    if (cmd._method === 'GET' && cmd._path === '/db-tuning/proposals') return { data: rows }
    if (cmd._method === 'GET' && cmd._path.startsWith('/db-tuning/proposals/'))
      return { data: rows.find((r) => cmd._path.endsWith(`/${r.id}`)) }
    if (cmd._method === 'POST' && posts[cmd._path]) return posts[cmd._path](cmd._body)
    if (cmd._method === 'POST') return { data: {} }
    throw new Error(`unexpected ${cmd._method} ${cmd._path}`)
  })
  return { client: { request } as unknown as NivaroClient, request }
}

function renderView(client: NivaroClient, onNotice = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <NivaroProvider client={client}>
        <DbTuningView onNotice={onNotice} />
      </NivaroProvider>
    </QueryClientProvider>
  )
  return onNotice
}

const postsTo = (request: ReturnType<typeof vi.fn>, path: string) =>
  request.mock.calls.map(([c]) => c as Cmd).filter((c) => c._method === 'POST' && c._path === path)

async function openRow(title: string) {
  fireEvent.click(await screen.findByText(title))
  await screen.findByText('Evidence')
}

describe('DbTuningView', () => {
  it('renders the proposals the client returns, open-tab first', async () => {
    const { client, request } = mockClient([
      proposal(),
      proposal({ id: 'p2', title: 'Cache the weekly report', kind: 'query_cache' })
    ])
    renderView(client)
    expect(await screen.findByText('Index orders on customer_id')).toBeInTheDocument()
    expect(screen.getByText('Cache the weekly report')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-tuning-proposal]')).toHaveLength(2)
    const list = request.mock.calls
      .map(([c]) => c as Cmd)
      .find((c) => c._path === '/db-tuning/proposals')
    expect(list?._params).toMatchObject({ status: 'proposed' })
  })

  it('Apply posts to the proposal apply path after the confirm', async () => {
    const { client, request } = mockClient([proposal()])
    const onNotice = renderView(client)
    await openRow('Index orders on customer_id')
    fireEvent.click(document.querySelector('[data-tuning-apply]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-tuning-action="apply"]') as HTMLElement)
    await waitFor(() => expect(postsTo(request, '/db-tuning/proposals/p1/apply')).toHaveLength(1))
    expect(postsTo(request, '/db-tuning/proposals/p1/apply')[0]._body).toEqual({ dba_ok: false })
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/^Applied/), 'success')
    )
  })

  it('a replicated 409 asks for the DBA, then re-posts with dba_ok', async () => {
    let calls = 0
    const { client, request } = mockClient([proposal()], {
      '/db-tuning/proposals/p1/apply': (body) => {
        calls++
        if (!(body as { dba_ok?: boolean }).dba_ok)
          throw apiError(409, {
            error: 'target is a replication article',
            code: 'TUNING_REPLICATED',
            target: 'dbo.orders'
          })
        return { data: proposal({ status: 'watching' }) }
      }
    })
    renderView(client)
    await openRow('Index orders on customer_id')
    fireEvent.click(document.querySelector('[data-tuning-apply]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-tuning-action="apply"]') as HTMLElement)
    expect(await screen.findByText(/replication article/)).toBeInTheDocument()
    expect(document.querySelector('[data-tuning-dba]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-tuning-action="apply"]') as HTMLElement)
    await waitFor(() => expect(calls).toBe(2))
    expect(postsTo(request, '/db-tuning/proposals/p1/apply').map((c) => c._body)).toEqual([
      { dba_ok: false },
      { dba_ok: true }
    ])
  })

  it('a stale 409 shows Re-prove on the row', async () => {
    const rows = [proposal()]
    const { client, request } = mockClient(rows, {
      '/db-tuning/proposals/p1/apply': () => {
        rows[0] = { ...rows[0], status: 'stale' }
        throw apiError(409, { error: 'the index already exists', code: 'TUNING_STALE' })
      }
    })
    renderView(client)
    await openRow('Index orders on customer_id')
    fireEvent.click(document.querySelector('[data-tuning-apply]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-tuning-action="apply"]') as HTMLElement)
    expect(await screen.findByText(/the index already exists/)).toBeInTheDocument()
    const reprove = await waitFor(() => {
      const el = document.querySelector('[data-tuning-action="reprove"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    fireEvent.click(reprove)
    await waitFor(() => expect(postsTo(request, '/db-tuning/proposals/p1/reprove')).toHaveLength(1))
  })

  it('dismiss without a note is blocked before any request', async () => {
    const { client, request } = mockClient([proposal()])
    renderView(client)
    await openRow('Index orders on customer_id')
    fireEvent.click(document.querySelector('[data-tuning-dismiss]') as HTMLElement)
    const confirm = document.querySelector('[data-tuning-action="dismiss"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    fireEvent.change(document.querySelector('[data-tuning-dismiss-note]') as HTMLElement, {
      target: { value: '   ' }
    })
    expect(confirm.disabled).toBe(true)
    expect(postsTo(request, '/db-tuning/proposals/p1/dismiss')).toHaveLength(0)
    fireEvent.change(document.querySelector('[data-tuning-dismiss-note]') as HTMLElement, {
      target: { value: 'covered by the nightly rebuild' }
    })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(postsTo(request, '/db-tuning/proposals/p1/dismiss')).toHaveLength(1))
    expect(postsTo(request, '/db-tuning/proposals/p1/dismiss')[0]._body).toEqual({
      note: 'covered by the nightly rebuild'
    })
  })
})
