// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ariaSortFor, type Column, containsFilter, DataTable } from './DataTable'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mount(columns: Column[], sort: string, onSortChange: (s: string) => void) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <DataTable
        columns={columns}
        rows={[{ amount: 1, note: 'a', name: 'x' }]}
        total={1}
        page={1}
        sort={sort}
        onSortChange={onSortChange}
        onPageChange={() => {}}
      />
    )
  )
  const headers = [...host.querySelectorAll('th')] as HTMLTableCellElement[]
  const head = (text: string) => headers.find((th) => th.textContent?.trim() === text) ?? null
  const done = () => {
    act(() => root.unmount())
    host.remove()
  }
  return { host, head, done }
}

// Army 9 b08 N-R9-6: queue headers sorted by mouse only and never said their order.
describe('DataTable sortable headers', () => {
  it('aria-sort follows the sort string', () => {
    expect(ariaSortFor('', 'amount')).toBe('none')
    expect(ariaSortFor('amount', 'amount')).toBe('ascending')
    expect(ariaSortFor('-amount', 'amount')).toBe('descending')
    expect(ariaSortFor('-name', 'amount')).toBe('none')
  })

  it('a text header is a button that sorts; the column header carries aria-sort', () => {
    const onSortChange = vi.fn()
    const t = mount(
      [
        { key: 'amount', header: 'REQ $', sortable: true },
        { key: 'note', header: 'Note' }
      ],
      '-amount',
      onSortChange
    )
    const th = t.head('REQ $')
    expect(th?.getAttribute('aria-sort')).toBe('descending')
    const button = th?.querySelector('button[data-dt-sort]') as HTMLButtonElement
    expect(button).toBeTruthy()
    act(() => button.click())
    expect(onSortChange).toHaveBeenCalledTimes(1)
    expect(onSortChange).toHaveBeenCalledWith('')
    // Not sortable: no button, no aria-sort.
    const note = t.head('Note')
    expect(note?.querySelector('button')).toBeNull()
    expect(note?.hasAttribute('aria-sort')).toBe(false)
    t.done()
  })

  it('a non-text header makes the cell focusable and Enter sorts', () => {
    const onSortChange = vi.fn()
    const t = mount([{ key: 'name', header: <span>Name</span>, sortable: true }], '', onSortChange)
    const th = t.head('Name') as HTMLTableCellElement
    expect(th.getAttribute('tabindex')).toBe('0')
    expect(th.getAttribute('aria-sort')).toBe('none')
    act(() => {
      th.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSortChange).toHaveBeenCalledWith('name')
    t.done()
  })
})

// Army 9 b08 N-R9-5: "ARMY" listed 23 names without it (cmdk's fuzzy subsequence score).
describe('value list search', () => {
  it('matches by contains, every word', () => {
    expect(containsFilter('CH26CR 201994 ARMY9 b06 Kristina', 'army')).toBe(1)
    expect(containsFilter('NR27PW 203388 25 CLARENDON ST. WATERTOWN MASS', 'ARMY')).toBe(0)
    expect(containsFilter('CH26CR 201994 ARMY9 b06 Kristina', 'kristina army9')).toBe(1)
    expect(containsFilter('anything', '  ')).toBe(1)
  })
})
