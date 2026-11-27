import type { HubResourceRow } from '../store.js'
import { countryRefusal, smsCountries } from '../twilio/countries.js'
import {
  type FieldSpec,
  type HealthAnswer,
  type Observed,
  type OpResult,
  type OutboundMessage,
  type PlannedOp,
  type ProviderContext,
  ProviderError,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import {
  assertArnInAccount,
  awsQuery,
  connectionAccount,
  hubTags,
  keyValueTags,
  orNull
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
  snsSmsSettingsEstimate,
  snsSmsUserEstimate,
  snsSubscriptionEstimate,
  snsTopicEstimate
} from './pricing-part4.js'
import { afterCreate, hubUser, IAM_PATH, iam, type KeyMeta, listKeys } from './ses.js'
import { xmlChild, xmlList, xmlText } from './xml.js'

/**
 * Amazon SNS (Query API, signed per region) for an app's alerts and texts (Task 40).
 *
 *  - `aws.sns_topic`: a topic. `sends`: a Hub event published to the topic reaches every
 *    subscriber. `allow_budgets` lets AWS Budgets publish to it (a budget alert).
 *  - `aws.sns_subscription`: email / email-json / https / sms. HTTP (not https) is refused. An SMS
 *    subscription is admin-only and its number follows the same guards as Twilio (E.164, country
 *    allow-list `sms_countries`). Email and https subscriptions stay pending until the recipient
 *    confirms; health says so.
 *  - `aws.sns_sms_settings`: the account's SMS settings in one region (spend limit, default sender,
 *    transactional or promotional). Shared scope (Hub administrators only), never deleted by the
 *    Hub. `sends`: a Hub event is texted to `notify_numbers` (≤10, E.164, allowed countries only,
 *    20 texts an hour per resource, critical events only unless turned off).
 *  - `aws.sns_sms_user`: the narrow IAM exception (Rob's ruling, as the SES SMTP user): an IAM
 *    user under `/nivaro-hub/`, tagged `nivaro-hub:managed` + `nivaro-hub:kind=sns_sms` +
 *    `nivaro-hub:resource=<row>` AT CREATE, whose ONLY policy allows `sns:Publish` (and denies it
 *    on topics, so the key can text phone numbers only). The access key is a `onceOnly` output
 *    bound to the app's SMS settings; every write proves path + tag + this row first.
 */

const t = xmlText
const c = xmlChild

const TOPIC_RE = /^[A-Za-z0-9_-]{1,256}$/
const TOPIC_ARN_RE = /^arn:aws:sns:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]{1,256})$/
const SUB_ARN_RE = /^arn:aws:sns:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]{1,256}):[0-9a-f-]{36}$/
const USER_RE = /^[A-Za-z0-9+=,.@_-]{1,64}$/
const E164_RE = /^\+[1-9]\d{6,14}$/
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[^\s@<>"]{2,63}$/
const SENDER_RE = /^(?=.*[A-Za-z])[A-Za-z0-9]{1,11}$/
const POLICY_NAME = 'nivaro-hub-sns-publish'
const KIND = 'sns_sms'
const MAX_NOTIFY_NUMBERS = 10
const RATE_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000

const invalid = (msg: string) => new ProviderError('INVALID_FIELDS', msg)
const clip = (ctx: ProviderContext, text: string) => ctx.scrub(text).slice(0, 400)

const sns = (
  ctx: ProviderContext,
  region: string,
  action: string,
  params: Record<string, unknown> = {}
) => awsQuery(ctx, 'sns', action, params, { region })

/** SNS answers maps as `<entry><key/><value/></entry>`; some results use a lower-case wrapper. */
function entries(node: unknown, ...names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of names) {
    const wrap = c(node as never, n)
    for (const e of xmlList(wrap, 'entry')) out[t(c(e, 'key'))] = t(c(e, 'value'))
  }
  return out
}

/** `{'Attributes.entry.1.key': …}` for a Query map parameter. */
function mapParam(name: string, map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  Object.entries(map).forEach(([k, v], i) => {
    out[`${name}.entry.${i + 1}.key`] = k
    out[`${name}.entry.${i + 1}.value`] = v
  })
  return out
}

const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []

// ── ARNs (every id is proven to belong to the connection's account and the call's region) ──

async function topicArn(ctx: ProviderContext, arn: string, region: string): Promise<string> {
  const m = TOPIC_ARN_RE.exec(arn)
  if (!m) throw new ProviderError('BAD_ID', 'That is not an SNS topic ARN.')
  await assertArnInAccount(ctx, arn)
  if (m[1] !== region)
    throw new ProviderError('REGION_MISMATCH', `Topic ${m[3]} lives in ${m[1]}, not ${region}.`)
  return arn
}

