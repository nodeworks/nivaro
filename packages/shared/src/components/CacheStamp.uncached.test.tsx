// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CacheStamp } from './CacheStamp'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const uncached = {
  data: [],
  cached: false,
  cache_ttl: 0,
  executed_at: '2026-11-14T10:00:00Z',
  freshness_sources: [{ table: 'invoices', column: '', changed_at: null }]
}

describe('CacheStamp for an uncached query', () => {
  it('shows nothing until the data it reads changes', () => {
    act(() => root.render(createElement(CacheStamp, { envelope: uncached, onRefresh: () => {} })))
    expect(host.innerHTML).toBe('')
  })

  it('then shows only the chip and Refresh (no age label)', () => {
    act(() =>
      root.render(
        createElement(CacheStamp, { envelope: uncached, onRefresh: () => {}, changedLive: true })
      )
    )
    expect(host.textContent).toContain('Data changed since run')
    expect(host.textContent).toContain('Refresh')
    expect(host.textContent).not.toContain('Updated')
  })
})
