import { createSign } from 'node:crypto'
import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

/**
 * GitHub REST access for the adapter: authentication (GitHub App JWT → installation token cached
 * in `ctx.tokens`, or a PAT), one request helper that maps every failure to a scrubbed
 * `ProviderError`, and link-header pagination. Nothing here logs a token or a provider body.
 */

export const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const INSTALLATION_KEY = 'installation'
const INSTALLATION_PERMS_KEY = 'installation-permissions'

export type GithubAuthMethod = 'app' | 'pat'

export function authMethod(ctx: ProviderContext): GithubAuthMethod {
  return ctx.config.auth_method === 'pat' ? 'pat' : 'app'
}

/** The account (organisation or user login) whose repositories this connection manages. */
export function ownerOf(ctx: ProviderContext): string {
  return String(ctx.config.owner ?? '').trim()
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** A PEM pasted into a one-line field often arrives with literal "\n" — put the newlines back. */
function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem
}

/** The app JWT (RS256, 9 minutes). Never cached, never logged. */
export function appJwt(ctx: ProviderContext): string {
  const appId = String(ctx.config.app_id ?? '').trim()
  const pem = normalizePem(ctx.secrets.private_key ?? '')
  if (!appId || !pem.trim())
    throw new ProviderError('AUTH_INCOMPLETE', 'The GitHub App id and private key are both needed.')
  const nowSec = Math.floor(ctx.now().getTime() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }))
  try {
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem)
    return `${head}.${body}.${b64url(sig)}`
  } catch {
    throw new ProviderError('AUTH_FAILED', 'The GitHub App private key could not be used to sign.')
  }
}

interface RawResult {
  status: number
  headers: Headers
  json: unknown
}

async function send(
  ctx: ProviderContext,
  method: string,
  url: string,
  token: string,
  body?: unknown
): Promise<RawResult> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'nivaro-hub',
    authorization: `Bearer ${token}`
  }
  let payload: string | null = null
  if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['content-type'] = 'application/json'
  }
  let res: Response
  try {
    res = await ctx.fetch(url, { method, headers, body: payload })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, ctx.scrub(err.message), {
        retryable: err.retryable
      })
    throw new ProviderError('NETWORK', 'Could not reach GitHub.', { retryable: true })
  }
  const text = await res.text().catch(() => '')
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: res.status, headers: res.headers, json }
}

