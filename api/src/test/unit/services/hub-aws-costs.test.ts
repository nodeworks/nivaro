import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 44b: AWS cost estimates against recorded Price List answers (the PriceList
// array holds JSON strings, as AWS sends them), the CloudWatch reader and its hourly batching, and
// the connection test rows for the two new permissions. Nothing reaches real AWS.

// The price book's cache is a table; here every lookup is a miss and nothing is written.
vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const rows = vi.hoisted(() => ({ resources: [] as any[], connection: null as any }))
vi.mock('../../../services/hub/providers/store.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/providers/store.js')>()),
  listResources: vi.fn(async () => rows.resources),
  readConnection: vi.fn(async () => rows.connection),
  openConnectionSecrets: vi.fn(async () => ({ secret_access_key: 'test-secret-access-key-0001' }))
}))

const { awsProvider } = await import('../../../services/hub/providers/aws/adapter.js')
const { awsConnection } = await import('../../../services/hub/providers/aws/client.js')
const P = await import('../../../services/hub/providers/aws/pricing.js')
const CW = await import('../../../services/hub/providers/aws/cloudwatch.js')
const egress = await import('../../../services/hub/providers/aws/egress.js')
const iam = await import('../../../services/hub/providers/aws/iam-policy.js')
const { parseAwsPriceItem } = await import(
  '../../../services/hub/providers/pricing/aws-price-list.js'
)
const { applyRates } = await import('../../../services/hub/providers/pricing/index.js')
const registry = await import('../../../services/hub/providers/registry.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const { CORE_PROVIDERS } = await import('../../../services/hub/providers/index.js')
const H = await import('./hub-aws-harness.js')

import type { CostEstimate } from '../../../services/hub/providers/types.js'

// The price book reads the registered adapter's bundled table.
registry.resetProvidersForTest()
registry.registerProvider(awsProvider)

const sumLines = (e: CostEstimate) => e.lines.reduce((n, l) => n + l.monthlyCents, 0)

/** AWS Price List answers by the filters of the request (recorded shapes in __fixtures__). */
function priceAnswers(over: Record<string, any> = {}) {
  return (call: { body: string }): any => {
    const body = JSON.parse(call.body)
    const f: Record<string, string> = {}
    for (const x of body.Filters ?? []) f[x.Field] = x.Value
    const code = body.ServiceCode as string
    const place = f.regionCode ?? f.fromRegionCode
    if (place && place !== 'us-east-1') return 'pricing-empty.json'
    const key = `${code}|${f.productFamily ?? ''}|${f.instanceType ?? f.volumeApiName ?? f.databaseEngine ?? f.transferType ?? ''}`
    if (key in over) return over[key]
    if (code === 'AmazonEC2') {
      if (f.productFamily === 'Compute Instance')
        return f.instanceType === 'm5.large'
          ? 'pricing-ec2-m5-large.json'
          : 'pricing-ec2-t3-micro.json'
      if (f.productFamily === 'Storage') return 'pricing-ebs-gp3-storage.json'
      if (f.productFamily === 'System Operation')
        return f.volumeApiName === 'io2' ? 'pricing-ebs-io2-iops.json' : 'pricing-ebs-gp3-iops.json'
      if (f.productFamily === 'Provisioned Throughput') return 'pricing-ebs-gp3-throughput.json'
      if (f.productFamily === 'NAT Gateway')
        return /Hourly/.test(f.groupDescription) ? 'pricing-nat-hours.json' : 'pricing-nat-gb.json'
    }
    if (code === 'AmazonVPC') return 'pricing-eip.json'
    if (code === 'AmazonRDS')
      return f.productFamily === 'Database Storage'
        ? 'pricing-rds-pg-storage-gp3.json'
        : f.deploymentOption === 'Multi-AZ'
          ? 'pricing-rds-pg-t3-micro-multi.json'
          : 'pricing-rds-pg-t3-micro.json'
    if (code === 'AWSELB')
      return /Network/.test(f.productFamily)
        ? 'pricing-lb-network.json'
        : 'pricing-lb-application.json'
    if (code === 'AmazonS3') return 'pricing-s3-standard.json'
    if (code === 'AmazonRoute53') return 'pricing-route53-zone.json'
    if (code === 'AWSDataTransfer')
      return f.transferType === 'IntraRegion'
        ? 'pricing-cross-az.json'
        : 'pricing-transfer-out.json'
    return 'pricing-empty.json'
  }
}

const NO_CW = { status: 403, file: 'cloudwatch-error-denied.xml' }

const h = (extra: Record<string, any> = {}, over: Parameters<typeof H.harness>[1] = {}) =>
  H.harness(
    { 'pricing:GetProducts': priceAnswers(), 'monitoring:GetMetricData': NO_CW, ...extra },
    over
  )

const want = (type: string, fields: Record<string, unknown>) => H.desired(type, fields)
const seen = (type: string, fields: Record<string, unknown>, status?: string) =>
  H.observedOf({
    type,
    externalId: 'x-1',
    fields: { region: 'us-east-1', ...fields },
    ...(status ? { status } : {})
  })

describe('estimate from recorded price list answer', () => {
  it('parses the first tier, the unit and the publication date of a real-shaped item', async () => {
    const raw = JSON.parse(H.fixture('pricing-ec2-t3-micro.json')).PriceList[0]
    expect(typeof raw).toBe('string')
    expect(parseAwsPriceItem(raw)).toEqual({
      unitCents: 1.04,
      unit: 'Hrs',
      currency: 'USD',
      asOf: '2026-11-20'
    })
    // A tier index picks the nth price dimension by start range (data transfer out).
    const out = JSON.parse(H.fixture('pricing-transfer-out.json')).PriceList[0]
    expect(parseAwsPriceItem(out, 0)?.unitCents).toBe(0)
    expect(parseAwsPriceItem(out, 1)?.unitCents).toBe(9)
    expect(parseAwsPriceItem(out, 4)?.unitCents).toBe(5)
    expect(parseAwsPriceItem(out, 5)).toBeNull()
  })

  it('ec2: 730 hours at the listed price, lines sum to the monthly figure, dated', async () => {
    const e = await P.ec2Estimate(
      h().ctx,
      want('aws.ec2_instance', { instance_type: 't3.micro' }),
      null
    )
    expect(e).toMatchObject({
      basis: 'price_list',
      confidence: 'list_price',
      monthlyCents: 759,
      priceAsOf: '2026-11-20'
    })
    expect(e.lines).toHaveLength(1)
    expect(sumLines(e)).toBe(e.monthlyCents)
    expect(e.note).toContain('none is assumed')
  })

  it('ec2: a delete answers what the observed instance costs now; a stopped one costs no compute', async () => {
    const running = await P.ec2Estimate(
      h().ctx,
      null,
      seen('aws.ec2_instance', { instance_type: 'm5.large' }, 'running')
    )
    expect(running.monthlyCents).toBe(Math.round(730 * 9.6))
    const stopped = await P.ec2Estimate(
      h().ctx,
      null,
      seen('aws.ec2_instance', { instance_type: 'm5.large' }, 'stopped')
    )
    expect(stopped.monthlyCents).toBe(0)
    expect(stopped.confidence).not.toBe('unknown')
    expect(stopped.note).toContain('Stopped')
  })

  it('ebs: storage plus gp3 IOPS and throughput above the free baseline', async () => {
    const e = await P.ebsEstimate(
      h().ctx,
      want('aws.ebs_volume', { size_gb: 100, volume_type: 'gp3', iops: 4000, throughput: 250 }),
      null
    )
    // 100 GB × 8 + 1000 IOPS × 0.5 + 125 MiB/s × 4 (the GiBps price is divided by 1024).
    expect(e.monthlyCents).toBe(800 + 500 + 500)
    expect(e.lines.map((l) => l.unit)).toEqual(['GB-month', 'IOPS-month', 'MiB/s-month'])
    expect(sumLines(e)).toBe(e.monthlyCents)
    const plain = await P.ebsEstimate(
      h().ctx,
      want('aws.ebs_volume', { size_gb: 100, volume_type: 'gp3' }),
      null
    )
    expect(plain.monthlyCents).toBe(800)
  })

  it('nat: the hours are the base line; data processed is a transfer line from the traffic', async () => {
    const base = await P.natEstimate(h().ctx, want('aws.nat_gateway', {}), null)
    expect(base.monthlyCents).toBe(Math.round(730 * 4.5))
    expect(base.confidence).toBe('usage_varies')
    expect(base.note).toContain('Plus data processed')
    const ctx = h().ctx
    ctx.traffic = { egressGbMonth: 100, source: 'measured' }
    const e = await P.natEstimate(ctx, want('aws.nat_gateway', {}), null)
    expect(e.lines.map((l) => [l.kind, l.source])).toEqual([
      ['base', 'price_list'],
      ['transfer', 'measured']
    ])
    expect(e.monthlyCents).toBe(3285 + 450)
  })

  it('elastic ip: 730 hours of the public IPv4 price', async () => {
    const e = await P.eipEstimate(h().ctx, want('aws.elastic_ip', {}), null)
    expect(e.monthlyCents).toBe(365)
  })

  it('rds: instance hours and storage; multi-az uses the multi-az hourly price', async () => {
    const single = await P.rdsEstimate(
      h().ctx,
      want('aws.rds_instance', {
        engine: 'postgres',
        instance_class: 'db.t3.micro',
        allocated_storage_gb: 20,
        storage_type: 'gp3'
      }),
      null
    )
    expect(single.monthlyCents).toBe(Math.round(730 * 1.7) + 230)
    const multi = await P.rdsEstimate(
      h().ctx,
      want('aws.rds_instance', {
        engine: 'postgres',
        instance_class: 'db.t3.micro',
        allocated_storage_gb: 20,
        multi_az: true
      }),
      null
    )
    expect(multi.monthlyCents).toBe(Math.round(730 * 3.4) + 230)
    const oracle = await P.rdsEstimate(
      h().ctx,
      want('aws.rds_instance', { engine: 'oracle-ee', instance_class: 'db.m5.large' }),
      null
    )
    expect(oracle.confidence).toBe('unknown')
  })

  it('load balancer: hourly price; a network one adds cross-zone data in both directions', async () => {
    const alb = await P.lbEstimate(
      h().ctx,
      want('aws.load_balancer', { type: 'application' }),
      null
    )
    expect(alb.monthlyCents).toBe(Math.round(730 * 2.25))
    expect(alb.note).toContain('LCU')
    const ctx = h().ctx
    ctx.traffic = { egressGbMonth: 50, source: 'form' }
    const nlb = await P.lbEstimate(ctx, want('aws.load_balancer', { type: 'network' }), null)
    expect(nlb.lines.at(-1)).toMatchObject({ kind: 'transfer', source: 'assumed', unitCents: 2 })
    expect(nlb.monthlyCents).toBe(Math.round(730 * 2.25) + 100)
  })

  it('s3: storage from the CloudWatch bucket size; none readable counts nothing and says so', async () => {
    const withSize = await P.s3Estimate(
      h({ 'monitoring:GetMetricData': 'cloudwatch-bucket-size.xml' }).ctx,
      null,
      seen('aws.s3_bucket', { name: 'shop-assets' })
    )
    expect(withSize.lines).toHaveLength(1)
    expect(withSize.lines[0]).toMatchObject({ qty: 100, unit: 'GB-month', source: 'measured' })
    expect(withSize.monthlyCents).toBe(230)
    expect(withSize.basis).toBe('usage')
    const noSize = await P.s3Estimate(h().ctx, null, seen('aws.s3_bucket', { name: 'shop-assets' }))
    expect(noSize.monthlyCents).toBe(0)
    expect(noSize.confidence).toBe('usage_varies')
    expect(noSize.note).toContain('Nothing is counted')
    // A bucket that does not exist yet never calls CloudWatch.
    const probe = h()
    await P.s3Estimate(probe.ctx, want('aws.s3_bucket', { name: 'new-bucket' }), null)
    expect(probe.of('GetMetricData')).toHaveLength(0)
  })

  it('route 53 zone: the per-zone price; acm: free', async () => {
    const z = await P.route53Estimate(h().ctx, null, seen('aws.route53_zone', {}))
    expect(z.monthlyCents).toBe(50)
    expect(z.note).toContain('DNS queries')
    const acm = await P.acmEstimate()
    expect(acm).toMatchObject({ basis: 'free', monthlyCents: 0, confidence: 'exact' })
  })

  it('every costed aws type now carries an estimate', () => {
    const aws = CORE_PROVIDERS.find((p) => p.key === 'aws')
    const keys = (aws?.types ?? [])
      .filter((t) => typeof t.estimate === 'function')
      .map((t) => t.key)
    expect(keys.sort()).toEqual(
      [
        'aws.acm_certificate',
        'aws.ebs_volume',
        'aws.ec2_instance',
        'aws.elastic_ip',
        'aws.load_balancer',
        'aws.nat_gateway',
        'aws.rds_instance',
        'aws.route53_zone',
        'aws.s3_bucket'
      ].sort()
    )
  })
})

describe('data transfer prices', () => {
  it('internet out: the first 100 GB free, then each paid tier from the price list', async () => {
    const ctx = h().ctx
    const a = await P.internetOutLines(ctx, 'us-east-1', { egressGbMonth: 150, source: 'form' })
    expect(a?.lines.map((l) => [l.qty, l.unitCents, l.monthlyCents, l.source])).toEqual([
      [50, 9, 450, 'assumed']
    ])
    const b = await P.internetOutLines(ctx, 'us-east-1', {
      egressGbMonth: 20_000,
      source: 'measured'
    })
    expect(b?.lines.map((l) => [l.qty, l.unitCents])).toEqual([
      [10_140, 9],
      [9_760, 8.5]
    ])
    expect(b?.lines.every((l) => l.kind === 'transfer' && l.source === 'measured')).toBe(true)
    expect(await P.internetOutLines(ctx, 'us-east-1', undefined)).toEqual({
      lines: [],
      asOf: null,
      bundled: null
    })
  })

  it('cross-az: the listed price twice, one line', async () => {
    const a = await P.crossAzLines(h().ctx, 'us-east-1', { egressGbMonth: 40, source: 'form' })
    expect(a?.lines).toHaveLength(1)
    expect(a?.lines[0]).toMatchObject({ unitCents: 2, monthlyCents: 80, kind: 'transfer' })
  })

  it('a transfer line never taxes or discounts: those stay the engine’s', async () => {
    const ctx = h().ctx
    ctx.traffic = { egressGbMonth: 150, source: 'form' }
    const e = await P.ec2Estimate(
      ctx,
      want('aws.ec2_instance', { instance_type: 't3.micro' }),
      null
    )
    expect(e.lines.some((l) => l.kind === 'tax' || l.kind === 'discount')).toBe(false)
    const taxed = applyRates(e, { taxPercent: 10, discountPercent: 0, source: 'admin', months: 0 })
    expect(taxed.lines.filter((l) => l.kind === 'tax')).toHaveLength(1)
  })
})

describe('prices that cannot be had', () => {
  it('a region with no price is unknown', async () => {
    const e = await P.ec2Estimate(
      h().ctx,
      want('aws.ec2_instance', { instance_type: 't3.micro', region: 'eu-west-1' }),
      null
    )
    expect(e.confidence).toBe('unknown')
    expect(e.monthlyCents).toBe(0)
    expect(e.note).toContain('eu-west-1')
  })

  it('an unreadable price list falls back to the bundled table and names its date', async () => {
    const ctx = H.harness({
      'pricing:GetProducts': { status: 403, file: 'pricing-error-denied.json' },
      'monitoring:GetMetricData': NO_CW
    }).ctx
    const e = await P.ec2Estimate(
      ctx,
      want('aws.ec2_instance', { instance_type: 't3.micro' }),
      null
    )
    expect(e.monthlyCents).toBe(759)
    expect(e.priceAsOf).toBe(P.AWS_PRICES_AS_OF)
    expect(e.note).toContain(P.AWS_PRICES_AS_OF)
    // The bundled table holds us-east-1 only: another region has no figure at all.
    const eu = await P.ec2Estimate(
      ctx,
      want('aws.ec2_instance', { instance_type: 't3.micro', region: 'eu-west-1' }),
      null
    )
    expect(eu.confidence).toBe('unknown')
  })

  it('never throws: a failing client, a bad value or a missing field is "No estimate"', async () => {
    const dead = H.harness({}).ctx
    for (const f of [
      () => P.ec2Estimate(dead, want('aws.ec2_instance', { instance_type: 'x1.nope' }), null),
      () => P.ec2Estimate(dead, want('aws.ec2_instance', {}), null),
      () => P.ebsEstimate(dead, want('aws.ebs_volume', { size_gb: 'big' }), null),
      () => P.rdsEstimate(dead, null, null),
      () => P.natEstimate(dead, want('aws.nat_gateway', { region: 'mars' }), null),
      () => P.s3Estimate(dead, null, null)
    ]) {
      const e = await f()
      expect(e.confidence).toBeDefined()
      expect(Number.isFinite(e.monthlyCents)).toBe(true)
    }
  })
})

describe('CloudWatch reader', () => {
  it('sends one batched GetMetricData with the metric, dimensions and period', async () => {
    const x = h({ 'monitoring:GetMetricData': 'cloudwatch-metric-data.xml' })
    const end = new Date('2026-11-26T12:00:00Z')
    const out = await CW.getMetricData(
      x.ctx,
      'us-east-1',
      [
        {
          id: 'm0',
          namespace: 'AWS/EC2',
          metric: 'NetworkOut',
          dimensions: [{ name: 'InstanceId', value: 'i-0aaa' }],
          stat: 'Sum',
          periodSeconds: 604_800
        },
        {
          id: 'm1',
          namespace: 'AWS/NATGateway',
          metric: 'BytesOutToDestination',
          dimensions: [{ name: 'NatGatewayId', value: 'nat-0bbb' }],
          stat: 'Sum',
          periodSeconds: 604_800
        }
      ],
      new Date(end.getTime() - 7 * 24 * 3600 * 1000),
      end
    )
    expect(x.of('GetMetricData')).toHaveLength(1)
    const p = x.of('GetMetricData')[0].params
    expect(p.Version).toBe('2010-08-01')
    expect(p['MetricDataQueries.member.1.MetricStat.Metric.Namespace']).toBe('AWS/EC2')
    expect(p['MetricDataQueries.member.1.MetricStat.Metric.Dimensions.member.1.Name']).toBe(
      'InstanceId'
    )
    expect(p['MetricDataQueries.member.2.MetricStat.Period']).toBe('604800')
    expect(out.get('m0')).toEqual([3.221225472e10])
    expect(out.get('m2')).toEqual([])
  })

  it('answers no bucket size on a denial, never throwing', async () => {
    expect(await CW.awsBucketSizeGb(h().ctx, 'us-east-1', 'shop-assets')).toBeNull()
    expect(
      await CW.awsBucketSizeGb(
        h({ 'monitoring:GetMetricData': 'cloudwatch-bucket-size.xml' }).ctx,
        'us-east-1',
        'shop-assets'
      )
    ).toBe(100)
  })
})

describe('measured egress', () => {
  const resource = (
    id: number,
    type: string,
    externalId: string,
    fields: Record<string, unknown>
  ) => ({
    id,
    connection_id: 7,
    provider: 'aws',
    type,
    external_id: externalId,
    app_id: 1,
    environment_id: 2,
    observed: { type, externalId, name: null, fields: { region: 'us-east-1', ...fields }, tags: {} }
  })
  let x: ReturnType<typeof h>

  beforeEach(() => {
    egress.resetAwsEgressForTest()
    registry.resetProvidersForTest()
    registry.registerProvider(awsProvider)
    rows.connection = {
      id: 7,
      provider: 'aws',
      status: 'ok',
      config: H.CONFIG
    }
    rows.resources = [
      resource(1, 'aws.ec2_instance', 'i-0aaa', {}),
      resource(2, 'aws.nat_gateway', 'nat-0bbb', {}),
      resource(3, 'aws.s3_bucket', 'shop-assets', {})
    ]
    x = h({ 'monitoring:GetMetricData': 'cloudwatch-metric-data.xml' })
    deps.configureResourceEngine({ fetch: { fetchImpl: x.fetchImpl as never } })
  })

  it('reads one batch per region, scales 7 days to a month, takes the largest path per environment', async () => {
    const byEnv = await egress.awsMeasuredEgress(1)
    expect(x.of('GetMetricData')).toHaveLength(1)
    // 30 GiB in the window → 30 × 30/7 = 128.57 GiB a month (instances), NAT 10 GiB → 42.86; max wins.
    expect([...byEnv]).toEqual([[2, 128.57]])
    expect(egress.awsResourceEgress(7, 'aws.nat_gateway', 'nat-0bbb')).toBeCloseTo(42.857, 2)
    expect(egress.awsResourceEgress(7, 'aws.s3_bucket', 'shop-assets')).toBeNull()
  })

  it('bills CloudWatch once an hour: a second read in the hour makes no call, one later does', async () => {
    const t0 = Date.UTC(2026, 10, 26, 12)
    await egress.awsMeasuredEgress(1, t0)
    await egress.awsMeasuredEgress(1, t0 + 30 * 60_000)
    expect(x.of('GetMetricData')).toHaveLength(1)
    await egress.awsMeasuredEgress(1, t0 + 61 * 60_000)
    // Stale: it answers the cached figure at once and refreshes behind it.
    await egress.refreshAwsEgress(7, new Date(t0 + 61 * 60_000))
    expect(x.of('GetMetricData').length).toBeGreaterThanOrEqual(2)
  })

  it('a connection without the permission yields no figure and never throws', async () => {
    x = h({ 'monitoring:GetMetricData': NO_CW })
    deps.configureResourceEngine({ fetch: { fetchImpl: x.fetchImpl as never } })
    expect([...(await egress.awsMeasuredEgress(1))]).toEqual([])
  })

  it('feeds the seam of the live costs by default', async () => {
    const { costsLiveDeps, resetCostsLiveForTest } = await import(
      '../../../services/hub/providers/estimate.js'
    )
    resetCostsLiveForTest()
    expect([...(await costsLiveDeps().measuredEgress(1))]).toEqual([[2, 128.57]])
    expect(costsLiveDeps().resourceEgress(7, 'aws.ec2_instance', 'i-0aaa')).toBeCloseTo(128.57, 2)
  })
})

describe('aws connection: permissions for the cost features', () => {
  const READS = [
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
  ]
  const base = () => {
    const handlers: Record<string, any> = { ...H.OTHER_PROBES_OK }
    for (const a of READS) handlers[`ec2:${a}`] = { status: 412, file: 'ec2-error-dryrun.xml' }
    handlers['sts:GetCallerIdentity'] = 'sts-caller-identity.xml'
    return handlers
  }

  it('shows a row for each; a missing one is listed but never fails the connection', async () => {
    const x = H.harness({
      ...base(),
      'pricing:GetProducts': { status: 403, file: 'pricing-error-denied.json' },
      'monitoring:GetMetricData': NO_CW
    })
    const t = await awsProvider.testConnection(x.ctx)
    expect(t.ok).toBe(true)
    expect(t.permissions.filter((p) => p.type === 'costs')).toEqual([
      { type: 'costs', need: 'pricing:GetProducts', has: false },
      { type: 'costs', need: 'cloudwatch:GetMetricData', has: false }
    ])
    expect(t.missing).toEqual(['pricing:GetProducts', 'cloudwatch:GetMetricData'])
    expect(t.message).toContain('Optional')
  })

  it('both granted: both rows are true and nothing is missing', async () => {
    const t = await awsProvider.testConnection(H.harness(base()).ctx)
    expect(t.ok).toBe(true)
    expect(t.permissions.filter((p) => p.type === 'costs').every((p) => p.has)).toBe(true)
    expect(t.missing).toEqual([])
  })

  it('the policy names exactly the actions the probes need, and the hosts allow both services', () => {
    const needs = ['pricing:GetProducts', 'cloudwatch:GetMetricData']
    expect([...iam.AWS_COST_ACTIONS]).toEqual(needs)
    expect(iam.AWS_COST_IAM_POLICY.Statement[0].Action).toEqual(needs)
    const hosts = awsConnection.hosts(H.CONFIG)
    expect(hosts).toContain('api.pricing.us-east-1.amazonaws.com')
    expect(hosts).toContain('monitoring.us-east-1.amazonaws.com')
    expect(hosts.some((x) => x.startsWith('*'))).toBe(false)
  })
})