async function subscriptionArn(ctx: ProviderContext, arn: string, region: string): Promise<string> {
  const m = SUB_ARN_RE.exec(arn)
  if (!m) throw new ProviderError('BAD_ID', 'That is not an SNS subscription ARN.')
  await assertArnInAccount(ctx, arn)
  if (m[1] !== region)
    throw new ProviderError('REGION_MISMATCH', `Subscription lives in ${m[1]}, not ${region}.`)
  return arn
}

// ── aws.sns_topic ──

const budgetsPolicy = (arn: string, account: string) =>
  JSON.stringify({
    Version: '2008-10-17',
    Id: 'nivaro-hub-topic-policy',
    Statement: [
      {
        Sid: 'NivaroHubOwner',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Action: [
          'SNS:GetTopicAttributes',
          'SNS:SetTopicAttributes',
          'SNS:AddPermission',
          'SNS:RemovePermission',
          'SNS:DeleteTopic',
          'SNS:Subscribe',
          'SNS:ListSubscriptionsByTopic',
          'SNS:Publish'
        ],
        Resource: arn,
        Condition: { StringEquals: { 'AWS:SourceOwner': account } }
      },
      {
        Sid: 'NivaroHubBudgets',
        Effect: 'Allow',
        Principal: { Service: 'budgets.amazonaws.com' },
        Action: 'SNS:Publish',
        Resource: arn,
        Condition: { StringEquals: { 'aws:SourceAccount': account } }
      }
    ]
  })

const ownerOnlyPolicy = (arn: string, account: string) => {
  const doc = JSON.parse(budgetsPolicy(arn, account)) as { Statement: unknown[] }
  return JSON.stringify({ ...doc, Statement: [doc.Statement[0]] })
}

async function readTags(
  ctx: ProviderContext,
  arn: string,
  region: string
): Promise<Record<string, string>> {
  const r = await orNull(() => sns(ctx, region, 'ListTagsForResource', { ResourceArn: arn }))
  const out: Record<string, string> = {}
  for (const x of xmlList(r && c(r, 'Tags'), 'member')) out[t(c(x, 'Key'))] = t(c(x, 'Value'))
  return out
}

async function readTopic(ctx: ProviderContext, arn: string, region: string) {
  await topicArn(ctx, arn, region)
  const r = await orNull(() => sns(ctx, region, 'GetTopicAttributes', { TopicArn: arn }))
  if (!r) return null
  const attrs = entries(r, 'Attributes')
  const tags = await readTags(ctx, arn, region)
  const name = arn.split(':').pop() as string
  let allowBudgets = false
  try {
    const doc = JSON.parse(attrs.Policy || '{}') as { Statement?: Array<{ Sid?: string }> }
    allowBudgets = !!doc.Statement?.some((s) => s.Sid === 'NivaroHubBudgets')
  } catch {
    allowBudgets = false
  }
  return observed(
    'aws.sns_topic',
    arn,
    region,
    name,
    {
      name,
      display_name: attrs.DisplayName ?? '',
      kms_key: attrs.KmsMasterKeyId ?? '',
      allow_budgets: allowBudgets,
      subscriptions_confirmed: Number(attrs.SubscriptionsConfirmed ?? 0),
      arn
    },
    tags,
    'active'
  )
}

