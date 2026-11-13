import { EventEmitter } from 'node:events'
import knexFactory, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from 'vitest'
import { attachConnectRetry } from '../../../db/connect-retry.js'
import { attachConnectState, connectStateOf, opensFailing } from '../../../db/connect-state.js'
import { classifyDbFailure, noConnectionNote } from '../../../lib/db-unavailable.js'

// A REAL knex (mssql dialect) and its REAL pool (tarn); only the driver's connection open is
// faked, so no server is involved. What is under test is the seam: what a request gets when
// the pool cannot hand it a connection, and what the pool knew at that moment.

/** Enough of a tedious connection for knex to pool it and destroy it. */
class FakeConn extends EventEmitter {
  connected = true
  close() {
    setImmediate(() => this.emit('end'))
  }
}

const loginRefused = () =>
  Object.assign(new Error("Login failed for user 'app_rw'."), { code: 'ELOGIN' })

type Opener = () => Promise<unknown>
type Client = {
  acquireRawConnection: Opener
  acquireConnection: () => Promise<unknown>
  releaseConnection: (c: unknown) => Promise<void>
}

const open: Knex[] = []
const cleanups: Array<() => void> = []

function pool(
  rawOpen: Opener,
  opts: { max?: number; acquireMs?: number; stuckOpenMs?: number; retry?: boolean } = {}
) {
  const k = knexFactory({
    client: 'mssql',
    connection: { server: 'nowhere.invalid', user: 'u', password: 'p', database: 'd' },
    pool: { min: 0, max: opts.max ?? 2 },
    acquireConnectionTimeout: opts.acquireMs ?? 250
  })
  open.push(k)
  const client = k.client as unknown as Client
  client.acquireRawConnection = rawOpen
  attachConnectState(k, 'main', { stuckOpenMs: opts.stuckOpenMs ?? 5000 })
  // The same order as db/index.ts: the retry wraps the tracked open, so every attempt counts.
  if (opts.retry) attachConnectRetry(k, { delaysMs: [5, 5], budgetMs: 1000 })
  return { k, client }
}

afterEach(async () => {
  for (const c of cleanups.splice(0)) c()
  await Promise.all(open.splice(0).map((k) => k.destroy().catch(() => {})))
})

const caught = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e) => e
  )

