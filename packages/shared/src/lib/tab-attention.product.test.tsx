// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { setTabTitleProduct, useTabTitleLabel } from './tab-attention'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A standalone Nivaro Hub puts "Hub · " in front of every title (admin lib/hub-product.ts),
// through the same single title owner as the count and the environment label.

const settle = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => setTabTitleProduct(null))

describe('setTabTitleProduct', () => {
  it('leads the title, survives page rewrites, and comes off cleanly', async () => {
    document.title = 'Apps — Nivaro Hub'
    setTabTitleProduct('Hub')
    expect(document.title).toBe('Hub · Apps — Nivaro Hub')
    document.title = 'Promote · Apps — Nivaro Hub'
    await settle()
    expect(document.title).toBe('Hub · Promote · Apps — Nivaro Hub')
    setTabTitleProduct(null)
    expect(document.title).toBe('Promote · Apps — Nivaro Hub')
  })

  it('sits before the environment label', async () => {
    document.title = 'Apps'
    setTabTitleProduct('Hub')
    const host = document.createElement('div')
    const root = createRoot(host)
    function Label() {
      useTabTitleLabel('Staging')
      return null
    }
    await act(async () => root.render(<Label />))
    await settle()
    expect(document.title).toBe('Hub · Staging · Apps')
    await act(async () => root.unmount())
    await settle()
    expect(document.title).toBe('Hub · Apps')
  })

  it('never touches a title it was not asked to (a regular install)', () => {
    document.title = 'Overview — Nivaro'
    setTabTitleProduct(null)
    expect(document.title).toBe('Overview — Nivaro')
  })
})
