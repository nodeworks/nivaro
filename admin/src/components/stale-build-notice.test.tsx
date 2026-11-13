// @vitest-environment jsdom

import { registerUnsavedWork } from '@nivaro/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { StaleBuildNotice } from './stale-build-notice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The stamp the stale-chunk recovery leaves when it reloads the tab. */
const RELOAD_STAMP = 'nvr-stale-chunk-reload'

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  sessionStorage.clear()
})

async function show() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<StaleBuildNotice />)
  })
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  const buttons = () => [...host.querySelectorAll('button')]
  return { host, buttons }
}

// Design review 2026-11-12.
describe('StaleBuildNotice', () => {
  it('offers the reload as the thing to do when nothing would be lost', async () => {
    const { host, buttons } = await show()
    expect(host.textContent).toContain('This app was updated')
    expect(host.textContent).toContain('This page needs the new version. Reload to open it.')
    expect(buttons().map((b) => b.textContent)).toEqual(['Reload'])
    expect(buttons()[0].className).toContain('bg-nvr-cyan')
  })

  // A white-label tenant's people never see the product's own name.
  it('does not name the product', async () => {
    const { host } = await show()
    expect(host.textContent).not.toMatch(/nivaro/i)
  })

  // With work not saved, the only control was a solid "Reload": one press from losing it.
  it('with unsaved work, says what the reload costs and stops being the bright button', async () => {
    const forget = registerUnsavedWork('Purchase order 12', () => true)
    try {
      const { host, buttons } = await show()
      expect(host.textContent).toContain(
        'This page needs the new version. Save your work first, then reload.'
      )
      expect(host.textContent).toContain('Not saved yet: Purchase order 12')
      expect(buttons().map((b) => b.textContent)).toEqual(['Reload without saving'])
      expect(buttons()[0].className).not.toContain('bg-nvr-cyan')
      expect(buttons()[0].className).toContain('border-slate-200')
    } finally {
      forget()
    }
  })

  // The give-up path: a reload was just tried and this screen is what it led back to.
  it('says a reload that was just tried did not bring the new version yet', async () => {
    sessionStorage.setItem(RELOAD_STAMP, String(Date.now() - 5_000))
    const { host } = await show()
    expect(host.textContent).toContain(
      'Reloading did not bring the new version yet. Wait a minute, then reload again.'
    )
    expect(host.textContent).not.toContain('Reload to open it.')
  })

  it('an older reload does not change the words', async () => {
    sessionStorage.setItem(RELOAD_STAMP, String(Date.now() - 5 * 60_000))
    const { host } = await show()
    expect(host.textContent).toContain('This page needs the new version. Reload to open it.')
  })

  it('a reload just tried, with unsaved work, still says to save first', async () => {
    sessionStorage.setItem(RELOAD_STAMP, String(Date.now() - 5_000))
    const forget = registerUnsavedWork('Purchase order 12', () => true)
    try {
      const { host, buttons } = await show()
      expect(host.textContent).toContain(
        'Reloading did not bring the new version yet. Save your work, wait a minute, then reload again.'
      )
      expect(buttons().map((b) => b.textContent)).toEqual(['Reload without saving'])
    } finally {
      forget()
    }
  })
})
