import { createHash } from 'node:crypto'
import {
  type ConnectionSpec,
  isRetryableStatus,
  type ProviderContext,
  ProviderError
} from '../types.js'
import { type AwsCredentials, signAwsRequest } from './sigv4.js'
import { AwsXmlError, awsXmlError, parseAwsXml, type XmlObject, xmlChild, xmlText } from './xml.js'

/**
 * The AWS client every `aws` type shares: SigV4-signed `ctx.fetch` calls (no AWS SDK) to the
 * Query APIs (EC2, RDS, ELBv2, STS), the JSON API (ACM), Route 53 (REST XML) and S3 (REST).
 *
 * Credentials: the connection's access key, or — when a role ARN is set — an STS AssumeRole
 * session (external id sent when set) cached in `ctx.tokens` until it expires. There are no
 * instance-metadata / instance-role credentials: the host list holds no metadata address and
 * safeFetch refuses it anyway.
 *
 * Hosts: exact per-region names (`ec2.<region>.amazonaws.com` …) for the connection's allowed
 * regions, plus `route53.amazonaws.com`. `*.amazonaws.com` is deliberately NOT used: the allow
 * list then also names which regions and services the Hub may reach. Commercial partition only.
 */

export const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'ca-west-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'il-central-1',
  'me-south-1',
  'me-central-1',
  'af-south-1',
  'ap-east-1',
  'ap-south-1',
  'ap-south-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5'
]

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/
const ROLE_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/

/** The connection's allowed regions (a list, or a comma-separated text). */
export function regionsOf(config: Record<string, unknown>): string[] {
  const raw = config.regions
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  return [
    ...new Set(list.map((r) => String(r).trim().toLowerCase()).filter((r) => REGION_RE.test(r)))
  ]
}

export type AwsService = 'ec2' | 'rds' | 'elbv2' | 'sts' | 'acm' | 's3' | 'route53' | 'pricing'

const SIGN_NAME: Record<AwsService, string> = {
  ec2: 'ec2',
  rds: 'rds',
  elbv2: 'elasticloadbalancing',
  sts: 'sts',
  acm: 'acm',
  s3: 's3',
  route53: 'route53',
  pricing: 'pricing'
}
const HOST_PREFIX: Record<AwsService, string> = { ...SIGN_NAME }
const QUERY_VERSION: Record<string, string> = {
  ec2: '2016-11-15',
  rds: '2014-10-31',
  elbv2: '2015-12-01',
  sts: '2011-06-15'
}

/**
 * Task 44a: the AWS Price List Query API (GetProducts) answers from us-east-1 only (the Hub never
 * asks its other endpoints); the price book signs it with the connection's own credentials.
 */
export const AWS_PRICING_REGION = 'us-east-1'
export const AWS_PRICING_HOST = `api.pricing.${AWS_PRICING_REGION}.amazonaws.com`

export function awsHost(service: AwsService, region: string): string {
  if (service === 'pricing') return AWS_PRICING_HOST
  return service === 'route53'
    ? 'route53.amazonaws.com'
    : `${HOST_PREFIX[service]}.${region}.amazonaws.com`
}

export const awsConnection: ConnectionSpec = {
  fields: [
    {
      key: 'account_id',
      label: 'Account id',
      kind: 'string',
      help: 'The 12-digit AWS account number (shown in the connection list).'
    },
    {
      key: 'regions',
      label: 'Allowed regions',
      kind: 'list',
      required: true,
      options: AWS_REGIONS.map((r) => ({ value: r, label: r })),
      help: 'Every call is made in one of these regions; the first is the default.'
    },
    { key: 'access_key_id', label: 'Access key id', kind: 'string', required: true },
    {
      key: 'secret_access_key',
      label: 'Secret access key',
      kind: 'string',
      secret: true,
      required: true
    },
    {
      key: 'session_token',
      label: 'Session token',
      kind: 'string',
      secret: true,
      help: 'Only for temporary base credentials.'
    },
    {
      key: 'role_arn',
      label: 'Role to assume',
      kind: 'string',
      placeholder: 'arn:aws:iam::123456789012:role/nivaro-hub',
      help: 'Recommended: the key only assumes this role; the role carries the permissions.'
    },
    {
      key: 'external_id',
      label: 'External id',
      kind: 'string',
      secret: true,
      help: 'Sent with the role assumption when the role requires one.'
    }
  ],
  hosts(config) {
    const out = new Set<string>(['route53.amazonaws.com', AWS_PRICING_HOST])
    for (const r of regionsOf(config))
      for (const s of ['ec2', 'rds', 'elbv2', 'sts', 'acm', 's3'] as AwsService[])
        out.add(awsHost(s, r))
    return [...out]
  },
  describe(config) {
    const acct = String(config.account_id ?? '').trim()
    return `AWS${acct ? ` ${acct}` : ''} · ${regionsOf(config).join(', ') || 'no regions'}`
  },
  validate(config, secrets) {
    const problems: string[] = []
    if (!regionsOf(config).length) problems.push('Pick at least one region.')
    if (!/^[A-Z0-9]{16,128}$/.test(String(config.access_key_id ?? '').trim()))
      problems.push('The access key id looks wrong.')
    if (!secrets.secret_access_key) problems.push('The secret access key is required.')
    const role = String(config.role_arn ?? '').trim()
    if (role && !ROLE_RE.test(role)) problems.push('The role must be an IAM role ARN.')
    const acct = String(config.account_id ?? '').trim()
    if (acct && !/^\d{12}$/.test(acct)) problems.push('The account id is 12 digits.')
    return problems
  }
}

