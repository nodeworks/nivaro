// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ColResizeHandle, fitWidth, useColumnWidths } from './catalog-columns'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

type Api = ReturnType<typeof useColumnWidths>
function mountHook(key: string | null): { current: Api } {
  const out = { current: null as unknown as Api }
  function Probe() {
    out.current = useColumnWidths(key)
    return null
  }
  act(() => root.render(createElement(Probe)))
  return out
}

describe('useColumnWidths', () => {
  it('remembers widths per table in this browser, clamped, and resets them', () => {
    const a = mountHook('cifa_items:inventory_request_materials.inventory_request:catalog')
    expect(a.current.customized).toBe(false)
    expect(a.current.box('item', 'w-36 shrink-0')).toEqual({
      'data-cpf-col': 'item',
      className: 'w-36 shrink-0',
      style: undefined
    })
    act(() => a.current.setWidth('item', 260))
    act(() => a.current.setWidth('description', 5))
    expect(a.current.box('item', 'w-36 shrink-0', 'text-right')).toEqual({
      'data-cpf-col': 'item',
      className: 'shrink grow-0 text-right',
      style: { width: 260, minWidth: 48 }
    })
    expect(a.current.widths.description).toBe(48) // never narrower than the minimum

    // A fresh mount (a reload) reads them back.
    act(() => root.unmount())
    root = createRoot(host)
    const b = mountHook('cifa_items:inventory_request_materials.inventory_request:catalog')
    expect(b.current.widths).toEqual({ item: 260, description: 48 })

    act(() => b.current.reset())
    expect(b.current.customized).toBe(false)
    expect(
      localStorage.getItem(
        'nvr:catalog-cols:v1:cifa_items:inventory_request_materials.inventory_request:catalog'
      )
    ).toBeNull()
  })

  it('ignores a damaged stored value', () => {
    localStorage.setItem('nvr:catalog-cols:v1:t', '{"item":"wide","qty":120}')
    expect(mountHook('t').current.widths).toEqual({ qty: 120 })
  })
})

describe('fitWidth', () => {
  it('takes the widest cell of the column, header included', () => {
    const area = document.createElement('div')
    const cell = (col: string, scroll: number, fitInner = false) => {
      const el = document.createElement('span')
      el.dataset.cpfCol = col
      const target = fitInner ? document.createElement('span') : el
      if (fitInner) {
        target.dataset.cpfFit = ''
        el.appendChild(target)
      }
      Object.defineProperty(target, 'scrollWidth', { value: scroll })
      area.appendChild(el)
    }
    cell('description', 140)
    cell('description', 310)
    cell('description', 90, true)
    cell('item', 999)
    expect(fitWidth(area, 'description')).toBe(316)
    expect(fitWidth(area, 'missing')).toBeNull()
  })
})

describe('ColResizeHandle', () => {
  it('resizes from the keyboard and fits on Enter', () => {
    const onResize = vi.fn()
    const onFit = vi.fn()
    act(() =>
      root.render(
        createElement(
          'span',
          { style: { position: 'relative' } },
          createElement(ColResizeHandle, { label: 'Description', onResize, onFit })
        )
      )
    )
    const cell = host.firstElementChild as HTMLElement
    cell.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
    const handle = host.querySelector('[data-cpf-resize]') as HTMLElement
    expect(handle.getAttribute('aria-label')).toBe('Resize Description')
    const key = (k: string, shift = false) =>
      act(() => {
        handle.dispatchEvent(
          new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true })
        )
      })
    key('ArrowRight')
    expect(onResize).toHaveBeenLastCalledWith(108)
    key('ArrowLeft', true)
    expect(onResize).toHaveBeenLastCalledWith(68)
    key('Enter')
    expect(onFit).toHaveBeenCalledOnce()
  })
})
