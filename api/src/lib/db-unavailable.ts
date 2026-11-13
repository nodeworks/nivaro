/**
 * "The database could not be reached" — told apart, narrowly, from every other way a
 * database call fails. ONE classifier: the 503 the error handler answers
 * (services/db-outage.ts) and the "is this a driver fault" test behind every 5xx body
 * (lib/db-refusal.ts) both read it. Leaf module: no imports.
 *
 * | What the driver raised                                             | Class       |
 * |--------------------------------------------------------------------|-------------|
 * | ELOGIN (the server answered the login with an error)               | unreachable |
 * | EINSTLOOKUP (the named instance could not be found)                | unreachable |
 * | ESOCKET / ETIMEOUT "Failed to connect to …" (refused, no answer)   | unreachable |
 * | ESOCKET "Connection lost - …" with no statement (reset while opening) | unreachable |
 * | EINVALIDSTATE "… not the Final state" (the pooled connection was    | unreachable |
 * |   already gone: the driver refused to send the statement)          |             |
 * | pool acquire timeout while that pool could not OPEN a connection   | unreachable |
 * | pool acquire timeout while connections open fine (all in use)      | busy        |
 * | a statement knex ran that lost its connection (ECLOSE, ECONNRESET, | cut         |
 * |   EPIPE, ETIMEDOUT, ESOCKET "Connection lost")                     |             |
 * | anything else: a statement timeout, a deadlock, a constraint, a    | null        |
 * |   bad query, an error that is not the database's                   |             |
 *
 * `unreachable` means nothing of the failed statement was sent: the request never held a
 * connection for it. That is what makes "try again" an honest answer. `cut` is the opposite
 * case and is kept apart on purpose: the statement was on the wire when the connection died,
 * so a write may or may not have been applied.
 *
 * The driver is told by its error CODE first (tedious sets `code` and leaves `name` as
 * "Error"), then by its words. Words alone decide nothing: a mail server says "Login
 * failed" and a partner call says "Failed to connect to …" too.
 */

export type DbFailure = 'unreachable' | 'busy' | 'cut'

type ErrLike = {
  message?: unknown
  code?: unknown
  name?: unknown
  statusCode?: unknown
}

const messageOf = (e: ErrLike): string => (typeof e.message === 'string' ? e.message : '')

/**
 * The request pool had no free connection within DB_ACQUIRE_TIMEOUT_MS (knex's
 * KnexTimeoutError "Timeout acquiring a connection"). On its own this says the server is
 * busy; `classifyDbFailure` reads the pool note to tell a pool that could not open one.
 */
export function isPoolBusy(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null
  return (
    !!e &&
    (e.name === 'KnexTimeoutError' ||
      /Timeout acquiring a connection\. The pool is probably full/i.test(String(e.message ?? '')))
  )
}

const OPENING = /^Failed to connect to /
const LOST_WHILE_OPENING = /^Connection lost - /

/**
 * A connection that would not OPEN, as tedious raises it from `connect`: these never come
 * out of a statement (knex prefixes a statement's error with the statement, and tedious
 * hands a running statement the raw socket error, not this wrapper).
 */
export function isConnectFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as ErrLike
  const message = messageOf(e)
  switch (e.code) {
    case 'ELOGIN':
    case 'EINSTLOOKUP':
      return true
    case 'ESOCKET':
      return OPENING.test(message) || LOST_WHILE_OPENING.test(message)
    case 'ETIMEOUT':
      // The statement timeout shares this code ("Timeout: Request failed to complete in …").
      return OPENING.test(message)
    default:
      return false
  }
}

/**
 * The pool handed out a connection that had already closed, and the driver refused to send
 * on it (tedious `makeRequest` checks the state first). Only the closed state counts: the
 * same error for a connection that is mid-statement is a bug of ours, not an outage.
 */
function isNeverSent(e: ErrLike): boolean {
  return (
    e.code === 'EINVALIDSTATE' &&
    /Requests can only be made in the LoggedIn state, not the Final state$/.test(messageOf(e))
  )
}

/** How a statement's error ends when its connection died under it. */
const CUT_TAIL =
  / - (?:Connection lost - [^\n]*|Connection closed before request completed\.|socket hang up|(?:read|write) E[A-Z]+)$/
