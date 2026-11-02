import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The relay's limiter counts MESSAGES (60 a minute on a public key). Refused messages wait in ONE
// queue per tenant (≤ 500, oldest dropped), drained by ONE timer per tenant, at most a window's
// worth per window; while the relay is limiting, new sends go straight into the queue.

const safeFetchMock = vi.hoisted(() => vi.fn())
const h = vi.hoisted(() => ({
  phones: [] as Array<{ id: number; endpoint: string }>,
  deleted: [] as number[],
  touched: [] as number[]
}))

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const st: { op: string; ids: number[] } = { op: 'select', ids: [] }
    const b: Record<string, unknown> = {}
    const self = () => b
    Object.assign(b, {
      where: self,
      select: self,
      first: self,
      whereIn: (_c: string, ids: number[]) => {
        st.ids = ids
        return b
      },
      count: self,
      del: () => {
        st.op = 'del'
        return b
      },
      update: () => {
        st.op = 'update'
        return b
      },
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        // A select by id (the drain's live-row check) sees only rows that still exist.
        let v: unknown = st.ids.length ? h.phones.filter((p) => st.ids.includes(p.id)) : h.phones
        if (table === 'nivaro_notifications') v = { c: 0 }
        else if (table === 'nivaro_settings_overrides') v = undefined
        else if (table === 'nivaro_settings') v = { project_name: 'Acme' }
        else if (st.op === 'del') {
          h.deleted.push(...st.ids)
          v = st.ids.length
        } else if (st.op === 'update') {
          h.touched.push(...st.ids)
          v = st.ids.length
        }
        return Promise.resolve(v).then(res, rej)
      },
      catch: (f: (e: unknown) => unknown) => (b.then as any)(undefined, f)
    })
    return b
  }
  return { db }
})
vi.mock('../../../services/channel-test-mode.js', () => ({
  routePush: async (u: string) => ({ userId: u, prefix: '' })
}))
vi.mock('../../../services/traffic-taps/channels.js', () => ({
  noteChannel: vi.fn(),
  noteChannelRedirect: vi.fn()
}))
vi.mock('../../../lib/ssrf.js', () => ({ safeFetch: safeFetchMock }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://acme.example' }))
vi.mock('../../../services/swallow-counter.js', () => ({ countSwallow: () => {} }))

const { sendPhonePush } = await import('../../../services/phone-push.js')
const { RELAY_QUEUE_MAX, relayQueueSize, resetRelayQueues } = await import(
  '../../../services/relay-retry-queue.js'
)

const dev = (i: number) => String(i).padStart(20, 'z')
const phones = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: 1000 + from + i, endpoint: `relay:${dev(from + i)}` }))

/** A relay that enforces 60 messages per fixed 60 s window (as limits.ts takeToken does). */
function enforcingRelay(startFull = false) {
  const win = { start: Date.now(), used: startFull ? 60 : 0 }
  const windows = new Set<number>()
  safeFetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const msgs = JSON.parse(init.body).messages as Array<{ device: string }>
    const now = Date.now()
    if (now - win.start >= 60_000) {
      win.start = now
      win.used = 0
    }
    if (win.used + msgs.length > 60) {
      const s = Math.max(1, Math.ceil((win.start + 60_000 - now) / 1000))
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': String(s) }),
        json: async () => ({})
      }
    }
    win.used += msgs.length
    windows.add(win.start)
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: msgs.map((m) => ({ device: m.device, status: 'ok' })) })
    }
  })
  return { windows }
}

beforeEach(() => {
  vi.useFakeTimers()
  process.env.MOBILE_PUSH_RELAY_KEY = 'rk'
  h.deleted = []
  h.touched = []
  safeFetchMock.mockReset()
  resetRelayQueues()
})
afterEach(() => {
  resetRelayQueues()
  vi.useRealTimers()
  delete process.env.MOBILE_PUSH_RELAY_KEY
})

describe('relay retry queue', () => {
  it('three sends that each meet a 429 leave ONE timer; the later ones never call the relay', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    enforcingRelay(true)
    for (let k = 0; k < 3; k++) {
      h.phones = phones(5, k * 5)
      await sendPhonePush('u1', { title: 't', body: 'b' })
    }
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    expect(relayQueueSize()).toBe(15)
    warn.mockRestore()
  })

  it('120 queued messages go out over 2 windows, at most 60 each, nothing refused again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { windows } = enforcingRelay(true)
    h.phones = phones(120)
    await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(relayQueueSize()).toBe(120)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(relayQueueSize()).toBe(60)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(relayQueueSize()).toBe(0)
    expect(windows.size).toBe(2)
    const refused = (
      await Promise.all(
        safeFetchMock.mock.results.map((r) => r.value as Promise<{ status: number }>)
      )
    ).filter((r) => r.status === 429)
    expect(refused).toHaveLength(1) // only the first, inside the request
    expect(new Set(h.touched).size).toBe(120)
    expect(vi.getTimerCount()).toBe(0)
    warn.mockRestore()
  })

  it('caps the queue at 500, dropping the oldest, logged once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    enforcingRelay(true)
    h.phones = phones(300)
    await sendPhonePush('u1', { title: 't', body: 'b' })
    h.phones = phones(300, 300)
    await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(relayQueueSize()).toBe(RELAY_QUEUE_MAX)
    const drops = warn.mock.calls.filter((c) => String(c[0]).includes('dropped'))
    expect(drops).toHaveLength(1)
    warn.mockRestore()
  })

  it('a phone signed out between queue and drain is not sent to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    enforcingRelay(true)
    h.phones = phones(5)
    await sendPhonePush('u1', { title: 't', body: 'b' })
    // Row 1002 is deleted (sign-out); row 1003 now belongs to another install.
    h.phones = h.phones
      .filter((p) => p.id !== 1002)
      .map((p) => (p.id === 1003 ? { ...p, endpoint: `relay:${'q'.repeat(20)}` } : p))
    await vi.advanceTimersByTimeAsync(60_000)
    const sent = safeFetchMock.mock.calls
      .slice(1)
      .flatMap((c) => JSON.parse((c[1] as { body: string }).body).messages)
      .map((m: { device: string }) => m.device)
    expect(sent.sort()).toEqual([dev(0), dev(1), dev(4)].sort())
    expect(relayQueueSize()).toBe(0)
    warn.mockRestore()
  })

  it('an item queued more than 120 s ago is dropped, never sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    enforcingRelay(true)
    h.phones = phones(3)
    await sendPhonePush('u1', { title: 't', body: 'b' })
    // The drain comes late (a busy process): the messages are stale by then.
    vi.setSystemTime(Date.now() + 130_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
    expect(relayQueueSize()).toBe(0)
    warn.mockRestore()
  })
})
