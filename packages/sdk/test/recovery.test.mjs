// Waiting out a server that is briefly away (2026-11-18). Runs against the built dist:
// `pnpm run build && pnpm test`.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  createNivaro,
  isKeyedWrite,
  isReadPost,
  isRecoverable,
  onRecoveryEvent,
  setRecoveryDefaults
} from '../dist/index.js'

const FAST = { enabled: true, baseDelayMs: 1, maxDelayMs: 5, budgetMs: 2_000 }

/** A fetch that plays back `answers` in order: a number = that status (with `code` body for
 *  objects), 'net' = a network error. Records each init. */
function scripted(answers) {
  const inits = []
  const fetch = async (_url, init) => {
    inits.push(init)
    const a = answers[Math.min(inits.length - 1, answers.length - 1)]
    if (a === 'net') throw new TypeError('Failed to fetch')
    const { status, code } = typeof a === 'number' ? { status: a } : a
    const body = status >= 400 ? { error: 'x', ...(code ? { code } : {}) } : { data: { id: 7 } }
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }
  return { fetch, inits }
}

const cmd = (method, path, body) => ({ _method: method, _path: path, _body: body })
const keyOf = (init) => init.headers['Idempotency-Key']

function events() {
  const seen = []
  const off = onRecoveryEvent((e) => seen.push(e.type))
  return { seen, off }
}

afterEach(() => setRecoveryDefaults({ enabled: false }))

describe('recovery policy', () => {
  it('keys only creates, updates and deletes of /items records', () => {
    assert.equal(isKeyedWrite('POST', '/items/orders'), true)
    assert.equal(isKeyedWrite('PATCH', '/items/orders/7'), true)
    assert.equal(isKeyedWrite('DELETE', '/api/items/orders/7'), true)
    assert.equal(isKeyedWrite('GET', '/items/orders'), false)
    assert.equal(isKeyedWrite('POST', '/workflows/instance/9/transition'), false)
    assert.equal(isKeyedWrite('POST', '/items/orders/7/whatever'), false)
    assert.equal(isKeyedWrite('POST', '/files'), false)
    assert.equal(isKeyedWrite('PATCH', '/items/user_presence/12'), false)
    assert.equal(isKeyedWrite('PATCH', '/items/orders'), true)
    assert.equal(isKeyedWrite('POST', '/items/batch-read'), false)
    assert.equal(isKeyedWrite('POST', '/items/orders/bulk-update'), false)
    assert.equal(isKeyedWrite('POST', '/items/orders/import'), false)
    assert.equal(isKeyedWrite('DELETE', '/items/orders'), false)
    assert.equal(isReadPost('POST', '/batch-get'), true)
    assert.equal(isReadPost('POST', '/api/items/batch-read'), true)
  })

  it('never retries an unkeyed write, a refusal or a maintenance window', () => {
    assert.equal(isRecoverable('POST', { status: 503, keyed: false }), false)
    assert.equal(isRecoverable('GET', { status: 400, keyed: false }), false)
    assert.equal(isRecoverable('GET', { status: 503, code: 'MAINTENANCE', keyed: false }), false)
    assert.equal(isRecoverable('GET', { status: 409, code: 'IDEMPOTENCY_IN_PROGRESS', keyed: false }), false)
    assert.equal(isRecoverable('PATCH', { status: 409, code: 'IDEMPOTENCY_IN_PROGRESS', keyed: true }), true)
    assert.equal(isRecoverable('GET', { keyed: false }), true)
    // the app's own 503s are answers, a proxy's / passing ones are not
    assert.equal(isRecoverable('GET', { status: 503, code: 'LIST_TIMEOUT', keyed: false }), false)
    assert.equal(isRecoverable('GET', { status: 503, code: 'DB_UNAVAILABLE', keyed: false }), true)
    assert.equal(isRecoverable('GET', { status: 503, code: null, keyed: false }), true)
    // a slow read is not re-run; a keyed write waits for its first try
    assert.equal(isRecoverable('GET', { status: 504, keyed: false }), false)
    assert.equal(isRecoverable('PATCH', { status: 504, keyed: true }), true)
  })
})

