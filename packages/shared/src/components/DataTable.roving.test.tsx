// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { type Column, DataTable } from './DataTable'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Row = { id: string; name: string }
const columns: Column<Row>[] = [{ key: 'name', header: 'Name', render: (r) => r.name }]

function mount(rows: Row[], activeRowKey: string | null, onRowClick = vi.fn()) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <DataTable<Row>
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        total={rows.length}
        page={1}
        onPageChange={() => {}}
        onRowClick={onRowClick}
        onRowFocus={() => {}}
        activeRowKey={activeRowKey}
      />
    )
  )
  const tabbable = () =>
    [...host.querySelectorAll('tr[data-row-key]')]
      .filter((tr) => tr.getAttribute('tabindex') === '0')
      .map((tr) => tr.getAttribute('data-row-key'))
  const done = () => {
    act(() => root.unmount())
    host.remove()
  }
  return { host, tabbable, done }
}

// Army 11 N10 + rev11-ui #6: rows are ONE Tab stop, and a stale highlight never removes it.
describe('DataTable roving rows', () => {
  const rows = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' }
  ]
  it('the active row is the one tab stop', () => {
    const t = mount(rows, 'b')
    expect(t.tabbable()).toEqual(['b'])
    t.done()
  })
  it('falls back to the first row when the active one is not on screen', () => {
    const t = mount(rows, 'gone-after-page-change')
    expect(t.tabbable()).toEqual(['a'])
    t.done()
  })
  it('Enter on the focused row opens it; Enter inside it does not', () => {
    const open = vi.fn()
    const t = mount(rows, null, open)
    const tr = t.host.querySelector('tr[data-row-key="a"]') as HTMLElement
    act(() => {
      tr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(open).toHaveBeenCalledTimes(1)
    t.done()
  })
})
