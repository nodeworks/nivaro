import { createHash, createHmac } from 'node:crypto'
import { db } from '../db/index.js'

type AuthType = 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2_cc' | 'hmac' | 'aws_sigv4'

interface ExternalApiRow {
  id: number
  name: string
  base_url: string
  auth_type: AuthType
  auth_config: string | null
  headers: string | null
  enabled: boolean
}

interface BearerConfig {
  token: string
}
interface ApiKeyConfig {
  key: string
  value: string
  in: 'header' | 'query'
  param_name: string
}
interface BasicConfig {
  username: string
  password: string
}
interface OAuth2CCConfig {
  client_id: string
  client_secret: string
  token_url: string
  scope?: string
}
interface HmacConfig {
  secret: string
  header_name?: string
  algorithm?: 'sha256' | 'sha1' | 'sha512'
}
interface AwsSigV4Config {
  region: string
  service: string
  access_key: string
  secret_key: string
}

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

// ─── Header masking ───────────────────────────────────────────────────────────

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'cookie',
  'set-cookie',
  'proxy-authorization'
])

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    const isSensitive =
      SENSITIVE_HEADER_NAMES.has(lk) ||
      lk.includes('secret') ||
      lk.includes('token') ||
      lk.includes('password') ||
      lk.includes('api-key') ||
      lk.includes('apikey')
    if (isSensitive && v) {
      if (lk === 'authorization') {
        const parts = v.split(' ')
        out[k] = parts.length > 1 ? `${parts[0]} ••••••` : '••••••'
      } else {
        out[k] = '••••••'
      }
    } else {
      out[k] = v
    }
  }
  return out
}

const BODY_TRUNCATE = 50_000 // 50KB

function truncate(s: string | null | undefined): string | null {
  if (s == null) return null
  return s.length > BODY_TRUNCATE ? `${s.slice(0, BODY_TRUNCATE)}… [truncated]` : s
}

// ─── Log writer ───────────────────────────────────────────────────────────────

export interface ApiCallLogEntry {
  api_id: number
  endpoint_id?: number | null
  triggered_by: string
  method: string
  url: string
  request_headers?: Record<string, string> | null
  request_body?: string | null
  response_status?: number | null
  response_headers?: Record<string, string> | null
  response_body?: string | null
  duration_ms?: number | null
  error?: string | null
  user_id?: string | null
}

export async function writeApiCallLog(entry: ApiCallLogEntry): Promise<void> {
  try {
    await db('nivaro_external_api_logs').insert({
      api_id: entry.api_id,
      endpoint_id: entry.endpoint_id ?? null,
      triggered_by: entry.triggered_by,
      method: entry.method,
      url: entry.url,
      request_headers: entry.request_headers
        ? JSON.stringify(maskHeaders(entry.request_headers))
        : null,
      request_body: truncate(entry.request_body),
      response_status: entry.response_status ?? null,
      response_headers: entry.response_headers ? JSON.stringify(entry.response_headers) : null,
      response_body: truncate(entry.response_body),
      duration_ms: entry.duration_ms ?? null,
      error: entry.error ?? null,
      user_id: entry.user_id ?? null,
      created_at: new Date()
    })
  } catch {
    // Never throw — log failure must not affect the calling operation
  }
}

// ─── Auth resolution ──────────────────────────────────────────────────────────

async function resolveAuth(
  authType: AuthType,
  cfg: Record<string, unknown> | null
): Promise<{ headers: Record<string, string>; queryParams: Record<string, string> }> {
  const headers: Record<string, string> = {}
  const queryParams: Record<string, string> = {}

  switch (authType) {
    case 'bearer': {
      const c = cfg as unknown as BearerConfig | null
      if (c?.token) headers.Authorization = `Bearer ${c.token}`
      break
    }
    case 'api_key': {
      const c = cfg as unknown as ApiKeyConfig | null
      if (c?.value) {
        const param = c.param_name || c.key
        if (c.in === 'query') {
          if (param) queryParams[param] = c.value
        } else if (param) headers[param] = c.value
      }
      break
    }
    case 'basic': {
      const c = cfg as unknown as BasicConfig | null
      if (c?.username != null) {
        const encoded = Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64')
        headers.Authorization = `Basic ${encoded}`
      }
      break
    }
    case 'oauth2_cc': {
      const c = cfg as unknown as OAuth2CCConfig | null
      if (c?.token_url && c.client_id) {
        const res = await fetch(c.token_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: c.client_id,
            client_secret: c.client_secret ?? '',
            ...(c.scope ? { scope: c.scope } : {})
          })
        })
        const body = (await res.json()) as { access_token?: string }
        if (body.access_token) headers.Authorization = `Bearer ${body.access_token}`
      }
      break
    }
  }

  return { headers, queryParams }
}

