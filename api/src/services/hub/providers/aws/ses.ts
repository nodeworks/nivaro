import {
  type HealthAnswer,
  type Observed,
  type ProviderContext,
  ProviderError,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import {
  awsQuery,
  awsRest,
  awsSegment,
  awsSesJson,
  connectionAccount,
  hubTags,
  keyValueTags,
  orNull,
  restXml
} from './client.js'
import {
  type AwsListPage,
  type AwsTypeDef,
  cap,
  nameField,
  observed,
  regionField,
  riskOf
} from './kit.js'
import {
  sesConfigurationSetEstimate,
  sesIdentityEstimate,
  sesSmtpUserEstimate
} from './pricing-part3.js'
import { changeRecords, normName, type RecordSet } from './route53.js'
import { sesSmtpHost, sesSmtpPassword } from './smtp-password.js'
import { xmlChild, xmlList, xmlText } from './xml.js'

/**
 * Amazon SES (v2 REST API) for an app's outgoing mail.
 *
 *  - `aws.ses_identity`: a DOMAIN identity with Easy DKIM. The DKIM CNAMEs (and the optional MAIL
 *    FROM MX and SPF TXT records) are written into a Route 53 zone the identity names (`zone`
 *    ref); they are also listed in `dkim_records` / `mail_from_records` so a person can make them
 *    in another DNS provider (`cloudflare.dns_record`) — a ref cannot cross connections, so the
 *    AWS adapter writes only into Route 53. A record that exists with other values is
 *    `ALREADY_EXISTS`, never overwritten. Health says when the account is still in the SES
 *    sandbox: leaving it is a support request only a person can make.
 *  - `aws.ses_configuration_set`: TLS policy, sending on/off, reputation metrics.
 *  - `aws.ses_smtp_user`: the narrow IAM exception (Rob's ruling). An IAM user under the path
 *    `/nivaro-hub/` tagged `nivaro-hub:managed=true` whose ONLY policy is `ses:SendRawEmail` +
 *    `ses:SendEmail` on that one identity. Every IAM call first proves the user is the Hub's
 *    (path + tag), so no other IAM user is ever read or changed. Outputs `smtp_host`, `smtp_port`,
 *    `smtp_user` (the access key id) and `smtp_pass` (derived from the secret access key with
 *    AWS's SES SMTP algorithm); the key and password are shown once (`onceOnly`) and the raw
 *    secret access key is never handed out. A lost value is rotated: a new key is made (the user
 *    holds at most two, the older of two is deleted first).
 */

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const SET_RE = /^[A-Za-z0-9_-]{1,64}$/
const USER_RE = /^[A-Za-z0-9+=,.@_-]{1,64}$/
const SUB_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const IAM_PATH = '/nivaro-hub/'
const POLICY_NAME = 'nivaro-hub-ses-send'

const t = xmlText
const c = xmlChild

// ── SES calls ──

const ses = (
  ctx: ProviderContext,
  method: string,
  path: string,
  region: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>
) => awsSesJson(ctx, method, path, region, body, query)

const idPath = (domain: string) => `/v2/email/identities/${awsSegment(domain)}`
const setPath = (name: string) => `/v2/email/configuration-sets/${awsSegment(name)}`

function checkDomain(domain: unknown): string {
  const d = typeof domain === 'string' ? domain.trim().toLowerCase() : ''
  if (!DOMAIN_RE.test(d))
    throw new ProviderError('INVALID_FIELDS', 'The domain is not a valid domain name.')
  return d
}

// ── DNS records ──

interface DnsRecord {
  name: string
  type: string
  value: string
}

const dkimRecords = (domain: string, tokens: string[]): DnsRecord[] =>
  tokens.map((tok) => ({
    name: `${tok}._domainkey.${domain}`,
    type: 'CNAME',
    value: `${tok}.dkim.amazonses.com`
  }))

const mailFromRecords = (mailFrom: string, region: string): DnsRecord[] => [
  { name: mailFrom, type: 'MX', value: `10 feedback-smtp.${region}.amazonses.com` },
  { name: mailFrom, type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"' }
]

const sameValues = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

/** Writes records into the zone; one that exists with other values is ALREADY_EXISTS. */
async function publishRecords(
  ctx: ProviderContext,
  zone: string,
  domain: string,
  records: DnsRecord[]
): Promise<void> {
  const zid = zone.replace(/^\/hostedzone\//, '')
  const zres = await awsRest(ctx, 'route53', 'GET', `/2013-04-01/hostedzone/${awsSegment(zid)}`)
  const zname = normName(t(c(c(restXml(ctx, zres), 'HostedZone'), 'Name')))
  if (!zname || (domain !== zname && !domain.endsWith(`.${zname}`)))
    throw new ProviderError(
      'ZONE_MISMATCH',
      `Hosted zone ${zname || zid} does not hold the domain ${domain}.`
    )
  const todo: RecordSet[] = []
  for (const r of records) {
    const res = await awsRest(
      ctx,
      'route53',
      'GET',
      `/2013-04-01/hostedzone/${awsSegment(zid)}/rrset`,
      {
        query: { name: r.name, type: r.type, maxitems: '1' }
      }
    )
    const hit = xmlList(c(restXml(ctx, res), 'ResourceRecordSets'), 'ResourceRecordSet').find(
      (x) => normName(t(c(x, 'Name'))) === normName(r.name) && t(c(x, 'Type')) === r.type
    )
    if (hit) {
      const have = xmlList(c(hit, 'ResourceRecords'), 'ResourceRecord').map((v) => t(c(v, 'Value')))
      if (sameValues(have, [r.value])) continue
      throw new ProviderError(
        'ALREADY_EXISTS',
        `A ${r.type} record for ${r.name} already exists with other values. Remove or adopt it first.`
      )
    }
    todo.push({ name: normName(r.name), type: r.type, ttl: 300, values: [r.value] })
  }
  if (todo.length)
    await changeRecords(
      ctx,
      zid,
      todo.map((record) => ({ action: 'CREATE' as const, record }))
    )
}

// ── aws.ses_identity ──

interface SesIdentity {
  IdentityType?: string
  VerifiedForSendingStatus?: boolean
  VerificationStatus?: string
  ConfigurationSetName?: string
  DkimAttributes?: { Status?: string; Tokens?: string[] }
  MailFromAttributes?: { MailFromDomain?: string; MailFromDomainStatus?: string }
  Tags?: Array<{ Key: string; Value?: string }>
}

const readIdentity = async (ctx: ProviderContext, domain: string, region: string) =>
  orNull(() => ses(ctx, 'GET', idPath(domain), region)) as Promise<SesIdentity | null>

function identityStatus(i: SesIdentity): string {
  const v = (i.VerificationStatus ?? '').toUpperCase()
  if (v === 'SUCCESS') return 'active'
  if (v === 'FAILED' || v === 'TEMPORARY_FAILURE') return 'failed'
  return 'pending'
}

function identityObserved(domain: string, i: SesIdentity, region: string): Observed {
  const tags: Record<string, string> = {}
  for (const x of i.Tags ?? []) tags[x.Key] = x.Value ?? ''
  const mf = (i.MailFromAttributes?.MailFromDomain ?? '').toLowerCase()
  const sub = mf && mf.endsWith(`.${domain}`) ? mf.slice(0, -(domain.length + 1)) : ''
  return observed(
    'aws.ses_identity',
    domain,
    region,
    domain,
    {
      domain,
      mail_from_subdomain: sub,
      configuration_set: i.ConfigurationSetName ?? '',
      dkim_records: dkimRecords(domain, i.DkimAttributes?.Tokens ?? []),
      mail_from_records: mf ? mailFromRecords(mf, region) : []
    },
    tags,
    identityStatus(i)
  )
}

/** Health text for the account's sending mode (null when SES will not say). */
async function sandboxNote(ctx: ProviderContext, region: string): Promise<string | null> {
  try {
    const a = await ses(ctx, 'GET', '/v2/email/account', region)
    return a.ProductionAccessEnabled === false
      ? 'This SES account is still in the sandbox: it can only send to verified addresses. Leaving the sandbox is a request in the AWS console (Support) that only a person can make.'
      : null
  } catch {
    return null
  }
}

export const sesIdentityDef: AwsTypeDef = {
  spec: {
    key: 'aws.ses_identity',
    label: 'SES identity',
    scope: 'app',
    nameField: 'domain',
    fields: [
      regionField,
      {
        key: 'domain',
        label: 'Domain',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[a-z0-9.-]{4,253}$',
        help: 'The sending domain (example.com). Verified with DKIM.'
      },
      {
        key: 'zone',
        label: 'Route 53 zone for the DNS records',
        kind: 'ref',
        refType: 'aws.route53_zone',
        createOnly: true,
        help: 'The DKIM (and MAIL FROM) records are written here. Leave empty to make them by hand or in another DNS provider; they are listed below.'
      },
      {
        key: 'mail_from_subdomain',
        label: 'MAIL FROM subdomain',
        kind: 'string',
        pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$',
        help: 'Optional, e.g. mail → mail.example.com, for SPF alignment.'
      },
      {
        key: 'configuration_set',
        label: 'Default configuration set',
        kind: 'ref',
        refType: 'aws.ses_configuration_set'
      },
      {
        key: 'dkim_records',
        label: 'DKIM records',
        kind: 'list',
        readOnly: true,
        items: { key: 'record', label: 'Record', kind: 'object' }
      },
      {
        key: 'mail_from_records',
        label: 'MAIL FROM records',
        kind: 'list',
        readOnly: true,
        items: { key: 'record', label: 'Record', kind: 'object' }
      }
    ],
    estimate: sesIdentityEstimate,
    capabilities: cap(),
    reversible: false,
    refs: [
      { field: 'zone', type: 'aws.route53_zone', required: false },
      { field: 'configuration_set', type: 'aws.ses_configuration_set', required: false }
    ],
    risk: riskOf()
  },
  probe: {
    need: 'ses:ListEmailIdentities',
    run: (ctx, region) =>
      ses(ctx, 'GET', '/v2/email/identities', region, undefined, { PageSize: '1' })
  },
  async observe(ctx, id, region) {
    const i = await readIdentity(ctx, checkDomain(id), region)
    return i ? identityObserved(id, i, region) : null
  },
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await ses(ctx, 'GET', '/v2/email/identities', region, undefined, {
      PageSize: '100',
      ...(token ? { NextToken: token } : {})
    })
    const out: Observed[] = []
    for (const x of (r.EmailIdentities as
      | Array<{ IdentityName?: string; IdentityType?: string }>
      | undefined) ?? []) {
      if (!x.IdentityName || x.IdentityType !== 'DOMAIN') continue
      const i = await readIdentity(ctx, x.IdentityName, region)
      if (i) out.push(identityObserved(x.IdentityName, i, region))
    }
    return { items: out, next: (r.NextToken as string | undefined) || null }
  },
  async findExisting(ctx, desired, region) {
    const d = checkDomain(desired.fields.domain)
    const i = await readIdentity(ctx, d, region)
    return i ? identityObserved(d, i, region) : null
  },
  checkPlan(desired) {
    checkDomain(desired.fields.domain)
    const sub = String(desired.fields.mail_from_subdomain ?? '')
    if (sub && !SUB_RE.test(sub))
      throw new ProviderError('INVALID_FIELDS', 'The MAIL FROM subdomain is not valid.')
  },
  async create(ctx, desired, region) {
    const domain = checkDomain(desired.fields.domain)
    const sub = String(desired.fields.mail_from_subdomain ?? '')
    const set =
      typeof desired.refs.configuration_set === 'string' ? desired.refs.configuration_set : ''
    const made = await ses(ctx, 'POST', '/v2/email/identities', region, {
      EmailIdentity: domain,
      Tags: keyValueTags(hubTags(desired.tags)),
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      ...(set ? { ConfigurationSetName: set } : {})
    })
    const tokens = ((made.DkimAttributes as { Tokens?: string[] } | undefined)?.Tokens ??
      []) as string[]
    if (sub)
      await ses(ctx, 'PUT', `${idPath(domain)}/mail-from`, region, {
        MailFromDomain: `${sub}.${domain}`,
        BehaviorOnMxFailure: 'USE_DEFAULT_VALUE'
      })
    const zone = typeof desired.refs.zone === 'string' ? desired.refs.zone : ''
    if (zone) {
      const records = [
        ...dkimRecords(domain, tokens),
        ...(sub ? mailFromRecords(`${sub}.${domain}`, region) : [])
      ]
      await publishRecords(ctx, zone, domain, records)
    }
    return domain
  },
  async update(ctx, id, region, desired, _o, changed) {
    const domain = checkDomain(id)
    if (changed.has('mail_from_subdomain')) {
      const sub = String(desired.fields.mail_from_subdomain ?? '')
      await ses(
        ctx,
        'PUT',
        `${idPath(domain)}/mail-from`,
        region,
        sub ? { MailFromDomain: `${sub}.${domain}`, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' } : {}
      )
    }
    if (changed.has('configuration_set')) {
      const set =
        typeof desired.refs.configuration_set === 'string' ? desired.refs.configuration_set : ''
      await ses(
        ctx,
        'PUT',
        `${idPath(domain)}/configuration-set`,
        region,
        set ? { ConfigurationSetName: set } : {}
      )
    }
    const acct = await connectionAccount(ctx)
    await ses(ctx, 'POST', '/v2/email/tags', region, {
      ResourceArn: `arn:aws:ses:${region}:${acct}:identity/${domain}`,
      Tags: keyValueTags(hubTags(desired.tags))
    })
  },
  async health(ctx, _id, region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    const sandbox = await sandboxNote(ctx, region)
    const status = obs.status ?? ''
    if (status === 'failed')
      return { status: 'warn', message: 'SES could not verify this domain. Check the DNS records.' }
    if (status === 'pending')
      return {
        status: 'warn',
        message: `Waiting for the DKIM records to be found in DNS.${sandbox ? ` ${sandbox}` : ''}`
      }
    return sandbox ? { status: 'warn', message: sandbox } : { status: 'ok', message: 'Verified' }
  },
  async remove(ctx, id, region) {
    await orNull(() => ses(ctx, 'DELETE', idPath(checkDomain(id)), region))
  }
}

// ── aws.ses_configuration_set ──

interface SesSet {
  ConfigurationSetName?: string
  DeliveryOptions?: { TlsPolicy?: string }
  ReputationOptions?: { ReputationMetricsEnabled?: boolean }
  SendingOptions?: { SendingEnabled?: boolean }
  Tags?: Array<{ Key: string; Value?: string }>
}

function setObserved(name: string, s: SesSet, region: string): Observed {
  const tags: Record<string, string> = {}
  for (const x of s.Tags ?? []) tags[x.Key] = x.Value ?? ''
  return observed(
    'aws.ses_configuration_set',
    name,
    region,
    name,
    {
      tls_policy: s.DeliveryOptions?.TlsPolicy === 'REQUIRE' ? 'REQUIRE' : 'OPTIONAL',
      sending_enabled: s.SendingOptions?.SendingEnabled !== false,
      reputation_metrics: s.ReputationOptions?.ReputationMetricsEnabled === true
    },
    tags,
    'active'
  )
}

const readSet = async (ctx: ProviderContext, name: string, region: string) =>
  orNull(() => ses(ctx, 'GET', setPath(name), region)) as Promise<SesSet | null>

export const sesConfigurationSetDef: AwsTypeDef = {
  spec: {
    key: 'aws.ses_configuration_set',
    label: 'SES configuration set',
    scope: 'app',
    fields: [
      regionField,
      {
        ...nameField,
        label: 'Name',
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z0-9_-]{1,64}$'
      },
      {
        key: 'tls_policy',
        label: 'TLS policy',
        kind: 'enum',
        default: 'OPTIONAL',
        options: [
          { value: 'OPTIONAL', label: 'Optional (TLS when the receiver offers it)' },
          { value: 'REQUIRE', label: 'Require TLS (mail to servers without it is not sent)' }
        ]
      },
      { key: 'sending_enabled', label: 'Sending enabled', kind: 'boolean', default: true },
      { key: 'reputation_metrics', label: 'Reputation metrics', kind: 'boolean', default: false }
    ],
    estimate: sesConfigurationSetEstimate,
    capabilities: cap(),
    reversible: true,
    refs: [],
    risk: riskOf((op) =>
      op.changes.some((x) => x.field === 'sending_enabled' && x.to === false) ? ['downtime'] : []
    )
  },
  probe: {
    need: 'ses:ListConfigurationSets',
    run: (ctx, region) =>
      ses(ctx, 'GET', '/v2/email/configuration-sets', region, undefined, { PageSize: '1' })
  },
  async observe(ctx, id, region) {
    if (!SET_RE.test(id)) return null
    const s = await readSet(ctx, id, region)
    return s ? setObserved(id, s, region) : null
  },
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await ses(ctx, 'GET', '/v2/email/configuration-sets', region, undefined, {
      PageSize: '100',
      ...(token ? { NextToken: token } : {})
    })
    const out: Observed[] = []
    for (const name of (r.ConfigurationSets as string[] | undefined) ?? []) {
      const s = await readSet(ctx, name, region)
      if (s) out.push(setObserved(name, s, region))
    }
    return { items: out, next: (r.NextToken as string | undefined) || null }
  },
  async findExisting(ctx, desired, region) {
    const name = String(desired.fields.name ?? '')
    const s = SET_RE.test(name) ? await readSet(ctx, name, region) : null
    return s ? setObserved(name, s, region) : null
  },
  async create(ctx, desired, region) {
    const f = desired.fields
    const name = String(f.name ?? '')
    if (!SET_RE.test(name))
      throw new ProviderError('INVALID_FIELDS', 'The configuration set name is not valid.')
    await ses(ctx, 'POST', '/v2/email/configuration-sets', region, {
      ConfigurationSetName: name,
      DeliveryOptions: { TlsPolicy: f.tls_policy === 'REQUIRE' ? 'REQUIRE' : 'OPTIONAL' },
      SendingOptions: { SendingEnabled: f.sending_enabled !== false },
      ReputationOptions: { ReputationMetricsEnabled: f.reputation_metrics === true },
      Tags: keyValueTags(hubTags(desired.tags))
    })
    return name
  },
  async update(ctx, id, region, desired, _o, changed) {
    const f = desired.fields
    const path = setPath(id)
    if (changed.has('tls_policy'))
      await ses(ctx, 'PUT', `${path}/delivery-options`, region, {
        TlsPolicy: f.tls_policy === 'REQUIRE' ? 'REQUIRE' : 'OPTIONAL'
      })
    if (changed.has('sending_enabled'))
      await ses(ctx, 'PUT', `${path}/sending`, region, {
        SendingEnabled: f.sending_enabled !== false
      })
    if (changed.has('reputation_metrics'))
      await ses(ctx, 'PUT', `${path}/reputation-options`, region, {
        ReputationMetricsEnabled: f.reputation_metrics === true
      })
  },
  async remove(ctx, id, region) {
    await orNull(() => ses(ctx, 'DELETE', setPath(id), region))
  }
}

// ── aws.ses_smtp_user (the IAM exception) ──

const iam = (
  ctx: ProviderContext,
  region: string,
  action: string,
  params: Record<string, unknown>
) => awsQuery(ctx, 'iam', action, params, { region })

const sleep = (ctx: ProviderContext, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ProviderError('ABORTED', 'The call was cancelled.'))
      },
      { once: true }
    )
  })

