/**
 * Riding out a server that is briefly away — a deploy, a restart, a proxy
 * with no healthy backend for a moment.
 *
 * One policy for every client an app uses (the SDK client, an app's own fetch
 * wrapper, an axios instance), so they all decide alike:
 *
 *  - Reads (GET, and the read-only batch POSTs) are retried while the server
 *    is away, up to a time budget.
 *  - Writes are retried ONLY when they carry an Idempotency-Key the server
 *    honours: creating a record (POST /items/:c), updating one or a set
 *    (PATCH /items/:c[/:id]), deleting one (DELETE /items/:c/:id), a pipeline
 *    or workflow move, and a comment or task write (post, edit, delete,
 *    resolve, react / complete, claim, nudge). The key
 *    is minted once per write and sent on every try, so a save whose answer
 *    was lost is answered from the server's record of the first try instead
 *    of being written twice.
 *  - Everything else that writes (bulk actions, imports, uploads, partner
 *    pushes, mail, GraphQL) is never retried automatically.
 *  - "Away" means no answer at all, a proxy's 502, or a 503 the app marks as
 *    passing (no code, DB_UNAVAILABLE, SERVER_BUSY). The app's own 503s
 *    (a list that took too long, maintenance, a missing setting) are answers.
 *    A 504 (the proxy gave up on a slow request) is retried only for a keyed
 *    write — the retry then waits for the first try's answer instead of
 *    running the work again; a slow read would only be slow again.
 *
 * Off unless an app turns it on (`setRecoveryDefaults` at boot, or
 * `recovery` on one client), so scripts and partners using the SDK keep the
 * behaviour they had.
 */

export interface RecoveryOptions {
  /** Retry while the server is away. */
  enabled: boolean
  /** Total time one request may spend waiting for the server (default 120 s). */
  budgetMs?: number
  /** First wait (default 1 s), doubled per try with jitter; a Retry-After wins. */
  baseDelayMs?: number
  /** Longest single wait (default 8 s). */
  maxDelayMs?: number
  /** Also retry keyed `/items` writes (default true). */
  writes?: boolean
}

export type RecoveryEvent =
  /** A request is waiting for the server to come back. */
  | { type: 'waiting'; method: string; path: string; write: boolean }
  /** A request that had been waiting got a real answer from the server. */
  | { type: 'recovered'; method: string; path: string; write: boolean; waitedMs: number }
  /** A request that had been waiting ended without one: out of time, cancelled, or the
   *  server still answering "away" / an error. Every `waiting` is closed by exactly one
   *  `recovered` or `gave-up`. */
  | {
      type: 'gave-up'
      method: string
      path: string
      write: boolean
      waitedMs: number
      aborted?: boolean
      /** The last answer's error code, when it had one. `IDEMPOTENCY_IN_PROGRESS` = the first
       *  try of this write never answered (its process may have stopped after saving): the
       *  change may well be stored — re-read the record before trying again. */
      code?: string
    }

const listeners = new Set<(e: RecoveryEvent) => void>()
let defaults: RecoveryOptions = { enabled: false }

/** Turn recovery on (or off) for every client in this page that has no `recovery` of its own. */
export function setRecoveryDefaults(options: RecoveryOptions): void {
  defaults = { ...options }
}

/** The page-wide defaults, read per request (clients created before the call follow it). */
export function recoveryDefaults(): RecoveryOptions {
  return defaults
}

