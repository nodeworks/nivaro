// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { QueryStatStrip, type QueryWidgetStat } from './QueryStatStrip'
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

const asOf: QueryWidgetStat = {
  label: 'Fusion figures as of',
  query: { slug: 'fusion-import-latest', value_field: 'finished_at' },
  format: 'date',
  empty_label: 'never imported',
  requires_field: 'fusion_synced_at',
  requires_label: 'no Fusion data for this selection'
}

async function mount(rows: Array<Record<string, unknown>>) {
  const client = {
    request: vi.fn(async () => ({ data: [{ finished_at: '2026-10-23T12:00:00Z' }] }))
  }
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NivaroProvider client={client as never}>
          <QueryStatStrip stats={[asOf]} rows={rows} effectiveParams={{}} loading={false} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return host.querySelector('[data-stat-tile="Fusion figures as of"]')?.textContent ?? ''
}

describe('QueryStatStrip requires_field', () => {
  it('says there is no data instead of an import date when no row carries the field', async () => {
    const text = await mount([{ project_id: '1', fusion_synced_at: null }])
    expect(text).toContain('no Fusion data for this selection')
    expect(text).not.toMatch(/2026/)
  })

  it('shows the value once any row carries the field', async () => {
    const text = await mount([{ project_id: '1', fusion_synced_at: '2026-10-23T08:00:00Z' }])
    expect(text).not.toContain('no Fusion data')
    expect(text).toMatch(/2026/)
  })
})
