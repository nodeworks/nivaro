// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type ReviewListConfig, type ReviewListResult, ReviewListWidget } from './ReviewListWidget'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const config: ReviewListConfig = {
  host_collection: 'workflows',
  collection: 'items',
  path: [],
  group_by: 'group_key',
  status: {
    field: 'review_status',
    options: [{ value: 'approved', label: 'Approve', color: 'green' }],
    action_endpoint: '/ext/decide'
  }
} as ReviewListConfig

const data: ReviewListResult = {
  rows: [
    { id: 1, group: 'A', values: {}, status: null, stamp_user: null, stamp_date: null },
    { id: 2, group: 'A', values: {}, status: 'under_review', stamp_user: null, stamp_date: null }
  ],
  columns: { group_meta: [], line_columns: [] },
  truncated: false
}

async function mount(
  request: (cmd: { _path: string; _body?: unknown }) => Promise<unknown>,
  confirm = true
) {
  const onRefetch = vi.fn()
  const client = { request: vi.fn(request) }
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NivaroProvider client={client as never}>
          <ReviewListWidget data={data} config={config} onRefetch={onRefetch} hostRecordId={7} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  const approve = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!
  await act(async () => {
    approve.click()
    await new Promise((r) => setTimeout(r, 0))
  })
  if (confirm) {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-review-confirm-submit]')!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
  }
  return { client, onRefetch }
}

describe('ReviewListWidget action endpoint', () => {
  it('sends nothing until the decision is confirmed; Cancel sends nothing', async () => {
    const { client } = await mount(async () => ({ data: { updated: 2 } }), false)
    const dialog = host.querySelector('[data-review-confirm="approved"]')
    expect(dialog?.textContent).toContain('Approve A?')
    expect(dialog?.textContent).toContain('2 rows')
    expect(client.request.mock.calls.some((c) => c[0]._path === '/ext/decide')).toBe(false)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-review-confirm-cancel]')!.click()
    })
    expect(host.querySelector('[data-review-confirm]')).toBeNull()
    expect(client.request.mock.calls.some((c) => c[0]._path === '/ext/decide')).toBe(false)
  })

  it('sends the status each row showed with the decision', async () => {
    const { client } = await mount(async () => ({ data: { updated: 2 } }))
    const call = client.request.mock.calls.find((c) => c[0]._path === '/ext/decide')!
    expect(call[0]._body).toMatchObject({
      ids: [1, 2],
      status: 'approved',
      workflow_id: 7,
      expected: { 1: null, 2: 'under_review' }
    })
  })

  it('a refusal (409: rows changed since) shows the reason and re-reads the rows', async () => {
    const { onRefetch } = await mount(async () => {
      throw Object.assign(new Error('Conflict'), {
        response: { error: 'Changed since you opened it — it is Approved.' }
      })
    })
    expect(host.textContent).toContain('Changed since you opened it — it is Approved.')
    expect(onRefetch).toHaveBeenCalledTimes(1)
  })
})

