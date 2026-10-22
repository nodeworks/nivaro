import { createNivaro } from '@nivaro/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

// #2857 — a read that never answers ends in a TimeoutError (so the screen can show an error
// state); writes are never cut short.
const get = { _method: 'GET', _path: '/x' } as never
const post = { _method: 'POST', _path: '/x', _body: {} } as never

afterEach(() => vi.useRealTimers())

describe('SDK read timeout', () => {
  it('abandons a GET that never answers', async () => {
    vi.useFakeTimers()
    const fetcher = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const client = createNivaro('http://x', { fetch: fetcher, timeoutMs: 1000 })
    const p = client.request(get)
    const assertion = expect(p).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
  })

  it('has no timeout unless asked: no signal on a GET by default', async () => {
    let seen: RequestInit | undefined
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen = init
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    await createNivaro('http://x', { fetch: fetcher }).request(get)
    expect(seen?.signal).toBeUndefined()
  })

  it('does not attach a signal to writes', async () => {
    let seen: RequestInit | undefined
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen = init
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    await createNivaro('http://x', { fetch: fetcher, timeoutMs: 1000 }).request(post)
    expect(seen?.signal).toBeUndefined()
  })
})
