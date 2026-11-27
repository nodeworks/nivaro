import {
  type CostRow,
  type HealthAnswer,
  type Observed,
  type ProviderContext,
  ProviderError
} from '../types.js'
import {
  assertArnInAccount,
  awsFixedJson,
  connectionAccount,
  hubTags,
  keyValueTags,
  orNull
} from './client.js'
import { type AwsListPage, type AwsTypeDef, cap, observed, riskOf } from './kit.js'
import { budgetEstimate, costTagEstimate } from './pricing-part4.js'

/**
 * Cost Explorer, cost allocation tags and AWS Budgets (Task 40). All three answer from one fixed
 * place (Cost Explorer us-east-1, Budgets' global host), never the connection's regions.
 *
 *  - `costs(ctx, range)`: ONE `GetCostAndUsage` per call, DAILY, UnblendedCost, grouped by the
 *    cost allocation tag `nivaro-hub:app` and by RECORD_TYPE (so a row says usage, tax, credit,
 *    discount or refund and Task 44a can learn the connection's tax and discount rates). AWS
 *    bills every Cost Explorer request (about 1 cent), so the feed makes one call per connection
 *    per day; a long answer is read page by page (each page is a request, capped at 10).
 *    Resource-level cost (GetCostAndUsageWithResources) is NOT used: it covers 14 days and needs
 *    an opt-in at AWS, so a row names the app tag, not the resource.
 *  - `aws.cost_allocation_tag`: activates a `nivaro-hub:*` tag. AWS lists a tag only after a
 *    resource carries it (up to 24 hours), and costs split by the tag only from activation on.
 *  - `aws.budget`: an AWS Budget limited to one app's tag, with ACTUAL and FORECASTED alerts to an
 *    SNS topic and / or email addresses. The Hub's own per-app budget (`notifyHub('cost.over_budget')`)
 *    is separate; this one is AWS's own guard.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 400
const MAX_PAGES = 10
const APP_TAG = 'nivaro-hub:app'

const invalid = (msg: string) => new ProviderError('INVALID_FIELDS', msg)

// ── costs() ──

type RecordType = NonNullable<CostRow['recordType']>

/** RECORD_TYPE of a Cost Explorer group → what the price book learns from. */
export function recordTypeOf(name: string): RecordType {
  const n = name.toLowerCase()
  if (n === 'tax') return 'tax'
  if (n === 'credit') return 'credit'
  if (n === 'refund') return 'refund'
  // Offsets and negotiated discounts are negative rows; usage covered by a plan is still usage.
  if (n.includes('discount') && n !== 'discountedusage') return 'discount'
  if (n === 'savingsplannegation') return 'discount'
  return 'usage'
}

const addDay = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const dayDiff = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

/** `nivaro-hub:app$shop` → `shop` ('' = untagged). */
const tagValue = (key: string): string => {
  const i = key.indexOf('$')
  return i < 0 ? '' : key.slice(i + 1)
}

