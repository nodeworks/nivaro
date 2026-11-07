// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryTable, type QueryTableConfig } from './QueryTable'

// Army 6 M12: the Budget & Spend Total-row "View Budget" opened every project
// although the search showed 9 of 47; the Total row now hands its action the
// rows it adds up. L13: the table must survive rows → none → rows without a
// hook-order crash, since it now stays mounted while its query refetches.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const rows = [
  { project_id: '201001', name: 'Test one', pub: 300 },
  { project_id: '201002', name: 'Other', pub: 100 },
  { project_id: '201003', name: 'Test two', pub: 50 }
]
const config: QueryTableConfig = {
  totals: true,
  search: true,
  columns: [
    { field: 'name', label: 'Name' },
    { field: 'pub', label: 'PUB', format: 'currency', sum: true, percent_of_total: true }
  ]
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function typeSearch(host: HTMLElement, text: string) {
  const input = host.querySelector<HTMLInputElement>('[data-qt-search]')!
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('QueryTable totals-row action', () => {
  it('passes the searched rows (what the total adds up) with a null row', () => {
    const onClick = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() =>
      root!.render(
        <QueryTable rows={rows} config={config} rowActions={[{ label: 'View Budget', onClick }]} />
      )
    )
    typeSearch(host, 'test')
    const btn = host.querySelector<HTMLButtonElement>('[data-qt-total-action="View Budget"]')!
    act(() => btn.click())
    expect(onClick).toHaveBeenCalledTimes(1)
    const [row, visible] = onClick.mock.calls[0]
    expect(row).toBeNull()
    expect((visible as typeof rows).map((r) => r.project_id)).toEqual(['201001', '201003'])
  })

  it('re-renders through rows → none → rows without losing its search', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(<QueryTable rows={rows} config={config} />))
    typeSearch(host, 'test')
    act(() => root!.render(<QueryTable rows={[]} config={config} />))
    expect(host.textContent).toContain('No data')
    act(() => root!.render(<QueryTable rows={rows} config={config} />))
    expect(host.querySelector<HTMLInputElement>('[data-qt-search]')!.value).toBe('test')
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2)
  })
})