/** The region a call uses: the hint, else the context's, else the first allowed one. */
export function resolveRegion(ctx: ProviderContext, hint?: unknown): string {
  const allowed = regionsOf(ctx.config)
  const r = (typeof hint === 'string' && hint) || ctx.region || allowed[0]
  if (!r || !allowed.includes(r))
    throw new ProviderError(
      'REGION_NOT_ALLOWED',
      `Region ${r ?? '(none)'} is not allowed for this connection.`
    )
  return r
}

// ── Transport ──

const FORM = 'application/x-www-form-urlencoded; charset=utf-8'

interface RawRequest {
  service: AwsService
  region: string
  method: string
  path: string
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: string | null
}

export interface AwsAnswer {
  status: number
  text: string
  headers: Headers
}

async function rawSend(
  ctx: ProviderContext,
  creds: AwsCredentials,
  req: RawRequest
): Promise<AwsAnswer> {
  const host = awsHost(req.service, req.region)
  const qs = req.query
    ? Object.entries(req.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : ''
  const url = `https://${host}${req.path}${qs ? `?${qs}` : ''}`
  const signRegion = req.service === 'route53' ? 'us-east-1' : req.region
  const headers = signAwsRequest(
    {
      method: req.method,
      url,
      headers: req.headers,
      body: req.body,
      service: SIGN_NAME[req.service],
      region: signRegion
    },
    creds,
    ctx.now()
  )
  try {
    const res = await ctx.fetch(url, { method: req.method, headers, body: req.body ?? null })
    return { status: res.status, text: await res.text(), headers: res.headers }
  } catch (err) {
    const e = err as { code?: string; retryable?: boolean; message?: string }
    throw new ProviderError(
      e.code ?? 'NETWORK',
      ctx.scrub(String(e.message ?? 'The call to AWS failed.')),
      { retryable: e.retryable ?? false }
    )
  }
}

const THROTTLE = new Set([
  'Throttling',
  'ThrottlingException',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestThrottledException',
  'TooManyRequestsException',
  'ServiceUnavailable',
  'SlowDown',
  'PriorRequestNotComplete',
  'InternalError',
  'Unavailable'
])

/**
 * AWS codes that mean the connection's keys themselves do not work (wrong, expired, badly
 * signed) — not a missing permission (AccessDenied / UnauthorizedOperation keep their code).
 * They become AUTH_FAILED, never retryable: waiting does not fix a bad key.
 */
export const AWS_AUTH_CODES = new Set([
  'AuthFailure',
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'UnrecognizedClientException',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidAccessKeyId',
  'IncompleteSignature',
  'MissingAuthenticationToken'
])

/** The ProviderError for a non-2xx answer (code + scrubbed message; retryable on 429 / 5xx). */
export function errorFromAnswer(ctx: ProviderContext, res: AwsAnswer): ProviderError {
  let code = ''
  let message = ''
  try {
    const e = awsXmlError(parseAwsXml(res.text))
    if (e) ({ code, message } = e)
  } catch {
    try {
      const j = JSON.parse(res.text) as { __type?: string; message?: string; Message?: string }
      code = String(j.__type ?? '')
        .split('#')
        .pop() as string
      message = String(j.message ?? j.Message ?? '')
    } catch {
      // neither XML nor JSON: the status text below is all there is
    }
  }
  if (!code)
    code =
      res.status === 404 ? 'NotFound' : res.status === 403 ? 'AccessDenied' : `HTTP_${res.status}`
  if (AWS_AUTH_CODES.has(code) || res.status === 401) {
    const said = ctx.scrub(message || `AWS answered ${res.status}.`).slice(0, 360)
    return new ProviderError(
      'AUTH_FAILED',
      `AWS refused the connection’s keys (${code.slice(0, 40)}): ${said}`,
      { retryable: false, status: res.status }
    )
  }
  return new ProviderError(
    code,
    ctx.scrub(message || `AWS answered ${res.status}.`).slice(0, 400),
    {
      retryable: isRetryableStatus(res.status) || THROTTLE.has(code),
      status: res.status
    }
  )
}

function okAnswer(ctx: ProviderContext, res: AwsAnswer): AwsAnswer {
  if (res.status >= 200 && res.status < 300) return res
  throw errorFromAnswer(ctx, res)
}

function parseOk(ctx: ProviderContext, text: string): XmlObject {
  try {
    return parseAwsXml(text)
  } catch (err) {
    if (err instanceof AwsXmlError)
      throw new ProviderError(
        'AWS_BAD_ANSWER',
        ctx.scrub(`AWS sent an unreadable answer: ${err.message}`),
        { retryable: true }
      )
    throw err
  }
}

/** The one root element's value, then its `<Action>Result` child when there is one. */
function unwrap(doc: XmlObject, action: string): XmlObject {
  const root = Object.values(doc)[0]
  const obj = root && typeof root === 'object' && !Array.isArray(root) ? (root as XmlObject) : {}
  const inner = action ? obj[`${action}Result`] : undefined
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as XmlObject) : obj
}