// ─── Body-dependent signing (hmac, aws_sigv4) ────────────────────────────────
// These auth types sign the final request (body and/or canonical URL), so they
// run AFTER the body string is built — unlike resolveAuth which runs before.

function applyHmacAuth(
  cfg: HmacConfig | null,
  headers: Record<string, string>,
  bodyStr: string | null
): void {
  if (!cfg?.secret) return
  const algorithm = cfg.algorithm ?? 'sha256'
  const headerName = cfg.header_name || 'X-Signature'
  const signature = createHmac(algorithm, cfg.secret)
    .update(bodyStr ?? '')
    .digest('hex')
  headers[headerName] = signature
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmacBuf(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Manual AWS Signature Version 4 signing (node:crypto only).
 * Adds Host, X-Amz-Date, X-Amz-Content-Sha256 and Authorization headers.
 */
function applyAwsSigV4Auth(
  cfg: AwsSigV4Config | null,
  method: string,
  url: URL,
  headers: Record<string, string>,
  bodyStr: string | null
): void {
  if (!cfg?.access_key || !cfg.secret_key || !cfg.region || !cfg.service) return

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8) // YYYYMMDD

  const payloadHash = sha256Hex(bodyStr ?? '')

  headers.Host = url.host
  headers['X-Amz-Date'] = amzDate
  headers['X-Amz-Content-Sha256'] = payloadHash

  // Canonical query string — params sorted by key, RFC 3986 encoded.
  const params: Array<[string, string]> = []
  url.searchParams.forEach((v, k) => {
    params.push([k, v])
  })
  params.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
  const enc = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    )
  const canonicalQuery = params.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')

  // Canonical headers — lowercase names, sorted, trimmed values.
  const signable = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : 1))
  const canonicalHeaders = signable.map(([k, v]) => `${k}:${v}\n`).join('')
  const signedHeaders = signable.map(([k]) => k).join(';')

  const canonicalUri =
    url.pathname
      .split('/')
      .map((seg) => enc(decodeURIComponent(seg)))
      .join('/') || '/'

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const credentialScope = `${dateStamp}/${cfg.region}/${cfg.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n')

  const kDate = hmacBuf(`AWS4${cfg.secret_key}`, dateStamp)
  const kRegion = hmacBuf(kDate, cfg.region)
  const kService = hmacBuf(kRegion, cfg.service)
  const kSigning = hmacBuf(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.access_key}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface CallOptions {
  method?: string
  path?: string
  body?: unknown
  headers?: Record<string, string>
  query?: Record<string, string>
  timeoutMs?: number
  /** Pre-defined endpoint name or id. Sets method/path/body/query/headers defaults; caller options override. */
  endpoint?: string | number
  /** Logging context — omit to skip logging. */
  _log?: {
    triggeredBy?: string
    userId?: string
  }
}

export interface CallResult {
  status: number
  headers: Record<string, string>
  body: unknown
}

interface EndpointDefRow {
  id: number
  api_id: number
  name: string
  method: string
  path: string
  default_body: string | null
  default_query: string | null
  default_headers: string | null
}

/**
 * Call a configured external API by name or numeric ID.
 * Handles all auth types automatically (bearer, api_key, basic, oauth2_cc).
 * Pass `_log: { triggeredBy }` in options to write a call log to nivaro_external_api_logs.
 */
export async function callExternalApi(
  nameOrId: string | number,
  options: CallOptions = {}
): Promise<CallResult> {
  const row: ExternalApiRow | undefined =
    typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId))
      ? await db('nivaro_external_apis')
          .where({ id: Number(nameOrId) })
          .first()
      : await db('nivaro_external_apis').where({ name: nameOrId }).first()

  if (!row) throw new Error(`External API not found: ${nameOrId}`)
  if (!row.enabled) throw new Error(`External API is disabled: ${row.name}`)

  let epId: number | undefined
  let epMethod: string | undefined
  let epPath: string | undefined
  let epBody: unknown
  let epQuery: Record<string, string> | undefined
  let epHeaders: Record<string, string> | undefined

  if (options.endpoint !== undefined) {
    const ep: EndpointDefRow | undefined =
      typeof options.endpoint === 'number' || /^\d+$/.test(String(options.endpoint))
        ? await db('nivaro_external_api_endpoints')
            .where({ id: Number(options.endpoint), api_id: row.id })
            .first()
        : await db('nivaro_external_api_endpoints')
            .where({ name: options.endpoint, api_id: row.id })
            .first()
    if (!ep) throw new Error(`Endpoint not found: ${options.endpoint}`)
    epId = ep.id
    epMethod = ep.method
    epPath = ep.path
    epBody = parseJson(ep.default_body) ?? undefined
    epQuery = parseJson<Record<string, string>>(ep.default_query) ?? undefined
    epHeaders = parseJson<Record<string, string>>(ep.default_headers) ?? undefined
  }

  const method = (options.method ?? epMethod ?? 'GET').toUpperCase()
  const path = options.path ?? epPath ?? ''
  const body = options.body !== undefined ? options.body : epBody
  const extraQuery = { ...epQuery, ...(options.query ?? {}) }
  const extraHeaders = { ...epHeaders, ...(options.headers ?? {}) }
  const timeoutMs = options.timeoutMs ?? 10_000

  const cfg = parseJson<Record<string, unknown>>(row.auth_config)
  const staticHeaders = parseJson<Record<string, string>>(row.headers) ?? {}
  const auth = await resolveAuth(row.auth_type, cfg)

  const base = row.base_url.replace(/\/+$/, '')
  const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
  const url = new URL(base + suffix)
  for (const [k, v] of Object.entries(auth.queryParams)) url.searchParams.set(k, v)
  for (const [k, v] of Object.entries(extraQuery)) url.searchParams.set(k, v)

  const reqHeaders: Record<string, string> = { ...staticHeaders, ...auth.headers, ...extraHeaders }
  const init: RequestInit = { method, headers: reqHeaders }

  let reqBodyStr: string | null = null
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
    if (!Object.keys(reqHeaders).some((h) => h.toLowerCase() === 'content-type')) {
      reqHeaders['Content-Type'] = 'application/json'
    }
    reqBodyStr = typeof body === 'string' ? body : JSON.stringify(body)
    init.body = reqBodyStr
  }

  // Body-dependent auth types — signed against the final body / canonical URL.
  if (row.auth_type === 'hmac') {
    applyHmacAuth(cfg as unknown as HmacConfig | null, reqHeaders, reqBodyStr)
  } else if (row.auth_type === 'aws_sigv4') {
    applyAwsSigV4Auth(cfg as unknown as AwsSigV4Config | null, method, url, reqHeaders, reqBodyStr)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  init.signal = controller.signal

  const startMs = Date.now()
  let res: Response | null = null
  let fetchError: string | null = null

  try {
    res = await fetch(url.toString(), init)
  } catch (err) {
    fetchError =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `Timed out after ${timeoutMs}ms`
          : err.message
        : String(err)
  } finally {
    clearTimeout(timer)
  }

  const durationMs = Date.now() - startMs

  if (fetchError || !res) {
    if (options._log) {
      await writeApiCallLog({
        api_id: row.id,
        endpoint_id: epId ?? null,
        triggered_by: options._log.triggeredBy ?? 'extension',
        method,
        url: url.toString(),
        request_headers: reqHeaders,
        request_body: reqBodyStr,
        duration_ms: durationMs,
        error: fetchError ?? 'No response',
        user_id: options._log.userId ?? null
      })
    }
    throw new Error(fetchError ?? 'Request failed')
  }

  const resHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    resHeaders[k] = v
  })

  const text = await res.text()
  let parsedBody: unknown = text
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      parsedBody = JSON.parse(text)
    } catch {
      parsedBody = text
    }
  }

  if (options._log) {
    await writeApiCallLog({
      api_id: row.id,
      endpoint_id: epId ?? null,
      triggered_by: options._log.triggeredBy ?? 'extension',
      method,
      url: url.toString(),
      request_headers: reqHeaders,
      request_body: reqBodyStr,
      response_status: res.status,
      response_headers: resHeaders,
      response_body: text,
      duration_ms: durationMs,
      user_id: options._log.userId ?? null
    })
  }

  return { status: res.status, headers: resHeaders, body: parsedBody }
}