function messageOf(r: RawResult): string {
  const m = (r.json as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m : ''
}

/** The error an unexpected status becomes. Provider text is scrubbed of the connection's secrets. */
function failFrom(ctx: ProviderContext, r: RawResult, what: string): ProviderError {
  const detail = ctx.scrub(messageOf(r)).slice(0, 300)
  const suffix = detail ? ` ${detail}` : ''
  const rateLimited =
    r.status === 429 ||
    (r.status === 403 &&
      (r.headers.get('x-ratelimit-remaining') === '0' ||
        r.headers.has('retry-after') ||
        /rate limit|abuse/i.test(detail)))
  if (rateLimited)
    return new ProviderError('RATE_LIMITED', `GitHub is rate limiting this connection.${suffix}`, {
      retryable: true,
      status: r.status
    })
  if (r.status === 401)
    return new ProviderError('AUTH_FAILED', `GitHub refused the credentials.${suffix}`, {
      status: 401
    })
  if (r.status === 403)
    return new ProviderError('FORBIDDEN', `The connection is not allowed to ${what}.${suffix}`, {
      status: 403
    })
  if (r.status === 404)
    return new ProviderError('NOT_FOUND', `${what}: GitHub could not find it.${suffix}`, {
      status: 404
    })
  if (r.status === 409)
    return new ProviderError('CONFLICT', `${what}: GitHub reports a conflict.${suffix}`, {
      status: 409
    })
  if (r.status === 422)
    return new ProviderError('VALIDATION', `${what}: GitHub refused the values.${suffix}`, {
      status: 422
    })
  return new ProviderError(
    isRetryableStatus(r.status) ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR',
    `${what}: GitHub answered ${r.status}.${suffix}`,
    { retryable: isRetryableStatus(r.status), status: r.status }
  )
}

/** The bearer for REST calls: a PAT, or an installation token minted from the app (cached). */
async function bearer(ctx: ProviderContext): Promise<string> {
  if (authMethod(ctx) === 'pat') {
    const t = (ctx.secrets.token ?? '').trim()
    if (!t) throw new ProviderError('AUTH_INCOMPLETE', 'The personal access token is missing.')
    return t
  }
  const cached = ctx.tokens.get(INSTALLATION_KEY)
  if (cached) return cached
  const installation = String(ctx.config.installation_id ?? '').trim()
  if (!installation)
    throw new ProviderError('AUTH_INCOMPLETE', 'The GitHub App installation id is missing.')
  const r = await send(
    ctx,
    'POST',
    `${GITHUB_API}/app/installations/${encodeURIComponent(installation)}/access_tokens`,
    appJwt(ctx),
    {}
  )
  if (r.status !== 201 && r.status !== 200) throw failFrom(ctx, r, 'mint an installation token')
  const j = r.json as { token?: unknown; expires_at?: unknown; permissions?: unknown } | null
  if (typeof j?.token !== 'string')
    throw new ProviderError('PROVIDER_ERROR', 'GitHub did not return an installation token.')
  const expires =
    typeof j.expires_at === 'string'
      ? new Date(j.expires_at)
      : new Date(ctx.now().getTime() + 3_600_000)
  ctx.tokens.set(INSTALLATION_KEY, j.token, expires)
  ctx.tokens.set(INSTALLATION_PERMS_KEY, JSON.stringify(j.permissions ?? {}), expires)
  return j.token
}

/** The permissions GitHub says the installation token holds (app auth only). */
export async function installationPermissions(
  ctx: ProviderContext
): Promise<Record<string, string>> {
  await bearer(ctx)
  const raw = ctx.tokens.get(INSTALLATION_PERMS_KEY)
  try {
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export interface GhResponse<T = unknown> {
  status: number
  json: T
  headers: Headers
}

export interface GhOptions {
  body?: unknown
  /** Statuses that are answers, not failures (e.g. 404 for a read). */
  ok?: number[]
  what?: string
}

/**
 * One GitHub call. 2xx and the statuses in `ok` come back; everything else throws a
 * ProviderError. A 401 on a cached installation token drops it and retries once.
 */
export async function gh<T = unknown>(
  ctx: ProviderContext,
  method: string,
  path: string,
  opts: GhOptions = {}
): Promise<GhResponse<T>> {
  const url = path.startsWith('https://') ? path : `${GITHUB_API}${path}`
  const what = opts.what ?? `${method} ${path.split('?')[0]}`
  let token = await bearer(ctx)
  let r = await send(ctx, method, url, token, opts.body)
  if (r.status === 401 && authMethod(ctx) === 'app') {
    ctx.tokens.delete(INSTALLATION_KEY)
    ctx.tokens.delete(INSTALLATION_PERMS_KEY)
    token = await bearer(ctx)
    r = await send(ctx, method, url, token, opts.body)
  }
  if ((r.status >= 200 && r.status < 300) || opts.ok?.includes(r.status))
    return { status: r.status, json: r.json as T, headers: r.headers }
  throw failFrom(ctx, r, what)
}

/** Next page number from a `Link` header, or null. */
export function nextPage(headers: Headers): number | null {
  const link = headers.get('link')
  if (!link) return null
  for (const part of link.split(',')) {
    if (!/rel="next"/.test(part)) continue
    const m = /[?&]page=(\d+)/.exec(part)
    if (m) return Number(m[1])
  }
  return null
}

/** Every item of a list endpoint, page by page (capped at 10 pages of 100). */
export async function ghAll<T>(
  ctx: ProviderContext,
  path: string,
  pick: (json: unknown) => T[] = (j) => (Array.isArray(j) ? (j as T[]) : [])
): Promise<T[]> {
  const out: T[] = []
  let page: number | null = 1
  for (let i = 0; i < 10 && page; i++) {
    const sep = path.includes('?') ? '&' : '?'
    const r: GhResponse = await gh(ctx, 'GET', `${path}${sep}per_page=100&page=${page}`)
    out.push(...pick(r.json))
    page = nextPage(r.headers)
  }
  return out
}

function badId(what: string, value: unknown): ProviderError {
  const shown = JSON.stringify(String(value ?? '')).slice(0, 60)
  return new ProviderError('BAD_ID', `${shown} is not a valid ${what}.`)
}

const CONTROL = {
  test(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c < 0x20 || c === 0x7f) return true
    }
    return false
  }
}

/**
 * One path segment, encoded. Refuses what could move the call to another endpoint: empty, `.`,
 * `..` (also written %2e), a slash or backslash, control characters.
 */
export function seg(value: string): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    /^(\.|%2e)+$/i.test(value) ||
    /[\\/]/.test(value) ||
    CONTROL.test(value)
  )
    throw badId('path segment', value)
  return encodeURIComponent(value)
}

