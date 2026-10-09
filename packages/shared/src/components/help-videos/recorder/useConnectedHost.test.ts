// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useConnectedHost } from './useConnectedHost'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useConnectedHost', () => {
  it('gives the modal while it is in the document, then null once it is removed', async () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    const seen: Array<HTMLElement | null> = []
    function Probe() {
      seen.push(useConnectedHost(dialog, true))
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Probe)))
    expect(seen[seen.length - 1]).toBe(dialog)
    await act(async () => {
      dialog.remove()
      await Promise.resolve()
    })
    expect(seen[seen.length - 1]).toBeNull()
    act(() => root.unmount())
  })

  it('is null without a host', () => {
    const seen: Array<HTMLElement | null> = []
    function Probe() {
      seen.push(useConnectedHost(null, true))
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Probe)))
    expect(seen[0]).toBeNull()
    act(() => root.unmount())
  })
})