// ── Credentials ──

const CRED_KEYS = ['ak', 'sk', 'st'] as const

async function credentials(ctx: ProviderContext): Promise<AwsCredentials> {
  const base: AwsCredentials = {
    accessKeyId: String(ctx.config.access_key_id ?? '').trim(),
    secretAccessKey: ctx.secrets.secret_access_key ?? '',
    sessionToken: ctx.secrets.session_token || undefined
  }
  const role = String(ctx.config.role_arn ?? '').trim()
  if (!role) return base
  const tk = (k: string) => `aws-role:${role}:${k}`
  const [ak, sk, st] = CRED_KEYS.map((k) => ctx.tokens.get(tk(k)))
  if (ak && sk && st) return { accessKeyId: ak, secretAccessKey: sk, sessionToken: st }

  const params: Record<string, unknown> = {
    RoleArn: role,
    RoleSessionName: 'nivaro-hub',
    DurationSeconds: 3600,
    ExternalId: ctx.secrets.external_id || undefined
  }
  const res = okAnswer(
    ctx,
    await rawSend(ctx, base, {
      service: 'sts',
      region: regionsOf(ctx.config)[0],
      method: 'POST',
      path: '/',
      headers: { 'content-type': FORM },
      body: encodeQuery('AssumeRole', params, true, QUERY_VERSION.sts)
    })
  )
  const c = xmlChild(unwrap(parseOk(ctx, res.text), 'AssumeRole'), 'Credentials')
  const got = {
    ak: xmlText(xmlChild(c, 'AccessKeyId')),
    sk: xmlText(xmlChild(c, 'SecretAccessKey')),
    st: xmlText(xmlChild(c, 'SessionToken'))
  }
  if (!got.ak || !got.sk || !got.st)
    throw new ProviderError('AWS_BAD_ANSWER', 'AWS did not return role credentials.')
  const expires = new Date(xmlText(xmlChild(c, 'Expiration')))
  const until = Number.isFinite(expires.getTime())
    ? expires
    : new Date(ctx.now().getTime() + 3_600_000)
  for (const k of CRED_KEYS) ctx.tokens.set(tk(k), got[k], until)
  return { accessKeyId: got.ak, secretAccessKey: got.sk, sessionToken: got.st }
}

// ── Query APIs (EC2, RDS, ELBv2, STS) ──

/**
 * AWS Query parameters from a nested value. Lists: EC2 numbers them `Name.1`, `Name.2`; RDS,
 * ELBv2 and STS use `Name.member.1`. Objects nest with dots; `undefined` / `null` are skipped.
 */
export function flattenQuery(
  value: unknown,
  member: boolean,
  prefix = '',
  out: Array<[string, string]> = []
): Array<[string, string]> {
  if (value === undefined || value === null) return out
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      flattenQuery(value[i], member, `${prefix}${member ? '.member' : ''}.${i + 1}`, out)
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      flattenQuery(v, member, prefix ? `${prefix}.${k}` : k, out)
  } else out.push([prefix, String(value)])
  return out
}

