// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { movePin, useSharedPins } from './shared-pins'
import { cleanup, mount, waitFor } from './test-kit'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const toastError = vi.fn()
vi.mock('../../lib/error-toast', () => ({
  toastError: (...a: unknown[]) => toastError(...a)
}))

type Cmd = { _method: string; _path: string; _body?: unknown }
const getPins = vi.fn()
const put = vi.fn()
const client = {
  request: vi.fn((cmd: Cmd) =>
    cmd._method === 'PUT' ? put(cmd._path, cmd._body) : getPins(cmd._path)
  )
}

beforeEach(() => {
  put.mockReset()
  getPins.mockReset()
  client.request.mockClear()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
  toastError.mockClear()
})
afterEach(cleanup)

type Pins = ReturnType<typeof useSharedPins>

/** renderHook: the hook's latest answer, read through `result.current`. */
function renderPins(enabled = true) {
  const result = { current: null as unknown as Pins }
  function Probe() {
    result.current = useSharedPins(enabled)
    return null
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mount(
    <QueryClientProvider client={qc}>
      <NivaroProvider client={client as never}>
        <Probe />
      </NivaroProvider>
    </QueryClientProvider>
  )
  return { result }
}

async function ready(initial: string[]) {
  getPins.mockResolvedValue({ data: { collections: initial } })
  const hook = renderPins()
  await waitFor(() => JSON.stringify(hook.result.current.pins) === JSON.stringify(initial))
  return hook
}

const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)

describe('movePin', () => {
  it('moves one name up or down and stops at the ends', () => {
    expect(movePin(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(movePin(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(movePin(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(movePin(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('useSharedPins', () => {
  it('reads the shared list', async () => {
    const { result } = await ready(['workflows', 'invoices'])
    expect(getPins).toHaveBeenCalledWith('/collection-pins')
    expect(result.current.pins).toEqual(['workflows', 'invoices'])
  })

  it('pins at once, before the server answers, and keeps the stored answer', async () => {
    const { result } = await ready(['workflows'])
    let answer!: (v: unknown) => void
    put.mockReturnValue(new Promise((r) => (answer = r)))
    act(() => {
      void result.current.pin('vendors', 'Vendors')
    })
    // Shown before the server has answered (the PUT is still pending).
    await waitFor(() => same(result.current.pins, ['workflows', 'vendors']))
    await waitFor(() => put.mock.calls.length > 0)
    expect(put).toHaveBeenCalledWith('/collection-pins', { collections: ['workflows', 'vendors'] })
    await act(async () => {
      answer({ data: { collections: ['workflows', 'vendors'] } })
    })
    expect(result.current.pins).toEqual(['workflows', 'vendors'])
    expect(toast.success).toHaveBeenCalledWith('Pinned Vendors for everyone')
  })

  it('puts the list back and says so when the save fails', async () => {
    const { result } = await ready(['workflows', 'invoices'])
    put.mockRejectedValue({ response: { status: 500, data: { error: 'Internal Server Error' } } })
    await act(async () => {
      await result.current.unpin('workflows', 'Workflows')
    })
    await waitFor(() => toastError.mock.calls.length === 1)
    expect(toastError.mock.calls[0][1]).toBe('Could not save the pinned collections')
    expect(result.current.pins).toEqual(['workflows', 'invoices'])
  })

  it('reorders optimistically and rolls back on failure', async () => {
    const { result } = await ready(['a', 'b', 'c'])
    let fail!: (e: unknown) => void
    put.mockReturnValue(new Promise((_r, j) => (fail = j)))
    act(() => {
      void result.current.reorder(['c', 'a', 'b'])
    })
    await waitFor(() => same(result.current.pins, ['c', 'a', 'b']))
    await waitFor(() => put.mock.calls.length > 0)
    await act(async () => {
      fail(new Error('Network Error'))
    })
    await waitFor(() => same(result.current.pins, ['a', 'b', 'c']))
  })

  it('does not read the list when switched off', () => {
    renderPins(false)
    expect(getPins).not.toHaveBeenCalled()
  })
})
