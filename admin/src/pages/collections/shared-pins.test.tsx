import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { movePin, useSharedPins } from './shared-pins'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const toastError = vi.fn()
vi.mock('@nivaro/shared', async (orig) => ({
  ...(await orig<typeof import('@nivaro/shared')>()),
  toastError: (...a: unknown[]) => toastError(...a)
}))

const put = vi.fn()
beforeEach(() => {
  ;(api as unknown as { put: typeof put }).put = put
  put.mockReset()
  vi.mocked(api.get).mockReset()
  vi.mocked(toast.error).mockClear()
  toastError.mockClear()
  vi.mocked(toast.success).mockClear()
})

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

async function ready(initial: string[]) {
  vi.mocked(api.get).mockResolvedValue({ data: { data: { collections: initial } } })
  const hook = renderHook(() => useSharedPins(true), { wrapper: wrapper() })
  await waitFor(() => expect(hook.result.current.pins).toEqual(initial))
  return hook
}

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
    expect(api.get).toHaveBeenCalledWith('/collection-pins')
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
    await waitFor(() => expect(result.current.pins).toEqual(['workflows', 'vendors']))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/collection-pins', {
        collections: ['workflows', 'vendors']
      })
    )
    await act(async () => {
      answer({ data: { data: { collections: ['workflows', 'vendors'] } } })
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
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
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
    await waitFor(() => expect(result.current.pins).toEqual(['c', 'a', 'b']))
    await waitFor(() => expect(put).toHaveBeenCalled())
    await act(async () => {
      fail(new Error('Network Error'))
    })
    await waitFor(() => expect(result.current.pins).toEqual(['a', 'b', 'c']))
  })

  it('does not read the list when switched off', () => {
    renderHook(() => useSharedPins(false), { wrapper: wrapper() })
    expect(api.get).not.toHaveBeenCalled()
  })
})
