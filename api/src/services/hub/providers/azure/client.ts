import { scrubValues } from '../context.js'
import { clientIdOf, isGuid, tenantOf, tenantProblem, tokenClaims } from '../microsoft/graph.js'
import { ProviderFetchError } from '../provider-fetch.js'
import {
  type ConnectionField,
  isRetryableStatus,
  type ProviderContext,
  ProviderError
} from '../types.js'

/**
 * Azure Resource Manager client for the `azure` provider. The connection is an Entra app
 * registration used with the client-credentials grant (tenant, client id, sealed client secret);
 * the token is minted for `https://management.azure.com/.default` (same sign-in as the Microsoft
 * providers, `microsoft/graph.ts` helpers for the tenant and claims), cached in `ctx.tokens`
 * until 60 s before it expires and minted once more after a 401. Every call goes through
 * `ctx.fetch` (hosts below). Writes that Azure runs as long operations are followed through the
 * `Azure-AsyncOperation` / `Location` URL (same host only); a run that gives up leaves the
 * resource in its provisioning state and the retryable error makes the engine re-apply, which
 * reads the resource first and waits again.
 *
 * Subscriptions are allow-listed per connection (`subscription_ids`): every id of a resource is
 * parsed here and anything outside the list is refused `AZURE_OUT_OF_ACCOUNT`, children through
 * their parent's id.
 */

export const ARM_HOST = 'management.azure.com'
export const LOGIN_HOST = 'login.microsoftonline.com'
export const PRICES_HOST = 'prices.azure.com'
export const AZURE_HOSTS: string[] = [ARM_HOST, LOGIN_HOST, PRICES_HOST]
export const ARM_BASE = `https://${ARM_HOST}`
export const ARM_SCOPE = `https://${ARM_HOST}/.default`

export const AZURE_CONNECTION_FIELDS: ConnectionField[] = [
  {
    key: 'tenant_id',
    label: 'Tenant ID',
    kind: 'string',
    required: true,
    placeholder: '00000000-0000-0000-0000-000000000000',
    help: 'The Entra directory (tenant) id, or its primary domain.'
  },
  {
    key: 'client_id',
    label: 'Application (client) ID',
    kind: 'string',
    required: true,
    help: 'The app registration the Hub signs in as. Give it a role on each subscription listed below (for example Contributor, plus Cost Management Reader for costs).'
  },
  {
    key: 'client_secret',
    label: 'Client secret',
    kind: 'string',
    secret: true,
    required: true
  },
  {
    key: 'subscription_ids',
    label: 'Subscriptions',
    kind: 'list',
    required: true,
    help: 'The subscription ids this connection may touch (GUIDs). Anything else is refused.'
  }
]

export const OUT_OF_ACCOUNT = 'AZURE_OUT_OF_ACCOUNT'

// ── Subscriptions ──

export function subscriptionsOf(config: Record<string, unknown>): string[] {
  const raw = config.subscription_ids
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []
  return [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean))]
}

/** A subscription id of the connection's list (lower case), else `AZURE_OUT_OF_ACCOUNT`. */
export function pinnedSub(ctx: ProviderContext, value: unknown): string {
  const sub = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!isGuid(sub)) throw new ProviderError('BAD_ID', 'That subscription id is not valid.')
  if (!subscriptionsOf(ctx.config).includes(sub))
    throw new ProviderError(
      OUT_OF_ACCOUNT,
      'That subscription is not on this connection’s list of subscriptions.'
    )
  return sub
}

// ── Ids and names ──

function badSegment(s: string): boolean {
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c < 0x20 || c === 0x7f || ch === '/' || ch === '\\') return true
  }
  return !s || s === '.' || s === '..' || s.endsWith('.')
}

const NAME_RE = {
  group: /^[\w().-]{1,90}$/,
  server: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
  database: /^[\w.-]{1,128}$/,
  rule: /^[\w.-]{1,128}$/,
  budget: /^[\w.-]{1,63}$/
} as const
export type NameKind = keyof typeof NAME_RE