export const snsTopicDef: AwsTypeDef = {
  spec: {
    key: 'aws.sns_topic',
    label: 'SNS topic',
    scope: 'app',
    fields: [
      regionField,
      {
        ...nameField,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z0-9_-]{1,256}$',
        help: 'Letters, digits, hyphens and underscores.'
      },
      {
        key: 'display_name',
        label: 'Display name',
        kind: 'string',
        pattern: '^[^\\r\\n]{0,100}$',
        help: 'Shown as the sender of an SMS or email from this topic (100 characters at most).'
      },
      {
        key: 'kms_key',
        label: 'Encryption key',
        kind: 'string',
        help: 'A KMS key id, ARN or alias (for example alias/my-key). Empty = not encrypted. AWS Budgets cannot publish to a topic that uses the AWS-managed key.'
      },
      {
        key: 'allow_budgets',
        label: 'Let AWS Budgets publish here',
        kind: 'boolean',
        default: false,
        help: 'Adds the topic policy statement AWS Budgets needs to send a budget alert to this topic (limited to this account).'
      },
      {
        key: 'subscriptions_confirmed',
        label: 'Confirmed subscribers',
        kind: 'number',
        readOnly: true
      },
      { key: 'arn', label: 'ARN', kind: 'string', readOnly: true }
    ],
    estimate: snsTopicEstimate,
    capabilities: cap(),
    reversible: false,
    refs: [],
    risk: riskOf(),
    sends: true
  },
  observe: async (ctx, id, region) => readTopic(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await sns(ctx, region, 'ListTopics', token ? { NextToken: token } : {})
    const out: Observed[] = []
    for (const x of xmlList(c(r, 'Topics'), 'member')) {
      const arn = t(c(x, 'TopicArn'))
      if (!arn) continue
      const o = await orNull(() => readTopic(ctx, arn, region))
      if (o) out.push(o)
    }
    return { items: out, next: t(c(r, 'NextToken')) || null }
  },
  async findExisting(ctx, desired, region) {
    const name = String(desired.fields.name ?? '')
    if (!TOPIC_RE.test(name)) return null
    return readTopic(ctx, `arn:aws:sns:${region}:${await connectionAccount(ctx)}:${name}`, region)
  },
  checkPlan(desired) {
    const f = desired.fields
    if (!TOPIC_RE.test(String(f.name ?? '')))
      throw invalid('A topic name is 1 to 256 letters, digits, hyphens or underscores.')
    if (/[\r\n]/.test(String(f.display_name ?? '')) || String(f.display_name ?? '').length > 100)
      throw invalid('The display name is one line of 100 characters at most.')
  },
  async create(ctx, desired, region) {
    const f = desired.fields
    const r = await sns(ctx, region, 'CreateTopic', {
      Name: String(f.name),
      Tags: keyValueTags(hubTags(desired.tags))
    })
    const arn = t(c(r, 'TopicArn'))
    if (!arn) throw new ProviderError('AWS_BAD_ANSWER', 'AWS did not return the topic ARN.')
    await topicArn(ctx, arn, region)
    await setAttrs(ctx, arn, region, f, new Set(['display_name', 'kms_key', 'allow_budgets']), true)
    return arn
  },
  async update(ctx, id, region, desired, _o, changed) {
    await topicArn(ctx, id, region)
    await setAttrs(ctx, id, region, desired.fields, changed, false)
  },
  async remove(ctx, id, region) {
    await topicArn(ctx, id, region)
    // Subscribers go with the topic: the engine asked for the typed confirm.
    await orNull(() => sns(ctx, region, 'DeleteTopic', { TopicArn: id }))
  },
  async notify(ctx, resource, msg, region): Promise<OpResult> {
    const arn = resource.external_id
    if (!arn) throw new ProviderError('NO_TARGET', 'This topic is not created yet.')
    await topicArn(ctx, arn, region)
    const subject = `${msg.title}`.replace(/[\r\n]+/g, ' ').slice(0, 100)
    await sns(ctx, region, 'Publish', {
      TopicArn: arn,
      Subject: subject || 'Nivaro Hub',
      Message: textOf(msg, 4000)
    })
    return { ok: true, externalId: arn, observed: null, answer: { sent: 1 } }
  },
  health: async (_ctx, _id, _region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> => {
    const n = Number(obs.fields.subscriptions_confirmed ?? 0)
    return n > 0
      ? {
          status: 'ok',
          message: `${n} confirmed subscriber${n === 1 ? '' : 's'}`,
          details: { subscribers: n }
        }
      : {
          status: 'warn',
          message: 'No confirmed subscribers: a message published here reaches nobody.',
          details: { subscribers: 0 }
        }
  }
}

async function setAttrs(
  ctx: ProviderContext,
  arn: string,
  region: string,
  f: Record<string, unknown>,
  changed: Set<string>,
  create: boolean
) {
  const one = (name: string, value: string) =>
    sns(ctx, region, 'SetTopicAttributes', {
      TopicArn: arn,
      AttributeName: name,
      AttributeValue: value
    })
  if (changed.has('display_name') && (!create || f.display_name))
    await one('DisplayName', String(f.display_name ?? ''))
  if (changed.has('kms_key') && (!create || f.kms_key))
    await one('KmsMasterKeyId', String(f.kms_key ?? ''))
  if (changed.has('allow_budgets') && (!create || f.allow_budgets === true)) {
    const acct = await connectionAccount(ctx)
    await one(
      'Policy',
      f.allow_budgets === true ? budgetsPolicy(arn, acct) : ownerOnlyPolicy(arn, acct)
    )
  }
}

function textOf(msg: OutboundMessage, max: number): string {
  return [msg.title, msg.body, msg.link]
    .filter((p) => typeof p === 'string' && p)
    .join('\n')
    .slice(0, max)
}

// ── aws.sns_subscription ──

const PROTOCOLS = ['email', 'email-json', 'https', 'sms']

function validateEndpoint(ctx: ProviderContext, protocol: string, endpoint: string): void {
  if (protocol === 'http')
    throw invalid('Only https URLs can subscribe to a topic (http is refused).')
  if (!PROTOCOLS.includes(protocol))
    throw invalid('The protocol is email, email-json, https or sms.')
  if (protocol === 'https') {
    let u: URL
    try {
      u = new URL(endpoint)
    } catch {
      throw invalid('The endpoint is not a URL.')
    }
    if (u.protocol !== 'https:') throw invalid('The endpoint must be an https URL.')
    if (u.username || u.password)
      throw invalid('The endpoint URL carries no user name or password.')
    if (!u.hostname || u.hostname === 'localhost')
      throw invalid('The endpoint must be a public https address.')
  } else if (protocol === 'sms') {
    if (!E164_RE.test(endpoint))
      throw invalid(`${endpoint} is not a phone number written with +country.`)
    const why = countryRefusal(endpoint, smsCountries(ctx.config))
    if (why) throw new ProviderError('COUNTRY_NOT_ALLOWED', why)
  } else if (!EMAIL_RE.test(endpoint)) throw invalid('The endpoint is not an email address.')
}