function encodeQuery(
  action: string,
  params: Record<string, unknown>,
  member: boolean,
  version: string
): string {
  const pairs: Array<[string, string]> = [
    ['Action', action],
    ['Version', version]
  ]
  flattenQuery(params, member, '', pairs)
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

export interface QueryOptions {
  region?: string
}

/** One Query API action; answers the action's result object. */
export async function awsQuery(
  ctx: ProviderContext,
  service: 'ec2' | 'rds' | 'elbv2' | 'sts',
  action: string,
  params: Record<string, unknown> = {},
  opts: QueryOptions = {}
): Promise<XmlObject> {
  const region = resolveRegion(ctx, opts.region)
  const creds = await credentials(ctx)
  const res = okAnswer(
    ctx,
    await rawSend(ctx, creds, {
      service,
      region,
      method: 'POST',
      path: '/',
      headers: { 'content-type': FORM },
      body: encodeQuery(action, params, service !== 'ec2', QUERY_VERSION[service])
    })
  )
  return unwrap(parseOk(ctx, res.text), action)
}

// ── ACM (JSON 1.1) ──

export async function awsJson(
  ctx: ProviderContext,
  target: string,
  body: Record<string, unknown>,
  opts: QueryOptions = {}
): Promise<Record<string, any>> {
  const region = resolveRegion(ctx, opts.region)
  const creds = await credentials(ctx)
  const res = okAnswer(
    ctx,
    await rawSend(ctx, creds, {
      service: 'acm',
      region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `CertificateManager.${target}`
      },
      body: JSON.stringify(body)
    })
  )
  try {
    return res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {}
  } catch {
    throw new ProviderError('AWS_BAD_ANSWER', 'AWS sent an unreadable answer.', { retryable: true })
  }
}

// ── Price List Query API (JSON 1.1, Task 44a) ──

/** One AWSPriceListService call (GetProducts), signed for `pricing` in us-east-1. */
export async function awsPriceList(
  ctx: ProviderContext,
  target: 'GetProducts',
  body: Record<string, unknown>
): Promise<Record<string, any>> {
  const creds = await credentials(ctx)
  const res = okAnswer(
    ctx,
    await rawSend(ctx, creds, {
      service: 'pricing',
      region: AWS_PRICING_REGION,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `AWSPriceListService.${target}`
      },
      body: JSON.stringify(body)
    })
  )
  try {
    return res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {}
  } catch {
    throw new ProviderError('AWS_BAD_ANSWER', 'AWS sent an unreadable answer.', { retryable: true })
  }
}

// ── Route 53 and S3 (REST) ──

export interface RestOptions {
  region?: string
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: string | null
  /** Statuses the caller handles itself (answered, not thrown). */
  allow?: number[]
}

export async function awsRest(
  ctx: ProviderContext,
  service: 'route53' | 's3',
  method: string,
  path: string,
  opts: RestOptions = {}
): Promise<AwsAnswer> {
  const region = service === 'route53' ? 'us-east-1' : resolveRegion(ctx, opts.region)
  const creds = await credentials(ctx)
  const res = await rawSend(ctx, creds, {
    service,
    region,
    method,
    path,
    query: opts.query,
    headers: opts.headers,
    body: opts.body ?? null
  })
  if (opts.allow?.includes(res.status)) return res
  return okAnswer(ctx, res)
}

/** A REST answer's XML, root unwrapped. */
export function restXml(ctx: ProviderContext, res: AwsAnswer): XmlObject {
  return unwrap(parseOk(ctx, res.text), '')
}

export const md5Base64 = (data: string) => createHash('md5').update(data).digest('base64')

// ── Small helpers every type uses ──

/** True for an AWS "that thing does not exist" error. */
export function isNotFound(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false
  return (
    /(NotFound|NotFoundException|NoSuchEntity|NoSuchBucket|NoSuchHostedZone|NoSuchTagSet)$/.test(
      err.code
    ) ||
    /^(DBInstanceNotFound|DBSubnetGroupNotFound|DBParameterGroupNotFound|LoadBalancerNotFound|TargetGroupNotFound|ListenerNotFound)/.test(
      err.code
    ) ||
    err.code === 'NotFound' ||
    err.code === 'NoSuchHostedZone'
  )
}

/** Runs `fn`; a not-found error answers null. */
export async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/** Polls `probe` until it answers a value; null after `tries` (sleeps only when not ready). */
export async function waitFor<T>(
  ctx: ProviderContext,
  probe: () => Promise<T | null>,
  opts: { tries?: number; delayMs?: number } = {}
): Promise<T | null> {
  const tries = opts.tries ?? 20
  const delay = opts.delayMs ?? 3000
  for (let i = 0; i < tries; i++) {
    const v = await probe()
    if (v !== null) return v
    if (i === tries - 1) break
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delay)
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new ProviderError('ABORTED', 'The call was cancelled.'))
        },
        { once: true }
      )
    })
  }
  return null
}

/** The tags the Hub puts on everything: the managed marker + the engine's app/env/resource tags. */
export function hubTags(tags: Record<string, string>, name?: unknown): Record<string, string> {
  const out: Record<string, string> = { ...tags, 'nivaro-hub:managed': 'true' }
  if (typeof name === 'string' && name) out.Name = name
  return out
}

export const keyValueTags = (tags: Record<string, string>) =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))

/** EC2 `TagSpecification.N` for one resource type. */
export const ec2TagSpec = (resourceType: string, tags: Record<string, string>) => [
  { ResourceType: resourceType, Tag: keyValueTags(tags) }
]
