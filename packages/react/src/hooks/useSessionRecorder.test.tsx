// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The full-mode recorder stops for good when the events endpoint refuses the recording or the
 * person (staging 2026-10-23: a View-as session ended and the recorder kept posting into
 * 401 MASQUERADE_EXPIRED).
 */

const rr = vi.hoisted(() => ({
  emit: null as ((event: unknown) => void) | null,
  opts: null as Record<string, unknown> | null,
  stop: vi.fn(),
  takeFullSnapshot: vi.fn()
}))
vi.mock('rrweb', () => {
  const record = Object.assign(
    (opts: { emit: (event: unknown) => void }) => {
      rr.emit = opts.emit
      rr.opts = opts
      return rr.stop
    },
    {
      addCustomEvent: vi.fn(),
      takeFullSnapshot: (c?: boolean) => rr.takeFullSnapshot(c)
    }
  )
  return { record }
})

import { useSessionRecorder } from './useSessionRecorder'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESUME_KEY = 'nvr_replay_resume:test'

type Cmd = { _method?: string; _path?: string }

function fakeClient(eventsError: unknown) {
  const calls: string[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      const key = `${cmd._method} ${cmd._path}`
      calls.push(key)
      if (cmd._path === '/session-recordings/enabled') return { data: { enabled: true } }
      if (cmd._path === '/session-recordings/start') return { data: { id: 'R1' } }
      if (cmd._path?.endsWith('/events')) throw eventsError
      return { data: null }
    })
  }
  return { client: client as unknown as NivaroClient, calls }
}

function Recorder({ client }: { client: NivaroClient }) {
  useSessionRecorder({ client, app: 'test' })
  return null
}

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  rr.emit = null
  rr.opts = null
  rr.stop.mockClear()
  rr.takeFullSnapshot.mockClear()
  sessionStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
})

async function mount(client: NivaroClient) {
  root = createRoot(host as HTMLDivElement)
  await act(async () => {
    root?.render(createElement(Recorder, { client }))
    await flushPromises()
  })
  await act(async () => {
    await flushPromises()
  })
}

/** The page hides: the recorder flushes what it buffered. */
async function hide() {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
  })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
}

describe('useSessionRecorder: a refused recording stops', () => {
  for (const [status, code] of [
    [401, 'MASQUERADE_EXPIRED'],
    [403, 'FORBIDDEN'],
    [409, 'RECORDING_CLOSED']
  ] as const) {
    it(`stops recording and drops its queue on ${status} from the events endpoint`, async () => {
      const err = Object.assign(new Error('refused'), { status, response: { code } })
      const { client, calls } = fakeClient(err)
      await mount(client)
      expect(rr.emit).toBeTypeOf('function')

      rr.emit?.({ type: 2, timestamp: 1 })
      rr.emit?.({ type: 3, timestamp: 2 })
      await hide()
      const posts = () => calls.filter((c) => c.endsWith('/events')).length
      expect(posts()).toBe(1)
      expect(rr.stop).toHaveBeenCalled()

      // Nothing after that: no retry, no pagehide keepalive, no second flush.
      rr.emit?.({ type: 3, timestamp: 3 })
      await hide()
      await act(async () => {
        window.dispatchEvent(new Event('pagehide'))
        window.dispatchEvent(new Event('online'))
        await flushPromises()
      })
      expect(posts()).toBe(1)
      expect(sessionStorage.getItem(RESUME_KEY)).toBeNull()
      // A dead recording takes no end call on unmount either.
      act(() => root?.unmount())
      root = null
      await flushPromises()
      expect(calls.filter((c) => c.endsWith('/end'))).toEqual([])
    })
  }

  it('a 401 on a resumed recording ends it: no fresh recording is started into the same 401', async () => {
    sessionStorage.setItem(
      RESUME_KEY,
      JSON.stringify({ recordingId: 'OLD', nextSeq: 4, startedAt: 1, lastActivityAt: Date.now() })
    )
    const err = Object.assign(new Error('expired'), {
      status: 401,
      response: { code: 'MASQUERADE_EXPIRED' }
    })
    const { client, calls } = fakeClient(err)
    await mount(client)
    rr.emit?.({ type: 2, timestamp: 1 })
    await hide()
    await act(async () => {
      await flushPromises()
    })
    expect(calls.filter((c) => c.endsWith('/events'))).toEqual([
      'POST /session-recordings/OLD/events'
    ])
    expect(calls).not.toContain('POST /session-recordings/start')
    expect(rr.stop).toHaveBeenCalled()
    expect(sessionStorage.getItem(RESUME_KEY)).toBeNull()
  })

  it('a 400 drops that batch and keeps recording', async () => {
    const err = Object.assign(new Error('bad'), { status: 400 })
    const { client, calls } = fakeClient(err)
    await mount(client)
    rr.emit?.({ type: 2, timestamp: 1 })
    await hide()
    rr.emit?.({ type: 3, timestamp: 2 })
    await hide()
    // Each batch tried once, never looped; the recorder is still running.
    expect(calls.filter((c) => c.endsWith('/events')).length).toBe(2)
    expect(rr.stop).not.toHaveBeenCalled()
  })
})

describe('useSessionRecorder: checkouts follow activity (2026-10-24 size cap)', () => {
  it('no rrweb 60 s checkout; a self-updating idle page snapshots every 15 min, a click after 1 min', async () => {
    const { client } = fakeClient(Object.assign(new Error('no'), { status: 500 }))
    await mount(client)
    expect(rr.opts).not.toBeNull()
    expect(rr.opts?.checkoutEveryNms).toBeUndefined()

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    try {
      const t0 = Date.now()
      rr.emit?.({ type: 2, timestamp: t0 })
      // A live page changing itself every 30 s, nobody there, for 14 minutes: no snapshot.
      for (let m = 1; m <= 28; m++) {
        vi.setSystemTime(t0 + m * 30_000)
        rr.emit?.({ type: 3, data: { source: 0 } })
      }
      vi.runOnlyPendingTimers()
      expect(rr.takeFullSnapshot).not.toHaveBeenCalled()
      // Past 15 minutes: one.
      vi.setSystemTime(t0 + 15 * 60_000 + 1)
      rr.emit?.({ type: 3, data: { source: 0 } })
      vi.runOnlyPendingTimers()
      expect(rr.takeFullSnapshot).toHaveBeenCalledTimes(1)
      expect(rr.takeFullSnapshot).toHaveBeenCalledWith(true)

      // The snapshot arrives; someone clicks; a minute later the next one is due.
      const t1 = Date.now()
      rr.emit?.({ type: 2, timestamp: t1 })
      vi.setSystemTime(t1 + 5_000)
      rr.emit?.({ type: 3, data: { source: 2 } })
      vi.setSystemTime(t1 + 60_000)
      rr.emit?.({ type: 3, data: { source: 0 } })
      vi.runOnlyPendingTimers()
      expect(rr.takeFullSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
