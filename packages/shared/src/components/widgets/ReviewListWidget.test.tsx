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

async function mount(request: (cmd: { _path: string; _body?: unknown }) => Promise<unknown>) {
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
  return { client, onRefetch }
}

describe('ReviewListWidget action endpoint', () => {
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