describe('a request that cannot get a connection', () => {
  it('gets the driver’s own error when the open fails, noted as “this pool could not open one”', async () => {
    const refused = loginRefused()
    const { k } = pool(async () => {
      throw refused
    })
    const err = await caught(k.raw('select 1'))
    expect(err).toBe(refused)
    expect(noConnectionNote(err)).toEqual({ pool: 'main', opensFailing: true })
    expect(classifyDbFailure(err)).toBe('unreachable')
  })

  it('is BUSY when every connection is in use and connections open fine', async () => {
    const { k, client } = pool(async () => new FakeConn(), { max: 1, acquireMs: 150 })
    const held = await client.acquireConnection()
    try {
      const err = (await caught(k.raw('select 1'))) as Error
      expect(err.name).toBe('KnexTimeoutError')
      expect(noConnectionNote(err)).toEqual({ pool: 'main', opensFailing: false })
      expect(classifyDbFailure(err)).toBe('busy')
    } finally {
      await client.releaseConnection(held)
    }
  })

  it('is UNREACHABLE when it gave up waiting while that pool’s opens kept failing', async () => {
    // One slot: the first waiter is handed the open's error (knex propagates it), everyone
    // behind it waits for the next attempt, which fails too, until they give up.
    const { k } = pool(
      async () => {
        throw loginRefused()
      },
      { max: 1, acquireMs: 300 }
    )
    const errs = (await Promise.all([1, 2, 3].map(() => caught(k.raw('select 1'))))) as Error[]
    expect(errs.map((e) => classifyDbFailure(e))).toEqual([
      'unreachable',
      'unreachable',
      'unreachable'
    ])
    // At least one of them is the pool's own timeout: told apart from a busy pool by the note.
    const timeouts = errs.filter((e) => e.name === 'KnexTimeoutError')
    expect(timeouts.length).toBeGreaterThan(0)
    for (const t of timeouts) expect(noConnectionNote(t)?.opensFailing).toBe(true)
  })

  it('is UNREACHABLE when the open neither answers nor fails (a server that swallows the connect)', async () => {
    const { k } = pool(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          cleanups.push(() => reject(new Error('test over')))
        }),
      { max: 2, acquireMs: 200, stuckOpenMs: 100 }
    )
    const err = (await caught(k.raw('select 1'))) as Error
    expect(err.name).toBe('KnexTimeoutError')
    expect(noConnectionNote(err)).toEqual({ pool: 'main', opensFailing: true })
    expect(classifyDbFailure(err)).toBe('unreachable')
  })

  it('an open that failed BEFORE this wait, then connections that open again, is busy', async () => {
    let fail = true
    const { k, client } = pool(
      async () => {
        if (fail) throw loginRefused()
        return new FakeConn()
      },
      { max: 1, acquireMs: 150 }
    )
    expect(classifyDbFailure(await caught(k.raw('select 1')))).toBe('unreachable')
    fail = false
    const held = await client.acquireConnection()
    try {
      const err = await caught(k.raw('select 1'))
      expect(noConnectionNote(err)).toEqual({ pool: 'main', opensFailing: false })
      expect(classifyDbFailure(err)).toBe('busy')
    } finally {
      await client.releaseConnection(held)
    }
  })

  it('counts every attempt of the refused-login retry, and hands over a connection that opens', async () => {
    let n = 0
    const { k, client } = pool(
      async () => {
        n++
        if (n < 3) throw loginRefused()
        return new FakeConn()
      },
      { retry: true }
    )
    // lint-traps-ok: a fake driver in a test: there is no pool connection to release
    const conn = await client.acquireConnection()
    expect(n).toBe(3)
    const state = connectStateOf(k)
    expect(state?.failsSinceOk).toBe(0)
    expect(state?.okAt).toBeGreaterThanOrEqual(state?.failAt ?? 0)
    await client.releaseConnection(conn)
  })
})

describe('opensFailing', () => {
  const state = (over: Partial<{ okAt: number; failAt: number; failsSinceOk: number }>) => ({
    okAt: 0,
    failAt: 0,
    failsSinceOk: 0,
    inFlight: new Set<{ at: number }>(),
    ...over
  })

  it('needs a failure during the wait with no success since', () => {
    expect(opensFailing(state({ failAt: 1500, failsSinceOk: 2 }), 1000, 2000)).toBe(true)
    // failed before this request started waiting
    expect(opensFailing(state({ failAt: 900, failsSinceOk: 1 }), 1000, 2000)).toBe(false)
    // failed, then opened again
    expect(opensFailing(state({ failAt: 1500, okAt: 1800, failsSinceOk: 0 }), 1000, 2000)).toBe(
      false
    )
    expect(opensFailing(state({}), 1000, 2000)).toBe(false)
  })

  it('or an open that has been in flight too long to be healthy', () => {
    const s = state({})
    s.inFlight.add({ at: 1000 })
    expect(opensFailing(s, 1000, 3000, 5000)).toBe(false)
    expect(opensFailing(s, 1000, 6000, 5000)).toBe(true)
  })
})

describe('attachConnectState', () => {
  it('ignores an instance with no driver, and wraps once', async () => {
    expect(() => attachConnectState({}, 'main')).not.toThrow()
    expect(() => attachConnectState({ client: {} }, 'main')).not.toThrow()
    let opens = 0
    const client = {
      async acquireRawConnection() {
        opens++
        return {}
      }
    }
    attachConnectState({ client }, 'main')
    attachConnectState({ client }, 'main')
    await client.acquireRawConnection()
    expect(opens).toBe(1)
    expect(connectStateOf({ client })?.okAt).toBeGreaterThan(0)
  })
})
