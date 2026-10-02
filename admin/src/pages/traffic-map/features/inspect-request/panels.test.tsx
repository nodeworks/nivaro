import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { CapturePanel } from './CapturePanel'
import { RequestPanel } from './RequestPanel'
import { StatementPanel } from './StatementPanel'
import { TracePanel } from './TracePanel'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }))

const RID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const get = vi.mocked(api.get)

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

const props = (kind: string, id: string) => ({
  inspectRef: { kind, id },
  open: vi.fn(),
  anchor: null,
  windowSec: 300
})

afterEach(() => get.mockReset())

const row = {
  id: 9,
  request_id: RID,
  method: 'PATCH',
  path: '/api/items/workflows/5',
  query: 'fields=id&token=••••••',
  status: 422,
  latency_ms: 140,
  created_at: '2026-10-01T10:00:00.000Z',
  auth: 'session',
  ip: '127.0.0.1',
  user_agent: 'Chrome',
  error: '{"error":"Field X is required"}',
  request_body: null,
  body_source: null,
  body_note: null,
  graphql: null,
  instance: 'development',
  chain_id: 'f97a98a1-cdca-45fe-8f6b-5024c6cebc84',
  chain_parent: null,
  user: 'U1',
  api_key_id: null,
  caller: { key: 'uU1', label: 'Robert Lee', kind: 'user' },
  route: 'PATCH /api/items/workflows/:id',
  entity: 'items/workflows',
  record: 'workflows:5'
}

describe('RequestPanel', () => {
  it('shows the call, honest gaps and the links it drills into', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          rid: RID,
          node: 'abcd1234',
          instance: 'development',
          pending: false,
          missing: null,
          matched_by: 'request_id',
          row,
          trace: {
            kept: false,
            code: 'fast',
            reason: 'Not kept — requests under 1000 ms are not traced.'
          },
          neighbours: [
            {
              request_id: '11111111-1111-4111-8111-111111111111',
              method: 'GET',
              path: '/api/items/workflows/5',
              status: 200,
              latency_ms: 30,
              created_at: '2026-10-01T10:00:01.000Z',
              route: 'GET /api/items/workflows/:id'
            }
          ],
          captured: null
        }
      }
    })
    render(wrap(<RequestPanel {...props('request', RID)} />))
    await screen.findByText('PATCH /api/items/workflows/5')
    expect(screen.getByText(/requests under 1000 ms are not traced/)).toBeTruthy()
    expect(screen.getByText(/Body not captured/)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="record:workflows:5"]')).not.toBeNull()
    expect(document.querySelector('[data-tm-inspect-link="caller:uU1"]')).not.toBeNull()
    expect(
      document.querySelector('[data-tm-inspect-link="chain:f97a98a1-cdca-45fe-8f6b-5024c6cebc84"]')
    ).not.toBeNull()
    expect(
      document.querySelector(
        '[data-tm-inspect-link="request:11111111-1111-4111-8111-111111111111"]'
      )
    ).not.toBeNull()
    expect(document.querySelector('[data-tm-inspect-trace-next-start]')).not.toBeNull()
    expect(screen.getByText('token')).toBeTruthy()
  })

  it('waits for the log while the request is pending', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          rid: RID,
          node: 'n',
          instance: 'development',
          pending: true,
          missing: null,
          matched_by: null,
          row: null,
          trace: { kept: false, code: 'unknown', reason: 'x' },
          neighbours: [],
          captured: null
        }
      }
    })
    render(wrap(<RequestPanel {...props('request', RID)} />))
    await screen.findByText(/Waiting for the API log/)
  })
})

describe('TracePanel', () => {
  it('draws the waterfall and links each statement', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          rid: RID,
          node: 'n1',
          instance: 'development',
          config: { slow_ms: 1000, capacity: 200, buffered: 3 },
          kept: true,
          trace: {
            id: RID,
            method: 'GET',
            route: '/api/items/:collection',
            url: '/api/items/workflows',
            status: 200,
            user: null,
            total_ms: 1200,
            spans: [
              { seq: 0, phase: 'auth', ms: 20, at: 0 },
              {
                seq: 1,
                phase: 'items:read',
                ms: 900,
                at: 30,
                queries: 12,
                repeat: { sql: 'select 1', n: 10, ms: 400 }
              }
            ],
            ts: '2026-10-01T10:00:00.000Z',
            queries: 14,
            sql_ms: 800,
            top_sql: [
              {
                sql: 'select 1',
                bindings: [],
                ms: 400,
                n: 10,
                index: 0,
                sha: 'a'.repeat(40),
                select: true,
                truncated: false
              }
            ],
            wide: [],
            unaccounted_ms: 280
          }
        }
      }
    })
    render(wrap(<TracePanel {...props('trace', RID)} />))
    await screen.findByText('unaccounted 280 ms')
    expect(document.querySelectorAll('[data-tm-inspect-span]').length).toBe(2)
    expect(
      document.querySelector(`[data-tm-inspect-link="statement:${'a'.repeat(40)}"]`)
    ).not.toBeNull()
    expect(screen.getAllByText(/N\+1/).length).toBeGreaterThan(0)
  })
})

describe('missing levels say why', () => {
  it('statement not seen', async () => {
    get.mockRejectedValue({
      response: { status: 404, data: { code: 'INSPECT_NOT_FOUND', error: 'x' } }
    })
    render(wrap(<StatementPanel {...props('statement', 'b'.repeat(40))} />))
    await screen.findByText(/Not seen in a kept trace on this API process/)
  })
  it('capture ended', async () => {
    get.mockRejectedValue({
      response: { status: 404, data: { code: 'INSPECT_NOT_FOUND', error: 'x' } }
    })
    render(wrap(<CapturePanel {...props('capture', RID)} />))
    await waitFor(() => expect(screen.getByText(/This capture has ended/)).toBeTruthy())
  })
})