/** A name that goes into a URL path: validated per kind (`BAD_ID`), then encoded. */
export function nameSeg(value: unknown, kind: NameKind, what: string): string {
  const s = typeof value === 'string' ? value : ''
  if (badSegment(s) || !NAME_RE[kind].test(s))
    throw new ProviderError('BAD_ID', `That ${what} is not valid.`)
  return encodeURIComponent(s)
}

export type ChildKind = 'databases' | 'firewallRules' | 'privateEndpointConnections'

export interface ArmId {
  sub: string
  group: string
  server?: string
  child?: { kind: ChildKind; name: string }
}

const ID_RE =
  /^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([^/]+)(?:\/providers\/Microsoft\.Sql\/servers\/([^/]+)(?:\/(databases|firewallRules|privateEndpointConnections)\/([^/]+))?)?$/i

/** Parses an ARM id of the shapes the adapter manages; null for anything else. */
export function parseArmId(id: unknown): ArmId | null {
  if (typeof id !== 'string') return null
  const m = ID_RE.exec(id)
  if (!m) return null
  const [, sub, group, server, kind, name] = m
  if (!isGuid(sub)) return null
  try {
    nameSeg(group, 'group', 'group')
    if (server) nameSeg(server.toLowerCase(), 'server', 'server')
    if (kind) nameSeg(name, kind.toLowerCase() === 'databases' ? 'database' : 'rule', 'name')
  } catch {
    return null
  }
  const out: ArmId = { sub: sub.toLowerCase(), group }
  if (server) out.server = server.toLowerCase()
  if (kind) {
    const k = ['databases', 'firewallRules', 'privateEndpointConnections'].find(
      (c) => c.toLowerCase() === kind.toLowerCase()
    ) as ChildKind
    out.child = { kind: k, name }
  }
  return out
}

/** Parses and pins: a bad id → `BAD_ID`, another subscription → `AZURE_OUT_OF_ACCOUNT`. */
export function pinnedId(ctx: ProviderContext, id: unknown): ArmId {
  const p = parseArmId(id)
  if (!p) throw new ProviderError('BAD_ID', 'That Azure resource id is not valid.')
  pinnedSub(ctx, p.sub)
  return p
}

export const groupId = (sub: string, group: string) =>
  `/subscriptions/${sub}/resourceGroups/${nameSeg(group, 'group', 'group name')}`
export const serverId = (sub: string, group: string, server: string) =>
  `${groupId(sub, group)}/providers/Microsoft.Sql/servers/${nameSeg(server, 'server', 'server name')}`
export const childId = (server: string, kind: ChildKind, name: string) =>
  `${server}/${kind}/${nameSeg(name, kind === 'databases' ? 'database' : 'rule', 'name')}`

/** The id of the server an id belongs to (a server's own id, or a child's parent). */
export function idOfServer(p: ArmId): string | null {
  return p.server ? serverId(p.sub, p.group, p.server) : null
}

// ── Tags ──

/** The engine's `nivaro-hub:app` tag is written to Azure as `nivaro-hub-app` (the cost tag). */
export function azureTags(tags: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(tags ?? {}))
    if (typeof v === 'string') out[k.replace(/^nivaro-hub:/, 'nivaro-hub-')] = v
  return out
}

export function hubTags(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object')
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (typeof v === 'string' && k.startsWith('nivaro-hub-'))
        out[k.replace(/^nivaro-hub-/, 'nivaro-hub:')] = v
  return out
}

// ── Token ──

export const clip = (t: string) => (t.length > 300 ? `${t.slice(0, 300)}…` : t)

/** A cached token belongs to one tenant and client. */
export const armTokenKey = (config: Record<string, unknown>) =>
  `azure:arm:${tenantOf(config)}:${clientIdOf(config)}`

/** Wraps the context so its scrub also masks `values` (a password this call sends). */
export function withScrub(ctx: ProviderContext, values: Iterable<string>): ProviderContext {
  const extra = [...values].filter((v) => typeof v === 'string' && v.length >= 4)
  if (!extra.length) return ctx
  return { ...ctx, scrub: (t: string) => scrubValues(ctx.scrub(t), extra) }
}

