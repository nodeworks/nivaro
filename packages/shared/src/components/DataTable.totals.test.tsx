// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { type Column, DataTable, type DataTableProps } from './DataTable'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Queue totals row (2026-11-14): the table's footer row stays at the bottom of the scrolling
// rows, one figure per column with a total on, "Σ totals" in the first empty cell.

type Row = Record<string, unknown>

function mount(props: Partial<DataTableProps<Row>> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const columns: Column<Row>[] = [
    { key: 'label', header: 'Item' },
    { key: 'extra.amount', header: 'Amount', headerMenu: <button type='button'>menu</button> },
    { key: 'extra.qty', header: 'Qty' }
  ]
  act(() =>
    root.render(
      <DataTable<Row>
        columns={columns}
        rows={[{ label: 'A', 'extra.amount': 5, 'extra.qty': 1 }]}
        total={1}
        page={1}
        onPageChange={() => {}}
        fillHeight
        columnPins={{}}
        totalsRow={{
          cells: { 'extra.amount': <span>Sum 1,300</span> },
          label: <span>Σ totals</span>
        }}
        {...props}
      />
    )
  )
  const done = () => {
    act(() => root.unmount())
    host.remove()
  }
  return { host, done }
}

describe('DataTable totals row', () => {
  it('renders a sticky footer with the figures and the label', () => {
    const { host, done } = mount()
    const foot = host.querySelector('tfoot[data-dt-totals]')
    expect(foot).not.toBeNull()
    const cells = [...(foot?.querySelectorAll('td') ?? [])]
    expect(cells.map((c) => c.textContent)).toEqual(['Σ totals', 'Sum 1,300', ''])
    expect(
      cells.every((c) => c.className.includes('sticky') && c.className.includes('bottom-0'))
    ).toBe(true)
    expect(cells[1].getAttribute('data-dt-total-cell')).toBe('extra.amount')
    // Light + dark surfaces.
    expect(cells[1].className).toMatch(/bg-slate-50/)
    expect(cells[1].className).toMatch(/dark:bg-muted/)
    done()
  })

  it('renders a column’s header menu in its header cell', () => {
    const { host, done } = mount()
    const th = [...host.querySelectorAll('th')].find((t) => t.textContent?.includes('Amount'))
    expect(th?.textContent).toContain('menu')
    expect(th?.className).toMatch(/group\/hcell/)
    done()
  })

  it('has no footer without rows, without a totals row, or while grouped', () => {
    for (const props of [
      { rows: [] },
      { totalsRow: undefined },
      { rowGroups: [{ key: 'g', header: 'G', rows: [{ label: 'A' }] }] }
    ]) {
      const { host, done } = mount(props)
      expect(host.querySelector('tfoot')).toBeNull()
      done()
    }
  })
})
