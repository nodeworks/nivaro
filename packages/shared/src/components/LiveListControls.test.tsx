// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { burstPillBottom } from './LiveListControls'

// The burst pill sits above the last visible row's bottom edge and above a sticky totals row,
// so it never straddles a border (design review round 2, 2026-11-15).

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top
  } as DOMRect
}

function build(withTotals: boolean) {
  const host = document.createElement('div')
  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  const table = document.createElement('table')
  table.appendChild(document.createElement('tbody'))
  if (withTotals) table.appendChild(document.createElement('tfoot'))
  scroller.appendChild(table)
  host.appendChild(scroller)
  const footer = document.createElement('div') // pager under the rows
  host.appendChild(footer)
  document.body.appendChild(host)
  host.getBoundingClientRect = () => rect(0, 1000)
  scroller.getBoundingClientRect = () => rect(40, 880)
  table.getBoundingClientRect = () => rect(40, 2400)
  const foot = table.querySelector('tfoot')
  if (foot) foot.getBoundingClientRect = () => rect(844, 880)
  return host
}

describe('burstPillBottom', () => {
  it('lifts the pill 8 px above the rows’ bottom edge (the pager is below it)', () => {
    expect(burstPillBottom(build(false))).toBe(1000 - 880 + 8)
  })
  it('and above the sticky totals row when the list shows one', () => {
    expect(burstPillBottom(build(true))).toBe(1000 - 880 + 36 + 8)
  })
  it('says nothing without a table', () => {
    expect(burstPillBottom(document.createElement('div'))).toBeNull()
  })
})
