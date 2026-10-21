// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LAYOUT_PUSH_SETTLE_MS, useLayoutEditingQuiet } from './layout-editing-quiet'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let state: ReturnType<typeof useLayoutEditingQuiet>

function Probe({ editing }: { editing: boolean }) {
  state = useLayoutEditingQuiet(editing)
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('useLayoutEditingQuiet (record page layoutEditing)', () => {
  it('is off with no layout session', () => {
    act(() => root.render(<Probe editing={false} />))
    expect(state.layoutEditing).toBe(false)
  })

  it('stays on after close until the last save settles plus the push gap', async () => {
    act(() => root.render(<Probe editing={true} />))
    expect(state.layoutEditing).toBe(true)

    const saved = deferred()
    act(() => {
      state.settle(saved.promise)
      root.render(<Probe editing={false} />)
    })
    // Closed, save still in flight: its push has not even been sent.
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(state.layoutEditing).toBe(true)

    await act(async () => saved.resolve())
    await act(async () => vi.advanceTimersByTimeAsync(LAYOUT_PUSH_SETTLE_MS - 100))
    expect(state.layoutEditing).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(state.layoutEditing).toBe(false)
  })

  it('a failed save ends the tail too', async () => {
    act(() => root.render(<Probe editing={false} />))
    act(() => state.settle(Promise.reject(new Error('conflict'))))
    expect(state.layoutEditing).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(LAYOUT_PUSH_SETTLE_MS + 10))
    expect(state.layoutEditing).toBe(false)
  })

  it("an earlier session's tail never ends a later one", async () => {
    act(() => root.render(<Probe editing={false} />))
    act(() => state.settle(Promise.resolve()))
    // Reopened and closed again before the first tail ran out, second save still pending.
    const second = deferred()
    await act(async () => vi.advanceTimersByTimeAsync(LAYOUT_PUSH_SETTLE_MS - 500))
    act(() => state.settle(second.promise))
    await act(async () => vi.advanceTimersByTimeAsync(LAYOUT_PUSH_SETTLE_MS))
    expect(state.layoutEditing).toBe(true)
    await act(async () => second.resolve())
    await act(async () => vi.advanceTimersByTimeAsync(LAYOUT_PUSH_SETTLE_MS + 10))
    expect(state.layoutEditing).toBe(false)
  })
})