export async function awsCosts(
  ctx: ProviderContext,
  range: { from: string; to: string }
): Promise<CostRow[]> {
  if (!DATE_RE.test(range.from) || !DATE_RE.test(range.to))
    throw invalid('A cost range is two dates written YYYY-MM-DD.')
  if (range.from > range.to) return []
  if (dayDiff(range.from, range.to) + 1 > MAX_DAYS)
    throw invalid(`Cost Explorer answers at most ${MAX_DAYS} days at a time.`)
  const rows: CostRow[] = []
  let token: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    let r: Record<string, any>
    try {
      r = await awsFixedJson(ctx, 'ce', 'GetCostAndUsage', {
        TimePeriod: { Start: range.from, End: addDay(range.to) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [
          { Type: 'TAG', Key: APP_TAG },
          { Type: 'DIMENSION', Key: 'RECORD_TYPE' }
        ],
        ...(token ? { NextPageToken: token } : {})
      })
    } catch (err) {
      if (err instanceof ProviderError && /^(DataUnavailable|BillExpiration)/.test(err.code))
        throw new ProviderError(
          'COST_EXPLORER_OFF',
          'Cost Explorer has no data for this account yet. Turn it on in the AWS billing console (it fills within 24 hours), or use the payer account’s connection.',
          { retryable: false, status: err.status }
        )
      throw err
    }
    for (const day of (r.ResultsByTime as Array<Record<string, any>> | undefined) ?? []) {
      const date = String(day?.TimePeriod?.Start ?? '').slice(0, 10)
      if (!DATE_RE.test(date)) continue
      for (const g of (day.Groups as Array<Record<string, any>> | undefined) ?? []) {
        const keys = Array.isArray(g.Keys) ? g.Keys.map(String) : []
        const m = g.Metrics?.UnblendedCost
        const amount = Number(m?.Amount)
        if (!Number.isFinite(amount)) continue
        const cents = Math.round(amount * 100)
        if (cents === 0) continue
        const recordName = keys[1] ?? 'Usage'
        const type = recordTypeOf(recordName)
        const appTag = tagValue(keys[0] ?? '')
        rows.push({
          date,
          amountCents: cents,
          currency: String(m?.Unit ?? 'USD').toUpperCase(),
          ...(appTag ? { appTag } : {}),
          service: type === 'usage' ? 'AWS' : recordName,
          recordType: type
        })
      }
    }
    token = typeof r.NextPageToken === 'string' && r.NextPageToken ? r.NextPageToken : undefined
    if (!token) break
  }
  return rows
}

// ── aws.cost_allocation_tag ──

const TAG_RE = /^nivaro-hub:[a-z0-9_-]{1,40}$/

const ce = (ctx: ProviderContext, target: string, body: Record<string, unknown>) =>
  awsFixedJson(ctx, 'ce', target, body)

interface TagRow {
  TagKey?: string
  Type?: string
  Status?: string
  LastUpdatedDate?: string
  LastUsedDate?: string
}

async function readTag(ctx: ProviderContext, key: string): Promise<Observed | null> {
  if (!TAG_RE.test(key))
    throw new ProviderError('BAD_ID', 'Only nivaro-hub:* cost allocation tags are managed.')
  const r = await ce(ctx, 'ListCostAllocationTags', { TagKeys: [key], MaxResults: 10 })
  const row = ((r.CostAllocationTags as TagRow[] | undefined) ?? []).find((x) => x.TagKey === key)
  return row ? tagObserved(row) : null
}

function tagObserved(row: TagRow): Observed {
  const key = String(row.TagKey)
  return observed(
    'aws.cost_allocation_tag',
    key,
    'us-east-1',
    key,
    {
      tag_key: key,
      active: row.Status === 'Active',
      last_used: row.LastUsedDate ?? ''
    },
    {},
    row.Status === 'Active' ? 'active' : 'inactive'
  )
}

async function setTagStatus(ctx: ProviderContext, key: string, active: boolean): Promise<void> {
  if (!TAG_RE.test(key))
    throw new ProviderError('BAD_ID', 'Only nivaro-hub:* cost allocation tags are managed.')
  const r = await ce(ctx, 'UpdateCostAllocationTagsStatus', {
    CostAllocationTagsStatus: [{ TagKey: key, Status: active ? 'Active' : 'Inactive' }]
  })
  const err = ((r.Errors as Array<Record<string, any>> | undefined) ?? [])[0]
  if (err)
    throw new ProviderError(
      'TAG_NOT_ACTIVATABLE',
      ctx.scrub(String(err.Message ?? 'AWS could not change the tag.')).slice(0, 300)
    )
}

