import { describe, expect, it } from 'vitest'
import {
  classifyDbFailure,
  DB_UNAVAILABLE_MESSAGE,
  dbUnavailableBody,
  isConnectFailure,
  markNoConnection,
  noConnectionNote,
  scrubConnectReason
} from '../../../lib/db-unavailable.js'

/** An error as the driver raises it: tedious sets `code`, never `name`. */
const driver = (message: string, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra })

const poolTimeout = () =>
  Object.assign(
    new Error(
      'Knex: Timeout acquiring a connection. The pool is probably full. Are you missing a .transacting(trx) call?'
    ),
    { name: 'KnexTimeoutError' }
  )

// The shapes are copied from tedious 19.2.1 (connection.js, token/handler.js) and knex 3.2
// (execution/internal/query-executioner.js prefixes a failed statement's reason with the
// statement; client.js turns tarn's acquire timeout into KnexTimeoutError). The first one is
// the message production answered 26 times on 2026-11-12.
describe('classifyDbFailure', () => {
  const UNREACHABLE: Array<[string, unknown]> = [
    ['login refused (server error token)', driver("Login failed for user 'app_rw'.", 'ELOGIN')],
    ['login refused (driver wording)', driver('Login failed.', 'ELOGIN')],
    [
      'database not open for logins',
      driver('Cannot open database "app" requested by the login. The login failed.', 'ELOGIN')
    ],
    [
      'server refused the socket',
      driver(
        'Failed to connect to db.internal:1433 - connect ECONNREFUSED 10.0.0.5:1433',
        'ESOCKET'
      )
    ],
    [
      'no address answered',
      driver('Failed to connect to db.internal:1433 - Could not connect (sequence)', 'ESOCKET')
    ],
    ['connect timed out', driver('Failed to connect to db.internal:1433 in 15000ms', 'ETIMEOUT')],
    [
      'named instance, connect timed out',
      driver('Failed to connect to db.internal\\SQL01 in 15000ms', 'ETIMEOUT')
    ],
    [
      'instance lookup failed',
      driver('Failed to lookup instance on db.internal - getaddrinfo ENOTFOUND', 'EINSTLOOKUP')
    ],
    ['reset while opening', driver('Connection lost - socket hang up', 'ESOCKET')],
    ['reset while opening (read)', driver('Connection lost - read ECONNRESET', 'ESOCKET')],
    [
      'the pooled connection was already gone: the statement was never sent',
      driver(
        'select [id] from [orders] where [id] = @p0 - Requests can only be made in the LoggedIn state, not the Final state',
        'EINVALIDSTATE'
      )
    ],
    [
      'the same on a transaction begin (no statement prefix)',
      driver(
        'Requests can only be made in the LoggedIn state, not the Final state',
        'EINVALIDSTATE'
      )
    ],
    [
      'gave up waiting for a connection while that pool could not open one',
      markNoConnection(poolTimeout(), { pool: 'main', opensFailing: true })
    ]
  ]

  const BUSY: Array<[string, unknown]> = [
    ['gave up waiting, nothing known about the pool', poolTimeout()],
    [
      'gave up waiting while connections were opening fine: every one is in use',
      markNoConnection(poolTimeout(), { pool: 'main', opensFailing: false })
    ],
    [
      'the same by message only',
      { message: 'Timeout acquiring a connection. The pool is probably full.' }
    ]
  ]

  const CUT: Array<[string, unknown]> = [
    [
      'connection closed under a running write',
      driver(
        'update [orders] set [total] = @p0 where [id] = @p1 - Connection closed before request completed.',
        'ECLOSE'
      )
    ],
    [
      'the same from a batch run on the driver directly',
      driver('Connection closed before request completed.', 'ECLOSE')
    ],
    [
      'socket ended under a running read',
      driver('select [id] from [orders] - socket hang up', 'ECONNRESET')
    ],
    ['socket reset', driver('select [id] from [orders] - read ECONNRESET', 'ECONNRESET')],
    [
      'socket write failed',
      driver('insert into [orders] ([n]) values (@p0) - write EPIPE', 'EPIPE')
    ],
    [
      'keep-alive gave up (the socket code, with a D)',
      driver('select [id] from [orders] - read ETIMEDOUT', 'ETIMEDOUT')
    ],
    [
      'the reset drill',
      driver('select * from [orders] - Connection lost - read ECONNRESET', 'ESOCKET', {
        name: 'ConnectionError'
      })
    ]
  ]

  const UNTOUCHED: Array<[string, unknown]> = [
    [
      'one statement timed out',
      driver(
        'select [id] from [orders] - Timeout: Request failed to complete in 15000ms',
        'ETIMEOUT'
      )
    ],
    [
      'the same without a prefix',
      driver('Timeout: Request failed to complete in 15000ms', 'ETIMEOUT')
    ],
    [
      'a cancel that got no answer',
      driver('select [id] from [orders] - Failed to cancel request in 5000ms', 'ETIMEOUT')
    ],
    [
      'deadlock victim',
      driver(
        'update [orders] set [n] = @p0 - Transaction (Process ID 71) was deadlocked on lock resources with another process and has been chosen as the deadlock victim. Rerun the transaction.',
        'EREQUEST',
        { number: 1205 }
      )
    ],
    [
      'unique violation',
      driver(
        "insert into [orders] ([n]) values (@p0) - Violation of UNIQUE KEY constraint 'uq_orders_n'. Cannot insert duplicate key in object 'dbo.orders'.",
        'EREQUEST',
        { number: 2627 }
      )
    ],
    [
      'a bad query',
      driver("select [nope] from [orders] - Invalid column name 'nope'.", 'EREQUEST', {
        number: 207
      })
    ],
    ['a cancelled statement', driver('select 1 - Canceled.', 'ECANCEL')],
    [
      'two statements on one connection (a bug, not an outage)',
      driver(
        'select 1 - Requests can only be made in the LoggedIn state, not the SentClientRequest state',
        'EINVALIDSTATE'
      )
    ],
    // Not the database at all: the words alone never decide.
    [
      'mail server refused the login',
      driver('Login failed: 535 5.7.8 Authentication failed', 'EAUTH')
    ],
    ['mail login, no code', new Error("Login failed for user 'mailer'.")],
    [
      'mail socket error (nodemailer shares the code name)',
      driver('connect ECONNREFUSED 10.0.0.9:587', 'ESOCKET')
    ],
    [
      'a partner API that would not connect',
      driver('Failed to connect to api.partner.example:443', 'ECONNREFUSED')
    ],
    [
      'a partner call, no code',
      new Error('Failed to connect to api.partner.example:443 in 30000ms')
    ],
    ['a partner call reset', driver('socket hang up', 'ECONNRESET')],
    ['prose that starts like a statement', driver('Update failed - socket hang up', 'ECONNRESET')],
    ['words only', new Error('Connection lost - read ECONNRESET')],
    [
      'an error of our own with a status',
      Object.assign(driver("Login failed for user 'x'.", 'ELOGIN'), { statusCode: 503 })
    ],
    ['an app error', new Error('Something broke')],
    ['nothing', null],
    ['a string', 'Login failed']
  ]

  it.each(UNREACHABLE)('unreachable — %s', (_name, err) => {
    expect(classifyDbFailure(err)).toBe('unreachable')
  })
  it.each(BUSY)('busy — %s', (_name, err) => {
    expect(classifyDbFailure(err)).toBe('busy')
  })
  it.each(CUT)('cut off mid-statement — %s', (_name, err) => {
    expect(classifyDbFailure(err)).toBe('cut')
  })
  it.each(UNTOUCHED)('not ours — %s', (_name, err) => {
    expect(classifyDbFailure(err)).toBeNull()
  })

  it('a connection that would not open is told by the driver code, then the words', () => {
    expect(isConnectFailure(driver("Login failed for user 'app_rw'.", 'ELOGIN'))).toBe(true)
    expect(isConnectFailure(driver('Connection lost - socket hang up', 'ESOCKET'))).toBe(true)
    expect(isConnectFailure(new Error("Login failed for user 'app_rw'."))).toBe(false)
    expect(isConnectFailure(driver('Failed to connect to smtp:587', 'ECONNECTION'))).toBe(false)
    // A statement that lost its connection is not "never opened".
    expect(
      isConnectFailure(driver('select 1 - Connection lost - read ECONNRESET', 'ESOCKET'))
    ).toBe(false)
  })
})

