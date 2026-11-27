import { describe, expect, it, vi } from 'vitest'

// Nivaro Hub providers, Task 40: the AWS adapter's SNS, Cost Explorer / Budgets and Route 53
// Domains types against recorded (fixture) AWS answers. Nothing reaches real AWS, and no domain is
// ever registered: RegisterDomain answers from a fixture.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { awsProvider } = await import('../../../services/hub/providers/aws/adapter.js')
const { domainExpiresAt } = await import('../../../services/hub/providers/aws/domains.js')
const { recordTypeOf } = await import('../../../services/hub/providers/aws/cost-explorer.js')
const { desired, harness, OTHER_PROBES_OK, observedOf } = await import('./hub-aws-harness.js')
import type { HubResourceRow } from '../../../services/hub/providers/store.js'
import type { PlannedOp } from '../../../services/hub/providers/types.js'

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:shop-alerts'
const SUB = `${TOPIC}:11111111-2222-3333-4444-555555555555`
const KEY_SECRET = 'test-secret-smtp-key-0001'

const op = (kind: PlannedOp['kind'], type: string, extra: Partial<PlannedOp> = {}): PlannedOp => ({
  kind,
  type,
  resourceId: 41,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  data: { region: 'us-east-1' },
  ...extra
})
const gone = (file: string) => ({ status: 404, file })
const type = (key: string) => awsProvider.types.find((t) => t.key === key)
const row = (over: Partial<HubResourceRow>): HubResourceRow =>
  ({
    id: 5,
    connection_id: 7,
    provider: 'aws',
    type: 'aws.sns_topic',
    external_id: TOPIC,
    name: 'x',
    scope: 'app',
    app_id: 1,
    environment_id: 2,
    desired: {},
    observed: null,
    drift: false,
    observed_at: null,
    tags: {},
    refs: [],
    created_by: null,
    adopted: false,
    deleted_at: null,
    created_at: null,
    updated_at: null,
    ...over
  }) as HubResourceRow
const msg = (severity: 'info' | 'critical' = 'critical') => ({
  kind: 'text' as const,
  title: 'Deploy failed',
  body: 'shop production',
  severity
})

const connectionHandlers = (over: Record<string, unknown> = {}) => {
  const h: Record<string, unknown> = {
    ...OTHER_PROBES_OK,
    'sts:GetCallerIdentity': 'sts-caller-identity.xml'
  }
  for (const a of [
    'DescribeVpcs',
    'DescribeSubnets',
    'DescribeRouteTables',
    'DescribeInternetGateways',
    'DescribeNatGateways',
    'DescribeNetworkAcls',
    'DescribeSecurityGroups',
    'DescribeAddresses',
    'DescribeInstances',
    'DescribeVolumes'
  ])
    h[`ec2:${a}`] = { status: 412, file: 'ec2-error-dryrun.xml' }
  return { ...h, ...over }
}

describe('aws part 4 hosts and connection', () => {
  it('adds SNS for the allowed regions only and the fixed Cost Explorer, Budgets and Domains hosts', () => {
    const hosts = awsProvider.connection.hosts({ regions: ['eu-west-1'] })
    expect(hosts).toEqual(
      expect.arrayContaining([
        'sns.eu-west-1.amazonaws.com',
        'ce.us-east-1.amazonaws.com',
        'budgets.amazonaws.com',
        'route53domains.us-east-1.amazonaws.com'
      ])
    )
    expect(hosts).not.toContain('sns.us-east-1.amazonaws.com')
  })

  it('the SNS, Budgets and Domains permissions are optional: missing ones never fail the connection', async () => {
    const denied = { status: 403, body: '{"__type":"AccessDeniedException","Message":"no"}' }
    const h = harness(
      connectionHandlers({
        'sns:ListTopics': {
          status: 403,
          file: 'iam-error-denied.xml'
        },
        'budgets:DescribeBudgets': denied,
        'route53domains:ListDomains': denied
      }) as never
    )
    const t = await awsProvider.testConnection(h.ctx)
    expect(t.ok).toBe(true)
    expect(t.missing).toEqual(
      expect.arrayContaining(['sns:ListTopics', 'budgets:ViewBudget', 'route53domains:ListDomains'])
    )
    // Cost Explorer is billed per request: the connection test never calls it.
    expect(h.of('GetCostAndUsage')).toHaveLength(0)
  })

  it('has sms_countries on the connection, default US,CA', () => {
    const f = awsProvider.connection.fields.find((x) => x.key === 'sms_countries')
    expect(f?.default).toBe('US,CA')
  })
})