const subObserved = (arn: string, region: string, a: Record<string, string>): Observed => {
  const pending = a.PendingConfirmation === 'true'
  return observed(
    'aws.sns_subscription',
    arn,
    region,
    a.Endpoint || null,
    {
      topic: a.TopicArn,
      protocol: a.Protocol,
      endpoint: a.Endpoint,
      status: pending ? 'pending_confirmation' : 'confirmed'
    },
    {},
    pending ? 'pending_confirmation' : 'confirmed'
  )
}

async function readSubscription(ctx: ProviderContext, arn: string, region: string) {
  await subscriptionArn(ctx, arn, region)
  const r = await orNull(() =>
    sns(ctx, region, 'GetSubscriptionAttributes', { SubscriptionArn: arn })
  )
  if (!r) return null
  return subObserved(arn, region, entries(r, 'Attributes'))
}

async function subscriptionsOf(
  ctx: ProviderContext,
  region: string,
  topic: string
): Promise<Observed[]> {
  const out: Observed[] = []
  let token: string | undefined
  for (let i = 0; i < 5; i++) {
    const r = await sns(ctx, region, 'ListSubscriptionsByTopic', {
      TopicArn: topic,
      NextToken: token
    })
    for (const x of xmlList(c(r, 'Subscriptions'), 'member')) {
      const arn = t(c(x, 'SubscriptionArn'))
      if (!SUB_ARN_RE.test(arn)) continue
      out.push(
        subObserved(arn, region, {
          TopicArn: t(c(x, 'TopicArn')),
          Protocol: t(c(x, 'Protocol')),
          Endpoint: t(c(x, 'Endpoint')),
          PendingConfirmation: 'false'
        })
      )
    }
    token = t(c(r, 'NextToken')) || undefined
    if (!token) break
  }
  return out
}

export const snsSubscriptionDef: AwsTypeDef = {
  spec: {
    key: 'aws.sns_subscription',
    label: 'SNS subscription',
    scope: 'app',
    nameField: 'endpoint',
    fields: [
      regionField,
      {
        key: 'topic',
        label: 'Topic',
        kind: 'ref',
        refType: 'aws.sns_topic',
        required: true,
        createOnly: true,
        replaceOnChange: true
      },
      {
        key: 'protocol',
        label: 'Protocol',
        kind: 'enum',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        options: [
          { value: 'email', label: 'Email' },
          { value: 'email-json', label: 'Email (JSON)' },
          { value: 'https', label: 'HTTPS endpoint' },
          { value: 'sms', label: 'Text message' }
        ]
      },
      {
        key: 'endpoint',
        label: 'Endpoint',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        help: 'An email address, an https URL, or a phone number written +15551234567. Email and https subscribers must confirm before they receive anything.'
      },
      { key: 'status', label: 'Status', kind: 'string', readOnly: true }
    ],
    estimate: snsSubscriptionEstimate,
    capabilities: cap({ update: false, tag: false }),
    reversible: false,
    refs: [{ field: 'topic', type: 'aws.sns_topic', required: true }],
    risk: riskOf()
  },
  observe: (ctx, id, region) => readSubscription(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await sns(ctx, region, 'ListSubscriptions', token ? { NextToken: token } : {})
    const out: Observed[] = []
    for (const x of xmlList(c(r, 'Subscriptions'), 'member')) {
      const arn = t(c(x, 'SubscriptionArn'))
      if (!SUB_ARN_RE.test(arn) || arn.split(':')[3] !== region) continue
      out.push(
        subObserved(arn, region, {
          TopicArn: t(c(x, 'TopicArn')),
          Protocol: t(c(x, 'Protocol')),
          Endpoint: t(c(x, 'Endpoint')),
          PendingConfirmation: 'false'
        })
      )
    }
    return { items: out, next: t(c(r, 'NextToken')) || null }
  },
  async findExisting(ctx, desired, region) {
    const topic = desired.refs.topic
    if (typeof topic !== 'string' || !topic) return null
    await topicArn(ctx, topic, region)
    const protocol = String(desired.fields.protocol ?? '')
    const endpoint = String(desired.fields.endpoint ?? '')
    return (
      (await subscriptionsOf(ctx, region, topic)).find(
        (s) => s.fields.protocol === protocol && s.fields.endpoint === endpoint
      ) ?? null
    )
  },
  checkPlan(desired, _observed, ctx) {
    const f = desired.fields
    validateEndpoint(ctx, String(f.protocol ?? ''), String(f.endpoint ?? ''))
  },
  opData: (_ctx, desired, seen) => {
    const protocol = String(desired?.fields.protocol ?? seen?.fields.protocol ?? '')
    // Who gets texted is an administrator's call, as with Twilio.
    return protocol === 'sms' ? { $adminOnly: true } : {}
  },
  async create(ctx, desired, region) {
    const f = desired.fields
    const protocol = String(f.protocol ?? '')
    const endpoint = String(f.endpoint ?? '')
    validateEndpoint(ctx, protocol, endpoint)
    const topic = desired.refs.topic
    if (typeof topic !== 'string' || !topic)
      throw invalid('Pick the topic this subscription belongs to.')
    await topicArn(ctx, topic, region)
    const r = await sns(ctx, region, 'Subscribe', {
      TopicArn: topic,
      Protocol: protocol,
      Endpoint: endpoint,
      ReturnSubscriptionArn: 'true'
    })
    const arn = t(c(r, 'SubscriptionArn'))
    if (!SUB_ARN_RE.test(arn))
      throw new ProviderError('AWS_BAD_ANSWER', 'AWS did not return the subscription id.')
    return arn
  },
  async remove(ctx, id, region) {
    await subscriptionArn(ctx, id, region)
    await orNull(() => sns(ctx, region, 'Unsubscribe', { SubscriptionArn: id }))
  },
  async health(_ctx, _id, _region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    return obs.status === 'pending_confirmation'
      ? {
          status: 'warn',
          message:
            'Waiting for the recipient to confirm (AWS sent a confirmation message). An unconfirmed subscription is removed by AWS after three days.'
        }
      : { status: 'ok', message: 'Confirmed' }
  }
}