export const costAllocationTagDef: AwsTypeDef = {
  global: true,
  spec: {
    key: 'aws.cost_allocation_tag',
    label: 'Cost allocation tag',
    scope: 'shared',
    nameField: 'tag_key',
    fields: [
      {
        key: 'tag_key',
        label: 'Tag key',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^nivaro-hub:[a-z0-9_-]{1,40}$',
        help: 'One of the tags the Hub puts on what it makes (nivaro-hub:app, nivaro-hub:env, nivaro-hub:resource). AWS lists a tag only after a resource carries it; costs split by the tag only from the day it is active.'
      },
      {
        key: 'active',
        label: 'Active',
        kind: 'boolean',
        default: true,
        help: 'Cost Explorer and the Hub’s cost feed split costs by an active tag (it takes up to 24 hours to show).'
      },
      { key: 'last_used', label: 'Last seen on a resource', kind: 'string', readOnly: true }
    ],
    estimate: costTagEstimate,
    capabilities: cap({ tag: false }),
    reversible: true,
    refs: [],
    risk: riskOf()
  },
  observe: (ctx, id) => readTag(ctx, id),
  async list(ctx, _region, token): Promise<AwsListPage> {
    const r = await ce(ctx, 'ListCostAllocationTags', {
      Type: 'UserDefined',
      MaxResults: 100,
      ...(token ? { NextToken: token } : {})
    })
    const items = ((r.CostAllocationTags as TagRow[] | undefined) ?? [])
      .filter((x) => TAG_RE.test(String(x.TagKey ?? '')))
      .map(tagObserved)
    return { items, next: typeof r.NextToken === 'string' && r.NextToken ? r.NextToken : null }
  },
  async findExisting(ctx, desired) {
    const have = await readTag(ctx, String(desired.fields.tag_key ?? ''))
    // An already active tag is not re-activated by a create: adopt it.
    return have?.fields.active === true ? have : null
  },
  checkPlan(desired) {
    if (!TAG_RE.test(String(desired.fields.tag_key ?? '')))
      throw invalid('Only nivaro-hub:* tags can be activated (for example nivaro-hub:app).')
  },
  async create(ctx, desired) {
    const key = String(desired.fields.tag_key)
    if (!(await readTag(ctx, key)))
      throw new ProviderError(
        'TAG_NOT_VISIBLE',
        `AWS does not list the tag ${key} yet. A tag appears after a resource carries it (up to 24 hours); tag something first, then activate it.`
      )
    await setTagStatus(ctx, key, desired.fields.active !== false)
    return key
  },
  async update(ctx, id, _region, desired) {
    await setTagStatus(ctx, id, desired.fields.active !== false)
  },
  async remove(ctx, id) {
    // A tag cannot be deleted at AWS: deactivating it is all "delete" means.
    await setTagStatus(ctx, id, false)
  },
  async health(_ctx, _id, _region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    return obs.fields.active === true
      ? {
          status: 'ok',
          message:
            'Active. Costs split by this tag from the day it was activated, and show in Cost Explorer within 24 hours.'
        }
      : {
          status: 'warn',
          message:
            'Not active: Cost Explorer and the Hub’s cost feed cannot split costs by this tag. Activate it (costs appear within 24 hours).'
        }
  }
}

// ── aws.budget ──

