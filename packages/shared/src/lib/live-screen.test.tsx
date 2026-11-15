// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fadeTargets,
  holdTopInserts,
  type SettledRow,
  settleRows,
  updatedAgoLabel,
  useSettledRows
} from './live-screen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface R {
  id: string
  v?: number
}
const key = (r: R) => r.id
const rows = (...ids: string[]): R[] => ids.map((id) => ({ id }))
const shown = (list: SettledRow<R>[]) =>
  list.map((r) => (r.state === 'departed' ? `${r.key}~` : r.key)).join(' ')

describe('settleRows — never move under the pointer', () => {
  it('first answer shows as it is', () => {
    expect(shown(settleRows([], rows('a', 'b'), key, { frozen: false }))).toBe('a b')
  })

  it('frozen: keeps the order, a row that left stays departed, arrivals go to the end', () => {
    const prev = settleRows([], rows('a', 'b', 'c'), key, { frozen: false })
    const next = settleRows(prev, rows('n', 'c', 'a'), key, { frozen: true })
    expect(shown(next)).toBe('a b~ c n')
  })

  it('frozen: rows still present take their new data in place', () => {
    const prev = settleRows([], [{ id: 'a', v: 1 }], key, { frozen: false })
    const next = settleRows(prev, [{ id: 'a', v: 2 }], key, { frozen: true })
    expect(next[0].row.v).toBe(2)
  })

  it('not frozen: server order, departed row kept next to the row it followed', () => {
    const prev = settleRows([], rows('a', 'b', 'c'), key, { frozen: false })
    const next = settleRows(prev, rows('c', 'a'), key, { frozen: false })
    expect(shown(next)).toBe('c a b~')
  })

  it('a departed row leaves once it may (an interaction happened) and nothing holds it', () => {
    const prev = settleRows([], rows('a', 'b'), key, { frozen: false })
    const gone = settleRows(prev, rows('a'), key, { frozen: false })
    expect(shown(gone)).toBe('a b~')
    expect(
      shown(settleRows(gone, rows('a'), key, { frozen: false, mayLeave: new Set(['b']) }))
    ).toBe('a')
  })

  it('a held row (its confirm is open) never leaves, even after an interaction', () => {
    const prev = settleRows([], rows('a', 'b'), key, { frozen: false })
    const next = settleRows(prev, rows('a'), key, {
      frozen: false,
      mayLeave: new Set(['b']),
      held: new Set(['b'])
    })
    expect(shown(next)).toBe('a b~')
  })

  it('a departed row never leaves while the list is frozen', () => {
    const prev = settleRows([], rows('a', 'b'), key, { frozen: false })
    const next = settleRows(prev, rows('a'), key, { frozen: true, mayLeave: new Set(['b']) })
    expect(shown(next)).toBe('a b~')
  })

  it('a released row (the person decided it) goes at once', () => {
    const prev = settleRows([], rows('a', 'b'), key, { frozen: false })
    expect(
      shown(settleRows(prev, rows('a'), key, { frozen: true, released: new Set(['b']) }))
    ).toBe('a')
    expect(
      shown(settleRows(prev, rows('a'), key, { frozen: false, released: new Set(['b']) }))
    ).toBe('a')
  })

  it('a row that comes back is live again', () => {
    const prev = settleRows([], rows('a', 'b'), key, { frozen: false })
    const gone = settleRows(prev, rows('a'), key, { frozen: false })
    expect(shown(settleRows(gone, rows('a', 'b'), key, { frozen: true }))).toBe('a b')
  })

  it('keeps a chain of departed rows in their old order', () => {
    const prev = settleRows([], rows('a', 'b', 'c', 'd'), key, { frozen: false })
    const next = settleRows(prev, rows('a', 'd'), key, { frozen: false })
    expect(shown(next)).toBe('a b~ c~ d')
  })
})

describe('holdTopInserts — new rows wait while scrolled down', () => {
  it('at the top the answer shows as it is', () => {
    expect(holdTopInserts(['b', 'c'], rows('a', 'b', 'c'), key, true)).toEqual({
      rows: rows('a', 'b', 'c'),
      held: 0
    })
  })

  it('scrolled down: leading arrivals are held and counted, order kept', () => {
    const r = holdTopInserts(['b', 'c'], rows('x', 'y', 'z', 'c', 'b'), key, false)
    expect(r.held).toBe(3)
    expect(r.rows.map(key)).toEqual(['b', 'c'])
  })

  it('scrolled down: arrivals below the shown rows go to the end, not counted', () => {
    const r = holdTopInserts(['a', 'b'], rows('a', 'b', 'q'), key, false)
    expect(r.held).toBe(0)
    expect(r.rows.map(key)).toEqual(['a', 'b', 'q'])
  })

  it('rows gone from the answer drop out', () => {
    const r = holdTopInserts(['a', 'b', 'c'], rows('a', 'c'), key, false)
    expect(r.rows.map(key)).toEqual(['a', 'c'])
  })

  it('first answer (nothing shown yet) and a wholly different page show as they are', () => {
    expect(holdTopInserts(null, rows('a'), key, false).rows.map(key)).toEqual(['a'])
    expect(holdTopInserts(['a'], rows('p', 'q'), key, false)).toEqual({
      rows: rows('p', 'q'),
      held: 0
    })
  })
})

