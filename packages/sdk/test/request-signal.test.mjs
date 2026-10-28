// Caller-cancellable requests (withSignal / Command._signal, 2026-10-28). Runs against the
// built dist: `pnpm run build && pnpm test`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNivaro, executeCustomQuery, withSignal } from '../dist/index.js'

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** A fetch that answers after `ms`, rejects when its signal aborts, and records each init.
 *  `bodyMs` delays the JSON body after the headers arrive. */
function fakeFetch({ ms = 30, bodyMs = 0 } = {}) {
  const inits = []
  const fetch = (_url, init) => {
    inits.push(init)
    return new Promise((resolve, reject) => {
      const sig = init.signal
      if (sig?.aborted) return reject(abortError())
      sig?.addEventListener('abort', () => reject(abortError()), { once: true })
      setTimeout(() => {
        resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () =>
            new Promise((res, rej) => {
              if (sig?.aborted) return rej(abortError())
              sig?.addEventListener('abort', () => rej(abortError()), { once: true })
              setTimeout(() => res({ data: [1] }), bodyMs)
            })
        })
      }, ms)
    })
  }
  return { fetch, inits }
}

/** An AbortSignal stand-in that counts its listeners. */
function countingSignal() {
  const ac = new AbortController()
  let listeners = 0
  const add = ac.signal.addEventListener.bind(ac.signal)
  const remove = ac.signal.removeEventListener.bind(ac.signal)
  ac.signal.addEventListener = (t, fn, o) => {
    listeners++
    add(t, fn, o)
  }
  ac.signal.removeEventListener = (t, fn, o) => {
    listeners--
    remove(t, fn, o)
  }
  return { ac, live: () => listeners }
}

describe('request() with a caller signal', () => {
  it('sends no signal when none is given', async () => {
    const { fetch, inits } = fakeFetch()
    const c = createNivaro('http://x', { fetch })
    assert.deepEqual(await c.request(executeCustomQuery('q', {})), { data: [1] })
    assert.equal(inits[0].signal, undefined)
  })

  it('withSignal without a signal returns the same command', () => {
    const cmd = executeCustomQuery('q', {})
    assert.equal(withSignal(cmd, undefined), cmd)
  })

  it('cancels a POST when the caller aborts', async () => {
    const { fetch, inits } = fakeFetch()
    const c = createNivaro('http://x', { fetch })
    const ac = new AbortController()
    const p = c.request(withSignal(executeCustomQuery('q', {}), ac.signal))
    setTimeout(() => ac.abort(), 5)
    await assert.rejects(p, { name: 'AbortError' })
    assert.equal(inits[0].signal, ac.signal)
  })

  it('combines the caller abort with the GET read timeout', async () => {
    const { fetch } = fakeFetch()
    const c = createNivaro('http://x', { fetch, timeoutMs: 5_000 })
    const ac = new AbortController()
    const p = c.request(withSignal({ _method: 'GET', _path: '/x' }, ac.signal))
    setTimeout(() => ac.abort(), 5)
    // The caller's own abort, not a TimeoutError.
    await assert.rejects(p, { name: 'AbortError' })
  })

  it('still reports the GET timeout as a TimeoutError when the caller did not abort', async () => {
    const { fetch } = fakeFetch({ ms: 200 })
    const c = createNivaro('http://x', { fetch, timeoutMs: 20 })
    const p = c.request(withSignal({ _method: 'GET', _path: '/x' }, new AbortController().signal))
    await assert.rejects(p, { name: 'TimeoutError' })
  })

  it('keeps the caller abort wired until the body is read, then removes its listener', async () => {
    const { fetch } = fakeFetch({ ms: 5, bodyMs: 100 })
    const c = createNivaro('http://x', { fetch, timeoutMs: 5_000 })
    const { ac, live } = countingSignal()
    const p = c.request(withSignal({ _method: 'GET', _path: '/x' }, ac.signal))
    // Headers are in (timer cleared); the body is still being read.
    setTimeout(() => ac.abort(), 40)
    await assert.rejects(p, { name: 'AbortError' })
    assert.equal(live(), 0)

    const done = countingSignal()
    await c.request(withSignal({ _method: 'GET', _path: '/x' }, done.ac.signal))
    assert.equal(done.live(), 0)
  })
})
