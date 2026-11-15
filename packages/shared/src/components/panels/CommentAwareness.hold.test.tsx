// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useHoldInPlace } from './CommentAwareness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The replies note appears above the comment box: the box must stay where it is on screen
// (coordinator 2026-11-15) — the scroll container moves by the note's height instead.

let boxTop = 300
const NOTE_H = 64

function Harness({ count }: { count: number }) {
  const ref = useRef<HTMLFormElement>(null)
  useHoldInPlace(ref, count)
  // jsdom has no layout: the box's top is "300 + the note's height", minus what was scrolled.
  return (
    <div data-scroller style={{ overflowY: 'auto' }}>
      {count > 0 && <div style={{ height: NOTE_H }} />}
      <form ref={ref} data-box />
    </div>
  )
}

async function mount(initialTop: number) {
  boxTop = initialTop
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let scroller: HTMLElement | null = null
  const origRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if ((this as HTMLElement).dataset?.box !== undefined) {
      const s = scroller ?? (host.querySelector('[data-scroller]') as HTMLElement | null)
      const hasNote = !!s && s.children.length > 1
      const top = boxTop + (hasNote ? NOTE_H : 0) - (s?.scrollTop ?? 0)
      return { top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40 } as DOMRect
    }
    if ((this as HTMLElement).dataset?.scroller !== undefined)
      return { top: 0, bottom: 800, left: 0, right: 0, width: 0, height: 800 } as DOMRect
    return origRect.call(this)
  }
  const render = async (count: number) => {
    await act(async () => root.render(<Harness count={count} />))
    scroller = host.querySelector('[data-scroller]')
    if (scroller) {
      Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true })
      Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true })
    }
  }
  await render(0)
  return {
    render,
    scroller: () => scroller as HTMLElement,
    done() {
      Element.prototype.getBoundingClientRect = origRect
      act(() => root.unmount())
      host.remove()
    }
  }
}

describe('useHoldInPlace', () => {
  it('scrolls by the note’s height so the box does not move', async () => {
    const ui = await mount(300)
    await ui.render(0)
    expect(ui.scroller().scrollTop).toBe(0)
    await ui.render(1)
    expect(ui.scroller().scrollTop).toBe(NOTE_H)
    ui.done()
  })

  it('leaves the scroll alone when the box was off screen', async () => {
    const ui = await mount(2000)
    await ui.render(0)
    await ui.render(1)
    expect(ui.scroller().scrollTop).toBe(0)
    ui.done()
  })
})