/** IAM is eventually consistent: a call right after CreateUser may say NoSuchEntity. */
async function afterCreate<T>(ctx: ProviderContext, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'NoSuchEntity' || i >= 3) throw err
      await sleep(ctx, 1500)
    }
  }
}

interface HubUser {
  arn: string
  tags: Record<string, string>
}

/**
 * The user, proven to be the Hub's: under `/nivaro-hub/` AND tagged `nivaro-hub:managed=true`.
 * null = no such user. A user that is not the Hub's is NOT_HUB_USER: nothing is read from or
 * changed on it.
 */
async function hubUser(
  ctx: ProviderContext,
  name: string,
  region: string
): Promise<HubUser | null> {
  if (!USER_RE.test(name)) throw new ProviderError('BAD_ID', 'That is not an IAM user name.')
  const r = await orNull(() => iam(ctx, region, 'GetUser', { UserName: name }))
  const u = r && c(r, 'User')
  if (!u) return null
  const tags: Record<string, string> = {}
  for (const x of xmlList(c(u, 'Tags'), 'member')) tags[t(c(x, 'Key'))] = t(c(x, 'Value'))
  if (!t(c(u, 'Path')).startsWith(IAM_PATH) || tags['nivaro-hub:managed'] !== 'true')
    throw new ProviderError(
      'NOT_HUB_USER',
      `IAM user ${name} was not made by the Hub (it is outside ${IAM_PATH} or not tagged nivaro-hub:managed). The Hub never reads or changes it.`
    )
  return { arn: t(c(u, 'Arn')), tags }
}

