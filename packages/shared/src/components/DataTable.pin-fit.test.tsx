// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Column, DataTable } from './DataTable'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Design review round 4: a 1280 / 1400 px queue kept Owners pinned and pushed State off
// screen. With a keep rank the table releases Owners first, then data columns, then State,
// and a pinned column with nothing in it on this page goes before any of them.

type Row = { id: string; name: string; state: string | null; owners: string | null }

const WIDTHS: Record<string, number> = {
  Name: 120,
  Amount: 120,
  State: 200,
  Owners: 260,
  Actions: 80
}

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'amount', header: 'Amount', render: () => '$1' },
  { key: 'state', header: 'State', render: (r) => r.state ?? '—' },
  {
    key: 'owners',
    header: 'Owners',
    render: (r) => (r.owners ? r.owners : <span data-cell-empty>No owners</span>)
  },
  { key: 'actions', header: 'Actions', render: () => <button type='button'>Open</button> }
]

const rank = (k: string) => (k === 'actions' ? 3 : k === 'state' ? 2 : k === 'owners' ? 0 : 1)

let restore: (() => void) | null = null
beforeEach(() => {
  const rect = HTMLElement.prototype.getBoundingClientRect
  const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const w = this.tagName === 'TH' ? (WIDTHS[(this.textContent ?? '').trim()] ?? 100) : 0
    return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0 } as DOMRect
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 1100
    }
  })
  restore = () => {
    HTMLElement.prototype.getBoundingClientRect = rect
    if (cw) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cw)
  }
})
afterEach(() => {
  restore?.()
  restore = null
})

function mount(rows: Row[], withRank: boolean) {
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
        columnPins={{ name: 'left', state: 'right', owners: 'right', actions: 'right' }}
        pinKeepRank={withRank ? rank : undefined}
        pinRightShare={0.45}
      />
    )
  )
  const heads = () => [...host.querySelectorAll('thead tr:first-child th')]
  const order = () => heads().map((th) => (th.textContent ?? '').trim())
  const sticky = () =>
    heads()
      .filter((th) => th.className.includes('sticky'))
      .map((th) => (th.textContent ?? '').trim())
  const done = () => {
    act(() => root.unmount())
    host.remove()
  }
  return { order, sticky, done }
}

const filled: Row[] = [
  { id: '1', name: 'A', state: 'Waiting on Level 1', owners: 'Pat Lee' },
  { id: '2', name: 'B', state: 'Approved', owners: 'Sam Roe' }
]

describe('DataTable pin fit with a keep rank', () => {
  it('without a rank the outer pins win: Owners stays, State goes (the old behaviour)', () => {
    const t = mount(filled, false)
    expect(t.sticky()).toEqual(['Name', 'Owners', 'Actions'])
    t.done()
  })

  it('releases Owners first and keeps State, moving Owners in with the scrolling columns', () => {
    const t = mount(filled, true)
    expect(t.sticky()).toEqual(['Name', 'State', 'Actions'])
    // Owners scrolls with the data, so State sits against Actions at the edge.
    expect(t.order()).toEqual(['Name', 'Amount', 'Owners', 'State', 'Actions'])
    t.done()
  })

  it('a pinned column empty on this page gives way before the rank order', () => {
    const rows: Row[] = filled.map((r) => ({ ...r, state: null }))
    const t = mount(rows, true)
    expect(t.sticky()).toEqual(['Name', 'Owners', 'Actions'])
    expect(t.order()).toEqual(['Name', 'Amount', 'State', 'Owners', 'Actions'])
    t.done()
  })

  it('text marked data-cell-empty ("No owners") counts as empty', () => {
    // Widen nothing: Owners is empty AND lowest rank, so it goes; State stays.
    const rows: Row[] = filled.map((r) => ({ ...r, owners: null }))
    const t = mount(rows, true)
    expect(t.sticky()).toEqual(['Name', 'State', 'Actions'])
    t.done()
  })
})
