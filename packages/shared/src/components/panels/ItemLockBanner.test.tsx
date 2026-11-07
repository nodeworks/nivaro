// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  type CollectionUpdateEvent,
  type RealtimeAdapter,
  RealtimeContext
} from '../../lib/realtime'
import { holdsLockByTakeOver } from '../item-edit/FieldAffordances'
import { ItemLockBanner, TAKEOVER_HOLD_MS, takenAwayText, useItemLock } from './ItemLockBanner'

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

  it('a form off screen (background workspace tab) lets its lock go at once and takes it back when shown', async () => {
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
    await flush()
    expect(said(calls, 'DELETE')).toHaveLength(1)
    expect(lock?.acquired).toBe(false)
    render(true)
    await flush()
    expect(said(calls, 'POST')).toHaveLength(2)
  })
})

describe('useItemLock — held only while this tab is the focused edit surface (2026-10-28)', () => {
  let focus = true
  let hasFocusSpy: { mockRestore: () => void } | null = null
  beforeEach(() => {
    focus = true
    hasFocusSpy = vi.spyOn(document, 'hasFocus').mockImplementation(() => focus)
  })
  afterEach(() => {
    hasFocusSpy?.mockRestore()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  async function claimed() {
    vi.useFakeTimers()
    const answer = { holder: null as null | Record<string, unknown> }
    const { client, calls } = fakeClient((cmd) => {
      if (cmd._method === 'POST' && cmd._path === '/item-locks/workflows/7/lock' && answer.holder)
        throw { status: 409, response: answer.holder }
      if (cmd._method === 'GET' && answer.holder) return { data: answer.holder }
      return { data: null }
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
    })
    expect(lock?.acquired).toBe(true)
    return { calls, answer, client }
  }

  it('beats every 10 s and says so (the server grants the 30 s lease)', async () => {
    const { calls } = await claimed()
    const lockPost = calls.find((c) => c._method === 'POST' && c._path.endsWith('/lock')) as
      | (Cmd & { _body?: { beat_ms?: number } })
      | undefined
    expect(lockPost?._body?.beat_ms).toBe(10_000)
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    const beats = calls.filter((c) => c._path.endsWith('/heartbeat')) as Array<
      Cmd & { _body?: { beat_ms?: number } }
    >
    expect(beats).toHaveLength(1)
    expect(beats[0]._body?.beat_ms).toBe(10_000)
  })

  it('window blur releases after the debounce; an in-page iframe or popover blur does not', async () => {
    const { calls } = await claimed()
    // Focus moved into an iframe of this page: the window blurs but still has focus.
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(1_600)
    })
    expect(said(calls, 'DELETE')).toHaveLength(0)
    expect(lock?.acquired).toBe(true)
    // …and then on to another app: no event up here — the poll notices.
    focus = false
    await act(async () => {
      vi.advanceTimersByTime(2_100)
    })
    expect(said(calls, 'DELETE')).toHaveLength(1)
    expect(lock?.acquired).toBe(false)
    // Back: taken again silently.
    focus = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(said(calls, 'POST')).toHaveLength(2)
    expect(lock?.acquired).toBe(true)
  })

  it('an open file picker keeps the lock until it closes; a picker left open lets go after 5 min', async () => {
    const { calls } = await claimed()
    const input = document.createElement('input')
    input.type = 'file'
    document.body.appendChild(input)
    try {
      // Upload clicked: the native picker takes window focus.
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      focus = false
      await act(async () => {
        window.dispatchEvent(new Event('blur'))
        vi.advanceTimersByTime(60_000)
      })
      expect(said(calls, 'DELETE')).toHaveLength(0)
      expect(lock?.acquired).toBe(true)
      // File chosen: focus comes back, nothing was released or retaken.
      focus = true
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
        window.dispatchEvent(new Event('focus'))
      })
      expect(said(calls, 'DELETE')).toHaveLength(0)
      expect(said(calls, 'POST')).toHaveLength(1)

      // Picker cancelled while the person is already in another app: ordinary rule.
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      focus = false
      await act(async () => {
        window.dispatchEvent(new Event('blur'))
        vi.advanceTimersByTime(10_000)
        input.dispatchEvent(new Event('cancel', { bubbles: true }))
        vi.advanceTimersByTime(1_600)
      })
      expect(said(calls, 'DELETE')).toHaveLength(1)
      expect(lock?.acquired).toBe(false)

      // Back, then a picker left open on an empty desk: released at the 5 min cap.
      focus = true
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })
      await flush()
      expect(lock?.acquired).toBe(true)
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      focus = false
      await act(async () => {
        window.dispatchEvent(new Event('blur'))
        vi.advanceTimersByTime(4 * 60_000)
      })
      expect(lock?.acquired).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(60_000 + 100)
      })
      expect(lock?.acquired).toBe(false)
    } finally {
      input.remove()
    }
  })

  it('a quick blur-and-back inside the debounce keeps the lock', async () => {
    const { calls } = await claimed()
    focus = false
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(800)
    })
    focus = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      vi.advanceTimersByTime(2_000)
    })
    expect(said(calls, 'DELETE')).toHaveLength(0)
    expect(lock?.acquired).toBe(true)
  })

  it('a hidden tab lets go at once with a keepalive release', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    const orig = globalThis.fetch
    globalThis.fetch = fetchSpy as never
    try {
      await claimed()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await flush()
      expect(lock?.acquired).toBe(false)
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain('/api/item-locks/workflows/7/lock/release')
      expect(init.keepalive).toBe(true)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('someone took it while I was away: read-only with their name, my edits untouched', async () => {
    const { calls, answer } = await claimed()
    focus = false
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(1_600)
    })
    expect(lock?.acquired).toBe(false)
    answer.holder = { locked_by: 'u-2', locked_by_name: 'Hector' }
    focus = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(said(calls, 'POST')).toHaveLength(2)
    expect(lock?.acquired).toBe(false)
    expect(lock?.isReadOnly).toBe(true)
    expect(lock?.lockHolder?.locked_by_name).toBe('Hector')
  })
})

