// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ListLoadError } from './ListLoadError'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ListLoadError', () => {
  it("says the server's words for a list timeout and retries", () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onRetry = vi.fn()
    const err = {
      status: 503,
      response: {
        code: 'LIST_TIMEOUT',
        message: 'This list took too long to load. Try again, or narrow the filters.'
      }
    }
    act(() => root.render(<ListLoadError error={err} onRetry={onRetry} />))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'This list took too long to load.'
    )
    act(() => (host.querySelector('button') as HTMLButtonElement).click())
    expect(onRetry).toHaveBeenCalledOnce()
    act(() => root.unmount())
    host.remove()
  })
})
