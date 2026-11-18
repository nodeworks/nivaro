// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTopInserts } from './live-screen'

// The notification bell hands useTopInserts the list element that IS the scroller
// (max-h-96 overflow-y-auto). Scrolled down, a new row must wait behind "N new" —
// before the fix the hook only looked at the list's parents, fell back to the page and
// always read "at the top", so the pill never showed.
type Row = { id: string }
let host: HTMLDivElement
let root: Root
let setRows: (r: Row[]) => void = () => {}
let held = 0
let list: HTMLDivElement | null = null

function Feed() {
  const [rows, set] = useState<Row[]>([{ id: 'a' }, { id: 'b' }])
  setRows = set
  const feed = useTopInserts(rows, (r) => r.id)
  held = feed.held
  return createElement(
    'div',
    {
      ref: (el: HTMLDivElement | null) => {
        list = el
        feed.rootRef(el)
      },
      style: { overflowY: 'auto', maxHeight: '100px' }
    },
    ...feed.rows.map((r) => createElement('p', { key: r.id }, r.id))
  )
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(Feed)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useTopInserts — the root is its own scroller', () => {
  it('holds a new top row while the list itself is scrolled down', () => {
    const el = list as HTMLDivElement
    act(() => {
      el.scrollTop = 300
      el.dispatchEvent(new Event('scroll'))
    })
    act(() => setRows([{ id: 'n' }, { id: 'a' }, { id: 'b' }]))
    expect(held).toBe(1)
  })

  it('shows it at once while the list is at its top', () => {
    act(() => setRows([{ id: 'n' }, { id: 'a' }, { id: 'b' }]))
    expect(held).toBe(0)
  })
})
