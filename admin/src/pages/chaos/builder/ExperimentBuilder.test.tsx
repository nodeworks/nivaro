// #2844 the experiment builder: steps, caps, the two-click Run, and degrading optional sources.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, type vi } from 'vitest'
import { api } from '@/lib/api'
import type { CatalogFault } from '../api'
import { ExperimentBuilder } from './ExperimentBuilder'

const getMock = api.get as unknown as ReturnType<typeof vi.fn>
const postMock = api.post as unknown as ReturnType<typeof vi.fn>

const slow: CatalogFault = {
  key: 'slow_requests',
  label: 'Slow requests',
  area: 'http',
  proves: 'Slow answers stay honest.',
  claim_keys: ['http.slow_honest'],
  targets: ['all', 'route', 'share'],
  params: {
    delay_ms: { type: 'number', label: 'Delay', min: 100, max: 5000, default: 1500, unit: 'ms' }
  },
  max_seconds: 300,
  default_seconds: 30,
  points: ['http.request'],
  danger: 'low',
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }],
  console_href: null,
  last_run: null
}

let preflightOk = true
let caps: unknown = null

function answers(url: string) {
  const ok = (data: unknown) => Promise.resolve({ data: { data } })
  if (url === '/chaos/status') return ok({ allowed: true, reason: null, armed: [], nodes: ['n1'] })
  if (url === '/chaos/catalog') return ok({ refusal: null, store: 'memory', faults: [slow] })
  if (url === '/chaos/preflight')
    return ok({
      ok: preflightOk,
      checks: [
        { key: 'deploy', label: 'No deploy running', ok: preflightOk, why: 'A deploy is running' }
      ]
    })
  // Caps come from GET /chaos/operator (#2862): readable by every chaos operator, not only admins.
  if (url === '/chaos/operator')
    return ok({ operator: true, admin: false, allowed: true, instance: 'dev', caps })
  if (url === '/chaos/settings') return Promise.reject({ response: { status: 403 } })
  if (url === '/chaos/samplers') return Promise.reject({ response: { status: 404 } })
  return ok([])
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ExperimentBuilder fault={slow} variant='tab' />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const step = async (name: RegExp) =>
  within(await screen.findByRole('navigation', { name: 'Steps' })).getByRole('button', { name })

beforeEach(() => {
  preflightOk = true
  caps = null
  getMock.mockReset()
  getMock.mockImplementation((url: string) => answers(url))
  postMock.mockReset()
  postMock.mockResolvedValue({
    data: { data: { run: { id: 'r1' }, fault: { id: 'f1', started_at: 0, ends_at: 30_000 } } }
  })
})

describe('ExperimentBuilder (#2844)', () => {
  it('arms only on the second click, naming the fault, target and duration', async () => {
    mount()
    const run = await screen.findByRole('button', { name: /^Run$/ })
    await waitFor(() => expect(run).toBeEnabled())
    fireEvent.click(run)
    expect(postMock).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', {
      name: /Confirm — arms Slow requests on everything for 30s/
    })
    fireEvent.click(confirm)
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1))
    expect(postMock.mock.calls[0][0]).toBe('/chaos/runs')
    expect(postMock.mock.calls[0][1]).toMatchObject({
      fault_key: 'slow_requests',
      target: { kind: 'all' },
      params: { delay_ms: 1500 },
      seconds: 30,
      hypothesis: slow.hypothesis_defaults,
      abort_after: 3
    })
  })

  it('sends the abort limit the abort step sets and reads it back in the summary', async () => {
    mount()
    fireEvent.click(await step(/^Abort limits/))
    const box = screen.getByRole('spinbutton', { name: /Stop after/ })
    expect(box).toHaveValue(3)
    fireEvent.change(box, { target: { value: '5' } })
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && /about 25 seconds of trouble/.test(el.textContent ?? '')
      )
    ).toBeInTheDocument()
    const summary = screen.getByRole('complementary', { name: 'This run' })
    expect(within(summary).getByText('5 bad samples in a row (about 25s)')).toBeInTheDocument()
    // Out of range is pulled back inside 1–10 when the box loses focus.
    fireEvent.change(box, { target: { value: '40' } })
    fireEvent.blur(box)
    expect(box).toHaveValue(10)
    const run = screen.getByRole('button', { name: /^Run$/ })
    await waitFor(() => expect(run).toBeEnabled())
    fireEvent.click(run)
    fireEvent.click(screen.getByRole('button', { name: /Confirm — arms/ }))
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1))
    expect(postMock.mock.calls[0][1]).toMatchObject({ abort_after: 10 })
  })

  it('keeps Run disabled and says why while pre-flight fails', async () => {
    preflightOk = false
    mount()
    expect(
      await screen.findByText(/Pre-flight is blocking this run: A deploy is running\./)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Run$/ })).toBeDisabled()
  })

  it('needs a route before a route target can run', async () => {
    mount()
    fireEvent.click(await step(/^Target/))
    fireEvent.click(screen.getByRole('radio', { name: /Routes/ }))
    expect((await screen.findAllByText(/Pick a route or type a path/)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /^Run$/ })).toBeDisabled()
  })

  it('stops the duration slider at the cap a non-admin operator reads from /chaos/operator (#2862)', async () => {
    caps = { max_seconds: 60 }
    mount()
    fireEvent.click(await step(/^Duration/))
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: 'Duration' })).toHaveAttribute('max', '60')
    )
    expect(screen.queryByRole('button', { name: '5m' })).toBeNull()
  })

  it('says "no estimate" for a fault that takes no dependency down', async () => {
    mount()
    fireEvent.click(await step(/^Blast radius/))
    expect(
      await screen.findByText(/No estimate: this fault does not take a whole dependency down/)
    ).toBeInTheDocument()
  })
})