const BUDGET_RE = /^[^:\\/]{1,100}$/
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[^\s@<>"]{2,63}$/
const TOPIC_ARN_RE = /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/
const MAX_THRESHOLDS = 4

const budgets = (ctx: ProviderContext, target: string, body: Record<string, unknown>) =>
  awsFixedJson(ctx, 'budgets', target, body)

const budgetArn = (account: string, name: string) => `arn:aws:budgets::${account}:budget/${name}`

const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []

function thresholdsOf(v: unknown): number[] {
  const raw = Array.isArray(v) && v.length ? v : [80, 100]
  const out = [...new Set(raw.map((x) => Number(x)))].sort((a, b) => a - b)
  if (out.length > MAX_THRESHOLDS) throw invalid(`At most ${MAX_THRESHOLDS} alert thresholds.`)
  for (const n of out)
    if (!Number.isInteger(n) || n < 1 || n > 1000)
      throw invalid('An alert threshold is a whole percent from 1 to 1000.')
  return out
}

function appTagOf(f: Record<string, unknown>, tags: Record<string, string>): string {
  const v = String(f.app_tag || tags['nivaro-hub:app'] || '').trim()
  if (!v || /[$,\s]/.test(v)) throw invalid('A budget is for one app: set a valid app tag value.')
  return v
}

function checkBudget(desired: { fields: Record<string, unknown>; tags: Record<string, string> }) {
  const f = desired.fields
  if (!BUDGET_RE.test(String(f.name ?? '')))
    throw invalid('A budget name is 1 to 100 characters without : / or \\.')
  const limit = Number(f.limit_usd)
  if (!Number.isFinite(limit) || limit < 1 || limit > 10_000_000)
    throw invalid('The monthly limit is a number of dollars from 1 to 10,000,000.')
  appTagOf(f, desired.tags)
  thresholds(f)
  for (const e of listOf(f.emails))
    if (!EMAIL_RE.test(e)) throw invalid(`${e} is not an email address.`)
  if (listOf(f.emails).length > 10) throw invalid('At most 10 email addresses.')
}
const thresholds = (f: Record<string, unknown>) => thresholdsOf(f.thresholds)

interface NotificationDef {
  Notification: Record<string, unknown>
  Subscribers: Array<Record<string, string>>
}

function notificationsFor(f: Record<string, unknown>, topic: string | null): NotificationDef[] {
  const subs: Array<Record<string, string>> = [
    ...(topic ? [{ SubscriptionType: 'SNS', Address: topic }] : []),
    ...listOf(f.emails).map((a) => ({ SubscriptionType: 'EMAIL', Address: a }))
  ]
  if (!subs.length) return []
  const types = f.forecast_alerts === false ? ['ACTUAL'] : ['ACTUAL', 'FORECASTED']
  return thresholds(f).flatMap((pct) =>
    types.map((NotificationType) => ({
      Notification: {
        NotificationType,
        ComparisonOperator: 'GREATER_THAN',
        Threshold: pct,
        ThresholdType: 'PERCENTAGE'
      },
      Subscribers: subs
    }))
  )
}

const budgetBody = (name: string, limit: number, app: string) => ({
  BudgetName: name,
  BudgetLimit: { Amount: String(limit), Unit: 'USD' },
  TimeUnit: 'MONTHLY',
  BudgetType: 'COST',
  // User-defined tags are filtered as `user:<key>$<value>`.
  CostFilters: { TagKeyValue: [`user:${APP_TAG}$${app}`] }
})

async function topicRef(ctx: ProviderContext, desired: { refs: Record<string, unknown> }) {
  const t = desired.refs.topic
  if (t === undefined || t === null || t === '') return null
  if (typeof t !== 'string' || !TOPIC_ARN_RE.test(t))
    throw invalid('The alert topic must be an SNS topic.')
  await assertArnInAccount(ctx, t)
  return t
}

async function readBudget(ctx: ProviderContext, name: string): Promise<Observed | null> {
  if (!BUDGET_RE.test(name)) throw new ProviderError('BAD_ID', 'That is not a budget name.')
  const account = await connectionAccount(ctx)
  const r = await orNull(() =>
    budgets(ctx, 'DescribeBudget', { AccountId: account, BudgetName: name })
  )
  const b = r?.Budget as Record<string, any> | undefined
  if (!b) return null
  const ns = await budgets(ctx, 'DescribeNotificationsForBudget', {
    AccountId: account,
    BudgetName: name
  })
  const notes = (ns.Notifications as Array<Record<string, any>> | undefined) ?? []
  const pcts = [
    ...new Set(
      notes.filter((n) => n.ThresholdType === 'PERCENTAGE').map((n) => Number(n.Threshold))
    )
  ].sort((a, b2) => a - b2)
  let topic = ''
  const emails: string[] = []
  if (notes[0]) {
    const sub = await budgets(ctx, 'DescribeSubscribersForNotification', {
      AccountId: account,
      BudgetName: name,
      Notification: notes[0]
    })
    for (const s of (sub.Subscribers as Array<Record<string, string>> | undefined) ?? []) {
      if (s.SubscriptionType === 'SNS') topic = s.Address
      else if (s.SubscriptionType === 'EMAIL') emails.push(s.Address)
    }
  }
  const tags: Record<string, string> = {}
  const tr = await orNull(() =>
    budgets(ctx, 'ListTagsForResource', { ResourceARN: budgetArn(account, name) })
  )
  for (const x of (tr?.ResourceTags as Array<{ Key: string; Value: string }> | undefined) ?? [])
    tags[x.Key] = x.Value
  const filter = (b.CostFilters?.TagKeyValue as string[] | undefined)?.[0] ?? ''
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return observed(
    'aws.budget',
    name,
    'us-east-1',
    name,
    {
      name,
      limit_usd: num(b.BudgetLimit?.Amount),
      app_tag: filter.startsWith(`user:${APP_TAG}$`) ? filter.slice(`user:${APP_TAG}$`.length) : '',
      thresholds: pcts,
      topic,
      emails: emails.sort(),
      // No notifications at all (no recipients yet): the default, so a later desired state shows no drift.
      forecast_alerts: notes.length ? notes.some((n) => n.NotificationType === 'FORECASTED') : true,
      actual_usd: num(b.CalculatedSpend?.ActualSpend?.Amount),
      forecast_usd: num(b.CalculatedSpend?.ForecastedSpend?.Amount)
    },
    tags,
    'active'
  )
}

async function writeNotifications(
  ctx: ProviderContext,
  account: string,
  name: string,
  wanted: NotificationDef[]
) {
  const have = await budgets(ctx, 'DescribeNotificationsForBudget', {
    AccountId: account,
    BudgetName: name
  })
  for (const n of (have.Notifications as Array<Record<string, unknown>> | undefined) ?? [])
    await budgets(ctx, 'DeleteNotification', {
      AccountId: account,
      BudgetName: name,
      Notification: n
    })
  for (const n of wanted)
    await budgets(ctx, 'CreateNotification', {
      AccountId: account,
      BudgetName: name,
      Notification: n.Notification,
      Subscribers: n.Subscribers
    })
}

export const budgetDef: AwsTypeDef = {
  global: true,
  spec: {
    key: 'aws.budget',
    label: 'AWS budget',
    scope: 'app',
    fields: [
      {
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[^:\\\\/]{1,100}$'
      },
      {
        key: 'limit_usd',
        label: 'Monthly limit (USD)',
        kind: 'number',
        required: true,
        min: 1,
        help: 'The budget counts this app’s costs (the cost allocation tag nivaro-hub:app must be active).'
      },
      {
        key: 'app_tag',
        label: 'App tag value',
        kind: 'string',
        help: 'The value of nivaro-hub:app to count. Empty = this app’s own tag.'
      },
      {
        key: 'thresholds',
        label: 'Alert at (percent of the limit)',
        kind: 'list',
        items: { key: 'p', label: 'Percent', kind: 'number', min: 1, max: 1000 },
        default: [80, 100],
        help: 'Up to 4 percentages.'
      },
      {
        key: 'forecast_alerts',
        label: 'Also alert on the forecast',
        kind: 'boolean',
        default: true
      },
      {
        key: 'topic',
        label: 'Alert topic',
        kind: 'ref',
        refType: 'aws.sns_topic',
        help: 'The SNS topic AWS publishes the alert to (turn on “Let AWS Budgets publish here” on the topic).'
      },
      {
        key: 'emails',
        label: 'Alert emails',
        kind: 'list',
        items: { key: 'e', label: 'Email', kind: 'string' },
        help: 'At most 10 addresses AWS emails directly.'
      },
      { key: 'actual_usd', label: 'Spent this month (USD)', kind: 'number', readOnly: true },
      { key: 'forecast_usd', label: 'Forecast this month (USD)', kind: 'number', readOnly: true }
    ],
    estimate: budgetEstimate,
    capabilities: cap(),
    reversible: false,
    refs: [{ field: 'topic', type: 'aws.sns_topic', required: false }],
    risk: riskOf()
  },
  observe: (ctx, id) => readBudget(ctx, id),
  async list(ctx, _region, token): Promise<AwsListPage> {
    const account = await connectionAccount(ctx)
    const r = await budgets(ctx, 'DescribeBudgets', {
      AccountId: account,
      MaxResults: 50,
      ...(token ? { NextToken: token } : {})
    })
    const out: Observed[] = []
    for (const b of (r.Budgets as Array<{ BudgetName?: string }> | undefined) ?? []) {
      if (!b.BudgetName) continue
      const o = await readBudget(ctx, b.BudgetName)
      if (o) out.push(o)
    }
    return { items: out, next: typeof r.NextToken === 'string' && r.NextToken ? r.NextToken : null }
  },
  findExisting: (ctx, desired) => readBudget(ctx, String(desired.fields.name ?? '')),
  checkPlan: (desired) => checkBudget(desired),
  async create(ctx, desired) {
    checkBudget(desired)
    const f = desired.fields
    const name = String(f.name)
    const account = await connectionAccount(ctx)
    const topic = await topicRef(ctx, desired)
    await budgets(ctx, 'CreateBudget', {
      AccountId: account,
      Budget: budgetBody(name, Number(f.limit_usd), appTagOf(f, desired.tags)),
      NotificationsWithSubscribers: notificationsFor(f, topic),
      // Tags at creation: the Hub's resource tag marks this budget as this row's own.
      ResourceTags: keyValueTags(hubTags(desired.tags))
    })
    return name
  },
  async update(ctx, id, _region, desired, _obs, changed) {
    checkBudget(desired)
    const f = desired.fields
    const account = await connectionAccount(ctx)
    if (changed.has('limit_usd') || changed.has('app_tag'))
      await budgets(ctx, 'UpdateBudget', {
        AccountId: account,
        NewBudget: budgetBody(id, Number(f.limit_usd), appTagOf(f, desired.tags))
      })
    if (['thresholds', 'forecast_alerts', 'topic', 'emails'].some((k) => changed.has(k)))
      await writeNotifications(ctx, account, id, notificationsFor(f, await topicRef(ctx, desired)))
  },
  async remove(ctx, id) {
    const account = await connectionAccount(ctx)
    await orNull(() => budgets(ctx, 'DeleteBudget', { AccountId: account, BudgetName: id }))
  },
  async health(_ctx, _id, _region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    const limit = Number(obs.fields.limit_usd)
    const actual = Number(obs.fields.actual_usd)
    const forecast = Number(obs.fields.forecast_usd)
    const cents = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) : 0)
    const details = {
      limit_cents: cents(limit),
      actual_cents: cents(actual),
      forecast_cents: cents(forecast)
    }
    if (!obs.fields.app_tag)
      return {
        status: 'warn',
        message: 'The budget is not limited to an app tag, so it counts the whole account.',
        details
      }
    if (limit > 0 && actual >= limit)
      return { status: 'down', message: 'Spent more than the monthly limit.', details }
    if (limit > 0 && (actual >= limit * 0.8 || forecast >= limit))
      return {
        status: 'warn',
        message: 'Spending is at 80% of the limit or the forecast passes it.',
        details
      }
    if (!obs.fields.topic && !(obs.fields.emails as string[] | undefined)?.length)
      return { status: 'warn', message: 'No alert recipients: AWS will not tell anyone.', details }
    return { status: 'ok', message: 'Within budget', details }
  }
}

export const costDefs: AwsTypeDef[] = [costAllocationTagDef, budgetDef]
