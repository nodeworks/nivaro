// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { ItemLockBanner, useItemLock } from './ItemLockBanner'

type Cmd = { _method: string; _path: string }

let host: HTMLDivElement
let root: Root
let lock: ReturnType<typeof useItemLock> | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  lock = null
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function fakeClient(answer: (cmd: Cmd) => unknown) {
  const calls: Cmd[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      return answer(cmd)
    })
  } as unknown as NivaroClient
  return { client, calls }
}

function Probe({ active = true }: { active?: boolean }) {
  lock = useItemLock('workflows', '7', true, { lazy: true, active })
  return null
}

const flush = () => act(async () => {})
const said = (calls: Cmd[], method: string) =>
  calls.filter((c) => c._method === method && c._path === '/item-locks/workflows/7/lock')

describe('useItemLock (lazy)', () => {
  it('opening a record only reads the lock; the first edit takes it', async () => {
    const { client, calls } = fakeClient(() => ({ data: null }))
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <Probe />
        </NivaroProvider>
      )
    )
    await flush()
    expect(said(calls, 'GET')).toHaveLength(1)
    expect(said(calls, 'POST')).toHaveLength(0)
    await act(async () => {
      await lock?.claim()
    })
    expect(said(calls, 'POST')).toHaveLength(1)
    expect(lock?.acquired).toBe(true)
  })

  it('a lock someone else holds turns the form read-only; my own other window does not', async () => {
    const other = fakeClient(() => ({ data: { locked_by: 'u-2', locked_by_name: 'Hector' } }))
    act(() =>
      root.render(
        <NivaroProvider client={other.client}>
          <Probe />
        </NivaroProvider>
      )
    )
    await flush()
    expect(lock?.isReadOnly).toBe(true)
    expect(lock?.lockHolder?.locked_by_name).toBe('Hector')

    act(() => root.unmount())
    root = createRoot(host)
    const mine = fakeClient(() => ({ data: { locked_by: 'u-1', is_mine: true } }))
    act(() =>
      root.render(
        <NivaroProvider client={mine.client}>
          <Probe />
        </NivaroProvider>
      )
    )
    await flush()
    expect(lock?.isReadOnly).toBe(false)
  })

  it('a form off screen lets its lock go after two minutes and takes it back when shown', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeClient(() => ({ data: null }))
    const render = (active: boolean) =>
      act(() =>
        root.render(
          <NivaroProvider client={client}>
            <Probe active={active} />
          </NivaroProvider>
        )
      )
    render(true)
    await flush()
    await act(async () => {
      await lock?.claim()
    })
    expect(said(calls, 'POST')).toHaveLength(1)
    render(false)
    await act(async () => {
      vi.advanceTimersByTime(119_000)
    })
    expect(said(calls, 'DELETE')).toHaveLength(0)
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(said(calls, 'DELETE')).toHaveLength(1)
    expect(lock?.acquired).toBe(false)
    render(true)
    await flush()
    expect(said(calls, 'POST')).toHaveLength(2)
  })
})

describe('useItemLock — records the caller cannot read', () => {
  it('a 404 from the lock routes stops every further lock request', async () => {
    const { client, calls } = fakeClient((cmd) => {
      throw Object.assign(new Error('Not found'), { status: 404, _cmd: cmd })
    })
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <Probe />
        </NivaroProvider>
      )
    )
    await flush()
    await act(async () => {
      await lock?.claim()
      await lock?.claim()
    })
    expect(said(calls, 'POST')).toHaveLength(0)
    expect(lock?.isReadOnly).toBe(false)
  })

  it('leaving the page releases a held lock through lock/release (keepalive)', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { client } = fakeClient(() => ({ data: null }))
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <Probe />
        </NivaroProvider>
      )
    )
    await flush()
    await act(async () => {
      await lock?.claim()
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/item-locks/workflows/7/lock/release',
      expect.objectContaining({ method: 'POST', keepalive: true })
    )
    vi.unstubAllGlobals()
  })
})

describe('ItemLockBanner', () => {
  const holder = { locked_by: 'u-2', locked_by_name: 'Hector' }
  const takeOverShown = () =>
    [...host.querySelectorAll('button')].some((b) => b.textContent === 'Take over')

  it('hides Take over when the server says this viewer may not use it', () => {
    act(() =>
      root.render(
        <ItemLockBanner
          lockHolder={{ ...holder, may_take_over: false }}
          onTakeOver={() => {}}
          takingOver={false}
        />
      )
    )
    expect(takeOverShown()).toBe(false)
  })

  it('offers Take over when allowed, when unknown, and always to admins', () => {
    for (const lh of [{ ...holder, may_take_over: true }, holder]) {
      act(() =>
        root.render(<ItemLockBanner lockHolder={lh} onTakeOver={() => {}} takingOver={false} />)
      )
      expect(takeOverShown()).toBe(true)
    }
    act(() =>
      root.render(
        <ItemLockBanner
          lockHolder={{ ...holder, may_take_over: false }}
          onTakeOver={() => {}}
          takingOver={false}
          isAdmin
        />
      )
    )
    expect(takeOverShown()).toBe(true)
  })
})
