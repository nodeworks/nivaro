// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { titleChipDeficit } from './HeaderTools'

// 2026-11-16 design review: at 1548 px the inline toolbar squeezed the title block until its
// chips wrapped under the id (a ~6 line header) without the row ever overflowing, so the tools
// never folded. titleChipDeficit says how much wider the id's line needs to be.

type Box = { top: number; bottom?: number; width?: number }
function box(el: HTMLElement, b: Box) {
  el.getBoundingClientRect = () =>
    ({
      top: b.top,
      bottom: b.bottom ?? b.top + 20,
      left: 0,
      right: 0,
      width: b.width ?? 0,
      height: 20
    }) as DOMRect
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: b.width ?? 0 })
}

function header({
  chipTops,
  lineWidth,
  stripTop
}: {
  chipTops: number[]
  lineWidth: number
  stripTop: number
}) {
  const row = document.createElement('header')
  const block = document.createElement('div')
  block.setAttribute('data-nvr-header-title', '')
  const line = document.createElement('div')
  line.style.columnGap = '6px'
  Object.defineProperty(line, 'clientWidth', { configurable: true, value: lineWidth })
  const id = document.createElement('h1')
  id.setAttribute('data-nvr-record-title', '')
  box(id, { top: 10, width: 110 })
  line.appendChild(id)
  for (const top of chipTops) {
    const chip = document.createElement('button')
    box(chip, { top, width: 180 })
    line.appendChild(chip)
  }
  block.appendChild(line)
  box(block, { top: 10, bottom: 110 })
  const strip = document.createElement('div')
  box(strip, { top: stripTop })
  row.append(block, strip)
  return { row, strip }
}

describe('titleChipDeficit', () => {
  it('is the extra width the chips need to sit beside the id', () => {
    const { row, strip } = header({ chipTops: [10, 36], lineWidth: 400, stripTop: 40 })
    // 110 + 180 + 180 + 2 gaps of 6 = 482 on one line, the line has 400.
    expect(titleChipDeficit(row, strip)).toBe(82)
  })

  it('is 0 when the chips already sit on the id line', () => {
    const { row, strip } = header({ chipTops: [10, 10], lineWidth: 500, stripTop: 40 })
    expect(titleChipDeficit(row, strip)).toBe(0)
  })

  it('is 0 when the tools are on a line of their own (phones), folding them wins nothing', () => {
    const { row, strip } = header({ chipTops: [10, 36], lineWidth: 300, stripTop: 120 })
    expect(titleChipDeficit(row, strip)).toBe(0)
  })

  it('is 0 outside a record header', () => {
    const row = document.createElement('header')
    expect(titleChipDeficit(row, document.createElement('div'))).toBe(0)
  })
})
