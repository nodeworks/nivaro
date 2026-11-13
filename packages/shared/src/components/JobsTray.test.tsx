// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetJobsTray, applyJobUpdate } from '../lib/jobs-tray'
import { JobsTray } from './JobsTray'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Go-live week review (2026-11-12): the header read "1 job finished" under a green check for a
// job that failed, and a cancelled row kept a spinner with no words.
describe('JobsTray — says what happened', () => {
  let host: HTMLDivElement
  let unmount: () => void
  beforeEach(() => {
    localStorage.clear()
    __resetJobsTray()
  })
  afterEach(() => {
    unmount?.()
    host?.remove()
  })
  async function render() {
    host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <JobsTray />
        </QueryClientProvider>
      )
    })
    unmount = () => act(() => root.unmount())
    return document.querySelector('[data-jobs-tray]') as HTMLElement
  }

  it('a failed job reads as failed in the header', async () => {
    applyJobUpdate({ key: 'a', kind: 'export', label: 'Export', status: 'error', error: 'x' })
    const tray = await render()
    expect(tray.dataset.jobsTrayTone).toBe('failed')
    expect(tray.querySelector('[data-jobs-tray-head]')?.textContent).toBe('1 job failed')
  })

  it('a cancelled job with no outcome still says it was cancelled, with no spinner', async () => {
    applyJobUpdate({ key: 'b', kind: 'import', label: 'PO import', status: 'canceled' })
    const tray = await render()
    const row = tray.querySelector('[data-job="b"]') as HTMLElement
    expect(row.textContent).toContain('Cancelled')
    expect(row.querySelector('.animate-spin')).toBeNull()
  })
})
