// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { CategoryAxisBox, categoryAxisWidth, fitLabel } from './category-axis'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const six = (t: string) => t.length * 6

describe('category axis', () => {
  it('the column is as wide as the longest label, capped at 40% of the chart', () => {
    expect(categoryAxisWidth(150, 800)).toBe(160)
    expect(categoryAxisWidth(400, 800)).toBe(320)
    expect(categoryAxisWidth(10, 800)).toBe(40)
  })

  it('a label that fits is left whole; one that does not is cut with an ellipsis', () => {
    expect(fitLabel('Waiting on PO', 200, six)).toEqual({ text: 'Waiting on PO', cut: false })
    const r = fitLabel('Waiting on Level 4 Approval', 96, six)
    expect(r.cut).toBe(true)
    expect(r.text.endsWith('…')).toBe(true)
    expect(six(r.text)).toBeLessThanOrEqual(96)
    expect(r.text).toBe('Waiting on Leve…')
  })

  it('draws one-line ticks; only a cut label carries the full text as data-tip', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    let props: { width: number; tick: (p: object) => React.ReactNode } | null = null
    act(() =>
      root.render(
        <CategoryAxisBox labels={['Started', 'Waiting on Level 4 Approval']}>
          {(p) => {
            props = p
            return null
          }}
        </CategoryAxisBox>
      )
    )
    expect(props).not.toBeNull()
    const p = props as unknown as { width: number; tick: (p: object) => React.ReactNode }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const tickHost = createRoot(svg as unknown as HTMLElement)
    act(() => tickHost.render(p.tick({ x: p.width, y: 10, payload: { value: 'Started' } })))
    expect(svg.querySelectorAll('text')).toHaveLength(1)
    expect(svg.querySelector('g')?.getAttribute('data-tip')).toBeNull()
    expect(svg.textContent).toBe('Started')
    act(() => tickHost.unmount())
    act(() => root.unmount())
  })
})