describe('useItemLock — a lock someone else holds', () => {
  function fakeFeed() {
    const subs = new Set<(ev: CollectionUpdateEvent) => void>()
    const adapter: RealtimeAdapter = {
      subscribeCollections: (_cols, cb) => {
        subs.add(cb)
        return () => subs.delete(cb)
      },
      on: () => () => {},
      emit: () => {}
    }
    const send = (ev: CollectionUpdateEvent) => {
      for (const cb of subs) cb(ev)
    }
    return { adapter, send }
  }

  it('clears the banner when the holder lets go (the $lock notice)', async () => {
    let held = true
    const { client } = fakeClient(() => ({
      data: held ? { locked_by: 'u-2', locked_by_name: 'Howard' } : null
    }))
    const feed = fakeFeed()
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <RealtimeContext.Provider value={feed.adapter}>
            <Probe />
          </RealtimeContext.Provider>
        </NivaroProvider>
      )
    )
    await flush()
    expect(lock?.isReadOnly).toBe(true)
    held = false
    // Another record's notice and a non-lock change are not this lock.
    await act(async () =>
      feed.send({ collection: 'workflows', item: '8', changed_fields: ['$lock'] })
    )
    await act(async () =>
      feed.send({ collection: 'workflows', item: '7', changed_fields: ['name'] })
    )
    expect(lock?.isReadOnly).toBe(true)
    await act(async () =>
      feed.send({ collection: 'workflows', item: '7', changed_fields: ['$lock'] })
    )
    await flush()
    expect(lock?.isReadOnly).toBe(false)
    expect(lock?.lockHolder).toBeNull()
  })

  it('a lock taken while I only look turns the form read-only (the releaser cannot save over it)', async () => {
    let holder: unknown = null
    const { client } = fakeClient(() => ({ data: holder }))
    const feed = fakeFeed()
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <RealtimeContext.Provider value={feed.adapter}>
            <Probe />
          </RealtimeContext.Provider>
        </NivaroProvider>
      )
    )
    await flush()
    expect(lock?.isReadOnly).toBe(false)
    holder = { locked_by: 'u-3', locked_by_name: 'Andy' }
    await act(async () =>
      feed.send({ collection: 'workflows', item: '7', changed_fields: ['$lock'] })
    )
    await flush()
    expect(lock?.lockHolder?.locked_by_name).toBe('Andy')
  })

  it('re-checks on a slow poll when no notice arrives', async () => {
    vi.useFakeTimers()
    let held = true
    const { client } = fakeClient(() => ({
      data: held ? { locked_by: 'u-2', locked_by_name: 'Howard' } : null
    }))
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <Probe />
        </NivaroProvider>
      )
    )
    await flush()
    expect(lock?.isReadOnly).toBe(true)
    held = false
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    await flush()
    expect(lock?.isReadOnly).toBe(false)
  })

  it('"Ask to be next" on a lock nobody holds any more drops the banner', async () => {
    const { client } = fakeClient((cmd) =>
      cmd._path.endsWith('/lock/queue')
        ? { data: { position: null, free: true, queue: [] } }
        : { data: { locked_by: 'u-2', locked_by_name: 'Howard' } }
    )
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <Probe />
        </NivaroProvider>
      )
    )
    await flush()
    expect(lock?.isReadOnly).toBe(true)
    await act(async () => {
      await lock?.joinQueue()
    })
    expect(lock?.isReadOnly).toBe(false)
    expect(lock?.myPosition).toBeNull()
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

