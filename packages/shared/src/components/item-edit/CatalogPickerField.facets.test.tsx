// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type CatalogBuilderConfig, FacetBuilderCard } from './CatalogPickerField'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SOURCE_ROWS = [
  {
    item: 11,
    color: 'Yellow',
    connector_1: 'SC/A',
    connector_2: 'LC/A',
    sim_dup: 'SIM',
    length: '10M',
    length_value: 10,
    label: '10M · 1.2MM'
  },
  {
    item: 12,
    color: 'Yellow',
    connector_1: 'LC/A',
    connector_2: 'SC/A',
    sim_dup: 'SIM',
    length: '3M',
    length_value: 3,
    label: '3M · 1.2MM'
  },
  {
    item: 13,
    color: 'Yellow',
    connector_1: 'LC/A',
    connector_2: 'SC/A',
    sim_dup: 'DUP',
    length: '5M',
    length_value: 5,
    label: '5M · 1.2MM'
  },
  {
    item: 14,
    color: 'Red',
    connector_1: 'SC/A',
    connector_2: 'LC/U',
    sim_dup: 'DUP',
    length: '29M',
    length_value: 29,
    label: '29M · 1.6MM'
  }
]
const BUILDER: CatalogBuilderConfig = {
  label: 'Fiber Jumpers',
  source: '/efp/fiber-jumper-catalog',
  facets: [
    { key: 'color', label: 'Color' },
    { key: 'connector_1', label: 'Connector 1' },
    { key: 'connector_2', label: 'Connector 2' },
    { key: 'sim_dup', label: 'SIM vs DUP' }
  ],
  symmetric: ['connector_1', 'connector_2'],
  result: { key: 'label', label: 'Length', sort: 'length_value' }
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
})

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const click = (el: Element | null | undefined) =>
  act(() => {
    ;(el as HTMLElement).click()
  })
const buttonByText = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

async function pick(label: string, value: string) {
  const field = [...host.querySelectorAll('p')].find((p) => p.textContent === label)?.parentElement
  await click(field?.querySelector('button'))
  await click([...(field?.querySelectorAll('button') ?? [])].find((b) => b.textContent === value))
  await flush()
}

describe('FacetBuilderCard', () => {
  it('picks in either connector order list every length, sorted, and Add puts the item in the summary', async () => {
    const addQty = vi.fn(async () => {})
    const client = {
      request: vi.fn(async (cmd: { _path?: string; _params?: Record<string, unknown> }) => {
        const path = String(cmd._path ?? '')
        if (path.includes('fiber-jumper-catalog')) return { data: SOURCE_ROWS }
        const ids = JSON.parse(String(cmd._params?.filter ?? '{}'))?.id?._in ?? []
        return {
          data: ids.map((id: string) => ({ id: Number(id), description: `part ${id}`, price: 5 }))
        }
      })
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <FacetBuilderCard
              builder={BUILDER}
              catalogCol='cifa_items'
              catalogFields='id,description,price'
              tmpl='{{description}}'
              currentQty={() => 0}
              addQty={addQty}
              qtyStep={1}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await click(buttonByText('Fiber Jumpers'))
    await flush()
    expect(host.textContent).toContain(
      'Pick Color, Connector 1, Connector 2, SIM vs DUP to see the length'
    )

    await pick('Color', 'Yellow')
    // the tech picks LC/A first and SC/A second; parts are stored either way round
    await pick('Connector 1', 'LC/A')
    await pick('Connector 2', 'SC/A')
    await pick('SIM vs DUP', 'SIM')
    await flush()

    const rows = [...host.querySelectorAll('[data-facet-result]')].map((r) =>
      r.getAttribute('data-facet-result')
    )
    expect(rows).toEqual(['12', '11']) // 3M before 10M, both connector orders
    expect(host.textContent).toContain('3M · 1.2MM')

    await click(host.querySelector('[data-facet-result="11"]')?.querySelector('button'))
    await flush()
    expect(addQty).toHaveBeenCalledWith('11', 1, expect.objectContaining({ id: 11 }))
  })
})
