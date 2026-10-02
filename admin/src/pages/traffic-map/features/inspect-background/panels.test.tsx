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

import { toast } from 'sonner'
import { AiPanel } from './AiPanel'
import { FlowPanel } from './FlowPanel'
import { AiCallsFooter, BackgroundRunFooter, PartnerPushesFooter } from './footers'
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
  vi.mocked(toast.error).mockReset()
  vi.mocked(toast.success).mockReset()
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
    expect(toast.success).toHaveBeenCalledWith('Resent — now pending')
  })

  it('says so when the resend fails, and disarms', async () => {
    get.mockResolvedValue({ data: { data: submission } })
    post.mockRejectedValue({ response: { status: 502, data: { error: 'Partner unreachable' } } })
    render(wrap(<SubmissionPanel {...props('submission', '6499')} />))
    await screen.findByText('FDX24INV-31805')
    const btn = document.querySelector('[data-tm-inspect-submission-resend]') as HTMLButtonElement
    fireEvent.click(btn)
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Resend failed: Partner unreachable')
    expect(btn.getAttribute('data-tm-inspect-submission-resend')).toBe('idle')
    expect(btn.disabled).toBe(false)
  })

  it('re-reads eligibility before sending and refuses when a newer push landed meanwhile', async () => {
    get.mockResolvedValueOnce({ data: { data: submission } }).mockResolvedValueOnce({
      data: {
        data: {
          ...submission,
          retry: {
            eligible: false,
            reason: 'A newer push to this record (#6500) already landed.',
            warning: null
          }
        }
      }
    })
    render(wrap(<SubmissionPanel {...props('submission', '6499')} />))
    await screen.findByText('FDX24INV-31805')
    const btn = document.querySelector('[data-tm-inspect-submission-resend]') as HTMLButtonElement
    fireEvent.click(btn)
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[1][0]).toBe('/traffic-map/inspect/submission/6499')
    expect(post).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'Not resent: A newer push to this record (#6500) already landed.'
    )
    // The fresh answer replaces the shown one, so the button now reads as blocked.
    expect(await screen.findAllByText(/newer push to this record/)).toBeTruthy()
    expect(btn.disabled).toBe(true)
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

const RUN = '54b4cb84-ebda-420f-8185-eacd4fcd64db'
const FLOW = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

const flowRun = {
  id: RUN,
  flow: { id: FLOW, name: 'Notify buyers', active: true, trigger_type: 'event', description: null },
  trigger: 'event',
  status: 'error',
  started_at: '2026-10-01T10:01:00Z',
  completed_at: '2026-10-01T10:01:01Z',
  duration_ms: 1000,
  ops_run: 2,
  matched: true,
  halted_at: 'notify',
  error: 'notify: mail refused',
  user: null,
  input: { key: '••••••', po: 'PO1' },
  output: null,
  operations: [
    {
      key: 'check',
      name: 'Check',
      type: 'condition',
      next: 'notify',
      on_reject: null,
      halted: false,
      failed: false
    },
    {
      key: 'notify',
      name: 'Notify',
      type: 'mail',
      next: null,
      on_reject: null,
      halted: true,
      failed: true
    }
  ],
  trace: null,
  chain_id: null,
  chain_parent: 'cron:staged-imports',
  job: null,
  submissions: []
}

