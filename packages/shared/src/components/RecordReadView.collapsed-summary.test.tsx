// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import {
  COLLAPSED_SUMMARY_MAX,
  collapsedSummaryEntries,
  type ReadViewLayout,
  RecordReadView
} from './RecordReadView'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #3195: a collapsed section's heading shows two or three chosen values in the summary view.

const FIELDS = [
  { field: 'id', type: 'integer', label: 'ID' },
  { field: 'title', type: 'string', label: 'Title' },
  { field: 'vendor', type: 'string', label: 'Vendor' },
  { field: 'amount', type: 'integer', label: 'Amount' },
  { field: 'blank', type: 'string', label: 'Blank' },
  { field: 'note', type: 'string', label: 'Note' },
  { field: 'other', type: 'string', label: 'Other' }
]

const assign = (field: string, group_key: string, sort: number) => ({
  field,
  group_key,
  sort,
  label_override: null,
  is_visible: true
})

function layout(groupExtra: Record<string, unknown>): ReadViewLayout {
  return {
    layout: { id: 7, name: 'Order', header_fields: [], hide_empty: false },
    groups: [
      { key: 'main', label: 'Main', type: 'section', sort: 1 },
      {
        key: 'money',
        label: 'Money',
        type: 'section',
        sort: 2,
        is_collapsed: true,
        ...groupExtra
      }
    ],
    assignments: [
      assign('title', 'main', 1),
      assign('vendor', 'money', 1),
      assign('amount', 'money', 2),
      assign('blank', 'money', 3),
      assign('note', 'money', 4),
      assign('other', 'money', 5)
    ]
  } as unknown as ReadViewLayout
}

function client() {
  return {
    request: vi.fn(async (cmd: { _path?: string }) => {
      if (cmd._path === '/collections/orders') return { data: { fields: FIELDS, relations: [] } }
      if (cmd._path === '/field-config/orders') return { data: FIELDS }
      if (cmd._path === '/items/orders/5')
        return {
          data: {
            id: 5,
            title: 'Pump',
            vendor: 'Acme',
            amount: 42,
            blank: null,
            note: 'n',
            other: 'o'
          }
        }
      return { data: null }
    })
  } as unknown as NivaroClient
}

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
  document.body.innerHTML = ''
})

async function mount(l: ReadViewLayout) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client()}>
          <RecordReadView collection='orders' itemId='5' layoutData={l} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  for (let i = 0; i < 8; i++) await act(async () => new Promise((r) => setTimeout(r, 10)))
}

const summary = () => host.querySelector('[data-read-collapsed-summary="money"]')

describe('collapsedSummaryEntries', () => {
  it('reads JSON text, names and {field, label} entries; drops slots', () => {
    expect(
      collapsedSummaryEntries('["a",{"field":"b","label":" Total "},{"x":1},"__owners__"]')
    ).toEqual([
      { field: 'a', label: null },
      { field: 'b', label: 'Total' }
    ])
    expect(collapsedSummaryEntries(['a'])).toEqual([{ field: 'a', label: null }])
    expect(collapsedSummaryEntries('a, b')).toEqual([
      { field: 'a', label: null },
      { field: 'b', label: null }
    ])
    expect(collapsedSummaryEntries(null)).toEqual([])
  })
})

describe('RecordReadView collapsed summary (#3195)', () => {
  it('shows the chosen values in the closed heading, at most three, and hides them when open', async () => {
    await mount(
      layout({
        summary_fields: JSON.stringify([
          'vendor',
          { field: 'amount', label: 'Total' },
          'blank',
          'note',
          'other'
        ])
      })
    )
    const s = summary()
    expect(s).not.toBeNull()
    expect(s?.textContent).toContain('Vendor')
    expect(s?.textContent).toContain('Acme')
    expect(s?.textContent).toContain('Total')
    expect(s?.textContent).toContain('42')
    expect(s?.querySelectorAll(':scope > span').length).toBe(COLLAPSED_SUMMARY_MAX)
    expect(s?.textContent).not.toContain('Note')
    const toggle = host.querySelector('[data-read-section="money"] h3 button') as HTMLElement
    await act(async () => toggle.click())
    expect(summary()).toBeNull()
  })

  it('leaves out empty values when the section says so', async () => {
    await mount(layout({ summary_fields: ['blank', 'vendor'], summary_hide_empty: true }))
    expect(summary()?.textContent).not.toContain('Blank')
    expect(summary()?.textContent).toContain('Acme')
  })

  it('a section that is not collapsible, or picks nothing, shows no summary', async () => {
    await mount(layout({ is_collapsed: false, summary_fields: ['vendor'] }))
    expect(summary()).toBeNull()
  })
})