describe('the pool note on an error', () => {
  it('rides the error without showing in its JSON or its keys', () => {
    const err = markNoConnection(new Error('x'), { pool: 'read', opensFailing: true })
    expect(noConnectionNote(err)).toEqual({ pool: 'read', opensFailing: true })
    expect(Object.keys(err)).toEqual([])
    expect(JSON.stringify(err)).toBe('{}')
    expect(noConnectionNote(new Error('y'))).toBeNull()
    expect(noConnectionNote(null)).toBeNull()
  })

  it('keeps the first note when an error passes two seams', () => {
    const err = markNoConnection(new Error('x'), { pool: 'main', opensFailing: true })
    markNoConnection(err, { pool: 'background', opensFailing: false })
    expect(noConnectionNote(err)).toEqual({ pool: 'main', opensFailing: true })
  })
})

describe('scrubConnectReason', () => {
  it('drops the login name and anything that reads as a server address', () => {
    expect(scrubConnectReason("Login failed for user 'app_rw'.")).toBe('Login failed.')
    expect(
      scrubConnectReason("Login failed for user 'CORP\\svc-app' because the account is disabled.")
    ).toBe('Login failed because the account is disabled.')
    const s = scrubConnectReason(
      'Failed to connect to db.internal:1433 - connect ECONNREFUSED 10.0.0.5:1433'
    )
    expect(s).not.toMatch(/db\.internal|10\.0\.0\.5|1433/)
    expect(s).toMatch(/^Failed to connect to .+ - connect ECONNREFUSED/)
    expect(scrubConnectReason('Failed to connect to db.internal\\SQL01 in 15000ms')).not.toMatch(
      /db\.internal|SQL01/
    )
    expect(scrubConnectReason('Failed to connect to sql01:1433 in 15000ms')).toMatch(/in 15000ms$/)
  })

  it('keeps everything else', () => {
    const kept = 'Cannot open database "app" requested by the login. The login failed.'
    expect(scrubConnectReason(kept)).toBe(kept)
    expect(scrubConnectReason('Connection lost - socket hang up')).toBe(
      'Connection lost - socket hang up'
    )
  })
})

describe('the answer', () => {
  it('is one body for every path: status, code and a sentence in both places clients read', () => {
    expect(dbUnavailableBody()).toEqual({
      statusCode: 503,
      error: DB_UNAVAILABLE_MESSAGE,
      message: DB_UNAVAILABLE_MESSAGE,
      code: 'DB_UNAVAILABLE'
    })
    // Plain words: no login, host, driver code, status line or "nothing was saved" (a request
    // that failed on its second connection may have saved something).
    expect(DB_UNAVAILABLE_MESSAGE).not.toMatch(/login|user|host|:\d|\b503\b|nothing was saved|sql/i)
    expect(DB_UNAVAILABLE_MESSAGE).not.toMatch(/\bE[A-Z]{4,}\b/)
  })
})
