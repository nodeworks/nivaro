import { createSign } from 'node:crypto'
import { scrubValues } from '../context.js'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * Google calls for the Firebase adapter. The connection's secret is a service-account key (JSON).
 * It is parsed here only to mint an OAuth token (RS256 JWT, node `crypto`) at the fixed Google
 * token address (never the `token_uri` inside the JSON); the token is cached in `ctx.tokens`.
 * Every call goes through `ctx.fetch` (hosts `firebase.googleapis.com`, `oauth2.googleapis.com`,
 * `iam.googleapis.com`, `fcm.googleapis.com`). Error text is scrubbed (key, key id, private key
 * lines, tokens) BEFORE it is clipped; the private key is never logged or answered.
 */

export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const FIREBASE_ORIGIN = 'https://firebase.googleapis.com'
export const IAM_ORIGIN = 'https://iam.googleapis.com'
export const FCM_ORIGIN = 'https://fcm.googleapis.com'
export const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

export interface ServiceAccountKey {
  client_email: string
  private_key: string
  private_key_id: string
  project_id: string
}

/** The parsed key, or null when the text is not a usable service-account key. */
export function parseServiceAccount(text: unknown): ServiceAccountKey | null {
  let j: any
  try {
    j = JSON.parse(String(text ?? ''))
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || j.type !== 'service_account') return null
  const email = String(j.client_email ?? '')
  const pk = String(j.private_key ?? '')
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(email)) return null
  if (!pk.includes('PRIVATE KEY')) return null
  return {
    client_email: email,
    private_key: pk,
    private_key_id: String(j.private_key_id ?? ''),
    project_id: String(j.project_id ?? '')
  }
}

/** Everything of the key that must never reach an error text. */
export function keyScrubValues(sa: ServiceAccountKey | null): string[] {
  if (!sa) return []
  const lines = sa.private_key
    .split(/\r?\n|\\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 8 && !l.startsWith('-----'))
  return [sa.private_key, sa.private_key_id, ...lines]
}

function bad(what: string): ProviderError {
  return new ProviderError('BAD_ID', `That ${what} cannot be used in a Google address.`)
}

export const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
export function projectSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!PROJECT_RE.test(s)) throw bad('project id')
  return s
}

export const APP_ID_RE = /^1:\d{1,20}:(android|ios|web):[a-f0-9]{1,64}$/
export function appSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!APP_ID_RE.test(s)) throw bad('app id')
  return s
}

export const SA_EMAIL_RE = /^[A-Za-z0-9._-]{1,100}@[A-Za-z0-9.-]{1,100}\.gserviceaccount\.com$/
export function emailSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!SA_EMAIL_RE.test(s)) throw bad('service account')
  return s
}

export function keyIdSeg(value: unknown): string {
  const s = String(value ?? '')
  if (!/^[a-f0-9]{16,64}$/.test(s)) throw bad('key id')
  return s
}

/** The project this connection is pinned to (a non-secret connection field). */
export function pinnedProject(ctx: ProviderContext): string {
  return projectSeg(ctx.config.projectId)
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

async function mintToken(ctx: ProviderContext, sa: ServiceAccountKey): Promise<string> {
  const cacheKey = `google:${sa.client_email}:${sa.private_key_id}:${SCOPE}`
  const cached = ctx.tokens.get(cacheKey)
  if (cached) return cached
  const iat = Math.floor(ctx.now().getTime() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }))
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })
  )
  let sig: string
  try {
    sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key, 'base64url')
  } catch {
    throw new ProviderError('AUTH_FAILED', 'The service-account key could not sign a request.')
  }
  const scrub = (t: string) => scrubValues(ctx.scrub(t), keyScrubValues(sa))
  let res: Response
  try {
    res = await ctx.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${head}.${claims}.${sig}`
      }).toString()
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrub(err.message), { retryable: err.retryable })
    throw err
  }
  const text = await res.text().catch(() => '')
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  if (res.status >= 400 || typeof body?.access_token !== 'string') {
    const said = scrub(String(body?.error_description ?? body?.error ?? '')).slice(0, 200)
    throw new ProviderError(
      res.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'AUTH_FAILED',
      scrub(`Google refused the service-account key (${res.status})${said ? `: ${said}` : ''}`),
      { retryable: isRetryableStatus(res.status), status: res.status }
    )
  }
  const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600
  ctx.tokens.set(cacheKey, body.access_token, new Date(ctx.now().getTime() + expiresIn * 1000))
  return body.access_token
}

export interface GoogleCall {
  query?: Record<string, string | number | undefined>
  body?: unknown
  extraScrub?: string[]
  allow?: number[]
}

export interface GoogleAnswer<T = any> {
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

export async function googleCall<T = any>(
  ctx: ProviderContext,
  origin: string,
  method: string,
  path: string,
  call: GoogleCall = {}
): Promise<GoogleAnswer<T>> {
  const sa = parseServiceAccount(ctx.secrets.serviceAccountJson)
  if (!sa)
    throw new ProviderError('AUTH_FAILED', 'The connection has no usable service-account key.')
  const scrub = (t: string) =>
    scrubValues(ctx.scrub(t), [...keyScrubValues(sa), ...(call.extraScrub ?? [])])
  const token = await mintToken(ctx, sa)
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(call.query ?? {}))
    if (v !== undefined && v !== '') params.set(k, String(v))
  const qs = params.toString()
  const hasBody = call.body !== undefined
  let res: Response
  try {
    res = await ctx.fetch(`${origin}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {})
      },
      body: hasBody ? JSON.stringify(call.body) : null
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrub(err.message), { retryable: err.retryable })
    throw err
  }
  const text = await res.text().catch(() => '')
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (res.status >= 400 && !(call.allow ?? []).includes(res.status)) {
    const raw = typeof body === 'string' ? body : String(body?.error?.message ?? '')
    const said = scrub(raw).slice(0, 300)
    const message = scrub(`Google answered ${res.status}${said ? `: ${said}` : ''}`)
    throw new ProviderError(codeFor(res.status), message, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  return { status: res.status, body: body as T }
}
