// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { leaveWarningActive, useLeaveWarning } from './useLeaveWarning'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ open, stage }: { open: boolean; stage: string }) {
  useLeaveWarning(leaveWarningActive(open, stage))
  return null
}

/** beforeunload handlers currently registered through window.addEventListener. */
function trackHandlers() {
  const live = new Set<unknown>()
  const add = vi.spyOn(window, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'beforeunload') live.add(fn)
  })
  const remove = vi.spyOn(window, 'removeEventListener').mockImplementation((type, fn) => {
    if (type === 'beforeunload') live.delete(fn)
  })
  return {
    live,
    restore: () => {
      add.mockRestore()
      remove.mockRestore()
    }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('leave-page warning', () => {
  it('is on while counting down, recording or saving, and off otherwise', () => {
    for (const s of ['countdown', 'recording', 'saving'])
      expect(leaveWarningActive(true, s)).toBe(true)
    for (const s of ['setup', 'done', 'limit', 'error'])
      expect(leaveWarningActive(true, s)).toBe(false)
    expect(leaveWarningActive(false, 'saving')).toBe(false)
  })

  it('leaves no handler behind once a save finishes', async () => {
    const h = trackHandlers()
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => root.render(createElement(Probe, { open: true, stage: 'recording' })))
    await act(async () => root.render(createElement(Probe, { open: true, stage: 'saving' })))
    expect(h.live.size).toBe(1)
    await act(async () => root.render(createElement(Probe, { open: true, stage: 'done' })))
    expect(h.live.size).toBe(0)
    // The parent closing the recorder mid-save also clears it.
    await act(async () => root.render(createElement(Probe, { open: true, stage: 'saving' })))
    await act(async () => root.render(createElement(Probe, { open: false, stage: 'saving' })))
    expect(h.live.size).toBe(0)
    await act(async () => root.unmount())
    h.restore()
  })
})
