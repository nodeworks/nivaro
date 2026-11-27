import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { crypto as acmeCrypto, Client } from 'acme-client'
import { scrubValues } from '../context.js'
import {
  type ConnectionField,
  isRetryableStatus,
  type ProviderContext,
  ProviderError
} from '../types.js'

/**
 * ACME (Let's Encrypt) transport and connection form (Hub providers Task 38).
 *
 * The maintained `acme-client` package does every piece of cryptography and protocol (JWS, nonces,
 * orders, CSRs); this file only gives it a transport. Its own HTTP layer (axios) is never used:
 * `client.http.request` is replaced PER CLIENT INSTANCE by a function that sends through
 * `ctx.fetch`, so every call obeys the connection's host allowlist (the directory host), https
 * only, the abort signal and the fetch timeout — and no module-level state is touched.
 *
 * Secrets: the ACME account key (connection secret) and a certificate's private key never leave
 * this folder as text: errors are scrubbed with the connection's secrets plus the key being used
 * (`scrubAll`), and the private key only travels in `OpResult.outputs`.
 */

export const LETSENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'
export const LETSENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'
const STAGING_HOST = 'acme-staging-v02.api.letsencrypt.org'
const PRODUCTION_HOST = 'acme-v02.api.letsencrypt.org'

export type DirectoryChoice = 'letsencrypt_staging' | 'letsencrypt_production' | 'custom'
export const DEFAULT_DIRECTORY: DirectoryChoice = 'letsencrypt_staging'
export const DNS_WAIT_DEFAULT_SECONDS = 10
export const DNS_WAIT_MAX_SECONDS = 120

export const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/

/** One DNS label sequence: letters, digits, hyphens, dots; no trailing dot. */
export const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export const CONNECTION_FIELDS: ConnectionField[] = [
  {
    key: 'directory',
    label: 'Certificate authority',
    kind: 'enum',
    required: true,
    default: DEFAULT_DIRECTORY,
    options: [
      { value: 'letsencrypt_staging', label: "Let's Encrypt staging (test certificates)" },
      { value: 'letsencrypt_production', label: "Let's Encrypt production (real certificates)" },
      { value: 'custom', label: 'Another ACME CA (set the directory URL)' }
    ],
    help: 'Staging certificates are not trusted by browsers and are the default. A Hub administrator switches this to production once the staging certificate worked; production has rate limits (about 5 certificates a week per exact set of names).'
  },
  {
    key: 'directory_url',
    label: 'Directory URL',
    kind: 'string',
    placeholder: 'https://acme.example.com/directory',
    help: 'Only for "Another ACME CA": the https ACME v2 directory. Its host is the only host this connection may call.'
  },
  {
    key: 'contact_email',
    label: 'Contact email',
    kind: 'string',
    required: true,
    help: 'The CA writes here about expiring certificates and problems.'
  },
  {
    key: 'dns_connection_id',
    label: 'DNS connection',
    kind: 'number',
    required: true,
    help: 'The id of the Hub connection (Cloudflare or AWS Route 53) that holds the DNS zones. Certificates are proven with DNS-01: a TXT record under _acme-challenge is made there and removed afterwards. Only this connection is ever used for DNS.'
  },
  {
    key: 'allowed_domains',
    label: 'Allowed domains',
    kind: 'list',
    help: 'Optional. When set, certificates can only be requested for these domains and their subdomains. Empty = any name inside the zone a certificate names.'
  },
  {
    key: 'dns_wait_seconds',
    label: 'Seconds to wait for DNS',
    kind: 'number',
    default: DNS_WAIT_DEFAULT_SECONDS,
    help: `After the TXT record exists the Hub waits this long (0 to ${DNS_WAIT_MAX_SECONDS}) before asking the CA to check it. Route 53 also waits for its own "in sync" answer.`
  },
  {
    key: 'account_key',
    label: 'ACME account key',
    kind: 'text',
    secret: true,
    required: true,
    help: "The private key (PEM, EC P-256/P-384 or RSA 2048+) that is this connection's ACME account. Make one with: openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256. It is sealed and never shown again."
  }
]

// ── Config readers ──

