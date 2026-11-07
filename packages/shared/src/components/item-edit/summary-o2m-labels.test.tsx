// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { SummaryFieldValue } from './SummaryPanel'
import type { CMSField } from './types'

// R7 review: the related-label read of an O2M summary ("{{year}} {{po_line_type.type}}")
// filters on the parent link like the saved-rows read — never an id list of up to 200 ids
// in a GET URL.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

const rows = Array.from({ length: 150 }, (_, i) => ({
  id: 1000 + i,
  workflow: 7,
  year: 2026,
  po_line_type: 2
}))

function makeClient() {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/collections/forecasts')
        return { data: { display_template: '{{year}} {{po_line_type.type}}', relations: [] } }
      if (cmd._path === '/items/forecasts') {
        const fields = String(cmd._params?.fields ?? '')
        if (fields.includes('po_line_type.type'))
          return { data: rows.map((r) => ({ id: r.id, po_line_type: { type: 'Goods' } })) }
        return { data: rows }
      }
      return { data: [] }
    })
  }
  return { client, calls }
}

const field: CMSField = {
  field: 'forecasts',
  type: 'alias',
  interface: 'list-o2m',
  label: 'Forecasts',
  required: false,
  hidden: false,
  readonly: false,
  sort: 0,
  group_key: null,
  options: null,
  computed_formula: null,
  computed_type: null,
  note: null,
  placeholder: null,
  repeater_schema: null,
  dependency_config: null,
  layout_assigned: true
} as unknown as CMSField

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

describe('O2M summary related labels (R7 review)', () => {
  it('reads the related paths by the parent link, not by an id list', async () => {
    const { client, calls } = makeClient()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <SummaryFieldValue
              field={field}
              val={null}
              relations={[
                {
                  many_collection: 'forecasts',
                  many_field: 'workflow',
                  one_collection: 'workflows',
                  one_field: 'forecasts',
                  junction_field: null
                } as never
              ]}
              collection='workflows'
              itemId='7'
              staging={null}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const labelRead = () =>
      calls.find(
        (c) =>
          c._path === '/items/forecasts' &&
          String(c._params?.fields ?? '').includes('po_line_type.type')
      )
    await settle(() => !!labelRead() && (host.textContent ?? '').includes('2026 Goods'))
    const read = labelRead()
    expect(read).toBeTruthy()
    const filter = JSON.parse(String(read?._params?.filter))
    expect(filter).toEqual({ workflow: { _eq: '7' } })
    expect(String(read?._params?.filter)).not.toContain('_in')
    expect(host.textContent).toContain('2026 Goods')
    qc.clear()
  })
})