// ── aws.sns_sms_settings ──

const smsId = (region: string) => `sms:${region}`

async function readSmsSettings(ctx: ProviderContext, id: string, region: string) {
  if (id !== smsId(region)) return null
  const r = await sns(ctx, region, 'GetSMSAttributes')
  const a = entries(r, 'attributes', 'Attributes')
  const out = observed(
    'aws.sns_sms_settings',
    id,
    region,
    `SMS settings (${region})`,
    {
      monthly_spend_limit: a.MonthlySpendLimit ? Number(a.MonthlySpendLimit) : undefined,
      default_sender_id: a.DefaultSenderID ?? '',
      default_sms_type: a.DefaultSMSType || undefined
    },
    {},
    'active'
  )
  // Whether anything beyond AWS's own defaults is set (a create then refuses: adopt it).
  const configured =
    !!a.DefaultSenderID ||
    !!a.DeliveryStatusIAMRole ||
    !!a.UsageReportS3Bucket ||
    (a.MonthlySpendLimit !== undefined && a.MonthlySpendLimit !== '1') ||
    (a.DefaultSMSType !== undefined && a.DefaultSMSType !== 'Promotional')
  return { observed: out, configured }
}

function validateNotify(ctx: ProviderContext, f: Record<string, unknown>): void {
  const nums = listOf(f.notify_numbers)
  if (nums.length > MAX_NOTIFY_NUMBERS)
    throw invalid(`At most ${MAX_NOTIFY_NUMBERS} numbers get notifications.`)
  const allowed = smsCountries(ctx.config)
  for (const n of nums) {
    if (!E164_RE.test(n)) throw invalid(`${n} is not a phone number written with +country.`)
    const why = countryRefusal(n, allowed)
    if (why) throw new ProviderError('COUNTRY_NOT_ALLOWED', why)
  }
}

function validateSms(ctx: ProviderContext, f: Record<string, unknown>): void {
  if (f.monthly_spend_limit !== undefined && f.monthly_spend_limit !== null) {
    const n = Number(f.monthly_spend_limit)
    if (!Number.isInteger(n) || n < 1 || n > 100000)
      throw invalid('The monthly spend limit is a whole number of dollars from 1 to 100000.')
  }
  const sender = String(f.default_sender_id ?? '')
  if (sender && !SENDER_RE.test(sender))
    throw invalid('A sender id is 1 to 11 letters or digits with at least one letter.')
  const type = String(f.default_sms_type ?? '')
  if (type && type !== 'Transactional' && type !== 'Promotional')
    throw invalid('The default message type is Transactional or Promotional.')
  validateNotify(ctx, f)
}

const NOTIFY_FIELDS: FieldSpec[] = [
  {
    key: 'notify_numbers',
    label: 'Notify these numbers',
    kind: 'list',
    items: { key: 'n', label: 'Phone number', kind: 'string', pattern: E164_RE.source },
    help: 'Hub events routed here are texted to these numbers (at most 10, written +15551234567, only in the connection’s allowed countries).'
  },
  {
    key: 'critical_only',
    label: 'Critical events only',
    kind: 'boolean',
    default: true,
    help: 'Text only events marked critical. Turn off to text everything routed here.'
  }
]