async function send(
  ctx: ProviderContext,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
): Promise<Response> {
  try {
    return await ctx.fetch(url, init)
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(err.code, clip(ctx.scrub(err.message)), { retryable: err.retryable })
    throw new ProviderError(
      'NETWORK',
      clip(ctx.scrub(err instanceof Error ? err.message : String(err))),
      { retryable: true }
    )
  }
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function statusCode(status: number): string {
  if (status === 401) return 'AUTH_FAILED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 400 || status === 422) return 'INVALID'
  if (status >= 500) return 'PROVIDER_ERROR'
  return 'PROVIDER_REFUSED'
}

/** The text of an ARM or token-endpoint error body. */
function errorText(body: unknown, status: number): { text: string; code: string | null } {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, any>
  const e = (o.error && typeof o.error === 'object' ? o.error : {}) as Record<string, any>
  const text =
    (typeof e.message === 'string' && e.message) ||
    (typeof o.error_description === 'string' && o.error_description) ||
    (typeof o.error === 'string' && o.error) ||
    (typeof body === 'string' && body) ||
    `Azure answered ${status}.`
  return { text, code: typeof e.code === 'string' ? e.code : null }
}

export class ArmError extends ProviderError {
  armCode: string | null
  constructor(base: ProviderError, armCode: string | null) {
    super(base.code, base.message, { retryable: base.retryable, status: base.status })
    this.armCode = armCode
  }
}

export function armError(ctx: ProviderContext, status: number, body: unknown): ArmError {
  const { text, code } = errorText(body, status)
  const hint =
    status === 403
      ? ' Check the role the app registration has on the subscription (and Cost Management Reader for costs).'
      : ''
  return new ArmError(
    new ProviderError(statusCode(status), clip(ctx.scrub(text)) + hint, {
      status,
      retryable: isRetryableStatus(status)
    }),
    code
  )
}

export async function mintArmToken(ctx: ProviderContext): Promise<string> {
  const tenant = tenantOf(ctx.config)
  const problem = tenantProblem(tenant)
  if (problem) throw new ProviderError('INVALID', problem)
  const res = await send(
    ctx,
    `https://${LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientIdOf(ctx.config),
        client_secret: ctx.secrets.client_secret ?? '',
        scope: ARM_SCOPE,
        grant_type: 'client_credentials'
      }).toString()
    }
  )
  const body = await readBody(res)
  if (!res.ok) {
    const e = armError(ctx, res.status, body)
    if ([400, 401, 403, 404].includes(res.status)) {
      e.code = 'AUTH_FAILED'
      e.retryable = false
    }
    throw e
  }
  const token = body && typeof body === 'object' ? body.access_token : null
  if (typeof token !== 'string' || !token)
    throw new ProviderError('AUTH_FAILED', 'Azure did not return an access token.')
  const tid = tokenClaims(token).tid
  if (isGuid(tenant) && typeof tid === 'string' && tid.toLowerCase() !== tenant)
    throw new ProviderError(
      'AUTH_FAILED',
      'The token belongs to a different tenant than the connection’s.'
    )
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  ctx.tokens.set(armTokenKey(ctx.config), token, new Date(ctx.now().getTime() + expiresIn * 1000))
  return token
}

export async function armToken(ctx: ProviderContext): Promise<string> {
  return ctx.tokens.get(armTokenKey(ctx.config)) ?? (await mintArmToken(ctx))
}

// ── Calls ──

export interface ArmResult {
  status: number
  body: any
  headers: Headers
}

export interface ArmOptions {
  query?: Record<string, string>
  body?: unknown
  /** Statuses that come back as a result instead of an error. */
  allow?: number[]
  /** Follow a long-running operation to its end. */
  wait?: boolean
  /** Poll interval (tests). */
  pollMs?: number
  tries?: number
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
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
}

async function once(
  ctx: ProviderContext,
  method: string,
  url: string,
  body: unknown
): Promise<ArmResult> {
  let reminted = false
  const payload = body === undefined ? undefined : JSON.stringify(body)
  for (;;) {
    const token = await armToken(ctx)
    const res = await send(ctx, url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: payload
    })
    if (res.status === 401 && !reminted) {
      await res.body?.cancel().catch(() => {})
      ctx.tokens.delete(armTokenKey(ctx.config))
      reminted = true
      continue
    }
    return { status: res.status, body: await readBody(res), headers: res.headers }
  }
}

const armUrl = (path: string, query: Record<string, string> | undefined) => {
  if (!path.startsWith('/')) throw new ProviderError('BAD_ID', 'That Azure path is not valid.')
  return `${ARM_BASE}${path}?${new URLSearchParams(query ?? {}).toString()}`
}

export const isArmUrl = (raw: string | null | undefined): raw is string => {
  if (!raw) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && u.hostname === ARM_HOST
  } catch {
    return false
  }
}

/** One ARM call (`path` starts with `/subscriptions/…`; `query` carries `api-version`). */
export async function armCall(
  ctx: ProviderContext,
  method: string,
  path: string,
  opts: ArmOptions = {}
): Promise<ArmResult> {
  const res = await once(ctx, method, armUrl(path, opts.query), opts.body)
  if (res.status === 429 && !opts.allow?.includes(429)) {
    throw new ProviderError('RATE_LIMITED', 'Azure is rate limiting requests.', {
      status: 429,
      retryable: true
    })
  }
  if (!(res.status >= 200 && res.status < 300) && !opts.allow?.includes(res.status))
    throw armError(ctx, res.status, res.body)
  if (!opts.wait || !(res.status >= 200 && res.status < 300)) return res
  return followOperation(ctx, res, opts)
}

async function followOperation(
  ctx: ProviderContext,
  first: ArmResult,
  opts: ArmOptions
): Promise<ArmResult> {
  const asyncUrl = first.headers.get('azure-asyncoperation')
  const locUrl = first.headers.get('location')
  const useAsync = isArmUrl(asyncUrl)
  const target = useAsync ? asyncUrl : first.status === 202 && isArmUrl(locUrl) ? locUrl : null
  if (!target) return first
  const tries = opts.tries ?? 40
  const pollMs = opts.pollMs ?? 2000
  for (let i = 0; i < tries; i++) {
    await sleep(i === 0 ? Math.min(pollMs, 500) : pollMs, ctx.signal)
    if (ctx.signal.aborted)
      throw new ProviderError('ABORTED', 'The run was cancelled while waiting for Azure.')
    const r = await once(ctx, 'GET', target, undefined)
    if (useAsync) {
      if (!(r.status >= 200 && r.status < 300)) throw armError(ctx, r.status, r.body)
      const status = String(r.body?.status ?? '')
      if (status === 'Succeeded') return first
      if (status === 'Failed' || status === 'Canceled') {
        const { text } = errorText(r.body, 500)
        throw new ProviderError(
          'OPERATION_FAILED',
          clip(
            ctx.scrub(r.body?.error ? text : `Azure reports the operation ${status.toLowerCase()}.`)
          )
        )
      }
    } else {
      if (r.status === 202) continue
      if (r.status >= 200 && r.status < 300) return first
      throw armError(ctx, r.status, r.body)
    }
  }
  throw new ProviderError(
    'OPERATION_PENDING',
    'Azure is still working on the change; it will be checked again.',
    { retryable: true }
  )
}

/** Every item of a list, following `nextLink` (same host only; at most 20 pages). */
export async function armList(
  ctx: ProviderContext,
  path: string,
  query: Record<string, string>
): Promise<any[]> {
  const out: any[] = []
  let res = await armCall(ctx, 'GET', path, { query })
  for (let page = 0; page < 20; page++) {
    if (Array.isArray(res.body?.value)) out.push(...res.body.value)
    const next = res.body?.nextLink
    if (!isArmUrl(typeof next === 'string' ? next : null)) break
    const r = await once(ctx, 'GET', next, undefined)
    if (!(r.status >= 200 && r.status < 300)) throw armError(ctx, r.status, r.body)
    res = r
  }
  return out
}

export const API = {
  resources: '2022-09-01',
  subscription: '2022-12-01',
  sql: '2023-08-01',
  budget: '2023-05-01',
  cost: '2023-11-01'
} as const

export const armVersion = (v: string): Record<string, string> => ({ 'api-version': v })
export const armErrorCode = (err: unknown): string | null =>
  err instanceof ArmError ? err.armCode : null
export { once as armOnce }