export function directoryChoice(config: Record<string, unknown>): DirectoryChoice {
  const v = config.directory
  return v === 'letsencrypt_production' || v === 'custom' ? v : DEFAULT_DIRECTORY
}

/** The directory URL of a connection (staging unless an admin chose otherwise). */
export function directoryUrl(config: Record<string, unknown>): string {
  const c = directoryChoice(config)
  if (c === 'letsencrypt_production') return LETSENCRYPT_PRODUCTION
  if (c === 'custom') return String(config.directory_url ?? '').trim()
  return LETSENCRYPT_STAGING
}

export function directoryHost(config: Record<string, unknown>): string {
  try {
    return new URL(directoryUrl(config)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function isProduction(config: Record<string, unknown>): boolean {
  return directoryChoice(config) !== 'letsencrypt_staging'
}

export function dnsWaitMs(config: Record<string, unknown>): number {
  const n = Number(config.dns_wait_seconds)
  const s = Number.isFinite(n)
    ? Math.min(DNS_WAIT_MAX_SECONDS, Math.max(0, n))
    : DNS_WAIT_DEFAULT_SECONDS
  return s * 1000
}

export function dnsConnectionId(config: Record<string, unknown>): number | null {
  const n = Number(config.dns_connection_id)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function allowedDomains(config: Record<string, unknown>): string[] {
  const v = config.allowed_domains
  return (Array.isArray(v) ? v : [])
    .map((x) => String(x).trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, ''))
    .filter(Boolean)
}

export function hostsOf(config: Record<string, unknown>): string[] {
  const c = directoryChoice(config)
  if (c === 'letsencrypt_production') return [PRODUCTION_HOST]
  if (c === 'letsencrypt_staging') return [STAGING_HOST]
  const h = directoryHost(config)
  return h ? [h] : []
}

export function describeConnection(config: Record<string, unknown>): string {
  const c = directoryChoice(config)
  const ca =
    c === 'letsencrypt_production'
      ? "Let's Encrypt production"
      : c === 'custom'
        ? `ACME CA ${directoryHost(config) || '(no directory)'}`
        : "Let's Encrypt staging"
  const email = typeof config.contact_email === 'string' ? config.contact_email : ''
  return email ? `${ca} · ${email}` : ca
}

// ── Keys ──

/** A fresh ACME account key (EC P-256, PKCS#8 PEM) for a person to put in the connection form. */
export function generateAccountKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}

/** Why a pasted account key cannot be used, or null. Never includes the key. */
export function accountKeyProblem(pem: string): string | null {
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey(pem)
  } catch {
    return 'The ACME account key is not a PEM private key.'
  }
  if (key.asymmetricKeyType === 'rsa') {
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
    return bits >= 2048 ? null : 'An RSA account key needs at least 2048 bits.'
  }
  if (key.asymmetricKeyType === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve
    return curve === 'prime256v1' || curve === 'secp384r1'
      ? null
      : 'An EC account key must be P-256 or P-384.'
  }
  return 'The ACME account key must be an EC (P-256/P-384) or RSA key.'
}

// ── Ids ──
// An ACME account or certificate is identified by a URL on the CA. The Hub id is that URL in
// base64url (safe in a path, a form or a log; decoded and checked on every use).

export function encodeUrlId(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url')
}

/** The URL behind an id, which must be an https URL on the connection's directory host. */
export function decodeUrlId(
  ctx: Pick<ProviderContext, 'config'>,
  id: string,
  what: string
): string {
  const raw = String(id ?? '')
  if (!/^[A-Za-z0-9_-]{8,600}$/.test(raw))
    throw new ProviderError('BAD_ID', `That is not a valid ${what} id.`)
  let url: URL
  try {
    url = new URL(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new ProviderError('BAD_ID', `That is not a valid ${what} id.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new ProviderError('BAD_ID', `That is not a valid ${what} id.`)
  const want = directoryHost(ctx.config)
  if (url.hostname.toLowerCase() !== want)
    throw new ProviderError(
      'ACME_DIRECTORY_CHANGED',
      `This ${what} belongs to ${url.hostname}, but the connection now talks to ${want || 'no directory'}. Switch the connection back to read it.`
    )
  return url.toString()
}

// ── Transport ──

/** What the last non-2xx answer of one client said (for error mapping). */
export interface LastProblem {
  status: number
  /** `urn:ietf:params:acme:error:<x>` → '<x>'. */
  type: string | null
  detail: string | null
  retryAfterSeconds: number | null
}

export interface AcmeSession {
  client: Client
  /** The `http`/`api` internals acme-client keeps (not in its typings). */
  api: {
    accountUrl: string | null
    createAccount(
      data: Record<string, unknown>
    ): Promise<{ status: number; data: any; headers: any }>
    apiRequest(
      url: string,
      payload: unknown,
      valid: number[],
      opts?: Record<string, unknown>
    ): Promise<{ status: number; data: any; headers: any }>
  }
  last: LastProblem | null
  /** Every secret-ish string this session handled (the account key, a certificate key). */
  secretsInPlay: string[]
}

function problemOf(status: number, data: unknown, headers: Record<string, string>): LastProblem {
  const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const type = typeof obj.type === 'string' ? obj.type : ''
  const ra = Number(headers['retry-after'])
  return {
    status,
    type: type.startsWith('urn:ietf:params:acme:error:')
      ? type.slice('urn:ietf:params:acme:error:'.length)
      : type || null,
    detail: typeof obj.detail === 'string' ? obj.detail : null,
    retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 86_400) : null
  }
}

/**
 * An acme-client for this connection whose every request goes through `ctx.fetch`.
 * `accountKeyPem` defaults to the connection's own secret.
 */
export function openSession(ctx: ProviderContext, accountKeyPem?: string): AcmeSession {
  const pem = accountKeyPem ?? ctx.secrets.account_key
  if (!pem)
    throw new ProviderError(
      'ACME_NO_ACCOUNT_KEY',
      'The connection has no ACME account key. Edit the connection and paste one.'
    )
  const url = directoryUrl(ctx.config)
  if (!url)
    throw new ProviderError('ACME_NO_DIRECTORY', 'The connection has no ACME directory URL.')
  const client = new Client({
    directoryUrl: url,
    accountKey: pem,
    backoffAttempts: 12,
    backoffMin: 2000,
    backoffMax: 15000
  })
  const session: AcmeSession = {
    client,
    api: (client as any).api,
    last: null,
    secretsInPlay: [pem]
  }
  const http = (client as any).http
  http.request = async (
    target: string,
    method: string,
    opts: { data?: unknown; headers?: Record<string, string> } = {}
  ) => {
    const verb = String(method).toUpperCase()
    const headers: Record<string, string> = { accept: 'application/json' }
    let body: string | undefined
    if (verb === 'POST') {
      headers['content-type'] = 'application/jose+json'
      body = typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data ?? {})
    }
    let res: Response
    try {
      res = await ctx.fetch(target, {
        method: verb,
        headers,
        ...(body !== undefined ? { body } : {})
      })
    } catch (e) {
      throw acmeFailure(ctx, e, session)
    }
    const out: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      out[k.toLowerCase()] = v
    })
    const text = verb === 'HEAD' ? '' : await res.text()
    let data: unknown = text
    if (/json/i.test(out['content-type'] ?? '')) {
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = text
      }
    }
    // A later good answer clears the problem (a retried badNonce must not colour another error).
    session.last = res.status >= 400 ? problemOf(res.status, data, out) : null
    return { status: res.status, headers: out, data, statusText: '' }
  }
  return session
}

/** Mask the connection's secrets plus everything this session handled, then clip. */
export function scrubAll(ctx: ProviderContext, text: string, extra: string[] = []): string {
  return scrubValues(ctx.scrub(String(text ?? '')), extra).slice(0, 1000)
}

const TYPE_CODES: Record<string, string> = {
  rateLimited: 'ACME_RATE_LIMITED',
  accountDoesNotExist: 'ACME_NO_ACCOUNT',
  unauthorized: 'ACME_UNAUTHORIZED',
  badCSR: 'ACME_BAD_CSR',
  caa: 'ACME_CAA',
  dns: 'ACME_DNS',
  connection: 'ACME_CONNECTION',
  rejectedIdentifier: 'ACME_REJECTED_IDENTIFIER',
  invalidContact: 'ACME_INVALID_CONTACT',
  unsupportedContact: 'ACME_INVALID_CONTACT',
  userActionRequired: 'ACME_TERMS',
  serverInternal: 'ACME_SERVER_ERROR'
}

/**
 * Any failure of an ACME call as a ProviderError: the CA's problem type decides the code, a 429
 * or 5xx (or a timeout) is retryable, a Retry-After is said in the message. Scrubbed before it is
 * clipped.
 */
export function acmeFailure(
  ctx: ProviderContext,
  err: unknown,
  session?: AcmeSession
): ProviderError {
  if (err instanceof ProviderError) return err
  const extra = session?.secretsInPlay ?? []
  const raw = err instanceof Error ? err.message : String(err)
  const last = session?.last ?? null
  // A kept account URL the CA no longer knows must not keep failing for the next hour.
  if (last && (last.type === 'accountDoesNotExist' || last.type === 'unauthorized'))
    ctx.tokens.delete(accountUrlKey(ctx))
  if (last) {
    const code =
      (last.type && TYPE_CODES[last.type]) ||
      (last.status === 429 ? 'ACME_RATE_LIMITED' : 'ACME_REJECTED')
    const retryable =
      last.status === 429 || last.type === 'rateLimited' || isRetryableStatus(last.status)
    const wait = last.retryAfterSeconds
      ? ` Try again after about ${Math.ceil(last.retryAfterSeconds / 60)} minute(s).`
      : ''
    const detail = last.detail ?? raw
    return new ProviderError(code, `${scrubAll(ctx, detail, extra)}${wait}`.slice(0, 1000), {
      retryable,
      status: last.status
    })
  }
  const name = err instanceof Error ? err.name : ''
  const retryable =
    name === 'ProviderFetchError' && /timed? ?out|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(raw)
  return new ProviderError(
    name === 'ProviderFetchError' ? 'ACME_UNREACHABLE' : 'ACME_ERROR',
    scrubAll(ctx, raw, extra),
    { retryable }
  )
}

/** Runs `fn` and maps anything it throws with `acmeFailure`. */
export async function guarded<T>(
  ctx: ProviderContext,
  session: AcmeSession,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw acmeFailure(ctx, e, session)
  }
}

/** Opens the account the connection's key already has; ACME_NO_ACCOUNT when there is none. */
export async function useExistingAccount(
  ctx: ProviderContext,
  session: AcmeSession
): Promise<{ url: string; account: Record<string, any> }> {
  const resp = await guarded(ctx, session, () =>
    session.api.createAccount({ onlyReturnExisting: true })
  ).catch((e) => {
    // `accountDoesNotExist` is a 400 problem: the library raises it as a plain error.
    throw e instanceof ProviderError && e.code === 'ACME_NO_ACCOUNT'
      ? new ProviderError(
          'ACME_NO_ACCOUNT',
          'The CA has no account for this connection’s key yet. Create the ACME account first.',
          { status: 400 }
        )
      : e
  })
  const url = session.api.accountUrl
  if (!url) throw new ProviderError('ACME_NO_ACCOUNT', 'The CA did not return an account URL.')
  return { url, account: (resp.data ?? {}) as Record<string, any> }
}

export const acmeKeys = acmeCrypto

const accountUrlKey = (ctx: ProviderContext) => `acme:account-url:${directoryUrl(ctx.config)}`
const ACCOUNT_URL_KEEP_MS = 60 * 60 * 1000

/**
 * The account URL for order and certificate calls: kept for an hour per connection (the Hub reads
 * every certificate on each drift pass; the CA is not asked who we are each time). A lookup that
 * reads the account itself (`useExistingAccount`) is for account resources.
 */
export async function ensureAccountUrl(
  ctx: ProviderContext,
  session: AcmeSession
): Promise<string> {
  const key = accountUrlKey(ctx)
  const kept = ctx.tokens.get(key)
  if (kept) {
    session.api.accountUrl = kept
    return kept
  }
  const { url } = await useExistingAccount(ctx, session)
  ctx.tokens.set(key, url, new Date(ctx.now().getTime() + ACCOUNT_URL_KEEP_MS))
  return url
}