describe('createNivaro recovery', () => {
  it('is off by default: a 503 read fails at once', async () => {
    const { fetch, inits } = scripted([503, 200])
    const c = createNivaro('http://x', { fetch })
    await assert.rejects(c.request(cmd('GET', '/items/orders')))
    assert.equal(inits.length, 1)
  })

  it('waits out a 503 / network error on a read and reports waiting → recovered', async () => {
    const { seen, off } = events()
    const { fetch, inits } = scripted([503, 'net', 200])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    const r = await c.request(cmd('GET', '/items/orders'))
    off()
    assert.deepEqual(r, { data: { id: 7 } })
    assert.equal(inits.length, 3)
    assert.deepEqual(seen, ['waiting', 'recovered'])
  })

  it('retries a keyed create with the SAME Idempotency-Key on every try', async () => {
    const { fetch, inits } = scripted(['net', 502, 201])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await c.request(cmd('POST', '/items/orders', { name: 'a' }))
    assert.equal(inits.length, 3)
    const key = keyOf(inits[0])
    assert.match(key, /^nvr-/)
    assert.ok(inits.every((i) => keyOf(i) === key))
  })

  it('a new write gets a new key', async () => {
    const { fetch, inits } = scripted([200])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await c.request(cmd('PATCH', '/items/orders/7', { a: 1 }))
    await c.request(cmd('PATCH', '/items/orders/7', { a: 1 }))
    assert.notEqual(keyOf(inits[0]), keyOf(inits[1]))
  })

  it('keeps a key the caller set', async () => {
    const { fetch, inits } = scripted([503, 200])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await c.request({ ...cmd('DELETE', '/items/orders/7'), _headers: { 'Idempotency-Key': 'mine' } })
    assert.deepEqual(
      inits.map((i) => i.headers['Idempotency-Key']),
      ['mine', 'mine']
    )
  })

  it('waits for the first try of the same write while the server says it is still running', async () => {
    const { fetch, inits } = scripted([{ status: 409, code: 'IDEMPOTENCY_IN_PROGRESS' }, 200])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await c.request(cmd('PATCH', '/items/orders/7', { a: 1 }))
    assert.equal(inits.length, 2)
  })

  it('never retries a write the server cannot deduplicate', async () => {
    const { fetch, inits } = scripted([503, 200])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await assert.rejects(c.request(cmd('POST', '/workflows/instance/9/transition', {})))
    assert.equal(inits.length, 1)
    assert.equal(inits[0].headers['Idempotency-Key'], undefined)
  })

  it('does not wait out a maintenance window', async () => {
    const { fetch, inits } = scripted([{ status: 503, code: 'MAINTENANCE' }, 200])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await assert.rejects(c.request(cmd('GET', '/items/orders')), (e) => e.code === 'MAINTENANCE')
    assert.equal(inits.length, 1)
  })

  it('gives up when the budget is spent and fails with the last answer', async () => {
    const { seen, off } = events()
    const { fetch } = scripted([503])
    const c = createNivaro('http://x', { fetch, recovery: { ...FAST, budgetMs: 30 } })
    await assert.rejects(c.request(cmd('GET', '/items/orders')), (e) => e.status === 503)
    off()
    assert.deepEqual(seen, ['waiting', 'gave-up'])
  })

  it('page-wide defaults reach a client created before them', async () => {
    const { fetch, inits } = scripted([503, 200])
    const c = createNivaro('http://x', { fetch })
    setRecoveryDefaults(FAST)
    await c.request(cmd('GET', '/items/orders'))
    assert.equal(inits.length, 2)
  })

  it('a client can opt out of the page-wide defaults', async () => {
    setRecoveryDefaults(FAST)
    const { fetch, inits } = scripted([503, 200])
    const c = createNivaro('http://x', { fetch, recovery: { enabled: false } })
    await assert.rejects(c.request(cmd('GET', '/items/orders')))
    assert.equal(inits.length, 1)
  })

  it('a read-only batch POST waits like a read and carries no key', async () => {
    const { fetch, inits } = scripted([503, 200])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await c.request(cmd('POST', '/batch-get', { reads: [] }))
    assert.equal(inits.length, 2)
    assert.equal(inits[0].headers['Idempotency-Key'], undefined)
  })

  it('an app 503 (a list that took too long) is the answer, not an outage', async () => {
    const { fetch, inits } = scripted([{ status: 503, code: 'LIST_TIMEOUT' }, 200])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await assert.rejects(c.request(cmd('GET', '/items/orders')), (e) => e.code === 'LIST_TIMEOUT')
    assert.equal(inits.length, 1)
  })

  it('waiting then a server error closes the wait as gave-up, never "recovered"', async () => {
    const { seen, off } = events()
    const { fetch } = scripted([502, 500])
    const c = createNivaro('http://x', { fetch, recovery: FAST })
    await assert.rejects(c.request(cmd('GET', '/items/orders')), (e) => e.status === 500)
    off()
    assert.deepEqual(seen, ['waiting', 'gave-up'])
  })

  it('an answer after the budget is marked so callers do not wait again', async () => {
    const { fetch } = scripted([503])
    const c = createNivaro('http://x', { fetch, recovery: { ...FAST, budgetMs: 30 } })
    await assert.rejects(c.request(cmd('GET', '/items/orders')), (e) => e.recoveryExhausted === true)
  })

  it('a cancel while waiting closes the wait (no stuck notice)', async () => {
    const { seen, off } = events()
    const { fetch } = scripted([503])
    const ac = new AbortController()
    const c = createNivaro('http://x', { fetch, recovery: { ...FAST, baseDelayMs: 200, maxDelayMs: 200 } })
    const p = c.request({ ...cmd('GET', '/items/orders'), _signal: ac.signal })
    setTimeout(() => ac.abort(), 20)
    await assert.rejects(p)
    off()
    assert.deepEqual(seen, ['waiting', 'gave-up'])
  })

  it('the caller abort ends the wait', async () => {
    const { fetch } = scripted([503])
    const ac = new AbortController()
    const c = createNivaro('http://x', { fetch, recovery: { ...FAST, baseDelayMs: 200, maxDelayMs: 200 } })
    const p = c.request({ ...cmd('GET', '/items/orders'), _signal: ac.signal })
    setTimeout(() => ac.abort(), 20)
    await assert.rejects(p, (e) => e.name === 'AbortError')
  })
})