describe('fadeTargets', () => {
  it('fades the parent of changed text, never inside an input or a no-fade area', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<span id="n">12</span><div data-live-nofade><b id="q">3</b></div><label><input id="i"/></label>'
    document.body.appendChild(root)
    const n = root.querySelector('#n') as HTMLElement
    const q = root.querySelector('#q') as HTMLElement
    const out = fadeTargets(
      root,
      [
        { type: 'characterData', target: n.firstChild as Node, addedNodes: [] as never },
        { type: 'characterData', target: q.firstChild as Node, addedNodes: [] as never }
      ],
      null
    )
    expect(out).toEqual([n])
    root.remove()
  })

  it('never fades the focused element or what holds it', () => {
    const root = document.createElement('div')
    root.innerHTML = '<button id="b">Approve <span id="c">2</span></button>'
    document.body.appendChild(root)
    const c = root.querySelector('#c') as HTMLElement
    const b = root.querySelector('#b') as HTMLElement
    const out = fadeTargets(
      root,
      [{ type: 'characterData', target: c.firstChild as Node, addedNodes: [] as never }],
      b
    )
    expect(out).toEqual([])
    root.remove()
  })
})

describe('updatedAgoLabel', () => {
  it('reads like the brief', () => {
    const now = 1_000_000
    expect(updatedAgoLabel(null, now)).toBeNull()
    expect(updatedAgoLabel(now - 2000, now)).toBe('Updated just now')
    expect(updatedAgoLabel(now - 10_000, now)).toBe('Updated 10 s ago')
    expect(updatedAgoLabel(now - 180_000, now)).toBe('Updated 3 min ago')
    expect(updatedAgoLabel(now - 7_200_000, now)).toBe('Updated 2 h ago')
  })
})

// ── The hook, with real pointer and focus events ─────────────────────────────

let root: Root
let host: HTMLDivElement
let setList: (r: R[]) => void = () => {}
let setHeld: (h: string[]) => void = () => {}

function List() {
  const [list, set] = useState<R[]>(rows('a', 'b', 'c'))
  const [held, hold] = useState<string[]>([])
  setList = set
  setHeld = hold
  const s = useSettledRows(list, key, { held })
  return createElement(
    'ul',
    { ref: s.containerRef, 'data-testid': 'list' },
    s.rows.map((r) =>
      createElement('li', { key: r.key, 'data-state': r.state, tabIndex: 0 }, r.key)
    )
  )
}

const text = () =>
  [...host.querySelectorAll('li')]
    .map((li) =>
      li.getAttribute('data-state') === 'departed' ? `${li.textContent}~` : li.textContent
    )
    .join(' ')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(List)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useSettledRows', () => {
  it('a row approved elsewhere stays calm under the pointer and leaves after the next click away', () => {
    const ul = host.querySelector('ul') as HTMLElement
    act(() => ul.dispatchEvent(new Event('pointerenter')))
    act(() => setList(rows('c', 'a')))
    // Pointer in the list: order kept, b departed in place.
    expect(text()).toBe('a b~ c')
    // A click while still inside does not move anything.
    act(() => document.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(text()).toBe('a b~ c')
    // Pointer leaves: the server order comes in and b may leave (an interaction happened).
    act(() => ul.dispatchEvent(new Event('pointerleave')))
    expect(text()).toBe('c a')
  })

  it('without an interaction since it left, a departed row waits', () => {
    act(() => setList(rows('a', 'c')))
    expect(text()).toBe('a b~ c')
    act(() => document.dispatchEvent(new Event('keydown', { bubbles: true })))
    expect(text()).toBe('a c')
  })

  it('a held row (open confirm) stays after interactions until released from hold', () => {
    act(() => setHeld(['b']))
    act(() => setList(rows('a', 'c')))
    act(() => document.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(text()).toBe('a b~ c')
    act(() => setHeld([]))
    expect(text()).toBe('a c')
  })

  it('keyboard focus inside holds the order like the pointer does', () => {
    const li = host.querySelector('li') as HTMLElement
    act(() => li.focus())
    act(() => setList(rows('n', 'c', 'b', 'a')))
    expect(text()).toBe('a b c n')
  })
})