/** Socket codes Node puts on a connection that died (ETIMEDOUT is the socket's, with a D). */
const CUT_CODES = new Set(['ECLOSE', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESOCKET'])
/** knex's "<statement> - <reason>": the head starts like SQL and reads like SQL. Prose that
 *  happens to start with "Update …" is not a statement. */
const STATEMENT_HEAD =
  /^(?:[^:\n]{1,80}: )?;?\s*(?:insert|update|delete|select|merge|exec|execute|with|declare|set|if|begin)\s/i
const READS_LIKE_SQL = /\[[^\]]+\]|@p\d|\b(?:from|into|set|where|values|join|exec|execute|table)\b/i

/**
 * A statement that was running when its connection died. The database's, provably: either
 * the driver's own "closed before request completed", or a statement knex ran (its text is
 * in the message) that ended on a socket error. A bare "socket hang up" is not enough: a
 * partner call fails the same way.
 */
function isCutStatement(e: ErrLike): boolean {
  const message = messageOf(e)
  if (e.code === 'ECLOSE' && message === 'Connection closed before request completed.') return true
  const tail = CUT_TAIL.exec(message)
  if (!tail) return false
  if (typeof e.code === 'string' && !CUT_CODES.has(e.code)) return false
  const head = message.slice(0, tail.index)
  return STATEMENT_HEAD.test(`${head} `) && READS_LIKE_SQL.test(head)
}

// ─── What the pool knew when it gave up ──────────────────────────────────────

const NO_CONNECTION = Symbol.for('nivaro.db.noConnection')

export interface NoConnectionNote {
  /** Which pool the request was waiting on. */
  pool: string
  /** That pool was trying to open connections and could not (db/connect-state.ts). */
  opensFailing: boolean
}

/** Stamp an error thrown while ACQUIRING a connection. Hidden: never in JSON, logs or keys. */
export function markNoConnection<T>(err: T, note: NoConnectionNote): T {
  if (err && typeof err === 'object' && !(NO_CONNECTION in err)) {
    try {
      Object.defineProperty(err, NO_CONNECTION, { value: note, enumerable: false })
    } catch {
      /* a frozen error keeps no note; the classifier falls back to its shape */
    }
  }
  return err
}

export function noConnectionNote(err: unknown): NoConnectionNote | null {
  if (!err || typeof err !== 'object') return null
  return (err as Record<symbol, NoConnectionNote | undefined>)[NO_CONNECTION] ?? null
}

/** The class of a thrown error, or null when it is not one of these (see the table above). */
export function classifyDbFailure(err: unknown): DbFailure | null {
  if (!err || typeof err !== 'object') return null
  const e = err as ErrLike
  // An error that carries its own status is ours (LIST_TIMEOUT, a coded refusal).
  if (e.statusCode != null) return null
  if (isPoolBusy(err)) return noConnectionNote(err)?.opensFailing ? 'unreachable' : 'busy'
  if (isConnectFailure(err) || isNeverSent(e)) return 'unreachable'
  if (isCutStatement(e)) return 'cut'
  return null
}

// ─── What may be written down about it ───────────────────────────────────────

/**
 * A driver reason fit for a log line or an issue: without the database login
 * ("Login failed for user '…'") and without anything that reads as a server address.
 */
export function scrubConnectReason(text: string): string {
  return (
    text
      .replace(/\s+for user '[^']*'/gi, '')
      .replace(/(Failed to (?:connect to|lookup instance on) )\S+/g, '$1the database server')
      .replace(/(getaddrinfo \w+ )\S+/g, '$1(address)')
      // host:port, a bare IPv4 address, host\instance
      .replace(/\b[A-Za-z0-9][\w.-]*:\d{2,5}\b/g, '(address)')
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '(address)')
  )
}

// ─── The answer ──────────────────────────────────────────────────────────────

export const DB_UNAVAILABLE_CODE = 'DB_UNAVAILABLE'
/** Says what is wrong and nothing about what was or was not saved: a request that failed
 *  on its second connection may already have saved something. */
export const DB_UNAVAILABLE_MESSAGE = 'The database is not answering right now.'
/** Seconds: one probe interval (services/db-health.ts), the busy pool's wait as well. */
export const DB_UNAVAILABLE_RETRY_AFTER_S = 5

export interface DbUnavailableBody {
  statusCode: 503
  error: string
  message: string
  code: typeof DB_UNAVAILABLE_CODE
}

/**
 * The one body for "the database cannot be reached", whichever path noticed: the outage
 * posture's fast refusal and a request that failed opening a connection look the same.
 * The sentence sits in `error` (where route answers put it, and where the posture always
 * had it) and in `message` (where the global handler's answers put it), so every client
 * reader shows it.
 */
export function dbUnavailableBody(): DbUnavailableBody {
  return {
    statusCode: 503,
    error: DB_UNAVAILABLE_MESSAGE,
    message: DB_UNAVAILABLE_MESSAGE,
    code: DB_UNAVAILABLE_CODE
  }
}
