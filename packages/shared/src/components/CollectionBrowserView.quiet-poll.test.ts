// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cbvQuietNow } from './CollectionBrowserView'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('cbvQuietNow — when a safety re-read may run', () => {
  it('is quiet with nothing selected and no table on screen', () => {
    expect(cbvQuietNow(0)).toBe(true)
  })

  it('is not quiet while rows are selected', () => {
    expect(cbvQuietNow(2)).toBe(false)
  })

  it('is not quiet while the tab is hidden', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    expect(cbvQuietNow(0)).toBe(false)
  })

  it('is not quiet with a field focused inside the table', () => {
    document.body.innerHTML = '<div data-cbv-scroll><input id="f" /></div>'
    ;(document.getElementById('f') as HTMLInputElement).focus()
    expect(cbvQuietNow(0)).toBe(false)
  })

  it('is quiet when the focus is elsewhere', () => {
    document.body.innerHTML = '<div data-cbv-scroll><p>rows</p></div><input id="o" />'
    ;(document.getElementById('o') as HTMLInputElement).focus()
    expect(cbvQuietNow(0)).toBe(true)
  })

  it('is not quiet while the pointer is over the table', () => {
    document.body.innerHTML = '<div data-cbv-scroll><p>rows</p></div>'
    const el = document.querySelector('[data-cbv-scroll]') as HTMLElement
    const orig = el.matches.bind(el)
    el.matches = (sel: string) => (sel === ':hover' ? true : orig(sel))
    expect(cbvQuietNow(0)).toBe(false)
  })
})
