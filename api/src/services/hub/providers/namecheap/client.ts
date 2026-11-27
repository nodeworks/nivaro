import { isIPv4 } from 'node:net'
import { ProviderFetchError } from '../provider-fetch.js'
import {
  type ConnectionField,
  isRetryableStatus,
  type ProviderContext,
  ProviderError
} from '../types.js'
import {
  parseXml,
  type XmlObject,
  type XmlValue,
  xmlAttr,
  xmlChild,
  xmlList,
  xmlText
} from '../xml.js'

/**
 * Namecheap API calls (Task 43). One endpoint, `https://<host>/xml.response`, a `Command` per call
 * and XML answers whose data sits in attributes (read with `parseXml(…, {attributes: true})`).
 *
 *  - The API key travels in the POST body, never in the address (Namecheap also takes GET; the
 *    Hub never uses it, so the key never lands in a proxy or access log).
 *  - Namecheap refuses every call that does not come from an IPv4 address the account allow-lists
 *    (API access → Whitelisted IPs). The connection names that address (`client_ip`, sent as
 *    `ClientIp`); when Namecheap refuses, its error names the address it saw, which the connection
 *    test shows (`CLIENT_IP_NOT_ALLOWED`).
 *  - Hosts: `api.namecheap.com`, or `api.sandbox.namecheap.com` when the connection is a sandbox
 *    one (tests and trials: nothing there is real or billed).
 *  - Error text is scrubbed of the connection's secrets BEFORE it is clipped.
 */

export const NAMECHEAP_HOST = 'api.namecheap.com'
export const NAMECHEAP_SANDBOX_HOST = 'api.sandbox.namecheap.com'

export const CONNECTION_FIELDS: ConnectionField[] = [
  {
    key: 'api_user',
    label: 'API user',
    kind: 'string',
    required: true,
    help: 'The Namecheap user the API key belongs to.'
  },
  {
    key: 'username',
    label: 'Account user name',
    kind: 'string',
    help: 'The account the calls act on. Leave empty to use the API user (the usual case).'
  },
  {
    key: 'client_ip',
    label: 'Hub address (IPv4)',
    kind: 'string',
    required: true,
    placeholder: '203.0.113.10',
    help: 'The public IPv4 address the Hub calls Namecheap from. Add it under Profile → Tools → API access → Whitelisted IPs at Namecheap. Test shows the address Namecheap sees when they differ.'
  },
  {
    key: 'sandbox',
    label: 'Sandbox',
    kind: 'boolean',
    default: false,
    help: 'Use api.sandbox.namecheap.com (a separate sandbox account; nothing there is real or billed).'
  },
  { key: 'api_key', label: 'API key', kind: 'string', secret: true, required: true }
]

export function hostOf(config: Record<string, unknown>): string {
  return config.sandbox === true ? NAMECHEAP_SANDBOX_HOST : NAMECHEAP_HOST
}

const USER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export function connectionProblems(
  config: Record<string, unknown>,
  secrets: Record<string, string>
): string[] {
  const out: string[] = []
  if (!USER_RE.test(String(config.api_user ?? '')))
    out.push('Enter the Namecheap API user (letters, digits, dot, dash, underscore).')
  if (config.username !== undefined && config.username !== '' && config.username !== null)
    if (!USER_RE.test(String(config.username))) out.push('The account user name is not valid.')
  if (!isIPv4(String(config.client_ip ?? '').trim()))
    out.push(
      'Enter the IPv4 address the Hub calls Namecheap from (Namecheap allow-lists IPv4 only).'
    )
  if ('api_key' in secrets && !secrets.api_key) out.push('Enter the API key.')
  return out
}

// ── Names ──

export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** A registered domain name, lower-cased, no trailing dot (BAD_ID otherwise). */
export function domainName(v: unknown): string {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  if (!DOMAIN_RE.test(s))
    throw new ProviderError('BAD_ID', 'That is not a domain name (example.com, no trailing dot).')
  return s
}

/** `example.co.uk` → `{sld: 'example', tld: 'co.uk'}` (Namecheap's DNS commands want both). */
export function splitDomain(name: string): { sld: string; tld: string } {
  const d = domainName(name)
  const i = d.indexOf('.')
  return { sld: d.slice(0, i), tld: d.slice(i + 1) }
}

/** The TLD of a domain (`com`, `co.uk`). */
export const tldOf = (name: string): string => {
  const s = String(name ?? '').toLowerCase()
  const i = s.indexOf('.')
  return i > 0 ? s.slice(i + 1) : ''
}

/** Namecheap dates are MM/DD/YYYY; answers an ISO date-time at midnight UTC ('' when unreadable). */
export function ncDate(v: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v ?? '').trim())
  if (!m) return ''
  const t = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))
  return Number.isFinite(t) ? new Date(t).toISOString() : ''
}

export const truthy = (v: string): boolean => /^true$/i.test(String(v ?? '').trim())

// ── Calls ──