/** Hear when requests start waiting for the server and when they get through. */
export function onRecoveryEvent(fn: (e: RecoveryEvent) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function emitRecoveryEvent(e: RecoveryEvent): void {
  for (const fn of listeners) {
    try {
      fn(e)
    } catch {
      /* a listener never fails a request */
    }
  }
}

function bare(path: string): string {
  return path.split('?')[0].replace(/^\/api(?=\/)/, '')
}

/** Literal second segments of POST routes under /items that are not "create a record". */
const ITEMS_POST_ROUTES = new Set(['batch-read'])
/** Bookkeeping writes the next one replaces (the presence heartbeat every 25 s): never
 *  worth holding for two minutes, and never "your change" in an outage notice. */
const NOT_WORTH_WAITING = new Set(['user_presence'])

/** Comment and task actions the server deduplicates (routes/comments.ts, routes/tasks.ts). */
const COMMENT_ACTIONS = new Set(['resolve', 'reactions'])
const TASK_ACTIONS = new Set(['complete', 'claim', 'nudge'])

/**
 * True for a write the server deduplicates by Idempotency-Key: a record create / update /
 * delete under /items, a pipeline or workflow move, and a comment or task write.
 */
export function isKeyedWrite(method: string, path: string): boolean {
  const m = method.toUpperCase()
  const seg = bare(path).split('/').filter(Boolean)
  const n = seg.length
  switch (seg[0]) {
    case 'items':
      if (n < 2 || NOT_WORTH_WAITING.has(seg[1])) return false
      if (m === 'POST') return n === 2 && !ITEMS_POST_ROUTES.has(seg[1])
      if (m === 'PATCH') return n === 2 || n === 3
      if (m === 'DELETE') return n === 3
      return false
    // POST /pipelines/instance/:collection/:item/transition, /workflows/instance/:id/transition
    case 'pipelines':
      return m === 'POST' && n === 5 && seg[1] === 'instance' && seg[4] === 'transition'
    case 'workflows':
      return m === 'POST' && n === 4 && seg[1] === 'instance' && seg[3] === 'transition'
    case 'comments':
      if (m === 'POST')
        return (
          n === 1 ||
          (n === 2 && seg[1] === 'entry-reactions') ||
          (n === 3 && COMMENT_ACTIONS.has(seg[2]))
        )
      return (m === 'PATCH' || m === 'DELETE') && n === 2
    case 'tasks':
      if (m === 'POST') return n === 1 || (n === 3 && TASK_ACTIONS.has(seg[2]))
      return (m === 'PATCH' || m === 'DELETE') && n === 2
    default:
      return false
  }
}

/** POSTs that only read (batched GETs): they wait like a read and carry no key. */
export function isReadPost(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false
  const p = bare(path)
  return p === '/batch-get' || p === '/items/batch-read'
}

/** A fresh key for one write; every retry of that write sends the same one. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return `nvr-${c.randomUUID()}`
  return `nvr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** 503 codes that mean "passing, try again" — anything else coded is the app's answer. */
const PASSING_503 = new Set(['DB_UNAVAILABLE', 'SERVER_BUSY'])

/**
 * Should this outcome be retried? `status` undefined = no answer at all
 * (network error). `code` = the error body's code when there was one.
 * `method` is 'GET' for a read (a read-only POST is passed as 'GET').
 */
export function isRecoverable(
  method: string,
  outcome: { status?: number; code?: string | null; keyed: boolean }
): boolean {
  const read = method.toUpperCase() === 'GET'
  if (!read && !outcome.keyed) return false
  const { status, code } = outcome
  if (status === undefined) return true
  // A 502/504 carrying the app's own code is the app's answer about an upstream it relays (a
  // Hub agent, GitLab): the server is there, so nothing is waited out (P4-25).
  if (status === 502) return code == null
  if (status === 503) return code == null || PASSING_503.has(code)
  // The proxy stopped waiting for a slow request: a keyed write's retry waits for the
  // first try's answer; a read would only run slowly again.
  if (status === 504) return code == null && outcome.keyed
  // The first try of this very write is still running on the server: wait for its answer.
  if (status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS') return outcome.keyed
  return false
}

/** True when the final answer shows the server is back (a real answer, not "away" or broken). */
export function isServerBack(status: number | undefined, code?: string | null): boolean {
  if (status === undefined) return false
  // The app's own coded 502/504 (an upstream refusal): the server answered.
  if ((status === 502 || status === 504) && code) return true
  if (status >= 500) return false
  return code !== 'IDEMPOTENCY_IN_PROGRESS'
}

/** The wait before try `attempt + 1`. */
export function recoveryDelay(
  attempt: number,
  options: RecoveryOptions,
  retryAfterMs?: number | null
): number {
  const base = options.baseDelayMs ?? 1_000
  const max = options.maxDelayMs ?? 8_000
  if (retryAfterMs != null && retryAfterMs >= 0) return Math.min(Math.max(retryAfterMs, base), max)
  const exp = base * 2 ** attempt
  return Math.min(max, Math.round(exp / 2 + Math.random() * (exp / 2)))
}

export function recoveryBudget(options: RecoveryOptions): number {
  return options.budgetMs ?? 120_000
}

export interface Verdict {
  retry: boolean
  retryAfterMs?: number | null
  /** The answer shows the server is back (closes a wait with `recovered`, else `gave-up`). */
  back?: boolean
  /** The answer's error code (409 / 503 bodies), carried onto a `gave-up` event. */
  code?: string | null
}

/** Retry-After in seconds or an HTTP date → ms. */
function retryAfter(value: string | null | undefined): number | null {
  if (!value) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v) * 1000
  const at = Date.parse(v)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

function isAbort(err: unknown, signal?: AbortSignal | null): boolean {
  const name = (err as { name?: string } | null)?.name
  return !!signal?.aborted || name === 'AbortError' || name === 'CanceledError'
}

/**
 * The verdict for one try, the same for every client: `res` is the fetch Response (or
 * undefined when it threw `err`). Reads a COPY of a 409 / 503 body for its code, and
 * cancels the body of an answer that is about to be retried.
 */
export async function recoveryVerdict(
  method: string,
  keyed: boolean,
  res: Response | undefined,
  err: unknown,
  signal?: AbortSignal | null
): Promise<Verdict> {
  if (err !== undefined) {
    if (isAbort(err, signal) || (err as { name?: string })?.name === 'TimeoutError')
      return { retry: false, back: false }
    return { retry: isRecoverable(method, { keyed }), back: false }
  }
  if (!res) return { retry: false, back: false }
  if (res.ok) return { retry: false, back: true }
  const code =
    res.status === 409 || res.status === 502 || res.status === 503 || res.status === 504
      ? await res
          .clone()
          .json()
          .then((b: { code?: unknown } | null) => (typeof b?.code === 'string' ? b.code : null))
          .catch(() => null)
      : null
  const again = isRecoverable(method, { status: res.status, code, keyed })
  if (again) {
    try {
      await res.body?.cancel()
    } catch {
      /* the discarded body may already be closed */
    }
  }
  return {
    retry: again,
    retryAfterMs: retryAfter(res.headers?.get?.('retry-after')),
    back: isServerBack(res.status, code),
    ...(code ? { code } : {})
  }
}

/** A wait that ends early (with an AbortError) when `signal` aborts. */
export function recoverySleep(signal?: AbortSignal | null): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve, reject) => {
      const abort = () =>
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      if (signal?.aborted) return abort()
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(t)
        abort()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/** Marks an error that already waited out the whole budget, so callers do not retry it again. */
export function isRecoveryExhausted(err: unknown): boolean {
  return !!(err as { recoveryExhausted?: boolean } | null)?.recoveryExhausted
}

function markExhausted(err: unknown): void {
  if (err && typeof err === 'object') {
    try {
      ;(err as { recoveryExhausted?: boolean }).recoveryExhausted = true
    } catch {
      /* a frozen error stays as it is */
    }
  }
}

/**
 * The loop every client shares. `run(attempt)` performs one try and resolves
 * to its outcome; `verdict` says whether to try again and whether the answer
 * shows the server is back. Waits between tries, gives up when the budget is
 * spent, and closes every `waiting` with exactly one `recovered` or `gave-up`
 * (an abort during the wait included).
 */
export async function withRecovery<T>(
  info: { method: string; path: string; write: boolean },
  options: RecoveryOptions,
  run: (attempt: number) => Promise<T>,
  verdict: (result: T | undefined, error: unknown) => Verdict | Promise<Verdict>,
  sleep: (ms: number) => Promise<void> = recoverySleep()
): Promise<T> {
  const started = Date.now()
  const budget = recoveryBudget(options)
  let waiting = false
  const close = (back: boolean, extra: { aborted?: boolean; code?: string } = {}) => {
    if (!waiting) return
    waiting = false
    const waitedMs = Date.now() - started
    emitRecoveryEvent(
      back
        ? { type: 'recovered', ...info, waitedMs }
        : { type: 'gave-up', ...info, waitedMs, ...extra }
    )
  }
  for (let attempt = 0; ; attempt++) {
    let result: T | undefined
    let error: unknown
    try {
      result = await run(attempt)
    } catch (e) {
      error = e
    }
    let v: Verdict
    try {
      v = await verdict(result, error)
    } catch {
      v = { retry: false, back: false }
    }
    const elapsed = Date.now() - started
    const delay = v.retry ? recoveryDelay(attempt, options, v.retryAfterMs) : 0
    if (!v.retry || elapsed + delay > budget) {
      const exhausted = v.retry
      close(!exhausted && v.back !== false, {
        aborted: isAbort(error) || undefined,
        ...(v.code ? { code: v.code } : {})
      })
      if (exhausted) markExhausted(error ?? result)
      if (error !== undefined) throw error
      return result as T
    }
    if (!waiting) {
      waiting = true
      emitRecoveryEvent({ type: 'waiting', ...info })
    }
    try {
      await sleep(delay)
    } catch (e) {
      close(false, { aborted: true })
      throw e
    }
  }
}
