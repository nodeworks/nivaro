import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUserCard, USER_CARD_BATCH_MAX, userCardQuery } from './user-cards'

type Cmd = { _method: string; _path: string; _body?: { ids: string[] } }

const card = (id: string) => ({
  id: id.toUpperCase(),
  first_name: id,
  last_name: null,
  email: `${id}@x`
})

function fakeClient(handler?: (cmd: Cmd) => Promise<unknown>) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (handler) return handler(cmd)
      if (cmd._path === '/users/cards') {
        return { data: (cmd._body?.ids ?? []).filter((i) => !i.startsWith('x')).map(card) }
      }
      throw new Error(`unexpected ${cmd._path}`)
    })
  }
  return { client: client as never, calls }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('loadUserCard', () => {
  it('coalesces ids asked in the same window into one POST /users/cards', async () => {
    const { client, calls } = fakeClient()
    const ps = [loadUserCard(client, 'a1'), loadUserCard(client, 'b2'), loadUserCard(client, 'c3')]
    await vi.advanceTimersByTimeAsync(5)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10)
    const out = await Promise.all(ps)
    expect(calls).toHaveLength(1)
    expect(calls[0]._method).toBe('POST')
    expect(calls[0]._body?.ids).toEqual(['a1', 'b2', 'c3'])
    expect(out.map((c) => c?.first_name)).toEqual(['a1', 'b2', 'c3'])
  })

  it('resolves each caller with its own card, matching ids case-insensitively, and dedupes', async () => {
    const { client, calls } = fakeClient()
    const p1 = loadUserCard(client, 'aa')
    const p2 = loadUserCard(client, 'AA')
    const p3 = loadUserCard(client, 'bb')
    await vi.advanceTimersByTimeAsync(20)
    expect(calls[0]._body?.ids).toEqual(['aa', 'bb'])
    const [c1, c2, c3] = await Promise.all([p1, p2, p3])
    expect(c1?.id).toBe('AA')
    expect(c2).toBe(c1)
    expect(c3?.id).toBe('BB')
  })

  it('answers null for an id the server did not return', async () => {
    const { client } = fakeClient()
    const known = loadUserCard(client, 'k1')
    const missing = loadUserCard(client, 'x-unknown')
    await vi.advanceTimersByTimeAsync(20)
    expect((await known)?.id).toBe('K1')
    expect(await missing).toBeNull()
    expect(await loadUserCard(client, null)).toBeNull()
  })

  it(`splits more than ${USER_CARD_BATCH_MAX} ids into chunks of ${USER_CARD_BATCH_MAX}`, async () => {
    const { client, calls } = fakeClient()
    const ps = Array.from({ length: 230 }, (_, i) => loadUserCard(client, `u${i}`))
    await vi.advanceTimersByTimeAsync(20)
    await Promise.all(ps)
    expect(calls.map((c) => c._body?.ids.length)).toEqual([100, 100, 30])
  })

  it('a failed chunk fails only its own callers; the next window tries again', async () => {
    let n = 0
    const { client, calls } = fakeClient(async (cmd) => {
      n++
      if (n === 1) throw Object.assign(new Error('boom'), { status: 500 })
      return { data: (cmd._body?.ids ?? []).map(card) }
    })
    const bad = Array.from({ length: 100 }, (_, i) => loadUserCard(client, `f${i}`))
    const good = loadUserCard(client, 'ok')
    const settled = Promise.allSettled([...bad, good])
    await vi.advanceTimersByTimeAsync(20)
    const res = await settled
    expect(res.slice(0, 100).every((r) => r.status === 'rejected')).toBe(true)
    expect(res[100]).toMatchObject({ status: 'fulfilled', value: { id: 'OK' } })
    const retry = loadUserCard(client, 'f0')
    await vi.advanceTimersByTimeAsync(20)
    expect((await retry)?.id).toBe('F0')
    expect(calls).toHaveLength(3)
  })

  it('falls back to one GET per id when the server has no batch route', async () => {
    const { client, calls } = fakeClient(async (cmd) => {
      if (cmd._path === '/users/cards') throw Object.assign(new Error('nf'), { status: 404 })
      const id = cmd._path.split('/')[2]
      if (id === 'gone') throw Object.assign(new Error('Not found'), { status: 404 })
      return { data: card(id) }
    })
    const a = loadUserCard(client, 'p1')
    const b = loadUserCard(client, 'gone')
    await vi.advanceTimersByTimeAsync(20)
    expect((await a)?.id).toBe('P1')
    expect(await b).toBeNull()
    // Later windows skip the batch route entirely.
    const c = loadUserCard(client, 'p2')
    await vi.advanceTimersByTimeAsync(20)
    expect((await c)?.id).toBe('P2')
    expect(calls.map((x) => `${x._method} ${x._path}`)).toEqual([
      'POST /users/cards',
      'GET /users/p1/card',
      'GET /users/gone/card',
      'GET /users/p2/card'
    ])
  })

  it('keeps one queue per client', async () => {
    const one = fakeClient()
    const two = fakeClient()
    const ps = [loadUserCard(one.client, 'a'), loadUserCard(two.client, 'b')]
    await vi.advanceTimersByTimeAsync(20)
    await Promise.all(ps)
    expect(one.calls[0]._body?.ids).toEqual(['a'])
    expect(two.calls[0]._body?.ids).toEqual(['b'])
  })
})

describe('userCardQuery', () => {
  it('uses the shared [user-card, id] key and the batched loader', async () => {
    const { client, calls } = fakeClient()
    const q = userCardQuery(client, 'z9')
    expect(q.queryKey).toEqual(['user-card', 'z9'])
    const p = q.queryFn()
    await vi.advanceTimersByTimeAsync(20)
    expect((await p)?.id).toBe('Z9')
    expect(calls[0]._path).toBe('/users/cards')
  })
})