interface KeyMeta {
  id: string
  status: string
  created: string
}

async function listKeys(ctx: ProviderContext, name: string, region: string): Promise<KeyMeta[]> {
  const r = await iam(ctx, region, 'ListAccessKeys', { UserName: name })
  return xmlList(c(r, 'AccessKeyMetadata'), 'member')
    .map((k) => ({
      id: t(c(k, 'AccessKeyId')),
      status: t(c(k, 'Status')),
      created: t(c(k, 'CreateDate'))
    }))
    .sort((a, b) => a.created.localeCompare(b.created))
}

const policyDoc = (region: string, account: string, domain: string) =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'NivaroHubSesSend',
        Effect: 'Allow',
        Action: ['ses:SendRawEmail', 'ses:SendEmail'],
        Resource: `arn:aws:ses:${region}:${account}:identity/${domain}`
      }
    ]
  })

const canonJson = (s: string): string => {
  try {
    return JSON.stringify(JSON.parse(s))
  } catch {
    return s
  }
}

/** The identity the user's policy allows, only when the policy is exactly the Hub's own. */
async function policyIdentity(
  ctx: ProviderContext,
  name: string,
  region: string
): Promise<{ domain: string | null; region: string }> {
  const r = await orNull(() =>
    iam(ctx, region, 'GetUserPolicy', { UserName: name, PolicyName: POLICY_NAME })
  )
  const raw = r ? t(c(r, 'PolicyDocument')) : ''
  if (!raw) return { domain: null, region }
  let doc = ''
  try {
    doc = decodeURIComponent(raw)
  } catch {
    return { domain: null, region }
  }
  let resource = ''
  try {
    const j = JSON.parse(doc) as { Statement?: Array<{ Resource?: unknown }> }
    resource = String(j.Statement?.[0]?.Resource ?? '')
  } catch {
    return { domain: null, region }
  }
  const m = /^arn:aws:ses:([a-z0-9-]+):(\d{12}):identity\/([a-z0-9.-]+)$/.exec(resource)
  if (!m) return { domain: null, region }
  const [, polRegion, acct, domain] = m
  const ok = canonJson(doc) === policyDoc(polRegion, acct, domain)
  return {
    domain: ok && acct === (await connectionAccount(ctx)) ? domain : null,
    region: polRegion
  }
}

