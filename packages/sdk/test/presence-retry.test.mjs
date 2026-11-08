// Army 10: a presence heartbeat that a busy server or proxy answers with a 5xx (or does not
// answer) gets ONE quiet retry a few seconds later, never an error for the page. Runs against
// the built dist: `pnpm run build && pnpm test`.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { createPresence } from '../dist/index.js'

const RETRY_MS = 3000
let calls
let answers
const realFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  answers = []
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const next = answers.shift() ?? { status: 204 }
    if (next.throws) throw new TypeError('Failed to fetch')
    return next
  }
})
afterEach(() => {
  mock.timers.reset()
  globalThis.fetch = realFetch
})

const flush = () => new Promise((r) => setImmediate(r))
const pings = () => calls.filter((u) => u.endsWith('/api/presence/ping')).length

describe('presence heartbeat retry', () => {
  it('retries a 503 ping once, quietly', async () => {
    answers = [{ status: 503 }, { status: 204 }]
    const p = createPresence({ apiUrl: 'https://cms.test', pingInterval: 60_000 })
    await flush()
    assert.equal(pings(), 1)
    mock.timers.tick(RETRY_MS)
    await flush()
    assert.equal(pings(), 2)
    mock.timers.tick(RETRY_MS)
    await flush()
    assert.equal(pings(), 2, 'one retry only')
    p.destroy()
  })

  it('retries a ping that got no answer', async () => {
    answers = [{ throws: true }]
    const p = createPresence({ apiUrl: 'https://cms.test', pingInterval: 60_000 })
    await flush()
    mock.timers.tick(RETRY_MS)
    await flush()
    assert.equal(pings(), 2)
    p.destroy()
  })

  it('does not retry a recorded ping', async () => {
    const p = createPresence({ apiUrl: 'https://cms.test', pingInterval: 60_000 })
    await flush()
    mock.timers.tick(RETRY_MS)
    await flush()
    assert.equal(pings(), 1)
    p.destroy()
  })
})