async function smsAttrs(
  ctx: ProviderContext,
  region: string,
  f: Record<string, unknown>,
  changed: Set<string>
) {
  const map: Record<string, string> = {}
  if (changed.has('monthly_spend_limit') && f.monthly_spend_limit != null)
    map.MonthlySpendLimit = String(Math.trunc(Number(f.monthly_spend_limit)))
  if (changed.has('default_sender_id')) map.DefaultSenderID = String(f.default_sender_id ?? '')
  if (changed.has('default_sms_type') && f.default_sms_type)
    map.DefaultSMSType = String(f.default_sms_type)
  if (!Object.keys(map).length) return
  await sns(ctx, region, 'SetSMSAttributes', mapParam('attributes', map))
}

export const snsSmsSettingsDef: AwsTypeDef = {
  spec: {
    key: 'aws.sns_sms_settings',
    label: 'SNS text message settings',
    scope: 'shared',
    nameField: 'region',
    fields: [
      regionField,
      {
        key: 'monthly_spend_limit',
        label: 'Monthly spend limit (USD)',
        kind: 'number',
        min: 1,
        max: 100000,
        help: 'The most AWS lets this account spend on texts in this region each month. AWS caps it at the account’s quota (a new account starts at 1 USD; raising the quota is an AWS support request).'
      },
      {
        key: 'default_sender_id',
        label: 'Default sender id',
        kind: 'string',
        pattern: '^[A-Za-z0-9]{0,11}$',
        help: 'Shown as the sender where countries allow it: 1 to 11 letters or digits with at least one letter.'
      },
      {
        key: 'default_sms_type',
        label: 'Default message type',
        kind: 'enum',
        options: [
          { value: 'Transactional', label: 'Transactional (alerts, one-time codes)' },
          { value: 'Promotional', label: 'Promotional (marketing, cheapest)' }
        ]
      },
      ...NOTIFY_FIELDS
    ],
    estimate: snsSmsSettingsEstimate,
    capabilities: cap({ delete: false, tag: false }),
    reversible: true,
    refs: [],
    risk: riskOf((op) =>
      // A higher spend limit lets texts cost more: the owner-approval gate for cost.
      op.changes.some(
        (ch) =>
          ch.field === 'monthly_spend_limit' &&
          Number(ch.to ?? 0) > Number(ch.from === undefined ? 1 : (ch.from ?? 1))
      )
        ? ['cost']
        : []
    ),
    sends: true
  },
  hubOnly: ['notify_numbers', 'critical_only'],
  observe: async (ctx, id, region) => (await readSmsSettings(ctx, id, region))?.observed ?? null,
  async list(ctx, region): Promise<AwsListPage> {
    const s = await readSmsSettings(ctx, smsId(region), region)
    return { items: s ? [s.observed] : [], next: null }
  },
  async findExisting(ctx, _desired, region) {
    const s = await readSmsSettings(ctx, smsId(region), region)
    // Settings someone already changed are not overwritten by a create: adopt them.
    return s?.configured ? s.observed : null
  },
  checkPlan(desired, _observed, ctx) {
    validateSms(ctx, desired.fields)
  },
  async create(ctx, desired, region) {
    validateSms(ctx, desired.fields)
    await smsAttrs(
      ctx,
      region,
      desired.fields,
      new Set(['monthly_spend_limit', 'default_sender_id', 'default_sms_type'])
    )
    return smsId(region)
  },
  async update(ctx, _id, region, desired, _o, changed) {
    validateSms(ctx, desired.fields)
    await smsAttrs(ctx, region, desired.fields, changed)
  },
  async remove() {
    throw new ProviderError(
      'NOT_DELETABLE',
      'The Hub does not reset an account’s SMS settings. Stop managing it instead.'
    )
  },
  async health(ctx, _id, region): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    const r = await orNull(() => sns(ctx, region, 'GetSMSSandboxAccountStatus'))
    if (r && t(c(r, 'IsInSandbox')) === 'true')
      return {
        status: 'warn',
        message:
          'The account is in the SMS sandbox: only verified numbers receive texts. Moving out of the sandbox is done in the SNS console (a person’s AWS request), not through the Hub.',
        details: { sandbox: true }
      }
    return { status: 'ok', message: 'Active', details: { sandbox: false } }
  },
  async notify(ctx, resource, msg, region): Promise<OpResult> {
    return sendTexts(ctx, resource, msg, region)
  }
}

// ── Notify (texts) ──

/**
 * At most 20 texts an hour per resource, counted in the connection's token cache (per process,
 * forgotten on a restart): a ceiling against runaway sends, not an exact meter. Over the limit =
 * RATE_LIMITED, not retryable.
 */
