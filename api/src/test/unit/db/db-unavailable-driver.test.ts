import net from 'node:net'
import knexFactory, { type Knex } from 'knex'
import { Connection, Request } from 'tedious'
import { afterEach, describe, expect, it } from 'vitest'
import { attachConnectState } from '../../../db/connect-state.js'
import { DB_FAULT_MESSAGE, isDriverFault, serverFaultMessage } from '../../../lib/db-refusal.js'
import {
  classifyDbFailure,
  noConnectionNote,
  scrubConnectReason
} from '../../../lib/db-unavailable.js'

// The classifier against errors the REAL driver raises (tedious through knex and its pool),
// produced on loopback only: a port nothing listens on, a listener that never answers, a
// listener that hangs up. No database server is contacted and no login is attempted.

const servers: net.Server[] = []
const sockets: net.Socket[] = []
const pools: Knex[] = []

function listen(onSocket: (s: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((s) => {
      sockets.push(s)
      s.on('error', () => {})
      onSocket(s)
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  })
}

/** A port that refuses: one that was just free and is no longer listened on. */
async function closedPort(): Promise<number> {
  const port = await listen(() => {})
  const server = servers.pop() as net.Server
  await new Promise<void>((r) => server.close(() => r()))
  return port
}

function pool(port: number, opts: { connectMs: number; acquireMs: number }): Knex {
  const k = knexFactory({
    client: 'mssql',
    connection: {
      server: '127.0.0.1',
      port,
      user: 'nobody',
      password: 'not-a-password',
      database: 'none',
      connectionTimeout: opts.connectMs
    },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: opts.acquireMs
  })
  pools.push(k)
  return k
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await Promise.all(pools.splice(0).map((k) => k.destroy().catch(() => {})))
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

const caught = async (p: PromiseLike<unknown>): Promise<Error & { code?: string }> =>
  Promise.resolve(p).then(
    () => {
      throw new Error('expected a failure')
    },
    (e) => e
  )

describe('real driver errors, loopback only', () => {
  it('a server that refuses the socket: ESOCKET "Failed to connect to …"', async () => {
    const port = await closedPort()
    const k = pool(port, { connectMs: 2000, acquireMs: 4000 })
    attachConnectState(k, 'main')
    const err = await caught(k.raw('select 1'))
    expect(err.code).toBe('ESOCKET')
    expect(err.message).toMatch(new RegExp(`^Failed to connect to 127\\.0\\.0\\.1:${port} - `))
    expect(classifyDbFailure(err)).toBe('unreachable')
    expect(noConnectionNote(err)).toEqual({ pool: 'main', opensFailing: true })
    // The 5xx body and the log line never carry the address.
    expect(isDriverFault(err)).toBe(true)
    expect(serverFaultMessage(err)).toBe(DB_FAULT_MESSAGE)
    expect(scrubConnectReason(err.message)).not.toMatch(/127\.0\.0\.1|:\d{2,5}\b/)
  })

  it('a server that never answers: ETIMEOUT "Failed to connect to … in Nms"', async () => {
    const port = await listen(() => {})
    const k = pool(port, { connectMs: 300, acquireMs: 4000 })
    const err = await caught(k.raw('select 1'))
    expect(err.code).toBe('ETIMEOUT')
    expect(err.message).toBe(`Failed to connect to 127.0.0.1:${port} in 300ms`)
    expect(classifyDbFailure(err)).toBe('unreachable')
    expect(serverFaultMessage(err)).toBe(DB_FAULT_MESSAGE)
  })

  it('a server that hangs up while the connection is opening: ESOCKET "Connection lost - …"', async () => {
    const port = await listen((s) => s.end())
    const k = pool(port, { connectMs: 2000, acquireMs: 4000 })
    const err = await caught(k.raw('select 1'))
    expect(err.code).toBe('ESOCKET')
    expect(err.message).toMatch(/^Connection lost - /)
    expect(classifyDbFailure(err)).toBe('unreachable')
    expect(serverFaultMessage(err)).toBe(DB_FAULT_MESSAGE)
  })

  it('giving up on a pool whose open is stuck: knex’s timeout, told from a busy pool by the note', async () => {
    const port = await listen(() => {})
    const k = pool(port, { connectMs: 3000, acquireMs: 400 })
    attachConnectState(k, 'main', { stuckOpenMs: 200 })
    const err = await caught(k.raw('select 1'))
    expect(err.name).toBe('KnexTimeoutError')
    expect(noConnectionNote(err)).toEqual({ pool: 'main', opensFailing: true })
    expect(classifyDbFailure(err)).toBe('unreachable')

    // The same error from a pool nobody watches says only "busy": the note is what decides.
    const bare = pool(port, { connectMs: 3000, acquireMs: 300 })
    const unnoted = await caught(bare.raw('select 1'))
    expect(unnoted.name).toBe('KnexTimeoutError')
    expect(classifyDbFailure(unnoted)).toBe('busy')
  })

  it('a statement on a connection that is already gone is refused before it is sent', async () => {
    const port = await closedPort()
    const connection = new Connection({
      server: '127.0.0.1',
      authentication: {
        type: 'default',
        options: { userName: 'nobody', password: 'not-a-password' }
      },
      options: { port, encrypt: false, connectTimeout: 2000 }
    })
    connection.on('error', () => {})
    await new Promise<void>((resolve) => connection.connect(() => resolve()))
    const err = await new Promise<Error & { code?: string }>((resolve) => {
      connection.execSql(new Request('select 1', (e) => resolve(e as Error & { code?: string })))
    })
    expect(err.code).toBe('EINVALIDSTATE')
    expect(err.message).toBe('Requests can only be made in the LoggedIn state, not the Final state')
    expect(classifyDbFailure(err)).toBe('unreachable')
  })
})
