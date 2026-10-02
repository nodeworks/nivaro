import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()
const post = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) }
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

import { AiCallsFooter } from './footers'
import { JobPanel } from './JobPanel'
import { SubmissionPanel } from './SubmissionPanel'

function wrap(ui: ReactNode) {
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

afterEach(() => {
  get.mockReset()
  post.mockReset()
})

const submission = {
  id: '6499',
  collection: 'inventory_request',
  item: '32197',
  record_label: 'FDX24INV-31805',
  status: 'failed',
  error_class: 'transient',
  last_error: 'HTTP 503',
  external_ref: null,
  attempts_count: 2,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:05:00Z',
  endpoint_path: '/orders',
  payload: { api_key: '••••••', po: 'PO1' },
  response: null,
  chain_id: null,
  chain_parent: null,
  requested_by: null,
  requested_via: 'retry',
  partner: { id: 2, name: 'MDSi', owner: null },
  endpoint: { method: 'POST', path: '/orders' },
  obligation: null,
  trigger: { kind: 'cron', label: 'A scheduled job', link: null, source: 'call-log' },
  triggered_by: {
    kind: 'scheduled',
    basis: 'inferred',
    label: 'The scheduler',
    user: null,
    via: 'cron',
    how: 'call log'
  },
  attempt_requesters: [],
  call_logs: [],
  retry: { eligible: true, reason: null, warning: null },
  attempts: {
    attempts: [
      {
        attempt: 2,
        status: 'failed',
        http_status: 503,
        error: 'HTTP 503',
        source: 'current',
        at: '2026-10-01T10:05:00Z',
        endpoint_path: '/orders',
        payload: null,
        response: null,
        masked: false
      }
    ],
    total: 2,
    unrecorded: 1
  },
  attempts_reason: null
}

describe('SubmissionPanel', () => {
  it('shows the push, says what is masked and what is missing, and resends on the second click', async () => {
    get.mockResolvedValue({ data: { data: submission } })
    post.mockResolvedValue({ data: { data: { status: 'pending' } } })
    render(wrap(<SubmissionPanel {...props('submission', '6499')} />))
    expect(await screen.findByText('FDX24INV-31805')).toBeTruthy()
    expect(screen.getByText(/masked here/)).toBeTruthy()
    expect(screen.getByText(/1 earlier attempt left/)).toBeTruthy()
    const btn = document.querySelector('[data-tm-inspect-submission-resend]') as HTMLButtonElement
    expect(btn.getAttribute('data-tm-inspect-submission-resend')).toBe('idle')
    fireEvent.click(btn)
    expect(post).not.toHaveBeenCalled()
    expect(btn.getAttribute('data-tm-inspect-submission-resend')).toBe('armed')
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(post).toHaveBeenCalledWith('/erp-submissions/6499/retry')
  })

  it('disables Resend with the reason when the push cannot be resent', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          ...submission,
          status: 'accepted',
          retry: {
            eligible: false,
            reason: 'The partner already accepted this push.',
            warning: null
          }
        }
      }
    })
    render(wrap(<SubmissionPanel {...props('submission', '6499')} />))
    expect(await screen.findAllByText('The partner already accepted this push.')).toBeTruthy()
    const btn = document.querySelector('[data-tm-inspect-submission-resend]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('explains a 404', async () => {
    get.mockRejectedValue({
      response: { status: 404, data: { error: 'x', code: 'INSPECT_NOT_FOUND' } }
    })
    render(wrap(<SubmissionPanel {...props('submission', '1')} />))
    expect(await screen.findByText(/No partner push #1/)).toBeTruthy()
  })
})

describe('JobPanel', () => {
  it('lists the writes a run made and says why when none can be attributed', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          id: '9',
          kind: 'remediation',
          job_id: 'fix-things',
          label: null,
          extension_id: null,
          description: null,
          registry: null,
          registered: null,
          status: 'interrupted',
          trigger_kind: null,
          triggered_by: null,
          instance: null,
          instance_id: null,
          this_node: false,
          lease_holder: null,
          ticks_enabled: null,
          started_at: '2026-10-01T10:00:00Z',
          finished_at: null,
          duration_ms: null,
          progress: null,
          outcome: null,
          error: null,
          chain_id: null,
          writes: { rows: [], total: 0, via: null },
          flows: [],
          submissions: []
        }
      }
    })
    render(wrap(<JobPanel {...props('job', '9')} />))
    expect(await screen.findByText('fix-things')).toBeTruthy()
    expect(screen.getByText(/restart or deploy/)).toBeTruthy()
    expect(screen.getByText(/cannot be attributed/)).toBeTruthy()
  })
})

describe('AiCallsFooter', () => {
  it('renders nothing when the request made no AI call', async () => {
    get.mockResolvedValue({ data: { data: { calls: [], kept_days: 30 } } })
    const { container } = render(wrap(<AiCallsFooter {...props('request', 'abc12345')} />))
    await act(async () => {})
    expect(container.textContent).toBe('')
  })

  it('lists the calls a request made', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          calls: [
            {
              id: '354',
              created_at: '2026-10-01T10:00:00Z',
              feature: 'traffic-map',
              model: 'claude-4-5-haiku',
              status: 'ok',
              latency_ms: 1750,
              input_tokens: 1,
              output_tokens: 1,
              cost_usd: 0.0017,
              tool_calls: 1
            }
          ],
          kept_days: 30
        }
      }
    })
    render(wrap(<AiCallsFooter {...props('request', 'abc12345')} />))
    expect(await screen.findByText('AI calls (1)')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="ai:354"]')).toBeTruthy()
  })
})
