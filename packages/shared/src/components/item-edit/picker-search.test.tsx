// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { narrowLocally, useLatestSearch } from './picker-search'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let sent: string[] = []
function Probe({ query, busy }: { query: string; busy: boolean }) {
  const s = useLatestSearch(query, busy, 300)
  if (sent[sent.length - 1] !== s) sent.push(s)
  return null
}
const render = (query: string, busy: boolean) =>
  act(() => root.render(<Probe query={query} busy={busy} />))

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

describe('useLatestSearch', () => {
  it('sends one search per pause, never a second while one is in flight', () => {
    render('', false)
    render('r', false)
    act(() => vi.advanceTimersByTime(300))
    expect(sent).toEqual(['', 'r'])
    // "r" is now in flight: typing at 330 ms a key sends nothing more
    for (const q of ['ro', 'rob', 'robe', 'rober', 'robert']) {
      render(q, true)
      act(() => vi.advanceTimersByTime(330))
    }
    expect(sent).toEqual(['', 'r'])
    // the answer lands → only the newest text goes out, with no second debounce
    render('robert', false)
    act(() => vi.advanceTimersByTime(0))
    expect(sent).toEqual(['', 'r', 'robert'])
    // the next pause is debounced again
    render('robert l', false)
    act(() => vi.advanceTimersByTime(299))
    expect(sent).toEqual(['', 'r', 'robert'])
    act(() => vi.advanceTimersByTime(1))
    expect(sent).toEqual(['', 'r', 'robert', 'robert l'])
  })

  it('clears at once when the box is emptied, even mid-flight', () => {
    render('rob', false)
    act(() => vi.advanceTimersByTime(300))
    render('', true)
    expect(sent[sent.length - 1]).toBe('')
  })
})

describe('narrowLocally', () => {
  const people = ['Robert Lee', 'Bob Diehl', 'Roberta Ng']
  it('keeps the previous answer narrowed by the typed words until the new one lands', () => {
    expect(narrowLocally(people, (p) => p, 'robert', false)).toEqual(['Robert Lee', 'Roberta Ng'])
    expect(narrowLocally(people, (p) => p, 'lee rob', false)).toEqual(['Robert Lee'])
  })
  it('shows the server answer untouched once settled', () => {
    expect(narrowLocally(people, (p) => p, 'robert', true)).toEqual(people)
  })
})