describe('useItemLock — the approval edit lock refuses the holder', () => {
  it('a 403 EDIT_LOCKED on a claim leaves the lock unheld and does not retry per keystroke', async () => {
    const { client, calls } = fakeClient((cmd) => {
      if (cmd._method === 'POST')
        throw Object.assign(new Error('Forbidden'), {
          status: 403,
          response: { code: 'EDIT_LOCKED', error: 'This record is in approval' }
        })
      return { data: null }
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
      await lock?.claim()
    })
    expect(said(calls, 'POST')).toHaveLength(1)
    expect(lock?.acquired).toBe(false)
  })

  it('a claim that cannot reach the server waits instead of firing again (offline)', async () => {
    const { client, calls } = fakeClient((cmd) => {
      if (cmd._method === 'POST') throw new TypeError('Failed to fetch')
      return { data: null }
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
      for (let i = 0; i < 5; i++) await lock?.claim()
    })
    expect(said(calls, 'POST')).toHaveLength(1)
    // Back online: the next edit claims again.
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await act(async () => {
      await lock?.claim()
    })
    expect(said(calls, 'POST')).toHaveLength(2)
  })
})

// a10-4: "An edit lock is held only by someone actually editing" — a form
// that saved and sits clean let other people wait up to 5 minutes.
describe('useItemLock — a clean form lets its lock go (a10-4)', () => {
  function DirtyProbe({ dirty }: { dirty: boolean }) {
    lock = useItemLock('workflows', '7', true, { lazy: true, dirty })
    return null
  }

  it('lets go once the form is clean, re-takes nothing on its own, and the next edit claims it', async () => {
    vi.useFakeTimers()
    let held = true
    const { client, calls } = fakeClient((cmd) => {
      // The lock is gone server side once released: the heartbeat answers 404.
      if (cmd._path.endsWith('/heartbeat') && !held)
        throw { status: 404, response: { error: 'You do not hold a lock on this item' } }
      if (cmd._method === 'DELETE') held = false
      if (cmd._method === 'POST' && cmd._path.endsWith('/lock')) held = true
      return { data: null }
    })
    const render = (dirty: boolean) =>
      act(() =>
        root.render(
          <NivaroProvider client={client}>
            <DirtyProbe dirty={dirty} />
          </NivaroProvider>
        )
      )
    render(true)
    await flush()
    await act(async () => {
      await lock?.claim()
    })
    expect(lock?.acquired).toBe(true)
    // Saved: clean. A quick edit right after keeps it (no drop + re-take)…
    render(false)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    render(true)
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(said(calls, 'DELETE')).toHaveLength(0)
    // …a form that stays clean lets go.
    render(false)
    await act(async () => {
      vi.advanceTimersByTime(1_600)
    })
    await flush()
    expect(said(calls, 'DELETE')).toHaveLength(1)
    expect(lock?.acquired).toBe(false)
    // No heartbeat, no re-take while clean.
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(said(calls, 'POST')).toHaveLength(1)
    // The next real edit takes it again.
    render(true)
    await act(async () => {
      await lock?.claim()
    })
    expect(said(calls, 'POST')).toHaveLength(2)
    expect(lock?.acquired).toBe(true)
  })

  it('a take-over into a clean form keeps the lock a minute, then lets it go (army6 M28, b09-N5)', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeClient(() => ({ data: null }))
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <DirtyProbe dirty={false} />
        </NivaroProvider>
      )
    )
    await flush()
    await act(async () => {
      await lock?.takeOver()
    })
    expect(lock?.acquired).toBe(true)
    expect(holdsLockByTakeOver()).toBe(true)
    // The clean release no longer hands it straight back to the person displaced.
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    await flush()
    expect(said(calls, 'DELETE')).toHaveLength(0)
    expect(lock?.acquired).toBe(true)
    // Still clean a minute later: it goes, and the typing gate is back.
    await act(async () => {
      vi.advanceTimersByTime(TAKEOVER_HOLD_MS)
    })
    await flush()
    expect(said(calls, 'DELETE')).toHaveLength(1)
    expect(lock?.acquired).toBe(false)
    expect(holdsLockByTakeOver()).toBe(false)
  })

  it('after a take-over, an edit then a save lets go at the usual beat', async () => {
    vi.useFakeTimers()
    const { client, calls } = fakeClient(() => ({ data: null }))
    const render = (dirty: boolean) =>
      act(() =>
        root.render(
          <NivaroProvider client={client}>
            <DirtyProbe dirty={dirty} />
          </NivaroProvider>
        )
      )
    render(false)
    await flush()
    await act(async () => {
      await lock?.takeOver()
    })
    render(true)
    render(false)
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    await flush()
    expect(said(calls, 'DELETE')).toHaveLength(1)
  })

  it("the displaced person's heartbeat hears taken_over on a free lock and does not take it back", async () => {
    vi.useFakeTimers()
    let mine = true
    const { client, calls } = fakeClient((cmd) => {
      if (cmd._path.endsWith('/heartbeat') && !mine)
        throw {
          status: 404,
          response: { locked_by: null, taken_over: true, taken_over_by_name: 'Sudharsan K' }
        }
      return { data: null }
    })
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <DirtyProbe dirty={true} />
        </NivaroProvider>
      )
    )
    await flush()
    await act(async () => {
      await lock?.claim()
    })
    expect(said(calls, 'POST')).toHaveLength(1)
    mine = false
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    await flush()
    // A dirty form would re-take a plainly free lock; a take-over says stop.
    expect(said(calls, 'POST')).toHaveLength(1)
    expect(lock?.acquired).toBe(false)
  })

  it('a lock lost while clean is not taken back by the heartbeat', async () => {
    vi.useFakeTimers()
    let held = true
    const { client, calls } = fakeClient((cmd) => {
      if (cmd._path.endsWith('/heartbeat') && !held)
        throw { status: 404, response: { error: 'You do not hold a lock on this item' } }
      return { data: null }
    })
    act(() =>
      root.render(
        <NivaroProvider client={client}>
          <DirtyProbe dirty={false} />
        </NivaroProvider>
      )
    )
    await flush()
    // Taken explicitly (Lock again) while clean, then the row vanished.
    await act(async () => {
      await lock?.relock()
    })
    held = false
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    await flush()
    expect(said(calls, 'POST')).toHaveLength(1)
    expect(lock?.acquired).toBe(false)
  })
})