function takeRate(ctx: ProviderContext, resourceId: number, count: number): void {
  const key = `sns-notify:${resourceId}`
  const now = ctx.now().getTime()
  let stamps: number[] = []
  try {
    const raw = ctx.tokens.get(key)
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed))
      stamps = parsed.filter((x) => typeof x === 'number' && now - x < HOUR_MS)
  } catch {
    stamps = []
  }
  if (stamps.length + count > RATE_PER_HOUR)
    throw new ProviderError(
      'RATE_LIMITED',
      `At most ${RATE_PER_HOUR} texts an hour go out through one resource (${stamps.length} sent in the last hour). This one was not sent.`,
      { retryable: false }
    )
  for (let i = 0; i < count; i++) stamps.push(now)
  ctx.tokens.set(key, JSON.stringify(stamps), new Date(now + HOUR_MS + 2 * 60 * 1000))
}

async function sendTexts(
  ctx: ProviderContext,
  resource: HubResourceRow,
  msg: OutboundMessage,
  region: string
): Promise<OpResult> {
  const f = (resource.desired ?? {}) as Record<string, unknown>
  if (f.critical_only !== false && msg.severity !== 'critical')
    return {
      ok: true,
      externalId: resource.external_id,
      observed: null,
      answer: { skipped: 'not critical' }
    }
  const numbers = listOf(f.notify_numbers)
  if (!numbers.length)
    throw new ProviderError('NO_RECIPIENTS', 'No numbers are set to be texted on this resource.')
  const allowed = smsCountries(ctx.config)
  for (const n of numbers) {
    if (!E164_RE.test(n)) throw new ProviderError('BAD_NUMBER', `${n} is not a valid phone number.`)
    const why = countryRefusal(n, allowed)
    if (why) throw new ProviderError('COUNTRY_NOT_ALLOWED', why)
  }
  const texts = numbers.slice(0, MAX_NOTIFY_NUMBERS)
  takeRate(ctx, resource.id, texts.length)
  const body = textOf(msg, 600)
  const failures: ProviderError[] = []
  let sent = 0
  for (const to of texts) {
    try {
      await sns(ctx, region, 'Publish', {
        PhoneNumber: to,
        Message: body,
        ...{
          'MessageAttributes.entry.1.Name': 'AWS.SNS.SMS.SMSType',
          'MessageAttributes.entry.1.Value.DataType': 'String',
          'MessageAttributes.entry.1.Value.StringValue': 'Transactional'
        }
      })
      sent++
    } catch (err) {
      if (err instanceof ProviderError) failures.push(err)
      else throw err
    }
  }
  if (failures.length) {
    const first = failures[0]
    throw new ProviderError(
      first.code,
      clip(ctx, `${failures.length} of ${numbers.length} texts were not sent: ${first.message}`),
      {
        retryable: failures.every((e) => e.retryable),
        ...(first.status ? { status: first.status } : {})
      }
    )
  }
  return { ok: true, externalId: resource.external_id, observed: null, answer: { sent } }
}

// ── aws.sns_sms_user (the IAM exception) ──

const USER_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'NivaroHubSnsPublish', Effect: 'Allow', Action: 'sns:Publish', Resource: '*' },
    // Phone numbers have no ARN, so the allow needs `*`; this keeps the key off every topic.
    {
      Sid: 'NivaroHubNoTopics',
      Effect: 'Deny',
      Action: 'sns:Publish',
      Resource: 'arn:aws:sns:*:*:*'
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

async function policyIsExact(ctx: ProviderContext, name: string, region: string): Promise<boolean> {
  const r = await orNull(() =>
    iam(ctx, region, 'GetUserPolicy', { UserName: name, PolicyName: POLICY_NAME })
  )
  const raw = r ? t(c(r, 'PolicyDocument')) : ''
  if (!raw) return false
  try {
    return canonJson(decodeURIComponent(raw)) === canonJson(USER_POLICY)
  } catch {
    return false
  }
}

async function userObserved(
  ctx: ProviderContext,
  name: string,
  region: string
): Promise<Observed | null> {
  const u = await hubUser(ctx, name, region, null, KIND)
  if (!u) return null
  const exact = await policyIsExact(ctx, name, region)
  const keys = await listKeys(ctx, name, region)
  return observed(
    'aws.sns_sms_user',
    name,
    region,
    name,
    { name, publish_only: exact, key_count: keys.length },
    u.tags,
    keys.some((k) => k.status === 'Active') ? 'active' : 'no_key'
  )
}

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
    sms_provider: 'aws-sns',
    sms_account_sid: id,
    sms_auth_token: secret,
    sms_region: region
  }
}

const putPolicy = (ctx: ProviderContext, name: string, region: string) =>
  iam(ctx, region, 'PutUserPolicy', {
    UserName: name,
    PolicyName: POLICY_NAME,
    PolicyDocument: USER_POLICY
  })