function matching(re: RegExp, what: string, value: unknown): string {
  if (typeof value !== 'string' || !re.test(value)) throw badId(what, value)
  seg(value)
  return value
}

export const checkOwner = (v: unknown): string =>
  matching(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'account name', v)
export const checkRepoName = (v: unknown): string =>
  matching(/^[A-Za-z0-9._-]{1,100}$/, 'repository name', v)
export const checkEnvName = (v: unknown): string =>
  matching(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,254}$/, 'environment name', v)
export const checkVarName = (v: unknown): string =>
  matching(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/, 'secret or variable name', v)
export const checkWorkflowFile = (v: unknown): string =>
  matching(/^[A-Za-z0-9._-]+\.ya?ml$/, 'workflow file name', v)
export const checkSlug = (v: unknown): string =>
  matching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'team name', v)
export const checkNumericId = (v: unknown): string => matching(/^\d{1,20}$/, 'numeric id', v)

/** A branch name in a path (git ref rules): slashes stay, every other character is encoded. */
export function branchPath(branch: string): string {
  if (
    typeof branch !== 'string' ||
    branch === '' ||
    branch.length > 250 ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch === '@' ||
    branch.includes('..') ||
    branch.includes('\\') ||
    /[ ~^:?*[]/.test(branch) ||
    CONTROL.test(branch) ||
    branch.endsWith('.') ||
    branch.endsWith('.lock')
  )
    throw badId('branch name', branch)
  const parts = branch.split('/')
  for (const p of parts)
    if (p === '' || p.startsWith('.') || p.endsWith('.lock')) throw badId('branch name', branch)
  return parts.map(seg).join('/')
}

/** The account an external id belongs to: everything before the first `/`, `#` or `@`. */
export function accountOf(ext: string): string {
  return String(ext ?? '').split(/[/#@]/)[0]
}

/**
 * A file path in the contents API: slash-separated, each segment validated like any path
 * segment (no empty, `.`, `..`, backslash, control character), no leading or trailing slash.
 */
export function filePath(path: string): string {
  if (typeof path !== 'string' || path === '' || path.length > 500) throw badId('file path', path)
  if (path.startsWith('/') || path.endsWith('/')) throw badId('file path', path)
  return path.split('/').map(seg).join('/')
}

/** true when the id names the account this connection is pinned to (case-insensitive). */
export function inAccount(ctx: ProviderContext, ext: string): boolean {
  // A malformed account part is a bad id, not "someone else's".
  return checkOwner(accountOf(ext)).toLowerCase() === ownerOf(ctx).toLowerCase()
}

/** Refuses an id of another account: a connection reads and writes only its own account. */
export function assertInAccount(ctx: ProviderContext, ext: string): void {
  if (!inAccount(ctx, ext))
    throw new ProviderError(
      'GITHUB_OUT_OF_ACCOUNT',
      `That resource belongs to another GitHub account than ${ownerOf(ctx) || 'this connection'}.`
    )
}