/** Error numbers Namecheap answers that the Hub reads (the rest are PROVIDER_REJECTED). */
const IP_ERRORS = new Set(['1011150', '1011145'])
const AUTH_ERRORS = new Set(['1011102', '1010101', '1011100', '1010102', '1017150'])
const NOT_FOUND_ERRORS = new Set(['2019166', '2016166', '2030166', '4019337', '2011166'])

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The address in a Namecheap "invalid request IP" error, when it names one. */
export function seenAddress(message: string): string | null {
  const m = /(\b\d{1,3}(?:\.\d{1,3}){3}\b)/.exec(message)
  return m && isIPv4(m[1]) ? m[1] : null
}

export interface NcAnswer {
  /** `<CommandResponse>` (attributes kept). */
  response: XmlValue | undefined
}

/** Parameters of one command; undefined / '' are left out. */
export type NcParams = Record<string, string | number | boolean | undefined>

/**
 * One API command. Throws ProviderError: CLIENT_IP_NOT_ALLOWED (with `seen`), AUTH_FAILED,
 * NOT_FOUND, RATE_LIMITED (retryable), PROVIDER_UNAVAILABLE (5xx, retryable), PROVIDER_REJECTED.
 */
export async function ncCall(
  ctx: ProviderContext,
  command: string,
  params: NcParams = {}
): Promise<NcAnswer> {
  if (!/^namecheap\.[a-z]+(\.[a-z]+){1,2}$/i.test(command))
    throw new ProviderError('BAD_ID', 'Unknown Namecheap command.')
  const apiUser = String(ctx.config.api_user ?? '')
  const user = String(ctx.config.username ?? '') || apiUser
  const body = new URLSearchParams({
    ApiUser: apiUser,
    ApiKey: ctx.secrets.api_key ?? '',
    UserName: user,
    ClientIp: String(ctx.config.client_ip ?? '').trim(),
    Command: command
  })
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') body.set(k, String(v))
  const scrubbed = (t: string) => clip(ctx.scrub(t))
  let res: Response
  try {
    res = await ctx.fetch(`https://${hostOf(ctx.config)}/xml.response`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/xml, text/xml'
      },
      body: body.toString()
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`FETCH_${err.code}`, scrubbed(err.message), {
        retryable: err.retryable
      })
    throw err
  }
  const text = await res.text().catch(() => '')
  if (res.status >= 400) {
    const status = res.status
    throw new ProviderError(
      status === 429
        ? 'RATE_LIMITED'
        : status >= 500
          ? 'PROVIDER_UNAVAILABLE'
          : 'PROVIDER_REJECTED',
      scrubbed(`Namecheap answered ${status}.`),
      { retryable: isRetryableStatus(status), status }
    )
  }
  let doc: XmlObject
  try {
    doc = parseXml(text, { attributes: true })
  } catch {
    throw new ProviderError(
      'PROVIDER_REJECTED',
      'Namecheap answered something that is not an API answer.',
      { retryable: false, status: res.status }
    )
  }
  const root = doc.ApiResponse
  if (!root || typeof root !== 'object')
    throw new ProviderError(
      'PROVIDER_REJECTED',
      'Namecheap answered something that is not an API answer.'
    )
  if (xmlAttr(root, 'Status').toUpperCase() !== 'OK') {
    const first = xmlList(xmlChild(root, 'Errors'), 'Error')[0]
    const num = xmlAttr(first, 'Number')
    const said = xmlText(first).trim() || xmlText(xmlChild(root, 'Errors')).trim()
    const message = scrubbed(
      `Namecheap refused ${command}${num ? ` (error ${num})` : ''}: ${said || 'no reason given'}`
    )
    if (IP_ERRORS.has(num) || /request ?ip|whitelist|client ?ip/i.test(said)) {
      const err = new ProviderError('CLIENT_IP_NOT_ALLOWED', message, { status: 403 })
      ;(err as ProviderError & { seen?: string | null }).seen = seenAddress(said)
      throw err
    }
    if (
      AUTH_ERRORS.has(num) ||
      /api ?key is invalid|api access has not been enabled|invalid api ?user/i.test(said)
    )
      throw new ProviderError('AUTH_FAILED', message, { status: 401 })
    if (
      NOT_FOUND_ERRORS.has(num) ||
      /not (found|associated)|doesn.t exist|does not exist/i.test(said)
    )
      throw new ProviderError('NOT_FOUND', message, { status: 404 })
    if (/too many requests|rate limit|try again later/i.test(said))
      throw new ProviderError('RATE_LIMITED', message, { retryable: true, status: 429 })
    throw new ProviderError('PROVIDER_REJECTED', message, { status: 400 })
  }
  return { response: xmlChild(root, 'CommandResponse') }
}

/** The address a CLIENT_IP_NOT_ALLOWED error says Namecheap saw (null otherwise). */
export function seenOf(err: unknown): string | null {
  const s = (err as { seen?: unknown } | null)?.seen
  return typeof s === 'string' ? s : null
}
