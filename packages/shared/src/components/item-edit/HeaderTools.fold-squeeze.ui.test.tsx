// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useHeaderFold } from './HeaderTools'

// 2026-11-16 design review r2 (1548 px, dark): the pipeline moves landed after the tool strip
// had folded. The row still fit — the title block absorbed them — so nothing reacted and the
// title ran to five lines with its chips each on a row of their own. The moves now fold on that
// squeeze too, and re-check when anything in the row changes (moves or chips arriving).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame
globalThis.cancelAnimationFrame ??= ((id: number) =>
  clearTimeout(id)) as typeof cancelAnimationFrame

function place(el: HTMLElement, top: number, width = 0, bottom = top + 20) {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: width, width, height: bottom - top }) as DOMRect
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width })
}

function Moves() {
  const ref = useRef<HTMLDivElement>(null)
  const folded = useHeaderFold(ref, true)
  return (
    <div ref={ref} data-testid='moves'>
      {folded ? 'Actions' : 'Fusion Submitted · Send Back'}
    </div>
  )
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

/** A record header whose tools are already folded, title chips placed by `chipTop`. */
function mount(chipTop: number) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <header data-nvr-header-row>
        <div data-nvr-header-title>
          <div className='line'>
            <h1 data-nvr-record-title>CM26-73975</h1>
            <button type='button' className='chip'>
              Help requested by Beth Maguire
            </button>
          </div>
        </div>
        <div className='strip'>
          <div data-nvr-header-tools='folded' />
          <Moves />
        </div>
      </header>
    )
  )
  const header = document.querySelector<HTMLElement>('[data-nvr-header-row]')!
  Object.defineProperty(header, 'clientWidth', { configurable: true, value: 1300 })
  Object.defineProperty(header, 'scrollWidth', { configurable: true, value: 1300 })
  const line = document.querySelector<HTMLElement>('.line')!
  Object.defineProperty(line, 'clientWidth', { configurable: true, value: 300 })
  place(document.querySelector<HTMLElement>('[data-nvr-header-title]')!, 10, 300, 140)
  place(document.querySelector<HTMLElement>('.strip')!, 40)
  place(document.querySelector<HTMLElement>('[data-nvr-record-title]')!, 10, 110)
  place(document.querySelector<HTMLElement>('.chip')!, chipTop, 220)
}

const moves = () => document.querySelector<HTMLElement>('[data-testid="moves"]')!
const tick = () => act(async () => await new Promise((r) => setTimeout(r, 60)))

describe('useHeaderFold on a squeezed title', () => {
  it('stays inline while the chips sit beside the id', async () => {
    mount(10)
    await tick()
    expect(moves().textContent).toContain('Fusion Submitted')
    expect(moves().getAttribute('data-nvr-header-fold')).toBe('inline')
  })

  it('folds the moves once a chip has wrapped under the id', async () => {
    mount(10)
    await tick()
    // A chip lands and wraps (no resize of the row): the mutation re-checks.
    place(document.querySelector<HTMLElement>('.chip')!, 36, 220)
    act(() => {
      document.querySelector('.line')!.appendChild(document.createElement('span'))
    })
    await tick()
    expect(moves().textContent).toBe('Actions')
    expect(moves().getAttribute('data-nvr-header-fold')).toBe('folded')
  })
})
