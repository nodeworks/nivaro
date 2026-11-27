import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Redis Cloud API calls for the adapter. Every call goes through `ctx.fetch` (host
 * `api.redislabs.com`), carries the account key and user key as `x-api-key` / `x-api-secret-key`,
 * and turns an HTTP error into a `ProviderError` whose text is scrubbed of the connection's
 * secrets. Writes are asynchronous: the API answers 202 with a task id and `waitTask` polls
 * `/tasks/:id` until the task is done.
 */

export const RC_ORIGIN = 'https://api.redislabs.com/v1'

/** Between two task polls; the whole wait is bounded by `TASK_MAX_MS` and the run's signal. */
export const TASK_POLL_MS = 3000
export const TASK_MAX_MS = 240_000

export interface RcCall {
  body?: unknown
  query?: Record<string, string | number | undefined>
  extraScrub?: string[]
  allow?: number[]
}

export interface RcAnswer<T = any> {
  status: number
  body: T
}

function codeFor(status: number): string {
  if (status === 401) return 'AUTH_FAILED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REJECTED'
}

/** A numeric id for a URL path (Redis Cloud ids are integers). */
export function numSegment(id: unknown): string {
  const s = typeof id === 'number' ? String(id) : typeof id === 'string' ? id : ''
  if (!/^\d{1,12}$/.test(s))
    throw new ProviderError('BAD_ID', 'The provider id has the wrong shape.')
  return s
}

/** A task id for a URL path: letters, digits, dashes, underscores. */
function taskSegment(id: unknown): string {
  const s = typeof id === 'string' ? id : ''
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s))
    throw new ProviderError('BAD_ID', 'The task id has the wrong shape.')
  return s
}

function errorText(body: any): string {
  const e = body?.error ?? body?.response?.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const bits = [e.type, e.description].filter((x) => typeof x === 'string' && x)
    if (bits.length) return bits.join(': ')
  }
  return typeof body?.description === 'string' ? body.description : ''
}

export async function rcCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: RcCall = {}
): Promise<RcAnswer<T>> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const scrub = (t: string) => scrubValues(ctx.scrub(t), call.extraScrub ?? [])
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${RC_ORIGIN}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        'x-api-key': ctx.secrets.accountKey ?? '',
        'x-api-secret-key': ctx.secrets.userKey ?? '',
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {})
      },
      body: hasBody ? JSON.stringify(call.body) : null
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrub(err.message), {
        retryable: err.retryable
      })
    throw err
  }
  const text = await res.text().catch(() => '')
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status)) {
    const said = errorText(body)
    const retryAfter = res.headers.get('retry-after')
    const message = scrub(
      `Redis Cloud answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    )
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('CANCELLED', 'The run was cancelled.'))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new ProviderError('CANCELLED', 'The run was cancelled.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export interface TaskDone {
  taskId: string
  /** The id of the resource the task made or changed (a database or subscription id), if any. */
  resourceId: number | null
}

/** The task id a 202 answer carries. */
export function taskIdOf(body: any): string {
  const id = body?.taskId
  if (typeof id !== 'string' || !id)
    throw new ProviderError('PROVIDER_REJECTED', 'Redis Cloud did not accept the change as a task.')
  return id
}

/**
 * Polls a task until it is completed (answers its resource id), failed (throws, not retryable,
 * with the provider's text scrubbed) or the bounded wait runs out (throws a RETRYABLE
 * `TASK_PENDING` naming the task, so a resume polls it again instead of starting a second one).
 */
export async function waitTask(
  ctx: ProviderContext,
  taskId: string,
  opts: { maxMs?: number; pollMs?: number } = {}
): Promise<TaskDone> {
  const maxMs = opts.maxMs ?? TASK_MAX_MS
  const pollMs = opts.pollMs ?? TASK_POLL_MS
  const start = ctx.now().getTime()
  let waited = 0
  for (;;) {
    const r = await rcCall(ctx, 'GET', `/tasks/${taskSegment(taskId)}`)
    const status = String(r.body?.status ?? '')
    if (status === 'processing-completed') {
      const rid = r.body?.response?.resourceId
      return { taskId, resourceId: typeof rid === 'number' ? rid : null }
    }
    if (status === 'processing-error') {
      const said = errorText(r.body)
      throw new ProviderError(
        'PROVIDER_REJECTED',
        ctx.scrub(`Redis Cloud could not finish the change${said ? `: ${said}` : ''}.`)
      )
    }
    if (waited >= maxMs || ctx.now().getTime() - start >= maxMs)
      throw new ProviderError(
        'TASK_PENDING',
        `Redis Cloud is still working on the change (task ${taskId}). Resume to keep waiting.`,
        { retryable: true }
      )
    await sleep(pollMs, ctx.signal)
    waited += pollMs
  }
}