describe('FlowPanel', () => {
  it('dry-runs from the run id alone — the masked payload never goes back over the wire', async () => {
    get.mockResolvedValue({ data: { data: flowRun } })
    post.mockResolvedValue({
      data: {
        data: {
          steps: [
            { key: 'check', name: 'Check', type: 'condition', status: 'resolve' },
            {
              key: 'notify',
              name: 'Notify',
              type: 'mail',
              status: 'resolve',
              preview: { to: 'a@x' }
            }
          ],
          output: { po: 'PO1' },
          error: null,
          dry_run: true,
          payload_used: 'stored'
        }
      }
    })
    render(wrap(<FlowPanel {...props('flow', RUN)} />))
    expect(await screen.findByText('Notify buyers')).toBeTruthy()
    expect(screen.getByText(/the real values, not the masked view/)).toBeTruthy()
    expect(screen.queryByText(/go in masked/)).toBeNull()
    const btn = document.querySelector('[data-tm-inspect-flow-dry-run]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]).toEqual([`/traffic-map/inspect/flow-dry-run/${RUN}`])
    expect(JSON.stringify(post.mock.calls[0])).not.toMatch(/PO1|••••••|\/flows\//)
    expect(await screen.findByText(/Would send/)).toBeTruthy()
    expect(
      document
        .querySelector('[data-tm-inspect-flow-dry-run-result]')
        ?.getAttribute('data-tm-inspect-flow-dry-run-result')
    ).toBe('2')
  })

  it('shows what the dry run refused with', async () => {
    get.mockResolvedValue({ data: { data: flowRun } })
    post.mockRejectedValue({
      response: { status: 404, data: { error: 'No such flow run, or its flow was deleted' } }
    })
    render(wrap(<FlowPanel {...props('flow', RUN)} />))
    await screen.findByText('Notify buyers')
    await act(async () => {
      fireEvent.click(document.querySelector('[data-tm-inspect-flow-dry-run]') as HTMLElement)
    })
    expect(await screen.findByText(/The dry run could not start: No such flow run/)).toBeTruthy()
  })

  it('marks where the run halted and failed, and explains a 404', async () => {
    get.mockResolvedValue({ data: { data: flowRun } })
    render(wrap(<FlowPanel {...props('flow', RUN)} />))
    await screen.findByText('Notify buyers')
    const notify = document.querySelector('[data-tm-inspect-flow-op="notify"]') as HTMLElement
    expect(notify.textContent).toMatch(/failed/)
    expect(screen.getByText('notify: mail refused')).toBeTruthy()
    get.mockReset()
    get.mockRejectedValue({
      response: { status: 404, data: { error: 'x', code: 'INSPECT_NOT_FOUND' } }
    })
    render(wrap(<FlowPanel {...props('flow', FLOW)} />))
    expect(await screen.findByText(/No such flow run/)).toBeTruthy()
  })
})

describe('AiPanel', () => {
  it('shows the numbers, the prompt by message and the answer', async () => {
    get.mockResolvedValue({
      data: {
        data: {
          id: '354',
          created_at: '2026-10-01T10:00:00Z',
          request_id: 'abc12345-0000-4000-8000-000000000000',
          calls_in_request: 2,
          user: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Dana Reyes' },
          feature: 'traffic-map',
          route: '/api/traffic-map/explain',
          provider: 'anthropic',
          model: 'claude-4-5-haiku',
          status: 'ok',
          latency_ms: 1750,
          tokens: { input: 1200, output: 30, cache_read: null, cache_write: null },
          cost_usd: 0.0017,
          stop_reason: 'end_turn',
          tool_calls: 1,
          rounds: 2,
          request: {
            system: 'Be brief.',
            tools: ['lookup'],
            messages: [{ role: 'user', text: 'Why slow?' }]
          },
          request_raw: null,
          response_text: 'Because of the N+1.',
          error: null,
          kept_days: 30
        }
      }
    })
    render(wrap(<AiPanel {...props('ai', '354')} />))
    expect(await screen.findByText('claude-4-5-haiku')).toBeTruthy()
    expect(screen.getByText('1,200 / 30')).toBeTruthy()
    expect(screen.getByText('$0.0017')).toBeTruthy()
    expect(screen.getByText(/made 2 AI calls/)).toBeTruthy()
    expect(screen.getByText(/Tools offered: lookup/)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-body="ai-message-0"]')).toBeTruthy()
    expect(screen.getByText('Because of the N+1.')).toBeTruthy()
    expect(
      document.querySelector(
        '[data-tm-inspect-link="caller:uaaaaaaaa-0000-4000-8000-000000000001"]'
      )
    ).toBeTruthy()
  })

  it('explains a 404 by retention', async () => {
    get.mockRejectedValue({
      response: { status: 404, data: { error: 'x', code: 'INSPECT_NOT_FOUND' } }
    })
    render(wrap(<AiPanel {...props('ai', '5')} />))
    expect(await screen.findByText(/No AI call #5/)).toBeTruthy()
  })
})

describe('BackgroundRunFooter', () => {
  it('never resolves the run at "now": with no moment anywhere it says so and asks nothing', async () => {
    get.mockResolvedValue({ data: { data: { id: '77', chain_parent: 'cron:staged-imports' } } })
    render(wrap(<BackgroundRunFooter {...props('write', '77')} />))
    expect(await screen.findByText(/carries no time/)).toBeTruthy()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toBe('/traffic-map/inspect/write/77')
  })

  it('falls back to the moment the detail carries', async () => {
    get.mockImplementation(async (url: string) =>
      url.includes('/job-for')
        ? {
            data: {
              data: { kind: 'job', id: '9', covering: true, started_at: '2026-10-01T10:00:00Z' }
            }
          }
        : {
            data: {
              data: {
                id: '77',
                chain_parent: 'cron:staged-imports',
                timestamp: '2026-10-01T10:01:00Z'
              }
            }
          }
    )
    render(wrap(<BackgroundRunFooter {...props('write', '77')} />))
    expect(await screen.findByText('staged-imports · run #9')).toBeTruthy()
    const jobFor = get.mock.calls.find((c) => String(c[0]).includes('/job-for'))
    expect(jobFor?.[1]).toEqual({
      params: { source: 'cron:staged-imports', at: Date.parse('2026-10-01T10:01:00Z') }
    })
  })
})

describe('PartnerPushesFooter', () => {
  it('asks by node for extension-declared partners and shows why when none resolves', async () => {
    get.mockResolvedValue({
      data: { data: { rows: [], matched_by: null, reason: 'Not loaded here.' } }
    })
    render(wrap(<PartnerPushesFooter {...props('down', 'x:efp-ops.mdsi')} />))
    expect(await screen.findByText('Not loaded here.')).toBeTruthy()
    expect(get.mock.calls[0][1]).toEqual({ params: { node: 'x:efp-ops.mdsi', window: 300 } })
  })

  it('renders nothing for a down node that is not a partner', async () => {
    const { container } = render(wrap(<PartnerPushesFooter {...props('down', 'db')} />))
    await act(async () => {})
    expect(container.textContent).toBe('')
    expect(get).not.toHaveBeenCalled()
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