export const snsSmsUserDef: AwsTypeDef = {
  global: true,
  spec: {
    key: 'aws.sns_sms_user',
    label: 'SNS SMS user',
    scope: 'app',
    fields: [
      regionField,
      {
        ...nameField,
        label: 'IAM user name',
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z0-9+=,.@_-]{1,64}$',
        help: 'Made under the path /nivaro-hub/ with a policy that can only publish text messages. The access key is handed to the app’s SMS settings once.'
      },
      {
        key: 'publish_only',
        label: 'Publish-only policy in place',
        kind: 'boolean',
        default: true,
        help: 'Always on: the user’s one policy allows sns:Publish to phone numbers and nothing else. Apply puts it back if it was changed.'
      },
      { key: 'key_count', label: 'Access keys', kind: 'number', readOnly: true },
      {
        key: ROTATE_OUTPUTS_FIELD,
        label: 'Make a new access key',
        kind: 'boolean',
        trigger: true,
        default: false,
        help: 'AWS shows a key once. This makes a NEW key and hands out its values; the previous key stays valid until the next rotation (a user holds at most two).'
      }
    ],
    estimate: snsSmsUserEstimate,
    capabilities: cap({ tag: false }),
    reversible: false,
    refs: [],
    risk: riskOf(),
    outputs: [
      { key: 'sms_provider', label: 'SMS provider', secret: false },
      { key: 'sms_account_sid', label: 'Access key id', secret: false, onceOnly: true },
      { key: 'sms_auth_token', label: 'Secret access key', secret: true, onceOnly: true },
      { key: 'sms_region', label: 'SMS region', secret: false }
    ]
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
        const o = await userObserved(ctx, name, region)
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
  opData: () => ({ $adminOnly: true }),
  checkPlan(desired) {
    if (!USER_RE.test(String(desired.fields.name ?? '')))
      throw invalid('The IAM user name is not valid.')
    if (desired.fields.publish_only === false)
      throw invalid('The user’s policy is always publish-only; it cannot be turned off.')
  },
  async create(ctx, desired, region) {
    const name = String(desired.fields.name)
    if (!USER_RE.test(name)) throw invalid('The IAM user name is not valid.')
    await iam(ctx, region, 'CreateUser', {
      UserName: name,
      Path: IAM_PATH,
      // Set explicitly at creation (the type has no tag capability): the kind and the row this
      // user belongs to. Every later rotate, policy write and delete checks both.
      Tags: keyValueTags({
        ...hubTags(desired.tags),
        'nivaro-hub:kind': KIND,
        ...(desired.resourceId != null ? { 'nivaro-hub:resource': String(desired.resourceId) } : {})
      })
    })
    try {
      await afterCreate(ctx, () => putPolicy(ctx, name, region))
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
    // This row's own user, proven before any write (a missing row id fails closed).
    await hubUser(ctx, id, region, desired.resourceId ?? -1, KIND)
    if (changed.has('publish_only')) await putPolicy(ctx, id, region)
    if (changed.has(ROTATE_OUTPUTS_FIELD)) {
      const keys: KeyMeta[] = await listKeys(ctx, id, region)
      // A user holds two keys at most: the older of two goes first.
      while (keys.length >= 2) {
        const old = keys.shift() as KeyMeta
        await iam(ctx, region, 'DeleteAccessKey', { UserName: id, AccessKeyId: old.id })
      }
      return { outputs: await makeKey(ctx, id, region) }
    }
  },
  async readOutputs(ctx, id, region) {
    await hubUser(ctx, id, region, null, KIND)
    return { sms_provider: 'aws-sns', sms_region: region }
  },
  async health(ctx, _id, region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    if (obs.fields.publish_only !== true)
      return {
        status: 'warn',
        message: 'The user’s policy was changed outside the Hub. Apply to put it back.'
      }
    if (obs.status === 'no_key')
      return { status: 'warn', message: 'The user has no active access key. Make a new one.' }
    const r = await orNull(() => sns(ctx, region, 'GetSMSSandboxAccountStatus'))
    if (r && t(c(r, 'IsInSandbox')) === 'true')
      return {
        status: 'warn',
        message:
          'The account is in the SMS sandbox: only verified numbers receive texts. Moving out of the sandbox is a person’s request in the SNS console.'
      }
    return { status: 'ok', message: 'Active' }
  },
  async remove(ctx, id, region, op: PlannedOp) {
    if (!(await hubUser(ctx, id, region, op.resourceId ?? -1, KIND))) return
    for (const k of await listKeys(ctx, id, region))
      await iam(ctx, region, 'DeleteAccessKey', { UserName: id, AccessKeyId: k.id })
    await orNull(() =>
      iam(ctx, region, 'DeleteUserPolicy', { UserName: id, PolicyName: POLICY_NAME })
    )
    await iam(ctx, region, 'DeleteUser', { UserName: id })
  }
}

export const snsDefs: AwsTypeDef[] = [
  snsTopicDef,
  snsSubscriptionDef,
  snsSmsSettingsDef,
  snsSmsUserDef
]