async function userObserved(
  ctx: ProviderContext,
  name: string,
  region: string
): Promise<Observed | null> {
  const u = await hubUser(ctx, name, region)
  if (!u) return null
  const pol = await policyIdentity(ctx, name, region)
  const keys = await listKeys(ctx, name, region)
  // The identity is only reported when the policy is exactly the Hub's, in this region.
  const identity = pol.region === region ? pol.domain : null
  return observed(
    'aws.ses_smtp_user',
    name,
    region,
    name,
    { name, identity, key_count: keys.length },
    u.tags,
    keys.some((k) => k.status === 'Active') ? 'active' : 'no_key'
  )
}

async function putPolicy(ctx: ProviderContext, name: string, region: string, domain: string) {
  const acct = await connectionAccount(ctx)
  await iam(ctx, region, 'PutUserPolicy', {
    UserName: name,
    PolicyName: POLICY_NAME,
    PolicyDocument: policyDoc(region, acct, domain)
  })
}

/** Makes a key; the secret goes only into the returned outputs. */
async function makeKey(
  ctx: ProviderContext,
  name: string,
  region: string
): Promise<Record<string, string>> {
  const r = await iam(ctx, region, 'CreateAccessKey', { UserName: name })
  const k = c(r, 'AccessKey')
  const id = t(c(k, 'AccessKeyId'))
  const secret = t(c(k, 'SecretAccessKey'))
  if (!id || !secret)
    throw new ProviderError('AWS_BAD_ANSWER', 'AWS did not return the new access key.')
  return {
    smtp_host: sesSmtpHost(region),
    smtp_port: '587',
    smtp_user: id,
    smtp_pass: sesSmtpPassword(secret, region)
  }
}