// Army 6 H16 / L35 / M33: the record-page invoice confirm read "Approve
// 300000974579815-201943-46314? 25 rows" — the Fusion composite id, no
// invoice number, vendor or what happens next; the badge said "Reject".
describe('ReviewListWidget names the group, not its raw key', () => {
  const invoiceConfig = {
    host_collection: 'workflows',
    collection: 'invoices',
    path: [],
    group_by: 'invoice_id',
    aggregate_sum: 'amount',
    aggregate_sum_format: 'currency',
    group_noun: 'invoice',
    row_noun: 'line',
    group_meta: [
      { field: 'number', label: 'Invoice', role: 'title', prefix: '#' },
      { field: 'vendor.name', label: 'Vendor', role: 'subtitle' }
    ],
    status: {
      field: 'efp_review_status',
      options: [
        {
          value: 'approved',
          label: 'Approve',
          status_label: 'Approved',
          color: 'green',
          confirm_notice: 'The PO requestor is told. An approval is final: it can’t be taken back.'
        },
        { value: 'rejected', label: 'Reject', status_label: 'Rejected', color: 'red' }
      ],
      action_endpoint: '/ext/decide'
    },
    enrich_endpoint: '/ext/enrich'
  } as ReviewListConfig

  const row = (id: number, status: string | null) => ({
    id,
    group: '300000974579815-201943-46314',
    values: {
      amount: 100,
      number: 'INV-PPC-000378',
      'vendor.name': 'PINNACLE POWER CORPORATION',
      create_date: '2026-11-04T00:00:00.000Z'
    },
    status,
    stamp_user: null,
    stamp_date: null
  })
  const invoiceData = (status: string | null): ReviewListResult => ({
    rows: [row(1, status), row(2, status)],
    columns: {
      group_meta: [
        { field: 'number', label: 'Invoice', role: 'title', prefix: '#' },
        { field: 'vendor.name', label: 'Vendor', role: 'subtitle' }
      ],
      line_columns: [{ field: 'create_date', label: 'Invoice date', format: 'date' }]
    },
    truncated: false
  })

  async function render(
    status: string | null,
    enrich: Record<string, unknown> = { 1: { can_act: true }, 2: { can_act: true } }
  ) {
    const client = {
      request: vi.fn(async (cmd: { _path: string }) =>
        cmd._path === '/ext/enrich' ? { data: { rows: enrich } } : { data: { updated: 2 } }
      )
    }
    await act(async () => {
      root.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <NivaroProvider client={client as never}>
            <ReviewListWidget
              data={invoiceData(status)}
              config={invoiceConfig}
              onRefetch={vi.fn()}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    // the enrich read resolves on a later tick
    for (let i = 0; i < 3; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
    return client
  }

  it('header and confirm lead with the invoice number and vendor; no Fusion id', async () => {
    await render(null)
    const title = host.querySelector('[data-review-group-title]')
    expect(title?.textContent).toBe('#INV-PPC-000378')
    expect(host.textContent).toContain('PINNACLE POWER CORPORATION')
    expect(host.textContent).toContain('2 lines')
    expect(host.textContent).not.toContain('300000974579815')
    const approve = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!
    await act(async () => {
      approve.click()
    })
    const dialog = host.querySelector('[data-review-confirm="approved"]')!
    expect(dialog.textContent).toContain(
      'Approve invoice #INV-PPC-000378 · PINNACLE POWER CORPORATION?'
    )
    expect(dialog.textContent).toContain('2 lines · $200.00')
    expect(host.querySelector('[data-review-confirm-notice]')?.textContent).toContain(
      'An approval is final'
    )
    expect(dialog.textContent).not.toContain('300000974579815')
  })

  it('the badge shows the state, not the button verb', async () => {
    await render('rejected')
    const badges = [...host.querySelectorAll('span')].map((s) => s.textContent)
    expect(badges).toContain('Rejected')
  })

  it('a row the server says is final shows View only with the reason', async () => {
    await render('approved', {
      1: { can_act: false, reason: 'An approval is final.' },
      2: { can_act: false, reason: 'An approval is final.' }
    })
    const viewOnly = host.querySelector('[data-review-view-only]')
    expect(viewOnly?.getAttribute('title')).toBe('An approval is final.')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Reject')).toBe(false)
  })

  it('a rejected invoice shows the reason the decision carried (army 8 b07-N14)', async () => {
    await render('rejected', {
      1: { can_act: false, note: 'Work not completed.' },
      2: { can_act: false, note: 'Work not completed.' }
    })
    const note = host.querySelector('[data-review-decision-note]')
    expect(note?.textContent).toBe('Reason: Work not completed.')
    // one line per group, not per row
    expect(host.querySelectorAll('[data-review-decision-note]')).toHaveLength(1)
  })

  // army 9 b07-B: approving a rejected invoice from the record page said nothing about
  // the rejection it replaces, nor who is told.
  it('the confirm uses the row’s own words for the decision when the endpoint sends them', async () => {
    const words =
      'Perry Callis rejected this invoice on Nov 3 (“Work not completed.”). Approving replaces that decision: The PO requestor (Andrew Davis), who was told it was rejected, is now told it is approved.'
    await render('rejected', {
      1: { can_act: true, confirm_notices: { approved: words } },
      2: { can_act: true, confirm_notices: { approved: words } }
    })
    const approve = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!
    await act(async () => {
      approve.click()
    })
    expect(host.querySelector('[data-review-confirm-notice]')?.textContent).toBe(words)
  })

  it('no reason line when the enrich endpoint carries none', async () => {
    await render('rejected')
    expect(host.querySelector('[data-review-decision-note]')).toBeNull()
  })

  it('browser Back closes the confirm instead of leaving the page (army 8 b07-N5)', async () => {
    await render(null)
    const approve = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve')!
    await act(async () => {
      approve.click()
    })
    expect(host.querySelector('[data-review-confirm="approved"]')).not.toBeNull()
    // opening pushed a marked history entry; Back pops it and closes the confirm
    expect((window.history.state as { nvrDialog?: string })?.nvrDialog).toMatch(/^nvr-dialog-/)
    await act(async () => {
      window.history.back()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(host.querySelector('[data-review-confirm="approved"]')).toBeNull()
  })

  it('a calendar date shows its own day (2026-11-04 → Nov 4, 2026)', async () => {
    await render(null)
    expect(host.textContent).toContain('Nov 4, 2026')
    expect(host.textContent).not.toContain('Nov 3, 2026')
  })
})
