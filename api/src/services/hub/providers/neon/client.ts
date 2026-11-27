import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Neon REST calls for the adapter. Every call goes through `ctx.fetch` (host `console.neon.tech`)
 * and turns an HTTP error into a `ProviderError` whose text is scrubbed of the connection's
 * secrets. The organisation is pinned by the connection (`orgId`): listings and creates carry it,
 * and every read of a project checks the project's own `org_id` (children are judged through
 * their parent project, see `projectInOrg` in index.ts).
 */

export const NEON_ORIGIN = 'https://console.neon.tech/api/v2'

export interface NeonCall {
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Statuses that are answered, not thrown (e.g. 404 on a read). */
  allow?: number[]
}

export interface NeonAnswer<T = any> {
  status: number
  body: T
}

export function orgIdOf(ctx: ProviderContext): string {
  return String(ctx.config.orgId ?? '')
}

/**
 * An id or name that goes into a URL path: refuses empty, `.`/`..`, separators and control
 * characters, then encodes it. Every id the adapter builds a path from passes through here.
 */
export function seg(value: unknown): string {
  const s = typeof value === 'string' ? value : ''
  let bad = !s || s === '.' || s === '..' || s.length > 200
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (ch === '/' || ch === '\\' || c < 0x20 || c === 0x7f) bad = true
  }
  if (bad) throw new ProviderError('BAD_ID', 'An id or name has a form Neon never uses.')
  return encodeURIComponent(s)
}

function codeFor(status: number): string {
  if (status === 401) return 'AUTH_FAILED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 423) return 'PROJECT_BUSY'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REJECTED'
}

export async function neonCall<T = any>(
  ctx: ProviderContext,
  method: string,
  path: string,
  call: NeonCall = {}
): Promise<NeonAnswer<T>> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${NEON_ORIGIN}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.secrets.apiKey ?? ''}`,
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {})
      },
      body: hasBody ? JSON.stringify(call.body) : null
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, ctx.scrub(err.message), {
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
    const said = typeof body?.message === 'string' ? body.message : ''
    const retryAfter = res.headers.get('retry-after')
    const message = ctx.scrub(
      `Neon answered ${res.status}${said ? `: ${said}` : ''}${
        res.status === 429 && retryAfter ? ` (retry after ${retryAfter} s)` : ''
      }`
    )
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status) || res.status === 423,
      status: res.status
    })
  }
  return { status: res.status, body: body as T }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })

const DONE = new Set(['finished', 'skipped', 'cancelled'])
const BAD = new Set(['failed', 'error'])

/**
 * Neon runs most writes as operations. Waits (bounded) for the ones a write answered, so the
 * next step finds the resource ready. A failed operation throws; running out of time is retryable.
 */
export async function waitOperations(
  ctx: ProviderContext,
  projectId: string,
  operations: unknown,
  opts: { pollMs?: number; tries?: number } = {}
): Promise<void> {
  const list = Array.isArray(operations) ? operations : []
  const pollMs = opts.pollMs ?? 750
  const tries = opts.tries ?? 40
  const failed = (action: unknown) =>
    new ProviderError(
      'OPERATION_FAILED',
      `Neon could not finish the ${String(action ?? 'operation')}.`
    )
  for (const op of list) {
    let status = String(op?.status ?? '')
    const id = typeof op?.id === 'string' ? op.id : ''
    for (let i = 0; i < tries; i++) {
      if (DONE.has(status)) break
      if (BAD.has(status)) throw failed(op?.action)
      if (!id) return
      if (i > 0) await sleep(pollMs, ctx.signal)
      if (ctx.signal.aborted)
        throw new ProviderError('ABORTED', 'The run was cancelled while waiting for Neon.')
      const r = await neonCall(ctx, 'GET', `/projects/${seg(projectId)}/operations/${seg(id)}`, {
        allow: [404]
      })
      status = r.status === 404 ? 'finished' : String(r.body?.operation?.status ?? '')
    }
    if (BAD.has(status)) throw failed(op?.action)
    if (!DONE.has(status))
      throw new ProviderError(
        'OPERATION_TIMEOUT',
        'Neon is still working on the change; try again shortly.',
        { retryable: true }
      )
  }
}