async function identityDomain(
  ctx: ProviderContext,
  desired: { refs: Record<string, unknown> },
  region: string
): Promise<string> {
  const domain = typeof desired.refs.identity === 'string' ? desired.refs.identity : ''
  if (!domain)
    throw new ProviderError('INVALID_FIELDS', 'Pick the SES identity this user may send as.')
  const checked = checkDomain(domain)
  if (!(await readIdentity(ctx, checked, region)))
    throw new ProviderError(
      'IDENTITY_NOT_FOUND',
      `SES identity ${checked} does not exist in ${region}. The SMTP user must be in the identity's region.`
    )
  return checked
}

export const sesSmtpUserDef: AwsTypeDef = {
  global: true,
  spec: {
    key: 'aws.ses_smtp_user',
    label: 'SES SMTP user',
    scope: 'app',
    fields: [
      regionField,
      {
        ...nameField,
        label: 'IAM user name',
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z0-9+=,.@_-]{1,64}$',
        help: 'Made under the path /nivaro-hub/ with a policy that can only send as the identity below.'
      },
      {
        key: 'identity',
        label: 'Sends as (SES identity)',
        kind: 'ref',
        refType: 'aws.ses_identity',
        required: true
      },
      { key: 'key_count', label: 'Access keys', kind: 'number', readOnly: true },
      {
        key: ROTATE_OUTPUTS_FIELD,
        label: 'Make a new access key',
        kind: 'boolean',
        trigger: true,
        default: false,
        help: 'AWS shows a key once. This makes a NEW key and hands out its SMTP password; the previous key stays valid until the next rotation (a user holds at most two).'
      }
    ],
    estimate: sesSmtpUserEstimate,
    capabilities: cap({ tag: false }),
    reversible: false,
    refs: [{ field: 'identity', type: 'aws.ses_identity', required: true }],
    risk: riskOf(),
    outputs: [
      { key: 'smtp_host', label: 'SMTP host', secret: false },
      { key: 'smtp_port', label: 'SMTP port', secret: false },
      { key: 'smtp_user', label: 'SMTP user (access key id)', secret: false, onceOnly: true },
      { key: 'smtp_pass', label: 'SMTP password', secret: true, onceOnly: true }
    ]
  },
  probe: {
    need: 'iam:ListUsers',
    run: (ctx, region) => iam(ctx, region, 'ListUsers', { PathPrefix: IAM_PATH, MaxItems: 1 })
  },
  observe: (ctx, id, region) => userObserved(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await iam(ctx, region, 'ListUsers', {
      PathPrefix: IAM_PATH,
      MaxItems: 100,
      Marker: token ?? undefined
    })
    const out: Observed[] = []
    for (const u of xmlList(c(r, 'Users'), 'member')) {
      const name = t(c(u, 'UserName'))
      if (!name) continue
      try {
        const reg = (await policyIdentity(ctx, name, region)).region
        const o = await userObserved(ctx, name, reg)
        if (o) out.push(o)
      } catch (err) {
        if (!(err instanceof ProviderError && err.code === 'NOT_HUB_USER')) throw err
      }
    }
    return {
      items: out,
      next: t(c(r, 'IsTruncated')) === 'true' ? t(c(r, 'Marker')) || null : null
    }
  },
  findExisting: (ctx, desired, region) =>
    userObserved(ctx, String(desired.fields.name ?? ''), region),
  checkPlan(desired) {
    if (!USER_RE.test(String(desired.fields.name ?? '')))
      throw new ProviderError('INVALID_FIELDS', 'The IAM user name is not valid.')
  },
  async create(ctx, desired, region) {
    const name = String(desired.fields.name)
    const domain = await identityDomain(ctx, desired, region)
    await iam(ctx, region, 'CreateUser', {
      UserName: name,
      Path: IAM_PATH,
      Tags: keyValueTags(hubTags(desired.tags))
    })
    try {
      await afterCreate(ctx, () => putPolicy(ctx, name, region, domain))
      const outputs = await afterCreate(ctx, () => makeKey(ctx, name, region))
      return { id: name, outputs }
    } catch (err) {
      // Leave nothing half-made: a retry starts clean (the user is the Hub's own, just created).
      await orNull(() =>
        iam(ctx, region, 'DeleteUserPolicy', { UserName: name, PolicyName: POLICY_NAME })
      )
      for (const k of await listKeys(ctx, name, region).catch(() => []))
        await orNull(() =>
          iam(ctx, region, 'DeleteAccessKey', { UserName: name, AccessKeyId: k.id })
        )
      await orNull(() => iam(ctx, region, 'DeleteUser', { UserName: name }))
      throw err
    }
  },
  async update(ctx, id, region, desired, _o, changed) {
    await hubUser(ctx, id, region) // proves the user is the Hub's before any write
    if (changed.has('identity'))
      await putPolicy(ctx, id, region, await identityDomain(ctx, desired, region))
    if (changed.has(ROTATE_OUTPUTS_FIELD)) {
      const keys = await listKeys(ctx, id, region)
      // A user holds two keys at most: the older of two goes first.
      while (keys.length >= 2) {
        const old = keys.shift() as KeyMeta
        await iam(ctx, region, 'DeleteAccessKey', { UserName: id, AccessKeyId: old.id })
      }
      return { outputs: await makeKey(ctx, id, region) }
    }
  },
  async readOutputs(ctx, id, region) {
    await hubUser(ctx, id, region)
    return { smtp_host: sesSmtpHost(region), smtp_port: '587' }
  },
  async health(ctx, _id, region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    if (obs.fields.identity == null)
      return {
        status: 'warn',
        message: 'The user’s policy was changed outside the Hub. Apply to put it back.'
      }
    if (obs.status === 'no_key')
      return { status: 'warn', message: 'The user has no active access key. Make a new one.' }
    const sandbox = await sandboxNote(ctx, region)
    return sandbox ? { status: 'warn', message: sandbox } : { status: 'ok', message: 'Active' }
  },
  async remove(ctx, id, region) {
    if (!(await hubUser(ctx, id, region))) return
    for (const k of await listKeys(ctx, id, region))
      await iam(ctx, region, 'DeleteAccessKey', { UserName: id, AccessKeyId: k.id })
    await orNull(() =>
      iam(ctx, region, 'DeleteUserPolicy', { UserName: id, PolicyName: POLICY_NAME })
    )
    // Any other policy, group or attachment makes IAM refuse (DeleteConflict): shown as is.
    await iam(ctx, region, 'DeleteUser', { UserName: id })
  }
}

export const sesDefs: AwsTypeDef[] = [sesIdentityDef, sesConfigurationSetDef, sesSmtpUserDef]