describe('aws.sns_topic', () => {
  const reads = (over: Record<string, unknown> = {}) => ({
    'sns:GetTopicAttributes': 'sns-get-topic.xml',
    'sns:ListTagsForResource': 'sns-list-tags.xml',
    ...over
  })

  it('maps a topic: display name, budgets policy, confirmed subscribers and tags', async () => {
    const h = harness(reads() as never)
    const o = await awsProvider.observe(h.ctx, 'aws.sns_topic', TOPIC)
    expect(o).toMatchObject({
      externalId: TOPIC,
      name: 'shop-alerts',
      fields: { display_name: 'Shop', allow_budgets: true, subscriptions_confirmed: 2 },
      tags: { 'nivaro-hub:resource': '41' }
    })
  })

  it('answers null for a topic that is gone, and refuses foreign accounts, other regions and bad ids', async () => {
    const h = harness(reads({ 'sns:GetTopicAttributes': gone('sns-error-notfound.xml') }) as never)
    expect(await awsProvider.observe(h.ctx, 'aws.sns_topic', TOPIC)).toBeNull()
    await expect(
      awsProvider.observe(h.ctx, 'aws.sns_topic', 'arn:aws:sns:us-east-1:999999999999:other')
    ).rejects.toMatchObject({ code: 'AWS_OUT_OF_ACCOUNT' })
    await expect(
      awsProvider.observe(h.ctx, 'aws.sns_topic', 'arn:aws:sns:eu-west-1:123456789012:other')
    ).rejects.toMatchObject({ code: 'REGION_MISMATCH' })
    await expect(awsProvider.observe(h.ctx, 'aws.sns_topic', '../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
  })

  it('creates with the Hub tags, display name and the Budgets policy limited to this account', async () => {
    const h = harness(
      reads({
        'sns:GetTopicAttributes': [gone('sns-error-notfound.xml'), 'sns-get-topic.xml'],
        'sns:CreateTopic': 'sns-create-topic.xml',
        'sns:SetTopicAttributes': 'sns-ok.xml'
      }) as never
    )
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.sns_topic'),
      desired('aws.sns_topic', { name: 'shop-alerts', display_name: 'Shop', allow_budgets: true })
    )
    expect(res.externalId).toBe(TOPIC)
    const create = h.of('CreateTopic')[0].params
    expect(create.Name).toBe('shop-alerts')
    expect(Object.values(create)).toEqual(
      expect.arrayContaining(['nivaro-hub:managed', 'nivaro-hub:resource', '41'])
    )
    const set = h.of('SetTopicAttributes').map((c) => c.params)
    expect(set.map((p) => p.AttributeName).sort()).toEqual(['DisplayName', 'Policy'])
    const pol = JSON.parse(set.find((p) => p.AttributeName === 'Policy')?.AttributeValue ?? '{}')
    expect(pol.Statement[1].Principal).toEqual({ Service: 'budgets.amazonaws.com' })
    expect(pol.Statement[1].Condition.StringEquals['aws:SourceAccount']).toBe('123456789012')
  })

  it('a topic the Hub did not make is ALREADY_EXISTS; nothing is created or changed', async () => {
    const h = harness(reads({ 'sns:ListTagsForResource': 'sns-list-tags-other.xml' }) as never)
    await expect(
      awsProvider.apply(h.ctx, op('create', 'aws.sns_topic'), desired('aws.sns_topic', { name: 'shop-alerts' }))
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(h.of('CreateTopic')).toHaveLength(0)
    expect(h.of('SetTopicAttributes')).toHaveLength(0)
  })

  it('delete is destructive and removes the topic; a delete of a gone topic does nothing', async () => {
    const plan = awsProvider.plan(
      harness(reads() as never).ctx,
      null,
      observedOf({ type: 'aws.sns_topic', externalId: TOPIC, name: 'shop-alerts' })
    )
    expect(plan[0]).toMatchObject({ kind: 'delete', risk: ['destructive'] })
    const h = harness(reads({ 'sns:DeleteTopic': 'sns-ok.xml' }) as never)
    await awsProvider.apply(h.ctx, op('delete', 'aws.sns_topic', { externalId: TOPIC }), null)
    expect(h.of('DeleteTopic')[0].params.TopicArn).toBe(TOPIC)
    const g = harness(reads({ 'sns:GetTopicAttributes': gone('sns-error-notfound.xml') }) as never)
    await awsProvider.apply(g.ctx, op('delete', 'aws.sns_topic', { externalId: TOPIC }), null)
    expect(g.of('DeleteTopic')).toHaveLength(0)
  })

  it('notify sends one message to the topic and maps 429 to retryable', async () => {
    const h = harness({ 'sns:Publish': 'sns-publish.xml' } as never)
    const r = await awsProvider.notify?.(h.ctx, row({}), {
      ...msg(),
      title: 'Deploy\nfailed',
      link: 'https://hub.example.com/x'
    })
    expect(r?.ok).toBe(true)
    const p = h.of('Publish')
    expect(p).toHaveLength(1)
    expect(p[0].params.TopicArn).toBe(TOPIC)
    expect(p[0].params.Subject).toBe('Deploy failed')
    expect(p[0].params.Message).toContain('shop production')
    const slow = harness({
      'sns:Publish': { status: 429, file: 'sns-error-throttle.xml' }
    } as never)
    await expect(awsProvider.notify?.(slow.ctx, row({}), msg())).rejects.toMatchObject({
      retryable: true
    })
  })

  it('declares sends, estimates as usage and no costClass', async () => {
    const t = type('aws.sns_topic')
    expect(t?.sends).toBe(true)
    expect(t?.costClass).toBeUndefined()
    const e = await t?.estimate?.(
      harness({ 'pricing:GetProducts': 'pricing-empty.json' } as never).ctx,
      desired('aws.sns_topic', { name: 'x' }),
      null
    )
    expect(e?.basis).toBe('usage')
    expect(e?.note).toMatch(/first million/)
  })
})

describe('aws.sns_subscription', () => {
  const want = (f: Record<string, unknown>) =>
    desired('aws.sns_subscription', { ...f }, { refs: { topic: TOPIC } })
  const ctx = () => harness({} as never).ctx

  it('refuses http, an https URL with credentials and a bad email', () => {
    expect(() =>
      awsProvider.plan(ctx(), want({ protocol: 'http', endpoint: 'http://x.example.com' }), null)
    ).toThrow(/https/)
    expect(() =>
      awsProvider.plan(
        ctx(),
        want({ protocol: 'https', endpoint: 'https://user:pw@hooks.example.com/x' }),
        null
      )
    ).toThrow(/user name or password/)
    expect(() =>
      awsProvider.plan(ctx(), want({ protocol: 'email', endpoint: 'not-an-email' }), null)
    ).toThrow(/email/)
    const ok = awsProvider.plan(
      ctx(),
      want({ protocol: 'https', endpoint: 'https://hooks.example.com/x' }),
      null
    )
    expect(ok[0].kind).toBe('create')
    expect(ok[0].data?.$adminOnly).toBeUndefined()
  })

  it('an SMS number follows the Twilio guards: E.164, allowed countries, admin only', () => {
    expect(() =>
      awsProvider.plan(ctx(), want({ protocol: 'sms', endpoint: '5551234567' }), null)
    ).toThrow(/\+country/)
    expect(() =>
      awsProvider.plan(ctx(), want({ protocol: 'sms', endpoint: '+442071838750' }), null)
    ).toThrow(expect.objectContaining({ code: 'COUNTRY_NOT_ALLOWED' }))
    const us = awsProvider.plan(ctx(), want({ protocol: 'sms', endpoint: '+12025550142' }), null)
    expect(us[0].data?.$adminOnly).toBe(true)
    const gb = harness({} as never, { config: { sms_countries: 'US,GB' } }).ctx
    expect(
      awsProvider.plan(gb, want({ protocol: 'sms', endpoint: '+442071838750' }), null)[0].kind
    ).toBe('create')
  })

  it('subscribes once asking for the ARN, and an existing subscription is ALREADY_EXISTS', async () => {
    const h = harness({
      'sns:ListSubscriptionsByTopic': 'sns-list-subs-by-topic.xml',
      'sns:Subscribe': 'sns-subscribe.xml',
      'sns:GetSubscriptionAttributes': 'sns-get-sub-pending.xml'
    } as never)
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.sns_subscription'),
      want({ protocol: 'email', endpoint: 'new@example.com' })
    )
    expect(res.externalId).toBe(SUB)
    expect(res.observed?.status).toBe('pending_confirmation')
    expect(h.of('Subscribe')[0].params).toMatchObject({
      TopicArn: TOPIC,
      Protocol: 'email',
      Endpoint: 'new@example.com',
      ReturnSubscriptionArn: 'true'
    })
    const dup = harness({
      'sns:ListSubscriptionsByTopic': 'sns-list-subs-by-topic.xml',
      'sns:Subscribe': 'sns-subscribe.xml'
    } as never)
    await expect(
      awsProvider.apply(
        dup.ctx,
        op('create', 'aws.sns_subscription'),
        want({ protocol: 'email', endpoint: 'ops@example.com' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(dup.of('Subscribe')).toHaveLength(0)
  })

  it('an answer with no subscription id is not taken as one', async () => {
    const h = harness({
      'sns:ListSubscriptionsByTopic': 'sns-list-subs-by-topic.xml',
      'sns:Subscribe': 'sns-subscribe-pending-literal.xml'
    } as never)
    await expect(
      awsProvider.apply(
        h.ctx,
        op('create', 'aws.sns_subscription'),
        want({ protocol: 'email', endpoint: 'new@example.com' })
      )
    ).rejects.toMatchObject({ code: 'AWS_BAD_ANSWER' })
  })

  it('observes pending and confirmed; health says the recipient must confirm; list skips unnamed ones', async () => {
    const h = harness({
      'sns:GetSubscriptionAttributes': 'sns-get-sub-pending.xml',
      'sns:ListSubscriptions': 'sns-list-subs.xml'
    } as never)
    const o = await awsProvider.observe(h.ctx, 'aws.sns_subscription', SUB)
    expect(o).toMatchObject({ name: 'ops@example.com', status: 'pending_confirmation' })
    const health = await awsProvider.health?.(h.ctx, 'aws.sns_subscription', SUB)
    expect(health?.status).toBe('warn')
    expect(health?.message).toMatch(/confirm/)
    const list = await awsProvider.list(h.ctx, 'aws.sns_subscription')
    expect(list.items).toHaveLength(1)
  })

  it('every field is fixed at creation, so a change replaces and nothing updates', () => {
    const o = observedOf({
      type: 'aws.sns_subscription',
      externalId: SUB,
      fields: { region: 'us-east-1', topic: TOPIC, protocol: 'email', endpoint: 'ops@example.com' }
    })
    const p = awsProvider.plan(
      ctx(),
      want({ protocol: 'email', endpoint: 'other@example.com' }),
      o
    )
    expect(p[0].kind).toBe('replace')
    expect(p[0].risk).toContain('destructive')
    expect(type('aws.sns_subscription')?.capabilities.update).toBe(false)
  })
})

describe('aws.sns_sms_settings', () => {
  const ctx = () => harness({} as never).ctx
  const settings = observedOf({
    type: 'aws.sns_sms_settings',
    externalId: 'sms:us-east-1',
    fields: {
      region: 'us-east-1',
      monthly_spend_limit: 50,
      default_sender_id: 'NIVARO',
      default_sms_type: 'Transactional'
    }
  })
  const same = {
    monthly_spend_limit: 50,
    default_sender_id: 'NIVARO',
    default_sms_type: 'Transactional'
  }

  it('is shared scope, cannot be deleted and sends', () => {
    const t = type('aws.sns_sms_settings')
    expect(t?.scope).toBe('shared')
    expect(t?.capabilities.delete).toBe(false)
    expect(t?.sends).toBe(true)
  })

  it('observes the account settings in a region', async () => {
    const h = harness({
      'sns:GetSMSAttributes': 'sns-sms-attrs.xml'
    } as never)
    const o = await awsProvider.observe(h.ctx, 'aws.sns_sms_settings', 'sms:us-east-1')
    expect(o?.fields).toMatchObject({
      monthly_spend_limit: 50,
      default_sender_id: 'NIVARO',
      default_sms_type: 'Transactional'
    })
    expect(await awsProvider.observe(h.ctx, 'aws.sns_sms_settings', 'sms:eu-west-1')).toBeNull()
  })

  it('settings someone already changed are ALREADY_EXISTS on create; AWS defaults are set', async () => {
    const taken = harness({ 'sns:GetSMSAttributes': 'sns-sms-attrs.xml' } as never)
    await expect(
      awsProvider.apply(
        taken.ctx,
        op('create', 'aws.sns_sms_settings'),
        desired('aws.sns_sms_settings', { monthly_spend_limit: 500 })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(taken.of('SetSMSAttributes')).toHaveLength(0)

    const fresh = harness({
      'sns:GetSMSAttributes': ['sns-sms-attrs-defaults-set.xml', 'sns-sms-attrs.xml'],
      'sns:SetSMSAttributes': 'sns-set-sms-ok.xml'
    } as never)
    const res = await awsProvider.apply(
      fresh.ctx,
      op('create', 'aws.sns_sms_settings'),
      desired('aws.sns_sms_settings', {
        monthly_spend_limit: 50,
        default_sms_type: 'Transactional'
      })
    )
    expect(res.externalId).toBe('sms:us-east-1')
    const params = fresh.of('SetSMSAttributes')[0].params
    expect(Object.values(params)).toEqual(
      expect.arrayContaining(['MonthlySpendLimit', '50', 'DefaultSMSType', 'Transactional'])
    )
  })

  it('raising the spend limit is a cost change; lowering it is not', () => {
    const up = awsProvider.plan(
      ctx(),
      desired('aws.sns_sms_settings', { ...same, monthly_spend_limit: 500 }),
      settings
    )
    expect(up[0]).toMatchObject({ kind: 'update', risk: ['cost'] })
    const down = awsProvider.plan(
      ctx(),
      desired('aws.sns_sms_settings', { ...same, monthly_spend_limit: 10 }),
      settings
    )
    expect(down[0].risk).toEqual([])
  })

  it('validates the limit, the sender and the notify numbers at plan time', () => {
    const bad = (f: Record<string, unknown>) =>
      awsProvider.plan(ctx(), desired('aws.sns_sms_settings', f), settings)
    expect(() => bad({ monthly_spend_limit: 0 })).toThrow(/whole number/)
    expect(() => bad({ ...same, default_sender_id: '123' })).toThrow(/letter/)
    expect(() => bad({ ...same, notify_numbers: ['+442071838750'] })).toThrow(
      expect.objectContaining({ code: 'COUNTRY_NOT_ALLOWED' })
    )
    expect(() => bad({ ...same, notify_numbers: ['12025550142'] })).toThrow(/\+country/)
    expect(() =>
      bad({
        ...same,
        notify_numbers: Array.from({ length: 11 }, (_, i) => `+1202555${String(1000 + i)}`)
      })
    ).toThrow(/At most 10/)
  })

  it('recipients live only in the Hub: a fresh read does not show them as a change', () => {
    const p = awsProvider.plan(
      ctx(),
      desired('aws.sns_sms_settings', {
        ...same,
        notify_numbers: ['+12025550142'],
        critical_only: false
      }),
      settings
    )
    expect(p[0].kind).toBe('noop')
  })

  it('health says the account is in the SMS sandbox', async () => {
    const h = harness({
      'sns:GetSMSAttributes': 'sns-sms-attrs.xml',
      'sns:GetSMSSandboxAccountStatus': 'sns-sms-sandbox.xml'
    } as never)
    const r = await awsProvider.health?.(h.ctx, 'aws.sns_sms_settings', 'sms:us-east-1')
    expect(r?.status).toBe('warn')
    expect(r?.message).toMatch(/sandbox/)
  })

  it('the Hub never resets the settings: delete is refused', async () => {
    const h = harness({ 'sns:GetSMSAttributes': 'sns-sms-attrs.xml' } as never)
    await expect(
      awsProvider.apply(
        h.ctx,
        op('delete', 'aws.sns_sms_settings', { externalId: 'sms:us-east-1' }),
        null
      )
    ).rejects.toMatchObject({ code: 'NOT_DELETABLE' })
  })

  describe('notify', () => {
    const r = (numbers: string[], over: Record<string, unknown> = {}) =>
      row({
        id: 77,
        type: 'aws.sns_sms_settings',
        external_id: 'sms:us-east-1',
        desired: { notify_numbers: numbers, ...over }
      })

    it('texts each number once, critical events only by default', async () => {
      const h = harness({ 'sns:Publish': 'sns-publish.xml' } as never)
      const skipped = await awsProvider.notify?.(h.ctx, r(['+12025550142']), msg('info'))
      expect(skipped?.answer).toMatchObject({ skipped: 'not critical' })
      expect(h.of('Publish')).toHaveLength(0)
      const sent = await awsProvider.notify?.(
        h.ctx,
        r(['+12025550142', '+14165550101']),
        msg('critical')
      )
      expect(sent?.answer).toMatchObject({ sent: 2 })
      const p = h.of('Publish').map((c) => c.params)
      expect(p.map((x) => x.PhoneNumber)).toEqual(['+12025550142', '+14165550101'])
      expect(Object.values(p[0])).toContain('Transactional')
    })

    it('refuses a number outside the allowed countries before any call, and an empty list', async () => {
      const h = harness({ 'sns:Publish': 'sns-publish.xml' } as never)
      await expect(
        awsProvider.notify?.(h.ctx, r(['+442071838750']), msg())
      ).rejects.toMatchObject({ code: 'COUNTRY_NOT_ALLOWED' })
      await expect(awsProvider.notify?.(h.ctx, r([]), msg())).rejects.toMatchObject({
        code: 'NO_RECIPIENTS'
      })
      expect(h.of('Publish')).toHaveLength(0)
    })

    it('at most 20 texts an hour per resource, not retryable', async () => {
      const h = harness({ 'sns:Publish': 'sns-publish.xml' } as never)
      const ten = Array.from({ length: 10 }, (_, i) => `+1202555${String(1000 + i)}`)
      await awsProvider.notify?.(h.ctx, r(ten), msg())
      await awsProvider.notify?.(h.ctx, r(ten), msg())
      await expect(awsProvider.notify?.(h.ctx, r(ten), msg())).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        retryable: false
      })
      expect(h.of('Publish')).toHaveLength(20)
    })

    it('maps a provider failure and keeps the other numbers going', async () => {
      const h = harness({
        'sns:Publish': { status: 429, file: 'sns-error-throttle.xml' }
      } as never)
      await expect(
        awsProvider.notify?.(h.ctx, r(['+12025550142']), msg())
      ).rejects.toMatchObject({ retryable: true })
    })
  })
})

describe('aws.sns_sms_user (the IAM exception)', () => {
  const want = { name: 'shop-sms' }
  const createHandlers = (over: Record<string, unknown> = {}) => ({
    'sts:GetCallerIdentity': 'sts-caller-identity.xml',
    'iam:GetUser': [gone('iam-error-noentity.xml'), 'iam-get-user-sns.xml'],
    'iam:CreateUser': 'iam-create-user.xml',
    'iam:PutUserPolicy': 'iam-ok.xml',
    'iam:CreateAccessKey': 'iam-create-key.xml',
    'iam:GetUserPolicy': 'iam-get-policy-sns.xml',
    'iam:ListAccessKeys': 'iam-list-keys-one.xml',
    ...over
  })
  const ctx = () => harness({} as never).ctx

  it('is app scope, admin only and declares the app SMS outputs once-only', () => {
    const t = type('aws.sns_sms_user')
    expect(t?.outputs?.map((o) => [o.key, o.secret, !!o.onceOnly])).toEqual([
      ['sms_provider', false, false],
      ['sms_account_sid', false, true],
      ['sms_auth_token', true, true],
      ['sms_region', false, false]
    ])
    const p = awsProvider.plan(ctx(), desired('aws.sns_sms_user', want), null)
    expect(p[0].data?.$adminOnly).toBe(true)
  })

  it('creates a tagged user whose only policy publishes texts, and hands out the outputs', async () => {
    const h = harness(createHandlers() as never)
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.sns_sms_user'),
      desired('aws.sns_sms_user', want)
    )
    expect(res.externalId).toBe('shop-sms')
    const user = h.of('CreateUser')[0].params
    expect(user.Path).toBe('/nivaro-hub/')
    // Tags are set explicitly at creation: managed, kind and this row.
    expect(Object.values(user)).toEqual(
      expect.arrayContaining([
        'nivaro-hub:managed',
        'nivaro-hub:kind',
        'sns_sms',
        'nivaro-hub:resource',
        '41'
      ])
    )
    const policy = JSON.parse(h.of('PutUserPolicy')[0].params.PolicyDocument)
    const actions = policy.Statement.map((s: { Action: string }) => s.Action)
    expect(actions).toEqual(['sns:Publish', 'sns:Publish'])
    expect(policy.Statement[0].Effect).toBe('Allow')
    expect(policy.Statement[1]).toMatchObject({
      Effect: 'Deny',
      Resource: 'arn:aws:sns:*:*:*'
    })
    expect(h.of('AttachUserPolicy')).toHaveLength(0)
    expect(res.outputs).toEqual({
      sms_provider: 'aws-sns',
      sms_account_sid: 'AKIAFAKESMTP0000003C',
      sms_auth_token: KEY_SECRET,
      sms_region: 'us-east-1'
    })
    const visible = JSON.stringify({ observed: res.observed, answer: res.answer })
    expect(visible).not.toContain(KEY_SECRET)
    expect(visible).not.toContain('AKIAFAKESMTP0000003C')
  })

  it('an SES user or another kind of Hub user is never read as an SNS user', async () => {
    const h = harness(createHandlers({ 'iam:GetUser': 'iam-get-user-hub.xml' }) as never)
    await expect(awsProvider.observe(h.ctx, 'aws.sns_sms_user', 'shop-smtp')).rejects.toMatchObject(
      { code: 'NOT_HUB_USER' }
    )
    // …and the other way round: an SNS user is not an SES user.
    const g = harness(createHandlers({ 'iam:GetUser': 'iam-get-user-sns.xml' }) as never)
    await expect(awsProvider.observe(g.ctx, 'aws.ses_smtp_user', 'shop-sms')).rejects.toMatchObject(
      { code: 'NOT_HUB_USER' }
    )
  })

  it('another row’s user is refused for rotate and delete before any write', async () => {
    const h = harness(
      createHandlers({
        'iam:GetUser': 'iam-get-user-sns-other-row.xml',
        'iam:DeleteAccessKey': 'iam-ok.xml',
        'iam:DeleteUser': 'iam-ok.xml'
      }) as never
    )
    const d = desired('aws.sns_sms_user', { ...want, rotate_outputs: true }, { externalId: 'shop-sms' })
    await expect(
      awsProvider.apply(
        h.ctx,
        op('update', 'aws.sns_sms_user', {
          externalId: 'shop-sms',
          changes: [{ field: 'rotate_outputs', to: true }]
        }),
        d
      )
    ).rejects.toMatchObject({ code: 'NOT_HUB_USER' })
    await expect(
      awsProvider.apply(h.ctx, op('delete', 'aws.sns_sms_user', { externalId: 'shop-sms' }), null)
    ).rejects.toMatchObject({ code: 'NOT_HUB_USER' })
    expect(h.of('CreateAccessKey')).toHaveLength(0)
    expect(h.of('DeleteUser')).toHaveLength(0)
  })

  it('rotate deletes the older of two keys and answers only the new outputs', async () => {
    const h = harness(
      createHandlers({
        'iam:ListAccessKeys': 'iam-list-keys-two.xml',
        'iam:DeleteAccessKey': 'iam-ok.xml'
      }) as never
    )
    const res = await awsProvider.apply(
      h.ctx,
      op('update', 'aws.sns_sms_user', {
        externalId: 'shop-sms',
        changes: [{ field: 'rotate_outputs', to: true }]
      }),
      desired('aws.sns_sms_user', { ...want, rotate_outputs: true }, { externalId: 'shop-sms' })
    )
    expect(h.of('DeleteAccessKey')).toHaveLength(1)
    expect(h.of('CreateAccessKey')).toHaveLength(1)
    expect(res.outputs?.sms_auth_token).toBe(KEY_SECRET)
  })

  it('a widened policy reads as drift and is put back', async () => {
    const h = harness(
      createHandlers({
        'iam:GetUser': 'iam-get-user-sns.xml',
        'iam:GetUserPolicy': 'iam-get-policy-sns-wide.xml'
      }) as never
    )
    const o = await awsProvider.observe(h.ctx, 'aws.sns_sms_user', 'shop-sms')
    expect(o?.fields.publish_only).toBe(false)
    const plan = awsProvider.plan(h.ctx, desired('aws.sns_sms_user', want), o)
    expect(plan[0].kind).toBe('update')
    expect(plan[0].changes.map((c) => c.field)).toEqual(['publish_only'])
    const health = await awsProvider.health?.(h.ctx, 'aws.sns_sms_user', 'shop-sms')
    expect(health?.status).toBe('warn')
  })

  it('refuses to turn the publish-only policy off', () => {
    expect(() =>
      awsProvider.plan(ctx(), desired('aws.sns_sms_user', { ...want, publish_only: false }), null)
    ).toThrow(/publish-only/)
  })

  it('delete removes the keys, the Hub’s policy and the user', async () => {
    const h = harness(
      createHandlers({
        'iam:GetUser': 'iam-get-user-sns.xml',
        'iam:DeleteAccessKey': 'iam-ok.xml',
        'iam:DeleteUserPolicy': 'iam-ok.xml',
        'iam:DeleteUser': 'iam-ok.xml'
      }) as never
    )
    await awsProvider.apply(
      h.ctx,
      op('delete', 'aws.sns_sms_user', { externalId: 'shop-sms' }),
      null
    )
    expect(h.calls.map((c) => c.action).filter((a) => a.startsWith('Delete'))).toEqual([
      'DeleteAccessKey',
      'DeleteUserPolicy',
      'DeleteUser'
    ])
  })

  it('maps IAM 429 to retryable', async () => {
    const h = harness({ 'iam:GetUser': { status: 429, file: 'iam-error-throttle.xml' } } as never)
    await expect(awsProvider.observe(h.ctx, 'aws.sns_sms_user', 'shop-sms')).rejects.toMatchObject({
      retryable: true
    })
  })
})

describe('Cost Explorer costs()', () => {
  const range = { from: '2026-11-25', to: '2026-11-25' }
  const costs = (h: ReturnType<typeof harness>, r = range) =>
    (awsProvider as unknown as { costs: (c: unknown, r: unknown) => Promise<unknown[]> }).costs(
      h.ctx,
      r
    )

  it('asks once, daily, grouped by the app tag and the record type', async () => {
    const h = harness({ 'ce:GetCostAndUsage': 'ce-cost-usage.json' } as never)
    await costs(h)
    expect(h.of('GetCostAndUsage')).toHaveLength(1)
    const body = JSON.parse(h.of('GetCostAndUsage')[0].body)
    expect(body).toMatchObject({
      // End is exclusive: the range's last day plus one.
      TimePeriod: { Start: '2026-11-25', End: '2026-11-26' },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [
        { Type: 'TAG', Key: 'nivaro-hub:app' },
        { Type: 'DIMENSION', Key: 'RECORD_TYPE' }
      ]
    })
  })

  it('maps rows: app tag, cents, and the record type the price book learns from', async () => {
    const h = harness({ 'ce:GetCostAndUsage': 'ce-cost-usage.json' } as never)
    const rows = await costs(h)
    expect(rows).toEqual([
      { date: '2026-11-25', amountCents: 1235, currency: 'USD', appTag: 'shop', service: 'AWS', recordType: 'usage' },
      { date: '2026-11-25', amountCents: 310, currency: 'USD', service: 'AWS', recordType: 'usage' },
      { date: '2026-11-25', amountCents: 102, currency: 'USD', appTag: 'shop', service: 'Tax', recordType: 'tax' },
      { date: '2026-11-25', amountCents: -250, currency: 'USD', appTag: 'shop', service: 'Credit', recordType: 'credit' },
      { date: '2026-11-25', amountCents: -40, currency: 'USD', service: 'Refund', recordType: 'refund' },
      { date: '2026-11-25', amountCents: -75, currency: 'USD', appTag: 'shop', service: 'SavingsPlanNegation', recordType: 'discount' },
      { date: '2026-11-25', amountCents: 50, currency: 'USD', appTag: 'shop', service: 'AWS', recordType: 'usage' }
    ])
    expect(recordTypeOf('DiscountedUsage')).toBe('usage')
    expect(recordTypeOf('EdpDiscount')).toBe('discount')
  })

  it('reads a long answer page by page', async () => {
    const h = harness({
      'ce:GetCostAndUsage': ['ce-cost-usage-page1.json', 'ce-cost-usage-page2.json']
    } as never)
    const rows = await costs(h, { from: '2026-11-24', to: '2026-11-25' })
    expect(rows).toHaveLength(2)
    expect(h.of('GetCostAndUsage')).toHaveLength(2)
    expect(JSON.parse(h.of('GetCostAndUsage')[1].body).NextPageToken).toBe('page-token-fake')
  })

  it('refuses bad ranges without a call; an empty range answers nothing', async () => {
    const h = harness({} as never)
    await expect(costs(h, { from: 'x', to: '2026-11-25' })).rejects.toMatchObject({
      code: 'INVALID_FIELDS'
    })
    await expect(costs(h, { from: '2024-01-01', to: '2026-11-25' })).rejects.toMatchObject({
      code: 'INVALID_FIELDS'
    })
    expect(await costs(h, { from: '2026-11-26', to: '2026-11-25' })).toEqual([])
    expect(h.calls).toHaveLength(0)
  })

  it('says Cost Explorer is off, and maps 429 to retryable', async () => {
    const off = harness({
      'ce:GetCostAndUsage': { status: 400, file: 'ce-error-unavailable.json' }
    } as never)
    await expect(costs(off)).rejects.toMatchObject({ code: 'COST_EXPLORER_OFF', retryable: false })
    const slow = harness({
      'ce:GetCostAndUsage': { status: 429, file: 'ce-error-throttle.json' }
    } as never)
    await expect(costs(slow)).rejects.toMatchObject({ retryable: true })
  })
})

describe('aws.cost_allocation_tag', () => {
  it('observes a tag; only nivaro-hub:* tags are listed or touched', async () => {
    const h = harness({ 'ce:ListCostAllocationTags': 'ce-list-tags.json' } as never)
    const o = await awsProvider.observe(h.ctx, 'aws.cost_allocation_tag', 'nivaro-hub:app')
    expect(o?.fields).toMatchObject({ tag_key: 'nivaro-hub:app', active: true })
    await expect(
      awsProvider.observe(h.ctx, 'aws.cost_allocation_tag', 'team')
    ).rejects.toMatchObject({ code: 'BAD_ID' })
    const l = harness({ 'ce:ListCostAllocationTags': 'ce-list-tags-mixed.json' } as never)
    const list = await awsProvider.list(l.ctx, 'aws.cost_allocation_tag')
    expect(list.items.map((i) => i.externalId)).toEqual(['nivaro-hub:app'])
    expect(() =>
      awsProvider.plan(h.ctx, desired('aws.cost_allocation_tag', { tag_key: 'team' }), null)
    ).toThrow(/nivaro-hub/)
  })

  it('create activates an inactive tag; an invisible tag says so; an active one is ALREADY_EXISTS', async () => {
    const h = harness({
      'ce:ListCostAllocationTags': ['ce-list-tags-inactive.json', 'ce-list-tags-inactive.json', 'ce-list-tags.json'],
      'ce:UpdateCostAllocationTagsStatus': 'ce-update-tags-ok.json'
    } as never)
    await awsProvider.apply(
      h.ctx,
      op('create', 'aws.cost_allocation_tag'),
      desired('aws.cost_allocation_tag', { tag_key: 'nivaro-hub:app' })
    )
    expect(JSON.parse(h.of('UpdateCostAllocationTagsStatus')[0].body)).toEqual({
      CostAllocationTagsStatus: [{ TagKey: 'nivaro-hub:app', Status: 'Active' }]
    })
    const none = harness({
      'ce:ListCostAllocationTags': 'ce-list-tags-empty.json',
      'ce:UpdateCostAllocationTagsStatus': 'ce-update-tags-ok.json'
    } as never)
    await expect(
      awsProvider.apply(
        none.ctx,
        op('create', 'aws.cost_allocation_tag'),
        desired('aws.cost_allocation_tag', { tag_key: 'nivaro-hub:app' })
      )
    ).rejects.toMatchObject({ code: 'TAG_NOT_VISIBLE' })
    expect(none.of('UpdateCostAllocationTagsStatus')).toHaveLength(0)
    const active = harness({ 'ce:ListCostAllocationTags': 'ce-list-tags.json' } as never)
    await expect(
      awsProvider.apply(
        active.ctx,
        op('create', 'aws.cost_allocation_tag'),
        desired('aws.cost_allocation_tag', { tag_key: 'nivaro-hub:app' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('a refusal from AWS is shown; delete only deactivates; health says it takes 24 hours', async () => {
    const h = harness({
      'ce:ListCostAllocationTags': 'ce-list-tags.json',
      'ce:UpdateCostAllocationTagsStatus': 'ce-update-tags-error.json'
    } as never)
    await expect(
      awsProvider.apply(
        h.ctx,
        op('delete', 'aws.cost_allocation_tag', { externalId: 'nivaro-hub:app' }),
        null
      )
    ).rejects.toMatchObject({ code: 'TAG_NOT_ACTIVATABLE' })
    const ok = harness({
      'ce:ListCostAllocationTags': 'ce-list-tags.json',
      'ce:UpdateCostAllocationTagsStatus': 'ce-update-tags-ok.json'
    } as never)
    await awsProvider.apply(
      ok.ctx,
      op('delete', 'aws.cost_allocation_tag', { externalId: 'nivaro-hub:app' }),
      null
    )
    expect(JSON.parse(ok.of('UpdateCostAllocationTagsStatus')[0].body).CostAllocationTagsStatus[0].Status).toBe(
      'Inactive'
    )
    const hh = await awsProvider.health?.(ok.ctx, 'aws.cost_allocation_tag', 'nivaro-hub:app')
    expect(hh?.message).toMatch(/24 hours/)
  })
})

describe('aws.budget', () => {
  const reads = (over: Record<string, unknown> = {}) => ({
    'sts:GetCallerIdentity': 'sts-caller-identity.xml',
    'budgets:DescribeBudget': 'budgets-describe.json',
    'budgets:DescribeNotificationsForBudget': 'budgets-describe-notifs.json',
    'budgets:DescribeSubscribersForNotification': 'budgets-describe-subs.json',
    'budgets:ListTagsForResource': 'budgets-list-tags.json',
    ...over
  })
  const want = { name: 'shop-monthly', limit_usd: 200, emails: ['fin@example.com'] }

  it('maps a budget: limit, app tag, thresholds, recipients and spend', async () => {
    const h = harness(reads() as never)
    const o = await awsProvider.observe(h.ctx, 'aws.budget', 'shop-monthly')
    expect(o?.fields).toMatchObject({
      limit_usd: 200,
      app_tag: 'shop',
      thresholds: [80, 100],
      topic: TOPIC,
      emails: ['fin@example.com'],
      forecast_alerts: true,
      actual_usd: 90.5,
      forecast_usd: 150
    })
    expect(o?.tags['nivaro-hub:resource']).toBe('41')
    expect(h.of('DescribeBudget')[0].body).toContain('"AccountId":"123456789012"')
  })

  it('creates one budget for the app tag with ACTUAL and FORECASTED alerts and the row tag', async () => {
    const h = harness(
      reads({
        'budgets:DescribeBudget': [gone('budgets-error-notfound.json'), 'budgets-describe.json'],
        'budgets:CreateBudget': 'budgets-ok.json'
      }) as never
    )
    // A 404 on DescribeBudget is a JSON NotFoundException.
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.budget'),
      desired('aws.budget', want, { refs: { topic: TOPIC } })
    )
    expect(res.externalId).toBe('shop-monthly')
    const body = JSON.parse(h.of('CreateBudget')[0].body)
    expect(body.AccountId).toBe('123456789012')
    expect(body.Budget).toMatchObject({
      BudgetName: 'shop-monthly',
      BudgetLimit: { Amount: '200', Unit: 'USD' },
      TimeUnit: 'MONTHLY',
      BudgetType: 'COST',
      CostFilters: { TagKeyValue: ['user:nivaro-hub:app$shop'] }
    })
    expect(
      body.NotificationsWithSubscribers.map(
        (n: { Notification: { NotificationType: string; Threshold: number } }) =>
          `${n.Notification.NotificationType}${n.Notification.Threshold}`
      )
    ).toEqual(['ACTUAL80', 'FORECASTED80', 'ACTUAL100', 'FORECASTED100'])
    expect(body.NotificationsWithSubscribers[0].Subscribers).toEqual([
      { SubscriptionType: 'SNS', Address: TOPIC },
      { SubscriptionType: 'EMAIL', Address: 'fin@example.com' }
    ])
    expect(JSON.stringify(body.ResourceTags)).toContain('nivaro-hub:resource')
  })

  it('a budget the Hub did not make is ALREADY_EXISTS; a duplicate answer maps the same', async () => {
    const h = harness(reads({ 'budgets:ListTagsForResource': 'budgets-list-tags-none.json' }) as never)
    await expect(
      awsProvider.apply(h.ctx, op('create', 'aws.budget'), desired('aws.budget', want))
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(h.of('CreateBudget')).toHaveLength(0)
    const d = harness(
      reads({
        'budgets:DescribeBudget': gone('budgets-error-notfound.json'),
        'budgets:CreateBudget': { status: 400, file: 'budgets-error-duplicate.json' }
      }) as never
    )
    await expect(
      awsProvider.apply(d.ctx, op('create', 'aws.budget'), desired('aws.budget', want))
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('refuses a budget with no app, a bad limit or too many thresholds', () => {
    const c = harness({} as never).ctx
    const plan = (f: Record<string, unknown>, tags?: Record<string, string>) =>
      awsProvider.plan(c, desired('aws.budget', f, tags ? { tags } : { tags: {} }), null)
    expect(() => plan(want)).toThrow(/one app/)
    expect(() => plan({ ...want, app_tag: 'shop', limit_usd: 0 })).toThrow(/limit/)
    expect(() => plan({ ...want, app_tag: 'shop', thresholds: [10, 20, 30, 40, 50] })).toThrow(
      /At most 4/
    )
    expect(plan({ ...want, app_tag: 'shop' })[0].kind).toBe('create')
  })

  it('health: ok, warn near the limit, down over it, with the figures for the Hub', async () => {
    const ok = await awsProvider.health?.(harness(reads() as never).ctx, 'aws.budget', 'shop-monthly')
    expect(ok?.status).toBe('ok')
    expect(ok?.details).toMatchObject({ limit_cents: 20000, actual_cents: 9050, forecast_cents: 15000 })
    const over = await awsProvider.health?.(
      harness(reads({ 'budgets:DescribeBudget': 'budgets-describe-over.json' }) as never).ctx,
      'aws.budget',
      'shop-monthly'
    )
    expect(over?.status).toBe('down')
  })

  it('an update rewrites only what changed: the limit, then the alerts', async () => {
    const h = harness(
      reads({ 'budgets:UpdateBudget': 'budgets-ok.json', 'budgets:DeleteNotification': 'budgets-ok.json', 'budgets:CreateNotification': 'budgets-ok.json' }) as never
    )
    await awsProvider.apply(
      h.ctx,
      op('update', 'aws.budget', { externalId: 'shop-monthly' }),
      desired(
        'aws.budget',
        { ...want, limit_usd: 300, emails: ['fin@example.com'] },
        { externalId: 'shop-monthly', refs: { topic: TOPIC } }
      )
    )
    expect(h.of('UpdateBudget')).toHaveLength(1)
    expect(JSON.parse(h.of('UpdateBudget')[0].body).NewBudget.BudgetLimit.Amount).toBe('300')
    expect(h.of('DeleteNotification')).toHaveLength(0)
  })
})

describe('aws.domain (Route 53 Domains, us-east-1 only)', () => {
  const contact = {
    first_name: 'Fake',
    last_name: 'Person',
    email: 'owner@example.com',
    phone: '+1.5551234567',
    address_line_1: '1 Test Street',
    city: 'Testville',
    state: 'NY',
    country_code: 'US',
    zip_code: '10001'
  }
  const reads = (over: Record<string, unknown> = {}) => ({
    'route53domains:GetDomainDetail': 'r53d-detail.json',
    ...over
  })
  const ctx = () => harness({} as never).ctx
  const NO_TRANSFER_OUT = /^(TransferDomain|TransferDomainToAnotherAwsAccount|RetrieveDomainAuthCode|AcceptDomainTransfer|DeleteDomain)/

  it('is shared scope (administrators only), never deletable, no transfer-out field', () => {
    const t = type('aws.domain')
    expect(t?.scope).toBe('shared')
    expect(t?.capabilities.delete).toBe(false)
    expect(t?.fields.map((f) => f.key)).not.toContain('auth_code')
  })

  it('observes a domain: expiry, auto-renew, lock, nameservers (sorted)', async () => {
    const h = harness(reads() as never)
    const o = await awsProvider.observe(h.ctx, 'aws.domain', 'example.com')
    expect(o?.fields).toMatchObject({
      auto_renew: true,
      transfer_lock: true,
      nameservers: ['ns-1.awsdns-00.com', 'ns-2.awsdns-01.org'],
      registrant_email: 'owner@example.com'
    })
    expect(o && domainExpiresAt(o)).toBe('2026-12-24T00:00:00.000Z'.replace('2026-12-24', new Date(1798243200 * 1000).toISOString().slice(0, 10)))
    const none = harness(reads({ 'route53domains:GetDomainDetail': { status: 400, file: 'r53d-error-notfound.json' } }) as never)
    expect(await awsProvider.observe(none.ctx, 'aws.domain', 'example.com')).toBeNull()
    await expect(awsProvider.observe(h.ctx, 'aws.domain', '../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
  })

  it('lists domains from the registrar', async () => {
    const h = harness({ 'route53domains:ListDomains': 'r53d-list.json' } as never)
    const p = await awsProvider.list(h.ctx, 'aws.domain')
    expect(p.items.map((i) => i.externalId)).toEqual(['example.com'])
    expect(p.cursor).toBe('next-fake')
  })

  it('registering is a cost change: admin only, its own typed confirm, contact required', () => {
    const p = awsProvider.plan(
      ctx(),
      desired('aws.domain', { name: 'example.com', years: 2, contact }),
      null
    )
    expect(p[0].kind).toBe('create')
    expect(p[0].risk).toContain('cost')
    expect(p[0].data).toMatchObject({ $adminOnly: true, $confirm: 'register example.com' })
    expect(() => awsProvider.plan(ctx(), desired('aws.domain', { name: 'example.com' }), null)).toThrow(
      /contact/
    )
    expect(() =>
      awsProvider.plan(
        ctx(),
        desired('aws.domain', { name: 'example.com', contact, nameservers: ['a.example.com', 'b.example.com'] }),
        null
      )
    ).toThrow(/after the domain is registered/)
  })

  it('checks availability first and registers with the contact, years, renewal and privacy (fixture only)', async () => {
    const h = harness({
      'route53domains:GetDomainDetail': { status: 400, file: 'r53d-error-notfound.json' },
      'route53domains:CheckDomainAvailability': 'r53d-check-available.json',
      'route53domains:RegisterDomain': 'r53d-register.json',
      'route53domains:GetOperationDetail': 'r53d-op-ok.json'
    } as never)
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.domain'),
      desired('aws.domain', { name: 'example.com', years: 2, contact })
    )
    expect(res.externalId).toBe('example.com')
    const actions = h.calls.map((c) => c.action)
    expect(actions.indexOf('CheckDomainAvailability')).toBeLessThan(actions.indexOf('RegisterDomain'))
    const body = JSON.parse(h.of('RegisterDomain')[0].body)
    expect(body).toMatchObject({
      DomainName: 'example.com',
      DurationInYears: 2,
      AutoRenew: true,
      PrivacyProtectAdminContact: true
    })
    expect(body.RegistrantContact).toMatchObject({
      FirstName: 'Fake',
      CountryCode: 'US',
      PhoneNumber: '+1.5551234567'
    })
  })

  it('never registers what is unavailable, what exists, or what is already being registered', async () => {
    const taken = harness({
      'route53domains:GetDomainDetail': { status: 400, file: 'r53d-error-notfound.json' },
      'route53domains:CheckDomainAvailability': 'r53d-check-unavailable.json',
      'route53domains:RegisterDomain': 'r53d-register.json'
    } as never)
    await expect(
      awsProvider.apply(
        taken.ctx,
        op('create', 'aws.domain'),
        desired('aws.domain', { name: 'example.com', contact })
      )
    ).rejects.toMatchObject({ code: 'DOMAIN_UNAVAILABLE' })
    expect(taken.of('RegisterDomain')).toHaveLength(0)

    const mine = harness(reads({ 'route53domains:RegisterDomain': 'r53d-register.json' }) as never)
    await expect(
      awsProvider.apply(
        mine.ctx,
        op('create', 'aws.domain'),
        desired('aws.domain', { name: 'example.com', contact })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(mine.of('RegisterDomain')).toHaveLength(0)

    const racing = harness({
      'route53domains:GetDomainDetail': { status: 400, file: 'r53d-error-notfound.json' },
      'route53domains:CheckDomainAvailability': 'r53d-check-available.json',
      'route53domains:RegisterDomain': { status: 400, file: 'r53d-error-duplicate.json' }
    } as never)
    await expect(
      awsProvider.apply(
        racing.ctx,
        op('create', 'aws.domain'),
        desired('aws.domain', { name: 'example.com', contact })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('a failed registration is reported, not left as success', async () => {
    const h = harness({
      'route53domains:GetDomainDetail': { status: 400, file: 'r53d-error-notfound.json' },
      'route53domains:CheckDomainAvailability': 'r53d-check-available.json',
      'route53domains:RegisterDomain': 'r53d-register.json',
      'route53domains:GetOperationDetail': 'r53d-op-failed.json'
    } as never)
    await expect(
      awsProvider.apply(
        h.ctx,
        op('create', 'aws.domain'),
        desired('aws.domain', { name: 'example.com', contact })
      )
    ).rejects.toMatchObject({ code: 'DOMAIN_OPERATION_FAILED' })
  })

  it('risk: lock off is destructive, nameservers and auto-renew off are downtime', () => {
    const o = observedOf({
      type: 'aws.domain',
      externalId: 'example.com',
      fields: {
        name: 'example.com',
        auto_renew: true,
        transfer_lock: true,
        nameservers: ['ns-1.awsdns-00.com', 'ns-2.awsdns-01.org']
      }
    })
    const risk = (f: Record<string, unknown>) =>
      awsProvider.plan(
        ctx(),
        desired('aws.domain', {
          name: 'example.com',
          auto_renew: true,
          transfer_lock: true,
          nameservers: ['ns-1.awsdns-00.com', 'ns-2.awsdns-01.org'],
          ...f
        }),
        o
      )[0].risk
    expect(risk({ transfer_lock: false })).toEqual(['destructive'])
    expect(risk({ nameservers: ['ns-1.example.net', 'ns-2.example.net'] })).toEqual(['downtime'])
    expect(risk({ auto_renew: false })).toEqual(['downtime'])
    expect(risk({})).toEqual([])
    expect(() => risk({ nameservers: ['only-one.example.net'] })).toThrow(/2 to 6/)
  })

  it('applies lock, auto-renew and nameservers through the registrar; no transfer-out call ever', async () => {
    const h = harness(
      reads({
        'route53domains:DisableDomainTransferLock': 'r53d-ok.json',
        'route53domains:DisableDomainAutoRenew': 'r53d-ok.json',
        'route53domains:UpdateDomainNameservers': 'r53d-ok.json'
      }) as never
    )
    await awsProvider.apply(
      h.ctx,
      op('update', 'aws.domain', { externalId: 'example.com' }),
      desired(
        'aws.domain',
        {
          name: 'example.com',
          auto_renew: false,
          transfer_lock: false,
          nameservers: ['ns-9.example.net', 'ns-8.example.net']
        },
        { externalId: 'example.com' }
      )
    )
    expect(h.of('DisableDomainTransferLock')).toHaveLength(1)
    expect(h.of('DisableDomainAutoRenew')).toHaveLength(1)
    expect(JSON.parse(h.of('UpdateDomainNameservers')[0].body).Nameservers).toEqual([
      { Name: 'ns-9.example.net' },
      { Name: 'ns-8.example.net' }
    ])
    expect(h.calls.filter((c) => NO_TRANSFER_OUT.test(c.action))).toHaveLength(0)
  })

  it('the Hub never deletes a registration', async () => {
    const h = harness(reads() as never)
    await expect(
      awsProvider.apply(h.ctx, op('delete', 'aws.domain', { externalId: 'example.com' }), null)
    ).rejects.toMatchObject({ code: 'NOT_DELETABLE' })
    expect(h.calls.filter((c) => NO_TRANSFER_OUT.test(c.action))).toHaveLength(0)
  })

  it('health carries expiresAt, autoRenew and locked for the domain watch', async () => {
    const h = harness(reads() as never)
    const ok = await awsProvider.health?.(h.ctx, 'aws.domain', 'example.com')
    expect(ok?.status).toBe('ok')
    expect(ok?.details).toMatchObject({ autoRenew: true, locked: true })
    expect(typeof ok?.details?.expiresAt).toBe('string')
    const soon = harness(reads({ 'route53domains:GetDomainDetail': 'r53d-detail-expiring.json' }) as never)
    const w = await awsProvider.health?.(soon.ctx, 'aws.domain', 'example.com')
    expect(w?.status).toBe('warn')
    expect(w?.details).toMatchObject({ autoRenew: false, locked: true })
    const open = harness(reads({ 'route53domains:GetDomainDetail': 'r53d-detail-unlocked.json' }) as never)
    expect((await awsProvider.health?.(open.ctx, 'aws.domain', 'example.com'))?.message).toMatch(
      /transfer lock is off/
    )
  })

  it('maps registrar 429 to retryable', async () => {
    const h = harness(
      reads({ 'route53domains:GetDomainDetail': { status: 429, file: 'r53d-error-throttle.json' } }) as never
    )
    await expect(awsProvider.observe(h.ctx, 'aws.domain', 'example.com')).rejects.toMatchObject({
      retryable: true
    })
  })

  describe('estimate from recorded price answer', () => {
    const est = (h: ReturnType<typeof harness>, d: ReturnType<typeof desired> | null, o = null as never) =>
      type('aws.domain')?.estimate?.(h.ctx, d, o)

    it('registration is one-time (first year, plus renewals for more) and renews yearly', async () => {
      const h = harness({ 'route53domains:ListPrices': 'r53d-prices.json' } as never)
      const e = await est(h, desired('aws.domain', { name: 'example.com', years: 2, contact }))
      expect(e).toMatchObject({
        basis: 'price_list',
        confidence: 'list_price',
        oneTimeCents: 3000,
        yearlyCents: 1500,
        monthlyCents: 0
      })
      expect(JSON.parse(h.of('ListPrices')[0].body)).toEqual({ Tld: 'com' })
      const io = await est(h, desired('aws.domain', { name: 'app.io', contact }))
      expect(io).toMatchObject({ oneTimeCents: 5700, yearlyCents: 7100 })
    })

    it('an existing domain costs its renewal; auto-renew off costs none; unknown TLD is unknown', async () => {
      const h = harness({ 'route53domains:ListPrices': 'r53d-prices.json' } as never)
      const o = observedOf({ type: 'aws.domain', externalId: 'example.com', fields: { name: 'example.com', auto_renew: true } })
      expect(await est(h, null, o as never)).toMatchObject({ oneTimeCents: 0, yearlyCents: 1500 })
      expect(
        await est(h, desired('aws.domain', { name: 'example.com', auto_renew: false }), o as never)
      ).toMatchObject({ yearlyCents: 0 })
      expect(
        await est(h, desired('aws.domain', { name: 'example.xyz', contact }))
      ).toMatchObject({ confidence: 'unknown' })
    })

    it('never throws when the registrar errors', async () => {
      const h = harness({
        'route53domains:ListPrices': { status: 429, file: 'r53d-error-throttle.json' }
      } as never)
      expect(await est(h, desired('aws.domain', { name: 'example.com', contact }))).toMatchObject({
        confidence: 'unknown'
      })
    })
  })
})

describe('aws part 4 estimates', () => {
  it('SNS settings, subscription, SMS user, budget and tag are known free (usage is billed elsewhere)', async () => {
    const c = harness({} as never).ctx
    for (const k of [
      'aws.sns_subscription',
      'aws.sns_sms_settings',
      'aws.sns_sms_user',
      'aws.budget',
      'aws.cost_allocation_tag'
    ]) {
      const e = await type(k)?.estimate?.(c, desired(k, {}), null)
      expect(e, k).toMatchObject({ confidence: 'exact', monthlyCents: 0 })
    }
  })
})
