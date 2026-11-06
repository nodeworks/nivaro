// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { QueryTable, type QueryTableConfig, queryTableCsv, sortCompare } from './QueryTable'

// Army 2026-11-05 a04-4 / a12-7: the Budget Performance table (190 rows) had
// no sort, search or export, and 132 rows with nothing in them. All four are
// table options, off unless a page turns them on.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const rows = [
  { project: 'Beta', pub: 300, spend: 10 },
  { project: 'Alpha', pub: null, spend: 0 },
  { project: 'Gamma', pub: 100, spend: 5 }
]
const columns: QueryTableConfig['columns'] = [
  { field: 'project', label: 'Project' },
  { field: 'pub', label: 'PUB', format: 'currency' },
  { field: 'spend', label: 'Spend', format: 'currency' }
]

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function mount(config: QueryTableConfig) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<QueryTable rows={rows} config={config} />))
  return host
}
const firstCol = (host: HTMLElement) =>
  [...host.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')?.textContent)

describe('QueryTable view tools', () => {
  it('none of them shows unless configured', () => {
    const host = mount({ columns })
    expect(host.querySelector('[data-qt-sort]')).toBeNull()
    expect(host.querySelector('[data-qt-search]')).toBeNull()
    expect(host.querySelector('[data-qt-csv]')).toBeNull()
    expect(host.querySelector('[data-qt-hide-empty]')).toBeNull()
  })

  it('sorts on header clicks: ascending, descending, back to data order; blanks last', () => {
    const host = mount({ columns, sortable: true })
    const pub = () => host.querySelector<HTMLButtonElement>('[data-qt-sort="pub"]')!
    act(() => pub().click())
    expect(firstCol(host)).toEqual(['Gamma', 'Beta', 'Alpha'])
    act(() => pub().click())
    expect(firstCol(host)).toEqual(['Beta', 'Gamma', 'Alpha'])
    act(() => pub().click())
    expect(firstCol(host)).toEqual(['Beta', 'Alpha', 'Gamma'])
  })

  it('search keeps matching rows and says how many', () => {
    const host = mount({ columns, search: true })
    const input = host.querySelector<HTMLInputElement>('[data-qt-search]')!
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'amm')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(firstCol(host)).toEqual(['Gamma'])
    expect(host.querySelector('[data-qt-shown]')?.textContent).toBe('1 of 3 rows')
  })

  it('hide empty rows hides rows whose fields are all blank or 0', () => {
    const host = mount({ columns, hide_empty: { fields: ['pub', 'spend'], default_on: true } })
    expect(firstCol(host)).toEqual(['Beta', 'Gamma'])
    act(() => host.querySelector<HTMLButtonElement>('[data-qt-hide-empty]')!.click())
    expect(firstCol(host)).toEqual(['Beta', 'Alpha', 'Gamma'])
  })
})

describe('queryTableCsv / sortCompare', () => {
  it('writes raw values with quoting and formula-safe text', () => {
    const csv = queryTableCsv(
      [{ field: 'a', label: 'A, "x"' }, { field: 'b' }],
      [
        { a: '=SUM(1)', b: -5 },
        { a: 'line\nbreak', b: null }
      ],
      (r, c) => r[c.field as string],
      (c) => c.label ?? c.field ?? ''
    )
    expect(csv).toBe('"A, ""x""",b\r\n\'=SUM(1),-5\r\n"line\nbreak",\r\n')
  })

  it('compares numbers, text naturally, blanks last both ways', () => {
    expect(sortCompare(2, 10)).toBeLessThan(0)
    expect(sortCompare('Item 2', 'Item 10')).toBeLessThan(0)
    expect(sortCompare(null, 1, -1)).toBe(1)
    expect(sortCompare(1, '', 1)).toBe(-1)
  })
})