describe('Take over (a10-6)', () => {
  const holder = { locked_by: 'u-2', locked_by_name: 'Paul Babson', may_take_over: true }
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === text) as
      | HTMLButtonElement
      | undefined

  it('asks first — the holder may have unsaved changes', () => {
    const onTakeOver = vi.fn()
    act(() =>
      root.render(
        <ItemLockBanner lockHolder={holder} onTakeOver={onTakeOver} takingOver={false} isAdmin />
      )
    )
    act(() => button('Take over')?.click())
    expect(onTakeOver).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Paul Babson may have unsaved changes')
    act(() => button('Cancel')?.click())
    expect(button('Take over')).toBeTruthy()
    act(() => button('Take over')?.click())
    act(() => button('Take over anyway')?.click())
    expect(onTakeOver).toHaveBeenCalledTimes(1)
  })

  it('the person pushed out is told who took over, not that they were away', () => {
    expect(takenAwayText(true, 'Ben Boulanger')).toMatch(/^Ben Boulanger took over editing/)
    expect(takenAwayText(false)).toMatch(/while you were away/)
  })

  it('coming back to a lock force-taken meanwhile says "took over"', async () => {
    vi.useFakeTimers()
    const focus = { on: true }
    const spy = vi.spyOn(document, 'hasFocus').mockImplementation(() => focus.on)
    const taken = { by: null as null | Record<string, unknown> }
    const { client } = fakeClient((cmd) => {
      if (cmd._method === 'POST' && cmd._path.endsWith('/lock') && taken.by)
        throw { status: 409, response: taken.by }
      return { data: taken.by }
    })
    const { toast } = await import('sonner')
    const warn = vi.spyOn(toast, 'warning')
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
    focus.on = false
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(1_600)
    })
    taken.by = { locked_by: 'u-ben', locked_by_name: 'Ben Boulanger', taken_over: true }
    focus.on = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Ben Boulanger took over editing/))
    warn.mockRestore()
    spy.mockRestore()
  })
})
