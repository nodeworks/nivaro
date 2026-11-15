// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { __resetScreenRefreshForTests, pageRefreshButtonShown } from '../lib/screen-refresh'
import { ScreenRefreshButton } from './ScreenRefreshButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; host: HTMLElement }> = []

function mount(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(el))
  const m = { root, host }
  mounted.push(m)
  return m
}

function unmount(m: { root: Root; host: HTMLElement }) {
  act(() => m.root.unmount())
  m.host.remove()
}

afterEach(() => {
  for (const m of mounted.splice(0)) {
    try {
      unmount(m)
    } catch {
      /* already gone */
    }
  }
  __resetScreenRefreshForTests()
})

const count = () => document.querySelectorAll('[data-screen-refresh]').length
const shows = (m: { host: HTMLElement }) => !!m.host.querySelector('[data-screen-refresh]')

describe('ScreenRefreshButton — one ↻ per screen', () => {
  it('the app-wide button shows when no page has its own', () => {
    mount(<ScreenRefreshButton variant='rail' />)
    expect(count()).toBe(1)
  })

  it('a page header button hides the app-wide one, which returns when the page goes', () => {
    const rail = mount(<ScreenRefreshButton variant='rail' />)
    const page = mount(<ScreenRefreshButton />)
    expect(count()).toBe(1)
    expect(pageRefreshButtonShown()).toBe(true)
    expect(shows(page)).toBe(true)
    expect(shows(rail)).toBe(false)
    unmount(page)
    expect(pageRefreshButtonShown()).toBe(false)
    expect(count()).toBe(1)
    expect(shows(rail)).toBe(true)
  })

  it('the portal top bar follows the same rule', () => {
    const bar = mount(<ScreenRefreshButton variant='bar' />)
    mount(<ScreenRefreshButton variant='header' />)
    expect(shows(bar)).toBe(false)
    expect(count()).toBe(1)
  })
})
