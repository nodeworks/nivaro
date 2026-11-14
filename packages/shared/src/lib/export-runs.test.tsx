// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; title: unknown; opts?: Record<string, unknown> }>
}))
vi.mock('sonner', () => {
  const make = (kind: string) => (title: unknown, opts?: Record<string, unknown>) => {
    toasts.calls.push({ kind, title, opts })
    return 1
  }
  const toast = Object.assign(make('plain'), {
    success: make('success'),
    error: make('error'),
    info: make('info'),
    warning: make('warning'),
    message: make('message'),
    dismiss: () => {}
  })
  return { toast }
})

import { JobsTray } from '../components/JobsTray'
import { __resetExportRuns, followExportRun, startLocalExport } from './export-runs'
import { __resetJobsTray, applyJobUpdate } from './jobs-tray'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Exports with visible progress (#2122 follow-up): one Jobs-tray row per export with rows done
// of the total and Cancel; the tab that started it downloads the file when it is ready.
describe('export progress', () => {
  let host: HTMLDivElement
  let unmount: () => void
  const clicks: string[] = []
  beforeEach(() => {
    localStorage.clear()
    __resetJobsTray()
    __resetExportRuns()
    toasts.calls.length = 0
    clicks.length = 0
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicks.push(this.getAttribute('href') ?? '')
    })
  })
  afterEach(() => {
    unmount?.()
    host?.remove()
    vi.restoreAllMocks()
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

  it('shows rows done of the total with a bar, and Cancel stops a local export', async () => {
    const job = startLocalExport('Workflows', 86_000)
    job.progress(12_400)
    const tray = await render()
    const row = tray.querySelector(`[data-job="${job.key}"]`) as HTMLElement
    expect(row.textContent).toContain('Exporting Workflows')
    expect(row.textContent).toContain('Reading rows · 12,400 of 86,000 rows')
    const bar = row.querySelector('.bg-nvr-cyan') as HTMLElement
    expect(bar.style.width).toBe('14%')
    const cancel = row.querySelector('[data-job-cancel]') as HTMLButtonElement
    expect(cancel).toBeTruthy()
    await act(async () => {
      cancel.click()
    })
    expect(job.signal.aborted).toBe(true)
    await act(async () => {
      job.cancelled()
    })
    const after = tray.querySelector(`[data-job="${job.key}"]`) as HTMLElement
    expect(after.dataset.jobStatus).toBe('canceled')
    expect(toasts.calls.some((t) => t.title === 'Export cancelled')).toBe(true)
  })

  it('never stores a tab-local export (a closed tab cannot leave it running elsewhere)', () => {
    startLocalExport('Workflows', 10)
    applyJobUpdate({ key: 'job:9', kind: 'export', label: 'Other', status: 'running' })
    const stored = JSON.parse(localStorage.getItem('nvr:jobs-tray:v1') ?? '[]') as Array<{
      key: string
    }>
    expect(stored.map((j) => j.key)).toEqual(['job:9'])
  })

  it('a server export downloads in the tab that started it when it is ready', async () => {
    followExportRun({
      mode: 'background',
      run_id: 41,
      key: 'job:41',
      label: 'Exporting “Friday finance”',
      total: 86_000,
      cancel_path: '/export-runs/41/cancel'
    })
    const tray = await render()
    const row = tray.querySelector('[data-job="job:41"]') as HTMLElement
    expect(row.textContent).toContain('Exporting “Friday finance”')
    expect(row.querySelector('[data-job-cancel]')).toBeTruthy()
    expect(clicks).toHaveLength(0)
    await act(async () => {
      applyJobUpdate({
        key: 'job:41',
        status: 'running',
        progress: { phase: 'Reading rows', done: 12_400, total: 86_000, unit: 'rows' }
      })
    })
    expect(row.textContent).toContain('12,400 of 86,000 rows')
    await act(async () => {
      applyJobUpdate({
        key: 'job:41',
        status: 'completed',
        outcome: '86,000 rows · Friday finance.xlsx → file f0000000-0000-0000-0000-000000000001',
        file_id: 'f0000000-0000-0000-0000-000000000001'
      })
    })
    expect(clicks).toEqual(['/api/files/f0000000-0000-0000-0000-000000000001?download=1'])
    const ready = toasts.calls.find((t) => t.kind === 'success')
    expect(ready?.title).toBe('Your export is ready')
    expect(ready?.opts?.description).toBe('86,000 rows · Friday finance.xlsx')
    // Once only: a later tick for the same key downloads nothing more.
    await act(async () => {
      applyJobUpdate({
        key: 'job:41',
        status: 'completed',
        file_id: 'f0000000-0000-0000-0000-000000000001'
      })
    })
    expect(clicks).toHaveLength(1)
  })

  it('a failed server export is told through describeError, never as raw text', async () => {
    followExportRun({
      mode: 'background',
      run_id: 42,
      key: 'job:42',
      label: 'Exporting Workflows',
      total: null,
      cancel_path: '/export-runs/42/cancel'
    })
    await act(async () => {
      applyJobUpdate({
        key: 'job:42',
        status: 'error',
        error:
          'RequestError: Timeout: Request failed to complete in 15000ms at Connection.requestTimeout (node_modules/tedious/lib/connection.js:1117)'
      })
    })
    const err = toasts.calls.find((t) => t.kind === 'error')
    expect(err).toBeTruthy()
    expect(String(err?.title)).not.toMatch(/tedious|RequestError|connection\.js/)
    expect(clicks).toHaveLength(0)
  })
})
